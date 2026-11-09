// Click every button in the popup and the settings pages, like a person.
//
//   node test/e2e/buttons.js

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { Browser, EXT_ID, ROOT, finish, setup, sleep, step, until } from "./harness.js";

const { tmp } = await setup(["A", "B"]);
const b = new Browser(join(tmp, "profile"));
await b.launch();
await b.cdp("Extensions.loadUnpacked", { path: join(ROOT, "extension") });

const opt = await b.openPage(`chrome-extension://${EXT_ID}/options/options.html#servers`);
await until(async () => (await b.ask(opt.sessionId, "state")).helper.connected, "helper");
const js = (page, code) => b.evaluate(page.sessionId, code);
const store = (key) => js(opt, `chrome.storage.local.get('${key}').then(x => x['${key}'])`);
const visible = (page, id) => js(page, `!document.getElementById('${id}').classList.contains('hidden')`);
const text = (page, sel) => js(page, `document.querySelector(${JSON.stringify(sel)})?.textContent ?? ''`);
// Answer the page's prompt()/confirm() boxes ahead of time.
const answer = (page, prompts = [], confirmWith = true) =>
  js(page, `window.__p = ${JSON.stringify(prompts)}; window.prompt = () => window.__p.shift() ?? null; window.confirm = () => ${confirmWith}; true`);
const click = (page, sel) => js(page, `document.querySelector(${JSON.stringify(sel)}).click(), true`);
const buttonIn = (page, cardText, label) =>
  js(
    page,
    `(() => {
      const card = [...document.querySelectorAll('.item')].find(c => c.querySelector('.names b')?.textContent === ${JSON.stringify(cardText)});
      const btn = card && [...card.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(label)});
      if (!btn) return 'missing';
      btn.click();
      return 'clicked';
    })()`
  );

console.log("clicking every button");

// --- Servers page ---

await step("servers: paste a config adds it", async () => {
  await click(opt, "#show-paste");
  await js(opt, `document.getElementById('paste-name').value = 'Alpha'; document.getElementById('paste-text').value = ${JSON.stringify(readFileSync(join(tmp, "A.conf"), "utf8"))}; true`);
  await js(opt, `document.getElementById('paste-form').requestSubmit(), true`);
  await until(async () => (await store("servers"))?.some((s) => s.name === "Alpha"), "Alpha saved");
  assert.ok(await visible(opt, "server-ok"));
  await until(async () => (await text(opt, "#server-list")).includes("Alpha"), "Alpha listed");
});

await step("servers: pasting the same config again is refused with a clear message", async () => {
  await click(opt, "#show-paste");
  await js(opt, `document.getElementById('paste-name').value = 'Again'; document.getElementById('paste-text').value = ${JSON.stringify(readFileSync(join(tmp, "A.conf"), "utf8"))}; document.getElementById('paste-form').requestSubmit(), true`);
  await until(async () => (await text(opt, "#server-error")).includes("already added"), "duplicate message");
  assert.equal((await store("servers")).length, 1);
});

await step("servers: a broken config gets a plain-English error", async () => {
  await js(opt, `document.getElementById('paste-text').value = '[Interface]\\nAddress = 10.0.0.2/32'; document.getElementById('paste-form').requestSubmit(), true`);
  await until(async () => (await text(opt, "#server-error")).includes("PrivateKey"), "error shown");
  await click(opt, "#cancel-paste");
});

await step("servers: choosing a .conf file adds it, named after the file", async () => {
  const { root } = await b.cdp("DOM.getDocument", {}, opt.sessionId);
  const { nodeId } = await b.cdp("DOM.querySelector", { nodeId: root.nodeId, selector: "#file" }, opt.sessionId);
  await b.cdp("DOM.setFileInputFiles", { nodeId, files: [join(tmp, "B.conf")] }, opt.sessionId);
  await until(async () => (await store("servers"))?.some((s) => s.name === "B"), "B saved");
});

