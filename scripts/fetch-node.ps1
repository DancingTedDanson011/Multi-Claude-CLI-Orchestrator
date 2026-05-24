# scripts/fetch-node.ps1
#
# Downloads the official Node.js LTS Windows-x64 embedded ZIP from nodejs.org
# and extracts node.exe into dist-bundle/bridge-clis/.
#
# Idempotent: if dist-bundle/bridge-clis/node.exe already exists with the
# expected version, this is a no-op.
#
# Why a separate script (not part of build-dist.ts):
#   - CI can cache the ~30MB download independently of code changes.
#   - Build can run offline once node.exe is present.
#   - We avoid mixing network IO into the deterministic JS bundler step.
#
# Why 20.10 specifically: node-pty prebuilds historically lag the latest Node
# release by 1-2 majors. 20.x LTS is the safest "supported and prebuilt" target.
# EXECUTION.md Anhang A pins this.

[CmdletBinding()]
param(
  [string]$NodeVersion = '20.10.0',
  [string]$Arch = 'x64',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir '..')
$outDir = Join-Path $repoRoot 'dist-bundle\bridge-clis'
$nodeExe = Join-Path $outDir 'node.exe'

if (-not (Test-Path $outDir)) {
  New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}

if ((Test-Path $nodeExe) -and -not $Force) {
  Write-Host "[fetch-node] node.exe already present at $nodeExe — skipping (use -Force to redownload)"
  exit 0
}

$fileName = "node-v$NodeVersion-win-$Arch.zip"
$url = "https://nodejs.org/dist/v$NodeVersion/$fileName"
$tmpDir = Join-Path $env:TEMP "bridge-clis-fetch-node-$([System.Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
$zipPath = Join-Path $tmpDir $fileName

try {
  Write-Host "[fetch-node] downloading $url ..."
  # TLS 1.2 required by nodejs.org
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing

  Write-Host "[fetch-node] extracting ..."
  Expand-Archive -LiteralPath $zipPath -DestinationPath $tmpDir -Force

  $extractedNode = Join-Path $tmpDir "node-v$NodeVersion-win-$Arch\node.exe"
  if (-not (Test-Path $extractedNode)) {
    throw "node.exe not found in extracted archive: $extractedNode"
  }

  Copy-Item -LiteralPath $extractedNode -Destination $nodeExe -Force
  $size = (Get-Item $nodeExe).Length
  Write-Host "[fetch-node] OK: $nodeExe ($([math]::Round($size/1MB,1)) MB)"
}
finally {
  if (Test-Path $tmpDir) {
    Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
