// Like sim-probe.mjs but inside the fake WebXR session: runs the default hand timeline and snapshots the
// wave-sim tile around t≈7 s (right hand sweeping under water). Prints the disturbance uniforms too.
import { chromium } from 'playwright';
import { startServer } from './serve.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = path.resolve(process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'tools/harness/out/simxr');
fs.mkdirSync(outDir, { recursive: true });
const fakeSrc = fs.readFileSync(path.join(root, 'tools/harness/fake-xr.js'), 'utf8');

function png(width, height, rgba) {
  const crc = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (width * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const { server, port } = await startServer(root, 0);
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 800 } });
await page.addInitScript(fakeSrc);
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`http://127.0.0.1:${port}/index.html?harness=1`);
await page.waitForFunction(() => window.__nocturne && window.__nocturne.ready, null, { timeout: 90000 });
await page.evaluate(() => window.__nocturne.ready);
await page.evaluate(() => { const c = window.__fakeXR.clock; c.mode = 'manual'; c.step = 0.075; c.time = 0; });
await page.evaluate(() => window.__nocturne.enterXR());
await page.waitForFunction(() => window.__nocturne.stats().xr, null, { timeout: 60000 });
const samples = [];
for (let i = 0; i < 100; i++) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
  const t = await page.evaluate(() => window.__fakeXR.clock.time);
  if (i % 10 === 0) {
    const s = await page.evaluate(() => {
      const c = window.__nocturneCtx; const d = c.water.lastDisturb; const n = c.modules.find((m) => m.name === 'wavesim')._s.mat.uniforms.uCount.value;
      const h = c.hands.right; return { t: c.time.t, dt: c.time.dt, count: n, first: Array.from(d.slice(0, 8)), subR: h.submerged, depthR: h.submergedDepth, speedR: h.speed, radiusIdx: h.joints['index-finger-tip'].radius, radiusWrist: h.joints['wrist'].radius, rigY: c.player.position.y, calm: c.calm };
    });
    samples.push({ fakeT: t, ...s });
  }
  if (t >= 7.5) break;
}
if (process.argv.includes('--debug-water')) {
  await page.evaluate(() => { window.__nocturneCtx.water.uniforms.uDebug.value = 1; });
  for (let i = 0; i < 2; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
  await page.screenshot({ path: path.join(outDir, 'debug_sim.png') });
  await page.evaluate(() => { window.__nocturneCtx.water.uniforms.uDebug.value = 2; });
  for (let i = 0; i < 2; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
  await page.screenshot({ path: path.join(outDir, 'debug_bio.png') });
  await page.evaluate(() => { window.__nocturneCtx.water.uniforms.uDebug.value = 3; });
  for (let i = 0; i < 2; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
  await page.screenshot({ path: path.join(outDir, 'debug_height.png') });
  await page.evaluate(() => { window.__nocturneCtx.water.uniforms.uDebug.value = 0; });
}
const snap = await page.evaluate(() => window.__nocturne.simSnapshot());
fs.writeFileSync(path.join(outDir, 'sim.png'), png(snap.size, snap.size, new Uint8Array(snap.pixels)));
await page.screenshot({ path: path.join(outDir, 'view.png') });
delete snap.pixels;
console.log(JSON.stringify({ samples, snap, errors }, null, 1));
await browser.close();
server.close();
