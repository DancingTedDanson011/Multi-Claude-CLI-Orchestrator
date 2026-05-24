<#
.SYNOPSIS
  bridge-clis one-click setup — installs deps, builds packages, registers
  the launcher in user PATH, and registers the bridge MCP server with Claude.

.DESCRIPTION
  Run this once after cloning / unpacking the repo. Idempotent: safe to re-run.

  Steps:
    1. Verify Node 20+ (errors out if missing)
    2. Ensure pnpm is available (auto-installs via corepack if Node has it)
    3. pnpm install
    4. pnpm -r build
    5. Add <repo>\launcher to user PATH (idempotent)
    6. Register bridge MCP with claude (idempotent)
    7. Optional smoke test (--no-test to skip)

.PARAMETER NoTest
  Skip the smoke test at the end (faster, less validation).

.PARAMETER Quiet
  Suppress non-essential output.

.EXAMPLE
  .\setup.ps1
  # → full setup with smoke test

.EXAMPLE
  .\setup.ps1 -NoTest
  # → setup without smoke test (~2min faster)
#>

[CmdletBinding()]
param(
  [switch] $NoTest,
  [switch] $Quiet
)

$ErrorActionPreference = 'Stop'
$RepoRoot = $PSScriptRoot
$LauncherDir = Join-Path $RepoRoot 'launcher'

function Step($msg) {
  if ($Quiet) { return }
  Write-Host ""
  Write-Host "==> $msg" -ForegroundColor Cyan
}

function Info($msg)  { if (-not $Quiet) { Write-Host "    $msg" -ForegroundColor Gray } }
function Ok($msg)    { if (-not $Quiet) { Write-Host "    [ok] $msg" -ForegroundColor Green } }
function Warn($msg)  { Write-Host "    [warn] $msg" -ForegroundColor Yellow }
function Fail($msg)  { Write-Host "[ERROR] $msg" -ForegroundColor Red; exit 1 }

# ---------- Step 1: Node ----------
Step "Checking Node.js"
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { Fail "Node.js not found in PATH. Install Node 20+ from https://nodejs.org and rerun." }
$nodeVer = (& node --version).TrimStart('v')
$nodeMajor = [int]($nodeVer.Split('.')[0])
if ($nodeMajor -lt 20) {
  Fail "Node $nodeVer is too old. Need 20+ (recommended: 20.10 LTS or newer)."
}
Ok "Node $nodeVer at $($nodeCmd.Source)"

# ---------- Step 2: pnpm ----------
Step "Checking pnpm"
$pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpmCmd) {
  Info "pnpm not found — trying to enable via corepack..."
  $corepack = Get-Command corepack -ErrorAction SilentlyContinue
  if ($corepack) {
    & corepack enable | Out-Null
    & corepack prepare 'pnpm@9.0.0' --activate | Out-Null
    $pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
  }
  if (-not $pnpmCmd) {
    Info "Falling back to: npm install -g pnpm"
    & npm install -g pnpm | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "Could not install pnpm. Try manually: npm install -g pnpm" }
    $pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
  }
  if (-not $pnpmCmd) { Fail "pnpm still not on PATH after install attempt." }
}
Ok "pnpm at $($pnpmCmd.Source)"

# ---------- Step 3: pnpm install ----------
Step "Installing dependencies (pnpm install)"
Push-Location $RepoRoot
try {
  & pnpm install
  if ($LASTEXITCODE -ne 0) { Fail "pnpm install failed (exit $LASTEXITCODE)" }
  Ok "dependencies installed"
} finally { Pop-Location }

# ---------- Step 4: build ----------
Step "Building TypeScript packages (pnpm -r build)"
Push-Location $RepoRoot
try {
  & pnpm -r build
  if ($LASTEXITCODE -ne 0) { Fail "Build failed (exit $LASTEXITCODE)" }
  Ok "all 4 packages built"
} finally { Pop-Location }

