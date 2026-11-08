// popup.js: pick a server for the site you're on.

import * as store from "../lib/store.js";
import { flag, groupIcon } from "../lib/conf.js";
import { normHost } from "../lib/hosts.js";

const $ = (id) => document.getElementById(id);

let tab = null;
let data = null; // {servers, rules, settings, checks, state, info}
let busy = false;

function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) n.setAttribute(k, v);
  }
  for (const c of children) if (c != null) n.append(c);
  return n;
}

export function stateText(st) {
  switch (st?.state) {
    case "up":
      // The server's relay is fetching sites for us (custom wg-easy image).
      return { text: st.relay ? "Connected, relay on" : "Connected", cls: "ok" };
    case "starting":
      return { text: "Connecting", cls: "warn" };
    case "down":
      return { text: "Not reachable", cls: "bad" };
    case "error":
      return { text: "Problem", cls: "bad" };
    default:
      return { text: "Off until a site uses it", cls: "" };
  }
}

async function loadAll() {
  // ?tab=<id> picks a tab explicitly (used by the screenshot test).
  const forced = Number(new URLSearchParams(location.search).get("tab"));
  [tab] = forced ? [await chrome.tabs.get(forced)] : await chrome.tabs.query({ active: true, currentWindow: true });
  const saved = await store.load(["servers", "groups", "rules", "settings", "checks"]);
  const state = await store.ask("state");
  const info = tab ? await store.ask("tabInfo", { tabId: tab.id, url: tab.url }) : { host: "" };
  data = { ...saved, state, info };
}

function routeName(route) {
  if (route === "direct") return "Direct";
  return (data.servers.find((s) => s.id === route) ?? data.groups.find((g) => g.id === route))?.name ?? "Missing server";
}

/** How a group is doing: which server it uses, or how many are up. */
function groupState(g, via) {
  const states = g.members.map((id) => data.state.tunnels[id]?.state);
  const up = states.filter((s) => s === "up").length;
  if (via) return { text: `Using ${routeName(via)}`, cls: "ok" };
  if (states.every((s) => !s)) return { text: "Off until a site uses it", cls: "" };
  if (up === 0 && states.some((s) => s === "starting")) return { text: "Connecting", cls: "warn" };
  if (up === 0) return { text: "All servers down", cls: "bad" };
  return { text: `${up} of ${g.members.length} servers up`, cls: "ok" };
}

function render() {
  const { servers, settings, state, info, checks } = data;
  $("enabled").checked = settings.enabled;
  $("helper-missing").classList.toggle("hidden", !state.helper.missing);
  $("helper-down").classList.toggle("hidden", state.helper.missing || state.helper.connected || !settings.enabled);
  $("off").classList.toggle("hidden", settings.enabled);
  $("no-servers").classList.toggle("hidden", servers.length > 0);

  const hasSite = !!info.host && servers.length > 0;
  $("site").classList.toggle("hidden", !hasSite);
  $("no-site").classList.toggle("hidden", hasSite || servers.length === 0);
  if (hasSite) renderSite();

  $("servers").classList.toggle("hidden", servers.length === 0);
  const list = $("server-list");
  list.replaceChildren(
    ...servers.map((s) => {
      const st = stateText(state.tunnels[s.id]);
      const check = checks[s.id];
      const sub = check?.sameAsYou
        ? `⚠️ Shows your own address (${check.ip})`
        : check
          ? `Shows as ${check.ip}`
          : st.text;
      const btn = el("button", { class: "btn btn-sm", title: "Check which IP and country sites see" }, "Check");
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "Checking";
        try {
          await store.ask("check", { server: s.id });
          await refresh();
        } catch (e) {
          btn.textContent = "Failed";
          btn.title = e.message;
        }
      });
      return el(
        "li",
        {},
        el("span", { class: "flag" }, flag(check?.loc)),
        el("div", { class: "info" }, el("b", {}, s.name), el("span", {}, sub)),
        el("span", { class: "dot " + st.cls, title: st.text }),
        btn
      );
    })
  );
}

