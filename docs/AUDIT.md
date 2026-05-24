# bridge-clis — Audit-Report v1

**Datum:** 2026-05-24
**Auditors:** security-engineer · code-auditor-ml · backend-architect (parallel, je eigene Lens)
**Gesamtbefund:** 6 CRITICAL · 14 HIGH · 21 MEDIUM · 14 LOW (nach Konsolidierung und Withdrawals)

---

## RESOLUTION STATUS (Phase B/C/D — 2026-05-24, post-fix-swarm)

**Verdict (Re-Audit, code-auditor-ml):** **Ready for Tag-0 spike + Marco-Trial.**

- ✅ **All 6 CRITICAL items PASS** (C1 xterm-indexing, C2 pre-handshake-drop, C3 inject-ack, C4 auth+pipe-mutex, C5 cmdline-redact, C6 idle-shutdown)
- ✅ **All 6 load-bearing HIGH items PASS** (H2 force-gate, H3 frame-DoS, H4 label+JSON-audit, H5 redact-patterns, H6 ReDoS, H8 raw-gate)
- ⏳ **H1 (`wait_for_idle` defaults)** — deferred to Tag-0 spike; defaults raised to `minSilentMs=1500, stableTicks=8` as safe interim
- ⏳ **H7 (pipe-TOCTOU)** — folded into C4 fix (pipe-as-mutex unification)
- ✅ **Bonus 9/9** (markDead-notify, base64-strict, cmdline-redact, M1/M2/M4/M5/M6/M7/M9/M10/M13)

**Regressions found by re-audit, ALL fixed in-line:**
- ~~MEDIUM~~ `pipe-server.ts:294` resume-with-dead-prior overwrote dead session silently → now explicit `purgeDeadAtConflictingId` with warn-log
- ~~LOW~~ `cb/index.ts:199` onAuthFailed killed wrapped child despite comment claiming "continues unbridged" → fixed to honor comment (cb stays transparent, drops bridging only)
- ~~LOW~~ `framing.ts:122` empty paste rejected as `protocol_violation` → empty string now returns `Buffer.alloc(0)`

**Still open from re-audit (LOW, acceptable):**
- aws_secret regex keyword-anchored → may miss bare 40-char keys (documented tradeoff to avoid false positives)
- Smoke race-test bounds tight on slow CI → may flap; tune if observed
- Boot-time daemon waits ≥60s before idle-shutdown if spawned with no client → non-obvious but documented

**Next step:** Run Tag-0 spike (`cd spike && npm install && node render-test.mjs`). If green: `pnpm install && pnpm -r build && pnpm test:smoke`. Then 1 Tag empirisches Tuning für `wait_for_idle` mit echter Claude-Code-Streaming-Output.

---

**Original-Verdict (Phase A pre-fix):** Code compiliert, aber **nicht produktionsreif**. Drei strukturelle Bugs in einem File (`headless-term.ts`) brechen `wait_for_idle`, `read_screen`, `read_tail` gleichzeitig. Plus Pre-Handshake-Drop, Pipe-ACL-Gap, Inject-ACK-Lüge. Reihenfolge zum Fixen unten.

---

## 1. Cross-Audit-Konsens — die Findings, die ≥2 Auditors unabhängig fanden

Höchstes Signal. Diese zuerst.

### C1 — xterm-headless Buffer-Indexing falsch (CRITICAL)
**Fundstellen:** code-auditor CRITICAL #2 + HIGH #1; backend-architect HIGH #4 (Symptom: `wait_for_idle` falsch tuned — Ursache liegt hier)
**File:** `packages/bridged/src/headless-term.ts:60-72, 81-133, 139-151`
**Bug:** `buf.getLine(y)` in `@xterm/headless` ist **buffer-absolut** (y=0 = älteste Scrollback-Zeile), nicht viewport-relativ. Code behandelt y aber als viewport-Index. Sobald Scrollback existiert (nach wenigen Zeilen Output):
- `renderScreen` returnt älteste Scrollback-Zeilen statt visible Screen
- `hashLastN(cursorY ± n)` hash't historische, unveränderliche Inhalte → `wait_for_idle` resolved **sofort** mit `idle:true` während Claude noch streamt
- `renderTail` mischt + dupliziert Scrollback und Active-Buffer

**Impact:** `bridge_read_screen`, `bridge_read_tail`, `bridge_wait_for_idle` liefern systematisch falsche Daten. STOP-Bedingung #2 aus EXECUTION ist **getriggert**, sobald empirisch getestet wird.

