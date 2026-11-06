// setup.js: the helper install page. Shows this computer's one-line install
// first, copies it on click, and "Check again" reconnects to the helper.

import { ask } from "../lib/store.js";

chrome.runtime.getPlatformInfo((info) => {
  if (info.os === "mac") document.getElementById("steps").prepend(document.getElementById("mac"));
});

for (const btn of document.querySelectorAll("[data-copy]")) {
  btn.addEventListener("click", async () => {
    await navigator.clipboard.writeText(btn.previousElementSibling.textContent.trim());
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = "Copy"), 1500);
  });
}

document.getElementById("check").addEventListener("click", async () => {
  const r = await ask("reconnect").catch((e) => ({ error: e.message }));
  document.getElementById("result").textContent = r.connected ? "Helper found. You're all set." : "Still not found.";
});
