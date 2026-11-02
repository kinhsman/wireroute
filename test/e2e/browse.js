// Browse like a person, then check what must always be true.
//
//   node test/e2e/browse.js
//
// Fake world: server A and server B. site-a.test goes through A, every other
// site through B (so B stands in for "the normal internet"). After each
// journey we check, against the helper's own record of what it did:
//   - pages load and nothing is blocked unless a server is down
//   - every address with its own rule used that rule
//   - shared services (Google & co) never followed a site
//   - the popup and badge say exactly what the helper did
//   - only the current page's hidden addresses got tagged to a site

import { join } from "node:path";
import assert from "node:assert/strict";
import { Browser, EXT_ID, ROOT, finish, setup, sleep, step, until } from "./harness.js";
import { isShared, matchRule } from "../../extension/lib/hosts.js";

const { tmp, confs } = await setup(["A", "B"]);
const b = new Browser(join(tmp, "profile"));
await b.launch();
await b.cdp("Extensions.loadUnpacked", { path: join(ROOT, "extension") });
const ext = await b.openPage(`chrome-extension://${EXT_ID}/options/options.html`);
await until(async () => (await b.ask(ext.sessionId, "state")).helper.connected, "helper");

const SERVERS = { srvA: "A", srvB: "B" };
const rules = [{ id: "rA", pattern: "site-a.test", exact: false, route: "srvA", autoFollow: true }];
await b.evaluate(
  ext.sessionId,
  `chrome.storage.local.set(${JSON.stringify({
    servers: [
      { id: "srvA", name: "A", label: "", ...confs.A },
      { id: "srvB", name: "B", label: "", ...confs.B },
    ],
    rules,
    learned: {},
    settings: { enabled: true, defaultRoute: "srvB", killSwitch: true, blockWebRTC: true, lanDirect: true },
  })})`
);
await until(async () => {
  const s = await b.ask(ext.sessionId, "state");
  return s.tunnels.srvA?.state === "up" && s.tunnels.srvB?.state === "up";
}, "both servers up", 20000);

// --- helpers ---

const storage = (key) => b.evaluate(ext.sessionId, `chrome.storage.local.get('${key}').then(x => x['${key}'])`);
const recent = () => b.ask(ext.sessionId, "recent");
const tabIdOf = (prefix) =>
  b.evaluate(ext.sessionId, `chrome.tabs.query({}).then(ts => ts.find(t => (t.url || '').startsWith(${JSON.stringify(prefix)}))?.id)`);
const title = (page) => b.evaluate(page.sessionId, "document.title");
const waitTitle = (page, re, what) => until(async () => re.test(await title(page)) && (await title(page)), what);

/** Last decision per host since t0. */
async function decisionsSince(t0) {
  const map = new Map();
  for (const d of await recent()) if (d.at >= t0) map.set(d.host, d);
  return map;
}

