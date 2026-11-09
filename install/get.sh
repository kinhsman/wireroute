#!/usr/bin/env bash
#
# One-line install of the WireRoute helper on a Mac. No admin rights needed.
#
#   curl -fsSL https://raw.githubusercontent.com/kinhsman/wireroute/main/install/get.sh | bash
#
# Downloads the latest helper from GitHub Releases and runs install.sh on it.

set -euo pipefail

# Everything is inside main so a half-downloaded script never runs.
main() {
  local repo="kinhsman/wireroute" arch dir
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) arch=arm64 ;;
    Darwin-x86_64) arch=amd64 ;;
    *) echo "This installer is for Macs. On Windows, use the PowerShell line." >&2; exit 1 ;;
  esac
  dir=$(mktemp -d)
  # The folder's name goes into the cleanup now: dir only exists inside main,
  # and the cleanup runs after main has finished.
  trap "rm -rf '$dir'" EXIT
  echo "Downloading the WireRoute helper..."
  curl -fsSL -o "$dir/wireroute-host" "https://github.com/$repo/releases/latest/download/wireroute-host-darwin-$arch"
  curl -fsSL -o "$dir/install.sh" "https://raw.githubusercontent.com/$repo/main/install/install.sh"
  WIREROUTE_BIN="$dir/wireroute-host" bash "$dir/install.sh"
  echo "Back in Chrome, press 'Check again' on the WireRoute page."
}

main "$@"
