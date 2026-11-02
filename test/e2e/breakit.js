// Break things on purpose and make sure nothing leaks.
//
//   node test/e2e/breakit.js
//
// example.com is set to go through fake server A, which answers
// "via A for example.com". The real site talks about documentation examples.
// If the real text ever shows while example.com should use A, your real
// connection leaked.

import { join } from "node:path";
import assert from "node:assert/strict";
import { Browser, EXT_ID, ROOT, WINDOWS, fakePid, finish, helperPids, setup, sleep, step, until } from "./harness.js";

const { tmp, confs } = await setup(["A", "B"]);
const b = new Browser(join(tmp, "profile"));
await b.launch();
await b.cdp("Extensions.loadUnpacked", { path: join(ROOT, "extension") });
let ext = await b.openPage(`chrome-extension://${EXT_ID}/options/options.html`);
await until(async () => (await b.ask(ext.sessionId, "state")).helper.connected, "helper");

const A = { id: "srvA", name: "A", label: "", ...confs.A };
const B = { id: "srvB", name: "B", label: "", ...confs.B };
const setStore = (obj) => b.evaluate(ext.sessionId, `chrome.storage.local.set(${JSON.stringify(obj)})`);
const patchSettings = (patch) =>
  b.evaluate(ext.sessionId, `chrome.storage.local.get('settings').then(({settings}) => chrome.storage.local.set({ settings: { ...settings, ...${JSON.stringify(patch)} } }))`);
await setStore({
  servers: [A],
  rules: [
    { id: "rEx", pattern: "example.com", exact: false, route: "srvA", autoFollow: true },
    // Only ever visited through A, for the restart check.
    { id: "rNet", pattern: "example.net", exact: false, route: "srvA", autoFollow: true },
  ],
  learned: {},
  settings: { enabled: true, defaultRoute: "direct", killSwitch: true, blockWebRTC: true, lanDirect: true },
});
const state = () => b.ask(ext.sessionId, "state");
await until(async () => (await state()).tunnels.srvA?.state === "up", "server A up", 20000);

/** Open url, return what it shows: "via A", "real", "blocked" or "error". */
async function show(url, wait = 8000) {
  // A unique address every time, so Chrome can't answer from its saved copy.
  const p = await b.openPage(url + (url.includes("?") ? "&" : "?") + "n=" + Date.now());
  let seen = "";
  try {
    return await until(
      async () => {
        const [href, text] = await b.evaluate(p.sessionId, "[location.href, document.body?.innerText ?? '']");
        seen = href + " | " + text.slice(0, 120).replace(/\s+/g, " ");
        if (href.startsWith(`chrome-extension://${EXT_ID}/blocked/`)) return "blocked";
        // The real example.com (its wording changes now and then).
        if (/Example Domain|documentation examples/i.test(text)) return "real";
        const via = text.match(/^via ([A-Z])\b/);
        if (via) return "via " + via[1];
        if (href.startsWith("chrome-error://")) {
          const code = await b.evaluate(p.sessionId, "document.querySelector('.error-code')?.textContent || (loadTimeData?.data_?.errorCode ?? '')").catch(() => "");
          return "error: " + code + " " + text.replace(/\s+/g, " ").slice(0, 160);
        }
        return null;
      },
      url,
      wait
    ).catch(() => "nothing: " + seen);
  } finally {
    await b.close(p);
  }
}

const testHelperPid = () => helperPids(b.proc.pid)[0] ?? 0;

console.log("breaking things on purpose");

await step("baseline: example.com goes through A (and its name was looked up inside the tunnel)", async () => {
  assert.equal(await show("http://example.com/"), "via A");
});

await step("helper crashes: example.com never loads the real site, then recovers by itself", async () => {
  const pid = testHelperPid();
  assert.ok(pid, "test helper found");
  process.kill(pid, "SIGKILL");
  for (const url of ["http://example.com/", "https://example.com/"]) {
    const during = await show(url, 4000);
    assert.ok(!during.startsWith("real"), `${url} loaded the real site while the helper was down: leak`);
  }
  await until(async () => (await state()).helper.connected && (await state()).tunnels.srvA?.state === "up", "helper back", 30000);
  assert.ok(testHelperPid() && testHelperPid() !== pid, "a new helper started");
  assert.equal(await show("http://example.com/"), "via A");
});

