# Tag-0 Spike

**Question:** Does `@xterm/headless` render Claude Code's Ink TUI through `node-pty` + ConPTY on Windows cleanly?

## Run

```powershell
cd spike
npm install
node render-test.mjs
```

You can pass any command instead of claude:
```powershell
node render-test.mjs pwsh
node render-test.mjs cmd
```

## Acceptance (all three must pass — gate for whole project)

- **A)** User terminal shows normal Claude UI with no visual glitch
- **B)** `snapshot.txt` (written every 2s) shows coherent screen state — input box at bottom, welcome text at top, cursor at plausible position. No doubled ANSI codes, no broken lines.
- **C)** Send a short prompt to Claude ("say hello in 5 words"), get a response. Snapshot taken after the response contains the response as readable plain text.

## If it fails

- Try with `pwsh` first. If pwsh is broken too → `node-pty`/ConPTY issue, escalate to ticket re-plan.
- If only Claude is broken → Ink-specific. Design raw-stream fallback path BEFORE proceeding to Tag 1.

## What's pinned

After spike passes, `cd ../packages/shared && npm ls > ../../spike/versions-known-good.txt` to capture the working version set.