function renderSite() {
  const { servers, settings, info, state, checks } = data;
  $("favicon").src = chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(tab.url)}&size=32`);
  $("site-name").textContent = info.site;
  $("host-name").textContent = info.host !== info.site ? info.host : "";

  const status = $("site-status");
  if (!settings.enabled || info.route === "direct") {
    status.className = "pill";
    status.textContent = "Not protected";
  } else if (info.usable) {
    status.className = "pill ok";
    status.textContent = "Protected";
    if (info.via) status.title = `Using ${routeName(info.via)}`;
  } else {
    status.className = "pill bad";
    status.textContent = data.groups.some((g) => g.id === info.route) ? "Blocked, all servers down" : "Blocked, server down";
  }

  // Scope: whole site (with subdomains) or this exact address.
  const showExact = info.host !== info.site;
  $("exact-row").classList.toggle("hidden", !showExact);
  $("exact-host").textContent = info.host;
  $("exact-site").textContent = info.site;
  if (info.rule && showExact) $("exact").checked = !!info.rule.exact && normHost(info.rule.pattern) === info.host;

  const current = info.rule ? info.rule.route : "default";
  const options = [
    {
      value: "default",
      icon: "⚙️",
      name: "Automatic",
      sub: info.follows
        ? `Goes with ${info.follows}, which uses it (${routeName(info.route)})`
        : `Same as other sites (${routeName(settings.defaultRoute)})`,
    },
    { value: "direct", icon: "🏠", name: "Direct", sub: "Your normal connection, no VPN" },
    ...data.groups.map((g) => {
      const st = groupState(g, info.route === g.id ? info.via : "");
      const lead = checks[info.route === g.id && info.via ? info.via : g.members[0]]?.loc;
      return { value: g.id, icon: groupIcon(g, lead), name: g.name, sub: st.text, cls: st.cls };
    }),
    ...servers.map((s) => {
      const st = stateText(state.tunnels[s.id]);
      return { value: s.id, icon: flag(checks[s.id]?.loc), name: s.name, sub: st.text, cls: st.cls };
    }),
  ];
  $("routes").replaceChildren(
    ...options.map((o) => {
      const b = el(
        "button",
        { class: "route", role: "radio", "aria-checked": String(o.value === current) },
        el("span", { class: "flag" }, o.icon),
        el("span", { class: "name" }, o.name, el("span", { class: "sub" }, o.sub)),
        o.cls !== undefined ? el("span", { class: "dot " + o.cls }) : null,
        el("span", { class: "radio" })
      );
      b.addEventListener("click", () => choose(o.value));
      return b;
    })
  );

  const det = $("detected");
  det.classList.toggle("hidden", info.hosts.length === 0);
  const following = info.hosts.filter((h) => h.why === "detected").length;
  $("detected-count").textContent = info.rule
    ? `${following} of ${info.hosts.length} hidden addresses go with this site`
    : `This site loaded ${info.hosts.length} other addresses`;
  $("detected-list").replaceChildren(
    ...info.hosts.map((h) =>
      el(
        "li",
        {},
        el("span", { class: "h", title: h.host }, h.host),
        el(
          "span",
          { class: "r", title: h.follows ? `Goes with ${h.follows}` : "" },
          routeName(h.route) + (h.why === "rule" ? " (own pick)" : h.follows && h.follows !== info.site ? ` (with ${h.follows})` : "")
        )
      )
    )
  );
}

async function choose(value) {
  if (busy) return;
  busy = true;
  document.querySelectorAll(".route").forEach((b) => (b.disabled = true));
  try {
    const exact = !$("exact-row").classList.contains("hidden") && $("exact").checked;
    const { info } = data;
    if (value === "default") {
      if (info.rule) {
        await store.ask("setSiteRoute", { pattern: info.rule.pattern, exact: !!info.rule.exact, route: null, tabId: tab.id });
      }
    } else {
      const pattern = exact ? info.host : info.site;
      await store.ask("setSiteRoute", { pattern, exact, route: value, tabId: tab.id });
    }
    await refresh();
  } catch (e) {
    alert(e.message);
  } finally {
    busy = false;
  }
}

async function refresh() {
  await loadAll();
  render();
}

$("enabled").addEventListener("change", async (e) => {
  // Read the switch now: a refresh during the save would reset it.
  const on = e.target.checked;
  busy = true;
  try {
    const { settings } = await store.load(["settings"]);
    await store.save({ settings: { ...settings, enabled: on } });
  } finally {
    busy = false;
  }
  setTimeout(refresh, 400);
});
$("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("add-server").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("options/options.html#servers") }));
$("open-setup").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("setup/setup.html") }));
$("reconnect").addEventListener("click", async () => {
  await store.ask("reconnect").catch(() => {});
  refresh();
});
$("exact").addEventListener("change", async () => {
  // Move the current rule to the new scope (whole site <-> this address).
  const rule = data.info.rule;
  if (!rule) return;
  await store.ask("setSiteRoute", { pattern: rule.pattern, exact: !!rule.exact, route: null, reload: false });
  await choose(rule.route);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.event === "changed" && !busy) refresh();
});

refresh();