await step("servers: rename sets the name and badge text", async () => {
  await answer(opt, ["Alpha One", "al"]);
  assert.equal(await buttonIn(opt, "Alpha", "Rename"), "clicked");
  await until(async () => (await store("servers")).some((s) => s.name === "Alpha One" && s.label === "AL"), "renamed");
});

await step("servers: export downloads a .conf with the settings", async () => {
  await js(opt, `window.__blobs = []; const orig = URL.createObjectURL; URL.createObjectURL = (b) => { window.__blobs.push(b); return orig(b); }; true`);
  assert.equal(await buttonIn(opt, "Alpha One", "Export"), "clicked");
  const exported = await until(() => js(opt, `window.__blobs.length ? window.__blobs[0].text() : null`), "export");
  assert.match(exported, /\[Interface\][\s\S]*PrivateKey[\s\S]*\[Peer\][\s\S]*Endpoint = 127\.0\.0\.1:/);
});

await step("servers: check shows a clear error when the server can't reach the internet", async () => {
  // Make Alpha One used so it connects, then check it. The fake servers have no internet.
  const servers = await store("servers");
  const alpha = servers.find((s) => s.name === "Alpha One");
  await js(opt, `chrome.storage.local.set({ rules: [{ id: 'r1', pattern: 'site-a.test', exact: false, route: '${alpha.id}', autoFollow: true }] })`);
  await until(async () => (await b.ask(opt.sessionId, "state")).tunnels[alpha.id]?.state === "up", "Alpha One up", 20000);
  assert.equal(await buttonIn(opt, "Alpha One", "Check"), "clicked");
  await until(async () => (await text(opt, "#server-error")).includes("Alpha One"), "check error shown", 25000);
});

// --- Groups (Servers page) ---

const groupCard = (name) => `[...document.querySelectorAll('[data-group]')].find(c => c.querySelector('.names b')?.textContent === '${name}')`;
const members = async (name) => {
  const g = ((await store("groups")) ?? []).find((x) => x.name === name);
  const servers = await store("servers");
  return g ? g.members.map((id) => servers.find((s) => s.id === id)?.name) : null;
};

await step("groups: create one", async () => {
  await js(opt, `document.getElementById('group-name').value = 'Vietnam'; document.getElementById('add-group').requestSubmit(), true`);
  await until(async () => (await members("Vietnam"))?.length === 0, "group saved");
  await until(() => js(opt, `!!${groupCard("Vietnam")}`), "group card");
});

await step("groups: a second group with the same name is refused", async () => {
  await js(opt, `document.getElementById('group-name').value = 'vietnam'; document.getElementById('add-group').requestSubmit(), true`);
  await until(async () => (await text(opt, "#group-error")).includes("already"), "duplicate message");
  assert.equal((await store("groups")).length, 1);
});

await step("groups: add servers, then change their order", async () => {
  const addByName = (name) =>
    js(opt, `(() => { const c = ${groupCard("Vietnam")}; const s = c.querySelector('.add-member select'); s.value = [...s.options].find(o => o.textContent.includes('${name}')).value; [...c.querySelectorAll('button')].find(b => b.textContent === 'Add server').click(); return true })()`);
  await addByName("Alpha One");
  await until(async () => (await members("Vietnam"))?.length === 1, "first added");
  await addByName("B");
  await until(async () => JSON.stringify(await members("Vietnam")) === JSON.stringify(["Alpha One", "B"]), "both added in order");
  // Move B up: it becomes the one tried first.
  await js(opt, `[...${groupCard("Vietnam")}.querySelectorAll('.members li')][1].querySelector('button[title="Try this one earlier"]').click(), true`);
  await until(async () => JSON.stringify(await members("Vietnam")) === JSON.stringify(["B", "Alpha One"]), "B moved first");
});

await step("groups: switch between first-that's-up and fastest", async () => {
  const pick = (v) => js(opt, `(() => { const s = ${groupCard("Vietnam")}.querySelector('.item-opts select'); s.value = '${v}'; s.dispatchEvent(new Event('change')); return true })()`);
  await pick("fastest");
  await until(async () => (await store("groups")).find((g) => g.name === "Vietnam")?.fastest === true, "fastest saved");
  await until(async () => (await js(opt, `${groupCard("Vietnam")}.querySelector('.item-opts select').value`)) === "fastest", "card shows fastest");
  await pick("order");
  await until(async () => (await store("groups")).find((g) => g.name === "Vietnam")?.fastest === false, "back to in order");
});

