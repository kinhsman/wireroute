// Builds the extension icons from design/dragon.png: the dragon in white on a
// red shield. Renders in headless Chrome (canvas), so no image libraries needed.
//
//   node tools/make-icons.js

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SIZES = [16, 32, 48, 128, 512];

const src = "data:image/png;base64," + readFileSync(join(ROOT, "design", "dragon.png")).toString("base64");

// Runs inside the page. Returns {size: dataURL}.
const render = `(async () => {
  const img = new Image();
  img.src = ${JSON.stringify(src)};
  await img.decode();

  // 1. Dragon: dark pixels become white, with alpha from how dark they were.
  const a = document.createElement("canvas");
  a.width = img.width; a.height = img.height;
  const ac = a.getContext("2d");
  ac.drawImage(img, 0, 0);
  const px = ac.getImageData(0, 0, a.width, a.height);
  let minX = a.width, minY = a.height, maxX = 0, maxY = 0;
  for (let i = 0; i < px.data.length; i += 4) {
    const lum = 0.299 * px.data[i] + 0.587 * px.data[i + 1] + 0.114 * px.data[i + 2];
    const alpha = Math.max(0, Math.min(255, (255 - lum) * 1.15)) * (px.data[i + 3] / 255);
    px.data[i] = px.data[i + 1] = px.data[i + 2] = 255;
    px.data[i + 3] = alpha;
    if (alpha > 40) {
      const p = i / 4, x = p % a.width, y = (p / a.width) | 0;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  ac.putImageData(px, 0, 0);
  const dw = maxX - minX + 1, dh = maxY - minY + 1;

  // 2. Master at 1024: red shield + dragon.
  const S = 1024, k = S / 128;
  const m = document.createElement("canvas");
  m.width = m.height = S;
  const c = m.getContext("2d");
  const shield = new Path2D();
  shield.moveTo(64 * k, 4 * k);
  shield.bezierCurveTo(80 * k, 12 * k, 98 * k, 16 * k, 116 * k, 16 * k);
  shield.lineTo(116 * k, 58 * k);
  shield.bezierCurveTo(116 * k, 92 * k, 94 * k, 113 * k, 64 * k, 125 * k);
  shield.bezierCurveTo(34 * k, 113 * k, 12 * k, 92 * k, 12 * k, 58 * k);
  shield.lineTo(12 * k, 16 * k);
  shield.bezierCurveTo(30 * k, 16 * k, 48 * k, 12 * k, 64 * k, 4 * k);
  shield.closePath();

  const g = c.createLinearGradient(0, 4 * k, 0, 125 * k);
  g.addColorStop(0, "#ef3b3b");
  g.addColorStop(1, "#b3141b");
  c.fillStyle = g;
  c.fill(shield);
  c.lineWidth = 4 * k;
  c.strokeStyle = "#8c0f14";
  c.save(); c.clip(shield); c.stroke(shield); c.restore();
  // soft top highlight
  c.save(); c.clip(shield);
  const hl = c.createLinearGradient(0, 4 * k, 0, 60 * k);
  hl.addColorStop(0, "rgba(255,255,255,0.18)");
  hl.addColorStop(1, "rgba(255,255,255,0)");
  c.fillStyle = hl; c.fillRect(0, 0, S, 60 * k);
  c.restore();

  const box = 76 * k;
  const scale = Math.min(box / dw, box / dh);
  const w = dw * scale, h = dh * scale;
  c.imageSmoothingQuality = "high";
  c.drawImage(a, minX, minY, dw, dh, (S - w) / 2 + 2 * k, 60 * k - h / 2 + 2 * k, w, h);

  // 3. Downscale in halving steps for crisp small sizes.
  const out = {};
  for (const size of ${JSON.stringify(SIZES)}) {
    let cur = m;
    while (cur.width / 2 >= size) {
      const n = document.createElement("canvas");
      n.width = n.height = cur.width / 2;
      const nc = n.getContext("2d");
      nc.imageSmoothingQuality = "high";
      nc.drawImage(cur, 0, 0, n.width, n.height);
      cur = n;
    }
    const f = document.createElement("canvas");
    f.width = f.height = size;
    const fc = f.getContext("2d");
    fc.imageSmoothingQuality = "high";
    fc.drawImage(cur, 0, 0, size, size);
    out[size] = f.toDataURL("image/png");
  }
  return out;
})()`;

const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-pipe", `--user-data-dir=${join(ROOT, ".icon-profile")}`, "about:blank"], {
  stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
});
let id = 0;
let buf = "";
const waiting = new Map();
chrome.stdio[4].on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\0")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (waiting.has(msg.id)) waiting.get(msg.id)(msg);
  }
});
const cdp = (method, params = {}, sessionId) =>
  new Promise((res) => {
    const n = ++id;
    waiting.set(n, res);
    chrome.stdio[3].write(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
  });

try {
  const { result: { targetId } } = await cdp("Target.createTarget", { url: "about:blank" });
  const { result: { sessionId } } = await cdp("Target.attachToTarget", { targetId, flatten: true });
  const r = await cdp("Runtime.evaluate", { expression: render, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  const urls = r.result.result.value;
  for (const size of SIZES) {
    const png = Buffer.from(urls[size].split(",")[1], "base64");
    const dest = size === 512 ? join(ROOT, "design", "icon-512.png") : join(ROOT, "extension", "icons", `icon-${size}.png`);
    writeFileSync(dest, png);
    console.log("wrote", dest);
  }
} finally {
  chrome.kill("SIGKILL");
}
