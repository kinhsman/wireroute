// wgeasy.js: get servers straight from a wg-easy server (version 15).
//
// WireRoute never asks for the wg-easy password. You sign in to wg-easy in
// Chrome as usual (password, two-step code or single sign-on all work), and
// these calls go out with that sign-in, the way the wg-easy page's own do.

/** "10.0.0.5:51821" or "https://vpn.example.com/" -> "http://10.0.0.5:51821". */
export function cleanBase(text) {
  let t = String(text ?? "").trim();
  if (!t) return "";
  if (!/^https?:\/\//i.test(t)) t = "http://" + t;
  try {
    const u = new URL(t);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "";
  }
}

export class SignInNeeded extends Error {
  constructor() {
    super("Sign in to wg-easy first");
  }
}

async function call(base, path, opts = {}) {
  let res;
  try {
    res = await fetch(base + path, { credentials: "include", cache: "no-store", ...opts });
  } catch {
    throw new Error(`Can't reach ${base}. Check the address, and that this computer can get to it.`);
  }
  if (res.status === 401 || res.status === 403) throw new SignInNeeded();
  if (!res.ok) throw new Error(`wg-easy said ${res.status} ${res.statusText}`.trim());
  return res;
}

/** Every client you can see, simplified. */
export async function listClients(base) {
  const res = await call(base, "/api/client");
  const list = await res.json().catch(() => null);
  if (!Array.isArray(list)) throw new Error("That doesn't look like wg-easy 15. Check the address.");
  return list.map(simplify);
}

export function simplify(c) {
  const seen = c.latestHandshakeAt ? Date.parse(c.latestHandshakeAt) : 0;
  return {
    id: c.id,
    name: String(c.name ?? `Client ${c.id}`),
    enabled: c.enabled !== false,
    address: c.ipv4Address ?? "",
    publicKey: c.publicKey ?? "",
    lastSeen: Number.isFinite(seen) ? seen : 0,
  };
}

/** A client's .conf text. */
export async function clientConfig(base, id) {
  const res = await call(base, `/api/client/${encodeURIComponent(id)}/configuration`);
  return res.text();
}

/** Make a new client (a new config) and return its id. */
export async function createClient(base, name) {
  const res = await call(base, "/api/client", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, expiresAt: null }),
  });
  const out = await res.json().catch(() => ({}));
  if (!out.clientId && out.clientId !== 0) throw new Error("wg-easy didn't say which client it made");
  return out.clientId;
}

/** Another device connected with this client in the last few minutes. */
export function inUseElsewhere(client, now = Date.now()) {
  return client.lastSeen > 0 && now - client.lastSeen < 3 * 60_000;
}
