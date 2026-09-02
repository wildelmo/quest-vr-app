/**
 * Audio fixture: boots the real audio engine + subsystems (src/audio/*) against a stub ctx
 * (no renderer, no WebGL), then drives ~28 s of update() while emitting every gameplay event
 * with realistic payloads. Reports errors, node counts, loudness samples and chord changes.
 *
 *   node tools/harness/fixtures/audio/test.mjs [--nobuffers]
 *   node tools/harness/run.mjs --url /tools/harness/fixtures/audio/index.html --no-xr
 *
 * ?nobuffers=1 skips the sample downloads so every api.buffer() returns null (synth-only path).
 */
import * as THREE from 'three';
import { CONFIG } from '/src/config.js';
import { Events } from '/src/core/events.js';
import { createAudio } from '/src/audio/engine.js';
import { registerAudio, ambience, music, sfx } from '/src/audio/index.js';

const params = new URLSearchParams(location.search);
const NO_BUFFERS = params.has('nobuffers');
const QUIET = params.has('quiet'); // no events, no hands: measures bed + pads only
const DURATION = 28;
const logEl = document.getElementById('log');
const lines = [];
const log = (s) => { lines.push(s); if (logEl) logEl.textContent = lines.slice(-40).join('\n'); };
const errors = [];
window.addEventListener('error', (e) => errors.push('window.error: ' + e.message));
window.addEventListener('unhandledrejection', (e) => errors.push('unhandledrejection: ' + (e.reason?.stack || e.reason)));
const origError = console.error.bind(console);
console.error = (...a) => { errors.push('console.error: ' + a.map((x) => (x?.stack || String(x))).join(' ').slice(0, 400)); origError(...a); };

// count AudioNode creations by type
const counts = {};
const proto = (window.BaseAudioContext || window.AudioContext).prototype;
for (const name of ['createGain', 'createOscillator', 'createBiquadFilter', 'createBufferSource', 'createPanner', 'createConvolver', 'createDynamicsCompressor', 'createDelay', 'createStereoPanner', 'createAnalyser']) {
  const orig = proto[name];
  if (!orig) continue;
  proto[name] = function (...a) { counts[name] = (counts[name] || 0) + 1; return orig.apply(this, a); };
}
const totalNodes = () => Object.values(counts).reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------- stub ctx
const scene = new THREE.Scene();
const player = new THREE.Group(); scene.add(player);
const camera = new THREE.PerspectiveCamera(75, 1, 0.05, 2000); camera.position.set(0, 1.73, 0); player.add(camera);
const mkHand = (handedness) => ({
  handedness, visible: false, tracked: false, active: false, submerged: false, submergedDepth: 0, speed: 0, openStill: false,
  palm: { position: new THREE.Vector3(), velocity: new THREE.Vector3(), velocityLocal: new THREE.Vector3(), speed: 0, speedH: 0, normal: new THREE.Vector3(0, -1, 0) },
  pinch: { active: false, point: new THREE.Vector3(), strength: 0 }, grabbed: null, tips: [],
});
const hands = { left: mkHand('left'), right: mkHand('right') };
hands.list = [hands.left, hands.right];
hands.any = (fn) => hands.list.some(fn);
const headWorld = new THREE.Vector3();
const ctx = {
  renderer: null, scene, camera, player,
  time: { t: 0, dt: 0, frame: 0, now: 0 },
  water: { level: CONFIG.water.level, tileSize: CONFIG.water.tileSize, calm: 0, simTexture: null, swell: () => 0, disturb() {} },
  hands, energy: 0, events: new Events(), audio: null, assets: null, grabbables: [],
  quality: { tier: 'desktop' }, harness: true, errors, mode: 'desktop', calm: 0,
  playerCtl: { state: { speed: 0, headWorld, headVelocity: new THREE.Vector3(), calibrated: true, seated: false }, velocity: new THREE.Vector3() },
  lanterns: { list: [] }, fireflies: { landedCount: 0 }, lotus: { flowers: [] },
};
window.__nocturneCtx = ctx;
for (let i = 0; i < 4; i++) ctx.lanterns.list.push({ position: new THREE.Vector3(), state: 'floating', bright: 0.5, held: null, active: true, ang: (i / 4) * Math.PI * 2, r: 1 + i * 0.9 });

