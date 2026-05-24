# bridge-clis — Execution-Plan

**Status:** Ready-to-execute v1 · 2026-05-23
**Komplementär zu:** `DESIGN.md` (Warum/Was). Dieses Doc ist das *Wie*, ticket-by-ticket.
**Sprache:** Anweisungen Deutsch, Code/Pfade/CLI Englisch.

> **Regel für den Implementer:** Wenn ein Ticket eine Annahme trifft, die hier nicht steht, **stop** und ergänze hier, bevor du weitermachst. Nicht improvisieren.

---

## 0. Gates & Stop-Bedingungen

Drei Punkte, bei denen Stop und Re-Plan zwingend ist:

1. **Tag-0-Spike rendert Claude-Code-TUI nicht sauber** → STOP. Kein Daemon, kein MCP bauen. Re-Plan: entweder Raw-Stream-Fallback designen oder Projekt killen.
2. **`wait_for_idle` produziert >5% false-positives im Tag-6-Test** → STOP. Algorithmus überarbeiten, nicht weiter Tools draufbauen.
3. **`pkg`/SEA-Binary lädt `node-pty` auf clean-Win11 nicht** → STOP. Auf Bundle-Strategie (Anhang E) wechseln, **nicht** weiter an pkg-Workarounds basteln.

Diese Stops sind nicht-verhandelbar. Time-boxing ist Selbstschutz, nicht Schwäche.

---

## 1. Tag 0 — Spike (Go/No-Go-Gate, max. 4h)

**Ziel:** Eine einzige Frage beantworten: *Rendert `@xterm/headless` Claude Code's Ink-TUI durch `node-pty`+ConPTY sauber?*

### 1.1 Setup
```powershell
mkdir spike; cd spike
npm init -y
npm i node-pty @xterm/headless
```
**Wichtig:** Pin Versionen, *nachdem* der Spike grün ist. Vorher: latest, schnell scheitern.

### 1.2 Spike-Skript — `spike/render-test.mjs`

```js
import pty from 'node-pty';
import { Terminal } from '@xterm/headless';
import fs from 'node:fs';

const COLS = 120, ROWS = 36;
const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 5000 });

const shell = pty.spawn('claude', [], {
  name: 'xterm-256color',
  cols: COLS, rows: ROWS,
  cwd: process.cwd(),
  env: { ...process.env, TERM: 'xterm-256color' },
});

shell.onData(data => {
  term.write(data);
  process.stdout.write(data); // user sieht alles direkt
});

shell.onExit(({ exitCode }) => { console.error(`\n[spike] exit ${exitCode}`); process.exit(exitCode); });

// snapshot alle 2s
setInterval(() => {
  const buf = term.buffer.active;
  let out = `=== ${new Date().toISOString()} cursor=(${buf.cursorY},${buf.cursorX}) ===\n`;
  for (let y = 0; y < ROWS; y++) {
    const line = buf.getLine(y);
    out += (line ? line.translateToString(true) : '~') + '\n';
  }
  fs.writeFileSync('spike/snapshot.txt', out);
}, 2000);

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', d => shell.write(d.toString('utf8')));

process.on('SIGWINCH', () => {
  shell.resize(process.stdout.columns, process.stdout.rows);
  term.resize(process.stdout.columns, process.stdout.rows);
});
```

Auf Windows existiert `SIGWINCH` nicht. Stattdessen `process.stdout.on('resize', ...)` registrieren — der Listener-Code ist sonst identisch.

### 1.3 Akzeptanz-Kriterien (alle drei müssen erfüllt sein)

| # | Test | Pass |
|---|---|---|
| A | `node spike/render-test.mjs` startet Claude. User-Terminal zeigt normales Claude-UI, kein visueller Glitch. | ✅ |
| B | `cat spike/snapshot.txt` zeigt zu jedem Zeitpunkt einen kohärenten Screen-State (Input-Box am unteren Rand, Welcome-Text oben, Cursor an plausibler Stelle). Keine doppelten ANSI-Codes, keine abgeschnittenen Linien. | ✅ |
| C | Tippe in Claude: "hallo, sag 1 wort zurück". Antwort kommt. Snapshot nach Antwort enthält die Antwort lesbar als Text. | ✅ |

**Bei FAIL:** Reproduziere mit `pwsh.exe` statt `claude` — wenn pwsh auch broken: node-pty/ConPTY-Bug, lass das ganze Projekt nochmal überdenken. Wenn nur Claude broken: Ink-spezifisch, Raw-Stream-Fallback-Pfad designen bevor Tag 1 startet.

**Bei PASS:** Versionen festschreiben (`npm ls > spike/versions.txt`), weiter mit Tag 1.

---

## 2. Repository-Layout (vor Tag 1 anlegen)

