<#
.SYNOPSIS
  bclaude-watch — live dashboard of all bridged sessions.

.DESCRIPTION
  Polls the bridge daemon every 2s via the pipe-helper protocol (same auth as
  bridge-mcp) and renders a tabular view of all sessions + their activity.
  Run in a separate terminal alongside `bclaude --master` and your workers.

  Ctrl-C to exit.
#>

[CmdletBinding()]
param(
  [int] $IntervalMs = 2000
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# --- Resolve paths (same logic as bclaude.ps1) ---
function Resolve-BridgePaths {
  $prodRoot = Join-Path $env:LOCALAPPDATA 'bridge-clis'
  if (Test-Path (Join-Path $prodRoot 'cb.cjs')) {
    return @{
      Node = Join-Path $prodRoot 'node.exe'
      WatchClient = Join-Path $prodRoot 'watch-client.cjs'
      RepoMode = $false
    }
  }
  $repoRoot = Split-Path -Parent $ScriptDir
  $watchClientDev = Join-Path $ScriptDir 'watch-client.mjs'
  if (Test-Path (Join-Path $repoRoot 'packages\bridged\dist\index.js')) {
    return @{
      Node = (Get-Command node -ErrorAction Stop).Source
      WatchClient = $watchClientDev
      RepoMode = $true
    }
  }
  throw "bridge-clis not built. Run 'pnpm -r build' first."
}

$bridge = Resolve-BridgePaths

# OSC window title
try { [Console]::Write("`e]0;[bclaude watch]`a") } catch { }

# Run the JS watch client (it speaks the daemon protocol directly).
& $bridge.Node $bridge.WatchClient $IntervalMs
exit $LASTEXITCODE