**Fix:** Cursor in absolute Koordinaten umrechnen:
```ts
const cursorAbs = buf.baseY + buf.cursorY;
// renderScreen viewport:
for (let y = buf.baseY; y < buf.baseY + rows; y++) { ... }
// hashLastN:
const start = Math.max(0, cursorAbs - n + 1);
for (let y = start; y <= cursorAbs; y++) { ... }
// renderTail: drop alt-screen branching, einfach last n rows aus active:
const start = Math.max(0, active.length - n);
for (let y = start; y < active.length; y++) { ... }
```
**Aufwand:** 1 File, ~30 Zeilen geändert. **Hebel: höchster im Codebase.** Drei Tools werden auf einmal korrekt.

---

### C2 — Pre-Handshake Stdout-Drop (CRITICAL)
**Fundstellen:** code-auditor CRITICAL #3; backend-architect CRITICAL #2
**Files:** `packages/cb/src/index.ts:117-188`, `packages/cb/src/pipe-client.ts:74-91`
**Bug:** PTY wird vor Pipe-Connect gespawnt. Erste 100ms-3s an Output (Welcome-Banner, Initial-Prompt) fallen in `sendStdout(...)` während `this.connected===false` → silent drop. Daemon sieht Session ohne Initial-State.

**Impact:** Frische Session: `read_screen` zeigt halben Bildschirm. `wait_for("Welcome to Claude")` matched nie auf ein Banner, das zu früh geflusht wurde. Fehler nur beim **ersten** cb-Spawn nach Daemon-Cold-Start ("first-run-of-day bug").

**Fix:** In `pipe-client.ts` einen bounded Pre-Connect-Queue (z.B. last 1MB) einbauen, in `connect`-Handler flushen. Pseudo:
```ts
private preConnectQueue: Array<{ t: 'stdout' | 'user_input' | 'stdin'; data?: string; at?: number }> = [];
sendStdout(chunk) {
  if (!this.connected) {
    this.preConnectQueue.push({ t: 'stdout', data: chunk.toString('base64') });
    // bounded eviction at 1MB
    return;
  }
  // ...
}
private onConnect() {
  this.send({ t: 'hello', session: this.sessionMeta });
  for (const q of this.preConnectQueue) this.send(q);
  this.preConnectQueue = [];
  this.connected = true;
}
```
**Aufwand:** 1 File, ~40 Zeilen. Pflicht-Fix.

---

### C3 — Inject-ACK lügt bei toter Session (HIGH/CRITICAL)
**Fundstellen:** code-auditor MEDIUM #2 + HIGH; backend-architect HIGH #1
**Files:** `packages/bridged/src/session.ts:102-124`, `packages/bridged/src/inject.ts:72-84`
**Bug:** `Session.inject` returnt `bytes.length` auch wenn `pipeClient.write()` 0 Bytes schreibt (destroyed socket). `tryInject` packt das als `{ok:true, written:0}` und audit-loggt es als Erfolg. Master-Claude bekommt `written:200`, vertraut, ruft `wait_for_idle`, timeout 30s später ohne Diagnose.

**Impact:** Während der Detection-Gap (bis zu 30s zwischen PID-Poll und Heartbeat-Loss) gehen MCP-Schreibvorgänge silent ins Leere. DESIGN §7 Vertrag "tool call on dead session → session_dead" wird gebrochen.

**Fix:** In `inject.ts:72-84`:
```ts
function doInject(session, bytes, opts) {
  if (session.status === 'dead' || !session.pipeClient) {
    return { ok: false, error: 'session_dead' };
  }
  const written = session.inject(bytes);
  if (written === 0) {
    return { ok: false, error: 'session_dead' }; // pipe write failed
  }
  audit({ op: opts.op, sessionLabel: session.label, bytes: written, callerId: opts.callerId });
  return { ok: true, written };
}
```
Plus in `session.inject`: synchron `process.kill(this.pid, 0)`-Check vor `pipeClient.write` für schnelle Toterkennung.
**Aufwand:** 2 Files, ~15 Zeilen.

---

