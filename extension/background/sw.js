// sw.js: WireRoute's background worker.
//
// Jobs:
//  1. Start the helper and keep it in sync with servers, site rules and settings.
//  2. Watch every request and tell the helper which site asked for which
//     address ("hints"), so hidden addresses follow their site automatically.
//  3. Point Chrome at the helper (PAC), block WebRTC leaks, show a "VPN down" page instead of leaking, keep badges current.

import * as native from "../lib/native.js";
import * as store from "../lib/store.js";
import { buildPac } from "../lib/pac.js";
import { hostOf, isShared, matchRule, normHost, siteOf } from "../lib/hosts.js";

const HOLD_MS = 1000;
const HINT_REFRESH_MS = 60_000;
const MAX_LEARNED = 20_000;
const MAX_TAB_HOSTS = 400;

let cfg = null; // {servers, rules, learned, settings}
let secret = null;
let helper = { connected: false, version: "", port: 0 };
let tunnels = {}; // serverId -> {state, error, lastHandshake, rxBytes, txBytes}
let pacNonce = Date.now();
const tabSite = new Map(); // tabId -> host of the page in that tab
const tabHosts = new Map(); // tabId -> {site, hosts: Set} of the page now in the tab
const hintSent = new Map(); // host -> {rule, at}

// --- startup ---

const ready = init();

async function init() {
  cfg = await store.load(["servers", "rules", "learned", "settings"]);
  secret = await store.getSecret();
  await seedTabs();
  await applyProxy();
  await applyWebRTC();
  await updateBlockRules();
  await connectHelper();
}

chrome.runtime.onStartup.addListener(() => ready);
chrome.runtime.onInstalled.addListener(async ({ reason, previousVersion }) => {
  await ready;
  chrome.alarms.create("keepalive", { periodInMinutes: 1 });
  if (reason === "install") chrome.runtime.openOptionsPage();
  if (reason === "update" && previousVersion === "1.0.0") {
    // 1.0.0 could tag addresses from a tab's earlier pages (and Google) as a
    // site's hidden addresses. Start clean; real ones are re-detected.
    cfg.learned = {};
    await store.save({ learned: {} });
    await applyAll();
  }
});
chrome.alarms.onAlarm.addListener(async () => {
  await ready;
  if (!native.isConnected()) await connectHelper();
  else refreshStatus();
});

async function seedTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      const h = hostOf(t.url ?? "");
      if (h) tabSite.set(t.id, h);
    }
  } catch {
    /* no tabs yet */
  }
}

// --- helper connection ---

let reconnectDelay = 2000;
let reconnectTimer = null;

async function connectHelper() {
  clearTimeout(reconnectTimer);
  const ok = await native.connect();
  if (!ok) {
    helper = { connected: false, version: "", port: 0 };
    await afterStateChange();
    if (!native.isMissing()) scheduleReconnect();
    return false;
  }
  try {
    const hello = await native.request({ cmd: "hello", port: secret.port });
    helper = { connected: true, version: hello.version, port: hello.port };
    if (hello.port !== secret.port) {
      await store.setSecretPort(hello.port);
      secret.port = hello.port;
    }
    await sendConfig();
    reconnectDelay = 2000;
    // New nonce: Chrome forgets any "proxy is down" marks from before.
    pacNonce = Date.now();
    await applyProxy();
    await refreshStatus();
    return true;
  } catch (e) {
    console.warn("helper hello failed", e);
    scheduleReconnect();
    return false;
  }
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectHelper, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
}

native.onEvent(async (msg) => {
  if (msg.type === "tunnel" && msg.tunnel) {
    tunnels[msg.tunnel.server] = msg.tunnel;
    await afterStateChange();
  } else if (msg.type === "disconnected") {
    helper = { connected: false, version: "", port: 0 };
    tunnels = {};
    await afterStateChange();
    if (!native.isMissing()) scheduleReconnect();
  }
});

async function refreshStatus() {
  if (!native.isConnected()) return;
  try {
    const st = await native.request({ cmd: "status" });
    tunnels = {};
    for (const t of st.tunnels ?? []) tunnels[t.server] = t;
    await afterStateChange();
  } catch {
    /* disconnect handler deals with it */
  }
}

function activeRules() {
  return cfg.settings.enabled ? cfg.rules : [];
}

