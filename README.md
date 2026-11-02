# WireRoute

Send each website through the WireGuard server you pick, right from Chrome.
cnn.com through your US server, tv360.vn through your Vietnam server, everything
else direct. Hidden addresses a site uses (video servers, logins, players) are
detected and follow it automatically, even on the first visit.

Started as a fork of [WireGuardExt](https://github.com/yoprogramo/wireguardext)
(Apache-2.0). The helper and extension have since been rewritten.

## How it works

```
Chrome tab ──> extension (decides nothing, watches who asks for what)
     │                │ hints: "a tv360.vn tab asked for video.viettel.vn"
     ▼                ▼
local proxy in the helper (127.0.0.1, password protected)
     │  rule? hint? learned? default?
     ├──> WireGuard tunnel to server A
     ├──> WireGuard tunnel to server B
     └──> direct
```

- The helper (`host/`) is a small Go program Chrome starts and stops for you.
  It runs WireGuard in userspace (no admin rights, nothing changes on the Mac's
  network) and holds each brand-new connection for a split second until the
  extension says which site it belongs to.
- The extension (`extension/`) watches every request, sends those hints, points
  Chrome at the helper, blocks WebRTC leaks and shows a "VPN down" page when a
  site's server is unreachable (kill switch).

## Install

1. Build and register the helper (needs Go: `brew install go`):

   ```bash
   ./install/install.sh
   ```

2. In Chrome open `chrome://extensions`, switch on Developer mode (top right),
   click Load unpacked and pick the `extension` folder.
3. Drop your WireGuard `.conf` files on the Servers page that opens.
4. On any site, click the WireRoute icon and pick a server.

Uninstall the helper with `./install/install.sh --remove`.

## Tests

```bash
npm test                          # rules, PAC and config parsing
(cd host && go test -race ./...)  # helper, with fake WireGuard servers
npm run e2e                       # real Chrome + helper + 2 fake servers
```

The end-to-end test runs a throwaway headless Chrome profile; it never touches
your own profile. `SHOTS=/some/dir npm run e2e` also saves screenshots.

## Notes

- Two tabs on the same site always share one server; Chrome can't route per tab.
- Chrome's own background traffic (updates, Safe Browsing) follows the default.
- On Macs where the `BasicAuthOverHttpEnabled` policy is off, the helper's Digest
  login still works.
- Logs: `~/Library/Logs/WireRoute/helper.log` (never contains keys).
