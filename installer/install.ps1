# installer/install.ps1
#
# Installs bridge-clis to $env:LOCALAPPDATA\bridge-clis\
#   - Copies bundle contents (this script's folder) to install dir
#   - Appends install dir to USER PATH (idempotent)
#   - Patches Claude Code MCP config (~/.claude.json or ~/.claude/mcp.json)
#     to register the `bridge` server. Backup before write. Never overwrites
#     an existing `bridge` entry.
#   - Writes install-marker.json with version + timestamp
#
# Usage:
#   .\install.ps1               # interactive
#   .\install.ps1 -Force        # overwrite existing install without prompt
#   .\install.ps1 -NoMcpPatch   # skip MCP config patch entirely
#
# Exit codes: 0 on success, non-zero on failure.

[CmdletBinding()]
param(
  [switch]$Force,
  [switch]$NoMcpPatch,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

function Write-Info($msg)  { if (-not $Quiet) { Write-Host "[install] $msg" } }
function Write-Warn2($msg) { Write-Warning "[install] $msg" }
function Write-Err($msg)   { Write-Host "[install] ERROR: $msg" -ForegroundColor Red }

# ----------------------------------------------------------------------------
# Cross-process install lock (audit M13).
# We hold an exclusive file handle ($global:_BridgeInstallLockStream) for the
# duration of any non-atomic mutation (PATH update, MCP config patch). Other
# concurrent installer runs will block at AcquireInstallLock and either get
# the lock after we release or time out cleanly. This prevents two parallel
# installers from racing the PATH read+write cycle.
# ----------------------------------------------------------------------------

$global:_BridgeInstallLockStream = $null

function Acquire-InstallLock {
  param(
    [string]$LockPath,
    [int]$TimeoutMs = 5000,
    [int]$PollMs = 200
  )
  $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
  $lastErr = $null
  while ((Get-Date) -lt $deadline) {
    try {
      $stream = [System.IO.File]::Open(
        $LockPath,
        [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::None
      )
      $global:_BridgeInstallLockStream = $stream
      return $true
    } catch [System.IO.IOException] {
      $lastErr = $_
      Start-Sleep -Milliseconds $PollMs
    } catch {
      $lastErr = $_
      Start-Sleep -Milliseconds $PollMs
    }
  }
  Write-Err "Could not acquire install lock at $LockPath within ${TimeoutMs}ms. Another installer may be running. Last error: $($lastErr.Exception.Message)"
  return $false
}

function Release-InstallLock {
  param([string]$LockPath)
  if ($null -ne $global:_BridgeInstallLockStream) {
    try { $global:_BridgeInstallLockStream.Dispose() } catch {}
    $global:_BridgeInstallLockStream = $null
  }
  if (Test-Path $LockPath) {
    try { Remove-Item -LiteralPath $LockPath -Force -ErrorAction Stop } catch {
      Write-Warn2 "Could not remove install lock $LockPath : $($_.Exception.Message)"
    }
  }
}

function Patch-McpConfig {
  param([string]$ConfigPath)

  # Ensure parent dir exists
  $parent = Split-Path -Parent $ConfigPath
  if ($parent -and -not (Test-Path $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }

  # Load (or seed) config
  $config = $null
  $exists = Test-Path $ConfigPath
  if ($exists) {
    try {
      $raw = Get-Content $ConfigPath -Raw -ErrorAction Stop
      if ([string]::IsNullOrWhiteSpace($raw)) {
        $config = [PSCustomObject]@{}
      } else {
        $config = $raw | ConvertFrom-Json -ErrorAction Stop
      }
    } catch {
      Write-Err "Failed to parse existing MCP config at $ConfigPath : $($_.Exception.Message)"
      Write-Err "Leaving config untouched. Add the bridge entry manually:"
      Write-Err '  { "mcpServers": { "bridge": { "command": "bridge-mcp" } } }'
      return
    }
  } else {
    $config = [PSCustomObject]@{}
  }

  # Ensure mcpServers property exists as an object
  if (-not ($config.PSObject.Properties.Name -contains 'mcpServers') -or $null -eq $config.mcpServers) {
    Add-Member -InputObject $config -NotePropertyName 'mcpServers' -NotePropertyValue ([PSCustomObject]@{}) -Force
  }

  $existingBridge = $null
  if ($config.mcpServers.PSObject.Properties.Name -contains 'bridge') {
    $existingBridge = $config.mcpServers.bridge
  }

  if ($null -ne $existingBridge) {
    Write-Warn2 "MCP config already has a 'bridge' entry — leaving it unchanged."
    Write-Warn2 "  Config: $ConfigPath"
    Write-Warn2 "  If this is a stale entry, edit the file manually."
    return
  }

  # Backup
  if ($exists) {
    $ts = (Get-Date).ToString('yyyyMMdd-HHmmss')
    $backup = "$ConfigPath.bak.$ts"
    Copy-Item -LiteralPath $ConfigPath -Destination $backup -Force
    Write-Info "Backup written: $backup"
  }

  # Add bridge entry
  Add-Member -InputObject $config.mcpServers -NotePropertyName 'bridge' -NotePropertyValue ([PSCustomObject]@{
    command = 'bridge-mcp'
  }) -Force

  # Write back — UTF8 NO BOM (Claude Code parsers can be picky)
  $json = $config | ConvertTo-Json -Depth 32
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($ConfigPath, $json, $utf8NoBom)
  Write-Info "MCP config patched: $ConfigPath  (added 'bridge' -> command: bridge-mcp)"
}

# -------- resolve paths --------

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$installDir = Join-Path $env:LOCALAPPDATA 'bridge-clis'
$markerPath = Join-Path $installDir 'install-marker.json'

# Sanity: do we look like a bundle? (cb.cmd + node.exe should exist next to us)
$expectedFiles = @('cb.cmd', 'bridged.cmd', 'bridge-mcp.cmd', 'cb.cjs', 'bridged.cjs', 'bridge-mcp.cjs')
$missingFiles = @()
foreach ($f in $expectedFiles) {
  if (-not (Test-Path (Join-Path $scriptDir $f))) { $missingFiles += $f }
}
if ($missingFiles.Count -gt 0) {
  Write-Err ("This script must be run from inside an unpacked bridge-clis bundle. " +
             "Missing: " + ($missingFiles -join ', '))
  exit 2
}
if (-not (Test-Path (Join-Path $scriptDir 'node.exe'))) {
  Write-Err "node.exe missing from bundle. Re-download a complete release zip."
  exit 2
}

# -------- existing install check --------

if (Test-Path $markerPath) {
  try {
    $existing = Get-Content $markerPath -Raw | ConvertFrom-Json
    Write-Info "Existing install detected (version: $($existing.version), installed: $($existing.installedAt))"
  } catch {
    Write-Info "Existing install detected (marker unreadable)."
  }
  if (-not $Force) {
    $resp = Read-Host "Overwrite? [y/N]"
    if ($resp -notmatch '^[yY]') {
      Write-Info "Aborted by user."
      exit 0
    }
  } else {
    Write-Info "Force mode — overwriting without prompt."
  }
}

# -------- copy bundle --------

Write-Info "Installing to: $installDir"
if (Test-Path $installDir) {
  # Clean install dir; user data lives under ~/.bridge-clis/ (not touched).
  Remove-Item -LiteralPath $installDir -Recurse -Force
}
New-Item -ItemType Directory -Path $installDir -Force | Out-Null

# Copy everything from script dir (includes installer scripts themselves —
# we want uninstall.ps1 present in the install dir for later removal).
Copy-Item -Path (Join-Path $scriptDir '*') -Destination $installDir -Recurse -Force

# Write marker
$version = '0.1.0'
try {
  $pkgJsonCandidate = Join-Path $scriptDir 'package.json'
  if (Test-Path $pkgJsonCandidate) {
    $pj = Get-Content $pkgJsonCandidate -Raw | ConvertFrom-Json
    if ($pj.version) { $version = $pj.version }
  }
} catch {}

$marker = @{
  version     = $version
  installedAt = (Get-Date).ToString('o')
  installDir  = $installDir
} | ConvertTo-Json
Set-Content -Path $markerPath -Value $marker -Encoding utf8

Write-Info "Files copied."

# -------- atomic mutation block (PATH + MCP config) --------
# Audit M13: previously the PATH read+write was non-atomic with no lock between
# concurrent installer runs. We now hold an exclusive cross-process file lock
# for the duration of both mutations.

$lockPath = Join-Path $env:LOCALAPPDATA 'bridge-clis-install.lock'
$lockAcquired = $false
try {
  $lockAcquired = Acquire-InstallLock -LockPath $lockPath -TimeoutMs 5000 -PollMs 200
  if (-not $lockAcquired) {
    exit 3
  }

  # -------- PATH patch --------

  # Read user PATH (NOT process PATH — we want persistence)
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($null -eq $userPath) { $userPath = '' }

  $pathSegments = $userPath -split ';' | Where-Object { $_ -ne '' }
  $normalizedInstallDir = $installDir.TrimEnd('\')

  $alreadyInPath = $false
  foreach ($seg in $pathSegments) {
    if ($seg.TrimEnd('\') -ieq $normalizedInstallDir) {
      $alreadyInPath = $true
      break
    }
  }

  if ($alreadyInPath) {
    Write-Info "User PATH already contains install dir — skipping."
  } else {
    $newPath = if ($userPath.Length -eq 0) { $installDir } else { "$userPath;$installDir" }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    Write-Info "Appended $installDir to USER PATH."
  }

  # -------- MCP config patch --------

  if ($NoMcpPatch) {
    Write-Info "MCP config patch skipped (-NoMcpPatch)."
  } else {
    # Claude Code (Windows): the canonical user-level MCP config is typically
    # at $env:USERPROFILE\.claude.json. Older / project setups also use
    # $env:USERPROFILE\.claude\mcp.json.
    # [conf: low — verify which Claude Code release writes which file on Windows.
    #  Strategy: prefer .claude.json if either exists; create .claude.json if neither.]

    $claudeJson    = Join-Path $env:USERPROFILE '.claude.json'
    $claudeMcpJson = Join-Path $env:USERPROFILE '.claude\mcp.json'

    $target = $null
    if (Test-Path $claudeJson)        { $target = $claudeJson }
    elseif (Test-Path $claudeMcpJson) { $target = $claudeMcpJson }
    else {
      $target = $claudeJson
      Write-Info "No existing Claude MCP config found. Will create: $target"
    }

    Patch-McpConfig -ConfigPath $target
  }
} finally {
  if ($lockAcquired) {
    Release-InstallLock -LockPath $lockPath
  }
}

# -------- success message --------

Write-Host ""
Write-Host "================================================================" -ForegroundColor Green
Write-Host " bridge-clis installed." -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. CLOSE this terminal and open a NEW one (PATH update takes effect)."
Write-Host "  2. In any project: run  cb claude  (or  cb pwsh  to test without API)."
Write-Host "  3. In a fresh terminal: run  claude  - type /mcp to see the bridge server."
Write-Host ""
Write-Host "Audit log:  $HOME\.bridge-clis\audit.log  (created on first use)"
Write-Host "Uninstall:  $installDir\uninstall.ps1"
Write-Host ""

exit 0
