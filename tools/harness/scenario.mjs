// End-to-end interaction scenario on the fake WebXR device:
//   1. calibrate, 2. grab the nearest lantern, lift it, let go above the water → it rises → a star is born,
//   3. touch the nearest lotus bud → it blooms, 4. hold a hand open and still → a firefly lands.
// Prints a JSON report and exits 1 if any step fails. Usage: node tools/harness/scenario.mjs [--out dir]
import { chromium } from 'playwright';
import { startServer } from './serve.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = path.resolve(process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'tools/harness/out/scenario');
fs.mkdirSync(outDir, { recursive: true });
const fakeSrc = fs.readFileSync(path.join(root, 'tools/harness/fake-xr.js'), 'utf8');

const { server, port } = await startServer(root, 0);
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 800 } });
await page.addInitScript(fakeSrc);
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const report = { steps: [], errors };
const step = (name, ok, info) => { report.steps.push({ name, ok, ...info }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${info ? JSON.stringify(info) : ''}`); };
const frame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
const frames = async (n) => { for (let i = 0; i < n; i++) await frame(); };
const stats = () => page.evaluate(() => window.__nocturne.stats());
const world = () => page.evaluate(() => window.__nocturne.world());
const events = () => page.evaluate(() => window.__nocturne.events());
// hand poses are given in the reference space (rig-local); convert from world by removing the rig offset
const setHand = (hs, world, pinch = 0, extra = {}) => page.evaluate(({ hs, world, pinch, extra }) => {
  const rig = window.__nocturneCtx.player.position;
  window.__fakeXR.setHandPose(hs, { position: [world[0] - rig.x, world[1] - rig.y, world[2] - rig.z], pinch, ...extra });
}, { hs, world, pinch, extra });
const shot = (name) => page.screenshot({ path: path.join(outDir, name) });

try {
  await page.goto(`http://127.0.0.1:${port}/index.html?harness=1`);
  await page.waitForFunction(() => window.__nocturne && window.__nocturne.ready, null, { timeout: 90000 });
  await page.evaluate(() => window.__nocturne.ready);
  await page.evaluate(() => { const c = window.__fakeXR.clock; c.mode = 'manual'; c.step = 1 / 36; c.time = 0; });
  await page.evaluate(() => window.__nocturne.enterXR());
  await page.waitForFunction(() => window.__nocturne.stats().xr, null, { timeout: 60000 });
  // park both hands above the water, in view, still
  await setHand('left', [-0.25, 1.25, -0.4], 0);
  await setHand('right', [0.25, 1.25, -0.4], 0);
  await frames(50);
  let s = await stats();
  step('calibrated', s.calibrated, { rigY: s.player.y, water: s.water, hands: [s.hands.left, s.hands.right] });

  // ---- lantern
  let w = await world();
  const head = w.head;
  const floating = w.lanterns.filter((l) => l.state === 'floating');
  floating.sort((a, b) => Math.hypot(a.x - head[0], a.z - head[2]) - Math.hypot(b.x - head[0], b.z - head[2]));
  const L = floating[0];
  step('lantern-in-reach', !!L && Math.hypot(L.x - head[0], L.z - head[2]) < 1.6, { nearest: L, count: w.lanterns.length });
  if (L) {
    // approach with an open hand, then pinch at the lantern's top
    await setHand('right', [L.x, L.y + 0.12, L.z], 0);
    await frames(12);
    await setHand('right', [L.x, L.y + 0.12, L.z], 1);
    await frames(12);
    let ev = await events();
    const grabbed = ev.some((e) => e.type === 'lanterngrab' || (e.type === 'grab'));
    step('lantern-grabbed', grabbed, { pinch: (await stats()).hands.pinchR, events: ev.filter((e) => e.type.startsWith('lantern') || e.type === 'grab' || e.type === 'pinchmiss').slice(-4) });
    // lift it over ~1 s, then let go above the water
    for (let i = 1; i <= 24; i++) { await setHand('right', [L.x, L.y + 0.12 + 0.35 * i / 24, L.z], 1); await frame(); }
    await shot('lantern_held.png');
    await setHand('right', [L.x, L.y + 0.47, L.z], 0);
    await frames(12);
    ev = await events();
    step('lantern-released', ev.some((e) => e.type === 'lanternrelease'), { events: ev.filter((e) => e.type.startsWith('lantern')).slice(-4) });
    // move the hand away and let time pass: the lantern should rise and become a star (≈ 25–30 s)
    await setHand('right', [0.25, 1.25, -0.4], 0);
    await page.evaluate(() => { window.__fakeXR.clock.step = 0.1; });
    for (let i = 0; i < 360; i++) { await frame(); if (i === 60) await shot('lantern_rising.png'); }
    s = await stats(); ev = await events();
    step('lantern-star', ev.some((e) => e.type === 'lanternstar') && s.lanternStars >= 1, { lanternStars: s.lanternStars, energy: +s.energy.toFixed(2), aurora: +(s.aurora || 0).toFixed(2) });
    await page.evaluate(() => { window.__fakeXR.clock.step = 1 / 36; });
  }

  // ---- lotus
  w = await world();
  const buds = w.lotus.filter((f) => !f.open);
  buds.sort((a, b) => Math.hypot(a.x - head[0], a.z - head[2]) - Math.hypot(b.x - head[0], b.z - head[2]));
  const B = buds[0];
  step('lotus-in-reach', !!B && Math.hypot(B.x - head[0], B.z - head[2]) < 2.2, { nearest: B, count: w.lotus.length });
  if (B) {
    // the pose is the wrist; fingers point -Z, so put the wrist ~16 cm behind the bud and lower the fingertips onto it
    await setHand('right', [B.x, B.y + 0.3, B.z + 0.16], 0);
    await frames(10);
    for (let i = 1; i <= 20; i++) { await setHand('right', [B.x, B.y + 0.3 - 0.24 * i / 20, B.z + 0.16], 0); await frame(); }
    await frames(30);
    const ev = await events();
    s = await stats();
    step('lotus-bloomed', ev.some((e) => e.type === 'lotusbloom'), { lotusOpen: s.lotusOpen, events: ev.filter((e) => e.type === 'lotusbloom').slice(-2) });
    await shot('lotus.png');
  }

  // ---- fireflies: open hand, palm up, still for ~4 s
  await setHand('right', [0.3, 1.3, -0.45], 0, { pitchDeg: 0, rollDeg: 180 });
  await setHand('left', [-0.3, 1.3, -0.45], 0, { pitchDeg: 0, rollDeg: -180 });
  for (let i = 0; i < 200; i++) await frame();
  s = await stats();
  const ev = await events();
  step('firefly-landed', ev.some((e) => e.type === 'fireflyland') || (s.fireflyLanded || 0) > 0, { fireflyLanded: s.fireflyLanded, stillL: await page.evaluate(() => { const h = window.__nocturneCtx.hands.right; return { still: h.still, stillFor: +h.stillFor.toFixed(2), open: h.open, attraction: +h.attraction.toFixed(2), disp: +h.stillDisp.toFixed(3) }; }) });
  await shot('fireflies.png');

  // ---- wading: a palm-aligned stroke under water should move the rig
  const before = (await world()).rig;
  await page.evaluate(() => window.__fakeXR.clearOverrides?.());
  await setHand('right', [0.3, 0.7, -0.45], 0, { pitchDeg: 0, rollDeg: -90 }); // palm facing -x
  await frames(6);
  for (let i = 1; i <= 30; i++) { await setHand('right', [0.3 - 0.6 * i / 30, 0.7, -0.45], 0, { pitchDeg: 0, rollDeg: -90 }); await frame(); }
  await frames(30);
  const after = (await world()).rig;
  const moved = Math.hypot(after.x - before.x, after.z - before.z);
  step('wading-moves-rig', moved > 0.05, { moved: +moved.toFixed(3), before: [before.x, before.z].map((v) => +v.toFixed(2)), after: [after.x, after.z].map((v) => +v.toFixed(2)) });

  // ---- pinch-and-pull: an empty pinch grabs the world; pulling the hand toward the body moves you forward.
  // The hand is driven in reference-space (rig-local) coordinates here, like a real hand: it moves with the body.
  {
    const b0 = (await world()).rig;
    await page.evaluate(() => window.__fakeXR.clearOverrides?.());
    const local = (z, pinch) => page.evaluate(({ z, pinch }) => window.__fakeXR.setHandPose('right', { position: [0.1, 1.25, z], pinch }), { z, pinch });
    await local(-0.55, 0);
    await frames(8);
    await local(-0.55, 1);
    await frames(6);
    for (let i = 1; i <= 24; i++) { await local(-0.55 + 0.4 * i / 24, 1); await frame(); }
    await local(-0.15, 0);
    await frames(20);
    const b1 = (await world()).rig;
    const fwdMoved = b0.z - b1.z; // pulling the world toward you (+z hand motion) carries the rig forward (−z)
    // 0.4 m of pull one-to-one, plus a short glide from the release momentum — never a runaway
    step('pinch-pull-moves-rig', fwdMoved > 0.35 && fwdMoved < 1.2, { forward: +fwdMoved.toFixed(3), before: [b0.x, b0.z].map((v) => +v.toFixed(2)), after: [b1.x, b1.z].map((v) => +v.toFixed(2)) });
  }

  s = await stats();
  report.final = { drawCalls: s.drawCalls, triangles: s.triangles, energy: s.energy, errors: s.errors };
} catch (err) {
  report.exception = String(err?.stack || err);
  console.error(err);
}
report.events = await events().catch(() => []);
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 1));
const ok = report.steps.every((st) => st.ok) && errors.length === 0 && !report.exception;
console.log(`[scenario] ${ok ? 'PASS' : 'FAIL'} — ${report.steps.filter((x) => x.ok).length}/${report.steps.length} steps, ${errors.length} error(s)`);
await browser.close();
server.close();
process.exit(ok ? 0 : 1);