await step("server goes down: example.com is blocked, never sent the normal way", async () => {
  await setStore({ servers: [{ ...A, endpoint: "127.0.0.1:9" }] });
  await until(async () => (await state()).tunnels.srvA?.state === "down", "A marked down", 40000);
  const r = await show("http://example.com/");
  assert.equal(r, "blocked");
  const https = await show("https://example.com/");
  assert.ok(!https.startsWith("real"), "https version leaked: " + https);
});

await step("kill switch off: with the server down, example.com uses your normal connection", async () => {
  await patchSettings({ killSwitch: false });
  await sleep(1500);
  try {
    assert.equal(await show("https://example.com/", 15000), "real");
  } finally {
    await patchSettings({ killSwitch: true });
    await setStore({ servers: [A] });
  }
  await until(async () => (await state()).tunnels.srvA?.state === "up", "A back", 30000);
  assert.equal(await show("http://example.com/"), "via A");
});

await step("WebRTC can't reveal your real address while the leak block is on", async () => {
  const gather = async () => {
    const p = await b.openPage("about:blank");
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
    await b.close(p);
    return cands;
  };
  const blocked = await gather();
  const leaky = blocked.filter((c) => / typ srflx /.test(c) || / (\d{1,3}\.){3}\d{1,3} \d+ typ host/.test(c));
  assert.deepEqual(leaky, [], "WebRTC exposed an address: " + leaky.join(" | "));
  // Make sure the test can see a leak at all: switch the block off.
  await patchSettings({ blockWebRTC: false });
  await sleep(800);
  const open = await gather();
  assert.ok(open.some((c) => / typ srflx /.test(c)), "with the block off, WebRTC should show your public address (proves this test works)");
  await patchSettings({ blockWebRTC: true });
});

