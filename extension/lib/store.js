// store.js: everything WireRoute keeps, in chrome.storage.local (never sync:
// private keys must not leave this Mac).
//
//   servers  [{id, name, label, privateKey, addresses, dns, mtu, publicKey,
//              presharedKey, endpoint, allowedIPs, keepalive}]
//   groups   [{id, name, label, icon, fastest, members: [serverId...]}]  failover order (icon: emoji, "" = first server's flag;
//            fastest: use the quickest member that's up, not the first)
//   rules    [{id, pattern, exact, route, autoFollow}]
//   learned  {host: ruleId}   hidden addresses sites were seen using
//   settings {enabled, defaultRoute, killSwitch, blockWebRTC, lanDirect, notify,
//             resumeAt}  resumeAt: when a pause ends (ms), 0 = not paused
//   checks   {serverId: {ip, loc, at}}
//   usage    {day: "YYYY-MM-DD", bytes: {serverId: n}, last: {serverId: {rx, tx}}}
//            data through each server today; last = the helper's counters at the last look
//   secret   {port}  the helper's preferred local port
//   wgEasy   {url}   the wg-easy address last used to get servers
//   (a server from wg-easy also has from: {base, client})

export const DEFAULT_SETTINGS = {
  enabled: true,
  defaultRoute: "direct",
  killSwitch: true,
  blockWebRTC: true,
  lanDirect: true,
  notify: true,
  resumeAt: 0,
};

const DEFAULTS = {
  servers: [],
  groups: [],
  rules: [],
  learned: {},
  settings: DEFAULT_SETTINGS,
  checks: {},
  usage: { day: "", bytes: {}, last: {} },
};

export async function load(keys = Object.keys(DEFAULTS)) {
  const got = await chrome.storage.local.get(keys);
  const out = {};
  for (const k of keys) {
    out[k] = got[k] ?? structuredClone(DEFAULTS[k]);
  }
  if (out.settings) out.settings = { ...DEFAULT_SETTINGS, ...out.settings };
  return out;
}

export function save(patch) {
  return chrome.storage.local.set(patch);
}

export function newId() {
  return crypto.randomUUID();
}

export async function getSecret() {
  const { secret } = await chrome.storage.local.get("secret");
  if (secret?.port) return secret;
  const fresh = { port: 18869 };
  await chrome.storage.local.set({ secret: fresh });
  return fresh;
}

export async function setSecretPort(port) {
  const s = await getSecret();
  if (s.port !== port) await chrome.storage.local.set({ secret: { ...s, port } });
}

/** Ask the background worker something. */
export function ask(cmd, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ cmd, ...payload }, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!res?.ok) reject(new Error(res?.error ?? "Something went wrong"));
      else resolve(res.data);
    });
  });
}
