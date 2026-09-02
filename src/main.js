import * as THREE from 'three';
import { CONFIG, detectQuality } from './config.js';
import { Events } from './core/events.js';
import { loadAssets } from './core/assets.js';
import { createXR } from './core/xr.js';
import { createPlayer } from './core/player.js';
import { createHands } from './core/hands.js';
import { createAudio } from './audio/engine.js';
import { WORLD_MODULES } from './world/index.js';

const params = new URLSearchParams(location.search);
const HARNESS = params.has('harness');

const $ = (id) => document.getElementById(id);
const ui = { landing: $('landing'), enter: $('enter'), desktop: $('desktop'), bar: $('bar')?.querySelector('i'), status: $('status'), hud: $('hud'), err: $('err') };

function showError(msg) {
  console.error(msg);
  if (ui.err) { ui.err.style.display = 'block'; ui.err.textContent += (ui.err.textContent ? '\n' : '') + String(msg); }
}
window.addEventListener('error', (e) => showError(e.message));
window.addEventListener('unhandledrejection', (e) => showError(e.reason?.stack || e.reason));

let readyResolve;
const ready = new Promise((r) => { readyResolve = r; });
const ctx = {
  renderer: null, scene: null, camera: null, player: null,
  time: { t: 0, dt: 0, frame: 0, now: 0 },
  water: { level: CONFIG.water.level, tileSize: CONFIG.water.tileSize, simTexture: null, swell: null },
  hands: null, energy: 0, events: new Events(), audio: null, assets: null, grabbables: [],
  quality: detectQuality(), harness: HARNESS, xr: null, errors: [],
  mode: 'landing', // 'landing' | 'desktop' | 'xr'
};
window.__nocturneCtx = ctx;

const origConsoleError = console.error.bind(console);
console.error = (...args) => { ctx.errors.push(args.map(String).join(' ').slice(0, 300)); origConsoleError(...args); };

