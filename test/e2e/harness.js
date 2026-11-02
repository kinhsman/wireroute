// Shared plumbing for the end-to-end tests: installs the helper, runs fake
// WireGuard servers, and drives a throwaway Chrome profile over the DevTools
// protocol. Nothing here touches your normal Chrome profile or the computer's
// network. Runs on macOS and Windows.

import { spawn, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseConf } from "../../extension/lib/conf.js";
import { isShared, matchRule } from "../../extension/lib/hosts.js";

export const ROOT = resolve(import.meta.dirname, "../..");
export const EXT_ID = "kbmajebcnniiphhhhhgafeipmpibcnjc";
export const WINDOWS = process.platform === "win32";
const EXE = WINDOWS ? ".exe" : "";
const CHROME =
  process.env.CHROME ??
  (WINDOWS
    ? [
        join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
        join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
        join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
      ].find((p) => existsSync(p))
    : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;

// Tests must never leave anything in your folders.
const DOWNLOADS = join(homedir(), "Downloads");
const listDownloads = () => {
  try {
    return new Set(readdirSync(DOWNLOADS));
  } catch {
    return new Set();
  }
};
const downloadsBefore = listDownloads();
const procs = [];
let tmpRoot = null;

export async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    console.log(`  ok   ${name} (${Date.now() - t0}ms)`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}\n       ${String(e.message).split("\n").join("\n       ")}`);
  }
}

export function finish() {
  const added = [...listDownloads()].filter((f) => !downloadsBefore.has(f));
  // Only count files a test could have made (another app may save something meanwhile).
  const ours = added.filter((f) => /\.(conf|json)$/i.test(f));
  if (ours.length) {
    failures++;
    console.log(`  FAIL test left files in your Downloads folder: ${ours.join(", ")}`);
  }
  console.log(failures ? `\n${failures} failed` : "\nall passed");
  process.exit(failures ? 1 : 0);
}

export async function until(fn, what, timeout = 15000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e.message;
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}

process.on("exit", () => {
  for (const p of procs) {
    try {
      p.kill("SIGKILL");
    } catch {}
  }
  if (tmpRoot && !process.env.KEEP) rmSync(tmpRoot, { recursive: true, force: true });
});

/** Install the current helper the way a person would on this system. */
function installHelper() {
  if (!WINDOWS) {
    execFileSync(join(ROOT, "install", "install.sh"), { stdio: "ignore" });
    return;
  }
  // Windows: build the exe next to a copy of the real installer and run it.
  const dir = join(tmpRoot, "win-install");
  mkdirSync(dir, { recursive: true });
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  execFileSync("go", ["build", "-o", join(dir, `wireroute-host-${arch}.exe`), "."], { cwd: join(ROOT, "host"), stdio: "inherit" });
  copyFileSync(join(ROOT, "install", "install.ps1"), join(dir, "install.ps1"));
  execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(dir, "install.ps1")], { stdio: "inherit" });
}

/** Process IDs of running helpers. On CI only the test's helper runs. */
export function helperPids(parentPid) {
  try {
    if (WINDOWS) {
      const out = execFileSync("powershell", [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='wireroute-host.exe'\" | ForEach-Object { $_.ProcessId }",
      ]).toString();
      return out.split(/\s+/).filter(Boolean).map(Number);
    }
    return execFileSync("pgrep", ["-P", String(parentPid), "-f", "wireroute-host"]).toString().trim().split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

const fakePids = {};

/** Process ID of a fake server, to pause or stop it. */
export const fakePid = (name) => fakePids[name];

/** Install the helper and start fake servers. Returns {tmp, confs}. */
export async function setup(serverNames = ["A", "B"]) {
  tmpRoot = mkdtempSync(join(tmpdir(), "wireroute-e2e-"));
  console.log("installing helper and building fake servers");
  // Chrome on macOS only finds helpers registered in its standard folder, so
  // the test installs the current helper the normal way first.
  installHelper();
  execFileSync("go", ["build", "-o", join(tmpRoot, "fakevpn" + EXE), "./cmd/fakevpn"], { cwd: join(ROOT, "host"), stdio: "inherit" });
  // One process per fake server, so a test can pause just one of them.
  const confs = {};
  for (const n of serverNames) {
    const fake = spawn(join(tmpRoot, "fakevpn" + EXE), ["-dir", tmpRoot, n], { stdio: ["ignore", "pipe", "inherit"] });
    procs.push(fake);
    fakePids[n] = fake.pid;
    await new Promise((res) => fake.stdout.on("data", (b) => String(b).includes("ready") && res()));
    confs[n] = parseConf(readFileSync(join(tmpRoot, `${n}.conf`), "utf8"));
  }
  return { tmp: tmpRoot, confs };
}

/** A throwaway Chrome you can close and start again on the same profile. */
export class Browser {
  constructor(profile) {
    this.profile = profile;
    mkdirSync(join(profile, "NativeMessagingHosts"), { recursive: true });
    // On a Mac, a Chrome with its own profile folder reads helper
    // registrations from there. (Windows reads them from the registry.)
    if (!WINDOWS) copyFileSync(
      join(homedir(), "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.wireroute.host.json"),
      join(profile, "NativeMessagingHosts", "com.wireroute.host.json")
    );
  }

  async launch() {
    this.nextId = 1;
    this.waiting = new Map();
    this.listeners = new Set();
    let buf = "";
    this.proc = spawn(
      CHROME,
      [
        ...(process.env.HEADFUL ? ["--window-position=3000,3000", "--window-size=1100,800"] : ["--headless=new"]),
        `--user-data-dir=${this.profile}`,
        "--remote-debugging-pipe",
        "--enable-unsafe-extension-debugging",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=HttpsUpgrades",
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] }
    );
    procs.push(this.proc);
    this.exited = new Promise((r) => this.proc.on("exit", r));
    this.proc.stdio[4].on("data", (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf("\0")) >= 0) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (msg.id && this.waiting.has(msg.id)) {
          const { res, rej } = this.waiting.get(msg.id);
          this.waiting.delete(msg.id);
          msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
        } else if (msg.method) {
          for (const l of this.listeners) l(msg);
        }
      }
    });
    this.proc.stdio[3].on("error", () => {});
    await this.cdp("Target.setDiscoverTargets", { discover: true });
    // Downloads (Export buttons) must never land in your folders.
    await this.cdp("Browser.setDownloadBehavior", { behavior: "deny" });
  }

  cdp(method, params = {}, sessionId) {
    const id = this.nextId++;
    this.proc.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
    return new Promise((res, rej) => this.waiting.set(id, { res, rej }));
  }

  async evaluate(sessionId, expression) {
    const r = await this.cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }

  async openPage(url) {
    const { targetId } = await this.cdp("Target.createTarget", { url });
    return this.attach(targetId);
  }

  async attach(targetId) {
    const { sessionId } = await this.cdp("Target.attachToTarget", { targetId, flatten: true });
    await this.cdp("Runtime.enable", {}, sessionId);
    await this.cdp("Page.enable", {}, sessionId);
    return { targetId, sessionId };
  }

  close(page) {
    return this.cdp("Target.closeTarget", { targetId: page.targetId });
  }

  ask(sessionId, cmd, payload = {}) {
    return this.evaluate(
      sessionId,
      `new Promise((res, rej) => chrome.runtime.sendMessage(${JSON.stringify({ cmd, ...payload })}, (r) => r?.ok ? res(r.data) : rej(new Error(r?.error))))`
    );
  }

  /** Close Chrome the normal way (like quitting it). */
  async quit() {
    await this.cdp("Browser.close").catch(() => {});
    await Promise.race([this.exited, sleep(10000)]);
  }
}

/**
 * Check everything that must always hold after a stretch of browsing, against
 * the helper's own log of what it did since t0. names maps server IDs to the
 * names shown in the popup. Throws listing every problem found.
 */
export async function checkInvariants(b, ext, { t0, tabPrefix, allowBlocked = false, names = {} }) {
  const SERVERS = names;
  const storage = (key) => b.evaluate(ext.sessionId, `chrome.storage.local.get('${key}').then(x => x['${key}'])`);
  const tabIdOf = (prefix) =>
    b.evaluate(ext.sessionId, `chrome.tabs.query({}).then(ts => ts.find(t => (t.url || '').startsWith(${JSON.stringify(prefix)}))?.id)`);
  const decisionsSince = async (since) => {
    const map = new Map();
    for (const d of await b.ask(ext.sessionId, "recent")) if (d.at >= since) map.set(d.host, d);
    return map;
  };
  const problems = [];
  const decided = await decisionsSince(t0);
  const settings = await storage("settings");
  const currentRules = await storage("rules");

  for (const [host, d] of decided) {
    if (d.route === "blocked" && !allowBlocked) problems.push(`${host} was blocked`);
    const own = matchRule(currentRules, host);
    if (own && d.route !== own.route && d.route !== "blocked") problems.push(`${host} has its own rule (${own.route}) but went ${d.route}`);
    if (!own && isShared(host) && d.route !== settings.defaultRoute) problems.push(`shared ${host} followed a site (${d.route})`);
  }

  const learned = (await storage("learned")) ?? {};
  for (const h of Object.keys(learned)) if (isShared(h)) problems.push(`shared ${h} was tagged to a site`);

  if (tabPrefix) {
    const tabId = await tabIdOf(tabPrefix);
    const info = await b.ask(ext.sessionId, "tabInfo", { tabId });
    // What the popup claims must match what the helper did.
    const claims = [{ host: info.host, route: info.route }, ...info.hosts];
    for (const c of claims) {
      const d = decided.get(c.host);
      if (d && d.route !== "blocked" && d.route !== c.route) problems.push(`popup says ${c.host} goes ${SERVERS[c.route] ?? c.route}, helper sent it ${SERVERS[d.route] ?? d.route}`);
    }
    // And the popup page itself must show that claim.
    const pop = await b.openPage(`chrome-extension://${EXT_ID}/popup/popup.html?tab=${tabId}`);
    const shown = await until(
      () =>
        b.evaluate(
          pop.sessionId,
          `(() => {
            const pill = document.getElementById('site-status')?.textContent;
            const checked = document.querySelector('.route[aria-checked="true"] .name')?.firstChild?.textContent;
            const rows = [...document.querySelectorAll('#detected-list li')].map(li => [li.querySelector('.h').textContent, li.querySelector('.r').textContent]);
            return pill ? { pill, checked, rows } : null;
          })()`
        ),
      "popup render"
    );
    await b.close(pop);
    const wantPill = info.route === "direct" ? "Not protected" : info.usable ? "Protected" : "Blocked, server down";
    if (shown.pill !== wantPill) problems.push(`popup pill "${shown.pill}", expected "${wantPill}"`);
    const wantChecked = info.rule ? SERVERS[info.rule.route] ?? "Direct" : "Automatic";
    if (shown.checked !== wantChecked) problems.push(`popup has "${shown.checked}" selected, expected "${wantChecked}"`);
    for (const [h, label] of shown.rows) {
      const d = decided.get(h);
      if (d && d.route !== "blocked" && !label.startsWith(SERVERS[d.route] ?? "Direct")) problems.push(`popup row ${h} says "${label}", helper sent it ${SERVERS[d.route]}`);
    }
    // Badge.
    const badge = await b.evaluate(ext.sessionId, `chrome.action.getBadgeText({ tabId: ${tabId} })`);
    // The badge shows the server's short label (its country after a Check),
    // else the first letters of its name.
    const srv = [...((await storage("servers")) ?? []), ...((await storage("groups")) ?? [])].find((x) => x.id === info.route);
    const short = srv ? (srv.label || srv.name.replace(/[^A-Za-z0-9]/g, "").slice(0, 3).toUpperCase() || "VPN").slice(0, 4) : "";
    const wantBadge = info.route === "direct" ? "" : info.usable ? short : "!";
    if (badge !== wantBadge) problems.push(`badge "${badge}", expected "${wantBadge}"`);
  }
  if (problems.length) throw new Error(problems.join("\n"));
  return decided;
}
