// hosts.js: host names, sites, and rule matching. Pure functions, no chrome.*
// APIs, so they run under Node tests too. Matching must agree with the
// helper's router (host/router.go).

/** Lowercase, drop a trailing dot and IPv6 brackets. */
export function normHost(h) {
  if (!h) return "";
  h = String(h).trim().toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  return h;
}

/** Host of a URL, or "" for non-web URLs (chrome://, extension pages). */
export function hostOf(url) {
  try {
    const u = new URL(url);
    if (!/^(https?|wss?):$/.test(u.protocol)) return "";
    return normHost(u.hostname);
  } catch {
    return "";
  }
}

export function isIP(h) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":");
}

// Two-part public suffixes common enough to matter. Without these,
// "bbc.co.uk" would collapse to "co.uk".
const MULTI_SUFFIXES = new Set(
  (
    "co.uk org.uk ac.uk gov.uk me.uk ltd.uk plc.uk net.uk " +
    "com.vn net.vn org.vn edu.vn gov.vn info.vn biz.vn name.vn pro.vn health.vn ac.vn int.vn " +
    "com.au net.au org.au edu.au gov.au asn.au id.au " +
    "co.jp ne.jp or.jp ac.jp go.jp gr.jp ed.jp lg.jp " +
    "co.kr or.kr ne.kr ac.kr go.kr re.kr " +
    "com.cn net.cn org.cn gov.cn edu.cn ac.cn " +
    "com.hk net.hk org.hk edu.hk gov.hk " +
    "com.tw net.tw org.tw edu.tw gov.tw idv.tw " +
    "com.sg net.sg org.sg edu.sg gov.sg " +
    "com.my net.my org.my edu.my gov.my " +
    "com.ph net.ph org.ph edu.ph gov.ph " +
    "co.th in.th ac.th go.th or.th " +
    "co.id or.id ac.id go.id web.id net.id " +
    "co.in net.in org.in firm.in gen.in ind.in ac.in gov.in edu.in " +
    "co.nz net.nz org.nz ac.nz govt.nz geek.nz " +
    "com.br net.br org.br gov.br edu.br " +
    "com.mx org.mx gob.mx edu.mx net.mx " +
    "com.ar org.ar gob.ar net.ar " +
    "com.tr org.tr net.tr gov.tr edu.tr " +
    "co.za org.za gov.za ac.za net.za " +
    "com.sa com.eg com.pk com.ng com.co com.pe com.ua com.pl " +
    "github.io pages.dev vercel.app netlify.app herokuapp.com appspot.com web.app firebaseapp.com " +
    "blogspot.com cloudfront.net azurewebsites.net"
  ).split(/\s+/)
);

/**
 * The "site" a host belongs to: its registrable domain.
 * edition.cnn.com -> cnn.com, www.bbc.co.uk -> bbc.co.uk, tv360.vn -> tv360.vn.
 */
export function siteOf(host) {
  host = normHost(host);
  if (!host || isIP(host) || !host.includes(".")) return host;
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const last2 = parts.slice(-2).join(".");
  if (MULTI_SUFFIXES.has(last2)) return parts.slice(-3).join(".");
  return last2;
}

/** This Mac or the home network: router pages, printers, .local names. */
export function isLocal(host) {
  host = normHost(host);
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (!host.includes(".") && !host.includes(":")) return true;
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (host.includes(":")) {
    return host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd");
  }
  return false;
}

/**
 * Most specific rule for host: an exact rule on the host itself, else the
 * longest "and subdomains" rule. Returns the rule or null.
 */
export function matchRule(rules, host) {
  host = normHost(host);
  if (!host) return null;
  let best = null;
  let bestLen = -1;
  for (const r of rules) {
    const p = normHost(r.pattern);
    if (!p) continue;
    if (r.exact) {
      if (host === p) return r;
      continue;
    }
    if (host === p || (!isIP(host) && host.endsWith("." + p))) {
      if (p.length > bestLen) {
        best = r;
        bestLen = p.length;
      }
    }
  }
  return best;
}

/** Valid-looking site pattern a person typed: "cnn.com", "*.cnn.com", a URL. */
export function cleanPattern(input) {
  let s = String(input ?? "").trim().toLowerCase();
  if (!s) return "";
  if (s.includes("://")) s = hostOf(s);
  s = s.replace(/^\*\./, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
  s = normHost(s);
  if (!/^[a-z0-9.-]+$/.test(s) && !isIP(s)) return "";
  if (s.startsWith(".") || s.includes("..")) return "";
  return s;
}

// Addresses lots of sites share: search, analytics, ads, big CDNs. They never
// follow a site (live or saved), or Google would go through tv360.vn's server
// from every tab. They use their own rule, or the default.
const SHARED_SITES = new Set(
  (
    "google.com gstatic.com googleapis.com googleusercontent.com googletagmanager.com google-analytics.com " +
    "googlesyndication.com googleadservices.com doubleclick.net recaptcha.net gvt1.com gvt2.com " +
    "facebook.com facebook.net fbcdn.net instagram.com twitter.com x.com twimg.com tiktok.com " +
    "cloudflare.com cloudflareinsights.com jsdelivr.net unpkg.com jquery.com bootstrapcdn.com fontawesome.com " +
    "apple.com icloud.com microsoft.com bing.com clarity.ms hotjar.com sentry.io segment.io amplitude.com " +
    "mixpanel.com newrelic.com nr-data.net dmca.com"
  ).split(" ")
);

export function isShared(host) {
  const site = siteOf(host);
  return SHARED_SITES.has(site) || /^google\.[a-z.]+$/.test(site);
}