/** Learned hosts, minus those whose site turned auto-detect off. */
function activeLearned() {
  const follow = new Set(cfg.rules.filter((r) => r.autoFollow !== false).map((r) => r.id));
  const out = {};
  for (const [h, id] of Object.entries(cfg.learned)) if (follow.has(id)) out[h] = id;
  return out;
}

async function sendConfig() {
  if (!native.isConnected()) return;
  const on = cfg.settings.enabled;
  const config = {
    servers: cfg.servers.map(({ id, name, privateKey, addresses, dns, mtu, publicKey, presharedKey, endpoint, allowedIPs, keepalive }) => ({
      id, name, privateKey, addresses, dns, mtu, publicKey, presharedKey, endpoint, allowedIPs, keepalive,
    })),
    rules: activeRules().map(({ id, pattern, exact, route }) => ({ id, pattern, exact: !!exact, route })),
    learned: on ? activeLearned() : {},
    defaultRoute: on ? cfg.settings.defaultRoute : "direct",
    killSwitch: cfg.settings.killSwitch,
    lanDirect: cfg.settings.lanDirect,
    holdMs: HOLD_MS,
  };
  await native.request({ cmd: "config", config });
}

// --- Chrome settings: proxy, WebRTC, block page ---

/** Is any traffic meant to go through a VPN? If not, leave Chrome alone. */
function routingNeeded() {
  const vpn = (route) => route !== "direct";
  return cfg.settings.enabled && (vpn(cfg.settings.defaultRoute) || cfg.rules.some((r) => vpn(r.route)));
}

async function applyProxy() {
  if (!routingNeeded()) {
    await chrome.proxy.settings.clear({ scope: "regular" });
    return;
  }
  const data = buildPac({
    port: secret.port,
    rules: cfg.rules,
    learned: activeLearned(),
    defaultRoute: cfg.settings.defaultRoute,
    killSwitch: cfg.settings.killSwitch,
    lanDirect: cfg.settings.lanDirect,
    nonce: pacNonce,
  });
  await chrome.proxy.settings.set({
    value: { mode: "pac_script", pacScript: { data, mandatory: true } },
    scope: "regular",
  });
}

async function applyWebRTC() {
  const policy = chrome.privacy.network.webRTCIPHandlingPolicy;
  if (cfg.settings.enabled && cfg.settings.blockWebRTC) {
    await policy.set({ value: "disable_non_proxied_udp" });
  } else {
    await policy.clear({});
  }
}

function serverById(id) {
  return cfg.servers.find((s) => s.id === id);
}

/** Can traffic for this route go out right now? */
function routeUsable(route) {
  if (route === "direct") return true;
  if (!serverById(route) || !helper.connected) return false;
  const st = tunnels[route]?.state;
  return st === "up" || st === "starting";
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Kill switch, visible part: while a site's server is down, opening the site
 * shows our "VPN down" page instead of a browser error. (The helper and the
 * PAC already stop the traffic itself.)
 */
async function updateBlockRules() {
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  const removeRuleIds = existing.map((r) => r.id);
  const addRules = [];
  if (cfg.settings.enabled && cfg.settings.killSwitch) {
    const page = chrome.runtime.getURL("blocked/blocked.html");
    const redirect = { type: "redirect", redirect: { regexSubstitution: page + "#\\0" } };
    const okDomains = cfg.rules.filter((r) => routeUsable(r.route) && !r.exact).map((r) => normHost(r.pattern));
    const downSuffix = [];
    let id = 1;
    for (const r of cfg.rules) {
      if (routeUsable(r.route)) continue;
      const p = normHost(r.pattern);
      if (r.exact) {
        addRules.push({
          id: id++,
          priority: 2,
          action: redirect,
          condition: { regexFilter: `^https?://${escapeRe(p)}(:[0-9]+)?(/.*)?$`, resourceTypes: ["main_frame"] },
        });
      } else {
        downSuffix.push(p);
      }
    }
    if (downSuffix.length) {
      // A more specific rule that's fine (edition.cnn.com via UK while cnn.com's
      // US server is down) stays reachable.
      const excluded = okDomains.filter((d) => downSuffix.some((s) => d.endsWith("." + s)));
      addRules.push({
        id: id++,
        priority: 2,
        action: redirect,
        condition: {
          regexFilter: "^https?://.*",
          requestDomains: downSuffix,
          ...(excluded.length ? { excludedRequestDomains: excluded } : {}),
          resourceTypes: ["main_frame"],
        },
      });
    }
    const def = cfg.settings.defaultRoute;
    if (def !== "direct" && !routeUsable(def)) {
      const fine = cfg.rules.filter((r) => routeUsable(r.route) && !r.exact).map((r) => normHost(r.pattern));
      addRules.push({
        id: id++,
        priority: 1,
        action: redirect,
        condition: {
          regexFilter: "^https?://.*",
          ...(fine.length ? { excludedRequestDomains: fine } : {}),
          resourceTypes: ["main_frame"],
        },
      });
    }
  }
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules });
}