### C4 — Pipe hat keine ACL, kein Auth-Handshake (CRITICAL — Security)
**Fundstellen:** security CRITICAL #1, #3 + HIGH (TOCTOU Mutex)
**Files:** `packages/bridged/src/pipe-server.ts:71`, `packages/bridged/src/mutex.ts:45`
**Bug:** Node's `net.Server.listen(pipe)` auf Windows verwendet libuv-Default-Security-Descriptor — **NICHT** Owner-only. Jeder lokale Prozess (auch andere User in derselben Session) kann connecten und `mcp_hello` senden → vollen Registry-Zugriff. Plus: `clientId` ist self-asserted, kein Token.

**Impact:** "Lokal-only Single-User"-Threat-Model aus DESIGN §6 ist Tag-1 gebrochen. Bösartige npm-Dep im Background-Terminal kann jede `cb claude`-Session steuern (inkl. authenticated API-Key).

**Fix:** Kombination:
1. Per-Daemon-Startup Secret-File `~/.bridge-clis/daemon.secret` (32 random bytes, mode 0600).
2. `mcp_hello` muss Secret enthalten. Daemon validiert.
3. Mutex und Session-Pipe vereinen: bind direkt `PIPE_NAME` als Mutex — schließt TOCTOU-Window aus dem die Architecture-Audit-MEDIUM #1 hervorgeht.
4. Optional via native call: `CreateNamedPipeW` mit owner-only SDDL — robuster, aber Native-Code-Schicht.

**Verifikation in 10 Sekunden:** `accesschk.exe \pipe\bridge-clis` nach Daemon-Start (Sysinternals).

**Aufwand:** 2 Files + 1 Doku-Update. ~50 Zeilen.

---

### C5 — `bridge_list` returnt `cmdline` unredacted (HIGH — Security)
**Fundstellen:** security HIGH #7
**Files:** `packages/bridged/src/session.ts:142-154`, `packages/bridged/src/pipe-server.ts:326-327`
**Bug:** `SessionInfo.cmdline` enthält volle CLI-Args wie `["claude", "--api-key", "sk-ant-real"]`. `bridge_list` returnt das ungefiltert — `redact()` läuft nur auf `read_screen`/`read_tail`/`read_raw`.

**Impact:** Master-Claude (oder per C4 jeder lokale Prozess) ruft `bridge_list` und kriegt API-Keys.

**Fix:** In `session.toInfo()`: jede cmdline-Entry durch `redact()` jagen. Oder noch radikaler: nur `cmdline[0]` exposen (Programmname genügt).
**Aufwand:** 1 File, ~5 Zeilen.

---

### C6 — Daemon shuttet nie down während Master-Claude lebt (CRITICAL)
**Fundstellen:** backend-architect CRITICAL #1
**File:** `packages/bridged/src/index.ts:88-104`
**Bug:** `maybeArmIdleTimer` schaltet ab wenn `pipeServer.mcpClientCount() > 0`. Master-Claude hält den MCP-Socket Stunden offen → Daemon nie idle, läuft permanent.

**Impact:** "60s idle → exit"-Vertrag gebrochen. Memory-Leaks akkumulieren über Tage. Smoke-Test passt nur, weil er den Helper vorher disconnected — echte Nutzung tut das nicht.

**Fix:** Idle-Bedingung umformulieren: "0 alive sessions UND letzte 60s keine MCP-Tool-Calls" (statt "keine MCP-Connection"). Heartbeat-Style: jeder MCP-Request bumpt `lastMcpActivityAt`.
**Aufwand:** 1 File, ~10 Zeilen.

---

## 2. High-Severity Single-Auditor-Findings

### H1 — `wait_for_idle` Defaults sind nicht empirisch validiert
backend-architect HIGH #4. EXECUTION STOP-Bedingung #2 explizit. Aktuelle Defaults (`minSilentMs=800, stableTicks=5`, `n=3 lines`) zusammen mit C1-Bug = praktisch garantierter False-Positive.

**Fix:** Erst C1 fixen, dann mit echtem Claude in Tag-0-Spike messen. Vermutliche bessere Defaults: `minSilentMs=1500, stableTicks=8`, n=screen-rows (nicht 3).

### H2 — `force:true` über MCP ohne Schutz
security HIGH #4. Master-Claude kann via Prompt-Injection aus bridged Session A überredet werden, `force:true` auf Session B zu setzen → Race-Protection bypassed.

**Fix:** `force` standardmäßig deaktivieren. Aktivieren nur via Env `BRIDGE_ALLOW_FORCE=1`. Forced Ops kriegen Audit-Op-Prefix `force_<op>`.

