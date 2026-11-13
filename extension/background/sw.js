// sw.js: WireRoute's background worker.
//
// Jobs:
//  1. Start the helper and keep it in sync with servers, site rules and settings.
//  2. Watch every request and tell the helper which site asked for which
//     address ("hints"), so hidden addresses follow their site automatically.
//  3. Point Chrome at the helper (PAC), block WebRTC leaks, show a "VPN down" page instead of leaking, keep badges current.
//  4. Extras: pause for a while, alerts when a server dies or comes back,
//     data used per server today, the right-click menu.

import * as native from "../lib/native.js";
import * as store from "../lib/store.js";
import { buildPac } from "../lib/pac.js";
import { hostOf, isShared, matchRule, normHost, siteOf } from "../lib/hosts.js";
import { needsCheck } from "../lib/health.js";
import { addUsage } from "../lib/usage.js";
import { alertFor } from "../lib/alerts.js";
import { flag, groupIcon } from "../lib/conf.js";

const HOLD_MS = 1000;
const HINT_REFRESH_MS = 60_000;
const MAX_LEARNED = 20_000;
const MAX_TAB_HOSTS = 400;

let cfg = null; // {servers, rules, learned, settings}
let secret = null;
let helper = { connected: false, version: "", port: 0 };
let tunnels = {}; // serverId -> {state, error, lastHandshake, rxBytes, txBytes, pingMs, since, relay}
let pacNonce = Date.now();
const tabSite = new Map(); // tabId -> host of the page in that tab
// tabId -> Map(site -> Set of hosts that site's pages loaded in this tab).
// Kept per site, not per "page now in the tab": requests from the page you
// just left keep arriving after you click a link, and must not be blamed on
// the new site.
const tabPages = new Map();
const hintSent = new Map(); // host -> {rule, at}

// --- startup ---

const ready = init();

async function init() {
  cfg = await store.load(["servers", "groups", "rules", "learned", "settings", "checks"]);
  secret = await store.getSecret();
  await resumeIfDue();
  await seedTabs();
  await applyProxy();
  await applyWebRTC();
  await updateBlockRules();
  await connectHelper();
  await buildMenus();
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
chrome.alarms.onAlarm.addListener(async (alarm) => {
  await ready;
  if (alarm.name === "resume") return resumeIfDue();
  if (!native.isConnected()) await connectHelper();
  else refreshStatus();
});

// --- pause ---

/** Turn WireRoute off for a while; it comes back on by itself. */
async function pause(minutes) {
  const resumeAt = Date.now() + minutes * 60_000;
  await store.save({ settings: { ...cfg.settings, enabled: false, resumeAt } });
  chrome.alarms.create("resume", { when: resumeAt });
  return { resumeAt };
}

/** End a pause whose time is up (also after Chrome was closed through it). */
async function resumeIfDue() {
  const at = cfg.settings.resumeAt;
  if (!at || Date.now() < at) return;
  cfg.settings = { ...cfg.settings, enabled: true, resumeAt: 0 };
  await store.save({ settings: cfg.settings });
  chrome.alarms.clear("resume");
}

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
    const prev = tunnels[msg.tunnel.server]?.state;
    tunnels[msg.tunnel.server] = msg.tunnel;
    await afterStateChange();
    autoCheck();
    alertChange(msg.tunnel.server, prev, msg.tunnel.state);
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
    autoCheck();
    trackUsage();
  } catch {
    /* disconnect handler deals with it */
  }
}

/**
 * Fresh speed readings for the open popup. State changes already arrive as
 * events; this only picks up the numbers that move in between, so it leaves
 * badges and block rules alone unless a state turns out to differ.
 */
async function liveStatus() {
  if (!native.isConnected()) return;
  try {
    const st = await native.request({ cmd: "status" }, 3000);
    const fresh = {};
    for (const t of st.tunnels ?? []) fresh[t.server] = t;
    const ids = new Set([...Object.keys(fresh), ...Object.keys(tunnels)]);
    const changed = [...ids].some((id) => fresh[id]?.state !== tunnels[id]?.state);
    tunnels = fresh;
    if (changed) await afterStateChange();
    await trackUsage();
  } catch {
    /* keep the last readings */
  }
}