/** Check everything that must always hold, after one journey. */
async function invariants({ t0, tabPrefix, allowBlocked = false }) {
  const problems = [];
  const decided = await decisionsSince(t0);
  const settings = await storage("settings");
  const currentRules = await storage("rules");

  for (const [host, d] of decided) {
    if (d.route === "blocked" && !allowBlocked) problems.push(`${host} was blocked`);
    const own = matchRule(currentRules, host);
    if (own && d.route !== own.route && d.route !== "blocked") problems.push(`${host} has its own rule (${own.route}) but went ${d.route}`);
    if (!own && isShared(host) && d.route !== settings.defaultRoute) problems.push(`shared ${host} followed a site (${d.route})`);
  }

  const learned = (await storage("learned")) ?? {};
  for (const h of Object.keys(learned)) if (isShared(h)) problems.push(`shared ${h} was tagged to a site`);

  if (tabPrefix) {
    const tabId = await tabIdOf(tabPrefix);
    const info = await b.ask(ext.sessionId, "tabInfo", { tabId });
    // What the popup claims must match what the helper did.
    const claims = [{ host: info.host, route: info.route }, ...info.hosts];
    for (const c of claims) {
      const d = decided.get(c.host);
      if (d && d.route !== "blocked" && d.route !== c.route) problems.push(`popup says ${c.host} goes ${SERVERS[c.route] ?? c.route}, helper sent it ${SERVERS[d.route] ?? d.route}`);
    }
    // And the popup page itself must show that claim.
    const pop = await b.openPage(`chrome-extension://${EXT_ID}/popup/popup.html?tab=${tabId}`);
    const shown = await until(
      () =>
        b.evaluate(
          pop.sessionId,
          `(() => {
            const pill = document.getElementById('site-status')?.textContent;
            const checked = document.querySelector('.route[aria-checked="true"] .name')?.firstChild?.textContent;
            const rows = [...document.querySelectorAll('#detected-list li')].map(li => [li.querySelector('.h').textContent, li.querySelector('.r').textContent]);
            return pill ? { pill, checked, rows } : null;
          })()`
        ),
      "popup render"
    );
    await b.close(pop);
    const wantPill = info.route === "direct" ? "Not protected" : info.usable ? "Protected" : "Blocked, server down";
    if (shown.pill !== wantPill) problems.push(`popup pill "${shown.pill}", expected "${wantPill}"`);
    const wantChecked = info.rule ? SERVERS[info.rule.route] ?? "Direct" : "Automatic";
    if (shown.checked !== wantChecked) problems.push(`popup has "${shown.checked}" selected, expected "${wantChecked}"`);
    for (const [h, label] of shown.rows) {
      const d = decided.get(h);
      if (d && d.route !== "blocked" && !label.startsWith(SERVERS[d.route] ?? "Direct")) problems.push(`popup row ${h} says "${label}", helper sent it ${SERVERS[d.route]}`);
    }
    // Badge.
    const badge = await b.evaluate(ext.sessionId, `chrome.action.getBadgeText({ tabId: ${tabId} })`);
    const wantBadge = info.route === "direct" ? "" : info.usable ? SERVERS[info.route] : "!";
    if (badge !== wantBadge) problems.push(`badge "${badge}", expected "${wantBadge}"`);
  }
  if (problems.length) throw new Error(problems.join("\n"));
  return decided;
}

console.log("browsing like a person");

// 1. Search, then click a result in the same tab.
let tab;
await step("search, click a result: site and its hidden address use A, the search page uses B", async () => {
  const t0 = Date.now();
  tab = await b.openPage("http://search.test/?to=" + encodeURIComponent("http://site-a.test/?cdn=j1-cdn.test"));
  await waitTitle(tab, /^search/, "search page");
  await b.evaluate(tab.sessionId, "document.getElementById('result').click()");
  assert.equal(await waitTitle(tab, /^page:/, "result page"), "page:A cdn:A");
  const d = await invariants({ t0, tabPrefix: "http://site-a.test" });
  assert.equal(d.get("search.test")?.route, "srvB");
  assert.equal(d.get("search-assets.test")?.route, "srvB");
  // Tags are saved a moment after they're detected.
  await until(async () => ((await storage("learned")) ?? {})["j1-cdn.test"], "tag saved");
  await sleep(2000);
  assert.deepEqual(Object.keys(await storage("learned")).sort(), ["j1-cdn.test"], "only the site's own hidden address is tagged");
});

// 2. Back to the search page and forward again.
await step("back to the search page: popup and badge follow, nothing from the site leaks in", async () => {
  const t0 = Date.now();
  await b.evaluate(tab.sessionId, "history.back()");
  await waitTitle(tab, /^search/, "back to search");
  await sleep(500);
  const info = await b.ask(ext.sessionId, "tabInfo", { tabId: await tabIdOf("http://search.test") });
  assert.equal(info.host, "search.test");
  assert.ok(!info.hosts.some((h) => h.host === "j1-cdn.test"), "site-a's address must not show on the search page");
  await invariants({ t0, tabPrefix: "http://search.test" });
  await b.evaluate(tab.sessionId, "history.forward()");
  await waitTitle(tab, /^page:/, "forward to site");
  await invariants({ t0, tabPrefix: "http://site-a.test" });
});

