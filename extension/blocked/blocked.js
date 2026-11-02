// blocked.js: shown instead of a site whose VPN server is down. Leaves as
// soon as the server is back (or the site no longer needs it).

import { ask } from "../lib/store.js";
import { hostOf } from "../lib/hosts.js";

const url = decodeURIComponent(location.hash.slice(1));
const target = /^https?:\/\//.test(url) ? url : "";
document.getElementById("site").textContent = hostOf(target) || "This site";

async function check() {
  if (!target) return;
  try {
    const s = await ask("blockStatus", { url: target });
    if (!s.blocked) {
      location.replace(target);
      return;
    }
    if (s.server) document.getElementById("server").textContent = s.server;
    document.getElementById("detail").textContent = s.helperMissing
      ? "The WireRoute helper isn't installed."
      : !s.helperConnected
        ? "The WireRoute helper isn't running."
        : s.error || (s.state === "down" ? "The server isn't answering." : "");
  } catch {
    /* worker waking up; next tick */
  }
}

document.getElementById("retry").addEventListener("click", async () => {
  await ask("reconnect").catch(() => {});
  check();
});
document.getElementById("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

check();
setInterval(check, 3000);