// --- badges ---

/**
 * Where host goes, as the helper will decide it: its own rule; else, unless
 * it's a shared service, the site that uses it (the page it's loaded by, or
 * the site it was detected for); else the default.
 */
function routeForHost(host, owner = host) {
  if (!cfg.settings.enabled) return { route: "direct", rule: null, why: "off" };
  const own = matchRule(cfg.rules, host);
  if (own) return { route: own.route, rule: own, why: "rule" };
  if (!isShared(host)) {
    const viaPage = owner && owner !== host ? matchRule(cfg.rules, owner) : null;
    const site = viaPage?.autoFollow !== false && viaPage ? viaPage : cfg.rules.find((r) => r.id === cfg.learned[host] && r.autoFollow !== false);
    if (site) return { route: site.route, rule: site, why: "detected" };
  }
  return { route: cfg.settings.defaultRoute, rule: null, why: "default" };
}

/**
 * Where each host really goes right now, asked from the helper (the one that
 * decides). Falls back to our own reading of the rules when it isn't running.
 * Returns Map host -> {route, why, rule} with why: rule | detected | default | off.
 */
async function explain(hosts, owner) {
  const out = new Map();
  if (native.isConnected() && cfg.settings.enabled && hosts.length) {
    try {
      const res = await native.request({ cmd: "explain", hosts }, 3000);
      for (const e of res.routes ?? []) {
        const rule = e.rule ? cfg.rules.find((r) => r.id === e.rule) ?? null : null;
        const why = e.why === "rule" ? "rule" : rule ? "detected" : "default";
        out.set(e.host, { route: e.route, why, rule });
      }
      return out;
    } catch {
      /* fall through */
    }
  }
  for (const h of hosts) out.set(h, routeForHost(h, owner));
  return out;
}

function shortLabel(server) {
  if (server.label) return server.label.slice(0, 4);
  return server.name.replace(/[^A-Za-z0-9]/g, "").slice(0, 3).toUpperCase() || "VPN";
}

async function updateBadge(tabId) {
  const host = tabSite.get(tabId);
  let text = "";
  let color = "#5f6368";
  if (!cfg.settings.enabled) {
    text = "off";
  } else if (host) {
    const { route } = (await explain([host])).get(host);
    if (route !== "direct") {
      const s = serverById(route);
      if (s && routeUsable(route)) {
        text = shortLabel(s);
        color = "#188038";
      } else {
        text = "!";
        color = "#d93025";
      }
    }
  }
  try {
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
    await chrome.action.setBadgeTextColor({ tabId, color: "#ffffff" });
  } catch {
    /* tab closed */
  }
}

async function updateAllBadges() {
  for (const tabId of tabSite.keys()) await updateBadge(tabId);
}

let notifyTimer = null;
async function afterStateChange() {
  await updateBlockRules();
  await updateAllBadges();
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => chrome.runtime.sendMessage({ event: "changed" }).catch(() => {}), 100);
}

chrome.tabs.onActivated.addListener(({ tabId }) => ready.then(() => updateBadge(tabId)));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!info.url) return;
  ready.then(() => {
    const h = hostOf(info.url);
    if (h) setTabPage(tabId, h, false);
    else {
      tabSite.delete(tabId);
      tabHosts.delete(tabId);
    }
    updateBadge(tabId);
  });
});

/**
 * The tab now shows a page of host. Its list of loaded addresses starts over
 * on a new page load, or when the tab moved to another site without one
 * (back/forward cache, a page Google preloaded from search results).
 */