// ---------------------------------------------------------------- assets (audio only)
async function loadAudioAssets() {
  const assets = { tex: {}, audio: { bytes: {}, manifest: [] } };
  try {
    const r = await fetch('/assets/audio/manifest.json');
    assets.audio.manifest = await r.json();
    if (!NO_BUFFERS) {
      await Promise.all(assets.audio.manifest.map(async (item) => {
        try { const b = await fetch('/assets/audio/' + item.file); if (b.ok) assets.audio.bytes[item.file] = await b.arrayBuffer(); }
        catch (err) { errors.push('fetch failed ' + item.file + ': ' + err); }
      }));
    }
  } catch (err) { errors.push('manifest failed: ' + err); }
  return assets;
}

// ---------------------------------------------------------------- scenario
const report = { ok: false, quiet: QUIET, errors, nodes: null, nodesAfterStart: 0, nodesTotal: 0, loudness: [], chords: [], events: [], music: {}, context: {}, buffers: 0, noBuffers: NO_BUFFERS };
let resolveReady, resolveDone;
const ready = new Promise((r) => { resolveReady = r; });
const done = new Promise((r) => { resolveDone = r; });
window.__audioTest = { done, report: null };

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const R = hands.right;
const palmPos = R.palm.position;
let chordName = '';
const fired = new Set();
const emit = (name, payload) => { report.events.push(name); ctx.events.emit(name, payload); };
const once = (key, t, T, fn) => { if (t >= T && !fired.has(key)) { fired.add(key); try { fn(); } catch (err) { errors.push(`scenario ${key}: ${err?.stack || err}`); } } };

