<#
.SYNOPSIS
  bclaude — universal launcher for bridged Claude Code workers and the master orchestrator.

.DESCRIPTION
  Worker mode (default):
    bclaude [--label <name>] [-- ...claude-args]
        → cb --label <name> npx @anthropic-ai/claude-code --dangerously-skip-permissions ...claude-args

  Master mode:
    bclaude --master [--prompt "..."] [--no-prompt] [--register-only] [-- ...claude-args]
        → (ensure bridge-MCP registered) → npx @anthropic-ai/claude-code --dangerously-skip-permissions [init-prompt] ...claude-args

  Arguments after a literal `--` are passed verbatim to claude.

  We parse args manually so both `--foo`/`--foo bar` (GNU style) and any
  PowerShell-isms work consistently.

.EXAMPLE
  cd C:\dev\handwerkmanager
  bclaude
  # → starts bridged Claude with label "handwerkmanager"

.EXAMPLE
  bclaude --label hwm

.EXAMPLE
  bclaude --master
  # → master orchestrator with default init-prompt

.EXAMPLE
  bclaude --master --prompt "Du bist Tester. Liste alle Sessions auf."

.EXAMPLE
  bclaude --master --no-prompt -- --resume
  # → master without init-prompt, passes --resume to claude
#>

[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $RawArgs
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# -----------------------------------------------------------------------------
# Manual argument parse — independent of PowerShell binding quirks.
# Supports:
#   --master | --no-prompt | --register-only | --help | -h
#   --label <name> | --label=<name>
#   --prompt <text> | --prompt=<text>
#   --                       (end of bclaude args; rest go to claude verbatim)
# -----------------------------------------------------------------------------
function Parse-Args {
  param([string[]] $a)
  $out = @{
    Master = $false
    Watch = $false
    NoPrompt = $false
    RegisterOnly = $false
    Help = $false
    Label = $null
    Prompt = $null
    PassThrough = @()
    ParseError = $null
  }
  if (-not $a) { return $out }
  $i = 0
  while ($i -lt $a.Count) {
    $tok = $a[$i]
    switch -CaseSensitive ($tok) {
      '--master'        { $out.Master = $true; $i++; continue }
      '--watch'         { $out.Watch = $true; $i++; continue }
      '--no-prompt'     { $out.NoPrompt = $true; $i++; continue }
      '--register-only' { $out.RegisterOnly = $true; $i++; continue }
      '--help'          { $out.Help = $true; $i++; continue }
      '-h'              { $out.Help = $true; $i++; continue }
      '--' {
        # Everything after `--` goes through verbatim.
        if ($i + 1 -lt $a.Count) { $out.PassThrough = @($a[($i + 1)..($a.Count - 1)]) }
        return $out
      }
      default {
        if ($tok.StartsWith('--label=')) { $out.Label = $tok.Substring(8); $i++; continue }
        if ($tok.StartsWith('--prompt=')) { $out.Prompt = $tok.Substring(9); $i++; continue }
        if ($tok -eq '--label') {
          if ($i + 1 -ge $a.Count) { $out.ParseError = '--label requires a value'; return $out }
          $out.Label = $a[$i + 1]; $i += 2; continue
        }
        if ($tok -eq '--prompt') {
          if ($i + 1 -ge $a.Count) { $out.ParseError = '--prompt requires a value'; return $out }
          $out.Prompt = $a[$i + 1]; $i += 2; continue
        }
        # Unknown token → goes to PassThrough (user can pass claude-args without `--` separator if they want).
        $out.PassThrough += $tok
        $i++
      }
    }
  }
  return $out
}

function Show-Usage {
  $u = @"
bclaude — universal launcher for bridge-clis

Worker mode (default):
  bclaude [--label <name>] [-- <claude-args...>]

Master mode:
  bclaude --master [--prompt "<text>"] [--no-prompt] [--register-only] [-- <claude-args...>]

Examples:
  bclaude                                  # bridged worker, label = cwd basename
  bclaude --label hwm                      # bridged worker with explicit label
  bclaude --master                         # master with default init-prompt
  bclaude --master --prompt "..."          # master with custom init-prompt
  bclaude --master --no-prompt             # master, no init-prompt
  bclaude --master --register-only         # just register the MCP, don't start
  bclaude --label hwm -- --resume          # extra args after -- go to claude
"@
  Write-Host $u
}

$opts = Parse-Args $RawArgs

if ($opts.Help) { Show-Usage; exit 0 }
if ($opts.ParseError) {
  Write-Host ("bclaude: " + $opts.ParseError) -ForegroundColor Red
  Show-Usage
  exit 2
}

# -----------------------------------------------------------------------------
# Resolve bridge-clis install layout: production (LOCALAPPDATA) or dev (repo).
# -----------------------------------------------------------------------------
function Resolve-BridgePaths {
  $prodRoot = Join-Path $env:LOCALAPPDATA 'bridge-clis'
  if (Test-Path (Join-Path $prodRoot 'cb.cjs')) {
    return @{
      Mode = 'prod'
      Root = $prodRoot
      Node = Join-Path $prodRoot 'node.exe'
      Cb = Join-Path $prodRoot 'cb.cjs'
      Bridged = Join-Path $prodRoot 'bridged.cjs'
      BridgeMcp = Join-Path $prodRoot 'bridge-mcp.cjs'
    }
  }
  $repoRoot = Split-Path -Parent $ScriptDir
  $cbDev = Join-Path $repoRoot 'packages\cb\dist\index.js'
  $mcpDev = Join-Path $repoRoot 'packages\bridge-mcp\dist\index.js'
  if (Test-Path $cbDev) {
    return @{
      Mode = 'dev'
      Root = $repoRoot
      Node = (Get-Command node -ErrorAction Stop).Source
      Cb = $cbDev
      Bridged = Join-Path $repoRoot 'packages\bridged\dist\index.js'
      BridgeMcp = $mcpDev
    }
  }
  throw "bridge-clis not found. Looked in:`n  $prodRoot`n  $repoRoot`nBuild first (pnpm -r build) or install."
}

# -----------------------------------------------------------------------------
# Ensure bridge MCP is registered with Claude Code (user scope). Idempotent.
# -----------------------------------------------------------------------------
function Ensure-BridgeMcpRegistered {
  param([string] $BridgeMcpPath, [string] $NodePath)

  $claude = Get-Command claude -ErrorAction SilentlyContinue
  if (-not $claude) {
    Write-Host "[bclaude] 'claude' not in PATH. Skipping MCP registration check." -ForegroundColor Yellow
    Write-Host ("[bclaude] To register manually:  claude mcp add bridge --scope user -- `"" + $NodePath + "`" `"" + $BridgeMcpPath + "`"") -ForegroundColor Yellow
    return
  }

  try {
    $listed = & claude mcp list 2>&1
    if ($LASTEXITCODE -eq 0 -and ($listed -match '(?m)^\s*bridge\b')) {
      Write-Verbose "bridge MCP already registered"
      return
    }
  } catch {
    Write-Host "[bclaude] could not query 'claude mcp list': $_" -ForegroundColor Yellow
  }

  Write-Host "[bclaude] registering bridge-MCP with claude (user scope)..." -ForegroundColor Cyan
  & claude mcp add bridge --scope user -- $NodePath $BridgeMcpPath
  if ($LASTEXITCODE -ne 0) {
    Write-Host "[bclaude] WARNING: 'claude mcp add' returned $LASTEXITCODE." -ForegroundColor Yellow
  } else {
    Write-Host "[bclaude] bridge-MCP registered." -ForegroundColor Green
  }
}

function Get-DefaultMasterPrompt {
  $promptFile = Join-Path $ScriptDir 'master-prompt.md'
  if (Test-Path $promptFile) { return Get-Content -Raw -LiteralPath $promptFile }
  return "Du bist der Master-Claude mit Zugriff auf den bridge-MCP. Ruf zuerst bridge_list auf."
}

# Build the claude command. Prefers a directly-spawnable Windows artifact in
# this order: claude.exe → claude.cmd → npx fallback.
#
# Why not Get-Command? On Windows it returns claude.ps1 first (PowerShell
# preference), but node-pty / ConPTY's CreateProcess cannot spawn .ps1 files —
# they need a powershell wrapper. .cmd is the canonical npm-shim entrypoint
# and works directly with ConPTY (verified in Tag-0 spike).
function Get-ClaudeInvocation {
  # Walk PATH for claude.exe / claude.cmd explicitly.
  $exts = @('.exe', '.cmd', '.bat')
  $pathDirs = ($env:Path -split ';') | Where-Object { $_ -ne '' }
  foreach ($d in $pathDirs) {
    foreach ($e in $exts) {
      $candidate = Join-Path $d ("claude" + $e)
      if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        return @{ Cmd = $candidate; PrefixArgs = @() }
      }
    }
  }
  # Fallback to npx (also a .cmd shim under npm).
  $npx = $null
  foreach ($d in $pathDirs) {
    foreach ($e in @('.cmd', '.exe')) {
      $candidate = Join-Path $d ("npx" + $e)
      if (Test-Path -LiteralPath $candidate -PathType Leaf) { $npx = $candidate; break }
    }
    if ($npx) { break }
  }
  if (-not $npx) {
    throw "Neither 'claude' (.exe/.cmd) nor 'npx' found in PATH. Install Claude Code or Node.js."
  }
  return @{ Cmd = $npx; PrefixArgs = @('--yes', '@anthropic-ai/claude-code') }
}

# =============================================================================
# Main
# =============================================================================
$bridge = Resolve-BridgePaths
Write-Verbose ("bridge-clis layout: " + $bridge.Mode + " (" + $bridge.Root + ")")

# -----------------------------------------------------------------------------
# Watch mode — live dashboard of all sessions (separate from Master/Worker).
# -----------------------------------------------------------------------------
if ($opts.Watch) {
  $watchScript = Join-Path $ScriptDir 'bclaude-watch.ps1'
  if (-not (Test-Path $watchScript)) {
    Write-Host "[bclaude] bclaude-watch.ps1 missing next to launcher" -ForegroundColor Red
    exit 2
  }
  & $watchScript @($opts.PassThrough)
  exit $LASTEXITCODE
}

# -----------------------------------------------------------------------------
# Master mode
# -----------------------------------------------------------------------------
if ($opts.Master) {
  Ensure-BridgeMcpRegistered -BridgeMcpPath $bridge.BridgeMcp -NodePath $bridge.Node

  if ($opts.RegisterOnly) {
    Write-Host "[bclaude] register-only complete; not launching claude." -ForegroundColor Green
    exit 0
  }

  # Phase E: OSC window title so master is identifiable in taskbar.
  try { [Console]::Write("`e]0;[bclaude master]`a") } catch { }

  $claude = Get-ClaudeInvocation
  $claudeArgs = @($claude.PrefixArgs) + @('--dangerously-skip-permissions')

  $initPrompt = $null
  if ($opts.Prompt) { $initPrompt = $opts.Prompt }
  elseif (-not $opts.NoPrompt) { $initPrompt = Get-DefaultMasterPrompt }

  if ($initPrompt) { $claudeArgs += @($initPrompt) }
  if ($opts.PassThrough -and $opts.PassThrough.Count -gt 0) { $claudeArgs += $opts.PassThrough }

  Write-Verbose ("exec: " + $claude.Cmd + " " + ($claudeArgs -join ' '))
  & $claude.Cmd @claudeArgs
  exit $LASTEXITCODE
}

# -----------------------------------------------------------------------------
# Worker mode (default)
# -----------------------------------------------------------------------------
function Sanitize-Label {
  param([string] $raw)
  if (-not $raw) { return 'session' }
  # Replace any char outside the allowed audit-safe set with a hyphen.
  # Allowed: A-Z a-z 0-9 . _ -  (matches LABEL_PATTERN in shared/constants.ts)
  $clean = $raw -replace '[^A-Za-z0-9._-]', '-'
  # Collapse runs of hyphens that the replacement just introduced.
  $clean = $clean -replace '-+', '-'
  # Trim leading/trailing separator chars so the label looks clean.
  $clean = $clean.Trim('-', '.', '_')
  if ($clean.Length -gt 64) { $clean = $clean.Substring(0, 64) }
  if (-not $clean) { return 'session' }
  return $clean
}

$rawLabel = if ($opts.Label) { $opts.Label } else { Split-Path -Leaf (Get-Location).Path }
$workerLabel = Sanitize-Label $rawLabel

if ($workerLabel -ne $rawLabel) {
  Write-Host "[bclaude] label '$rawLabel' sanitized to '$workerLabel' (pass --label explicitly to override)" -ForegroundColor DarkGray
}

# Defensive: the daemon also validates against LABEL_PATTERN. If the
# sanitizer produced something the daemon would reject (should never happen),
# bail clearly here rather than later in handshake.
if ($workerLabel -notmatch '^[A-Za-z0-9._-]{1,64}$') {
  Write-Host "[bclaude] internal: sanitized label '$workerLabel' still invalid. Use --label <name>." -ForegroundColor Red
  exit 2
}

$claude = Get-ClaudeInvocation
$cbArgs = @($bridge.Cb, '--label', $workerLabel, $claude.Cmd) + $claude.PrefixArgs + @('--dangerously-skip-permissions')
if ($opts.PassThrough -and $opts.PassThrough.Count -gt 0) { $cbArgs += $opts.PassThrough }

Write-Verbose ("exec: " + $bridge.Node + " " + ($cbArgs -join ' '))
& $bridge.Node @cbArgs
exit $LASTEXITCODE
