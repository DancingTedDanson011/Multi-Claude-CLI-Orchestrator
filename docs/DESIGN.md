# bridge-clis — Design-Doc

**Status:** Draft v1 · 2026-05-18
**Autor:** Claude (mit Marco)
**Scope:** Phase A only. UIA-Fallback explizit ausgeschlossen.

---

## 1. Ziel in einem Satz

Master-Claude-Code soll mehrere parallel laufende Claude-Code-Instanzen (oder generell interaktive CLIs) **lesen, beobachten und steuern** können — jeweils in ihrem eigenen Working-Directory — über einen MCP-Server, analog zum Chrome-MCP-Modell.

## 2. Use-Case (konkret)

```
Terminal 1 (HandwerkManager):
  cd C:\dev\handwerkmanager
  cb claude --label hwm

Terminal 2 (meinesteuern):
  cd C:\dev\meinesteuern
  cb claude --label steuern

Terminal 3 (Master-Claude mit Bridge-MCP):
  cd C:\dev\orchestrator
  claude
  > "Liste alle bridged Sessions"
  > "Schick an 'hwm': sag mir den Status der Invoice-Migration"
  > "Lies die letzten 100 Zeilen von 'steuern'"
  > "Wenn 'hwm' fertig ist, schick 'steuern' den nächsten Task"
```

Master-Claude orchestriert, du tippst weiter normal in jedem Fenster mit.

## 3. Architektur — drei Komponenten

```
┌──────────────────────────────────────────────────────────────┐
│  Terminal 1            Terminal 2            Terminal N      │
│  ┌──────────┐          ┌──────────┐          ┌──────────┐    │
│  │   cb     │          │   cb     │          │   cb     │    │
│  │ (wrapper)│          │ (wrapper)│          │ (wrapper)│    │
│  │    │     │          │    │     │          │    │     │    │
│  │    ↓ PTY │          │    ↓ PTY │          │    ↓ PTY │    │
│  │  claude  │          │  claude  │          │   pwsh   │    │
│  └────┬─────┘          └────┬─────┘          └────┬─────┘    │
│       │                     │                     │          │
│       │ Named Pipe IPC      │                     │          │
│       └─────────┬───────────┴─────────┬───────────┘          │
│                 ↓                     ↓                      │
│            ┌────────────────────────────────┐                │
│            │      bridged (daemon)          │                │
│            │  - Session registry            │                │
│            │  - Headless terminal state     │                │
│            │  - Output ring buffers         │                │
│            │  - Single-instance via mutex   │                │
│            └────────────┬───────────────────┘                │
│                         │ stdio/pipe                         │
│                         ↓                                    │
│            ┌────────────────────────────────┐                │
│            │      bridge-mcp                │                │
│            │  (MCP server, spawned by       │                │
│            │   Master-Claude per .mcp.json) │                │
│            └────────────────────────────────┘                │
└──────────────────────────────────────────────────────────────┘
```

### 3.1 `cb` — der Wrapper (Terminal-side)

**Job:** Ersetzt den direkten Aufruf von `claude` / beliebiger CLI. Spawnt das eigentliche Programm in einer PTY, verbindet sich mit dem Daemon, leitet Output zum Daemon-Buffer UND zum sichtbaren stdout (für den User im Fenster), leitet User-stdin zur PTY.

**Verhalten:**
- `cb claude` → wie `claude`, nur dass es bridged ist
- `cb --label hwm claude` → explizites Label, sonst auto aus cwd-basename
- Bei Daemon-down: startet Daemon (detached subprocess), wartet kurz, verbindet
- Bei Daemon-disconnect mid-session: läuft headless weiter, versucht reconnect (silent)
- Beim Exit der inneren CLI: dereg vom Daemon, eigener Exit-Code wird durchgereicht

**Tech:** Node.js single-file binary (`pkg` oder `node --experimental-sea-config`), `node-pty` für PTY, `net.connect('\\\\.\\pipe\\bridge-clis')` für IPC.

**Output-Flow:**
```
PTY stdout → split:
  ├─→ process.stdout (User sieht Original-Terminal)
  └─→ Daemon-Pipe (Daemon parsed + buffert)

process.stdin → split:
  ├─→ PTY stdin (User-Input geht an inneren Prozess)
  └─→ Daemon-Pipe (Daemon weiß was User getippt hat, für Context)

Daemon-injected input → PTY stdin (Master-Claude steuert)
```

### 3.2 `bridged` — der Daemon

**Job:** Single-Instance Service. Hält die Session-Registry, einen Ring-Buffer pro Session (raw + rendered), gibt MCP-Clients Read/Write-Zugriff.

