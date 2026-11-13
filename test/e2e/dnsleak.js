// DNS leak test: Chrome must never look up the name of a site that goes
// through a server. Only the helper may, inside the tunnel. Otherwise your
// internet provider sees which sites you visit.
//
//   node test/e2e/dnsleak.js
//
// Chrome writes its network log (every name it looks up itself) to a file.
// The test browses sites set to server A, including pages that ask Chrome to
// look names up early (DNS prefetch, preconnect, links, hover), then reads
// the log. A site set to Direct is visited too: Chrome must look that one up
// itself, which proves the log really shows lookups.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { Browser, EXT_ID, ROOT, finish, setup, sleep, step, until } from "./harness.js";

const { tmp, confs } = await setup(["A"]);
const netlog = join(tmp, "netlog.json");
const b = new Browser(join(tmp, "profile"), { args: [`--log-net-log=${netlog}`] });
await b.launch();
await b.cdp("Extensions.loadUnpacked", { path: join(ROOT, "extension") });
const ext = await b.openPage(`chrome-extension://${EXT_ID}/options/options.html`);
await until(async () => (await b.ask(ext.sessionId, "state")).helper.connected, "helper");

// Fresh names every run, so nothing can come from an earlier run.
const tag = Math.random().toString(36).slice(2, 8);
const routed = (n) => `${n}-${tag}.leak.test`;
const DIRECT_NAME = `direct-${tag}.directcheck.test`;

await b.evaluate(
  ext.sessionId,
  `chrome.storage.local.set(${JSON.stringify({
    servers: [{ id: "srvA", name: "A", label: "", ...confs.A }],
    rules: [
      { id: "r1", pattern: "leak.test", exact: false, route: "srvA", autoFollow: true },
      { id: "r2", pattern: "directcheck.test", exact: false, route: "direct", autoFollow: true },
    ],
    learned: {},
    settings: { enabled: true, defaultRoute: "direct", killSwitch: true, blockWebRTC: true, lanDirect: true },
  })})`
);
await until(async () => (await b.ask(ext.sessionId, "state")).tunnels.srvA?.state === "up", "server A up", 20000);

const used = []; // every routed name the test made Chrome see
const names4 = (prefix) => {
  const n = ["prefetch", "preconnect", "link", "img"].map((k) => routed(`${prefix}${k}`));
  used.push(...n);
  return n;
};

/** Open url, wait for text, hover the #link if there is one, keep the tab a moment. */
async function visit(url, want) {
  const p = await b.openPage(url);
  try {
    await until(async () => (await b.evaluate(p.sessionId, "document.body?.innerText ?? ''")).includes(want), url);
    const box = await b.evaluate(p.sessionId, "(() => { const r = document.getElementById('link')?.getBoundingClientRect(); return r ? [r.x + 5, r.y + 5] : null })()");
    if (box) {
      // Chrome warms up connections for a link the mouse rests on.
      await b.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: box[0], y: box[1] }, p.sessionId);
    }
    await sleep(3000);
  } finally {
    await b.close(p);
  }
}

console.log("checking Chrome for DNS leaks");

await step("a site on server A loads through it", async () => {
  const host = routed("page");
  used.push(host);
  await visit(`http://${host}/`, "via A");
});

await step("https: a site on server A is tried through it", async () => {
  // The fake server has no https, so this fails; what matters is that Chrome
  // still never looks the name up.
  const host = routed("secure");
  used.push(host);
  const p = await b.openPage(`https://${host}/`);
  await sleep(3000);
  await b.close(p);
});

await step("a page on server A that hints at other names on A", async () => {
  const host = routed("hints");
  used.push(host);
  await visit(`http://${host}/?names=${names4("a").join(",")}`, "a link");
});

// A page on your own network (always Direct) hinting at names that are set to A.
const lan = createServer((req, res) => {
  const names = new URL(req.url, "http://x").searchParams.get("names")?.split(",") ?? [];
  res.setHeader("Content-Type", "text/html");
  res.end(`<!doctype html><title>lan</title>
<link rel="dns-prefetch" href="//${names[0]}">
<link rel="preconnect" href="http://${names[1]}">
<a id="link" href="http://${names[2]}/" style="display:block;font-size:40px">a link</a>
<img src="http://${names[3]}/pic.png" alt="">`);
});
await new Promise((r) => lan.listen(0, "127.0.0.1", r));

await step("a Direct page that hints at names set to A", async () => {
  await visit(`http://127.0.0.1:${lan.address().port}/?names=${names4("b").join(",")}`, "a link");
});

await step("a site set to Direct (Chrome looks this one up itself)", async () => {
  const p = await b.openPage(`http://${DIRECT_NAME}/`);
  await sleep(3000); // the name doesn't exist; the lookup is what counts
  await b.close(p);
});

lan.close();
await b.quit(); // Chrome finishes the log file when it closes

/**
 * Every name Chrome sent out to be looked up, from its network log. Chrome
 * also checks its memory and the hosts file for names it never sends out
 * (HOST_RESOLVER_MANAGER_REQUEST with no job); those stay on the computer,
 * so only real lookups count: a job, a DNS query, or the system's lookup.
 */
function chromeLookups() {
  let text = readFileSync(netlog, "utf8").trim();
  // A log cut short by a crash has no ending; close it.
  if (!text.endsWith("}")) text = text.replace(/,?\s*$/, "") + "]}";
  const log = JSON.parse(text);
  const typeName = Object.fromEntries(Object.entries(log.constants.logEventTypes).map(([k, v]) => [v, k]));
  const out = [];
  for (const e of log.events) {
    const type = typeName[e.type] ?? "";
    const p = e.params ?? {};
    if (type === "HOST_RESOLVER_MANAGER_JOB" && p.host) out.push(`${type} ${p.host}`);
    if (type === "DNS_TRANSACTION" && p.hostname) out.push(`${type} ${p.hostname}`);
    if (type === "HOST_RESOLVER_DNS_TASK_EXTRACTION_RESULTS") for (const r of p.results ?? []) out.push(`${type} ${r.domain_name}`);
  }
  return out;
}

const lookups = chromeLookups();

await step("the network log shows Chrome's own lookups (the Direct site is in it)", async () => {
  assert.ok(lookups.some((l) => l.includes(DIRECT_NAME)), `${DIRECT_NAME} is not in the log, so the log shows nothing useful (${lookups.length} lookups)`);
});

await step("Chrome never sent out a lookup for a name set to server A", async () => {
  const leaks = lookups.filter((l) => used.some((n) => l.includes(n)) || l.includes(`-${tag}.leak.test`));
  assert.deepEqual(leaks, [], "DNS leak:\n" + leaks.join("\n"));
});

finish();
