import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

import { cleanPattern, hostOf, isLocal, matchRule, siteOf } from "../extension/lib/hosts.js";
import { buildPac } from "../extension/lib/pac.js";
import { flag, parseConf, toConf } from "../extension/lib/conf.js";

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
