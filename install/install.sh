#!/usr/bin/env bash
#
# Builds the WireRoute helper from source and registers it with Chrome.
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
  echo "Helper removed. (Your extension settings are untouched.)"
  exit 0
fi

command -v go >/dev/null || { echo "Go is needed to build the helper: brew install go" >&2; exit 1; }

echo "Building the helper..."
mkdir -p "$APP_DIR"
chmod 700 "$APP_DIR"
(cd "$ROOT/host" && go build -trimpath -ldflags="-s -w" -o "$BIN.new" .)
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