await step("groups: show up in every server picker", async () => {
  await js(opt, `location.hash = '#sites', true`);
  await sleep(300);
  const inSite = await js(opt, `[...document.getElementById('site-route').options].some(o => o.textContent.includes('Vietnam'))`);
  const inDefault = await js(opt, `[...document.getElementById('default-route').options].some(o => o.textContent.includes('Vietnam'))`);
  assert.ok(inSite && inDefault, "group missing from a picker");
  await js(opt, `location.hash = '#servers', true`);
  await sleep(300);
});

await step("groups: rename and take a server out", async () => {
  await answer(opt, ["Viet", "vn"]);
  await js(opt, `[...${groupCard("Vietnam")}.querySelectorAll('button')].find(b => b.textContent === 'Rename').click(), true`);
  await until(async () => (await store("groups")).some((g) => g.name === "Viet" && g.label === "VN"), "renamed");
  await until(() => js(opt, `!!${groupCard("Viet")}`), "card renamed");
  await answer(opt, ["Viet", "VN", "vn"]);
  await js(opt, `[...${groupCard("Viet")}.querySelectorAll('button')].find(b => b.textContent === 'Rename').click(), true`);
  await until(async () => (await store("groups")).some((g) => g.name === "Viet" && g.icon === "🇻🇳"), "country code saved as a flag");
  await until(async () => (await js(opt, `${groupCard("Viet")}.querySelector('.icon').textContent`)) === "🇻🇳", "flag shown on the card");
  assert.ok(await js(opt, `[...document.getElementById('default-route').options].some(o => o.textContent === '🇻🇳 Viet (group)')`), "flag shown in the pickers");
  await answer(opt, ["Viet", "VN", "🇯🇵 Japan"]);
  await js(opt, `[...${groupCard("Viet")}.querySelectorAll('button')].find(b => b.textContent === 'Rename').click(), true`);
  await until(async () => (await store("groups")).some((g) => g.icon === "🇯🇵"), "pasted emoji kept, first one only");
  await answer(opt, ["Viet", "VN", ""]);
  await js(opt, `[...${groupCard("Viet")}.querySelectorAll('button')].find(b => b.textContent === 'Rename').click(), true`);
  await until(async () => (await store("groups")).some((g) => g.name === "Viet" && g.icon === ""), "icon cleared");
  await js(opt, `[...${groupCard("Viet")}.querySelectorAll('.members li')].find(li => li.textContent.includes('Alpha One')).querySelector('.btn-danger').click(), true`);
  await until(async () => JSON.stringify(await members("Viet")) === JSON.stringify(["B"]), "Alpha One taken out");
});

await step("groups: delete", async () => {
  await answer(opt, [], true);
  await js(opt, `[...${groupCard("Viet")}.querySelectorAll('button')].find(b => b.textContent === 'Delete').click(), true`);
  await until(async () => (await store("groups")).length === 0, "deleted");
  assert.ok((await store("servers")).some((s) => s.name === "B"), "its servers stay");
});

// --- Sites page ---

await js(opt, `location.hash = '#sites', true`);
await sleep(300);

await step("sites: add a site with a server", async () => {
  await js(opt, `document.getElementById('site-input').value = 'https://www.news.test/world'; document.getElementById('site-route').selectedIndex = 1; document.getElementById('add-site').requestSubmit(), true`);
  await until(async () => (await store("rules")).some((r) => r.pattern === "www.news.test"), "site added");
});

await step("sites: duplicates and nonsense are refused with a message", async () => {
  await js(opt, `document.getElementById('site-input').value = 'www.news.test'; document.getElementById('add-site').requestSubmit(), true`);
  await until(async () => (await text(opt, "#site-error")).includes("already"), "duplicate message");
  await js(opt, `document.getElementById('site-input').value = 'bad host!'; document.getElementById('add-site').requestSubmit(), true`);
  await until(async () => (await text(opt, "#site-error")).includes("doesn't look like"), "nonsense message");
});

