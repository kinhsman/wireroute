# Installs the WireRoute helper on Windows and registers it with Chrome,
# Edge and Brave. No admin rights needed: everything goes in your user
# folder and your user part of the registry.
#
#   Double-click "Install WireRoute.cmd" (it runs this script), or:
#   powershell -ExecutionPolicy Bypass -File install.ps1 [-Remove]

param([switch]$Remove)

$ErrorActionPreference = "Stop"
$HostName = "com.wireroute.host"
$ExtensionId = "kbmajebcnniiphhhhhgafeipmpibcnjc"
$AppDir = Join-Path $env:LOCALAPPDATA "WireRoute"
$Exe = Join-Path $AppDir "wireroute-host.exe"
$Manifest = Join-Path $AppDir "$HostName.json"
$Browsers = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts",
  "HKCU:\Software\Chromium\NativeMessagingHosts",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts",
  "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts"
)

if ($Remove) {
  foreach ($b in $Browsers) { Remove-Item -Path (Join-Path $b $HostName) -ErrorAction SilentlyContinue }
  Remove-Item -Path $Exe, $Manifest -ErrorAction SilentlyContinue
  Write-Host "WireRoute helper removed. (Your extension settings are untouched.)"
  exit 0
}

# Pick the helper built for this PC's chip.
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "amd64" }
$source = Join-Path $PSScriptRoot "wireroute-host-$arch.exe"
if (-not (Test-Path $source)) { throw "Can't find $source next to this script." }

New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
# Stop a running copy first so the file can be replaced (Chrome restarts it).
Get-Process -Name "wireroute-host" -ErrorAction SilentlyContinue | Stop-Process -Force
Copy-Item -Force $source $Exe
# Downloaded files carry a "came from the internet" mark that can block them.
Unblock-File -Path $Exe -ErrorAction SilentlyContinue

$json = [ordered]@{
  name            = $HostName
  description     = "WireRoute helper: per-site WireGuard tunnels"
  path            = $Exe
  type            = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json
[System.IO.File]::WriteAllText($Manifest, $json, (New-Object System.Text.UTF8Encoding $false))

foreach ($b in $Browsers) {
  # The key's default value points the browser at the manifest.
  New-Item -Path (Join-Path $b $HostName) -Value $Manifest -Force | Out-Null
}

Write-Host ""
Write-Host "Done. Helper installed in $AppDir"
# Only the zip has the extension next to this script (not the one-line install).
if (Test-Path (Join-Path $PSScriptRoot "extension")) {
  Write-Host "Next: in Chrome open chrome://extensions, turn on Developer mode,"
  Write-Host "click 'Load unpacked' and pick the 'extension' folder from this zip."
}
