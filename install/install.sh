#!/usr/bin/env bash
#
# Builds the WireRoute helper from source and registers it with Chrome.
# Downloads Go by itself if the Mac doesn't have it.
# No admin rights needed: everything goes in your user folders.
#
#   ./install/install.sh            build + install
#   ./install/install.sh --remove   uninstall the helper

set -euo pipefail

HOST_NAME="com.wireroute.host"
EXTENSION_ID="kbmajebcnniiphhhhhgafeipmpibcnjc"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$HOME/Library/Application Support/WireRoute"
BIN="$APP_DIR/wireroute-host"
BASE="$HOME/Library/Application Support"
GO_CACHE="$HOME/Library/Caches/WireRoute"
BROWSERS=(
  "Google/Chrome"
  "Google/Chrome Beta"
  "Google/Chrome Dev"
  "Google/Chrome Canary"
  "Chromium"
  "BraveSoftware/Brave-Browser"
)

if [[ "${1:-}" == "--remove" ]]; then
  for b in "${BROWSERS[@]}"; do rm -f "$BASE/$b/NativeMessagingHosts/$HOST_NAME.json"; done
  rm -f "$BIN"
  rm -rf "$GO_CACHE"
  echo "Helper removed. (Your extension settings are untouched.)"
  exit 0
fi

# Go builds the helper. Use the Mac's own Go when it's new enough; otherwise
# download the official one into WireRoute's cache folder (no Homebrew, no
# admin rights) and use that.
NEED_GO=$(awk '$1 == "go" { print $2; exit }' "$ROOT/host/go.mod")

go_new_enough() {  # $1 = path to a go binary
  local have
  have=$("$1" env GOVERSION 2>/dev/null) || return 1
  awk -v a="${have#go}" -v b="$NEED_GO" 'BEGIN {
    split(a, x, "."); split(b, y, ".")
    exit !(x[1] + 0 > y[1] + 0 || (x[1] + 0 == y[1] + 0 && x[2] + 0 >= y[2] + 0))
  }'
}

fetch_go() {
  local arch ver file
  case "$(uname -m)" in
    arm64) arch=arm64 ;;
    x86_64) arch=amd64 ;;
    *) echo "Unsupported Mac chip: $(uname -m)" >&2; exit 1 ;;
  esac
  ver=$(curl -fsSL "https://go.dev/VERSION?m=text" | head -n 1)
  file="$ver.darwin-$arch.tar.gz"
  echo "Downloading Go $ver to build the helper (one time, about 70 MB)..."
  mkdir -p "$GO_CACHE"
  curl -fL --progress-bar -o "$GO_CACHE/$file" "https://dl.google.com/go/$file"
  if ! echo "$(curl -fsSL "https://dl.google.com/go/$file.sha256")  $GO_CACHE/$file" | shasum -a 256 -c - >/dev/null; then
    rm -f "$GO_CACHE/$file"
    echo "The Go download was damaged. Run this again." >&2
    exit 1
  fi
  rm -rf "$GO_CACHE/go"
  tar -xzf "$GO_CACHE/$file" -C "$GO_CACHE"
  rm -f "$GO_CACHE/$file"
}

if command -v go >/dev/null && go_new_enough go; then
  GO=go
else
  GO="$GO_CACHE/go/bin/go"
  go_new_enough "$GO" || fetch_go
  # Keep everything this Go downloads in the cache folder too, not in ~/go.
  export GOTOOLCHAIN=local GOPATH="$GO_CACHE/gopath" GOCACHE="$GO_CACHE/build" GOFLAGS=-modcacherw
fi

echo "Building the helper..."
mkdir -p "$APP_DIR"
chmod 700 "$APP_DIR"
(cd "$ROOT/host" && "$GO" build -trimpath -ldflags="-s -w" -o "$BIN.new" .)
mv -f "$BIN.new" "$BIN"

MANIFEST=$(cat <<EOF
{
  "name": "$HOST_NAME",
  "description": "WireRoute helper: per-site WireGuard tunnels",
  "path": "$BIN",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
EOF
)

registered=0
for b in "${BROWSERS[@]}"; do
  if [[ -d "$BASE/$b" ]]; then
    mkdir -p "$BASE/$b/NativeMessagingHosts"
    printf '%s\n' "$MANIFEST" > "$BASE/$b/NativeMessagingHosts/$HOST_NAME.json"
    echo "Registered with $b"
    registered=1
  fi
done
if [[ $registered -eq 0 ]]; then
  echo "No Chrome profile folder found. Open Chrome once, then run this again." >&2
  exit 1
fi

echo "Done. Helper: $BIN"
echo "If the extension is already loaded, click 'Try again' in its popup."
