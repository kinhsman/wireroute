// health.js: how a server is doing, in plain words, for the popup and the
// settings page. The helper measures; this only words it.
//
//   status  {state, error, pingMs, since, relay}  from the helper
//   check   {ip, loc, at, sameAsYou}                 from the last exit check

/** A round trip this long or longer reads as slow. */
export const SLOW_MS = 400;

/** Exit checks older than this are redone by themselves. */
export const RECHECK_AFTER_MS = 6 * 60 * 60 * 1000;

/** "42 ms", or "450 ms, slow". */
export function speedText(ms) {
  if (!ms) return "";
  return ms >= SLOW_MS ? `${ms} ms, slow` : `${ms} ms`;
}

/** How long ago, short: "a moment", "5 min", "2 hr", "3 days". */
export function ago(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return "a moment";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr`;
  const days = Math.floor(s / 86400);
  return days === 1 ? "1 day" : `${days} days`;
}

let names = null;
/** "VN" -> "Vietnam". Unknown codes come back as they are. */
export function countryName(cc) {
  if (!/^[A-Za-z]{2}$/.test(cc ?? "")) return cc ?? "";
  try {
    names ??= new Intl.DisplayNames(["en"], { type: "region" });
    return names.of(cc.toUpperCase()) ?? cc;
  } catch {
    return cc;
  }
}

/**
 * One server's health.
 * @returns {{text: string, cls: string, title: string, where: string}}
 *   text   is it up and how fast ("Connected · 42 ms")
 *   cls    "ok" | "warn" | "bad" | "" for the coloured dot
 *   where  the country sites see, or a warning when they see you
 *   title  the longer story, for hovering
 */
export function serverHealth(status, check, nowMs = Date.now()) {
  const now = nowMs / 1000;
  const lasted = status?.since ? ` for ${ago(now - status.since)}` : "";
  let text, cls, title;
  switch (status?.state) {
    case "up": {
      // The server's relay is fetching sites for us (custom wg-easy image).
      const base = status.relay ? "Connected, relay on" : "Connected";
      const speed = speedText(status.pingMs);
      text = speed ? `${base} · ${speed}` : base;
      cls = status.pingMs >= SLOW_MS ? "warn" : "ok";
      title = status.pingMs ? `Round trip through this server: ${status.pingMs} ms` : base;
      break;
    }
    case "starting":
      [text, cls, title] = ["Connecting", "warn", "Connecting"];
      break;
    case "down":
      text = "Not reachable" + lasted;
      [cls, title] = ["bad", "The server isn't answering" + lasted];
      break;
    case "error":
      [text, cls, title] = ["Problem", "bad", status.error || "Problem"];
      break;
    default:
      [text, cls, title] = ["Off until a site uses it", "", "Not connected: no site uses it yet"];
  }

  let where = "";
  if (check?.sameAsYou) {
    where = `⚠️ Shows your own address (${check.ip})`;
  } else if (check?.loc) {
    where = countryName(check.loc);
  }
  if (check?.ip) {
    const when = check.at ? `, checked ${ago(now - check.at / 1000)} ago` : "";
    title += `\nSites see ${check.ip}${check.loc ? ` in ${countryName(check.loc)}` : ""}${when}`;
  }
  return { text, cls, title, where };
}

/** Whether a connected server's exit check is missing or old. */
export function needsCheck(status, check, nowMs = Date.now()) {
  return status?.state === "up" && (!check?.at || nowMs - check.at > RECHECK_AFTER_MS);
}
