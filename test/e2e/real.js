// Real-world run: a real WireGuard server, real sites, a throwaway Chrome.
//
//   node test/e2e/real.js [path/to/test-peer.conf]
//
// Uses a test-only peer (default ~/Library/Application Support/WireRoute/
// test-peer.conf, readable only by you) so it never
// fights your own browsing over the same key. Sends ifconfig.io and tv360.vn
// through that server, everything else direct, then browses like a person and
// checks the always-true rules after each step.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { parseConf } from "../../extension/lib/conf.js";
import { Browser, EXT_ID, ROOT, checkInvariants, finish, setup, sleep, step, until } from "./harness.js";

const confPath = process.argv[2] ?? join(homedir(), "Library", "Application Support", "WireRoute", "test-peer.conf");
if (!existsSync(confPath)) {
  console.log(`No test key at ${confPath}. Add a peer in your WireGuard dashboard and save its config there.`);
  process.exit(2);
}
const server = { id: "srvL", name: "lambut-test", label: "", ...parseConf(readFileSync(confPath, "utf8")) };
const NAMES = { srvL: "lambut-test" };
const myIP = execFileSync("curl", ["-s", "-m", "10", "https://ifconfig.io/ip"]).toString().trim();

const { tmp } = await setup([]);
const b = new Browser(join(tmp, "profile"));
await b.launch();
await b.cdp("Extensions.loadUnpacked", { path: join(ROOT, "extension") });
const ext = await b.openPage(`chrome-extension://${EXT_ID}/options/options.html`);
await until(async () => (await b.ask(ext.sessionId, "state")).helper.connected, "helper");
await b.evaluate(
  ext.sessionId,
  `chrome.storage.local.set(${JSON.stringify({
    servers: [server],
    rules: [
      { id: "rIfc", pattern: "ifconfig.io", exact: false, route: "srvL", autoFollow: true },
      { id: "rTv", pattern: "tv360.vn", exact: false, route: "srvL", autoFollow: true },
    ],
    learned: {},
    settings: { enabled: true, defaultRoute: "direct", killSwitch: true, blockWebRTC: true, lanDirect: true },
  })})`
);
const invariants = (opts) => checkInvariants(b, ext, { names: NAMES, ...opts });
const text = (p) => b.evaluate(p.sessionId, "document.body?.innerText ?? ''");

console.log(`real world: your address ${myIP}, server ${server.endpoint}`);

let exitIP = "";
await step("the test server connects and comes out somewhere other than your own address", async () => {
  await until(async () => (await b.ask(ext.sessionId, "state")).tunnels.srvL?.state === "up", "server up", 30000);
  const c = await b.ask(ext.sessionId, "check", { server: "srvL" });
  exitIP = c.ip;
  console.log(`       exits as ${c.ip} (${c.loc})`);
  assert.notEqual(c.ip, myIP, "server exits with your own address");
  assert.ok(!c.sameAsYou);
});

await step("ifconfig.io shows the server's address, not yours", async () => {
  const t0 = Date.now();
  const p = await b.openPage("https://ifconfig.io/");
  const t = await until(async () => {
    const x = await text(p);
    return /\d+\.\d+\.\d+\.\d+/.test(x) && x;
  }, "ifconfig.io", 20000);
  assert.ok(t.includes(exitIP), "page doesn't show the server's address");
  assert.ok(!t.includes(myIP), "page shows your real address");
  await invariants({ t0, tabPrefix: "https://ifconfig.io" });
  await b.close(p);
});

await step("search Google, click through to tv360.vn: the site and its hidden addresses use the server, Google doesn't", async () => {
  const t0 = Date.now();
  const p = await b.openPage("https://www.google.com/search?q=tv360.vn&hl=en");
  await sleep(4000);
  const clicked = await b.evaluate(
    p.sessionId,
    `(() => { const a = [...document.querySelectorAll('a[href]')].find(a => /^https:\\/\\/(www\\.)?tv360\\.vn/.test(a.href)); if (!a) return false; a.removeAttribute('target'); a.click(); return true; })()`
  );
  if (!clicked) {
    console.log("       note: Google showed no clickable result (consent page or bot check); opening tv360.vn directly");
    await b.cdp("Page.navigate", { url: "https://tv360.vn/" }, p.sessionId);
  }
  await until(async () => (await b.evaluate(p.sessionId, "location.host")).endsWith("tv360.vn"), "tv360.vn", 20000);
  await sleep(12000); // let the page load its players and APIs
  const decided = await invariants({ t0, tabPrefix: "https://tv360.vn" });
  assert.equal(decided.get("tv360.vn")?.route ?? decided.get("www.tv360.vn")?.route, "srvL");
  const viaServer = [...decided.values()].filter((d) => d.route === "srvL").map((d) => d.host);
  const google = [...decided.values()].filter((d) => /google/.test(d.host));
  console.log(`       ${viaServer.length} addresses went through the server: ${viaServer.slice(0, 8).join(", ")}${viaServer.length > 8 ? ", ..." : ""}`);
  assert.ok(google.every((d) => d.route === "direct"), "Google followed tv360: " + JSON.stringify(google));
  await b.close(p);
});

await step("a normal site goes direct and the badge stays blank", async () => {
  const t0 = Date.now();
  const p = await b.openPage("https://www.wikipedia.org/");
  await until(async () => (await text(p)).includes("Wikipedia"), "wikipedia", 20000);
  const decided = await invariants({ t0, tabPrefix: "https://www.wikipedia.org" });
  assert.equal(decided.get("www.wikipedia.org")?.route, "direct");
  await b.close(p);
});

await step("on tv360.vn, WebRTC can't reveal your address", async () => {
  const p = await b.openPage("https://tv360.vn/");
  await sleep(3000);
  const cands = await b.evaluate(
    p.sessionId,
    `new Promise((res) => {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
      const out = [];
      pc.onicecandidate = (e) => { if (e.candidate) out.push(e.candidate.candidate); };
      pc.createDataChannel("x");
      pc.createOffer().then((o) => pc.setLocalDescription(o));
      setTimeout(() => res(out), 5000);
    })`
  );
  const leaks = cands.filter((c) => c.includes(myIP) || / typ srflx /.test(c) || / (\d{1,3}\.){3}\d{1,3} \d+ typ host/.test(c));
  assert.deepEqual(leaks, []);
  await b.close(p);
});

finish();