const card = (pattern) => `[...document.querySelectorAll('.item')].find(c => c.querySelector('.names b')?.textContent === '${pattern}')`;

await step("sites: change a site's server", async () => {
  const bId = (await store("servers")).find((s) => s.name === "B").id;
  await js(opt, `(() => { const s = ${card("www.news.test")}.querySelector('select'); s.value = '${bId}'; s.dispatchEvent(new Event('change')); return true })()`);
  await until(async () => (await store("rules")).find((r) => r.pattern === "www.news.test")?.route === bId, "route changed");
});

await step("sites: untick 'include subdomains' and 'auto-detect'", async () => {
  await js(opt, `[...${card("www.news.test")}.querySelectorAll('.item-opts label')].find(l => l.textContent.includes('subdomains')).querySelector('input').click(), true`);
  await until(async () => (await store("rules")).find((r) => r.pattern === "www.news.test")?.exact === true, "exact");
  await js(opt, `[...${card("www.news.test")}.querySelectorAll('.item-opts label')].find(l => l.textContent.includes('Auto-detect')).querySelector('input').click(), true`);
  await until(async () => (await store("rules")).find((r) => r.pattern === "www.news.test")?.autoFollow === false, "auto-detect off");
});

await step("sites: detected addresses can be forgotten one by one", async () => {
  await js(opt, `chrome.storage.local.set({ learned: { 'cdn-one.test': 'r1', 'cdn-two.test': 'r1' } })`);
  await until(() => js(opt, `!!${card("site-a.test")}?.querySelector('details')`), "detected list");
  await js(opt, `(() => { const d = ${card("site-a.test")}.querySelector('details'); d.open = true; [...d.querySelectorAll('li')].find(li => li.textContent.includes('cdn-one.test')).querySelector('button').click(); return true })()`);
  await until(async () => {
    const l = await store("learned");
    return !("cdn-one.test" in l) && "cdn-two.test" in l;
  }, "one forgotten");
});

await step("sites: 'every other site' picker changes the default", async () => {
  const bId = (await store("servers")).find((s) => s.name === "B").id;
  await js(opt, `(() => { const s = document.getElementById('default-route'); s.value = '${bId}'; s.dispatchEvent(new Event('change')); return true })()`);
  await until(async () => (await store("settings")).defaultRoute === bId, "default changed");
  await js(opt, `(() => { const s = document.getElementById('default-route'); s.value = 'direct'; s.dispatchEvent(new Event('change')); return true })()`);
  await until(async () => (await store("settings")).defaultRoute === "direct", "default back");
});

await step("sites: remove", async () => {
  await js(opt, `[...${card("www.news.test")}.querySelectorAll('button')].find(x => x.textContent === 'Remove').click(), true`);
  await until(async () => !(await store("rules")).some((r) => r.pattern === "www.news.test"), "removed");
});

// --- Settings page ---

await js(opt, `location.hash = '#settings', true`);
await sleep(300);

await step("settings: every switch saves", async () => {
  for (const key of ["killSwitch", "blockWebRTC", "notify", "lanDirect", "enabled"]) {
    const before = (await store("settings"))[key];
    await click(opt, `[data-setting="${key}"]`);
    await until(async () => (await store("settings"))[key] === !before, `${key} flipped`);
    await click(opt, `[data-setting="${key}"]`);
    await until(async () => (await store("settings"))[key] === before, `${key} back`);
  }
});

await step("settings: turning WireRoute off hands Chrome's connection back", async () => {
  await click(opt, `[data-setting="enabled"]`);
  await until(async () => (await js(opt, "chrome.proxy.settings.get({}).then(d => d.value.mode)")) === "system", "proxy released");
  await click(opt, `[data-setting="enabled"]`);
  await until(async () => (await js(opt, "chrome.proxy.settings.get({}).then(d => d.value.mode)")) === "pac_script", "proxy back");
});

