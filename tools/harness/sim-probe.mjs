// Probes the wave simulation: runs the app in desktop mode, sweeps the virtual hand through the water for a
// few seconds, then dumps the sim texture (R = height, G = afterglow, B = energy) as a PNG plus stats.
// Usage: node tools/harness/sim-probe.mjs [--out dir]
import { chromium } from 'playwright';
import { startServer } from './serve.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = path.resolve(process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'tools/harness/out/sim');
fs.mkdirSync(outDir, { recursive: true });

function png(width, height, rgba) {
  const crc = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (width * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const { server, port } = await startServer(root, 0);
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`http://127.0.0.1:${port}/index.html?harness=1`);
await page.waitForFunction(() => window.__nocturne && window.__nocturne.ready, null, { timeout: 90000 });
await page.evaluate(() => window.__nocturne.ready);
await page.evaluate(() => window.__nocturne.look(0, -35));
// sweep the submerged hand left-right for ~3 s of app time (frames are slow under SwiftShader)
const N = Number(process.argv.includes('--frames') ? process.argv[process.argv.indexOf('--frames') + 1] : 120);
let lastFrame = await page.evaluate(() => window.__nocturne.stats().frame);
for (let i = 0; i < N; i++) {
  const x = 0.35 + 0.3 * Math.sin(i / N * Math.PI * 3);
  await page.evaluate((x) => window.__nocturne.setHand({ x, y: 0.62, pinch: false, submerged: true }), x);
  // advance exactly one rendered frame
  lastFrame = await page.evaluate((f) => new Promise((res) => { const tick = () => { const n = window.__nocturne.stats().frame; if (n > f) res(n); else requestAnimationFrame(tick); }; tick(); }), lastFrame);
}
const stats = await page.evaluate(() => { const s = window.__nocturne.stats(); return { frame: s.frame, fps: s.fps, submergedR: s.hands.submergedR, dt: window.__nocturneCtx.time.dt }; });
const snap = await page.evaluate(() => window.__nocturne.simSnapshot());
const rgba = new Uint8Array(snap.pixels);
fs.writeFileSync(path.join(outDir, 'sim.png'), png(snap.size, snap.size, rgba));
await page.screenshot({ path: path.join(outDir, 'view.png') });
delete snap.pixels;
console.log(JSON.stringify({ stats, snap, errors }, null, 1));
await browser.close();
server.close();