```
bridge-clis/
├── package.json              # pnpm workspaces root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .eslintrc.cjs
├── packages/
│   ├── cb/                   # PTY-Wrapper-CLI
│   │   ├── src/index.ts
│   │   ├── src/pty.ts
│   │   ├── src/pipe-client.ts
│   │   ├── src/spawn-daemon.ts
│   │   └── package.json
│   ├── bridged/              # Daemon
│   │   ├── src/index.ts
│   │   ├── src/registry.ts
│   │   ├── src/session.ts
│   │   ├── src/pipe-server.ts
│   │   ├── src/ring-buffer.ts
│   │   ├── src/headless-term.ts
│   │   ├── src/wait-for.ts
│   │   ├── src/redact.ts
│   │   ├── src/audit.ts
│   │   └── package.json
│   ├── bridge-mcp/           # MCP server
│   │   ├── src/index.ts
│   │   ├── src/tools.ts
│   │   ├── src/daemon-client.ts
│   │   └── package.json
│   └── shared/               # Protocol types, ulid, helpers
│       ├── src/protocol.ts
│       ├── src/keys.ts
│       └── package.json
├── installer/
│   ├── install.ps1
│   └── uninstall.ps1
└── tests/
    ├── smoke/                # End-to-end smoke
    └── unit/                 # per-package
```

**Tooling pinned:**
- `pnpm` 9.x · `typescript` 5.4+ · `tsx` für dev-run · `vitest` für tests
- Node-Version-Floor: 20.10 (für `--experimental-sea-config`-Fallback verfügbar)

---

## 3. Tickets — sequentiell, jedes self-contained

Jedes Ticket: **Goal · Files · Steps · Acceptance**. Reihenfolge ist Dependency-Reihenfolge, nicht Zeit-Schätzung. Wenn ein Ticket >2x länger dauert als grob impliziert → STOP, neu schneiden.

### T1 — Repo-Skelett + shared/protocol

**Goal:** Monorepo läuft, Wire-Protocol-Types existieren.

**Files:** root config, `shared/src/protocol.ts`, `shared/src/keys.ts`

**Steps:**
1. pnpm-Workspaces aufsetzen, alle 4 packages mit minimal `package.json` + `src/index.ts`.
2. `tsconfig.base.json` mit `strict: true`, `module: "NodeNext"`, `target: "ES2022"`.
3. `shared/src/protocol.ts` exportiert die *vollständigen* IPC-Message-Types aus DESIGN §5 + die in Anhang C ergänzten Race-Messages.
4. `shared/src/keys.ts` exportiert eine `Key` Union (DESIGN §4.6) + `keyToBytes(k: Key): Buffer` mit ANSI-Sequenzen:
   - `enter` → `\r`  · `tab` → `\t`  · `esc` → `\x1b`  · `backspace` → `\x7f`  · `delete` → `\x1b[3~`
   - Arrows: `\x1b[A/B/C/D` (up/down/right/left)
   - `home` → `\x1b[H` · `end` → `\x1b[F` · `pageup` → `\x1b[5~` · `pagedown` → `\x1b[6~`
   - `ctrl-c` → `\x03` · `ctrl-d` → `\x04` · `ctrl-l` → `\x0c`
   - `{literal: s}` → `Buffer.from(s, 'utf8')`

**Acceptance:** `pnpm -r build` grün. `import { Key, keyToBytes } from '@bridge-clis/shared'` funktioniert aus allen drei anderen packages.

---

### T2 — `cb` PTY-Wrapper (ohne Daemon-IPC)

**Goal:** `cb <cmd> <args...>` läuft wie `<cmd>` — vollständig transparent. Noch keine Daemon-Verbindung.

**Files:** `cb/src/index.ts`, `cb/src/pty.ts`

**Steps:**
1. CLI-Parser (kein dep, manuell): `cb [--label <name>] [--no-bridge] <cmd> [args...]`. `--no-bridge` skipped Daemon-Pfad — für T2-Test.
2. `pty.spawn` mit Argumenten aus Spike. cols/rows von `process.stdout`.
3. `process.stdin.setRawMode(true)`, durchleiten an `pty.write`.
4. `pty.onData` → `process.stdout.write` (1:1).
5. Resize-Handler (`process.stdout.on('resize', ...)`).
6. `pty.onExit({ exitCode }) => process.exit(exitCode)`.
7. Cleanup: bei `SIGINT`/`SIGTERM` auf `process` → `pty.kill()`, dann exit.

**Acceptance:**
- `cb --no-bridge pwsh` → vollständig normale PowerShell-Erfahrung. Tab-Completion, Ctrl-C, Color, resize — alles wie ohne wrapper.
- `cb --no-bridge claude` → vollständig normale Claude-Erfahrung. Eingabe-Box reagiert, Streaming-Output rendert glitch-frei.
- Exit-Code wird korrekt durchgereicht (`cb --no-bridge node -e 'process.exit(42)'` → `$LASTEXITCODE` = 42).

---

### T3 — Named-Pipe Wire-Format + Mock-Daemon

**Goal:** Length-prefixed JSON Framing, beidseitig korrekt.

