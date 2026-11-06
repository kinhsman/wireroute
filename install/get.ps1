# One-line install of the WireRoute helper on Windows. No admin rights needed.
#
#   irm https://raw.githubusercontent.com/kinhsman/wireroute/main/install/get.ps1 | iex
#
# Downloads the latest helper from GitHub Releases and runs install.ps1 on it.

& {
  $ErrorActionPreference = "Stop"
  $ProgressPreference = "SilentlyContinue"  # PowerShell 5 downloads far faster without the progress bar
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $repo = "kinhsman/wireroute"
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "amd64" }
  $dir = Join-Path $env:TEMP ("wireroute-" + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $dir | Out-Null
  try {
    Write-Host "Downloading the WireRoute helper..."
    Invoke-WebRequest -UseBasicParsing "https://github.com/$repo/releases/latest/download/wireroute-host-windows-$arch.exe" -OutFile (Join-Path $dir "wireroute-host-$arch.exe")
    Invoke-WebRequest -UseBasicParsing "https://raw.githubusercontent.com/$repo/main/install/install.ps1" -OutFile (Join-Path $dir "install.ps1")
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dir "install.ps1")
    if ($LASTEXITCODE -ne 0) { throw "The install didn't finish." }
    Write-Host "Back in Chrome, press 'Check again' on the WireRoute page."
  } finally {
    Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
  }
}
