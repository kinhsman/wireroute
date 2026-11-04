#!/bin/sh
# Copies the relay into the custom wg-easy image's source (kinhsman/wg-easy,
# branch 15.5.0-copy), where the image build compiles it.
#
#   tools/sync-relay.sh [path to the wg-easy checkout]   (default ../wg-easy)
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
dest=${1:-$here/../wg-easy}/wireroute-relay
mkdir -p "$dest/relay"
cp "$here/host/relay/relay.go" "$dest/relay/relay.go"
sed 's#"github.com/sanglam/wireroute/host/relay"#"wireroute-relay/relay"#' \
  "$here/host/cmd/relay/main.go" > "$dest/main.go"
yamux=$(cd "$here/host" && go list -m -f '{{.Version}}' github.com/hashicorp/yamux)
cat > "$dest/go.mod" <<MOD
module wireroute-relay

go 1.22

require github.com/hashicorp/yamux $yamux
MOD
(cd "$dest" && go mod tidy && gofmt -l . && go vet ./... && CGO_ENABLED=0 go build -o /dev/null .)
echo "relay copied to $dest"

# SangTV's TV-machine add-on uses the same relay (client side).
sltv=$here/../livestream/helper/relay
if [ -d "$sltv" ]; then
  mkdir -p "$sltv/relay"
  cp "$here/host/relay/relay.go" "$sltv/relay/relay.go"
  cat > "$sltv/go.mod" <<MOD
module sangtv-relay

go 1.22

require github.com/hashicorp/yamux $yamux
MOD
  (cd "$sltv" && go mod tidy && gofmt -w . && GOOS=linux go vet ./... && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o /dev/null .)
  echo "relay copied to $sltv"
fi