**Files:** `shared/src/framing.ts`, `bridged/src/pipe-server.ts`, `cb/src/pipe-client.ts`

**Steps:**
1. `shared/src/framing.ts`:
   - `encodeFrame(msg: object): Buffer` → `[4-byte LE length][utf8 JSON]`
   - `createDecoder()` → Stateful decoder. Append bytes, emit complete frames. Handhabt partial reads korrekt (TCP/Pipe sind streams).
2. Mock-Daemon (`bridged/src/index.ts` v0): Listen auf `\\.\pipe\bridge-clis`, accept, decode frames, `console.log` jeden Frame. Reagiere auf `hello` mit `{t:"ping"}`.
3. `cb` integriert pipe-client: connect, sende `hello` mit session-meta, sende `stdout`-Frames bei jedem PTY-output-chunk (base64), antworte auf `ping` mit `pong`.

**Acceptance:**
- Terminal A: `node bridged/dist/index.js`
- Terminal B: `cb --label test pwsh`
- Terminal A printet `hello`-Frame mit cwd, dann eine Reihe `stdout`-Frames in base64.
- `kill` Daemon → `cb` läuft headless weiter (reconnect-loop läuft alle 5s, logged "daemon down" einmal, dann silent).

**Wichtig:** Reconnect ist *silent*. Kein Print zum User-Terminal. Nur in `~/.bridge-clis/cb.log` (rotiert, max 1MB).

---

### T4 — Daemon-Auto-Spawn + Mutex

**Goal:** Erstes `cb` startet Daemon detached, alle weiteren nutzen ihn. Doppelstart unmöglich.

**Files:** `cb/src/spawn-daemon.ts`, `bridged/src/index.ts`

