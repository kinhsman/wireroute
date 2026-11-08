// options.js: Sites, Servers and Settings pages.

import * as store from "../lib/store.js";
import { cleanIcon, flag, groupIcon, parseConf, toConf } from "../lib/conf.js";
import { cleanPattern, normHost } from "../lib/hosts.js";

const $ = (id) => document.getElementById(id);
let d = null; // {servers, rules, learned, settings, checks, state}

function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k === "checked" || k === "value" || k === "disabled" || k === "selected") n[k] = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v);
  }
  for (const c of children) if (c != null) n.append(c);
  return n;
}

function showNotice(id, text) {
  const n = $(id);
  n.textContent = text;
  n.classList.toggle("hidden", !text);
}

// --- tabs ---

function showTab() {
  const name = (location.hash || "#sites").slice(1);
  for (const t of ["sites", "servers", "settings"]) {
    $("tab-" + t).classList.toggle("hidden", t !== name);
    document.querySelector(`[data-tab="${t}"]`).classList.toggle("active", t === name);
  }
}
window.addEventListener("hashchange", showTab);

// --- data ---

async function load() {
  const saved = await store.load(["servers", "groups", "rules", "learned", "settings", "checks"]);
  let state = { helper: { connected: false, missing: false }, tunnels: {} };
  try {
    state = await store.ask("state");
  } catch {
    /* worker starting */
  }
  d = { ...saved, state };
}

async function refresh() {
  await load();
  render();
}

function routeOptions(selected, { withDefault = false } = {}) {
  const opts = [];
  if (withDefault) opts.push(el("option", { value: "default", selected: selected === "default" }, "Default"));
  opts.push(el("option", { value: "direct", selected: selected === "direct" }, "🏠 Direct (no VPN)"));
  for (const g of d.groups) {
    opts.push(el("option", { value: g.id, selected: selected === g.id }, `${groupIcon(g, d.checks[g.members[0]]?.loc)} ${g.name} (group)`));
  }
  for (const s of d.servers) {
    opts.push(el("option", { value: s.id, selected: selected === s.id }, `${flag(d.checks[s.id]?.loc)} ${s.name}`));
  }
  const known = (id) => d.servers.some((s) => s.id === id) || d.groups.some((g) => g.id === id);
  if (selected && selected !== "default" && selected !== "direct" && !known(selected)) {
    opts.push(el("option", { value: selected, selected: true }, "⚠️ Deleted server"));
  }
  return opts;
}

function tunnelPill(id) {
  const st = d.state.tunnels[id]?.state;
  const map = {
    up: ["ok", "Connected"],
    starting: ["warn", "Connecting"],
    down: ["bad", "Not reachable"],
    error: ["bad", "Problem"],
  };
  const [cls, text] = map[st] ?? ["", "Off until a site uses it"];
  return el("span", { class: "pill " + cls, title: d.state.tunnels[id]?.error ?? "" }, el("span", { class: "dot " + cls }), text);
}

// --- render ---

function render() {
  const h = d.state.helper;
  const hs = $("helper-state");
  hs.replaceChildren(
    el("span", { class: "dot " + (h.connected ? "ok" : "bad") }),
    el(
      "div",
      {},
      h.connected ? `Helper running (v${h.version})` : h.missing ? "Helper not installed" : "Helper not running",
      !h.connected
        ? el("button", { class: "link", id: "install-helper", onclick: () => chrome.tabs.create({ url: chrome.runtime.getURL("setup/setup.html") }) }, "Install helper")
        : null
    )
  );
  const version = chrome.runtime.getManifest().version;
  $("version").textContent = `v${version}`;
  $("about").textContent = `WireRoute ${version}. Helper log: ~/Library/Logs/WireRoute/helper.log`;

  renderSites();
  renderServers();
  renderGroups();
  renderSettings();
}