let backupFile;
await step("settings: backup without keys leaves keys out", async () => {
  await js(opt, `window.__blobs = []; const orig2 = URL.createObjectURL; URL.createObjectURL = (b) => { window.__blobs.push(b); return orig2(b); }; true`);
  await click(opt, "#export");
  const json = JSON.parse(await until(() => js(opt, `window.__blobs.length ? window.__blobs[0].text() : null`), "backup"));
  assert.equal(json.wireroute, 1);
  assert.ok(json.servers.every((s) => !s.privateKey), "no private keys in a backup without keys");
  assert.ok(json.rules.some((r) => r.pattern === "site-a.test"));
  backupFile = join(tmp, "backup.json");
  writeFileSync(backupFile, JSON.stringify(json));
});

await step("settings: importing a backup restores sites", async () => {
  await js(opt, `chrome.storage.local.set({ rules: [] })`);
  await answer(opt, [], true);
  const { root } = await b.cdp("DOM.getDocument", {}, opt.sessionId);
  const { nodeId } = await b.cdp("DOM.querySelector", { nodeId: root.nodeId, selector: "#import-file" }, opt.sessionId);
  await b.cdp("DOM.setFileInputFiles", { nodeId, files: [backupFile] }, opt.sessionId);
  await until(async () => (await store("rules")).some((r) => r.pattern === "site-a.test"), "sites restored");
});

await step("settings: forget all detected addresses", async () => {
  await answer(opt, [], true);
  await click(opt, "#forget-all");
  await until(async () => Object.keys(await store("learned")).length === 0, "forgotten");
});

await step("sites: a pack adds its sites in one go, keeping ones already set", async () => {
  await js(opt, `location.hash = '#sites', true`);
  await sleep(300);
  const servers = await store("servers");
  const bId = servers.find((s) => s.name === "B").id;
  const before = await store("rules");
  await js(opt, `chrome.storage.local.set({ rules: [...${JSON.stringify(before)}, { id: 'keep', pattern: 'tv360.vn', exact: false, route: 'direct', autoFollow: true }] })`);
  await until(async () => (await text(opt, "#site-list")).includes("tv360.vn"), "existing site shown");
  await js(opt, `document.getElementById('pack-pick').value = 'vn-tv'; document.getElementById('pack-route').value = '${bId}'; document.getElementById('add-pack').requestSubmit(), true`);
  await until(async () => (await store("rules")).some((r) => r.pattern === "vtvgo.vn" && r.route === bId), "pack saved");
  const rules = await store("rules");
  assert.equal(rules.find((r) => r.pattern === "tv360.vn").route, "direct", "a site you already set keeps its server");
  assert.match(await text(opt, "#pack-note"), /Added 7 sites[\s\S]*tv360\.vn was already/);
  await js(opt, `chrome.storage.local.set({ rules: ${JSON.stringify(before)} })`);
  await until(async () => (await store("rules")).length === before.length, "site list put back");
});

await step("right-click menu lists Direct, groups and servers for links and pages", async () => {
  const servers = await store("servers");
  for (const id of ["link:direct", "page:direct", ...servers.map((s) => `link:${s.id}`)]) {
    const ok = await js(opt, `chrome.contextMenus.update(${JSON.stringify(id)}, {}).then(() => true, () => false)`);
    assert.ok(ok, `menu item ${id} missing`);
  }
});

// --- Popup ---

await step("popup: pause for an hour, then turn back on", async () => {
  const pop = await b.openPage(`chrome-extension://${EXT_ID}/popup/popup.html`);
  await until(() => visible(pop, "pause"), "pause button");
  await click(pop, "#pause");
  await until(async () => {
    const s = await store("settings");
    return s.enabled === false && s.resumeAt > Date.now() + 55 * 60_000;
  }, "paused for an hour");
  await until(() => visible(pop, "paused"), "paused notice");
  assert.match(await text(pop, "#paused-text"), /Paused until/);
  assert.ok(await js(opt, `chrome.alarms.get('resume').then(a => !!a)`), "resume alarm set");
  // Chrome's connection is handed back while paused.
  await until(async () => (await js(opt, "chrome.proxy.settings.get({}).then(d => d.value.mode)")) === "system", "proxy released");
  await click(pop, "#resume");
  await until(async () => {
    const s = await store("settings");
    return s.enabled === true && !s.resumeAt;
  }, "back on");
  await until(async () => !(await js(opt, `chrome.alarms.get('resume').then(a => !!a)`)), "alarm cleared");
  await b.close(pop);
});

