// packs.js: ready-made lists of sites to add in one go. Only the main
// address of each service is listed; the video servers and logins it uses
// are detected and follow it by themselves, as with any site.

export const PACKS = [
  {
    id: "vn-tv",
    name: "Vietnam TV and video",
    sites: [
      "tv360.vn",
      "vtvgo.vn",
      "vtv.vn",
      "fptplay.vn",
      "vieon.vn",
      "mytv.com.vn",
      "galaxyplay.vn",
      "htvonline.com.vn",
    ],
  },
  {
    id: "vn-music",
    name: "Vietnam music",
    sites: ["zingmp3.vn", "nhaccuatui.com"],
  },
  {
    id: "us-streaming",
    name: "US streaming",
    sites: ["netflix.com", "hulu.com", "disneyplus.com", "max.com", "peacocktv.com", "paramountplus.com", "sling.com"],
  },
];

/**
 * Add a pack's sites to the rules, all through route. Sites already in the
 * list keep the server they have.
 * @returns {{rules, added: string[], kept: string[]}}
 */
export function addPack(rules, pack, route, newId) {
  const have = new Set(rules.filter((r) => !r.exact).map((r) => r.pattern.toLowerCase().replace(/\.$/, "")));
  const added = [];
  const kept = [];
  const out = [...rules];
  for (const site of pack.sites) {
    if (have.has(site)) {
      kept.push(site);
      continue;
    }
    out.push({ id: newId(), pattern: site, exact: false, route, autoFollow: true });
    added.push(site);
  }
  return { rules: out, added, kept };
}
