// conf.js: read WireGuard .conf files into server objects.
//
//   [Interface]
//   PrivateKey = <base64>
//   Address = 10.0.0.2/32, fd00::2/128
//   DNS = 1.1.1.1, 1.0.0.1
//   [Peer]
//   PublicKey = <base64>
//   Endpoint = home.example.com:51820
//   AllowedIPs = 0.0.0.0/0, ::/0
//
// Only the first [Peer] is used: one server per file. wg-quick extras
// (PostUp, Table, ListenPort...) don't apply and are ignored.

const KEY_RE = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw480]=$/;

export function isWgKey(k) {
  return KEY_RE.test(String(k ?? "").trim());
}

function list(v) {
  return String(v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parse .conf text. Throws an Error with a plain-English message when the
 * file can't be used.
 * @returns {{privateKey, addresses, dns, mtu, publicKey, presharedKey, endpoint, allowedIPs, keepalive}}
 */
export function parseConf(text) {
  const iface = {};
  const peers = [];
  let section = null;
  let peer = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) {
      section = sec[1].trim().toLowerCase();
      if (section === "peer") {
        peer = {};
        peers.push(peer);
      }
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    if (section === "interface") iface[key] = value;
    else if (section === "peer" && peer) peer[key] = value;
  }

  if (!iface.privatekey) throw new Error("This file has no PrivateKey, so it isn't a WireGuard client config.");
  if (peers.length === 0) throw new Error("This file has no [Peer] section.");
  const p = peers[0];
  const server = {
    privateKey: iface.privatekey,
    addresses: list(iface.address),
    dns: list(iface.dns).filter((d) => /^[0-9a-f.:]+$/i.test(d)),
    mtu: Number(iface.mtu) || 0,
    publicKey: p.publickey ?? "",
    presharedKey: p.presharedkey ?? "",
    endpoint: p.endpoint ?? "",
    allowedIPs: list(p.allowedips),
    keepalive: Number(p.persistentkeepalive) || 0,
  };
  const problems = checkServer(server);
  if (problems.length) throw new Error(problems.join(" "));
  return server;
}

/** Plain-English problems with a server's settings (empty when fine). */
export function checkServer(s) {
  const out = [];
  if (!isWgKey(s.privateKey)) out.push("The PrivateKey doesn't look like a WireGuard key.");
  if (!isWgKey(s.publicKey)) out.push("The server's PublicKey doesn't look like a WireGuard key.");
  if (s.presharedKey && !isWgKey(s.presharedKey)) out.push("The PresharedKey doesn't look like a WireGuard key.");
  if (!s.addresses?.length) out.push("The config has no Address.");
  if (!/^(\[[0-9a-f:]+\]|[a-z0-9.-]+):\d{1,5}$/i.test(s.endpoint ?? "")) {
    out.push("The Endpoint should look like myhome.example.com:51820.");
  }
  return out;
}

/** Back to .conf text, for the Export button. */
export function toConf(s) {
  const lines = ["[Interface]", `PrivateKey = ${s.privateKey}`, `Address = ${s.addresses.join(", ")}`];
  if (s.dns?.length) lines.push(`DNS = ${s.dns.join(", ")}`);
  if (s.mtu) lines.push(`MTU = ${s.mtu}`);
  lines.push("", "[Peer]", `PublicKey = ${s.publicKey}`);
  if (s.presharedKey) lines.push(`PresharedKey = ${s.presharedKey}`);
  lines.push(`Endpoint = ${s.endpoint}`);
  lines.push(`AllowedIPs = ${(s.allowedIPs?.length ? s.allowedIPs : ["0.0.0.0/0", "::/0"]).join(", ")}`);
  if (s.keepalive) lines.push(`PersistentKeepalive = ${s.keepalive}`);
  return lines.join("\n") + "\n";
}

/** Country code ("US") to a flag emoji. */
export function flag(cc) {
  if (!/^[A-Za-z]{2}$/.test(cc ?? "")) return "🌐";
  return String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0)));
}

/**
 * What someone typed as a group's icon: a country code ("VN", since a flag
 * is hard to type), or any emoji, kept to its first character. "" means
 * "pick it by itself".
 */
export function cleanIcon(text) {
  const t = String(text ?? "").trim();
  if (/^[A-Za-z]{2}$/.test(t)) return flag(t);
  const first = [...new Intl.Segmenter().segment(t)][0]?.segment ?? "";
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(first) ? first : "";
}

/** A group's icon: the one picked for it, else the flag of the server it's on (or would use first). */
export function groupIcon(g, loc) {
  return g.icon || (loc ? flag(loc) : "🔁");
}