async function boot() {
  const canvas = $('c');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance', stencil: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping; // keeps the cyan/amber hues; ACES pushes bright glows to white
  renderer.toneMappingExposure = 1.0;
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local-floor');
  renderer.xr.setFoveation(1.0);
  renderer.setClearColor(CONFIG.fog.color, 1);
  renderer.sortObjects = true;
  ctx.renderer = renderer;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(CONFIG.fog.color, CONFIG.fog.density);
  ctx.scene = scene;

  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 2000);
  camera.position.set(0, CONFIG.player.eyeHeightDesktop, 0);
  ctx.camera = camera;

  const player = new THREE.Group();
  player.name = 'player';
  player.add(camera);
  scene.add(player);
  ctx.player = player;

  // Analytic swell used by anything that floats (matched in the water shader).
  const A = CONFIG.water.swellAmplitude;
  ctx.water.swell = (x, z, t) => A * (Math.sin(x * 0.9 + t * 0.7) + 0.7 * Math.sin(z * 1.3 - t * 0.55 + x * 0.4) + 0.5 * Math.sin((x + z) * 2.1 + t * 1.1));

  window.addEventListener('resize', onResize);
  onResize();

  ui.status && (ui.status.textContent = 'Loading the sky…');
  ctx.assets = await loadAssets(ctx, (p, label) => {
    if (ui.bar) ui.bar.style.width = `${Math.round(p * 100)}%`;
    if (ui.status) ui.status.textContent = p >= 1 ? 'Ready.' : `Loading ${label}…`;
  });

  ctx.audio = createAudio(ctx);
  ctx.hands = createHands(ctx);
  ctx.playerCtl = createPlayer(ctx);
  ctx.xr = createXR(ctx);

  // ?extra=fireflies,lanterns loads modules that are not (yet) registered in src/world/index.js;
  // ?only=wavesim,water restricts the registered list. Both are for development/testing.
  const moduleList = [...WORLD_MODULES];
  if (params.get('only')) { const keep = new Set(params.get('only').split(',')); for (let i = moduleList.length - 1; i >= 0; i--) if (!keep.has(moduleList[i].name)) moduleList.splice(i, 1); }
  if (params.get('extra')) {
    for (const name of params.get('extra').split(',').map((s) => s.trim()).filter(Boolean)) {
      if (moduleList.some((m) => m.name === name)) continue;
      try {
        const mod = await import(`./world/${name}.js`);
        const m = mod[name] || mod.default;
        if (m && typeof m.init === 'function') moduleList.push(m); else showError(`[extra] ${name}.js does not export a module named "${name}"`);
      } catch (err) { showError(`[extra] failed to load ${name}: ${err?.message || err}`); }
    }
  }
  const modules = [];
  for (const m of moduleList) {
    try { await m.init(ctx); modules.push(m); }
    catch (err) { showError(`[${m.name}] init failed: ${err?.stack || err}`); }
  }
  ctx.modules = modules;

  // ---- UI wiring
  const xrOK = await ctx.xr.isSupported();
  if (ui.enter) {
    if (xrOK) { ui.enter.disabled = false; ui.enter.textContent = 'Enter VR'; }
    else { ui.enter.disabled = true; ui.enter.textContent = 'VR not available here'; }
    ui.enter.addEventListener('click', () => enterXR().catch(showError));
  }
  ui.desktop?.addEventListener('click', () => enterDesktop());

  ctx.events.on('xrstart', () => { ctx.mode = 'xr'; ui.landing?.classList.add('hidden'); ui.hud?.classList.remove('show'); });
  ctx.events.on('xrend', () => { if (ctx.mode === 'xr') enterDesktop(); });

  // ---- loop
  let last = performance.now();
  let fpsAcc = 0, fpsN = 0, fps = 0;
  renderer.setAnimationLoop((now, frame) => {
    const dtRaw = Math.min(0.1, Math.max(0.0001, (now - last) / 1000));
    last = now;
    const dt = dtRaw;
    ctx.time.dt = dt; ctx.time.t += dt; ctx.time.frame++; ctx.time.now = now / 1000;

    try {
      ctx.hands.update(frame, dt);
      ctx.playerCtl.update(dt);
      for (const m of modules) m.update(ctx, dt);
      ctx.energy = Math.max(0, ctx.energy - CONFIG.energy.decay * dt);
      ctx.audio.update(dt);
    } catch (err) {
      if (!ctx._loopErr) { ctx._loopErr = true; showError(err?.stack || err); }
    }
    renderer.render(scene, camera);

    fpsAcc += dt; fpsN++;
    if (fpsAcc >= 1) { fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
    ctx.fps = fps;
    if (ctx.time.frame === 2) readyResolve();
  });

  // ---- test / automation hooks
  window.__nocturne = {
    ready,
    enterXR: () => enterXR(),
    exitXR: () => ctx.xr.end(),
    look: (yaw, pitch) => ctx.playerCtl.look(yaw, pitch),
    setHand: (h) => ctx.hands.setDesktopHand(h),
    setTime: (s) => { ctx.time.t = s; ctx.events.emit('timejump', { t: s }); },
    stats: () => ({
      frame: ctx.time.frame, t: ctx.time.t, fps: ctx.fps,
      drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles, points: renderer.info.render.points,
      programs: renderer.info.programs?.length ?? 0, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures,
      xr: renderer.xr.isPresenting, mode: ctx.mode, energy: ctx.energy, errors: ctx.errors.slice(),
      hands: { left: ctx.hands.left.visible, right: ctx.hands.right.visible, pinchL: ctx.hands.left.pinch.active, pinchR: ctx.hands.right.pinch.active, submergedR: ctx.hands.right.submerged, debug: ctx.hands.debugInfo?.() },
      calibrated: ctx.playerCtl.state.calibrated, seated: ctx.playerCtl.state.seated, calm: ctx.calm,
      player: { x: player.position.x, y: player.position.y, z: player.position.z },
      water: ctx.water.level,
    }),
    ctx,
  };

  if (HARNESS) enterDesktop(true);

  async function enterXR() {
    await ctx.audio.unlock();
    await ctx.xr.start();
  }
  function enterDesktop(quiet) {
    ctx.mode = 'desktop';
    ui.landing?.classList.add('hidden');
    if (!quiet) { ui.hud?.classList.add('show'); setTimeout(() => ui.hud?.classList.remove('show'), 12000); }
    ctx.audio.unlock().catch(() => {});
    ctx.playerCtl.enableDesktop();
    ctx.hands.enableDesktop();
    ctx.events.emit('desktopstart');
  }
  function onResize() {
    if (renderer.xr.isPresenting) return;
    const w = window.innerWidth, h = window.innerHeight;
    camera.aspect = w / h; camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }
}

boot().catch((err) => showError(err?.stack || err));
