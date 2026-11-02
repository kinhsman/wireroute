// setup.js: "Check again" button on the helper install page.

import { ask } from "../lib/store.js";
document.getElementById("check").addEventListener("click", async () => {
  const r = await ask("reconnect").catch((e) => ({ error: e.message }));
  document.getElementById("result").textContent = r.connected ? "Helper found. You're all set." : "Still not found.";
});
