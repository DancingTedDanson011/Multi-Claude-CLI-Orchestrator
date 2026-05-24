---
name: Bug report
about: Something does not work the way it should
title: '[bug] '
labels: bug
assignees: ''
---

## What happened

(describe the behaviour you saw)

## What you expected

(describe what should have happened)

## Steps to reproduce

1.
2.
3.

## Environment

- Windows version (winver):
- Node version (`node -v`):
- pnpm version (`pnpm -v`):
- Claude Code version (`claude --version`):
- bridge-clis commit / version:

## Logs

Please attach (or paste relevant excerpts of):

- `~/.bridge-clis/cb.log`
- `~/.bridge-clis/bridged.log`
- `~/.bridge-clis/bridge-mcp.log`

Do not paste your shared secret (`~/.bridge-clis/daemon.secret`). If you suspect credentials leaked into logs, run a quick grep for `sk-ant-`, `sk-`, `Bearer `, etc. before pasting.

## Additional context

(screenshots, repro repo, etc.)
