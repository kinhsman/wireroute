// pac.js: builds the PAC script Chrome uses to pick a proxy per request.
//
// Everything goes to the helper, which makes the real decision (rules, hints
// from tabs, learned hosts). The PAC only decides one more thing: whether
// Chrome may fall back to a direct connection when the helper isn't
// reachable. For sites that must use a VPN (kill switch), it may not.

import { normHost } from "./hosts.js";

/**
 * @param {object} o
 * @param {number} o.port         helper's local proxy port
 * @param {object[]} o.rules      [{id, pattern, exact, route}]
 * @param {object} o.learned      {host: ruleId}
 * @param {string} o.defaultRoute "direct" or a server id
 * @param {boolean} o.killSwitch
 * @param {boolean} o.lanDirect
 * @param {number} [o.nonce]      changes the script so Chrome forgets "bad proxy" marks
 */
export function buildPac({ port, rules, learned, defaultRoute, killSwitch, lanDirect, nonce = 0 }) {
  const exact = {};
  const suffix = {};
  const ruleStrict = {};
  for (const r of rules) {
    const p = normHost(r.pattern);
    if (!p) continue;
    // 0 = always direct, 1 = helper only, 2 = helper, direct allowed if it's down
    const mode = r.route === "direct" ? 0 : killSwitch ? 1 : 2;
    (r.exact ? exact : suffix)[p] = mode;
    ruleStrict[r.id] = mode;
  }
  const learnedMode = {};
  for (const [h, id] of Object.entries(learned ?? {})) {
    if (id in ruleStrict && ruleStrict[id] !== 0) learnedMode[normHost(h)] = ruleStrict[id];
  }
  const defMode = defaultRoute === "direct" ? 2 : killSwitch ? 1 : 2;

  return `// WireRoute ${nonce}
var P = "PROXY 127.0.0.1:${Number(port)}";
var EXACT = ${JSON.stringify(exact)};
var SUFFIX = ${JSON.stringify(suffix)};
var LEARNED = ${JSON.stringify(learnedMode)};
var DEF = ${defMode};
var LAN = ${lanDirect ? "true" : "false"};

function isLocal(h) {
  if (isPlainHostName(h) || h === "localhost") return true;
  if (/\\.(localhost|local)$/.test(h)) return true;
  if (/^127\\./.test(h) || /^10\\./.test(h) || /^192\\.168\\./.test(h) || /^169\\.254\\./.test(h)) return true;
  if (/^172\\.(1[6-9]|2[0-9]|3[01])\\./.test(h)) return true;
  if (h === "::1" || /^\\[?(fe80|fc|fd)/.test(h)) return true;
  return false;
}

function out(mode) {
  if (mode === 0) return "DIRECT";
  if (mode === 1) return P;
  return P + "; DIRECT";
}

function FindProxyForURL(url, host) {
  host = host.toLowerCase();
  if (host.charAt(host.length - 1) === ".") host = host.substring(0, host.length - 1);
  if (host.charAt(0) === "[") host = host.substring(1, host.length - 1);
  if (LAN && isLocal(host)) return "DIRECT";
  if (EXACT.hasOwnProperty(host)) return out(EXACT[host]);
  var h = host;
  while (true) {
    if (SUFFIX.hasOwnProperty(h)) return out(SUFFIX[h]);
    var i = h.indexOf(".");
    if (i < 0) break;
    h = h.substring(i + 1);
  }
  if (LEARNED.hasOwnProperty(host)) return out(LEARNED[host]);
  return out(DEF);
}
`;
}
