# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `/bridge` slash command installed into `~/.claude/commands/` by setup.ps1. Activates Multi-Genie Orchestrator mode in any Claude Code session without a separate launcher.
- `bridge_send_and_wait` MCP tool: combines paste + enter + wait_for_idle + read_tail in one call. Master cannot forget the wait step or politely ask permission to wait.
- Auto-sanitization of invalid label characters in the worker launcher (spaces, slashes, etc. become hyphens, fallback to `session`).
- Master prompt is now English-baseline with explicit language-detect instruction so non-German users get responses in their own language.

### Changed

- Master prompt rewritten as a heavy multi-genie orchestrator spec with first-turn protocol, question detection, quality-control loop, periodic sweep, memory discipline, and notification compliance rules.
- TypeScript composite-mode plus project references removed from package configs. Build is now straightforward (`pnpm -r build` runs in topological order, no `.tsbuildinfo` cache surprises).

### Fixed

- CI: typecheck step removed (build already typechecks; composite-mode race made it fail with TS2307).

## [0.1.0] - 2026-05-24

Initial public release. Windows-first, Phase A complete.

### Added

- `cb` PTY wrapper with transparent passthrough, pre-connect buffering, race-protected reconnect, and resume-by-ULID after transient pipe drops
- `bridged` daemon: session registry, headless xterm rendering, ring buffer, race-protected inject, wait-for primitives, audit log, credential redaction, notification queue, cross-restart session persistence
- `bridge-mcp` MCP server with 12 tools
- Named Pipe authentication via per-daemon shared secret (32 bytes, atomic O_EXCL write)
- Pipe-as-mutex single-instance pattern (no separate mutex pipe)
- Session restore after reboot via `bridge_session_history` plus `bridge_restore_sessions`
- Async notifications: `task_complete`, `session_added`, `session_dead`, `session_exited`
- Status footer auto-appended to every MCP tool response
- Window titles for worker, master, and watch processes
- `bclaude` launcher with worker / master / watch / register-only modes
- Master init-prompt (`launcher/master-prompt.md`) explaining the toolset
- Watch dashboard (`bclaude --watch`) with live polling and notification view
- One-click setup script (`setup.ps1`)
- End-to-end smoke suite covering happy path plus race-protection regression

### Security

All findings from the pre-release multi-auditor pass were resolved before this release. Details in [docs/AUDIT.md](docs/AUDIT.md).

- 6 CRITICAL findings resolved (xterm-headless indexing, pre-handshake stdout drop, inject-ACK lies, pipe authentication and TOCTOU, cmdline redaction in `bridge_list`, daemon idle-shutdown gate)
- 6 load-bearing HIGH findings resolved (force gate, frame DoS, audit-log injection, expanded redaction patterns, ReDoS protection, raw-bytes opt-in)
- 13 MEDIUM findings resolved or documented as accepted trade-offs

### Known limitations

- Windows only for now (PTY abstraction is portable, but launcher and installer are Windows-specific)
- Production-bundle installer (single zip with embedded Node) is scaffolded but not yet polished
- No code-signing certificate yet (some AV products may flag fresh builds)
- Some redaction patterns can be evaded by terminal column-wrap splits