/** Ask which IP and country sites see through a server, and remember it. */
async function runCheck(id) {
  if (!native.isConnected()) throw new Error("The helper isn't running");
  const res = await native.request({ cmd: "check", server: id }, 20000);
  const { checks } = await store.load(["checks"]);
  checks[id] = { ip: res.ip, loc: res.loc, at: Date.now(), sameAsYou: !!res.directIP && res.directIP === res.ip };
  await store.save({ checks });
  const s = serverById(id);
  if (s && !s.label && res.loc) {
    const servers = cfg.servers.map((x) => (x.id === s.id ? { ...x, label: res.loc } : x));
    await store.save({ servers });
  }
  return checks[id];
}

// Connected servers get their exit country checked by themselves, so the
// popup shows where sites see you without a click. Redone every few hours.
const checking = new Set();
const checkFailedAt = new Map(); // serverId -> when the last automatic try failed
async function autoCheck() {
  if (!native.isConnected() || !cfg) return;
  const { checks } = await store.load(["checks"]);
  for (const s of cfg.servers) {
    if (checking.has(s.id) || !needsCheck(tunnels[s.id], checks[s.id])) continue;
    // A server whose check fails (no internet behind it) isn't retried for a while.
    if (Date.now() - (checkFailedAt.get(s.id) ?? 0) < 10 * 60_000) continue;
    checking.add(s.id);
    runCheck(s.id)
      .then(() => {
        checkFailedAt.delete(s.id);
        chrome.runtime.sendMessage({ event: "changed" }).catch(() => {});
      })
      .catch(() => checkFailedAt.set(s.id, Date.now()))
      .finally(() => checking.delete(s.id));
  }
}

// --- data used today ---

let usageSaving = Promise.resolve();
/** Fold the helper's byte counters into today's totals. */
function trackUsage() {
  usageSaving = usageSaving.then(async () => {
    const { usage } = await store.load(["usage"]);
    await store.save({ usage: addUsage(usage, tunnels) });
  }).catch(() => {});
  return usageSaving;
}

// --- alerts ---

/** Routes something points at: the default and every site rule. */
function routesInUse() {
  return new Set([cfg.settings.defaultRoute, ...cfg.rules.map((r) => r.route)]);
}

function alertChange(id, prev, next) {
  if (!cfg.settings.notify || !cfg.settings.enabled) return;
  const server = serverById(id);
  if (!server) return;
  const used = routesInUse();
  const names = Object.fromEntries(cfg.servers.map((s) => [s.id, s.name]));
  const groups = cfg.groups.filter((g) => used.has(g.id) && g.members.includes(id));
  const alert = alertFor(prev, next, { server, groups, tunnels, names, killSwitch: cfg.settings.killSwitch });
  if (!alert) return;
  // One alert per server at a time: a newer one replaces it.
  chrome.notifications
    .create("server-" + id, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
      title: alert.title,
      message: alert.message,
      priority: next === "down" ? 2 : 0,
    })
    .catch(() => {});
}

chrome.notifications.onClicked.addListener((nid) => {
  chrome.notifications.clear(nid);
  chrome.tabs.create({ url: chrome.runtime.getURL("options/options.html#servers") });
});

// --- right-click menu ---

let menuBuild = Promise.resolve();
/**
 * "Open link through..." on links, "Send this site through..." on pages,
 * each listing Direct, your groups and your servers. Picking one sets the
 * site's server, like the popup does.
 */
