// End-to-end test: a throwaway Chrome profile with WireRoute loaded, the real
// helper, and two fake WireGuard servers (A and B) running locally.
//
//   npm run e2e
//
// Nothing here touches your normal Chrome profile or the Mac's network.

import { spawn, execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { parseConf } from "../../extension/lib/conf.js";

const ROOT = resolve(import.meta.dirname, "../..");
const EXT_ID = "kbmajebcnniiphhhhhgafeipmpibcnjc";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const tmp = mkdtempSync(join(tmpdir(), "wireroute-e2e-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
let failures = 0;

function cleanup() {
  for (const p of procs) {
    try {
      p.kill("SIGKILL");
    } catch {}
  }
  if (!process.env.KEEP) rmSync(tmp, { recursive: true, force: true });
}
process.on("exit", cleanup);

async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    console.log(`  ok   ${name} (${Date.now() - t0}ms)`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}\n       ${e.message.split("\n").join("\n       ")}`);
  }
}

async function until(fn, what, timeout = 15000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e.message;
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}

// --- build ---
// Chrome on macOS only finds helpers registered in its standard folder, so the
// test installs the current helper the normal way first.
console.log("installing helper and building fake servers");
execFileSync(join(ROOT, "install", "install.sh"), { stdio: "ignore" });
execFileSync("go", ["build", "-o", join(tmp, "fakevpn"), "./cmd/fakevpn"], { cwd: join(ROOT, "host"), stdio: "inherit" });

// --- fake servers ---
const fake = spawn(join(tmp, "fakevpn"), ["-dir", tmp, "A", "B"], { stdio: ["ignore", "pipe", "inherit"] });
procs.push(fake);
await new Promise((res) => fake.stdout.on("data", (b) => String(b).includes("ready") && res()));
const confA = parseConf(readFileSync(join(tmp, "A.conf"), "utf8"));
const confB = parseConf(readFileSync(join(tmp, "B.conf"), "utf8"));

const profile = join(tmp, "profile");
// A Chrome with its own profile folder reads helper registrations from there.
mkdirSync(join(profile, "NativeMessagingHosts"), { recursive: true });
copyFileSync(
  join(homedir(), "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.wireroute.host.json"),
  join(profile, "NativeMessagingHosts", "com.wireroute.host.json")
);

const chrome = spawn(
  CHROME,
  [
    ...(process.env.HEADFUL ? ["--window-position=3000,3000", "--window-size=800,600"] : ["--headless=new"]),
    `--user-data-dir=${profile}`,
    "--remote-debugging-pipe",
    "--enable-unsafe-extension-debugging",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=HttpsUpgrades",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] }
);
procs.push(chrome);

// --- tiny CDP client over the pipe ---
let nextId = 1;
const waiting = new Map();
const eventWaiters = [];
let buf = "";
chrome.stdio[4].on("data", (chunk) => {
  buf += chunk.toString();
  let i;
  while ((i = buf.indexOf("\0")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (msg.id && waiting.has(msg.id)) {
      const { res, rej } = waiting.get(msg.id);
      waiting.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    } else if (msg.method) {
      for (const w of [...eventWaiters]) if (w.match(msg)) w.res(msg);
    }
  }
});
function cdp(method, params = {}, sessionId) {
  const id = nextId++;
  chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
  return new Promise((res, rej) => waiting.set(id, { res, rej }));
}

async function evaluate(sessionId, expression) {
  const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

async function openPage(url) {
  const { targetId } = await cdp("Target.createTarget", { url });
  const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
  await cdp("Runtime.enable", {}, sessionId);
  return { targetId, sessionId };
}

const ask = (s, cmd, payload = {}) =>
  evaluate(
    s,
    `new Promise((res, rej) => chrome.runtime.sendMessage(${JSON.stringify({ cmd, ...payload })}, (r) => r?.ok ? res(r.data) : rej(new Error(r?.error))))`
  );

console.log("running in a throwaway Chrome");

await step("extension loads with its fixed ID", async () => {
  const { id } = await cdp("Extensions.loadUnpacked", { path: join(ROOT, "extension") });
  assert.equal(id, EXT_ID);
});

const ext = await openPage(`chrome-extension://${EXT_ID}/options/options.html`);
await until(() => evaluate(ext.sessionId, "document.readyState === 'complete'"), "options page");

await step("helper starts through native messaging", async () => {
  const st = await until(async () => {
    const s = await ask(ext.sessionId, "state");
    return s.helper.connected && s;
  }, "helper connection");
  assert.match(st.helper.version, /^\d+\.\d+\.\d+$/);
});

await step("with nothing set up, Chrome's own connection is left alone", async () => {
  const mode = await evaluate(ext.sessionId, "chrome.proxy.settings.get({}).then(d => d.value.mode)");
  assert.equal(mode, "system");
});

const A = { id: "srvA", name: "A", label: "", ...confA };
const B = { id: "srvB", name: "B", label: "", ...confB };
await evaluate(
  ext.sessionId,
  `chrome.storage.local.set(${JSON.stringify({
    servers: [A, B],
    rules: [{ id: "r1", pattern: "site-a.test", exact: false, route: "srvA", autoFollow: true }],
    settings: { enabled: true, defaultRoute: "srvB", killSwitch: true, blockWebRTC: true, lanDirect: true },
  })})`
);

await step("both servers connect", async () => {
  await until(async () => {
    const s = await ask(ext.sessionId, "state");
    return s.tunnels.srvA?.state === "up" && s.tunnels.srvB?.state === "up";
  }, "both tunnels up", 20000);
});

async function visit(url, { timeout = 15000 } = {}) {
  const page = await openPage(url);
  let lastSeen = "";
  try {
    return await until(async () => {
      const t = await evaluate(page.sessionId, "document.title + '|' + location.href + '|' + (document.body?.innerText ?? '')");
      lastSeen = t;
      const [title, href, text] = t.split("|");
      if (href.startsWith(`chrome-extension://${EXT_ID}/blocked/`)) return { blocked: true, href };
      if (title.startsWith("page:")) return { title };
      if (text.startsWith("via ")) return { text };
      return null;
    }, url, timeout).catch((e) => {
      throw new Error(e.message + "\n       page showed: " + lastSeen.slice(0, 300));
    });
  } finally {
    await cdp("Target.closeTarget", { targetId: page.targetId });
  }
}

await step("site with a rule goes through its server (A)", async () => {
  const r = await visit("http://site-a.test/");
  assert.match(r.title, /^page:A /);
});

await step("hidden address the site loads follows it on the first visit (auto-detect)", async () => {
  const r = await visit("http://site-a.test/?cdn=first-visit-cdn.test");
  assert.equal(r.title, "page:A cdn:A");
});

await step("other sites use the default server (B)", async () => {
  const r = await visit("http://unrelated.test/");
  assert.equal(r.text, "via B for unrelated.test");
});

await step("detected hidden addresses are remembered", async () => {
  const learned = await until(async () => {
    const l = await evaluate(ext.sessionId, "chrome.storage.local.get('learned').then(x => x.learned ?? {})");
    return l["first-visit-cdn.test"] && l;
  }, "learned address saved");
  assert.equal(learned["first-visit-cdn.test"], "r1");
});

await step("a detected address goes with its site even when opened on its own", async () => {
  const r = await visit("http://first-visit-cdn.test/plain");
  assert.equal(r.text, "via A for first-visit-cdn.test");
});

await step("shared services like Google never follow a site", async () => {
  const r = await visit("http://site-a.test/?cdn=www.google.com");
  assert.equal(r.title, "page:A cdn:B");
  const learned = await evaluate(ext.sessionId, "chrome.storage.local.get('learned').then(x => x.learned ?? {})");
  assert.ok(!("www.google.com" in learned), "Google must not be saved as the site's");
});

await step("picking a server only tags the current page's addresses, not the tab's earlier pages", async () => {
  const page = await openPage("http://earlier-page.test/plain");
  await sleep(1000);
  await cdp("Page.navigate", { url: "http://site-c.test/?cdn=c-video.test" }, page.sessionId);
  await until(async () => (await evaluate(page.sessionId, "document.title")).startsWith("page:"), "site-c page");
  const tabId = await evaluate(ext.sessionId, `chrome.tabs.query({}).then(ts => ts.find(t => (t.url || '').startsWith('http://site-c.test'))?.id)`);
  const { ruleId } = await ask(ext.sessionId, "setSiteRoute", { pattern: "site-c.test", exact: false, route: "srvA", tabId });
  const learned = await evaluate(ext.sessionId, "chrome.storage.local.get('learned').then(x => x.learned ?? {})");
  await cdp("Target.closeTarget", { targetId: page.targetId });
  assert.equal(learned["c-video.test"], ruleId, "the page's own hidden address is tagged");
  assert.ok(!("earlier-page.test" in learned), "an earlier page in the tab must not be tagged");
  await ask(ext.sessionId, "setSiteRoute", { pattern: "site-c.test", exact: false, route: null });
});

await step("subdomains follow the site's rule", async () => {
  const r = await visit("http://www.site-a.test/plain");
  assert.equal(r.text, "via A for www.site-a.test");
});

await step("Chrome's proxy points at the helper, WebRTC leak block is on", async () => {
  const proxy = await evaluate(ext.sessionId, "chrome.proxy.settings.get({}).then(d => d.value.mode)");
  assert.equal(proxy, "pac_script");
  const rtc = await evaluate(ext.sessionId, "chrome.privacy.network.webRTCIPHandlingPolicy.get({}).then(d => d.value)");
  assert.equal(rtc, "disable_non_proxied_udp");
});

await step("switching the site to B moves it and its hidden addresses", async () => {
  await ask(ext.sessionId, "setSiteRoute", { pattern: "site-a.test", exact: false, route: "srvB" });
  const r = await visit("http://site-a.test/?cdn=first-visit-cdn.test");
  assert.equal(r.title, "page:B cdn:B");
});

await step("a server no site uses any more is switched off", async () => {
  await until(async () => !(await ask(ext.sessionId, "state")).tunnels.srvA, "server A stopped", 10000);
});

await step("badge shows the site's server", async () => {
  const page = await openPage("http://site-a.test/");
  await sleep(1500);
  const tabId = await evaluate(
    ext.sessionId,
    `chrome.tabs.query({}).then(ts => ts.find(t => (t.url || '').startsWith('http://site-a.test'))?.id)`
  );
  const text = await evaluate(ext.sessionId, `chrome.action.getBadgeText({ tabId: ${tabId} })`);
  await cdp("Target.closeTarget", { targetId: page.targetId });
  assert.equal(text, "B");
});

if (process.env.SHOTS) {
  const { writeFileSync } = await import("node:fs");
  const shot = async (url, file, width, height, wait = 1200) => {
    const page = await openPage(url);
    await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false }, page.sessionId);
    await sleep(wait);
    const { data } = await cdp("Page.captureScreenshot", { format: "png" }, page.sessionId);
    writeFileSync(join(process.env.SHOTS, file), Buffer.from(data, "base64"));
    await cdp("Target.closeTarget", { targetId: page.targetId });
  };
  const site = await openPage("http://site-a.test/?cdn=first-visit-cdn.test");
  await sleep(1500);
  const tabId = await evaluate(ext.sessionId, `chrome.tabs.query({}).then(ts => ts.find(t => (t.url || '').startsWith('http://site-a.test'))?.id)`);
  await shot(`chrome-extension://${EXT_ID}/popup/popup.html?tab=${tabId}`, "popup.png", 360, 720);
  await shot(`chrome-extension://${EXT_ID}/options/options.html#sites`, "sites.png", 1100, 760);
  await shot(`chrome-extension://${EXT_ID}/options/options.html#servers`, "servers.png", 1100, 760);
  await shot(`chrome-extension://${EXT_ID}/options/options.html#settings`, "settings.png", 1100, 760);
  await shot(`chrome-extension://${EXT_ID}/options/options.html#sites`, "sites-mobile.png", 390, 800);
  await cdp("Target.closeTarget", { targetId: site.targetId });
}

await step("kill switch: a site whose server is down is blocked, never sent direct", async () => {
  // Point A at a dead port, then put site-a.test back on A.
  const deadA = { ...A, endpoint: "127.0.0.1:9" };
  await evaluate(ext.sessionId, `chrome.storage.local.get('servers').then(({servers}) => chrome.storage.local.set({ servers: servers.map(s => s.id === 'srvA' ? ${JSON.stringify(deadA)} : s) }))`);
  await ask(ext.sessionId, "setSiteRoute", { pattern: "site-a.test", exact: false, route: "srvA" });
  await until(async () => (await ask(ext.sessionId, "state")).tunnels.srvA?.state === "down", "server A marked down", 40000);
  const r = await visit("http://site-a.test/");
  assert.ok(r.blocked, "expected the VPN-down page, got " + JSON.stringify(r));
  if (process.env.SHOTS) {
    const page = await openPage("http://site-a.test/");
    await cdp("Emulation.setDeviceMetricsOverride", { width: 900, height: 600, deviceScaleFactor: 2, mobile: false }, page.sessionId);
    await sleep(1500);
    const { data } = await cdp("Page.captureScreenshot", { format: "png" }, page.sessionId);
    (await import("node:fs")).writeFileSync(join(process.env.SHOTS, "blocked.png"), Buffer.from(data, "base64"));
    await cdp("Target.closeTarget", { targetId: page.targetId });
  }
});

await step("blocked page lets the site load once its server is back", async () => {
  await evaluate(ext.sessionId, `chrome.storage.local.get('servers').then(({servers}) => chrome.storage.local.set({ servers: servers.map(s => s.id === 'srvA' ? ${JSON.stringify(A)} : s) }))`);
  await until(async () => (await ask(ext.sessionId, "state")).tunnels.srvA?.state !== "down", "server A back", 20000);
  const r = await visit("http://site-a.test/", { timeout: 20000 });
  assert.match(r.title ?? "", /^page:A /);
});

await step("normal sites still load over the real internet (direct)", async () => {
  await evaluate(ext.sessionId, "chrome.storage.local.get('settings').then(({settings}) => chrome.storage.local.set({ settings: { ...settings, defaultRoute: 'direct' } }))");
  await sleep(2000);
  const page = await openPage("https://example.com/");
  let lastText = "";
  try {
    const title = await until(async () => {
      const t = await evaluate(page.sessionId, "document.title");
      lastText = await evaluate(page.sessionId, "location.href + ' | ' + (document.body?.innerText ?? '').slice(0, 200)");
      return t.includes("Example") && t;
    }, "example.com", 20000).catch((e) => {
      throw new Error(e.message + "\n       page showed: " + lastText);
    });
    assert.match(title, /Example Domain/);
  } finally {
    await cdp("Target.closeTarget", { targetId: page.targetId });
  }
});

await step("turning WireRoute off hands the proxy back to Chrome", async () => {
  await evaluate(ext.sessionId, "chrome.storage.local.get('settings').then(({settings}) => chrome.storage.local.set({ settings: { ...settings, enabled: false } }))");
  await until(async () => (await evaluate(ext.sessionId, "chrome.proxy.settings.get({}).then(d => d.value.mode)")) === "system", "proxy cleared");
  const rtc = await evaluate(ext.sessionId, "chrome.privacy.network.webRTCIPHandlingPolicy.get({}).then(d => d.value)");
  assert.equal(rtc, "default");
});

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