// 3. Pick a server in the popup for a site reached from search.
await step("picking A in the popup moves the site and only its own hidden address", async () => {
  const t0 = Date.now();
  const t = await b.openPage("http://search.test/?to=" + encodeURIComponent("http://site-d.test/?cdn=d-cdn.test"));
  await waitTitle(t, /^search/, "search page");
  await b.evaluate(t.sessionId, "document.getElementById('result').click()");
  assert.equal(await waitTitle(t, /^page:/, "site-d"), "page:B cdn:B");
  const tabId = await tabIdOf("http://site-d.test");
  const pop = await b.openPage(`chrome-extension://${EXT_ID}/popup/popup.html?tab=${tabId}`);
  await until(() => b.evaluate(pop.sessionId, "document.querySelectorAll('.route').length > 2"), "popup routes");
  await b.evaluate(
    pop.sessionId,
    `[...document.querySelectorAll('.route')].find(x => x.querySelector('.name').firstChild.textContent === 'A').click()`
  );
  await until(async () => (await title(t)) === "page:A cdn:A", "site-d reloaded through A", 15000);
  await b.close(pop);
  await sleep(2000);
  const learned = await storage("learned");
  const rule = (await storage("rules")).find((r) => r.pattern === "site-d.test");
  assert.ok(rule, "rule created");
  assert.equal(learned["d-cdn.test"], rule.id);
  for (const h of ["search.test", "search-assets.test", "j1-cdn.test"]) assert.notEqual(learned[h], rule.id, `${h} must not be tagged to site-d`);
  await invariants({ t0, tabPrefix: "http://site-d.test" });
  await b.close(t);
});

// 4. An embedded player from another company follows the page it's on.
await step("an embedded player and its own CDN follow the site", async () => {
  const t0 = Date.now();
  const t = await b.openPage("http://site-a.test/?cdn=j4-cdn.test&frame=widget.test");
  await waitTitle(t, /^page:/, "page");
  const widget = await until(() => b.evaluate(t.sessionId, "document.body.dataset.widget"), "widget");
  assert.equal(widget, "widget-cdn:A");
  const d = await invariants({ t0, tabPrefix: "http://site-a.test/?cdn=j4" });
  assert.equal(d.get("widget.test")?.route, "srvA");
  await b.close(t);
});

// 5. Something the page loads later (after you click play) also follows.
await step("an address the page loads later (like a video starting) follows the site", async () => {
  const t0 = Date.now();
  const t = await b.openPage("http://site-a.test/?cdn=j5-cdn.test");
  await waitTitle(t, /^page:/, "page");
  assert.equal(await b.evaluate(t.sessionId, "later('video-later.test')"), "A");
  await invariants({ t0, tabPrefix: "http://site-a.test/?cdn=j5" });
  await b.close(t);
});

// 6. Two sites on different servers both use one hidden address.
await step("two sites sharing a hidden address: the first keeps it, and the popup says so", async () => {
  await b.evaluate(
    ext.sessionId,
    `chrome.storage.local.get('rules').then(({rules}) => chrome.storage.local.set({ rules: [...rules, { id: 'rE', pattern: 'site-e.test', exact: false, route: 'srvB', autoFollow: true }] }))`
  );
  await sleep(800);
  const t0 = Date.now();
  const t1 = await b.openPage("http://site-a.test/?cdn=both-cdn.test");
  assert.equal(await waitTitle(t1, /^page:/, "site-a"), "page:A cdn:A");
  const t2 = await b.openPage("http://site-e.test/?cdn=both-cdn.test");
  assert.equal(await waitTitle(t2, /^page:/, "site-e"), "page:B cdn:A", "site-e's copy of the shared address stays with site-a");
  await invariants({ t0, tabPrefix: "http://site-e.test" });
  // site-a must not have lost its connection to the shared address.
  assert.equal(await b.evaluate(t1.sessionId, "later('both-cdn.test')"), "A");
  await b.close(t1);
  await b.close(t2);
});

// 7. Chrome's own pages.
await step("new tab page and Chrome pages: nothing blocked, popup handles them", async () => {
  const t0 = Date.now();
  const t = await b.openPage("chrome://newtab/");
  await sleep(2500);
  await invariants({ t0 });
  const tabId = await b.evaluate(ext.sessionId, `chrome.tabs.query({}).then(ts => ts.find(t => (t.url || '').startsWith('chrome://new'))?.id)`);
  const info = await b.ask(ext.sessionId, "tabInfo", { tabId });
  assert.equal(info.host, "");
  await b.close(t);
});

// 8. Typing a hidden address directly.
await step("opening a detected address yourself: popup tells the truth about where it goes", async () => {
  const t0 = Date.now();
  const t = await b.openPage("http://j1-cdn.test/plain");
  await until(async () => (await b.evaluate(t.sessionId, "document.body?.innerText ?? ''")).startsWith("via"), "page");
  await invariants({ t0, tabPrefix: "http://j1-cdn.test" });
  await b.close(t);
});

finish();
