// usage.js: data through each server today, from the helper's running byte
// counters. The helper counts since each tunnel started; this keeps a daily
// total that survives tunnels restarting and the background worker sleeping.

/** Today's date on this computer, "YYYY-MM-DD". */
export function dayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Add what each tunnel moved since the last look.
 * @param usage   {day, bytes: {id: n}, last: {id: total}}
 * @param tunnels {id: {rxBytes, txBytes}}
 * @returns a new usage object
 */
export function addUsage(usage, tunnels, today = dayKey()) {
  const out = {
    day: today,
    bytes: usage?.day === today ? { ...usage.bytes } : {},
    last: { ...(usage?.last ?? {}) },
  };
  for (const [id, t] of Object.entries(tunnels ?? {})) {
    if (t?.rxBytes == null && t?.txBytes == null) continue;
    const total = (t.rxBytes ?? 0) + (t.txBytes ?? 0);
    const prev = out.last[id];
    // First sight: start counting from here. Counters going backwards mean
    // the tunnel restarted, so everything it shows is new.
    const moved = prev == null ? 0 : total >= prev ? total - prev : total;
    if (moved > 0) out.bytes[id] = (out.bytes[id] ?? 0) + moved;
    out.last[id] = total;
  }
  return out;
}

/** Below this, "today" isn't worth showing: it's only keep-alive chatter. */
export const SHOW_FROM_BYTES = 1024 * 1024;

/** "820 KB", "14 MB", "1.2 GB". */
export function bytesText(n) {
  if (!n || n < 1024) return n ? `${n} B` : "0 MB";
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i < 2 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
