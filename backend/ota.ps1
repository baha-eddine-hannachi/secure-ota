# LEGACY: ota.ps1 signs, registers and triggers one OTA test version; prefer npm run release.
# Put it in C:\Users\Dell\Documents\iot\backend and run it from that folder.
# Usage:
#   .\ota.ps1 -Version 1.1.0 -KeyFile "$env:USERPROFILE\.iot-keys\signing-private.pem"
#   .\ota.ps1 -Version 1.1.0 -KeyFile ... -NoTrigger      (sign + register only)
#   .\ota.ps1 -Version 1.1.0 -TriggerOnly                 (trigger an already registered version)
# OTA_ADMIN_TOKEN may override the .env token for an isolated test backend; the token is never printed.
param(
  [Parameter(Mandatory=$true)][string]$Version,
  [string]$KeyFile = "$env:USERPROFILE\.iot-keys\signing-private.pem",
  [string]$Bin = "..\wifi_base\build\wifi_base.bin",
  [string]$Ca = "C:\Users\Dell\Documents\iot\mosq\ca.crt",
  [string]$Base,
  [string]$ReleaseDir = "..\release",
  [string]$DeviceId = "esp32-001",
  [switch]$NoTrigger,
  [switch]$TriggerOnly
)
$ErrorActionPreference = "Stop"

$token = $env:OTA_ADMIN_TOKEN
if (-not $token) {
  $envLine = Select-String -Path ".\.env" -Pattern '^\s*ADMIN_API_TOKEN\s*=\s*(.+)$' | Select-Object -First 1
  if (-not $envLine) { throw "ADMIN_API_TOKEN not found in .env" }
  $token = $envLine.Matches[0].Groups[1].Value.Trim().Trim('"').Trim("'")
}
$auth  = "Authorization: Bearer $token"
if (-not $Base) {
  $baseLine = Select-String -Path ".\.env" -Pattern '^\s*FIRMWARE_BASE_URL\s*=\s*(.+)$' | Select-Object -First 1
  if (-not $baseLine) { throw "FIRMWARE_BASE_URL not found in .env" }
  $Base = $baseLine.Matches[0].Groups[1].Value.Trim().Trim('"').Trim("'").TrimEnd('/')
}

function Call-Api([string]$Method, [string]$Path, [string]$BodyFile) {
  $args = @("--silent","--show-error","--ssl-no-revoke","--cacert",$Ca,"-X",$Method,"-H",$auth,"-H","Content-Type: application/json")
  if ($BodyFile) { $args += @("--data-binary","@$BodyFile") }
  $args += "$Base$Path"
  & curl.exe @args
}
function Write-Utf8([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding $false))
}

$releaseRoot = [System.IO.Path]::GetFullPath($ReleaseDir)
New-Item -ItemType Directory -Force -Path $releaseRoot | Out-Null
$rel = Join-Path $releaseRoot $Version
New-Item -ItemType Directory -Force -Path $rel | Out-Null

if (-not $TriggerOnly) {
  if (-not (Test-Path $Bin)) { throw "Firmware not found: $Bin (build it first)" }
  $binPath = (Resolve-Path -LiteralPath $Bin).Path
  $projectInfoPath = Join-Path $PSScriptRoot "..\wifi_base\build\project_description.json"
  if (-not (Test-Path -LiteralPath $projectInfoPath)) { throw "Build metadata not found: $projectInfoPath (run idf.py build first)" }
  $projectInfo = Get-Content -LiteralPath $projectInfoPath -Raw | ConvertFrom-Json
  if ($projectInfo.project_version -ne $Version) { throw "Built project version $($projectInfo.project_version) does not match requested $Version; rebuild the intended version first" }
  $buildInputs = @(
    (Get-Item (Join-Path $PSScriptRoot "..\wifi_base\CMakeLists.txt")),
    (Get-Item (Join-Path $PSScriptRoot "..\wifi_base\main\wifi_base.c")),
    (Get-Item (Join-Path $PSScriptRoot "..\wifi_base\main\secrets.h")),
    (Get-Item (Join-Path $PSScriptRoot "..\wifi_base\sdkconfig")),
    (Get-Item $projectInfoPath)
  )
  $latestInput = ($buildInputs | Measure-Object -Property LastWriteTimeUtc -Maximum).Maximum
  if ((Get-Item -LiteralPath $binPath).LastWriteTimeUtc -lt $latestInput) { throw "Firmware binary predates a build input; run idf.py build before registering $Version" }
  $python = if ($env:IDF_PYTHON_ENV_PATH) { Join-Path $env:IDF_PYTHON_ENV_PATH "Scripts\python.exe" } else { (Get-Command python.exe -ErrorAction Stop).Source }
  if (-not (Test-Path -LiteralPath $python)) { throw "ESP-IDF Python environment not found; activate ESP-IDF before running this script" }
  $imageInfo = & $python -m esptool image-info $binPath 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Could not inspect the firmware image; rebuild it with the active ESP-IDF environment" }
  $versionLine = $imageInfo | Select-String '^App version:\s*(.+)$' | Select-Object -First 1
  if (-not $versionLine -or $versionLine.Matches[0].Groups[1].Value.Trim() -ne $Version) { throw "Firmware image version does not match requested $Version; refusing registration" }
  $fw = Join-Path $rel "firmware.bin"
  Copy-Item $binPath $fw -Force
  $out = Join-Path $rel "manifest.json"
  Write-Host "== Signing $Version"
  node scripts/sign_firmware.js --firmware=$fw --version=$Version --device-type=esp32 --key=$KeyFile --base-url=$Base --out=$out
  if ($LASTEXITCODE -ne 0) { throw "sign_firmware.js failed" }

  $mf = Get-Item $out
  if ($mf.PSIsContainer) { $mf = Get-Item (Join-Path $mf.FullName "manifest.json") }
  $raw  = (Get-Content $mf.FullName -Raw).Trim()
  $fwJs = $fw -replace '\\','\\'
  $body = '{"manifest":' + $raw + ',"firmware_path":"' + $fwJs + '"}'
  $reg  = Join-Path $rel "register.json"
  Write-Utf8 $reg $body

  Write-Host "== Registering $Version"
  Call-Api "POST" "/api/firmwares" $reg
  Write-Host ""
}

if (-not $NoTrigger) {
  $upd = Join-Path $rel "update.json"
  Write-Utf8 $upd ('{"device_id":"' + $DeviceId + '","version":"' + $Version + '"}')
  Write-Host "== Triggering update $Version for $DeviceId (monitor must be open)"
  Call-Api "POST" "/api/updates" $upd
  Write-Host ""
}