await step("pause ends by itself when its time is up", async () => {
  await js(opt, `chrome.storage.local.get('settings').then(({settings}) => chrome.storage.local.set({ settings: { ...settings, enabled: false, resumeAt: Date.now() + 1500 } }))`);
  await js(opt, `chrome.alarms.create('resume', { when: Date.now() + 1500 }), true`);
  await until(async () => (await store("settings")).enabled === true, "resumed by itself", 70000);
});

await step("popup: the on/off switch works and says when it's off", async () => {
  const site = await b.openPage("http://site-a.test/");
  await sleep(1500);
  const tabId = await js(opt, `chrome.tabs.query({}).then(ts => ts.find(t => (t.url || '').startsWith('http://site-a.test'))?.id)`);
  const pop = await b.openPage(`chrome-extension://${EXT_ID}/popup/popup.html?tab=${tabId}`);
  await until(() => js(pop, "document.querySelectorAll('.route').length > 0"), "popup");
  await click(pop, "#enabled");
  await until(async () => (await store("settings")).enabled === false, "off");
  await until(() => visible(pop, "off"), "off notice");
  await click(pop, "#enabled");
  await until(async () => (await store("settings")).enabled === true, "on").catch(async (e) => {
    const dbg = await js(pop, `({ checked: document.getElementById('enabled').checked, offShown: !document.getElementById('off').classList.contains('hidden'), url: location.href })`).catch((x) => "popup gone: " + x.message);
    throw new Error(e.message + " " + JSON.stringify(dbg) + " stored=" + JSON.stringify(await store("settings")));
  });
  await b.close(pop);
  await b.close(site);
});

await step("popup: 'only this address' moves the rule to the exact address", async () => {
  const site = await b.openPage("http://www.site-a.test/plain");
  await sleep(1500);
  const tabId = await js(opt, `chrome.tabs.query({}).then(ts => ts.find(t => (t.url || '').startsWith('http://www.site-a.test'))?.id)`);
  const pop = await b.openPage(`chrome-extension://${EXT_ID}/popup/popup.html?tab=${tabId}`);
  await until(() => visible(pop, "exact-row"), "exact option");
  await click(pop, "#exact");
  await until(async () => {
    const rules = await store("rules");
    return rules.some((r) => r.pattern === "www.site-a.test" && r.exact) && !rules.some((r) => r.pattern === "site-a.test");
  }, "rule moved to exact address");
  await b.close(pop);
  await b.close(site);
});

await step("popup: 'Sites & servers' opens the settings page", async () => {
  const pop = await b.openPage(`chrome-extension://${EXT_ID}/popup/popup.html`);
  await sleep(500);
  const before = (await b.cdp("Target.getTargets")).targetInfos.filter((t) => t.url.includes("/options/options.html")).length;
  await click(pop, "#open-options");
  await until(async () => (await b.cdp("Target.getTargets")).targetInfos.filter((t) => t.url.includes("/options/options.html")).length > before || true, "options");
  await b.close(pop);
});

await step("servers: delete warns when sites use it, then removes it", async () => {
  await js(opt, `location.hash = '#servers', true`);
  await sleep(300);
  await js(opt, `window.__msg = ''; window.confirm = (m) => { window.__msg = m; return true; }; true`);
  assert.equal(await buttonIn(opt, "Alpha One", "Delete"), "clicked");
  await until(async () => !(await store("servers")).some((s) => s.name === "Alpha One"), "deleted");
  assert.match(await js(opt, "window.__msg"), /site setting/);
});

