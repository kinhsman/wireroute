import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

import { cleanPattern, hostOf, isLocal, isShared, matchRule, siteOf } from "../extension/lib/hosts.js";
import { buildPac } from "../extension/lib/pac.js";
import { cleanIcon, flag, groupIcon, parseConf, toConf } from "../extension/lib/conf.js";

const RULES = [
  { id: "cnn", pattern: "cnn.com", route: "us" },
  { id: "ed", pattern: "edition.cnn.com", route: "uk" },
  { id: "ex", pattern: "exact.example.com", exact: true, route: "vn" },
  { id: "tv", pattern: "TV360.vn.", route: "vn" },
  { id: "dir", pattern: "bank.example", route: "direct" },
];

// Same cases as host/router_test.go: the extension and helper must agree.
const MATCH_CASES = {
  "cnn.com": "us",
  "www.cnn.com": "us",
  "a.b.cnn.com": "us",
  "edition.cnn.com": "uk",
  "live.edition.cnn.com": "uk",
  "notcnn.com": null,
  "exact.example.com": "vn",
  "sub.exact.example.com": null,
  "tv360.vn": "vn",
  "WWW.TV360.VN": "vn",
  "cnn.com.evil.example": null,
};

test("matchRule picks the most specific rule", () => {
  for (const [host, want] of Object.entries(MATCH_CASES)) {
    assert.equal(matchRule(RULES, host)?.route ?? null, want, host);
  }
});

test("siteOf finds the registrable domain", () => {
  assert.equal(siteOf("edition.cnn.com"), "cnn.com");
  assert.equal(siteOf("tv360.vn"), "tv360.vn");
  assert.equal(siteOf("www.tv360.vn"), "tv360.vn");
  assert.equal(siteOf("video.viettel.com.vn"), "viettel.com.vn");
  assert.equal(siteOf("news.bbc.co.uk"), "bbc.co.uk");
  assert.equal(siteOf("1.2.3.4"), "1.2.3.4");
  assert.equal(siteOf("localhost"), "localhost");
});

test("hostOf only takes web URLs", () => {
  assert.equal(hostOf("https://Edition.CNN.com/world"), "edition.cnn.com");
  assert.equal(hostOf("wss://chat.example.com/x"), "chat.example.com");
  assert.equal(hostOf("chrome://extensions"), "");
  assert.equal(hostOf("not a url"), "");
  assert.equal(hostOf("http://[::1]:8080/"), "::1");
});

test("cleanPattern accepts what people type", () => {
  assert.equal(cleanPattern("https://www.cnn.com/world?x=1"), "www.cnn.com");
  assert.equal(cleanPattern("  CNN.com "), "cnn.com");
  assert.equal(cleanPattern("*.cnn.com"), "cnn.com");
  assert.equal(cleanPattern("cnn.com/path"), "cnn.com");
  assert.equal(cleanPattern("bad host!"), "");
  assert.equal(cleanPattern(""), "");
});

test("isLocal covers home network addresses", () => {
  for (const h of ["localhost", "192.168.1.1", "10.0.0.5", "172.20.1.1", "printer.local", "router", "::1"]) {
    assert.ok(isLocal(h), h);
  }
  for (const h of ["8.8.8.8", "cnn.com", "172.32.0.1"]) assert.ok(!isLocal(h), h);
});

function runPac(script) {
  const ctx = {
    isPlainHostName: (h) => !h.includes("."),
  };
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  return (host) => ctx.FindProxyForURL(`https://${host}/`, host);
}

test("PAC: ruled sites never fall back to direct (kill switch)", () => {
  const pac = runPac(
    buildPac({
      port: 18869,
      rules: RULES,
      learned: { "video.viettel.vn": "tv", "gone.example": "deleted" },
      defaultRoute: "direct",
      killSwitch: true,
      lanDirect: true,
    })
  );
  const P = "PROXY 127.0.0.1:18869";
  assert.equal(pac("www.cnn.com"), P);
  assert.equal(pac("edition.cnn.com"), P);
  assert.equal(pac("video.viettel.vn"), P, "learned hidden address is strict too");
  assert.equal(pac("bank.example"), "DIRECT", "direct rule skips the helper");
  assert.equal(pac("gone.example"), P + "; DIRECT");
  assert.equal(pac("random.example"), P + "; DIRECT", "unknown hosts still go via helper so it can route them");
  assert.equal(pac("192.168.1.1"), "DIRECT");
  assert.equal(pac("router"), "DIRECT");
  assert.equal(pac("WWW.CNN.COM."), P);
});

test("PAC: kill switch off allows fallback, VPN default is strict", () => {
  const P = "PROXY 127.0.0.1:1";
  const loose = runPac(buildPac({ port: 1, rules: RULES, learned: {}, defaultRoute: "direct", killSwitch: false, lanDirect: false }));
  assert.equal(loose("cnn.com"), P + "; DIRECT");
  assert.equal(loose("192.168.1.1"), P + "; DIRECT", "LAN goes via helper when lanDirect is off");
  const strictDefault = runPac(buildPac({ port: 1, rules: [], learned: {}, defaultRoute: "home", killSwitch: true, lanDirect: true }));
  assert.equal(strictDefault("anything.example"), P);
});