function scenario(t, dt) {
  if (QUIET) { camera.getWorldPosition(headWorld); once('advance', t, 13.0, () => ctx.music.advance()); once('stopq', t, 26.0, () => { ambience.stop(); music.stop(); sfx.stop(); }); return; }
  // hand motion: visible from 1 s; submerged sweep 2–6 s; a fast startle sweep 6.5–6.8; gone after 12
  const prevPalm = palmPos.clone();
  if (t >= 1 && t < 12) {
    R.visible = true; R.tracked = true; R.active = true;
    const sweep = t >= 2 && t < 6;
    palmPos.set(sweep ? 0.3 * Math.sin(2 * Math.PI * 0.4 * t) : 0.3, sweep ? ctx.water.level - 0.15 : ctx.water.level + 0.15, -0.5).add(headWorld).sub(V(0, 1.73, 0));
    R.submerged = sweep || (t >= 6.5 && t < 6.8);
    R.submergedDepth = R.submerged ? 0.15 : 0;
    R.palm.velocityLocal.subVectors(palmPos, prevPalm).divideScalar(Math.max(dt, 1e-3));
    R.palm.velocity.copy(R.palm.velocityLocal);
    R.palm.speed = (t >= 6.5 && t < 6.8) ? 1.4 : R.palm.velocityLocal.length();
    R.speed = R.palm.speed;
    R.pinch.point.copy(palmPos).add(V(0.05, 0, -0.1));
  } else { R.visible = false; R.tracked = false; R.active = false; R.submerged = false; R.submergedDepth = 0; R.palm.speed = 0; R.speed = 0; }
  // wading glide
  ctx.playerCtl.state.speed = (t >= 3 && t < 6) ? 0.6 : (t >= 12 && t < 15) ? 0.9 : 0;
  player.position.x += ctx.playerCtl.state.speed * dt;
  // calm reward window
  ctx.water.calm = (t >= 12 && t < 17) ? 0.8 : 0;
  ctx.calm = ctx.water.calm;
  // lanterns drift around the player; one becomes a star at 8 s
  ctx.lanterns.list.forEach((l, i) => {
    l.ang += dt * 0.15;
    l.position.set(headWorld.x + Math.cos(l.ang) * l.r, ctx.water.level + 0.05, headWorld.z + Math.sin(l.ang) * l.r);
    l.bright = 0.5 + 0.5 * Math.sin(t * 2 + i);
    if (i === 1 && t >= 8) l.state = 'star';
  });

  once('calibrated', t, 0.5, () => { emit('calibrated', { eyeHeight: 1.6, seated: false, rigY: 0 }); emit('desktopstart', {}); });
  once('handenter', t, 2.0, () => emit('handenter', { hand: R, speed: 0.9 }));
  once('pinchmiss', t, 2.5, () => emit('pinchmiss', { hand: R, point: R.pinch.point }));
  once('grab', t, 3.0, () => { emit('pinchstart', { hand: R, grabbed: true, kind: 'pinch' }); emit('lanterngrab', { pos: palmPos.clone(), hand: R }); });
  once('release', t, 4.0, () => { emit('pinchend', { hand: R, released: true }); emit('lanternrelease', { pos: palmPos.clone().add(V(0, 0.3, 0)), hand: R }); ctx.energy = Math.min(1, ctx.energy + 0.5); });
  once('lotus', t, 4.5, () => { for (let i = 0; i < 3; i++) emit('lotusbloom', { index: i, note: i * 2 % 6, pos: V(0.6 - 0.4 * i, ctx.water.level, -0.8).add(headWorld).sub(V(0, 1.73, 0)), color: 0xff9ad5 }); });
  once('chord', t, 5.0, () => emit('lotuschord', {}));
  once('firefly', t, 5.5, () => { emit('fireflyland', { pos: palmPos.clone().add(V(0, 0.02, -0.1)), hand: R }); emit('fireflyland', { pos: palmPos.clone().add(V(0.03, 0.02, -0.1)), hand: R }); ctx.fireflies.landedCount = 2; });
  once('handexit', t, 6.0, () => emit('handexit', { hand: R }));
  once('splash', t, 7.0, () => { emit('lanternsplash', { pos: V(0.5, ctx.water.level, -1).add(headWorld).sub(V(0, 1.73, 0)) }); ctx.energy = 0.9; });
  once('star', t, 8.0, () => emit('lanternstar', { dir: V(0.3, 0.9, -0.2), pos: V(30, 80, -20) }));
  once('xrstart', t, 9.0, () => emit('xrstart', { session: null, hasHands: true }));
  once('xrblur', t, 9.5, () => emit('xrblur', {}));
  once('xrfocus', t, 10.0, () => emit('xrfocus', {}));
  once('timejump', t, 10.5, () => { ctx.time.t = 30; emit('timejump', { t: 30 }); });
  once('xrend', t, 11.0, () => emit('xrend', {}));
  once('advance', t, 13.0, () => ctx.music.advance());
  once('raindrop', t, 13.5, () => ctx.music.raindrop());
  once('burst', t, 14.0, () => { for (let i = 0; i < 10; i++) emit('lotusbloom', { index: i, note: i % 6, pos: V(0.2 * i - 1, ctx.water.level, -1).add(headWorld).sub(V(0, 1.73, 0)) }); });
  once('advance2', t, 15.0, () => ctx.music.advance());
  once('breathe', t, 16.0, () => ctx.music.breathe());
  once('stop', t, 26.0, () => { ambience.stop(); music.stop(); sfx.stop(); });
  once('restart', t, 26.5, () => { ctx.audio.add({ name: 'probe', start() {}, update() {} }); ambience.start(ctx.audio, ctx); music.start(ctx.audio, ctx); sfx.start(ctx.audio, ctx); emit('lotusbloom', { index: 0, note: 0, pos: V(0, ctx.water.level, -1) }); });
  once('stop2', t, 27.5, () => { ambience.stop(); music.stop(); sfx.stop(); });
}

function sampleLoudness(t) {
  const s = ctx.audio.stats();
  report.loudness.push({ t: +t.toFixed(1), rmsDb: +s.rmsDb.toFixed(1), peakDb: +s.peakDb.toFixed(1) });
}

