# bclaude — universal launcher

Single command for both bridged worker sessions and the master orchestrator.

## Quick install (dev mode, no install.ps1 needed)

```powershell
# Add to your PATH (one-time, current session only):
$env:Path += ";C:\Users\DancingTedDanson\Desktop\bridge clis wie mcp\launcher"

# Or permanent (current user):
$existing = [Environment]::GetEnvironmentVariable('Path', 'User')
[Environment]::SetEnvironmentVariable('Path', "$existing;C:\Users\DancingTedDanson\Desktop\bridge clis wie mcp\launcher", 'User')
# → open a NEW terminal to pick up the change
```

## Usage

```powershell
# Worker (bridged Claude) — label auto-derived from cwd basename
cd C:\dev\handwerkmanager
bclaude
# → cb --label handwerkmanager npx @anthropic-ai/claude-code --dangerously-skip-permissions

# Worker with explicit label
bclaude --label hwm

# Worker passing extra args to Claude
bclaude --label hwm -- --resume

# Master (orchestrator with bridge-MCP)
bclaude --master
# → registers bridge-MCP if not yet, starts claude with default init-prompt

# Master with custom init-prompt
bclaude --master --prompt "Du bist Test-Master. Liste alle Sessions auf, dann warte."

# Master without any init-prompt (vanilla claude with MCP attached)
bclaude --master --no-prompt

# Just register the MCP server, don't start Claude
bclaude --master --register-only
```

## Resolution order

1. Looks for production bundle at `%LOCALAPPDATA%\bridge-clis\` (cb.cjs, bridged.cjs, bridge-mcp.cjs, node.exe)
2. Falls back to dev layout: `<launcher-parent>\packages\*\dist\index.js` with system `node`
3. If neither: errors out

## Init prompt

Default master init-prompt lives at `master-prompt.md` next to this script.
It explains the 9 bridge tools, the standard send/wait/read workflow, and the
race-protection / redaction semantics. Master-Claude sees this as its first
user message, which biases it to use the tools correctly.

Override per-invocation with `--prompt "..."`; suppress entirely with `--no-prompt`.

## Worker label

If `--label` is omitted, the label defaults to `Split-Path -Leaf $PWD`. So
`cd C:\dev\meinesteuern; bclaude` yields label `meinesteuern`.

Labels must match `^[A-Za-z0-9._-]{1,64}$` (audit H4). The launcher rejects
invalid labels before spawning cb.
