<div align="center">

# Multi-Claude CLI Orchestrator

**tmux for Claude Code agents.** One master Claude reads and controls many worker Claude Code sessions running across your terminals, via the Model Context Protocol.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![CI](https://github.com/DancingTedDanson011/Multi-Claude-CLI-Orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/DancingTedDanson011/Multi-Claude-CLI-Orchestrator/actions/workflows/ci.yml)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D6?logo=windows&logoColor=white)](#quick-start-windows)
[![Node](https://img.shields.io/badge/Node-%E2%89%A520.10-43853d?logo=node.js&logoColor=white)](#development)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](#development)
[![MCP](https://img.shields.io/badge/MCP-12_tools-7c3aed)](#tools-the-master-gets)

Session persistence | Restore after reboot | Live dashboard | Async notifications | Race-protected inject | Credential redaction

</div>

---

## Status

Phase A is feature-complete on Windows. The smoke suite covers the full end-to-end path. A multi-auditor pass cleared 6 CRITICAL plus 6 load-bearing HIGH findings before this initial release. Daily-driven by the author.

Open source under the **MIT license**: free for any use, personal or commercial, with attribution. Fork it, ship it, build on it. See [LICENSE](LICENSE).

## What it does

You wrap Claude Code (or any interactive CLI) in a transparent PTY bridge. A central daemon tracks every wrapped session. A master Claude, running with the included MCP server, can:

- list all bridged sessions
- read what is on each session's screen
- send text and keystrokes (with race protection so user typing is never trampled)
- wait for a session to become idle (= worker finished answering)
- restore the sessions that were open before the last reboot

You keep typing normally in each terminal. The master sees what you see, and can act on any of them when you ask.

## Quick start (Windows)

```powershell
git clone https://github.com/DancingTedDanson011/Multi-Claude-CLI-Orchestrator.git
cd Multi-Claude-CLI-Orchestrator
.\setup.ps1
```

Then in a fresh terminal:

```powershell
# in any project folder
bclaude

# in a separate terminal: master with the bridge MCP loaded
bclaude --master

# OR: inside any normal claude session, type the slash command
claude
> /bridge

# optional: live dashboard of all sessions
bclaude --watch
```

The setup script installs dependencies, builds the four TypeScript packages, adds the launcher to your user PATH, registers the bridge MCP server with Claude Code, installs the `/bridge` slash command into `~/.claude/commands/`, and runs the smoke suite to confirm everything works.

After setup, `/bridge` is available in any Claude Code session and switches it into multi-genie orchestrator mode without needing a separate launcher.

## How it works (90 seconds)

Three components:

1. `cb` (or `bclaude` via the launcher): transparent PTY wrapper. You see the same Claude UI as without it. Bytes flow through a Named Pipe to the daemon.
2. `bridged`: single-instance background daemon. Holds per-session state (raw ring buffer, headless xterm render, dead-session retention). Spawned on demand by the first `cb`.
3. `bridge-mcp`: MCP server spawned by master Claude. Speaks the same Named Pipe protocol. Exposes 12 tools.

All local, all single-user. The pipe is owner-only via a per-daemon shared secret in `~/.bridge-clis/daemon.secret`.

## Tools the master gets

| Tool | What it does |
|---|---|
| `bridge_list` | list all live sessions (id, label, cwd, status, pid) |
| `bridge_read_screen` | rendered terminal snapshot of one session |
| `bridge_read_tail` | last N lines of scrollback (plain text, redacted) |
| `bridge_read_raw` | raw PTY bytes since timestamp (opt-in, NOT redacted) |
| `bridge_write` | send text to a session's stdin |
| `bridge_send_keys` | send control keys (enter, esc, ctrl-c, arrows) |
| `bridge_paste` | bracketed paste (default for sending Claude prompts) |
| `bridge_wait_for` | block until pattern appears (regex or substring) |
| `bridge_wait_for_idle` | block until screen is stable (= worker finished) |
| `bridge_notifications` | drain async events (worker done, session died, new session added) |
| `bridge_session_history` | persisted log across daemon restarts |
| `bridge_restore_sessions` | spawn new terminal windows for previous sessions |

## Three-terminal workflow

```
Terminal 1  cd C:\dev\projectA   bclaude              <- worker, label "projectA"
Terminal 2  cd C:\dev\projectB   bclaude              <- worker, label "projectB"
Terminal 3                       bclaude --master     <- master with bridge MCP

In the master window you can now say things like:
  "list bridged sessions"
  "what is in projectA right now?"
  "send projectB a prompt: refactor the auth module"
  "wait until projectB is done and read me the answer"
  "open the sessions from before my last reboot"
```

The master init-prompt at `launcher/master-prompt.md` explains the tools to the master Claude on startup so you do not have to.

## Restore after reboot

Every wrapped session is persisted to `~/.bridge-clis/sessions.json` with its cwd and command line. After a reboot, run `bclaude --master` and ask:

```
"open the sessions that were running before the reboot"
```

The master calls `bridge_session_history` to see what was alive at the last shutdown, then `bridge_restore_sessions` which spawns one new terminal window per session via Windows Terminal (with cmd.exe fallback). Each new window opens in the original cwd and runs `bclaude --label <name>` automatically.

## Security

This tool is for single-user local development. It is not designed for shared machines or remote access.

- Pipe authentication uses a 32-byte shared secret regenerated at each daemon startup.
- All read paths run output through a redactor that catches Anthropic, OpenAI, Stripe (live), AWS, Slack, GitHub, JWT, and PEM private-key shapes.
- Inject calls block while the user is actively typing in the target session (default 1500ms idle requirement, audit-defined).
- `--dangerously-skip-permissions` on the inner Claude is passed through. Treat the master like any privileged developer tool.
- Append-only audit log of every master-to-worker write at `~/.bridge-clis/audit.log`.
- Force-bypass and raw-byte reads are gated behind explicit env flags (`BRIDGE_ALLOW_FORCE=1`, `BRIDGE_ALLOW_RAW=1`).

Full threat model and known gaps: see [SECURITY.md](SECURITY.md). Detailed audit history: see [docs/AUDIT.md](docs/AUDIT.md).

## Architecture and design docs

- [docs/DESIGN.md](docs/DESIGN.md): architectural reference, IPC protocol, MCP tool schemas, failure modes
- [docs/EXECUTION.md](docs/EXECUTION.md): the ticket-by-ticket implementation plan with acceptance criteria
- [docs/AUDIT.md](docs/AUDIT.md): consolidated multi-auditor report with resolution status

## Development

```powershell
.\setup.ps1            # full install + build + PATH + MCP + smoke
pnpm -r build          # rebuild after source changes
pnpm test:smoke        # full end-to-end smoke (about 2 minutes)
```

Layout:

```
packages/
  shared/      protocol types, framing, key encoding, auth helpers
  cb/          PTY wrapper, pipe client, daemon-spawn
  bridged/     daemon: registry, ring buffer, xterm-headless, wait-for,
               redact, audit, persistence, notifications
  bridge-mcp/  MCP server, 12 tools, daemon client
launcher/      bclaude.ps1, bclaude-watch.ps1, master-prompt.md
tests/smoke/   end-to-end suite
docs/          DESIGN.md, EXECUTION.md, AUDIT.md
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev loop.

## Roadmap

Phase A (Windows + Claude Code) is feature-complete and battle-tested via the included smoke suite. Open items:

- Linux and macOS support (PTY abstraction holds, mostly a packaging job)
- Production bundle installer with Node-embedded zip
- Code-signing certificate to avoid AV false positives
- Public demo recording

## License

MIT. Free for any use, personal or commercial, with attribution. Fork it, ship it, build on it. See [LICENSE](LICENSE) for the legal text.

If you build something on top of this and want to share it, open an issue or PR. Not required, just appreciated.