function setTabPage(tabId, host, newLoad) {
  tabSite.set(tabId, host);
  const cur = tabHosts.get(tabId);
  if (newLoad || !cur || siteOf(cur.site) !== siteOf(host)) tabHosts.set(tabId, { site: host, hosts: new Set() });
}
chrome.tabs.onRemoved.addListener((tabId) => {
  tabSite.delete(tabId);
  tabHosts.delete(tabId);
});

// --- auto-detect: who asked for what ---

let learnedDirty = false;
let learnedTimer = null;

function scheduleLearnedSave() {
  learnedDirty = true;
  clearTimeout(learnedTimer);
  learnedTimer = setTimeout(async () => {
    if (!learnedDirty) return;
    learnedDirty = false;
    await store.save({ learned: cfg.learned });
  }, 1500);
}

function learn(host, ruleId) {
  if (isShared(host)) return;
  if (cfg.learned[host] === ruleId) return;
  if (!(host in cfg.learned) && Object.keys(cfg.learned).length >= MAX_LEARNED) return;
  cfg.learned[host] = ruleId;
  scheduleLearnedSave();
}

chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    ready.then(() => onRequest(d));
  },
  { urls: ["<all_urls>"] }
);

function onRequest(d) {
  const host = hostOf(d.url);
  if (!host) return;

  // Pages Google preloads from search results aren't in the tab yet.
  const prerender = d.documentLifecycle === "prerender";
  const inTab = d.tabId >= 0 && !prerender;
  if (d.type === "main_frame" && inTab) {
    setTabPage(d.tabId, host, true);
    updateBadge(d.tabId);
  } else if (inTab && tabSite.has(d.tabId)) {
    setTabPage(d.tabId, tabSite.get(d.tabId), false);
    const seen = tabHosts.get(d.tabId).hosts;
    if (seen.size < MAX_TAB_HOSTS && host !== tabSite.get(d.tabId)) seen.add(host);
  }

  if (!cfg.settings.enabled) return;
  // The site this request belongs to: a page you open is its own site; other
  // requests belong to the page in their tab, or (workers, preloaded pages)
  // to the page that started them.
  let owner;
  if (d.type === "main_frame") owner = host;
  else if (inTab && tabSite.has(d.tabId)) owner = tabSite.get(d.tabId);
  else owner = hostOf(d.initiator ?? "");
  if (matchRule(cfg.rules, host)) return; // has its own rule; the helper knows
  // Shared services (Google, analytics, CDNs) never follow a site.
  let rule = owner && !isShared(host) ? matchRule(cfg.rules, owner) : null;
  if (rule && rule.autoFollow === false) rule = null;
  const ruleId = rule?.id ?? "";

  const last = hintSent.get(host);
  const now = Date.now();
  if (!last || last.rule !== ruleId || now - last.at > HINT_REFRESH_MS) {
    native.send({ cmd: "hint", host, rule: ruleId });
    hintSent.set(host, { rule: ruleId, at: now });
    if (hintSent.size > 50_000) hintSent.clear();
  }
  if (ruleId && host !== owner) learn(host, ruleId);
}

// --- settings changed in the UI ---

let applyTimer = null;
let learnedPacTimer = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  ready.then(() => {
    const main = ["servers", "rules", "settings"].some((k) => k in changes);
    for (const k of ["servers", "rules", "settings"]) {
      if (k in changes) cfg[k] = k === "settings" ? { ...store.DEFAULT_SETTINGS, ...changes[k].newValue } : changes[k].newValue ?? [];
    }
    if ("learned" in changes && !learnedDirty) cfg.learned = changes.learned.newValue ?? {};
    if (main) {
      clearTimeout(applyTimer);
      applyTimer = setTimeout(applyAll, 250);
    } else if ("learned" in changes) {
      clearTimeout(learnedPacTimer);
      learnedPacTimer = setTimeout(applyProxy, 2000);
    }
  });
});

async function applyAll() {
  hintSent.clear();
  await applyProxy();
  await applyWebRTC();
  try {
    await sendConfig();
  } catch (e) {
    console.warn("config send failed", e);
  }
  // Servers nothing uses any more were just stopped; pick up the new picture.
  await refreshStatus();
  await afterStateChange();
}

// --- requests from the popup and pages ---

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg?.cmd) return false;
  ready
    .then(() => handle(msg))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: e.message }));
  return true;
});