function buildMenus() {
  menuBuild = menuBuild.then(async () => {
    await chrome.contextMenus.removeAll();
    if (!cfg.servers.length) return;
    const choices = [
      { id: "direct", title: "🏠 Direct (no VPN)" },
      ...cfg.groups.map((g) => ({ id: g.id, title: `${groupIcon(g, cfg.checks?.[g.members[0]]?.loc)} ${g.name}` })),
      ...cfg.servers.map((s) => ({ id: s.id, title: `${flag(cfg.checks?.[s.id]?.loc)} ${s.name}` })),
    ];
    const menus = [
      { id: "link", title: "Open link through", contexts: ["link"] },
      { id: "page", title: "Send this site through", contexts: ["page"] },
    ];
    for (const m of menus) {
      chrome.contextMenus.create({ id: m.id, title: m.title, contexts: m.contexts, documentUrlPatterns: ["http://*/*", "https://*/*"] });
      for (const c of choices) {
        chrome.contextMenus.create({ id: `${m.id}:${c.id}`, parentId: m.id, title: c.title, contexts: m.contexts });
      }
    }
  }).catch((e) => console.warn("menu build failed", e));
  return menuBuild;
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  ready.then(async () => {
    const [kind, route] = String(info.menuItemId).split(":");
    if (!route) return;
    if (kind === "link") {
      const host = hostOf(info.linkUrl ?? "");
      if (!host) return;
      await handle({ cmd: "setSiteRoute", pattern: siteOf(host), exact: false, route });
      chrome.tabs.create({ url: info.linkUrl, index: tab ? tab.index + 1 : undefined, openerTabId: tab?.id });
    } else if (kind === "page" && tab) {
      const host = await tabHost(tab.id);
      if (!host) return;
      await handle({ cmd: "setSiteRoute", pattern: siteOf(host), exact: false, route, tabId: tab.id });
    }
  });
});

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
    groups: cfg.groups.map(({ id, name, members, fastest }) => ({ id, name, fastest: !!fastest, members: members.filter((m) => serverById(m)) })),
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

function groupById(id) {
  return cfg.groups.find((g) => g.id === id);
}

/** What a route points at, by name: a server, a group, or Direct. */
function routeName(route) {
  if (route === "direct") return "Direct";
  return serverById(route)?.name ?? groupById(route)?.name ?? "";
}

function serverUsable(id) {
  if (!serverById(id) || !helper.connected) return false;
  const st = tunnels[id]?.state;
  return st === "up" || st === "starting";
}

/** Can traffic for this route go out right now? A group can while any member can. */
function routeUsable(route) {
  if (route === "direct") return true;
  const group = groupById(route);
  if (group) return group.members.some(serverUsable);
  return serverUsable(route);
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
        out.set(e.host, { route: e.route, why, rule, via: e.via ?? "" });
      }
      return out;
    } catch {
      /* fall through */
    }
  }
  for (const h of hosts) out.set(h, routeForHost(h, owner));
  return out;
}

/** Badge text for a server or group: its label, else its name's first letters. */
function shortLabel(item) {
  if (item.label) return item.label.slice(0, 4);
  return item.name.replace(/[^A-Za-z0-9]/g, "").slice(0, 3).toUpperCase() || "VPN";
}

/**
 * The address a tab shows. Its own address wins over the last page that
 * started loading in it, which can be one Chrome preloads unseen (Google
 * does this with the top search result).
 */
async function tabHost(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const url = tab?.pendingUrl || tab?.url;
  return url ? hostOf(url) : tabSite.get(tabId) ?? "";
}

async function updateBadge(tabId) {
  const host = await tabHost(tabId);
  let text = "";
  let color = "#5f6368";
  if (!cfg.settings.enabled) {
    text = "off";
  } else if (host) {
    const { route } = (await explain([host])).get(host);
    if (route !== "direct") {
      const s = serverById(route) ?? groupById(route);
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
    if (h) tabSite.set(tabId, h);
    else tabSite.delete(tabId);
    updateBadge(tabId);
  });
});
chrome.tabs.onRemoved.addListener((tabId) => {
  tabSite.delete(tabId);
  tabPages.delete(tabId);
});