// ---------------------------------------------------------------- boot
async function boot() {
  ctx.assets = await loadAudioAssets();
  ctx.audio = createAudio(ctx);
  registerAudio(ctx);
  await ctx.audio.unlock();
  const api = ctx.audio;
  report.context = { state: api.context?.state, sampleRate: api.context?.sampleRate, started: !!api.started, running: api.running };
  report.buffers = Object.keys(api.buffers).length;
  if (!api.started) { errors.push('audio engine did not start (context state ' + api.context?.state + ')'); }
  report.nodesAfterStart = totalNodes();
  report.nodes = { ...counts };
  // ctx.music contract checks
  try {
    const m = ctx.music;
    report.music = {
      present: !!m, chord: m?.currentChord, scaleNote05: m?.scaleNote(0, 5), scaleNote55: m?.scaleNote(5, 5), scaleNote25: m?.scaleNote(2, 5),
      pitchFor15: m?.pitchFor(1, 5), isConsonant74: m?.isConsonant(74), isConsonant75: m?.isConsonant(75),
    };
    if (m.scaleNote(0, 5) !== 74 || m.scaleNote(5, 5) !== 86 || m.scaleNote(2, 5) !== 79) errors.push('scaleNote mismatch ' + JSON.stringify(report.music));
    if (!m.isConsonant(74) || m.isConsonant(75)) errors.push('isConsonant mismatch');
  } catch (err) { errors.push('ctx.music check: ' + (err?.stack || err)); }
  log(`audio started: ${report.context.state} @ ${report.context.sampleRate} Hz, ${report.buffers} buffers, ${report.nodesAfterStart} nodes`);

  const t0 = api.context.currentTime;
  let lastPerf = performance.now();
  let lastSample = -1;
  const loop = () => {
    const nowPerf = performance.now();
    const dt = Math.min(0.1, Math.max(0.0001, (nowPerf - lastPerf) / 1000));
    lastPerf = nowPerf;
    const t = api.context.currentTime - t0;
    ctx.time.dt = dt; ctx.time.t += dt; ctx.time.frame++; ctx.time.now = nowPerf / 1000;
    try {
      camera.getWorldPosition(headWorld);
      scenario(t, dt);
      ctx.energy = Math.max(0, ctx.energy - CONFIG.energy.decay * dt);
      api.update(dt);
      scene.updateMatrixWorld(true);
      const name = ctx.music?.currentChord?.name;
      if (name && name !== chordName) { chordName = name; report.chords.push({ t: +t.toFixed(1), name, midi: ctx.music.currentChord.midi }); }
      const sec = Math.floor(t);
      if (sec !== lastSample && [2, 5, 8, 10, 12, 14, 16, 18, 20, 22, 24].includes(sec)) { lastSample = sec; sampleLoudness(t); }
    } catch (err) { errors.push('loop: ' + (err?.stack || err)); }
    if (ctx.time.frame === 2) resolveReady();
    if (t < DURATION) requestAnimationFrame(loop);
    else finish(t);
  };
  requestAnimationFrame(loop);

  function finish(t) {
    report.nodesTotal = totalNodes();
    report.nodes = { ...counts };
    report.frames = ctx.time.frame;
    report.seconds = +t.toFixed(1);
    report.ok = errors.length === 0;
    window.__audioTest.report = report;
    log(JSON.stringify(report, null, 1));
    resolveDone(report);
  }
}

// ---------------------------------------------------------------- harness contract (run.mjs --no-xr)
window.__nocturne = {
  ready: done.then(() => undefined),
  enterXR: async () => {}, exitXR: async () => {},
  look() {}, setHand() {}, setTime() {},
  stats: () => ({ frame: ctx.time.frame, xr: false, errors: errors.slice(), harness: true, audio: window.__audioTest.report }),
  ctx,
};
boot().catch((err) => { errors.push('boot: ' + (err?.stack || err)); window.__audioTest.report = { ...report, ok: false }; resolveDone(report); });