await step("group failover: when A dies, example.com keeps working through B, and the popup says so", async () => {
  await setStore({
    servers: [A, B],
    groups: [{ id: "grp", name: "Pair", label: "PR", members: ["srvA", "srvB"] }],
    rules: [
      { id: "rEx", pattern: "example.com", exact: false, route: "grp", autoFollow: true },
      { id: "rNet", pattern: "example.net", exact: false, route: "srvA", autoFollow: true },
    ],
  });
  await until(async () => {
    const t = (await state()).tunnels;
    return t.srvA?.state === "up" && t.srvB?.state === "up";
  }, "A and B up", 30000);
  assert.equal(await show("http://example.com/"), "via A");
  try {

    // A dies. The helper should notice within ~10s and move the group to B.
    const t0 = Date.now();
    await setStore({ servers: [{ ...A, endpoint: "127.0.0.1:9" }, B] });
    await until(async () => (await state()).tunnels.srvA?.state === "down", "A marked down", 40000);
    const failoverSeconds = Math.round((Date.now() - t0) / 1000);
    console.log(`       A was marked down after ${failoverSeconds}s`);
    // (Changing A's settings restarts its tunnel; a server that just goes quiet is noticed in ~10s.)
    assert.equal(await show("http://example.com/"), "via B", "site should move to B");

    const p = await b.openPage("http://example.com/?popup");
    await sleep(1000);
    const tabId = await b.evaluate(ext.sessionId, `chrome.tabs.query({}).then(ts => ts.find(t => (t.url || '').startsWith('http://example.com/?popup'))?.id)`);
    const info = await b.ask(ext.sessionId, "tabInfo", { tabId });
    assert.equal(info.route, "grp");
    assert.equal(info.via, "srvB", "popup should say the group is using B");
    assert.equal(await b.evaluate(ext.sessionId, `chrome.action.getBadgeText({ tabId: ${tabId} })`), "PR");
    if (process.env.SHOTS) {
      const { writeFileSync } = await import("node:fs");
      for (const [url, file, w, h] of [
        [`chrome-extension://${EXT_ID}/popup/popup.html?tab=${tabId}`, "popup-group.png", 360, 760],
        [`chrome-extension://${EXT_ID}/options/options.html#servers`, "groups.png", 1100, 1300],
      ]) {
        const s = await b.openPage(url);
        await b.cdp("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: false }, s.sessionId);
        await sleep(1500);
        const { data } = await b.cdp("Page.captureScreenshot", { format: "png" }, s.sessionId);
        writeFileSync(join(process.env.SHOTS, file), Buffer.from(data, "base64"));
        await b.close(s);
      }
    }
    await b.close(p);

    // B dies too: now the site is blocked, never sent the normal way.
    await setStore({ servers: [{ ...A, endpoint: "127.0.0.1:9" }, { ...B, endpoint: "127.0.0.1:9" }] });
    await until(async () => (await state()).tunnels.srvB?.state === "down", "B marked down", 40000);
    assert.equal(await show("http://example.com/"), "blocked");

  } finally {
    // Both come back.
    await setStore({ servers: [A, B] });
    await until(async () => {
      const t = (await state()).tunnels;
      return t.srvA?.state === "up" && t.srvB?.state === "up";
    }, "A and B back", 40000);
  }
  assert.equal(await show("http://example.com/"), "via A", "back on the first server");
});

await step("a server that simply goes quiet is noticed within about 10 seconds", async () => {
  if (WINDOWS) {
    // Windows can't pause a process; the failover step above and the helper
    // tests cover a server that stops answering.
    console.log("       skipped on Windows (no way to pause a process)");
    return;
  }
  // Stop answering without changing any settings: pause A's fake server.
  const before = (await state()).tunnels.srvA?.state;
  assert.equal(before, "up");
  const t0 = Date.now();
  process.kill(fakePid("A"), "SIGSTOP");
  try {
    await until(async () => (await state()).tunnels.srvA?.state === "down", "A noticed down", 30000);
    const secs = (Date.now() - t0) / 1000;
    console.log(`       noticed after ${secs.toFixed(1)}s`);
    assert.ok(secs < 20, `took ${secs}s`);
    assert.equal(await show("http://example.com/"), "via B");
  } finally {
    process.kill(fakePid("A"), "SIGCONT");
  }
});

await step("Chrome quits and starts again: everything comes back with no clicks", async () => {
  await b.quit();
  await b.launch();
  const loaded = await until(async () => {
    const { targetInfos } = await b.cdp("Target.getTargets");
    return targetInfos.some((t) => t.url.startsWith(`chrome-extension://${EXT_ID}/`));
  }, "extension running after restart", 20000).catch(() => false);
  if (!loaded) {
    // Unpacked extensions added over DevTools only last one session; a real
    // install stays. Load it again: settings must have survived.
    await b.cdp("Extensions.loadUnpacked", { path: join(ROOT, "extension") });
  }
  ext = await b.openPage(`chrome-extension://${EXT_ID}/options/options.html`);
  await sleep(500);
  await until(async () => (await state()).helper.connected && (await state()).tunnels.srvA?.state === "up", "helper and A after restart", 30000).catch(async (e) => {
    throw new Error(e.message + "\n       loaded=" + loaded + " state=" + JSON.stringify(await state()) + " settings=" + JSON.stringify(await b.evaluate(ext.sessionId, "chrome.storage.local.get(null).then(x => ({servers: (x.servers||[]).length, rules: (x.rules||[]).length, settings: x.settings}))")));
  });
  // Chrome's own request must reach the helper and go through A.
  const t0 = Date.now();
  const r = await show("http://example.net/");
  const fromChrome = (await b.ask(ext.sessionId, "recent")).filter((d) => d.host === "example.net" && d.at >= t0);
  assert.ok(fromChrome.length > 0, "Chrome's request never reached the helper");
  assert.ok(fromChrome.every((d) => d.route === "srvA"), "example.net went " + JSON.stringify(fromChrome));
  assert.ok(!r.startsWith("real"), "real site loaded after restart: leak");
  assert.equal(r, "via A");
});

finish();