/** The addresses pages of site loaded in a tab (created on first use). */
function pageHosts(tabId, site) {
  let pages = tabPages.get(tabId);
  if (!pages) tabPages.set(tabId, (pages = new Map()));
  const key = siteOf(site);
  let set = pages.get(key);
  if (!set) {
    pages.set(key, (set = new Set()));
    if (pages.size > 4) pages.delete(pages.keys().next().value);
  }
  return set;
}

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

  // Pages Google preloads from search results aren't shown in the tab yet.
  // A page loading into the tab itself is always its frame 0.
  const preloaded = d.documentLifecycle === "prerender" || (d.type === "main_frame" && d.frameId !== 0);
  const inTab = d.tabId >= 0 && !preloaded;

  // The site this request belongs to. A page you open is its own site.
  // Requests from a tab's main page carry the page that made them
  // (initiator): trust that over "what the tab shows now", which flips the
  // moment you click a link while the old page is still sending requests.
  // Embedded frames belong to the page in their tab; workers to whoever
  // started them.
  let owner;
  if (d.type === "main_frame") {
    owner = host;
    if (inTab) {
      tabSite.set(d.tabId, host);
      tabPages.get(d.tabId)?.delete(siteOf(host)); // a fresh load starts its list over
      updateBadge(d.tabId);
    }
  } else {
    const initiator = hostOf(d.initiator ?? "");
    if (d.frameId === 0 && initiator) owner = initiator;
    else if (inTab && tabSite.has(d.tabId)) owner = tabSite.get(d.tabId);
    else owner = initiator;
    if (d.tabId >= 0 && owner && host !== owner) {
      const seen = pageHosts(d.tabId, owner);
      if (seen.size < MAX_TAB_HOSTS) seen.add(host);
    }
  }

  if (!cfg.settings.enabled) return;
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
let menuTimer = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  ready.then(() => {
    const main = ["servers", "groups", "rules", "settings"].some((k) => k in changes);
    for (const k of ["servers", "groups", "rules", "settings"]) {
      if (k in changes) cfg[k] = k === "settings" ? { ...store.DEFAULT_SETTINGS, ...changes[k].newValue } : changes[k].newValue ?? [];
    }
    if ("learned" in changes && !learnedDirty) cfg.learned = changes.learned.newValue ?? {};
    // Turned back on by hand during a pause: the pause is over.
    if ("settings" in changes && cfg.settings.enabled && cfg.settings.resumeAt) {
      store.save({ settings: { ...cfg.settings, resumeAt: 0 } });
      chrome.alarms.clear("resume");
    }
    if ("servers" in changes || "groups" in changes || "checks" in changes) {
      if ("checks" in changes) cfg.checks = changes.checks.newValue ?? {};
      clearTimeout(menuTimer);
      menuTimer = setTimeout(buildMenus, 300);
    }
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
      if (msg.live) await liveStatus();
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
      const host = msg.tabId != null ? await tabHost(msg.tabId) : hostOf(msg.url ?? "");
      if (!host) return { host: "" };
      const site = siteOf(host);
      const rule = matchRule(cfg.rules, host);
      const others = [...(tabPages.get(msg.tabId)?.get(siteOf(host)) ?? [])].filter((h) => h !== host).sort();
      const truth = await explain([host, ...others], host);
      const r = truth.get(host);
      // via: for a group, the server it's using right now.
      const describe = (t) => ({
        route: t.route,
        why: t.why,
        follows: t.why === "detected" ? t.rule.pattern : "",
        usable: routeUsable(t.route),
        via: groupById(t.route) ? t.via ?? "" : "",
      });
      const hosts = others.map((h) => ({ host: h, ...describe(truth.get(h)) }));
      return { host, site, rule, ...describe(r), hosts };
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
      // What this site's pages already loaded in the tab follows it right
      // away (only if the tab really shows that site).
      const shown = msg.tabId != null ? await tabHost(msg.tabId) : null;
      const rule = rules.find((r) => r.id === ruleId);
      if (rule && shown && matchRule([rule], shown)) {
        for (const h of tabPages.get(msg.tabId)?.get(siteOf(shown)) ?? []) {
          if (h !== shown && !matchRule(rules, h) && !isShared(h)) cfg.learned[h] = ruleId;
        }
        await store.save({ learned: cfg.learned });
      }
      cfg.rules = rules;
      await store.save({ rules });
      await applyAll();
      if (msg.tabId != null && msg.reload !== false) chrome.tabs.reload(msg.tabId).catch(() => {});
      return { ruleId };
    }

    case "check":
      return runCheck(msg.server);

    case "pause":
      return pause(msg.minutes ?? 60);

    case "resume":
      cfg.settings = { ...cfg.settings, enabled: true, resumeAt: 0 };
      await store.save({ settings: cfg.settings });
      chrome.alarms.clear("resume");
      return {};

    case "usage": {
      await trackUsage();
      const { usage } = await store.load(["usage"]);
      return usage;
    }

    case "blockStatus": {
      const host = hostOf(msg.url ?? "");
      const { route } = routeForHost(host);
      return {
        blocked: cfg.settings.enabled && cfg.settings.killSwitch && route !== "direct" && !routeUsable(route),
        server: routeName(route),
        group: !!groupById(route),
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

