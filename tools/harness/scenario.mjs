// End-to-end interaction scenario on the fake WebXR device:
//   1. calibrate, 2. grab the nearest lantern, lift it, let go above the water → it rises → a star is born; brush an open
//      hand sideways through the next floating lantern → it is nudged away (no grab, no pull),
//   3. hold a fingertip still above the nearest lotus bud → it leans, whispers and opens by itself; hovering too high does
//      nothing; touch the next bud → it blooms; set a lantern down among the next closed cluster's pads → it warms the bud open,
//   4. hold a hand open and still → a firefly lands, 4a. carry them to a lantern and let it go → they escort it up, spill and
//      kick their cloud into step; its star sends a wave of flashes across the lake, 4b. move an open hand slowly → fireflies
//      follow it in a ribbon and hand off to a still hand, 4c. a palm resting flat on the water hushes it,
//   5. locomotion: a stroke does nothing, a missed pinch does nothing, pinch-and-pull moves, two hands turn, 6. palms together → leave.
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

  // ---- touch and nudge: an open hand, fingers along -X, swept sideways through the nearest floating lantern pushes it
  // away along -X and fires 'lanterntouch'; nothing is pinched, grabbed or pulled, so the rig stays put
  {
    w = await world();
    const hd = w.head, rig0 = w.rig;
    const fl = w.lanterns.map((l, index) => ({ ...l, index })).filter((l) => l.state === 'floating');
    fl.sort((a, b) => Math.hypot(a.x - hd[0], a.z - hd[2]) - Math.hypot(b.x - hd[0], b.z - hd[2]));
    const LN = fl[0];
    step('lantern-nudge-ready', !!LN, { lantern: LN });
    if (LN) {
      const brush = { yawDeg: 90, pitchDeg: 0, rollDeg: 0, curl: 0.05 }; // wrist east of the hull, fingertips 0.175 m along -X
      const n0 = (await events()).length;
      await setHand('right', [LN.x + 0.32, LN.y + 0.02, LN.z], 0, brush);
      await frames(8);
      const L0 = (await world()).lanterns[LN.index];
      let minX = L0.x;
      const sample = async () => { minX = Math.min(minX, (await world()).lanterns[LN.index].x); };
      // sweep the wrist from +0.32 to +0.05 over 20 frames (≈0.49 m/s): the fingers pass through the body
      for (let i = 1; i <= 20; i++) { await setHand('right', [LN.x + 0.32 - 0.27 * i / 20, LN.y + 0.02, LN.z], 0, brush); await frame(); if (i % 2 === 0) await sample(); }
      for (let i = 1; i <= 10; i++) { await frame(); if (i % 2 === 0) await sample(); }
      const ev = (await events()).slice(n0);
      s = await stats();
      const w1 = await world();
      const touch = ev.find((e) => e.type === 'lanterntouch' && e.detail?.speed > 0.2 && e.detail?.hand === 'right');
      const stray = ev.filter((e) => e.type === 'grab' || e.type === 'pinchmiss');
      const rigMoved = Math.hypot(w1.rig.x - rig0.x, w1.rig.z - rig0.z);
      step('lantern-nudged', !!touch && minX < L0.x - 0.10 && s.hands.pinchR === false && stray.length === 0 && rigMoved < 0.005,
        { index: LN.index, x0: L0.x, minX: +minX.toFixed(3), pushed: +(L0.x - minX).toFixed(3), touch: touch?.detail, pinchR: s.hands.pinchR, stray: stray.length, rigMoved: +rigMoved.toFixed(4), lantern: w1.lanterns[LN.index] });
      await shot('lantern_nudged.png');
      await setHand('right', [0.25, 1.25, -0.4], 0, { curl: 0.6 });
      await frames(30);
      s = await stats();
      const w2 = await world();
      step('lantern-nudge-settles', (s.lanternTouches || 0) >= 1 && w2.lanterns[LN.index].state === 'floating', { touches: s.lanternTouches, lantern: w2.lanterns[LN.index] });
    }
  }

  // ---- lotus, by patience: a still fingertip 9–22 cm above a closed bud makes it lean, stir and open on its own
  {
    w = await world();
    const closed = w.lotus.filter((f) => !f.open);
    closed.sort((a, b) => Math.hypot(a.x - head[0], a.z - head[2]) - Math.hypot(b.x - head[0], b.z - head[2]));
    const B = closed[0], C = closed[1];
    const budIdx = (b) => w.lotus.indexOf(b);
    const hover = { pitchDeg: 0, rollDeg: 0, curl: 0.15 };
    // the pose is the wrist; with the fake skeleton the index/middle tips end ~15 cm above the pod and 1–3 cm off axis:
    // inside the hover band, outside the 8 cm touch radius
    await setHand('right', [B.x, B.y + 0.18, B.z + 0.175], 0, hover);
    await frames(20);
    let lw = await world();
    step('lotus-leans', lw.lotus[budIdx(B)].lean >= 0.15, { index: budIdx(B), lean: lw.lotus[budIdx(B)].lean, state: lw.lotus[budIdx(B)].state });
    await frames(100); // still after 0.5 s, stir at ~1.1 s, open at ~2.5 s
    let ev = await events();
    lw = await world();
    const iStir = ev.findIndex((e) => e.type === 'lotusstir' && e.detail?.index === budIdx(B));
    const iBloom = ev.findIndex((e) => e.type === 'lotusbloom' && e.detail?.index === budIdx(B) && e.detail?.cause === 'patient');
    step('lotus-patient-open', iStir >= 0 && iBloom > iStir && lw.lotus[budIdx(B)].open === true, { index: budIdx(B), stirAt: ev[iStir]?.t, bloomAt: ev[iBloom]?.t, events: ev.filter((e) => e.type === 'lotusstir' || e.type === 'lotusbloom').slice(-3) });
    await shot('lotus_patient.png');
    // negative: hovering too high (≈30 cm above the pod) leans the bud a little but never opens it
    if (C) {
      const n0 = ev.filter((e) => e.type === 'lotusbloom' && e.detail?.index === budIdx(C)).length;
      await setHand('right', [C.x, C.y + 0.33, C.z + 0.175], 0, hover);
      await frames(110);
      ev = await events();
      lw = await world();
      const n1 = ev.filter((e) => e.type === 'lotusbloom' && e.detail?.index === budIdx(C)).length;
      step('lotus-too-high-stays-closed', n1 === n0 && lw.lotus[budIdx(C)].open === false, { index: budIdx(C), lean: lw.lotus[budIdx(C)].lean, hoverT: await page.evaluate((i) => +window.__nocturneCtx.lotus.flowers[i].hoverT.toFixed(2), budIdx(C)) });
    }
    await setHand('right', [0.25, 1.25, -0.4], 0, { curl: 0.6 });
    await frames(10);
  }

  // ---- lotus, by touch (the next closed bud)
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

  // ---- lantern among the lily pads: carry a lantern to the nearest closed cluster and let it go in the water;
  // the pads hold it and its light warms the bud open (slowly) without any fingertip coming near the pod
  {
    w = await world();
    const hd = w.head, level = (await stats()).water;
    const closed = w.lotus.map((f, index) => ({ ...f, index })).filter((f) => !f.open);
    closed.sort((a, b) => Math.hypot(a.x - hd[0], a.z - hd[2]) - Math.hypot(b.x - hd[0], b.z - hd[2]));
    const fl = w.lanterns.map((l, index) => ({ ...l, index })).filter((l) => l.state === 'floating');
    fl.sort((a, b) => Math.hypot(a.x - hd[0], a.z - hd[2]) - Math.hypot(b.x - hd[0], b.z - hd[2]));
    const B = closed[0], L2 = fl[0];
    step('lantern-lotus-ready', !!B && !!L2, { bud: B, lantern: L2 });
    if (B && L2) {
      const grip = { pitchDeg: 0, rollDeg: 0, curl: 0.1 };
      const grabs0 = (await events()).filter((e) => e.type === 'grab').length;
      const G = [L2.x, L2.y + 0.12, L2.z];
      await setHand('right', G, 0, grip);
      await frames(12);
      await setHand('right', G, 1, grip);
      await frames(12);
      let ev = await events();
      step('lantern-lotus-grabbed', ev.filter((e) => e.type === 'grab').length > grabs0, { events: ev.filter((e) => e.type === 'grab' || e.type === 'pinchmiss' || e.type === 'lanterngrab').slice(-3) });
      // the pinch point is ~13.5 cm ahead (-z) of the wrist: aim it 0.33 m beyond the bud, on the far side from the head,
      // carrying high so no fingertip passes within 8 cm of any pod, then lower it until the lantern's bottom is under water
      const ul = Math.hypot(B.x - hd[0], B.z - hd[2]) || 1;
      const u = [(B.x - hd[0]) / ul, (B.z - hd[2]) / ul];
      const Tx = B.x + 0.33 * u[0], Tz = B.z + 0.33 * u[1] + 0.135;
      const hi = [Tx, level + 0.40, Tz], lo = [Tx, level + 0.10, Tz];
      for (let i = 1; i <= 48; i++) { const k = i / 48; await setHand('right', [G[0] + (hi[0] - G[0]) * k, G[1] + (hi[1] - G[1]) * k, G[2] + (hi[2] - G[2]) * k], 1, grip); await frame(); }
      for (let i = 1; i <= 18; i++) { const k = i / 18; await setHand('right', [Tx, hi[1] + (lo[1] - hi[1]) * k, Tz], 1, grip); await frame(); }
      await frames(6);
      const splashes0 = (await events()).filter((e) => e.type === 'lanternsplash').length;
      await setHand('right', lo, 0, grip);
      await frames(6);
      ev = await events();
      const lw = await world();
      step('lantern-lotus-set-down', ev.filter((e) => e.type === 'lanternsplash').length > splashes0 && lw.lanterns[L2.index].state === 'floating', { lantern: lw.lanterns[L2.index], events: ev.filter((e) => e.type.startsWith('lantern')).slice(-3) });
      await setHand('right', [0.25, 1.25, -0.4], 0, { curl: 0.6 });
      await frames(144); // 4 s: warmth needs 2.5 s, then the bud opens over 5 s
      ev = await events();
      const fw = await world();
      const warm = await page.evaluate((i) => { const f = window.__nocturneCtx.lotus.flowers[i]; return { warm: +f.warm.toFixed(2), near: f.warmNear, lanternIdx: f.lanternIdx, openSeconds: f.openSeconds }; }, B.index);
      const bloom = ev.find((e) => e.type === 'lotusbloom' && e.detail?.cause === 'lantern' && e.detail?.index === B.index);
      step('lantern-warms-lotus', !!bloom && fw.lotus[B.index].open && fw.lotus[B.index].bloom < 1 && fw.lanterns[L2.index].pads === true && warm.warm > 2.5,
        { index: B.index, bloomAt: bloom?.t, flower: fw.lotus[B.index], lantern: fw.lanterns[L2.index], ...warm });
      await shot('lantern_lotus.png');
    }
  }

  // ---- fireflies: open hand, palm up, still for ~4 s
  await setHand('right', [0.3, 1.3, -0.45], 0, { pitchDeg: 0, rollDeg: 180 });
  await setHand('left', [-0.3, 1.3, -0.45], 0, { pitchDeg: 0, rollDeg: -180 });
  for (let i = 0; i < 200; i++) await frame();
  s = await stats();
  const ev = await events();
  step('firefly-landed', ev.some((e) => e.type === 'fireflyland') || (s.fireflyLanded || 0) > 0, { fireflyLanded: s.fireflyLanded, stillL: await page.evaluate(() => { const h = window.__nocturneCtx.hands.right; return { still: h.still, stillFor: +h.stillFor.toFixed(2), open: h.open, attraction: +h.attraction.toFixed(2), disp: +h.stillDisp.toFixed(3) }; }) });
  await shot('fireflies.png');

  // ---- the escort, and the lake passes it on: carry the fireflies resting on the palm-up hand to the nearest floating
  // lantern, lift it and let it go: they lift off with it ('fireflyescort'), spill ~4 s up ('fireflyspill') and kick their
  // cloud into step; when that lantern becomes a star, a wave of flashes crosses the lake from the player ('lakewave')
  {
    w = await world();
    const hd = w.head;
    const fl = w.lanterns.map((l, index) => ({ ...l, index })).filter((l) => l.state === 'floating');
    fl.sort((a, b) => Math.hypot(a.x - hd[0], a.z - hd[2]) - Math.hypot(b.x - hd[0], b.z - hd[2]));
    const L2 = fl[0];
    step('escort-lantern-ready', !!L2 && (s.fireflyLanded || 0) > 0, { lantern: L2, fireflyLanded: s.fireflyLanded });
    if (L2) {
      const up = { pitchDeg: 0, rollDeg: 180, curl: 0.02 };
      const live = async () => { const l = (await world()).lanterns[L2.index]; return [l.x, l.y + 0.15, l.z + 0.10]; };
      // glide the wrist over (<= 0.3 m/s so the landed fireflies stay), then correct for the lantern's drift on the way
      const from = [0.3, 1.3, -0.45];
      let to = [L2.x, L2.y + 0.15, L2.z + 0.10];
      let dist = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
      let n = Math.max(144, Math.ceil(dist / 0.28 * 36));
      for (let i = 1; i <= n; i++) { const k = i / n; await setHand('right', [from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k, from[2] + (to[2] - from[2]) * k], 0, up); await frame(); }
      const at = to, now = await live();
      dist = Math.hypot(now[0] - at[0], now[1] - at[1], now[2] - at[2]);
      if (dist > 0.02) { n = Math.max(6, Math.ceil(dist / 0.25 * 36)); for (let i = 1; i <= n; i++) { const k = i / n; await setHand('right', [at[0] + (now[0] - at[0]) * k, at[1] + (now[1] - at[1]) * k, at[2] + (now[2] - at[2]) * k], 0, up); await frame(); } to = now; }
      const landedBefore = (await stats()).fireflyLanded;
      const grabs0 = (await events()).filter((e) => e.type === 'grab').length;
      for (let i = 1; i <= 24; i++) { await setHand('right', to, i / 24, up); await frame(); }
      await frames(4);
      let ev = await events();
      s = await stats();
      step('escort-lantern-grabbed', ev.filter((e) => e.type === 'grab').length > grabs0 && (s.fireflyLanded || 0) > 0,
        { landedBefore, fireflyLanded: s.fireflyLanded, events: ev.filter((e) => e.type === 'grab' || e.type === 'pinchmiss' || e.type === 'lanterngrab').slice(-3) });
      const n0 = ev.length;
      // lift it 0.40 m over 1.5 s and let go at the top
      for (let i = 1; i <= 54; i++) { await setHand('right', [to[0], to[1] + 0.40 * i / 54, to[2]], 1, up); await frame(); }
      await setHand('right', [to[0], to[1] + 0.40, to[2]], 0, up);
      await frames(4);
      ev = await events(); s = await stats();
      const esc = ev.slice(n0).find((e) => e.type === 'fireflyescort');
      const lw0 = (await world()).lanterns[L2.index];
      step('firefly-escort', !!esc && esc.detail?.count >= 1 && (s.fireflyEscorting || 0) >= 1, { escort: esc?.detail, escorting: s.fireflyEscorting, lantern: lw0, released: ev.slice(n0).some((e) => e.type === 'lanternrelease') });
      await shot('escort.png');
      // park the hand; ~4.2 s up the escort spills
      await setHand('right', [0.25, 1.25, -0.4], 0, { curl: 0.6 });
      await frames(180);
      ev = await events(); s = await stats();
      const spill = ev.slice(n0).find((e) => e.type === 'fireflyspill');
      const kicked = await page.evaluate(() => window.__nocturneCtx.fireflies.kickedCloud);
      step('firefly-spill', !!spill && s.fireflyEscorting === 0, { spill: spill?.detail, escorting: s.fireflyEscorting, kickedCloud: kicked, lantern: (await world()).lanterns[L2.index] });
      // the kicked cloud locks into a common flash within a few seconds (fast clock)
      await page.evaluate(() => { window.__fakeXR.clock.step = 0.1; });
      let cohMax = 0;
      for (let i = 0; i < 80; i++) {
        await frame();
        const coh = await page.evaluate(() => { const f = window.__nocturneCtx.fireflies; return f.kickedCloud >= 0 ? f.coherence[f.kickedCloud] : 0; });
        cohMax = Math.max(cohMax, coh);
        if (coh > 0.5) break;
      }
      step('spill-kicks-the-cloud', cohMax > 0.5, { coherence: +cohMax.toFixed(3), kickedCloud: kicked });
      // keep stepping until that lantern becomes a star; the lake answers 0.8 s later
      const stars0 = ev.filter((e) => e.type === 'lanternstar').length;
      const tBefore = await page.evaluate(() => window.__nocturneCtx.time.t);
      let starred = false;
      for (let i = 0; i < 320 && !starred; i++) { await frame(); if (i % 4 === 3) starred = (await events()).filter((e) => e.type === 'lanternstar').length > stars0; }
      await page.evaluate(() => { window.__fakeXR.clock.step = 1 / 36; });
      let fired = false;
      for (let i = 0; i < 40 && !fired; i++) { await frame(); fired = await page.evaluate((tb) => { const wv = window.__nocturneCtx.fireflies.wave; return wv.fired && wv.t0 > tb; }, tBefore); }
      const wv = await page.evaluate(() => { const x = window.__nocturneCtx.fireflies.wave; return { count: x.count, t0: +x.t0.toFixed(2), sample: Array.from(x.sample), sampleT: Array.from(x.sampleT) }; });
      // every sampled firefly of cloud 0 should peak (> 0.6) within 0.12 s of the moment the 2.5 m/s front reaches it
      const peaks = new Array(wv.sample.length).fill(-1);
      for (let i = 0; i < 150; i++) {
        await frame();
        const r = await page.evaluate((st) => { const c = window.__nocturneCtx; const t = c.time.t, b = c.fireflies.brightness; return st.sample.map((idx, k) => (idx >= 0 && Math.abs(t - st.sampleT[k]) <= 0.12 ? b[idx] : -1)); }, wv);
        for (let k = 0; k < r.length; k++) if (r[k] > peaks[k]) peaks[k] = r[k];
      }
      const nSamples = wv.sample.filter((i) => i >= 0).length;
      const peaked = peaks.filter((v) => v > 0.6).length;
      ev = await events();
      const lwEv = ev.slice(n0).find((e) => e.type === 'lakewave' && e.t > tBefore);
      const lotusWave = await page.evaluate(() => { const f = window.__nocturneCtx.lotus.flowers; return { anyOpen: f.some((x) => x.open), anyWave: f.some((x) => x.waveAt > 0), waveAt: f.map((x) => +x.waveAt.toFixed(2)) }; });
      step('lake-wave', starred && fired && !!lwEv && lwEv.detail?.count >= 100 && nSamples > 0 && peaked >= 0.75 * nSamples && (lotusWave.anyOpen ? lotusWave.anyWave : true),
        { starred, fired, wave: lwEv?.detail, count: wv.count, t0: wv.t0, samples: nSamples, peaked, peaks: peaks.map((v) => +v.toFixed(2)), lotus: lotusWave });
      await shot('lake_wave.png');
    }
  }

  // ---- the ribbon: an open hand carried slowly sideways, palm up, gathers a strand of fireflies behind it; stopping hands them over
  {
    await setHand('right', [0.2, 1.25, -0.45], 0, { curl: 0.6 });                            // close the hand: the landed fireflies leave
    await frames(30);
    await setHand('right', [0.25, 1.25, -0.4], 0);
    await setHand('left', [-0.3, 1.25, -0.45], 0, { pitchDeg: 0, rollDeg: 0, curl: 0.6 });   // not open: attracts nothing
    await frames(20);
    const up = { pitchDeg: 0, rollDeg: 180, curl: 0.02 };
    const sweepFrom = (await events()).length;
    // four legs between x 0.10 and 0.50 at 0.15 m/s (0.15/36 m per frame): 7.5 cm over any 0.5 s, so the hand is never "still"
    let x = 0.10;
    for (let leg = 0; leg < 4; leg++) {
      const dir = leg & 1 ? -1 : 1;
      for (let i = 0; i < 96; i++) { x += dir * 0.15 / 36; await setHand('right', [x, 1.30, -0.45], 0, up); await frame(); }
    }
    await frames(36);
    s = await stats();
    let ev = await events();
    const since = ev.slice(sweepFrom);
    const followed = since.some((e) => e.type === 'fireflyfollow' && e.detail?.hand === 'right');
    const landedDuring = since.some((e) => e.type === 'fireflyland' && e.detail?.hand === 'right');
    const rib = await page.evaluate(() => { const c = window.__nocturneCtx; const h = c.hands.right; return { speed: +h.palm.speed.toFixed(3), speedH: +h.palm.speedH.toFixed(3), normalY: +h.palm.normal.y.toFixed(2), open: h.open, still: h.still, disp: +h.stillDisp.toFixed(3) }; });
    step('firefly-ribbon', s.fireflyFollowers[1] >= 3 && s.fireflyFollowArrived[1] >= 2 && followed && !landedDuring,
      { followers: s.fireflyFollowers, arrived: s.fireflyFollowArrived, followed, landedDuring, hand: rib, follows: since.filter((e) => e.type === 'fireflyfollow').slice(0, 3) });
    await shot('ribbon.png');
    // hold still where it stopped: the strand gathers and lands (a fresh recruit from the cloud would need ~7 s)
    const holdFrom = ev.length;
    let handoff = false;
    for (let i = 0; i < 120 && !handoff; i++) {
      await frame();
      if (i % 6 === 5) { ev = await events(); handoff = ev.slice(holdFrom).some((e) => e.type === 'fireflyland' && e.detail?.hand === 'right'); }
    }
    ev = await events();
    handoff = ev.slice(holdFrom).some((e) => e.type === 'fireflyland' && e.detail?.hand === 'right');
    s = await stats();
    step('ribbon-handoff', handoff, { fireflyLanded: s.fireflyLanded, followers: s.fireflyFollowers, lands: ev.slice(holdFrom).filter((e) => e.type === 'fireflyland').slice(0, 3) });
    await setHand('right', [0.25, 1.25, -0.4], 0, { curl: 0.6 });
    await frames(20);
  }

  // ---- hush: an open palm resting flat on the water, still, hushes a disc of water around it
  {
    await setHand('left', [-0.25, 1.25, -0.4], 0);
    await setHand('right', [0.25, 1.25, -0.4], 0);
    await frames(30);
    const lvl = s.water;
    // the hint plane and the drips show and hide on their own schedule: count draw calls without them (per view)
    const draws = () => page.evaluate(() => {
      const c = window.__nocturneCtx; const r = c.renderer;
      const views = r.xr.isPresenting ? (r.xr.getCamera().cameras.length || 1) : 1;
      let n = r.info.render.calls;
      for (const name of ['hint', 'drips']) { const o = c.scene.getObjectByName(name); if (o && o.visible) n -= views; }
      return n;
    });
    const disturb = () => page.evaluate(() => window.__nocturneCtx.water.disturb(0.19, -0.48, 0.15, 0.3));
    const maxH = () => page.evaluate(() => window.__nocturne.simSnapshot().maxH);
    const draws0 = await draws();
    // control: the same push on open water
    await disturb(); await frames(15);
    const h0 = await maxH();
    await frames(120);
    // palm joint at lvl + 0.014 with its normal straight down, thumb tip 1.8 cm under, fingers open, perfectly still
    await setHand('right', [0.2, lvl + 0.012, -0.45], 0, { pitchDeg: 0, rollDeg: 0, curl: 0.05 });
    await frames(120);
    const hs = await page.evaluate(() => { const c = window.__nocturneCtx; const h = c.hands.right; const k = c.hush.circles[1]; return { strength: +c.hush.strength.toFixed(3), r: +k.r.toFixed(3), active: k.active, count: c.hush.count, still: h.still, open: h.open, palmY: +h.palm.position.y.toFixed(3), normalY: +h.palm.normal.y.toFixed(2), submerged: h.submerged, calm: +c.water.calm.toFixed(2) }; });
    let ev = await events();
    const hushEv = ev.find((e) => e.type === 'hush' && e.detail?.hand === 'right');
    step('hush-circle-forms', hs.strength > 0.8 && hs.r > 0.8 && hs.still === true && !!hushEv, { ...hs, event: hushEv || null, water: lvl });
    await shot('hush.png');
    const draws1 = await draws();
    // the same push at the circle's centre now dies almost at once
    await disturb(); await frames(15);
    const h1 = await maxH();
    step('hush-stills-the-water', h0 >= 0.04 && h1 < 0.4 * h0, { h0: +h0.toFixed(4), h1: +h1.toFixed(4) });
    // lift the hand: the stillness dissolves (strength decays with tau 1.2 s; 'hushend' fires below 0.02, ~4.6 s from 0.92)
    await setHand('right', [0.2, lvl + 0.3, -0.45], 0, { curl: 0.6 });
    await frames(180);
    ev = await events();
    s = await stats();
    step('hush-dissolves', s.hush < 0.1 && ev.some((e) => e.type === 'hushend'), { hush: +s.hush.toFixed(3), events: ev.filter((e) => e.type === 'hush' || e.type === 'hushend').slice(-3) });
    step('hush-no-new-draw-calls', draws1 === draws0, { before: draws0, during: draws1 });
    await setHand('right', [0.25, 1.25, -0.4], 0);
    await frames(20);
  }

  // ---- a palm stroke under water is not locomotion any more (reaching through the water must never move you)
  {
    const before = (await world()).rig;
    await page.evaluate(() => window.__fakeXR.clearOverrides?.());
    await setHand('right', [0.3, 0.7, -0.45], 0, { pitchDeg: 0, rollDeg: -90 }); // palm facing -x
    await frames(6);
    for (let i = 1; i <= 30; i++) { await setHand('right', [0.3 - 0.6 * i / 30, 0.7, -0.45], 0, { pitchDeg: 0, rollDeg: -90 }); await frame(); }
    await frames(30);
    const after = (await world()).rig;
    const moved = Math.hypot(after.x - before.x, after.z - before.z);
    step('stroke-does-not-move', moved < 0.02, { moved: +moved.toFixed(3) });
  }

  // hands are driven in reference-space (rig-local) coordinates from here on, like a real hand: they move with the body
  const local = (hs, p, pinch, extra = {}) => page.evaluate(({ hs, p, pinch, extra }) => window.__fakeXR.setHandPose(hs, { position: p, pinch, ...extra }), { hs, p, pinch, extra });

  // ---- a pinch that misses a lantern and moves a little must not move you (dead zone)
  {
    await local('right', [0.1, 1.25, -0.55], 0);
    await frames(8);
    const b0 = (await world()).rig;
    await local('right', [0.1, 1.25, -0.55], 1);
    for (let i = 1; i <= 8; i++) { await local('right', [0.1, 1.25, -0.55 + 0.04 * i / 8], 1); await frame(); }
    await local('right', [0.1, 1.25, -0.51], 0);
    await frames(12);
    const b1 = (await world()).rig;
    const moved = Math.hypot(b1.x - b0.x, b1.z - b0.z);
    step('missed-pinch-does-not-move', moved < 0.01, { moved: +moved.toFixed(3) });
  }

  // ---- pinch-and-pull: an empty pinch grabs the world; pulling the hand toward the body moves you forward
  {
    const b0 = (await world()).rig;
    await local('right', [0.1, 1.25, -0.55], 0);
    await frames(8);
    await local('right', [0.1, 1.25, -0.55], 1);
    await frames(6);
    for (let i = 1; i <= 24; i++) { await local('right', [0.1, 1.25, -0.55 + 0.4 * i / 24], 1); await frame(); }
    await local('right', [0.1, 1.25, -0.15], 0);
    await frames(20);
    const b1 = (await world()).rig;
    const fwdMoved = b0.z - b1.z; // pulling the world toward you (+z hand motion) carries the rig forward (−z)
    // 0.4 m of pull minus the dead zone, one-to-one, plus a short glide from the release momentum — never a runaway
    step('pinch-pull-moves-rig', fwdMoved > 0.3 && fwdMoved < 1.2, { forward: +fwdMoved.toFixed(3), before: [b0.x, b0.z].map((v) => +v.toFixed(2)), after: [b1.x, b1.z].map((v) => +v.toFixed(2)) });
  }

  // ---- two hands pinched: turning the line between them turns the world, and the hands keep hold of it
  {
    const r = 0.22, cz = -0.5;
    const at = (deg) => { const a = deg * Math.PI / 180; return [[-r * Math.cos(a), 1.25, cz - r * Math.sin(a)], [r * Math.cos(a), 1.25, cz + r * Math.sin(a)]]; };
    let [l0, r0] = at(0);
    await local('left', l0, 0); await local('right', r0, 0);
    await frames(8);
    const w0 = await world();
    const palmBefore = await page.evaluate(() => window.__nocturneCtx.hands.right.palm.position.toArray());
    await local('left', l0, 1); await local('right', r0, 1);
    await frames(6);
    for (let i = 1; i <= 30; i++) { const [l, rr] = at(35 * i / 30); await local('left', l, 1); await local('right', rr, 1); await frame(); }
    const palmAfter = await page.evaluate(() => window.__nocturneCtx.hands.right.palm.position.toArray());
    const [l1, r1] = at(35);
    await local('left', l1, 0); await local('right', r1, 0);
    await frames(10);
    const w1 = await world();
    const turnedDeg = ((w1.rig.ry - w0.rig.ry) * 180 / Math.PI);
    const drift = Math.hypot(palmAfter[0] - palmBefore[0], palmAfter[2] - palmBefore[2]);
    // the hands rotate 35°, the first 4° are the dead zone: the rig should turn ≈31° (the sign keeps the hands on the world)
    step('two-hand-turn', Math.abs(Math.abs(turnedDeg) - 31) < 8 && drift < 0.08, { turnedDeg: +turnedDeg.toFixed(1), palmDrift: +drift.toFixed(3) });
  }

  // ---- hand-over-hand: swapping the pulling hand on one frame must not jolt the rig (a grip change, not a jump)
  {
    await local('left', [-0.15, 1.25, -0.55], 0); await local('right', [0.15, 1.25, -0.55], 0);
    await frames(8);
    await local('left', [-0.15, 1.25, -0.55], 1);
    await frames(6);
    const zs = [];
    const rigZ = async () => (await world()).rig.z;
    for (let i = 1; i <= 15; i++) { await local('left', [-0.15, 1.25, -0.55 + 0.25 * i / 15], 1); await frame(); zs.push(await rigZ()); }
    // release the left (its pinch opens over the next frames) and close the right two frames later
    await local('left', [-0.15, 1.25, -0.30], 0);
    for (let i = 0; i < 12; i++) {
      if (i === 2) await local('right', [0.15, 1.25, -0.55], 1);
      if (i > 2) await local('right', [0.15, 1.25, -0.55 + 0.02 * (i - 2)], 1);
      await frame(); zs.push(await rigZ());
    }
    await local('right', [0.15, 1.25, -0.37], 0);
    await frames(6);
    let maxStep = 0;
    for (let i = 1; i < zs.length; i++) maxStep = Math.max(maxStep, Math.abs(zs[i] - zs[i - 1]));
    step('hand-swap-no-jolt', maxStep < 0.03, { maxStepPerFrame: +maxStep.toFixed(4) });
  }

  // ---- leaving: both palms pressed together for a few seconds ends the session
  {
    await local('left', [-0.035, 1.2, -0.4], 0, { pitchDeg: 0, rollDeg: 90 });   // palm facing +x
    await local('right', [0.035, 1.2, -0.4], 0, { pitchDeg: 0, rollDeg: -90 });  // palm facing -x
    let progress = 0, ended = false;
    for (let i = 0; i < 160; i++) {
      await frame();
      const st = await page.evaluate(() => ({ p: window.__nocturneCtx.leave?.progress || 0, xr: window.__nocturne.stats().xr }));
      progress = Math.max(progress, st.p);
      if (!st.xr) { ended = true; break; }
    }
    const ev = await events();
    step('leave-gesture-ends-session', ended && ev.some((e) => e.type === 'leave'), { progress: +progress.toFixed(2), ended });
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