### H3 — Frame-Decoder DoS (16MB, kein Idle-Timeout)
security CRITICAL #2. `Buffer.concat` Quadratic-Hot-Path im Decoder (code-auditor HIGH). Cap `MAX_FRAME_BYTES=1MB`, `socket.setTimeout(30s)`, ersetze Concat-Akkumulator durch List-of-Chunks + Cursor.

### H4 — Audit-Log-Injection via Session-Label
security HIGH #1. Label kann `=` und Unicode-Line-Separators enthalten → forensische Korrumpierung. Label-Validation `/^[A-Za-z0-9._-]{1,64}$/` in `pipe-server.ts:179-181`. Audit-Format auf JSON-per-line wechseln.

### H5 — Redaction-Patterns lückenhaft
security HIGH #2. Fehlen: AWS (`AKIA…`), Stripe (`sk_live_…` — relevant für HandwerkManager!), Slack (`xox[bpars]-…`), JWT, Google API Keys, PEM-Private-Keys. Zeilenwrap-Split (xterm splittet bei col 80) macht Token unmatchbar.

**Fix:** Patterns ergänzen in `redact.ts:15-21`. Zusätzlich: bei Multi-Line-Output zweiten Pass auf newline-stripped text mit Logging.

### H6 — Redact.json user-supplied regex = ReDoS-Vector
security HIGH #3. Bösartige oder schlechte custom regex hängt den Event-Loop. Cap auf 32 patterns, regex-Test gegen `'a'.repeat(10_000)` mit 10ms-Budget vor Adoption, Reject pattern matching empty string.

### H7 — Pipe-TOCTOU + Mutex auf separater Pipe
security HIGH (Mutex TOCTOU). Mutex-Pipe und Wire-Pipe sind verschiedene Pfade. Window zwischen Mutex-Acquire und Wire-Listen erlaubt Pre-Bind durch Angreifer-Prozess. Fix: dieselbe Pipe als Mutex (try-bind PIPE_NAME first; EADDRINUSE → exit). Macht TOCTOU unmöglich.

### H8 — `read_raw` kein Opt-In, kein Schutz
security MEDIUM (würde ich auf HIGH heben). `sinceMs=-1` returnt full ring buffer bypass redact. Gate hinter `BRIDGE_ALLOW_RAW=1` Env, enforce `sinceMs >= 0`.

---

## 3. Medium-Severity Highlights (priorisiert)

| # | Datei | Bug | Fix-Effort |
|---|---|---|---|
| M1 | `session.ts:71` | `lastUserInputAt = startedAt` → 1.5s artificial Latency auf jeden ersten Inject | 1 Zeile |
| M2 | `pipe-server.ts:204-228` vs `pipe-client.ts:20-22` | Heartbeat-Asymmetrie cb=30s, daemon=40s → bei brief Netz-Blip Session-Verdopplung mit `-2` Suffix | Re-attach by ULID in hello |
| M3 | `audit.ts:73-78` | `appendFileSync` blockt Event-Loop unter Last | Async stream |
| M4 | `cb/index.ts:141-148` | Sendet `stdin` (full base64) UND `user_input` (throttled) — wasteful + leakt Keystrokes inkl. Passwörter | sendStdin droppen |
| M5 | `pipe-server.ts:204-228` | Pong-Handler bumpt `missedPongs=0` aber nicht `lastActivityAt` → stale activity timestamps | 1 Zeile |
| M6 | `registry.ts:84-100` | Dead-Session-Label kann mit neuer alive-Session kollidieren → zwei "hwm" in list | Rename dead label auf reuse |
| M7 | `wait-for.ts:59-91` | Timeout-Check VOR scan statt nach → edge-case false-negative am Boundary | Reorder |
| M8 | `smoke/pipe-helper.ts:152-161` | Default `force:true` maskiert Race-Protection-Bugs | Default false + dedizierter Race-Test |
| M9 | `spawn-daemon.ts:82-110` | Simultane cb-Spawns racen → noise im daemon log | Transient file-lock oder backoff |
| M10 | `daemon-client.ts:31, 197-198` | Optimistic 100ms mcp_hello statt echtem Ack | `mcp_hello_ack` Frame |
| M11 | `headless-term.ts:20` | ANIM_CHARS-Mask deckt nur 10 von 256 Braille-Spinner-Glyphen ab | Range `[⠀-⣿]` |
| M12 | `framing.ts:6-30` | Base64 silent-truncates auf invaliden Input | Round-trip-validate |
| M13 | `install.ps1:175-195` | PATH-Update non-atomic, kein Lock zwischen Read und Write | File-lock |
| M14 | `pipe-server.ts:150-162` | Unknown role → silent destroy ohne error-Frame → cb-Reconnect-Loop ohne Diagnose | Error-Frame senden |

