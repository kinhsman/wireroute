#!/usr/bin/env bash
# Builds dist/WireRoute-windows-<version>.zip: the extension, the helper for
# both Windows chip types, and a double-click installer.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION=$(python3 -c "import json;print(json.load(open('$ROOT/extension/manifest.json'))['version'])")
OUT="$ROOT/dist/WireRoute-windows-$VERSION"
rm -rf "$OUT" "$OUT.zip"
mkdir -p "$OUT"
for arch in amd64 arm64; do
  (cd "$ROOT/host" && GOOS=windows GOARCH=$arch go build -trimpath -ldflags="-s -w" -o "$OUT/wireroute-host-$arch.exe" .)
done
cp -R "$ROOT/extension" "$OUT/extension"
cp "$ROOT/install/install.ps1" "$ROOT/install/Install WireRoute.cmd" "$ROOT/install/Uninstall WireRoute.cmd" "$OUT/"
cat > "$OUT/READ ME FIRST.txt" <<TXT
WireRoute $VERSION for Windows

1. Double-click "Install WireRoute.cmd". No admin rights needed.
   If Windows says it protected your PC, click "More info", then "Run anyway".
2. In Chrome, open chrome://extensions, turn on Developer mode (top right),
   click "Load unpacked" and pick the "extension" folder in here.
   Keep this folder: Chrome loads the extension from it.
3. Drop your WireGuard .conf files on the Servers page that opens.
4. On any site, click the WireRoute icon and pick a server or group.

To remove the helper: double-click "Uninstall WireRoute.cmd".
Helper log: %LOCALAPPDATA%\WireRoute\Logs\helper.log
TXT
(cd "$ROOT/dist" && COPYFILE_DISABLE=1 zip -qr "WireRoute-windows-$VERSION.zip" "WireRoute-windows-$VERSION")
echo "$OUT.zip"