**Steps:**
1. In `bridged/src/index.ts`: bei Start versuche Named-Mutex `Local\bridge-clis-daemon` zu erstellen (`Local\` nicht `Global\` — siehe DESIGN §9.5).
   - Verwende `windows-mutex` (oder fallback: try-create-named-pipe als de-facto-mutex; wenn Bind fails → daemon läuft schon → exit 0).
2. Daemon hat einen `--idle-shutdown-ms 60000` flag, default an.
3. In `cb/src/spawn-daemon.ts`: vor connect, prüfe ob Pipe existiert. Wenn nein: spawne Daemon mit `child_process.spawn(process.execPath, [daemonScript], { detached: true, stdio: 'ignore', windowsHide: true })`, `.unref()`, dann retry-connect bis 3s.
4. Daemon-Pfad-Resolution: `cb` und `bridged` werden zusammen distribuiert (siehe Packaging). `cb` kennt `path.resolve(__dirname, '../bridged/dist/index.js')`.

**Acceptance:**
- Frische Session, `cb pwsh` → daemon spawnt, sichtbar in `Get-Process node` mit cmdline-pfad zu `bridged`.
- Zweites `cb pwsh` in anderem Terminal → kein neuer daemon, beide verbinden mit demselben.
- Beide Sessions exit, 60s warten → daemon ist weg.

---

### T5 — Session-Registry + Ring-Buffer

**Goal:** Daemon hält Sessions in-memory, sammelt raw bytes mit hartem Limit.

**Files:** `bridged/src/registry.ts`, `bridged/src/session.ts`, `bridged/src/ring-buffer.ts`

**Steps:**
1. `RingBuffer`: `push(Uint8Array)`, `readSince(timestamp)`, hartes Limit 10MB pro Session — älteste Chunks rauswerfen. Jeder Chunk hat Timestamp.
2. `Session`-Typ aus DESIGN §3.2 exakt umsetzen. ULID via `ulid`-package (3KB, eine Dep).
3. `Registry`: `Map<sessionId, Session>`. Methoden: `add(session)`, `remove(id)`, `byIdOrLabel(s)`, `list()`. Auto-label: wenn `--label` fehlt → cwd-basename + `-N` Suffix bei Kollision (DESIGN §9.4 entschieden: auto-suffix).
4. PID-Watcher: alle 30s `process.kill(pid, 0)` (existiert?). Wenn nein → `status='dead'`, behalte Buffer 5min, dann delete.

**Acceptance:**
- 2 `cb` parallel, daemon-stderr-log zeigt Registry-State korrekt.
- Kill von einem `cb`-Prozess → 30s später status='dead' in log. 5min später Session aus Map entfernt.
- 12MB an Output produzieren (z.B. `cat large-file`) → memory-usage bleibt ~10MB pro session (nicht 12MB).

---

### T6 — `@xterm/headless` Integration

**Goal:** Daemon hält pro Session einen rendered Screen-State, abrufbar als plain-text.

**Files:** `bridged/src/headless-term.ts`, erweitert `session.ts`

**Steps:**
1. Pro Session: `new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true })`. Bei `cols/rows`-changes über `resize`-Frame: `term.resize(...)`.
2. Jeder `stdout`-Frame: base64-decode, `term.write(buffer)`.
3. Helper `renderScreen(t)` → `{ cols, rows, lines: string[], cursor: {row, col} }`. Identisch zu Spike-Snapshot.
4. Helper `renderTail(t, n)` → letzte n lines aus `buffer.active` + scrollback (`buffer.normal.getLine(i)`).

**Acceptance:**
- Tippe in eine bridged `cb claude`-Session "say hello in 5 words", warte auf Antwort.
- In daemon-REPL (oder Test-Skript): `renderScreen(session.rendered)` → zeigt korrekt aktuellen Welcome-Screen + Q + A + Input-Box.
- `renderTail(session.rendered, 50)` → enthält Q+A als plain text, kein ANSI.

---

### T7 — MCP-Server: `bridge_list` + `bridge_read_*`

**Goal:** Master-Claude kann lesen.

**Files:** `bridge-mcp/src/index.ts`, `bridge-mcp/src/tools.ts`, `bridge-mcp/src/daemon-client.ts`

**Steps:**
1. Verwende `@modelcontextprotocol/sdk` (offiziell). stdio transport.
2. `daemon-client.ts`: same pipe-protocol wie `cb`, aber Client-Rolle ist "reader/writer", nicht "session-owner". Sendet `{ t: "mcp_hello" }` statt `hello`.
3. Daemon erkennt `mcp_hello`, behandelt diesen Client als read/write-API statt als Session-Owner.
4. Implementiere Tools (read-only zuerst):
   - `bridge_list` → daemon-RPC `{ t:"list" }` → `{ sessions: [...] }`
   - `bridge_read_screen` → `{ t:"read_screen", id_or_label }` → rendered
   - `bridge_read_tail` → `{ t:"read_tail", id_or_label, lines }`
   - `bridge_read_raw` → `{ t:"read_raw", id_or_label, sinceMs, maxBytes }`
5. Alle Read-Returns durch `redact()` filtern (siehe T11).

**Acceptance:**
- `.mcp.json` in einem Test-Projekt mit bridge-mcp eintragen.
- Master-Claude starten in dem Projekt, daneben `cb claude` in anderem Folder.
- Master-Claude: "list bridged sessions" → korrekte Liste.
- Master-Claude: "what's on screen in label X" → korrekter Screen.

---

### T8 — `bridge_write` + `bridge_send_keys` + `bridge_paste`

**Goal:** Master-Claude kann schreiben.

**Files:** Erweitert `tools.ts`, `daemon-client.ts`, daemon `pipe-server.ts`

**Steps:**
1. Daemon: neue inbound-msg `{ t:"inject", id_or_label, bytes_base64 }`. Findet session, sendet via `cb`-pipe einen `inject`-frame, `cb` schreibt in `pty.write`.
2. `bridge_write(id, text)` → inject(text als utf8 bytes).
3. `bridge_send_keys(id, keys)` → für jede Key ihre bytes via `keyToBytes`, concat, inject. **Zwischen Keys kein delay** (Spec ist "sequence", nicht "typing simulation").
4. `bridge_paste(id, text)` → `\x1b[200~` + text + `\x1b[201~`, inject als ein Block.

**Acceptance:**
- Master-Claude paste-t einen 3-zeiligen Prompt in die `hwm`-Session. Claude Code dort akzeptiert es als zusammenhängenden Block (nicht 3 separate Submits).
- `bridge_send_keys(hwm, ['ctrl-c'])` interruptet sauber.
- Ein 200-Zeichen-`bridge_write` ohne Newline landet komplett in Claude Code's input box.

**Falls bracketed-paste-mode in Claude Code NICHT enabled ist** (Test: schreib mit `bridge_paste` rein, schau ob die Literal-Escapes sichtbar werden): Fallback in `bridge_paste`: schreibe in 64-byte chunks mit 5ms delay, ohne Bracket-Wrapper. Toggle via `BRIDGE_PASTE_MODE=chunked` env-var auf Daemon-Seite.

---

### T9 — `bridge_wait_for` (pattern-Modus)

**Goal:** Trivialer Wait für regex/substring im rendered tail.

**Files:** `bridged/src/wait-for.ts`

**Steps:**
1. Watcher pro Session: registered patterns, jedes `stdout`-Frame triggert `term.write()` und dann ein Re-Scan der letzten 100 Zeilen rendered text.
2. Match → resolve mit `{matched:true, matchedLine, ms}`. Timeout → `{matched:false, ms:timeout}`.
3. `mode: "substring"` ist default, `"regex"` via `new RegExp(pattern, 'm')`.
4. MCP-Tool `bridge_wait_for(id, pattern, timeoutMs, mode)`.

**Acceptance:**
- Session in der `claude` läuft. Master ruft: `bridge_paste(hwm, "sag bitte FERTIG")`, `bridge_send_keys(hwm, ['enter'])`, `bridge_wait_for(hwm, "FERTIG", 30000)` → matched:true in <30s.

---

### T10 — `bridge_wait_for_idle` (Screen-Stability-Modus)

**Goal:** Robuste "Claude Code ist mit Antworten fertig"-Detektion. Siehe **Anhang B** für vollständigen Algorithmus.

**Files:** Erweitert `wait-for.ts`

**Steps:**
1. Implementiere `screenHashLastN(term, n=3, maskAnim=true)`:
   - Nimm letzten n Zeilen aus active buffer.
   - `maskAnim`: ersetze chars in `/[•·*✦◆●○◐◑◒◓⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g` mit `' '`.
   - Hash via `node:crypto` md5 (schnell, nicht security).
2. Tick-Loop alle 200ms pro aktivem `wait_for_idle`-Request:
   - Wenn `Date.now() - lastOutputAt < 800` → continue.
   - Hash current, push in 5-elementige FIFO.
   - Wenn alle 5 gleich → resolve `{idle:true, ms}`.
3. Timeout default 30000ms.
4. MCP-Tool ergänzen: `bridge_wait_for_idle(id, timeoutMs=30000, stableTicks=5)`.

**Acceptance-Tests (eigenes Test-Skript, mehrere Runs):**
- 10x Run: Master schickt Prompt + send-keys enter + wait_for_idle. Misst `(time wait_for_idle returns) - (time output last changed)`. Sollte konsistent <2s sein.
- **False-positive-test:** Während Claude "thinking" zeigt mit Spinner-Animation, *nicht* zu früh idle returnen. Wenn das in <5% der Runs schief geht: **STOP-Bedingung 2 getriggert**, Algorithmus nachschärfen (z.B. stableTicks erhöhen, oder zusätzlich auf "esc to interrupt" als negative-marker checken).

---

### T11 — Credential-Redaction

**Goal:** Sensitive Werte in lesendem MCP-Output maskieren.

**Files:** `bridged/src/redact.ts`

**Steps:**
1. Default-Patterns (hart-codiert):
   ```ts
   const DEFAULT = [
     { name: 'anthropic_key', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
     { name: 'openai_key',    re: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
     { name: 'github_token',  re: /gh[pousr]_[A-Za-z0-9]{30,}/g },
     { name: 'bearer',        re: /Bearer\s+[A-Za-z0-9._-]{20,}/gi },
     { name: 'env_secret',    re: /\b(?:PASSWORD|TOKEN|SECRET|API_?KEY|PRIVATE_KEY)=\S+/gi },
   ];
   ```
2. Override-File: `~/.bridge-clis/redact.json` mit `{patterns: [{name, regex}]}`. Bei start einmal laden.
3. `redact(text: string): string` → ersetze matches mit `[REDACTED:<name>]`.
4. **Wo angewendet:** *Nur* in MCP-Read-Pfaden (`read_screen`/`read_tail`/`read_raw`-Return-Value). **Nicht** im Buffer (sonst kann der User in seinem eigenen Terminal seinen API-Key nicht mehr sehen, wenn Claude ihn ausgibt).
5. `read_raw` ist tricky: redact auf ANSI-bytes funktioniert nicht zuverlässig. Spec: `read_raw` redacted nicht, returnt im response `{ warning: "raw output is not redacted" }`. Doku in README.

**Acceptance:**
- In bridged Claude-Session: `echo $env:ANTHROPIC_API_KEY` (oder echte test-string `sk-ant-abc123...`).
- Master: `bridge_read_tail(hwm, 10)` → enthält `[REDACTED:anthropic_key]`, nicht das echte Token.

---

### T12 — Race-Protection (User-typing vs. Master-inject)

**Goal:** Master-Claude bricht User-Tippen nicht in der Mitte ab. Siehe **Anhang C** für vollständiges Protocol.

**Files:** `bridged/src/session.ts` (Tracking), `bridged/src/pipe-server.ts` (Check), `bridge-mcp/src/tools.ts` (Default-Flag)

**Steps:**
1. `cb` sendet bereits `stdin`-Frames bei jedem User-Tipper (T3 hat das implementiert). Daemon trackt `session.lastUserInputAt = Date.now()` darauf.
2. Erweitere `bridge_write`/`bridge_paste`/`bridge_send_keys`-Tool-Schema um optional:
   ```
   { wait_for_user_idle_ms?: number = 1500, force?: boolean = false }
   ```
3. Tool-Handler in `bridge-mcp`:
   - Wenn `force === true`: direkt inject.
   - Sonst: hole `lastUserInputAt`. Wenn `Date.now() - lastUserInputAt < wait_for_user_idle_ms`: warte bis Differenz erfüllt (poll alle 200ms, max 10s), dann inject. Wenn 10s erreicht: return error `{ code: "user_active" }`.
4. Master-Claude-Strategie wird in README dokumentiert: bei `user_active`-Error entweder retry mit größerem timeout, oder dem User die Information geben.

**Acceptance:**
- Test-Skript: User tippt langsam in bridged session ("hallo" über 3s verteilt). Master ruft währenddessen `bridge_paste(..., text, {})`. Inject erfolgt erst *nach* User-Pause >1500ms, nicht mittendrin.
- Mit `force:true`: inject sofort, User-Input und Master-Input interleaven (zu erwartendes Verhalten — Footgun, dokumentiert).

---

### T13 — Audit-Log

**Goal:** Jeder Master→Session-Write hinterlässt Spur.

**Files:** `bridged/src/audit.ts`

**Steps:**
1. Append-only file `~/.bridge-clis/audit.log`. Format: `ISO8601 op=<paste|write|send_keys> session=<label> bytes=<n> caller=<mcp-client-id>`.
2. Rotate bei 10MB: rename zu `audit.log.1`, max 5 rotations behalten.
3. *Keine* Inhalte loggen, nur Metadaten.

**Acceptance:** Nach 3x Master-Paste: Datei existiert, 3 Zeilen, korrekte bytes-Counts.

---

### T14 — Packaging — Bundle-Strategie (siehe Anhang E für Begründung)

**Goal:** Eine `.zip` die ein User entpackt und nutzt. Kein pkg/sea-Aufwand.

**Files:** `installer/install.ps1`, build-script in root `package.json`

**Steps:**
1. Build-Step (`pnpm run dist`):
   - esbuild bundlet `cb`, `bridged`, `bridge-mcp` jeweils zu single `.cjs` mit `--external:node-pty --external:@xterm/headless` (native + heavy).
   - Output nach `dist/bridge-clis/`:
     ```
     bridge-clis/
     ├── node.exe              # offizielle Node-Embedded-Zip Variante, 30MB
     ├── cb.cjs                # esbuild output
     ├── bridged.cjs
     ├── bridge-mcp.cjs
     ├── node_modules/         # nur node-pty + @xterm/headless + ulid (mit prebuilt binaries)
     ├── cb.cmd                # @"%~dp0node.exe" "%~dp0cb.cjs" %*
     ├── bridged.cmd
     ├── bridge-mcp.cmd
     ├── install.ps1
     └── uninstall.ps1
     ```
2. `install.ps1`:
   - Kopiert nach `$env:LOCALAPPDATA\bridge-clis\`.
   - Fügt diesen Pfad zu User-PATH hinzu (via `[Environment]::SetEnvironmentVariable('Path', ..., 'User')`), idempotent (skip wenn schon drin).
   - Patcht `$env:USERPROFILE\.claude\mcp.json` (oder erstellt sie) mit:
     ```json
     { "mcpServers": { "bridge": { "command": "bridge-mcp" } } }
     ```
     **Wichtig:** vorher ein Backup `mcp.json.bak.<timestamp>` machen, NICHT überschreiben wenn `bridge`-key schon existiert (warn + skip).
3. `uninstall.ps1`: invers, mit denselben Safety-Checks.

**Acceptance:**
- Auf VM mit frischem Win11 (kein Node, kein Claude Code installiert außer per `npm install -g @anthropic-ai/claude-code` global): zip entpacken, `.\install.ps1` ausführen, neues Terminal öffnen, `cb claude` läuft.
- `claude` (Master) startet, sieht in `/mcp` den `bridge`-server, Tools sind aufgelistet.

**Falls Tag-0-Spike `node-pty`-prebuilt nicht für die installierte Node-Major-Version vorhanden hat:** Pinne in `package.json` die `node-pty`-Version auf eine mit prebuilds für die gebundelte Node-Version. Eigenständig kompilieren ist Out-of-Scope.

---

### T15 — Smoke-Test-Suite

**Goal:** Ein Skript, das den End-to-End-Flow auf einem System validiert. Wird nach Install als Sanity-Check empfohlen.

**Files:** `tests/smoke/run.ts`

**Steps:**
1. Spawne 2x `cb pwsh` (statt claude, damit Test nicht von Claude-API abhängt) mit labels `s1`, `s2`.
2. Verbinde direkt mit Daemon-Pipe (nicht über MCP — schneller).
3. Sequenz:
   - `list` → erwarte 2 Sessions.
   - `read_screen s1` → erwarte PowerShell-Prompt.
   - `inject s1: "Write-Host TESTMARKER\r"`
   - `wait_for s1 "TESTMARKER" 5000` → matched:true.
   - `wait_for_idle s1` → idle:true.
   - kill `cb` s1 → 30s warten → `list` zeigt s1 als dead, s2 alive.
   - kill s2, warte 60s → daemon-process ist weg.
4. Exit-Code 0 wenn alle Asserts pass.

**Acceptance:** Läuft grün auf der Build-VM (T14) und auf Marco's Hauptmaschine.

---

### T16 — README + Sicherheitswarnungen

**Goal:** User-facing doc. Eine Datei, knapp.

**Files:** `README.md`

**Inhalt (Pflicht-Sektionen):**
- Installation (2 Befehle: download zip, `.\install.ps1`)
- Quickstart (3 Terminal-Beispiele aus DESIGN §2)
- **Security-Warnungen** (in dieser Reihenfolge):
  1. *"bridge-mcp gehört nicht in remote-zugängliche Claude-Instanzen. Jeder, der MCP-Zugriff hat, kann jeden bridged Prozess steuern — inklusive authentifizierter Claude-Code-Sessions."*
  2. Credential-Redaction ist best-effort. Bei custom-Tokens eigene Patterns in `~/.bridge-clis/redact.json` ergänzen.
  3. Audit-Log liegt unter `~/.bridge-clis/audit.log`. Regelmäßig prüfen wenn das Tool produktiv genutzt wird.
  4. `force:true` auf write-tools umgeht Race-Protection — nur nutzen wenn man die Konsequenzen versteht.
- Liste der 9 MCP-Tools (eine Zeile pro Tool, Link zu DESIGN.md für Details).
- Uninstall (`.\uninstall.ps1`).

---

## 4. Definition of Done — finale Version

DESIGN §11 plus:

- [ ] Tag-0-Spike läuft auf der Maschine, snapshot.txt sieht korrekt aus.
- [ ] Alle 15 Tickets abgeschlossen, jeweils mit erfüllten Acceptance-Kriterien.
- [ ] Smoke-Test-Suite (T15) grün auf Build-VM und Hauptmaschine.
- [ ] `wait_for_idle` zeigt <5% false-positive in 10er-Run-Test (T10).
- [ ] Race-Protection-Test (T12) zeigt korrekten Block bei User-Aktivität.
- [ ] Install + Uninstall idempotent auf Win11 VM.
- [ ] README mit Security-Warnungen in der spezifizierten Reihenfolge.
- [ ] Marco hat einen vollen Arbeitstag das Tool mit echten DACH-Projekten genutzt ohne kritischen Bug.

---

## Anhang A — Pinned Dependencies

Festschreiben nach Tag-0-Spike-Grün. Initial-Vorschlag (an Spike-Ergebnis anpassen):

| Package | Verwendung | Version-Pin |
|---|---|---|
| `node-pty` | PTY | `^1.0.0` (prüfe ConPTY-Support für aktuelle Node-Major) |
| `@xterm/headless` | TUI-Rendering | `^5.5.0` |
| `@modelcontextprotocol/sdk` | MCP-Server | `latest` zum Build-Zeitpunkt, dann pin |
| `ulid` | Session-IDs | `^2.3.0` |
| `windows-mutex` (optional) | Single-instance | `^0.4.0` ODER via Named-Pipe als de-facto-mutex |
| `esbuild` | Bundling | `^0.21` |
| `typescript` | — | `~5.4` |
| `vitest` | Tests | `^1.6` |
| `tsx` | Dev-run | `^4.7` |

Node-Runtime: 20.10 LTS (Embedded-Zip-Variante von nodejs.org). **Nicht** newer als latest LTS, weil node-pty-prebuilds nachhinken.

---

## Anhang B — `wait_for_idle` Algorithmus (vollständig)

```ts
// in bridged/src/wait-for.ts

const ANIM_CHARS = /[•·*✦◆●○◐◑◒◓⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏▰▱]/g;

function screenHashLastN(term: Terminal, n: number, maskAnim: boolean): string {
  const buf = term.buffer.active;
  let s = '';
  const start = Math.max(0, buf.cursorY - n + 1);
  for (let y = start; y <= buf.cursorY; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    let text = line.translateToString(true);
    if (maskAnim) text = text.replace(ANIM_CHARS, ' ');
    s += text + '\n';
  }
  return createHash('md5').update(s).digest('hex');
}

export function waitForIdle(
  session: Session,
  opts: { timeoutMs: number; stableTicks: number; tickMs?: number; minSilentMs?: number }
): Promise<{ idle: boolean; ms: number }> {
  const { timeoutMs, stableTicks, tickMs = 200, minSilentMs = 800 } = opts;
  const start = Date.now();
  const hashes: string[] = [];
  return new Promise(resolve => {
    const iv = setInterval(() => {
      const elapsed = Date.now() - start;
      if (elapsed > timeoutMs) { clearInterval(iv); resolve({ idle: false, ms: elapsed }); return; }
      if (Date.now() - session.lastOutputAt < minSilentMs) return;
      const h = screenHashLastN(session.rendered, 3, true);
      hashes.push(h);
      if (hashes.length > stableTicks) hashes.shift();
      if (hashes.length === stableTicks && hashes.every(x => x === hashes[0])) {
        clearInterval(iv); resolve({ idle: true, ms: elapsed });
      }
    }, tickMs);
  });
}
```

**Tunable Defaults:** `timeoutMs=30000`, `stableTicks=5`, `tickMs=200`, `minSilentMs=800`. → idle wird frühestens 800ms+1s nach letztem Output gemeldet. Fühlbar schnell, aber robust gegen Spinner.

---

## Anhang C — Race-Protection Wire-Protocol (Erweiterung zu DESIGN §5)

**Neue Frames `cb → bridged`:**
```ts
{ t: "user_input", at: number }  // optional throttled: max 1x pro 200ms
```
Sendet `cb` bei jedem User-stdin-chunk, *zusätzlich* zum bestehenden `stdin`-Frame (oder als Replacement — entscheide bei Impl: throttled `user_input` reicht, der full `stdin`-content-frame ist optional).

**Daemon-Tracking:**
```ts
session.lastUserInputAt: number = 0; // ms
// onUserInput: lastUserInputAt = Date.now()
```

**Neue Tool-Param (T8-Tools):**
```ts
type WriteOpts = { wait_for_user_idle_ms?: number; force?: boolean };
// default wait_for_user_idle_ms = 1500
```

**Inject-Logik im Daemon:**
```ts
async function tryInject(session, bytes, opts) {
  if (opts.force) return doInject(session, bytes);
  const need = opts.wait_for_user_idle_ms ?? 1500;
  const deadline = Date.now() + 10_000; // hart-cap 10s
  while (Date.now() < deadline) {
    const silentFor = Date.now() - session.lastUserInputAt;
    if (silentFor >= need) return doInject(session, bytes);
    await sleep(Math.min(200, need - silentFor));
  }
  return { error: 'user_active', silentMs: Date.now() - session.lastUserInputAt };
}
```

---

## Anhang D — Credential-Redaction-Spec

Siehe T11. Zusätzliche Regeln:
- Regex sind `g`-flagged. Apply pro Line, nicht über Line-Breaks.
- Ersatztext: `[REDACTED:<name>]`. Konstante Länge ist *nicht* erforderlich — Master-Claude bekommt eh nur den rendered text, Cursor-Position ist getrennt.
- Custom-Patterns aus `~/.bridge-clis/redact.json` werden *nach* Default-Patterns appliziert. User kann Defaults nicht entfernen (Sicherheit). Custom-Patterns die ungültig regex sind → start-up-warning in daemon-log, skip.

---

## Anhang E — Packaging-Entscheidung (begründet)

**Optionen evaluiert:**

| Option | Pro | Contra |
|---|---|---|
| `pkg` (Vercel) | Single-binary, ~40MB | native modules brauchen Workarounds, deprecated by Vercel, AV-Flagging fast garantiert |
| Node SEA (single executable app, experimental) | Offizieller Weg, signiert-fähig | Experimental, native modules nicht offiziell supported, post-build patching nötig |
| **Bundle (Node-embedded + bundled JS + .cmd wrapper)** | Zero pkg-pain, native modules via prebuilds funktionieren out-of-box, Node.exe ist von Node-Foundation signiert (kein AV-Issue), Update-Path simpel (zip ersetzen) | ~60MB statt 40MB, drei Files in PATH statt einem |

**Entscheidung:** Bundle. Begründung: Footprint-Differenz ist unkritisch (60 vs. 40 MB), aber AV-Risiko bei pkg-binaries und SEA-Experimentalität sind echte Blocker für ein Tool, das ein einzelner Entwickler ausliefert.

---

## Anhang F — Rollback / Recovery pro Ticket

Generelle Regel: jedes Ticket auf eigenem Branch, Merge nach grünem Acceptance. Bei Scheitern:

- **T1-T6** Scheitern: lokal revert, ticket re-scope. Kein Production-Impact.
- **T7-T13** Scheitern: lokal revert, *kein* MCP-server entry in `mcp.json` schreiben bevor T15 grün ist.
- **T14 Scheitern** auf VM: install.ps1 hat backup-Schritt für `mcp.json` — restore aus `.bak`-File. Lokale `bridge-clis`-Folder löschen, PATH-entry manuell removen.
- **Nach Install im Daily-Use Marco merkt kritischen Bug:** `uninstall.ps1` ausführen, bridged-Daemon killen (`Get-Process node | Where-Object {$_.Path -like "*bridge-clis*"} | Stop-Process`). System ist clean.

---

## Anhang G — Was *nicht* gebaut wird (Anti-Scope-Creep)

Wiederholung aus DESIGN §10, hier verbindlich:
- Keine `bridge_create` / `bridge_kill` Tools.
- Keine UIA für nicht-gewrappte Fenster.
- Kein Linux/macOS.
- Keine Persistenz (kein resume after daemon-restart).
- Keine TUI für `bridged status`.
- Kein Multi-User / Remote.
- Keine `bridge_audit_tail` MCP-tool — Audit-Log ist file-based, User kann `tail` selber.

**Wenn während Implementation der Wunsch aufkommt eines davon zu bauen:** STOP, Marco fragen. Niemals heimlich.

---

**Ende.** Wenn alles bis hier befolgt wird, ist nichts mehr offen außer Tippen.
