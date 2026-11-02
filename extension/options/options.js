// options.js: Sites, Servers and Settings pages.

import * as store from "../lib/store.js";
import { flag, parseConf, toConf } from "../lib/conf.js";
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
  const saved = await store.load(["servers", "rules", "learned", "settings", "checks"]);
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
  for (const s of d.servers) {
    opts.push(el("option", { value: s.id, selected: selected === s.id }, `${flag(d.checks[s.id]?.loc)} ${s.name}`));
  }
  if (selected && selected !== "default" && selected !== "direct" && !d.servers.some((s) => s.id === selected)) {
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
    h.connected ? `Helper running (v${h.version})` : h.missing ? "Helper not installed" : "Helper not running"
  );
  $("about").textContent = `WireRoute ${chrome.runtime.getManifest().version}. Helper log: ~/Library/Logs/WireRoute/helper.log`;

  renderSites();
  renderServers();
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
            check ? `Sites see ${check.ip}${check.loc ? " (" + check.loc + ")" : ""}` : "Not checked yet",
            ` · used by ${d.settings.defaultRoute === s.id ? "every other site" : `${usedBy[s.id] ?? 0} site${usedBy[s.id] === 1 ? "" : "s"}`}`,
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

// --- sites ---

async function updateRule(id, patch) {
  const rules = d.rules.map((r) => (r.id === id ? { ...r, ...patch } : r));
  await store.save({ rules });
  await refresh();
}

async function removeRule(r) {
  const rules = d.rules.filter((x) => x.id !== r.id);
  const learned = Object.fromEntries(Object.entries(d.learned).filter(([, id]) => id !== r.id));
  await store.save({ rules, learned });
  await refresh();
}

$("add-site").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pattern = cleanPattern($("site-input").value);
  if (!pattern) return showNotice("site-error", "That doesn't look like a website. Try something like cnn.com.");
  if (d.rules.some((r) => normHost(r.pattern) === pattern && !r.exact)) {
    return showNotice("site-error", `${pattern} is already in the list.`);
  }
  showNotice("site-error", "");
  const rules = [...d.rules, { id: store.newId(), pattern, exact: false, route: $("site-route").value, autoFollow: true }];
  await store.save({ rules });
  $("site-input").value = "";
  await refresh();
});

$("default-route").addEventListener("change", async (e) => {
  await store.save({ settings: { ...d.settings, defaultRoute: e.target.value } });
  await refresh();
});

// --- servers ---

function isDuplicate(s) {
  return d.servers.some((x) => x.privateKey === s.privateKey && x.publicKey === s.publicKey && x.endpoint === s.endpoint);
}

async function addServers(entries) {
  const servers = [...d.servers];
  const added = [];
  const errors = [];
  for (const { name, text } of entries) {
    try {
      const s = parseConf(text);
      if (isDuplicate(s) || servers.some((x) => x.privateKey === s.privateKey && x.publicKey === s.publicKey && x.endpoint === s.endpoint)) {
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
}

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
  const servers = d.servers.map((x) =>
    x.id === s.id ? { ...x, name: name.trim(), label: (label ?? x.label ?? "").trim().slice(0, 4).toUpperCase() } : x
  );
  await store.save({ servers });
  await refresh();
}

async function removeServer(s, uses) {
  const msg = uses
    ? `Delete ${s.name}? ${uses} site setting${uses === 1 ? " uses" : "s use"} it. Those sites will be blocked until you pick another server.`
    : `Delete ${s.name}?`;
  if (!confirm(msg)) return;
  await store.save({ servers: d.servers.filter((x) => x.id !== s.id) });
  await refresh();
}

// --- settings ---

for (const input of document.querySelectorAll("[data-setting]")) {
  input.addEventListener("change", async () => {
    await store.save({ settings: { ...d.settings, [input.dataset.setting]: input.checked } });
    await refresh();
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
  const backup = { wireroute: 1, servers, rules: d.rules, learned: d.learned, settings: d.settings };
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
    const servers = [...d.servers];
    for (const s of full) if (!servers.some((x) => x.id === s.id)) servers.push(s);
    if (!confirm(`Replace your sites and settings with the backup? ${full.length} server(s) with keys will be added.`)) return;
    await store.save({ servers, rules: b.rules ?? [], learned: b.learned ?? {}, settings: { ...d.settings, ...(b.settings ?? {}) } });
    await refresh();
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
