// store.js: everything WireRoute keeps, in chrome.storage.local (never sync:
// private keys must not leave this Mac).
//
//   servers  [{id, name, label, privateKey, addresses, dns, mtu, publicKey,
//              presharedKey, endpoint, allowedIPs, keepalive}]
//   groups   [{id, name, label, icon, members: [serverId...]}]  failover order (icon: emoji, "" = first server's flag)
//   rules    [{id, pattern, exact, route, autoFollow}]
//   learned  {host: ruleId}   hidden addresses sites were seen using
//   settings {enabled, defaultRoute, killSwitch, blockWebRTC, lanDirect}
//   checks   {serverId: {ip, loc, at}}
//   secret   {port}  the helper's preferred local port

export const DEFAULT_SETTINGS = {
  enabled: true,
  defaultRoute: "direct",
  killSwitch: true,
  blockWebRTC: true,
  lanDirect: true,
};

const DEFAULTS = {
  servers: [],
  groups: [],
  rules: [],
  learned: {},
  settings: DEFAULT_SETTINGS,
  checks: {},
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
