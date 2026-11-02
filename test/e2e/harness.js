// Shared plumbing for the end-to-end tests: installs the helper, runs fake
// WireGuard servers, and drives a throwaway Chrome profile over the DevTools
// protocol. Nothing here touches your normal Chrome profile or the Mac's network.

import { spawn, execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseConf } from "../../extension/lib/conf.js";

export const ROOT = resolve(import.meta.dirname, "../..");
export const EXT_ID = "kbmajebcnniiphhhhhgafeipmpibcnjc";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
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

/** Install the helper and start fake servers. Returns {tmp, confs}. */
export async function setup(serverNames = ["A", "B"]) {
  tmpRoot = mkdtempSync(join(tmpdir(), "wireroute-e2e-"));
  console.log("installing helper and building fake servers");
  // Chrome on macOS only finds helpers registered in its standard folder, so
  // the test installs the current helper the normal way first.
  execFileSync(join(ROOT, "install", "install.sh"), { stdio: "ignore" });
  execFileSync("go", ["build", "-o", join(tmpRoot, "fakevpn"), "./cmd/fakevpn"], { cwd: join(ROOT, "host"), stdio: "inherit" });
  const confs = {};
  if (serverNames.length) {
    const fake = spawn(join(tmpRoot, "fakevpn"), ["-dir", tmpRoot, ...serverNames], { stdio: ["ignore", "pipe", "inherit"] });
    procs.push(fake);
    await new Promise((res) => fake.stdout.on("data", (b) => String(b).includes("ready") && res()));
    for (const n of serverNames) confs[n] = parseConf(readFileSync(join(tmpRoot, `${n}.conf`), "utf8"));
  }
  return { tmp: tmpRoot, confs };
}

/** A throwaway Chrome you can close and start again on the same profile. */
export class Browser {
  constructor(profile) {
    this.profile = profile;
    mkdirSync(join(profile, "NativeMessagingHosts"), { recursive: true });
    // A Chrome with its own profile folder reads helper registrations from there.
    copyFileSync(
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