async function handle(msg) {
  switch (msg.cmd) {
    case "state":
      return {
        helper: { ...helper, missing: native.isMissing() },
        tunnels,
      };

    case "recent": {
      // The helper's real routing decisions, newest last.
      if (!native.isConnected()) return [];
      const res = await native.request({ cmd: "recent" });
      return res.recent ?? [];
    }

    case "reconnect":
      reconnectDelay = 2000;
      await connectHelper();
      return { connected: helper.connected };

    case "tabInfo": {
      const host = tabSite.get(msg.tabId) ?? hostOf(msg.url ?? "");
      if (!host) return { host: "" };
      const site = siteOf(host);
      const rule = matchRule(cfg.rules, host);
      const others = [...(tabHosts.get(msg.tabId)?.hosts ?? [])].filter((h) => h !== host).sort();
      const truth = await explain([host, ...others], host);
      const r = truth.get(host);
      const hosts = others.map((h) => {
        const t = truth.get(h);
        return { host: h, route: t.route, why: t.why, follows: t.why === "detected" ? t.rule.pattern : "", usable: routeUsable(t.route) };
      });
      return { host, site, rule, route: r.route, why: r.why, follows: r.why === "detected" ? r.rule.pattern : "", usable: routeUsable(r.route), hosts };
    }

    case "setSiteRoute": {
      const pattern = normHost(msg.pattern);
      if (!pattern) throw new Error("No site");
      let rules = [...cfg.rules];
      const idx = rules.findIndex((r) => normHost(r.pattern) === pattern && !!r.exact === !!msg.exact);
      let ruleId = null;
      if (msg.route === null) {
        if (idx >= 0) rules.splice(idx, 1);
      } else if (idx >= 0) {
        rules[idx] = { ...rules[idx], route: msg.route };
        ruleId = rules[idx].id;
      } else {
        ruleId = store.newId();
        rules.push({ id: ruleId, pattern, exact: !!msg.exact, route: msg.route, autoFollow: true });
      }
      // What the page in this tab already loaded follows the site right away
      // (only if the tab really shows that site).
      const page = msg.tabId != null ? tabHosts.get(msg.tabId) : null;
      const rule = rules.find((r) => r.id === ruleId);
      if (rule && page && matchRule([rule], page.site)) {
        for (const h of page.hosts) {
          if (h !== page.site && !matchRule(rules, h) && !isShared(h)) cfg.learned[h] = ruleId;
        }
        await store.save({ learned: cfg.learned });
      }
      cfg.rules = rules;
      await store.save({ rules });
      await applyAll();
      if (msg.tabId != null && msg.reload !== false) chrome.tabs.reload(msg.tabId).catch(() => {});
      return { ruleId };
    }

    case "check": {
      if (!native.isConnected()) throw new Error("The helper isn't running");
      const res = await native.request({ cmd: "check", server: msg.server }, 20000);
      const { checks } = await store.load(["checks"]);
      checks[msg.server] = { ip: res.ip, loc: res.loc, at: Date.now(), sameAsYou: !!res.directIP && res.directIP === res.ip };
      await store.save({ checks });
      const s = serverById(msg.server);
      if (s && !s.label && res.loc) {
        const servers = cfg.servers.map((x) => (x.id === s.id ? { ...x, label: res.loc } : x));
        await store.save({ servers });
      }
      return checks[msg.server];
    }

    case "blockStatus": {
      const host = hostOf(msg.url ?? "");
      const { route } = routeForHost(host);
      const s = serverById(route);
      return {
        blocked: cfg.settings.enabled && cfg.settings.killSwitch && route !== "direct" && !routeUsable(route),
        server: s?.name ?? "",
        helperMissing: native.isMissing(),
        helperConnected: helper.connected,
        state: tunnels[route]?.state ?? "",
        error: tunnels[route]?.error ?? "",
      };
    }

    case "forget": {
      const learned = { ...cfg.learned };
      for (const [h, id] of Object.entries(learned)) {
        if ((msg.host && h === msg.host) || (msg.ruleId && id === msg.ruleId && !msg.host)) delete learned[h];
      }
      cfg.learned = learned;
      await store.save({ learned });
      await applyAll();
      return {};
    }

    default:
      throw new Error("Unknown command " + msg.cmd);
  }
}