# ---------- Step 5: PATH ----------
Step "Registering launcher in user PATH"
if (-not (Test-Path (Join-Path $LauncherDir 'bclaude.cmd'))) {
  Fail "launcher not found at $LauncherDir — repo may be incomplete"
}
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($null -eq $userPath) { $userPath = '' }
$parts = @($userPath -split ';' | Where-Object { $_ -ne '' })
if ($parts -contains $LauncherDir) {
  Ok "launcher already in user PATH"
} else {
  $newPath = if ($userPath -eq '') { $LauncherDir } else { "$userPath;$LauncherDir" }
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  # Also refresh THIS process's PATH so the rest of setup can find bclaude.
  $env:Path = "$env:Path;$LauncherDir"
  Ok "added $LauncherDir to user PATH"
}

# ---------- Step 6: MCP registration ----------
Step "Registering bridge MCP server with Claude Code"
$claudeCmd = $null
foreach ($d in (($env:Path -split ';') | Where-Object { $_ -ne '' })) {
  foreach ($e in @('.exe', '.cmd')) {
    $c = Join-Path $d ("claude" + $e)
    if (Test-Path -LiteralPath $c -PathType Leaf) { $claudeCmd = $c; break }
  }
  if ($claudeCmd) { break }
}
if (-not $claudeCmd) {
  Warn "claude CLI not found in PATH — skipping MCP registration."
  Warn "Install Claude Code (npm install -g @anthropic-ai/claude-code or via Anthropic), then rerun this script (or just run: bclaude --master --register-only)."
} else {
  $bridgeMcpPath = Join-Path $RepoRoot 'packages\bridge-mcp\dist\index.js'
  if (-not (Test-Path $bridgeMcpPath)) { Fail "bridge-mcp dist missing — build step should have produced it" }

  # Check existing registration
  $listed = & $claudeCmd mcp list 2>&1
  $alreadyRegistered = $listed -match '(?m)^\s*bridge\s*:'
  if ($alreadyRegistered) {
    Ok "bridge MCP already registered with claude"
  } else {
    & $claudeCmd mcp add bridge --scope user -- $nodeCmd.Source $bridgeMcpPath | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Warn "claude mcp add returned exit $LASTEXITCODE — you may need to register manually:"
      Warn "  claude mcp add bridge --scope user -- `"$($nodeCmd.Source)`" `"$bridgeMcpPath`""
    } else {
      Ok "bridge MCP registered (user scope)"
    }
  }
}

# ---------- Step 7: smoke test ----------
if ($NoTest) {
  Info "Skipping smoke test (--NoTest)"
} else {
  Step "Running smoke test (this takes ~2 minutes)"
  Push-Location $RepoRoot
  try {
    # Clean any prior daemon state so the smoke starts fresh.
    $bd = Join-Path $env:USERPROFILE '.bridge-clis'
    foreach ($f in @('cb.log', 'bridged.log', 'daemon.secret', 'spawn.lock')) {
      $p = Join-Path $bd $f
      if (Test-Path $p) { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue }
    }
    # Kill any lingering daemons from prior dev runs.
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -like '*bridged*dist*index.js*' } |
      ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch { } }
    Start-Sleep -Seconds 1

    & pnpm test:smoke
    if ($LASTEXITCODE -ne 0) {
      Warn "smoke test failed (exit $LASTEXITCODE) — setup completed but something is off."
      Warn "Check ~/.bridge-clis/bridged.log and cb.log for diagnostics."
    } else {
      Ok "smoke test passed"
    }
  } finally { Pop-Location }
}

# ---------- Final summary ----------
Write-Host ""
Write-Host "==================================================" -ForegroundColor Green
Write-Host "  bridge-clis setup complete" -ForegroundColor Green
Write-Host "==================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Open a NEW terminal (PATH refresh)"
Write-Host "  2. Worker:  cd <project>; bclaude"
Write-Host "  3. Master:  bclaude --master"
Write-Host "  4. Watch:   bclaude --watch"
Write-Host ""
Write-Host "Documentation:"
Write-Host "  - DESIGN.md       — architecture"
Write-Host "  - EXECUTION.md    — implementation plan"
Write-Host "  - AUDIT.md        — security/quality status"
Write-Host "  - launcher\README.md — bclaude usage"
Write-Host ""