**Lifecycle:**
- Erstes `cb` startet ihn auto-detached (`spawn(..., { detached: true, stdio: 'ignore' })`)
- Named-Mutex `Global\bridge-clis-daemon` verhindert Doppelstart `[conf: high — Standard Windows API via node module]`
- Idle-Shutdown: nach 60s ohne aktive Sessions UND ohne MCP-Verbindung beendet sich der Daemon
- Crash-Recovery: nicht persistent. Wenn Daemon stirbt, müssen `cb`-Prozesse neu connecten (sie versuchen das automatisch)

**State (in-memory):**
```typescript
type Session = {
  id: string;            // ulid
  label: string;         // "hwm" | "steuern" | auto
  cwd: string;
  cmdline: string[];     // ["claude"] etc.
  pid: number;
  startedAt: number;
  pipeClient: net.Socket; // verbindung zum cb
  rawBuffer: RingBuffer<Uint8Array>;  // raw PTY bytes, last ~10MB
  rendered: HeadlessTerminal;          // xterm-headless instance
  status: 'alive' | 'dead';
};
```

**Headless-Terminal:** `@xterm/headless` parst die raw PTY-Bytes in einen virtuellen Screen-State. Damit kann `read_screen` einen *gerenderten* Snapshot zurückgeben (was der User sieht), nicht den raw ANSI-Soup. Kritisch für Claude-Code's Ink-basierte TUI. `[conf: medium — @xterm/headless existiert und wird so verwendet, aber Claude Code's Alt-Screen-Wechsel und partial-redraws können Edge-Cases erzeugen die Validierung brauchen]`

**Persistente Logs (optional, default off):** `~/.bridge-clis/logs/<session-id>.log` für Post-Mortem.

### 3.3 `bridge-mcp` — der MCP-Server

**Job:** Spricht das MCP-Protokoll zu Master-Claude, übersetzt zu Daemon-Calls.

**Lifecycle:** Wird von Claude Code per `.mcp.json` als stdio-Subprozess gestartet, lebt für die Dauer der Master-Claude-Session.

**Daemon-Verbindung:** Named Pipe Client. Wenn Daemon nicht läuft, startet er ihn (gleiche Logik wie `cb`).

## 4. MCP-Tool-Schema

Minimal, YAGNI-konform. Acht Tools.

### 4.1 `bridge_list`
```
() → Session[]
  { id, label, cwd, pid, status, startedAt, lastActivityAt, lineCount }
```
Listet alle bekannten Sessions. Dead-Sessions werden 5 Min nach Tod noch gezeigt, dann gepurged.

### 4.2 `bridge_read_screen`
```
(id_or_label: string) → { cols, rows, lines: string[], cursor: {row, col} }
```
Gibt den **gerenderten** sichtbaren Screen. Was der User aktuell im Terminal sehen würde. Bevorzugt für Claude-Code-TUIs.

### 4.3 `bridge_read_tail`
```
(id_or_label: string, lines?: number = 200) → { text: string, truncated: bool }
```
Gibt die letzten N Zeilen aus dem **scrollback** (gerendert, plain text, kein ANSI). Für historische Inspektion.

### 4.4 `bridge_read_raw`
```
(id_or_label: string, sinceMs?: number, maxBytes?: number = 100_000) 
  → { bytes_base64: string, latestTimestamp: number }
```
Raw PTY-Stream seit Zeitpunkt X. Für Spezialfälle (Debug, Replay). Default-Verbrauch hoch — sparsam nutzen.

### 4.5 `bridge_write`
```
(id_or_label: string, text: string) → { written: number }
```
Schickt Text in stdin. **Kein** Auto-Newline. Verbatim.

### 4.6 `bridge_send_keys`
```
(id_or_label: string, keys: Key[]) → ok
  Key = "enter" | "tab" | "esc" | "up" | "down" | "left" | "right" 
      | "ctrl-c" | "ctrl-d" | "ctrl-l" | "backspace" | "delete" 
      | "home" | "end" | "pageup" | "pagedown"
      | { literal: string }
