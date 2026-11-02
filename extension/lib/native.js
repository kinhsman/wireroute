// native.js: talks to the helper app over Chrome native messaging.
//
// Requests carry an id the helper echoes back. Messages without an id are
// events (tunnel state changes). Chrome starts the helper on connect and stops
// it when the port closes.

const HOST = "com.wireroute.host";

let port = null;
let nextId = 1;
const pending = new Map();
const listeners = new Set();
let missing = false;

export function isConnected() {
  return port !== null;
}

export function isMissing() {
  return missing;
}

export function onEvent(cb) {
  listeners.add(cb);
}

function emit(msg) {
  for (const cb of listeners) {
    try {
      cb(msg);
    } catch (e) {
      console.error(e);
    }
  }
}

/** Connect if not already. Resolves true once the helper answers a ping. */
export async function connect() {
  if (port) return true;
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch (e) {
    missing = true;
    port = null;
    return false;
  }
  port.onMessage.addListener((msg) => {
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.type === "error") reject(new Error(msg.error));
      else resolve(msg);
      return;
    }
    emit(msg);
  });
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message ?? "";
    // "Specified native messaging host not found" means it isn't installed.
    if (/not found|forbidden/i.test(err)) missing = true;
    port = null;
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error("The helper stopped"));
    }
    pending.clear();
    emit({ type: "disconnected", error: err });
  });
  try {
    await request({ cmd: "ping" }, 5000);
    missing = false;
    return true;
  } catch {
    return false;
  }
}

export function request(msg, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (!port) {
      reject(new Error("The helper isn't running"));
      return;
    }
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("The helper didn't answer"));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
      port.postMessage({ ...msg, id });
    } catch (e) {
      pending.delete(id);
      clearTimeout(timer);
      reject(e);
    }
  });
}

/** Fire and forget (hints). */
export function send(msg) {
  if (!port) return;
  try {
    port.postMessage(msg);
  } catch {
    /* port closing; the disconnect handler cleans up */
  }
}