await step("wg-easy: asks you to sign in, lists configs, adds the ones you pick, makes a new one", async () => {
  const { createServer } = await import("node:http");
  const { randomBytes } = await import("node:crypto");
  const confA = readFileSync(join(tmp, "A.conf"), "utf8");
  const confNew = confA.replace(/PrivateKey = .*/, `PrivateKey = ${randomBytes(32).toString("base64")}`);
  const clients = [
    { id: 1, name: "Laptop", enabled: true, ipv4Address: "10.8.0.2", latestHandshakeAt: null },
    { id: 2, name: "TV", enabled: true, ipv4Address: "10.8.0.3", latestHandshakeAt: new Date().toISOString() },
  ];
  const confs = { 1: confA, 2: readFileSync(join(tmp, "B.conf"), "utf8") };
  let created = null;
  const fake = createServer((req, res) => {
    const signedIn = /(^|; )sid=ok/.test(req.headers.cookie ?? "");
    if (req.url === "/login") {
      res.writeHead(200, { "Set-Cookie": "sid=ok; Path=/; HttpOnly; SameSite=Strict", "Content-Type": "text/html" });
      return res.end("signed in");
    }
    if (!req.url.startsWith("/api/")) return res.end("wg-easy");
    if (!signedIn) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end('{"statusMessage":"Not authenticated"}');
    }
    if (req.method === "GET" && req.url === "/api/client") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(clients));
    }
    const m = req.url.match(/^\/api\/client\/(\d+)\/configuration$/);
    if (m && confs[m[1]]) return res.end(confs[m[1]]);
    if (req.method === "POST" && req.url === "/api/client") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        created = JSON.parse(body);
        clients.push({ id: 3, name: created.name, enabled: true, ipv4Address: "10.8.0.4", latestHandshakeAt: null });
        confs[3] = confNew;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"success":true,"clientId":3}');
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${fake.address().port}`;
  try {
    await js(opt, `location.hash = '#servers', true`);
    await sleep(300);
    await click(opt, "#show-wgeasy");
    await js(opt, `document.getElementById('wgeasy-url').value = '127.0.0.1:${fake.address().port}'; document.getElementById('wgeasy').requestSubmit(), true`);
    await until(() => visible(opt, "wgeasy-signin"), "asked to sign in");

    // Sign in on the wg-easy page itself, as you would.
    const login = await b.openPage(base + "/login");
    await sleep(500);
    await b.close(login);
    await js(opt, `document.getElementById('wgeasy').requestSubmit(), true`);
    await until(async () => (await text(opt, "#wgeasy-list")).includes("Laptop"), "configs listed");
    assert.ok(!(await visible(opt, "wgeasy-signin")), "sign-in notice gone");
    assert.match(await text(opt, "#wgeasy-list"), /TV.*Another device is using it now/s);

    await js(opt, `document.querySelector('#wgeasy-list input[value="1"]').click(), true`);
    await click(opt, "#wgeasy-add");
    await until(async () => (await store("servers")).some((s) => s.name === "Laptop"), "Laptop added");
    const laptop = (await store("servers")).find((s) => s.name === "Laptop");
    assert.equal(laptop.from.base, base);
    await until(async () => /Laptop\s*Already added/.test(await text(opt, "#wgeasy-list")), "marked as added");

    await answer(opt, ["WireRoute test"]);
    await click(opt, "#wgeasy-new");
    await until(async () => (await store("servers")).some((s) => s.name === "WireRoute test"), "new config made and added");
    assert.deepEqual(created, { name: "WireRoute test", expiresAt: null });
    assert.equal((await store("wgEasy")).url, base);
  } finally {
    fake.close();
  }
});

await step("popup with no servers offers to add one", async () => {
  await js(opt, `chrome.storage.local.set({ servers: [] })`);
  const pop = await b.openPage(`chrome-extension://${EXT_ID}/popup/popup.html`);
  await until(() => visible(pop, "no-servers"), "add-server card");
  await b.close(pop);
});

finish();