const CONF = `
# exported by my router
[Interface]
PrivateKey = yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=
Address = 10.0.0.2/32, fd00::2/128
DNS = 1.1.1.1, 1.0.0.1, home.lan
MTU = 1380
PostUp = something

[Peer]
PublicKey = xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=
Endpoint = myhome.example.com:51820
AllowedIPs = 0.0.0.0/0, ::/0
PersistentKeepalive = 25
`;

test("parseConf reads a normal client config", () => {
  const s = parseConf(CONF);
  assert.deepEqual(s.addresses, ["10.0.0.2/32", "fd00::2/128"]);
  assert.deepEqual(s.dns, ["1.1.1.1", "1.0.0.1"]);
  assert.deepEqual(s.allowedIPs, ["0.0.0.0/0", "::/0"]);
  assert.equal(s.endpoint, "myhome.example.com:51820");
  assert.equal(s.mtu, 1380);
  assert.equal(s.keepalive, 25);
  assert.deepEqual(parseConf(toConf(s)), s, "export and re-import round-trips");
});

test("parseConf explains bad files", () => {
  assert.throws(() => parseConf("hello"), /PrivateKey/);
  assert.throws(() => parseConf("[Interface]\nPrivateKey = abc\nAddress = 10.0.0.2/32\n[Peer]\nPublicKey = x\nEndpoint = a:1"), /WireGuard key/);
  assert.throws(() => parseConf(CONF.replace("Endpoint = myhome.example.com:51820", "")), /Endpoint/);
});

test("flag turns country codes into emoji", () => {
  assert.equal(flag("US"), "🇺🇸");
  assert.equal(flag("vn"), "🇻🇳");
  assert.equal(flag(undefined), "🌐");
});

test("shared services are recognised, site-specific addresses aren't", () => {
  for (const h of ["www.google.com", "www.google.com.vn", "fonts.gstatic.com", "static.cloudflareinsights.com", "connect.facebook.net", "www.googletagmanager.com"]) {
    assert.ok(isShared(h), h);
  }
  for (const h of ["video.viettel.vn", "tv360.vn", "cdn.tv360.vn", "media.ethicalads.io", "googleish.com"]) assert.ok(!isShared(h), h);
});

test("group icons: a country code becomes its flag, an emoji is kept, anything else picks itself", () => {
  assert.equal(cleanIcon("vn"), "🇻🇳");
  assert.equal(cleanIcon(" 🇻🇳 "), "🇻🇳");
  assert.equal(cleanIcon("🇯🇵 Japan"), "🇯🇵");
  assert.equal(cleanIcon("🏠"), "🏠");
  assert.equal(cleanIcon("Vietnam"), "");
  assert.equal(cleanIcon(""), "");
  assert.equal(cleanIcon(null), "");
  assert.equal(groupIcon({ icon: "🇻🇳" }, "US"), "🇻🇳");
  assert.equal(groupIcon({ icon: "" }, "US"), "🇺🇸");
  assert.equal(groupIcon({}, undefined), "🔁");
});

test("server health: up with a speed, slow when far, how long it's been down", async () => {
  const { serverHealth, ago, needsCheck, countryName, RECHECK_AFTER_MS } = await import("../extension/lib/health.js");
  const now = 1_800_000_000_000;
  const sec = now / 1000;

  const fast = serverHealth({ state: "up", pingMs: 42, since: sec - 600 }, { ip: "1.2.3.4", loc: "VN", at: now - 120_000 }, now);
  assert.equal(fast.text, "Connected · 42 ms");
  assert.equal(fast.cls, "ok");
  assert.equal(fast.where, "Vietnam");
  assert.match(fast.title, /Sites see 1\.2\.3\.4 in Vietnam, checked 2 min ago/);

  const slow = serverHealth({ state: "up", pingMs: 650, relay: true }, null, now);
  assert.equal(slow.text, "Connected, relay on · 650 ms, slow");
  assert.equal(slow.cls, "warn");
  assert.equal(slow.where, "");

  // An older helper sends no speed: still just "Connected".
  assert.equal(serverHealth({ state: "up" }, null, now).text, "Connected");

  const down = serverHealth({ state: "down", since: sec - 300 }, null, now);
  assert.equal(down.text, "Not reachable for 5 min");
  assert.equal(down.cls, "bad");

  assert.equal(serverHealth({ state: "error", error: "bad key" }, null, now).title, "bad key");
  assert.equal(serverHealth(undefined, null, now).text, "Off until a site uses it");

  const leak = serverHealth({ state: "up", pingMs: 5 }, { ip: "9.9.9.9", loc: "US", sameAsYou: true }, now);
  assert.match(leak.where, /your own address \(9\.9\.9\.9\)/);

  assert.equal(ago(20), "a moment");
  assert.equal(ago(7200), "2 hr");
  assert.equal(ago(86400), "1 day");
  assert.equal(countryName("us"), "United States");
  assert.equal(countryName("??"), "??");

  // Exit checks: only for connected servers, and only when missing or old.
  assert.equal(needsCheck({ state: "up" }, undefined, now), true);
  assert.equal(needsCheck({ state: "up" }, { at: now - 60_000 }, now), false);
  assert.equal(needsCheck({ state: "up" }, { at: now - RECHECK_AFTER_MS - 1 }, now), true);
  assert.equal(needsCheck({ state: "down" }, undefined, now), false);
});

