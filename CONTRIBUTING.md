# Contributing

Thanks for the interest. This project is in early-stage personal use, so contributions are welcome but please align on direction first via an issue before sending a large PR.

## Dev setup

```powershell
git clone https://github.com/DancingTedDanson011/Multi-Claude-CLI-Orchestrator.git
cd Multi-Claude-CLI-Orchestrator
.\setup.ps1
```

The setup script installs deps, builds all packages, registers the launcher in your user PATH, and registers the bridge MCP server with Claude Code. It also runs the smoke test at the end. Pass `-NoTest` to skip the smoke.

## Dev loop

```powershell
pnpm -r build       # after any TypeScript change
pnpm test:smoke     # full end-to-end check (about 2 minutes)
```

For iterating on the master init prompt: edit `launcher/master-prompt.md`. No rebuild needed, takes effect on the next `bclaude --master` invocation.

For iterating on launcher behavior: edit `launcher/bclaude.ps1`. No rebuild needed.

## Project layout

See the layout table in the [README](README.md).

## Coding conventions

- TypeScript strict mode, plus `noUncheckedIndexedAccess` and `noImplicitOverride`
- ESM throughout (`"type": "module"`)
- Two-space indent, LF line endings (CRLF for `.ps1` and `.cmd`)
- No emoji in source files unless the task explicitly calls for it
- Comments document WHY (constraint, prior bug, non-obvious tradeoff), not WHAT

## Architecture changes

For non-trivial changes (new IPC frames, new MCP tools, daemon lifecycle):

1. Open an issue describing the problem and the proposed approach
2. Update [docs/DESIGN.md](docs/DESIGN.md) before merging, not after
3. Update [docs/EXECUTION.md](docs/EXECUTION.md) acceptance criteria
4. Add or extend the smoke suite when behavior changes

## Tests

The smoke suite (`tests/smoke/run.ts`) is the integration backbone. It spawns two cb wrappers around pwsh, exercises every major path (list, read, write, wait, race-protection, death detection, idle shutdown), and asserts on outcomes. A PR that adds a new MCP tool or daemon state machine should extend the smoke.

## License

By contributing, you agree your contributions will be licensed under the MIT license that covers this repository.
