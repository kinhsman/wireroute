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

1. Install the helper with one line. No admin rights, no Go.

   Windows (PowerShell):

   ```powershell
   irm https://raw.githubusercontent.com/kinhsman/wireroute/main/install/get.ps1 | iex
   ```

   Mac (Terminal):

   ```bash
   curl -fsSL https://raw.githubusercontent.com/kinhsman/wireroute/main/install/get.sh | bash
   ```

   These download the latest helper from GitHub Releases. To build it from
   source on a Mac instead, run `./install/install.sh`; if the Mac doesn't
   have Go, it downloads the official one into `~/Library/Caches/WireRoute`
   (one time, about 70 MB, checksum verified).

2. In Chrome open `chrome://extensions`, switch on Developer mode (top right),
   click Load unpacked and pick the `extension` folder.
3. Drop your WireGuard `.conf` files on the Servers page that opens, or get
   them straight from wg-easy 15 (sign in to wg-easy in Chrome as usual;
   WireRoute uses that sign-in and never sees your password).
4. On any site, click the WireRoute icon and pick a server.

## What else it does

- The popup shows each server's state, speed and the country sites see you
  in (checked by itself every few hours), plus data used today.
- Groups use the first server that's up, or the fastest one. Fastest only
  moves when another server is clearly quicker (1.5 times and 50 ms faster),
  so sites don't keep seeing a new address.
- Alerts when a server you use stops answering, a group switches, or it's back.
- Pause for an hour from the popup; it turns itself back on.
- Right-click a link to open it through a server, or a page to move its site.
- Site packs: add Vietnam TV, Vietnam music or US streaming sites in one go.

Uninstall the helper with `./install/install.sh --remove` (also deletes that Go).

### Releasing a new helper

Bump the version in `extension/manifest.json` and `host/types.go`, commit,
then run `./tools/release.sh`. It builds the helper for Windows and Mac and
publishes GitHub release `v<version>`, which the one-line installs pick up.

### Windows zip

`./tools/package-windows.sh` (on a Mac or Linux box with Go) builds
`dist/WireRoute-windows-<version>.zip`: the extension, the helper for x64 and
ARM PCs, and `Install WireRoute.cmd`, which copies the helper to
`%LOCALAPPDATA%\WireRoute` and registers it with Chrome, Edge and Brave in
your user registry (no admin rights). `Uninstall WireRoute.cmd` undoes it.

## Tests

```bash
npm test                          # rules, PAC and config parsing
(cd host && go test -race ./...)  # helper, with fake WireGuard servers
npm run e2e                       # real Chrome: features, real-life browsing,
                                  # break-it (leaks, crashes, restart), DNS
                                  # leaks, every button
```

The end-to-end test runs a throwaway headless Chrome profile; it never touches
your own profile. `SHOTS=/some/dir npm run e2e` also saves screenshots. On
Linux, set `CHROME` to a Chrome or Chromium if Google Chrome isn't installed,
and keep `TMPDIR` short (Chrome refuses long socket paths).

DNS leaks are checked twice. `TestNoDNSLeaks` (helper) catches any site name
the helper looks up on your computer instead of inside the tunnel.
`test/e2e/dnsleak.js` reads Chrome's own network log while it browses sites
set to a server, including pages with DNS prefetch, preconnect, links,
pictures and a hovered link, and fails on any lookup Chrome sends out for
them. Both first check that they can see a lookup (a Direct site), so a pass
means something.

## Notes

- Two tabs on the same site always share one server; Chrome can't route per tab.
- Chrome's own background traffic (updates, Safe Browsing) follows the default.
- On Macs where the `BasicAuthOverHttpEnabled` policy is off, the helper's Digest
  login still works.
- Logs: `~/Library/Logs/WireRoute/helper.log` (never contains keys).
- Country flags come from a small bundled font (`extension/lib/fonts/`), since
  Chrome on Windows has none and shows "VN" instead. The flag pictures are
  [Twemoji](https://github.com/twitter/twemoji) (CC-BY 4.0), packed as a font by
  [country-flag-emoji-polyfill](https://github.com/talkjs/country-flag-emoji-polyfill) (MIT).
