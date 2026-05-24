# installer/uninstall.ps1
#
# Inverse of install.ps1:
#   - Removes $env:LOCALAPPDATA\bridge-clis\ (the install dir)
#   - Strips install dir from USER PATH (exact-match only)
#   - Removes `bridge` entry from Claude Code MCP config (preserves others)
#     Backup before write.
#
# DOES NOT TOUCH:
#   - $HOME\.bridge-clis\  (user data: logs, audit.log, redact.json)
#     A warning is printed at the end with the path. Delete manually if desired.
#
# Usage:
#   .\uninstall.ps1               # interactive on conflicts
#   .\uninstall.ps1 -Force        # skip prompts, proceed anyway
#   .\uninstall.ps1 -NoMcpPatch   # don't touch MCP config

[CmdletBinding()]
param(
  [switch]$Force,
  [switch]$NoMcpPatch,
  [switch]$Quiet
)

$ErrorActionPreference = 'Continue'  # best-effort; we want partial success to be visible

function Write-Info($msg)  { if (-not $Quiet) { Write-Host "[uninstall] $msg" } }
function Write-Warn2($msg) { Write-Warning "[uninstall] $msg" }
function Write-Err($msg)   { Write-Host "[uninstall] ERROR: $msg" -ForegroundColor Red }

function Unpatch-McpConfig {
  param([string]$ConfigPath)

  if (-not (Test-Path $ConfigPath)) {
    Write-Info "No MCP config at $ConfigPath — nothing to unpatch."
    return
  }

  $config = $null
  try {
    $raw = Get-Content $ConfigPath -Raw -ErrorAction Stop
    if ([string]::IsNullOrWhiteSpace($raw)) {
      Write-Info "$ConfigPath is empty — nothing to unpatch."
      return
    }
    $config = $raw | ConvertFrom-Json -ErrorAction Stop
  } catch {
    Write-Err "Failed to parse $ConfigPath : $($_.Exception.Message)"
    Write-Err "Skipping MCP unpatch. Edit the file manually to remove the 'bridge' entry."
    return
  }

  if (-not ($config.PSObject.Properties.Name -contains 'mcpServers')) {
    Write-Info "$ConfigPath has no mcpServers — nothing to unpatch."
    return
  }
  if (-not ($config.mcpServers.PSObject.Properties.Name -contains 'bridge')) {
    Write-Info "$ConfigPath has no 'bridge' MCP entry — nothing to unpatch."
    return
  }

  # Backup
  $ts = (Get-Date).ToString('yyyyMMdd-HHmmss')
  $backup = "$ConfigPath.bak.$ts"
  Copy-Item -LiteralPath $ConfigPath -Destination $backup -Force
  Write-Info "Backup written: $backup"

  # Remove bridge
  $config.mcpServers.PSObject.Properties.Remove('bridge')

  # If mcpServers is now empty, remove it entirely (clean config).
  $remainingServers = @($config.mcpServers.PSObject.Properties)
  if ($remainingServers.Count -eq 0) {
    $config.PSObject.Properties.Remove('mcpServers')
  }

  $json = $config | ConvertTo-Json -Depth 32
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($ConfigPath, $json, $utf8NoBom)
  Write-Info "Removed 'bridge' entry from $ConfigPath"
}

# -------- resolve paths --------

$installDir = Join-Path $env:LOCALAPPDATA 'bridge-clis'
$markerPath = Join-Path $installDir 'install-marker.json'
$userDataDir = Join-Path $env:USERPROFILE '.bridge-clis'

$hadAnything = $false

# -------- stop running daemon (best effort) --------

# The daemon is a `node.exe` process whose argv points into the install dir.
# Stopping it cleanly prevents file-in-use errors during the rmdir below.
try {
  $procs = Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
    $_.CommandLine -and $_.CommandLine -like "*$installDir*bridged*"
  }
  foreach ($p in $procs) {
    Write-Info "Stopping bridged daemon process (PID $($p.ProcessId))"
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  }
} catch {
  Write-Warn2 "Could not enumerate processes to stop daemon: $($_.Exception.Message)"
}

# Brief pause so the OS releases file handles
Start-Sleep -Milliseconds 500

# -------- remove install dir --------

if (Test-Path $installDir) {
  $hadAnything = $true
  Write-Info "Removing install dir: $installDir"
  try {
    Remove-Item -LiteralPath $installDir -Recurse -Force -ErrorAction Stop
  } catch {
    Write-Err "Failed to remove $installDir : $($_.Exception.Message)"
    Write-Err "Some files may be locked. Close any open terminals and retry."
    if (-not $Force) { exit 1 }
  }
} else {
  Write-Info "Install dir not found ($installDir) — nothing to remove."
}

# -------- strip from USER PATH --------

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($null -ne $userPath -and $userPath.Length -gt 0) {
  $normalizedTarget = $installDir.TrimEnd('\')
  $segments = $userPath -split ';'
  $kept = @()
  $removed = $false
  foreach ($seg in $segments) {
    if ($seg.Trim() -eq '') { continue }
    if ($seg.TrimEnd('\') -ieq $normalizedTarget) {
      $removed = $true
      continue
    }
    $kept += $seg
  }
  if ($removed) {
    $hadAnything = $true
    $newPath = ($kept -join ';')
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    Write-Info "Removed install dir from USER PATH."
  } else {
    Write-Info "USER PATH did not contain install dir — nothing to strip."
  }
}

# -------- MCP config unpatch --------

if ($NoMcpPatch) {
  Write-Info "MCP config unpatch skipped (-NoMcpPatch)."
} else {
  $claudeJson    = Join-Path $env:USERPROFILE '.claude.json'
  $claudeMcpJson = Join-Path $env:USERPROFILE '.claude\mcp.json'

  # Unpatch BOTH if present (install may have only touched one, but be thorough).
  if (Test-Path $claudeJson)    { Unpatch-McpConfig -ConfigPath $claudeJson;    $hadAnything = $true }
  if (Test-Path $claudeMcpJson) { Unpatch-McpConfig -ConfigPath $claudeMcpJson; $hadAnything = $true }
}

# -------- user data warning --------

Write-Host ""
Write-Host "================================================================" -ForegroundColor Yellow
if ($hadAnything) {
  Write-Host " bridge-clis uninstalled." -ForegroundColor Green
} else {
  Write-Host " Nothing to uninstall (no traces found)." -ForegroundColor Yellow
}
Write-Host "================================================================" -ForegroundColor Yellow
Write-Host ""

if (Test-Path $userDataDir) {
  Write-Host "USER DATA WAS NOT REMOVED:" -ForegroundColor Yellow
  Write-Host "  $userDataDir"
  Write-Host "  Contains: audit.log, cb.log, redact.json (if configured)"
  Write-Host "  Delete manually if no longer needed:"
  Write-Host "      Remove-Item '$userDataDir' -Recurse -Force"
  Write-Host ""
}

Write-Host "Note: PATH change takes effect in NEW terminals only."
Write-Host ""

exit 0