test("data today: counts what moved, survives restarts, starts over each day", async () => {
  const { addUsage, bytesText, dayKey } = await import("../extension/lib/usage.js");
  let u = addUsage(undefined, { a: { rxBytes: 1000, txBytes: 500 } }, "2026-11-09");
  assert.deepEqual(u.bytes, {}, "first sight only sets the starting point");
  u = addUsage(u, { a: { rxBytes: 5000, txBytes: 1500 } }, "2026-11-09");
  assert.equal(u.bytes.a, 5000);
  u = addUsage(u, { a: { rxBytes: 300, txBytes: 0 } }, "2026-11-09"); // tunnel restarted
  assert.equal(u.bytes.a, 5300);
  u = addUsage(u, { a: { rxBytes: 1300, txBytes: 0 } }, "2026-11-10"); // new day
  assert.deepEqual(u.bytes, { a: 1000 });
  assert.equal(bytesText(0), "0 MB");
  assert.equal(bytesText(840 * 1024), "840 KB");
  assert.equal(bytesText(14.4 * 1024 * 1024), "14 MB");
  assert.equal(bytesText(1.25 * 1024 ** 3), "1.3 GB");
  assert.match(dayKey(new Date(2026, 0, 5)), /^2026-01-05$/);
});

test("alerts: server down, group switch, all down, back again", async () => {
  const { alertFor, nextMember } = await import("../extension/lib/alerts.js");
  const server = { id: "a", name: "VN 1" };
  const names = { a: "VN 1", b: "VN 2", c: "VN 3" };
  const g = { id: "g", name: "Vietnam", members: ["a", "b", "c"] };
  const tunnels = { a: { state: "down" }, b: { state: "up", pingMs: 300 }, c: { state: "up", pingMs: 90 } };

  assert.equal(alertFor("up", "down", { server, names }).title, "VN 1 is down");
  assert.match(alertFor("up", "down", { server, names, killSwitch: false }).message, /normal connection/);
  assert.equal(alertFor("up", "down", { server, groups: [g], tunnels, names }).title, "Vietnam: switched to VN 2");
  assert.equal(alertFor("up", "down", { server, groups: [{ ...g, fastest: true }], tunnels, names }).title, "Vietnam: switched to VN 3");
  const allDown = { a: { state: "down" }, b: { state: "down" } };
  assert.equal(alertFor("up", "down", { server, groups: [g], tunnels: allDown, names }).title, "Vietnam: every server is down");
  assert.equal(alertFor("down", "up", { server }).title, "VN 1 is back");
  // Starting up, or a first reading, is no news.
  assert.equal(alertFor(undefined, "up", { server }), null);
  assert.equal(alertFor("starting", "up", { server }), null);
  assert.equal(alertFor(undefined, "down", { server }), null);
  assert.equal(nextMember(g, tunnels, "b"), "c");
});

test("site packs: adds what's missing, keeps sites you already set", async () => {
  const { PACKS, addPack } = await import("../extension/lib/packs.js");
  const tv = PACKS.find((p) => p.id === "vn-tv");
  assert.ok(tv.sites.includes("tv360.vn"));
  for (const p of PACKS) for (const s of p.sites) assert.equal(cleanPattern(s), s, `${s} is a clean site`);
  let n = 0;
  const res = addPack([{ id: "x", pattern: "tv360.vn", route: "us" }], tv, "vn", () => "id" + n++);
  assert.deepEqual(res.kept, ["tv360.vn"]);
  assert.equal(res.added.length, tv.sites.length - 1);
  assert.equal(res.rules.find((r) => r.pattern === "tv360.vn").route, "us");
  assert.ok(res.rules.filter((r) => r.pattern !== "tv360.vn").every((r) => r.route === "vn" && r.autoFollow));
});

test("wg-easy: addresses and client lists", async () => {
  const { cleanBase, simplify, inUseElsewhere } = await import("../extension/lib/wgeasy.js");
  assert.equal(cleanBase("10.12.10.25:51821"), "http://10.12.10.25:51821");
  assert.equal(cleanBase(" https://vpn.example.com/ "), "https://vpn.example.com");
  assert.equal(cleanBase("https://example.com/wg/"), "https://example.com/wg");
  assert.equal(cleanBase(""), "");
  const now = Date.parse("2026-11-09T12:00:00Z");
  const c = simplify({ id: 3, name: "TV", enabled: true, ipv4Address: "10.8.0.4", latestHandshakeAt: "2026-11-09T11:59:00Z" });
  assert.deepEqual([c.id, c.name, c.address], [3, "TV", "10.8.0.4"]);
  assert.equal(inUseElsewhere(c, now), true);
  assert.equal(inUseElsewhere(simplify({ id: 4, name: "Old", latestHandshakeAt: null }), now), false);
});
