// End-to-end test: a throwaway Chrome profile with WireRoute loaded, the real
// helper, and two fake WireGuard servers (A and B) running locally.
//
//   npm run e2e
//
// Nothing here touches your normal Chrome profile or the Mac's network.

import { join } from "node:path";
import assert from "node:assert/strict";
import { Browser, EXT_ID, ROOT, finish, setup, sleep, step, until } from "./harness.js";

const { tmp, confs } = await setup(["A", "B"]);
const confA = confs.A;
const confB = confs.B;
const browser = new Browser(join(tmp, "profile"));
await browser.launch();
const cdp = (...a) => browser.cdp(...a);
const evaluate = (...a) => browser.evaluate(...a);
const openPage = (...a) => browser.openPage(...a);
const ask = (...a) => browser.ask(...a);

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

finish();