---

## 4. Top 3 Priority — was zuerst gefixt werden muss

Sortiert nach (Impact × Wahrscheinlichkeit) / Effort:

### Priority 1 — C1 (xterm-Indexing)
**1 File, 30 Zeilen, fixt 3 Tools auf einmal.** Höchster Hebel im gesamten Codebase. Ohne diesen Fix ist `wait_for_idle` praktisch unbrauchbar und alle read_*-Tools liefern Junk.

### Priority 2 — C2 + C3 (Pre-Handshake + Inject-Lie)
**2 Files, ~55 Zeilen.** Beide brechen die "Master sieht was im Child passiert"-Garantie. Ohne diese Fixes lügt das Tool subtil — exakt der teuerste Failure-Mode.

### Priority 3 — C4 + C5 + H2 + H8 (Security-Cluster)
**4 Files, ~80 Zeilen.** Pipe-Auth, cmdline-Redaction, `force` gated, `read_raw` opt-in. Wenn das Tool für HandwerkManager-Workflows (echte Stripe-Keys) genutzt werden soll: **vor erstem produktivem Einsatz Pflicht**.

### Davor: C6 (Daemon-Shutdown) — 1 File, 10 Zeilen
Trivial-Fix mit operationaler Bedeutung. Sollte mit Priority 1 mitlaufen.

---

## 5. Was die Smoke-Test-Suite NICHT abdeckt (sollte sie aber)

- **Claude Code TUI Rendering** (pwsh-only smoke). Tag-0-Spike-Equivalent als Smoke-Test, optional via `CLAUDE_API_KEY`-Gate.
- **Pre-Handshake-Drop** (C2) — `read_screen` direkt nach cb-Spawn würde es beweisen.
- **Daemon-Shutdown mit MCP-Client connected** (C6) — Helper connected lassen statt vorher disconnect.
- **Inject auf dying session** (C3) — kill inner, sofort inject, expect `session_dead` in <100ms (nicht 30s).
- **Bracketed-paste end-to-end** — Smoke ruft nie `bridge_paste`.
- **Concurrent inject + user-typing** — Race-Protection ist plumbed aber durch `force:true` im Helper maskiert.
- **Credential-Redaction** — `sk-ant-xxx` → `[REDACTED:anthropic_key]`-Assertion.
- **Label-Recycling** während dead retain (M6).

---

## 6. Ticket-Implementation-Status (16 Tickets aus EXECUTION.md)

| Status | Anzahl | Tickets |
|---|---|---|
| **Spec-konform** | 7 | T1, T2, T3, T4, T5 (modulo M-fixes), T8 (plumbing), T13 |
| **Partial / off-spec** | 7 | T6 (C1), T7 (C1-downstream), T9 (M7), T10 (C1+H1+M11), T11 (redactRaw stub, H5/H8), T12 (M8 maskiert), T15 (M-tight timing) |
| **Off-spec / unverifiziert** | 2 | T14 (installer existiert aber nicht gebaut+getestet), T16 (README existiert aber nicht audited) |

**DoD-Lücke:** C1 + C2 + C3 + C4 sind alle harte Blocker für "Marco hat einen Tag damit gearbeitet ohne kritischen Bug".

---

## 7. Honest Caveats

- Keine der Findings ist runtime-validiert. Audit war Static-Only. `[conf]`-Levels in den Original-Reports beibehalten.
- `pnpm install` wurde nicht ausgeführt — keine echten Versionen, keine Compile-Verifikation des integrierten Codes.
- Tag-0-Spike (EXECUTION §1) ist weiterhin der hartet Go/No-Go-Gate, bevor irgendetwas dieser Audit-Empfehlungen Sinn ergibt zu fixen.

---

**Bottom Line:** Code ist solide-strukturiert (Monorepo sauber, TypeScript strict, Conventions konsistent), aber 4 strukturelle Bugs (C1-C4) machen es in der aktuellen Form nicht nutzbar. Geschätzter Aufwand bis "produktionsreif für interne Nutzung" (alle C-Fixes + H2/H5/H8): **~6-8 Stunden konzentrierte Arbeit + Tag-0-Spike + 1 Tag empirisches Tuning von `wait_for_idle`**.