function renderSites() {
  $("site-route").replaceChildren(...routeOptions(d.servers[0]?.id ?? "direct"));
  $("default-route").replaceChildren(...routeOptions(d.settings.defaultRoute));
  $("sites-empty").classList.toggle("hidden", d.rules.length > 0);

  const counts = {};
  for (const id of Object.values(d.learned)) counts[id] = (counts[id] ?? 0) + 1;

  const rules = [...d.rules].sort((a, b) => a.pattern.localeCompare(b.pattern));
  $("site-list").replaceChildren(
    ...rules.map((r) => {
      const hosts = Object.entries(d.learned)
        .filter(([, id]) => id === r.id)
        .map(([host]) => host)
        .sort();
      const select = el("select", { "aria-label": "Server for " + r.pattern }, ...routeOptions(r.route));
      select.addEventListener("change", () => updateRule(r.id, { route: select.value }));

      return el(
        "div",
        { class: "card item" },
        el(
          "div",
          { class: "item-main" },
          el("img", { class: "icon", alt: "", src: chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent("https://" + r.pattern)}&size=32`) }),
          el("div", { class: "names" }, el("b", {}, r.pattern), el("span", {}, r.exact ? "Only this exact address" : "Includes all its subdomains")),
          select
        ),
        el(
          "div",
          { class: "item-opts" },
          el(
            "label",
            {},
            el("input", { type: "checkbox", checked: r.autoFollow !== false, onchange: (e) => updateRule(r.id, { autoFollow: e.target.checked }) }),
            "Auto-detect hidden addresses"
          ),
          el(
            "label",
            {},
            el("input", { type: "checkbox", checked: !r.exact, onchange: (e) => updateRule(r.id, { exact: !e.target.checked }) }),
            "Include subdomains"
          ),
          el("span", { class: "spacer" }),
          el("button", { class: "btn btn-sm btn-danger", onclick: () => removeRule(r) }, "Remove")
        ),
        hosts.length
          ? el(
              "details",
              { class: "hosts" },
              el("summary", {}, `${hosts.length} detected hidden addresses follow this site`),
              el(
                "ul",
                {},
                ...hosts.map((host) =>
                  el(
                    "li",
                    {},
                    el("span", { title: host }, host),
                    el("button", { title: "Forget this address", onclick: () => store.ask("forget", { host }).then(refresh) }, "×")
                  )
                )
              )
            )
          : null
      );
    })
  );
}

function renderServers() {
  const usedBy = {};
  for (const r of d.rules) usedBy[r.route] = (usedBy[r.route] ?? 0) + 1;
  $("server-list").replaceChildren(
    ...d.servers.map((s) => {
      const check = d.checks[s.id];
      const checkBtn = el("button", { class: "btn btn-sm" }, "Check");
      checkBtn.addEventListener("click", async () => {
        checkBtn.disabled = true;
        checkBtn.textContent = "Checking";
        try {
          await store.ask("check", { server: s.id });
          await refresh();
        } catch (e) {
          checkBtn.disabled = false;
          checkBtn.textContent = "Check";
          showNotice("server-error", `${s.name}: ${e.message}`);
        }
      });
      const uses = (usedBy[s.id] ?? 0) + (d.settings.defaultRoute === s.id ? 1 : 0);
      return el(
        "div",
        { class: "card item" },
        el(
          "div",
          { class: "item-main" },
          el("span", { class: "icon" }, flag(check?.loc)),
          el("div", { class: "names" }, el("b", {}, s.name), el("span", { class: "mono" }, s.endpoint)),
          tunnelPill(s.id)
        ),
        el(
          "div",
          { class: "item-opts" },
          el(
            "span",
            { class: "server-stats" },
            check
              ? check.sameAsYou
                ? `⚠️ Sites see ${check.ip}, your own address: this server sends its traffic back out through your network`
                : `Sites see ${check.ip}${check.loc ? " (" + check.loc + ")" : ""}`
              : "Not checked yet",
            ` · used by ${d.settings.defaultRoute === s.id ? "every other site" : `${usedBy[s.id] ?? 0} site${usedBy[s.id] === 1 ? "" : "s"}`}`,
            ...d.groups.filter((g) => g.members.includes(s.id)).map((g) => ` · in group ${g.name}`),
            ` · badge shows "${s.label || "auto"}"`
          ),
          el("span", { class: "spacer" }),
          checkBtn,
          el("button", { class: "btn btn-sm", onclick: () => renameServer(s) }, "Rename"),
          el("button", { class: "btn btn-sm", onclick: () => download(`${s.name}.conf`, toConf(s), "text/plain") }, "Export"),
          el("button", { class: "btn btn-sm btn-danger", onclick: () => removeServer(s, uses) }, "Delete")
        )
      );
    })
  );
}

function renderSettings() {
  for (const input of document.querySelectorAll("[data-setting]")) {
    input.checked = !!d.settings[input.dataset.setting];
  }
}

// --- changes ---
// Every change reads what's saved right now (never the copy on screen, which
// can be a moment old) and changes run one at a time, so quick clicks can't
// undo or duplicate each other.

let queue = Promise.resolve();
function change(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}
const fresh = (keys) => store.load(keys);

// --- sites ---

const updateRule = (id, patch) => change(async () => {
  const { rules: saved } = await fresh(["rules"]);
  const rules = saved.map((r) => (r.id === id ? { ...r, ...patch } : r));
  await store.save({ rules });
  await refresh();
});

const removeRule = (r) => change(async () => {
  const saved = await fresh(["rules", "learned"]);
  const rules = saved.rules.filter((x) => x.id !== r.id);
  const learned = Object.fromEntries(Object.entries(saved.learned).filter(([, id]) => id !== r.id));
  await store.save({ rules, learned });
  await refresh();
});

$("add-site").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("site-input").value;
  const route = $("site-route").value;
  change(async () => {
    const pattern = cleanPattern(input);
    if (!pattern) return showNotice("site-error", "That doesn't look like a website. Try something like cnn.com.");
    const { rules: saved } = await fresh(["rules"]);
    if (saved.some((r) => normHost(r.pattern) === pattern && !r.exact)) {
      return showNotice("site-error", `${pattern} is already in the list.`);
    }
    showNotice("site-error", "");
    await store.save({ rules: [...saved, { id: store.newId(), pattern, exact: false, route, autoFollow: true }] });
    if ($("site-input").value === input) $("site-input").value = "";
    await refresh();
  });
});

$("default-route").addEventListener("change", (e) => {
  const value = e.target.value;
  change(async () => {
    const { settings } = await fresh(["settings"]);
    await store.save({ settings: { ...settings, defaultRoute: value } });
    await refresh();
  });
});

// --- servers ---

const sameServer = (a, b) => a.privateKey === b.privateKey && a.publicKey === b.publicKey && a.endpoint === b.endpoint;

const addServers = (entries) => change(async () => {
  const servers = [...(await fresh(["servers"])).servers];
  const added = [];
  const errors = [];
  for (const { name, text } of entries) {
    try {
      const s = parseConf(text);
      if (servers.some((x) => sameServer(x, s))) {
        errors.push(`${name}: already added.`);
        continue;
      }
      servers.push({ id: store.newId(), name: name || "Server " + (servers.length + 1), label: "", ...s });
      added.push(name);
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
  }
  if (added.length) await store.save({ servers });
  showNotice("server-error", errors.join(" "));
  showNotice("server-ok", added.length ? `Added ${added.join(", ")}. Pick it for a site from the WireRoute icon.` : "");
  await refresh();
});

async function readFiles(files) {
  const entries = [];
  for (const f of files) {
    if (f.size > 64 * 1024) {
      entries.push({ name: f.name, text: "" });
      continue;
    }
    entries.push({ name: f.name.replace(/\.conf$/i, ""), text: await f.text() });
  }
  await addServers(entries);
}

const drop = $("drop");
drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.classList.add("over");
});
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  readFiles([...e.dataTransfer.files]);
});
$("pick-file").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", (e) => {
  readFiles([...e.target.files]);
  e.target.value = "";
});
$("show-paste").addEventListener("click", () => $("paste-form").classList.remove("hidden"));
$("cancel-paste").addEventListener("click", () => $("paste-form").classList.add("hidden"));
$("paste-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await addServers([{ name: $("paste-name").value.trim(), text: $("paste-text").value }]);
  if ($("server-error").classList.contains("hidden")) {
    $("paste-form").classList.add("hidden");
    $("paste-name").value = "";
    $("paste-text").value = "";
  }
});

async function renameServer(s) {
  const name = prompt("Name for this server", s.name);
  if (name === null || !name.trim()) return;
  const label = prompt("Short badge text (up to 4 letters, like US or VN). Leave empty to use its country.", s.label ?? "");
  await change(async () => {
    const { servers } = await fresh(["servers"]);
    await store.save({
      servers: servers.map((x) =>
        x.id === s.id ? { ...x, name: name.trim(), label: (label ?? x.label ?? "").trim().slice(0, 4).toUpperCase() } : x
      ),
    });
    await refresh();
  });
}

async function removeServer(s, uses) {
  const inGroups = d.groups.filter((g) => g.members.includes(s.id)).map((g) => g.name);
  const parts = [`Delete ${s.name}?`];
  if (uses) parts.push(`${uses} site setting${uses === 1 ? " uses" : "s use"} it. Those sites will be blocked until you pick another server.`);
  if (inGroups.length) parts.push(`It will also be taken out of ${inGroups.join(", ")}.`);
  if (!confirm(parts.join(" "))) return;
  await change(async () => {
    const { servers, groups } = await fresh(["servers", "groups"]);
    await store.save({
      servers: servers.filter((x) => x.id !== s.id),
      groups: groups.map((g) => ({ ...g, members: g.members.filter((m) => m !== s.id) })),
    });
    await refresh();
  });
}

// --- groups ---

/** How a group is doing, from its members' states. */
function groupState(g) {
  const states = g.members.map((id) => d.state.tunnels[id]?.state);
  const up = states.filter((x) => x === "up").length;
  if (!g.members.length) return ["warn", "No servers yet"];
  if (states.every((x) => !x)) return ["", "Off until a site uses it"];
  if (up === 0 && states.some((x) => x === "starting")) return ["warn", "Connecting"];
  if (up === 0) return ["bad", "All servers down"];
  return ["ok", `${up} of ${g.members.length} up`];
}

function renderGroups() {
  const usedBy = {};
  for (const r of d.rules) usedBy[r.route] = (usedBy[r.route] ?? 0) + 1;
  const serverName = (id) => d.servers.find((s) => s.id === id)?.name ?? "Deleted server";
  $("group-list").replaceChildren(
    ...d.groups.map((g) => {
      const [cls, text] = groupState(g);
      const uses = (usedBy[g.id] ?? 0) + (d.settings.defaultRoute === g.id ? 1 : 0);
      const others = d.servers.filter((s) => !g.members.includes(s.id));
      const addSelect = el("select", { "aria-label": `Server to add to ${g.name}` }, ...others.map((s) => el("option", { value: s.id }, `${flag(d.checks[s.id]?.loc)} ${s.name}`)));
      const members = g.members.length
        ? g.members.map((id, i) => {
            const st = d.state.tunnels[id]?.state;
            const dot = st === "up" ? "ok" : st === "starting" ? "warn" : st ? "bad" : "";
            return el(
              "li",
              {},
              el("span", { class: "grow" }, `${flag(d.checks[id]?.loc)} ${serverName(id)}`),
              el("span", { class: "dot " + dot, title: st ?? "off" }),
              el("button", { class: "btn btn-sm", title: "Try this one earlier", disabled: i === 0, onclick: () => moveMember(g.id, i, -1) }, "↑"),
              el("button", { class: "btn btn-sm", title: "Try this one later", disabled: i === g.members.length - 1, onclick: () => moveMember(g.id, i, 1) }, "↓"),
              el("button", { class: "btn btn-sm btn-danger", title: "Take out of this group", onclick: () => removeMember(g.id, id) }, "Remove")
            );
          })
        : [el("li", { class: "empty-note" }, "Add servers below. The first one is used while it's up.")];
      return el(
        "div",
        { class: "card item", "data-group": g.id },
        el(
          "div",
          { class: "item-main" },
          el("span", { class: "icon" }, groupIcon(g, d.checks[g.members[0]]?.loc)),
          el("div", { class: "names" }, el("b", {}, g.name), el("span", {}, `used by ${uses} site setting${uses === 1 ? "" : "s"} · badge shows "${g.label || "auto"}"`)),
          el("span", { class: "pill " + cls }, el("span", { class: "dot " + cls }), text)
        ),
        el("ol", { class: "members" }, ...members),
        others.length
          ? el("div", { class: "add-member" }, addSelect, el("button", { class: "btn btn-sm", onclick: () => addMember(g.id, addSelect.value) }, "Add server"))
          : null,
        el(
          "div",
          { class: "item-opts" },
          el("span", { class: "spacer" }),
          el("button", { class: "btn btn-sm", onclick: () => renameGroup(g) }, "Rename"),
          el("button", { class: "btn btn-sm btn-danger", onclick: () => removeGroup(g, uses) }, "Delete")
        )
      );
    })
  );
}

const updateGroup = (id, fn) =>
  change(async () => {
    const { groups } = await fresh(["groups"]);
    await store.save({ groups: groups.map((g) => (g.id === id ? fn(g) : g)) });
    await refresh();
  });

const addMember = (id, serverId) => serverId && updateGroup(id, (g) => (g.members.includes(serverId) ? g : { ...g, members: [...g.members, serverId] }));
const removeMember = (id, serverId) => updateGroup(id, (g) => ({ ...g, members: g.members.filter((m) => m !== serverId) }));
const moveMember = (id, index, by) =>
  updateGroup(id, (g) => {
    const members = [...g.members];
    const to = index + by;
    if (to < 0 || to >= members.length) return g;
    [members[index], members[to]] = [members[to], members[index]];
    return { ...g, members };
  });

$("add-group").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("group-name").value.trim();
  change(async () => {
    if (!name) return showNotice("group-error", "Give the group a name, like Vietnam.");
    const { groups } = await fresh(["groups"]);
    if (groups.some((g) => g.name.toLowerCase() === name.toLowerCase())) return showNotice("group-error", `There's already a group called ${name}.`);
    showNotice("group-error", "");
    await store.save({ groups: [...groups, { id: store.newId(), name, label: "", members: [] }] });
    $("group-name").value = "";
    await refresh();
  });
});

async function renameGroup(g) {
  const name = prompt("Name for this group", g.name);
  if (name === null || !name.trim()) return;
  const label = prompt("Short badge text (up to 4 letters, like VN). Leave empty to use the name.", g.label ?? "");
  const icon = prompt("Icon: a country code like VN for its flag, or paste any emoji. Leave empty to use the first server's flag.", g.icon ?? "");
  await updateGroup(g.id, (x) => ({
    ...x,
    name: name.trim(),
    label: (label ?? x.label ?? "").trim().slice(0, 4).toUpperCase(),
    icon: icon === null ? x.icon ?? "" : cleanIcon(icon),
  }));
}

async function removeGroup(g, uses) {
  const msg = uses
    ? `Delete ${g.name}? ${uses} site setting${uses === 1 ? " uses" : "s use"} it. Those sites will be blocked until you pick something else.`
    : `Delete ${g.name}? Its servers stay.`;
  if (!confirm(msg)) return;
  await change(async () => {
    const { groups } = await fresh(["groups"]);
    await store.save({ groups: groups.filter((x) => x.id !== g.id) });
    await refresh();
  });
}

// --- settings ---

for (const input of document.querySelectorAll("[data-setting]")) {
  input.addEventListener("change", () => {
    const value = input.checked;
    change(async () => {
      const { settings } = await fresh(["settings"]);
      await store.save({ settings: { ...settings, [input.dataset.setting]: value } });
      await refresh();
    });
  });
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el("a", { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$("export").addEventListener("click", () => {
  const withKeys = $("with-keys").checked;
  const servers = d.servers.map((s) => (withKeys ? s : { id: s.id, name: s.name, label: s.label, endpoint: s.endpoint }));
  const backup = { wireroute: 1, servers, groups: d.groups, rules: d.rules, learned: d.learned, settings: d.settings };
  download(`wireroute-backup${withKeys ? "-with-keys" : ""}.json`, JSON.stringify(backup, null, 2), "application/json");
});
$("import").addEventListener("click", () => $("import-file").click());
$("import-file").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  try {
    const b = JSON.parse(await f.text());
    if (b.wireroute !== 1) throw new Error("not a WireRoute backup");
    const full = (b.servers ?? []).filter((s) => s.privateKey && s.publicKey);
    if (!confirm(`Replace your sites and settings with the backup? ${full.length} server(s) with keys will be added.`)) return;
    await change(async () => {
      const saved = await fresh(["servers", "settings"]);
      const servers = [...saved.servers];
      for (const s of full) if (!servers.some((x) => x.id === s.id)) servers.push(s);
      await store.save({
        servers,
        groups: b.groups ?? [],
        rules: b.rules ?? [],
        learned: b.learned ?? {},
        settings: { ...saved.settings, ...(b.settings ?? {}) },
      });
      await refresh();
    });
  } catch (err) {
    alert("Couldn't import: " + err.message);
  }
});
$("forget-all").addEventListener("click", async () => {
  if (!confirm("Forget every detected address?")) return;
  await store.save({ learned: {} });
  await refresh();
});

// --- live updates ---

// Debounced: detected addresses arrive in bursts while you browse.
let refreshTimer = null;
function soon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 400);
}
chrome.storage.onChanged.addListener((_c, area) => {
  if (area === "local") soon();
});
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.event === "changed") soon();
});

showTab();
refresh();
