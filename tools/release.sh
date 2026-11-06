#!/usr/bin/env bash
# Builds the helper for Windows (x64, ARM) and Mac (Apple chip, Intel) and
# publishes them as GitHub release v<version>. The one-line installers
# (install/get.ps1, install/get.sh) download from the latest release.
#
#   ./tools/release.sh
#
# Needs Go and a signed-in gh. Run it after bumping the version in both
# extension/manifest.json and host/types.go.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

EXT_VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/extension/manifest.json")
HOST_VERSION=$(sed -n 's/^const Version = "\(.*\)"/\1/p' "$ROOT/host/types.go")
if [[ "$EXT_VERSION" != "$HOST_VERSION" ]]; then
  echo "Version mismatch: extension $EXT_VERSION, helper $HOST_VERSION" >&2
  exit 1
fi
VERSION=$EXT_VERSION
if [[ -n "$(git -C "$ROOT" status --porcelain)" ]]; then
  echo "Commit your changes first: the release is tagged on the current commit." >&2
  exit 1
fi

OUT="$ROOT/dist/release-$VERSION"
rm -rf "$OUT"
mkdir -p "$OUT"
for target in windows/amd64 windows/arm64 darwin/arm64 darwin/amd64; do
  os=${target%/*} arch=${target#*/}
  ext=""; [[ $os == windows ]] && ext=".exe"
  echo "Building $os/$arch..."
  (cd "$ROOT/host" && GOOS=$os GOARCH=$arch CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o "$OUT/wireroute-host-$os-$arch$ext" .)
done

git -C "$ROOT" push origin HEAD
gh release create "v$VERSION" "$OUT"/* \
  --repo kinhsman/wireroute \
  --target "$(git -C "$ROOT" rev-parse HEAD)" \
  --title "WireRoute $VERSION" \
  --notes "Helper $VERSION. Install it with one line:

Windows (PowerShell): \`irm https://raw.githubusercontent.com/kinhsman/wireroute/main/install/get.ps1 | iex\`

Mac (Terminal): \`curl -fsSL https://raw.githubusercontent.com/kinhsman/wireroute/main/install/get.sh | bash\`"
echo "Published v$VERSION"