```
Strukturiertes Senden von Steuerzeichen + Text in Sequenz. Resolved intern zu den korrekten Escape-Codes.

### 4.7 `bridge_paste`
```
(id_or_label: string, text: string) → ok
```
Schickt Text mit bracketed-paste-mode-Wrappern (`ESC[200~ ... ESC[201~`). Sicher für mehrzeilige Prompts an Claude Code. **Default-Tool für "schick diesen Prompt an die andere Session".**

### 4.8 `bridge_wait_for`
```
(id_or_label: string, pattern: string, timeoutMs?: number = 30_000, 
 mode?: "regex"|"substring" = "substring") 
  → { matched: bool, matchedLine?: string, ms: number }
```
Blockiert bis Pattern im Output erscheint oder Timeout. Essentiell für "schick Prompt → warte bis Antwort fertig → lies Antwort".

**Bewusst weggelassen** (YAGNI):
- `bridge_create` — Sessions entstehen nur durch `cb` im User-Terminal, nicht über MCP. Schützt vor "headless ghost claudes"
- `bridge_kill` — User killt selbst über sein Terminal. Reduziert Footgun-Risiko
- `bridge_resize` — wird automatisch vom `cb`-Wrapper auf Terminal-Resize hin propagiert

## 5. IPC-Protokoll (`cb` ↔ `bridged`)

Newline-delimited JSON über Named Pipe `\\.\pipe\bridge-clis`. Frame-Sicher durch length-prefix vor jedem JSON-Blob:

```
<4-byte LE uint32: payload length><JSON payload>
```

### 5.1 Messages: `cb` → `bridged`

```typescript
{ t: "hello", session: { id, label, cwd, cmdline, pid, cols, rows } }
{ t: "stdout", data: <base64> }       // jedes PTY-output-chunk
{ t: "stdin",  data: <base64> }       // jedes User-typed-chunk (für Context)
{ t: "resize", cols, rows }
{ t: "bye",    exitCode: number }
{ t: "pong" }
```

### 5.2 Messages: `bridged` → `cb`

```typescript
{ t: "inject", data: <base64> }       // Master-Claude will was reinschreiben
{ t: "ping" }                          // 10s heartbeat
```

### 5.3 Heartbeat & Disconnect

- Daemon sendet alle 10s `ping`, `cb` antwortet `pong`
- 3 verpasste pongs → Daemon markiert Session `status="dead"`, behält Buffer
- `cb` sendet 3 verpasste pings → versucht reconnect

## 6. Security

**Bedrohungsmodell:** Lokal-only. Kein Netzwerk, kein Multi-User.

- Named-Pipe ACL: nur der erstellende User darf connecten. Setzen via `node-windows` oder direkt via `\\?\pipe\` + Win32 ACL `[conf: medium — muss in der Implementation verifiziert werden, default Named Pipe ACL ist meist user-only aber nicht garantiert]`
- Kein TCP-Listener. Kein localhost:port.
- Daemon läuft als der User, nicht als Service / Admin.
- `bridge-mcp` startet Daemon nur wenn der User-MCP-Server selbst läuft — kein Privilege-Escalation.

**Wichtige Footgun-Warnung in der README:** Wer den MCP-Server nutzen darf, kann *jeden* gewrappten Prozess steuern, inklusive `claude` mit voll authentifiziertem API-Key. Dieser MCP gehört nicht in remote-zugängliche Claude-Instanzen.

## 7. Failure-Modes & Recovery

| Failure | Detection | Recovery |
|---|---|---|
| Daemon crash | `cb` verliert Connection | `cb` läuft headless weiter, polled reconnect alle 5s |
| `cb`-Prozess gekillt aber innere CLI lebt | Pipe-EOF | Innere CLI läuft normal weiter, ist nur nicht mehr bridged |
| Innere CLI crash | PTY-Exit | `cb` sendet `bye{exitCode}`, terminiert selbst |
| Daemon hat Session als "alive" aber Prozess ist tot | PID-Poll alle 30s | Mark als dead, behalte Buffer 5min |
| MCP-Tool-Call auf dead Session | Daemon antwortet `error: session_dead` | MCP gibt klaren Fehler an Master-Claude |
| Master-Claude `bridge_wait_for` Timeout | Daemon hat Watcher mit setTimeout | Antwort `{matched: false, ms: <timeout>}` |
| Konkurrierende Writes (User tippt + Master schreibt gleichzeitig) | nicht detect-bar | **Nicht gelöst.** Doku-Warnung. Master sollte `bridge_wait_for` nutzen um auf Idle zu warten |

## 8. Implementation-Plan

### Tag 1 — Skelett
- Repo-Init, `pnpm`, TypeScript strict, ESM
- Drei Packages in monorepo: `cb`, `bridged`, `bridge-mcp`
- `cb` spawnt PTY, leitet I/O durch, schreibt Hello in Pipe (Mock-Daemon nur prints)
- `bridged` MVP: accept Pipe-Connection, log alles
- Sanity-Test: `cb pwsh` startet PowerShell, User kann tippen, alles funktioniert wie ohne `cb`

### Tag 2 — Daemon + Buffer
- Session-Registry, Ring-Buffer (raw)
- `@xterm/headless` integration, rendered-Snapshot
- IPC-Protokoll vollständig, heartbeat
- `bridge-mcp` Skelett mit `bridge_list` + `bridge_read_screen`
- Test mit Claude Code als gewrappter Prozess: rendert das ohne Glitches?

### Tag 3 — Write-Path + Wait
- `bridge_write`, `bridge_send_keys`, `bridge_paste`
- `bridge_wait_for` mit Watcher
- Multi-Session-Test: zwei `cb claude` parallel, Master-Claude orchestriert
- Failure-Mode-Tests (Daemon-Kill, CLI-Kill, Reconnect)

### Tag 4 — Polish
- `pkg` Binary für `cb` (~40MB, akzeptabel)
- Install-Script (PowerShell): legt `cb.exe` in PATH, registriert `bridge-mcp` in user's `.mcp.json`
- README mit Sicherheitswarnungen
- Smoke-Test-Suite

## 9. Offene technische Fragen

1. **Claude Code's TUI im Alt-Screen-Modus** — wenn Claude in den Alternate-Screen-Buffer wechselt (was es vermutlich tut für die Eingabe-Box), wie zuverlässig rendert `@xterm/headless` das? Tag-2-Test wird das zeigen. Fallback: `bridge_read_raw` und Master-Claude muss selbst parsen. `[conf: low — muss empirisch verifiziert werden]`

2. **`bridge_paste` an Claude Code** — Claude Code in TUI-Mode erwartet vermutlich keine bracketed-paste-Escapes (vs. wenn man interaktiv ein Prompt eintippt). Test: `printf '\e[200~hallo\e[201~\n' > /dev/tty` in der bridged Session und schauen ob Claude den Text annimmt. Falls nein: `bridge_paste` schickt Zeichen-für-Zeichen mit kleinem Delay. `[conf: low]`

3. **Wann ist eine Claude-Code-Antwort "fertig"?** — `bridge_wait_for` braucht ein Pattern. Claude Code hat vermutlich einen distinkten Prompt-Marker am Zeilenanfang wenn es auf Input wartet. Muss empirisch ermittelt werden. Fallback: idle-detection (5s ohne Output → vermutlich fertig). `[conf: low]`

4. **Multiple `cb`-Instanzen mit demselben Label** — auto-suffix (`hwm-2`)? Reject? **Vorschlag:** auto-suffix, gibt Warnung im `cb`-Output.

5. **Windows-User mit nicht-administrativen Rechten und Named-Mutex `Global\`** — `Global\` braucht SeCreateGlobalPrivilege. Fallback: `Local\bridge-clis-daemon` reicht für single-user-Szenario. `[conf: high]`

## 10. Was später kommt (Phase B+, NICHT jetzt)

- UIA-Fallback an nicht-gewrappte Fenster
- Linux/macOS Support
- Persistente Session-Replay
- Multi-User / Remote-Bridge über SSH
- TUI für `bridged status` (CLI-Inspector)
- Recording / Time-Travel-Debugging

## 11. Definition of Done für Phase A

✅ `cb claude` läuft wie `claude` — kein User-merklicher Unterschied
✅ Zwei parallele `cb`-Sessions sind via `bridge_list` sichtbar
✅ Master-Claude kann mit `bridge_read_screen` den aktuellen Stand einer anderen Session sehen
✅ Master-Claude kann mit `bridge_paste` + `bridge_send_keys[enter]` einen Prompt an eine andere Claude-Session schicken, der dort verarbeitet wird
✅ `bridge_wait_for` blockt bis Claude fertig geantwortet hat
✅ Daemon-Kill und Reconnect ohne Daten-Verlust für laufende Sessions
✅ Smoke-Test-Suite läuft grün auf einem frischen Windows-11

## 12. Risiken (kalibriert)

| Risiko | Impact | Wahrscheinlichkeit | Mitigation |
|---|---|---|---|
| `@xterm/headless` rendert Claude Code TUI fehlerhaft | Hoch (Kernfeature broken) | Mittel | Tag-2 Spike-Test mit echtem Claude Code, Fallback raw-stream |
| `node-pty` + Claude Code Alt-Screen-Issues | Mittel | Niedrig | node-pty + Windows Terminal funktionieren in der Praxis |
| Race Conditions User-Input vs. Master-Input | Mittel | Mittel | Doku + Wait-Pattern, kein Lock-Mechanismus in v1 |
| Daemon-Memory-Leak bei langlaufenden Sessions | Niedrig | Mittel | Ring-Buffer mit harter Obergrenze, regelmäßige Tests |
| Antivirus flaggt `cb.exe` (pkg-binary) | Mittel | Niedrig-Mittel | Signieren mit Code-Cert, oder als Node-Script + .cmd-wrapper distributen |

---

**Nächster Schritt nach Approval:** Tag-1-Spike — `cb pwsh` als minimal-PTY-wrapper, dann Tag-2-Spike mit `@xterm/headless` + echtem Claude Code, um die zwei größten Unknowns früh zu killen.
