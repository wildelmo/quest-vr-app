import * as THREE from 'three';
import { CONFIG, detectQuality } from './config.js';
import { Events } from './core/events.js';
import { loadAssets } from './core/assets.js';
import { createXR } from './core/xr.js';
import { createPlayer } from './core/player.js';
import { createHands } from './core/hands.js';
import { createAudio } from './audio/engine.js';
import { registerAudio } from './audio/index.js';
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
  quality: detectQuality(), harness: HARNESS, debug: params.has('debug'), xr: null, errors: [],
  // per-eye view metrics, refreshed every frame: pixelScale = 0.5 * viewportHeight * projection[1][1], so a
  // point/quad of world size S at depth d spans S * pixelScale / d pixels on this headset/frame buffer
  view: { pixelScale: 500, eyeHeightPx: 1000 },
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
  try { registerAudio(ctx); } catch (err) { showError(`[audio] register failed: ${err?.stack || err}`); }
  ctx.audio.load().catch((e) => console.warn('[audio] decode failed', e)); // decoding needs no gesture
  // event log for the harness / debugging
  ctx.eventLog = [];
  for (const type of ['grab', 'pinchstart', 'pinchend', 'pinchmiss', 'handenter', 'handexit', 'lanterngrab', 'lanternrelease', 'lanternsplash', 'lanternstar', 'starborn', 'lotusbloom', 'lotuschord', 'fireflyland', 'calibrated', 'xrstart', 'xrend', 'moonset', 'meteor', 'audiostart', 'leave', 'drip']) {
    ctx.events.on(type, (e) => { if (ctx.eventLog.length < 500) ctx.eventLog.push({ type, t: +ctx.time.t.toFixed(2), detail: summarize(e) }); });
  }
  function summarize(e) {
    if (!e || typeof e !== 'object') return null;
    const o = {};
    for (const k of ['index', 'note', 'grabbed', 'kind', 'lost', 'released', 'seated', 'eyeHeight', 'hasHands', 'count', 'speed']) if (k in e) o[k] = e[k];
    if (e.hand?.handedness) o.hand = e.hand.handedness;
    if (e.pos?.x !== undefined) o.pos = [+e.pos.x.toFixed(2), +e.pos.y.toFixed(2), +e.pos.z.toFixed(2)];
    return o;
  }
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
  if (ui.desktop) { ui.desktop.disabled = false; ui.desktop.addEventListener('click', () => enterDesktop()); }

  let sessionStartT = 0, starsThisSession = 0;
  ctx.events.on('starborn', () => { starsThisSession++; });
  ctx.events.on('xrstart', () => { ctx.mode = 'xr'; sessionStartT = ctx.time.t; starsThisSession = 0; ui.landing?.classList.add('hidden'); ui.hud?.classList.remove('show'); });
  ctx.events.on('xrend', () => {
    if (ctx.mode !== 'xr') return;
    // back on the landing page: a small note about the night that was
    const minutes = Math.max(1, Math.round((ctx.time.t - sessionStartT) / 60));
    const total = ctx.sky?.lanternStarCount?.() || 0;
    let msg = `You spent ${minutes} minute${minutes === 1 ? '' : 's'} on the water`;
    if (starsThisSession) msg += ` and left ${starsThisSession} star${starsThisSession === 1 ? '' : 's'} in the sky.`; else msg += '.';
    if (total > starsThisSession) msg += ` The sky holds ${total} of your stars.`;
    if (ui.status) ui.status.textContent = msg;
    if (ui.enter) ui.enter.textContent = 'Return to the water';
    ctx.mode = 'landing';
    ui.landing?.classList.remove('hidden');
    ctx.playerCtl.enableDesktop();
    ctx.hands.enableDesktop();
  });

  // ---- loop
  let last = performance.now();
  let fpsAcc = 0, fpsN = 0, fps = 0;
  renderer.setAnimationLoop((now, frame) => {
    const dtRaw = Math.min(0.1, Math.max(0.0001, (now - last) / 1000));
    last = now;
    const dt = dtRaw;
    ctx.time.dt = dt; ctx.time.t += dt; ctx.time.frame++; ctx.time.now = now / 1000;

    // per-eye view metrics (three's ArrayCamera sub-cameras carry the XR viewports)
    {
      const cams = renderer.xr.isPresenting ? renderer.xr.getCamera().cameras : null;
      const cam0 = cams && cams[0];
      const h = cam0 && cam0.viewport && cam0.viewport.w > 0 ? cam0.viewport.w : renderer.domElement.height;
      const p11 = (cam0 || camera).projectionMatrix.elements[5] || 1;
      ctx.view.pixelScale = 0.5 * h * p11;
      ctx.view.eyeHeightPx = h;
    }
    // each stage is isolated: one broken module must not freeze the others or the audio
    const guard = (owner, fn) => { if (owner._err) return; try { fn(); } catch (err) { owner._err = true; showError(`[${owner.name || 'core'}] ${err?.stack || err}`); } };
    guard(ctx.hands, () => ctx.hands.update(frame, dt));
    guard(ctx.playerCtl, () => ctx.playerCtl.update(dt));
    for (const m of modules) guard(m, () => m.update(ctx, dt));
    ctx.energy = Math.max(0, ctx.energy - CONFIG.energy.decay * dt);
    guard(ctx.audio, () => ctx.audio.update(dt));
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
    simSnapshot: () => ctx.water.simSnapshot?.(),
    audioStats: () => ctx.audio?.stats?.(),
    events: () => ctx.eventLog.slice(),
    world: () => ({
      lanterns: (ctx.lanterns?.list || []).map((l) => ({ x: +l.position.x.toFixed(2), y: +l.position.y.toFixed(2), z: +l.position.z.toFixed(2), state: l.state })),
      lotus: (ctx.lotus?.flowers || []).map((f) => ({ x: +f.position.x.toFixed(2), y: +f.position.y.toFixed(2), z: +f.position.z.toFixed(2), bloom: +(f.bloom || 0).toFixed(2), open: !!f.open })),
      rig: { x: player.position.x, y: player.position.y, z: player.position.z, ry: player.rotation.y },
      head: ctx.playerCtl.state.headWorld.toArray().map((v) => +v.toFixed(3)),
    }),
    stats: () => ({
      frame: ctx.time.frame, t: ctx.time.t, fps: ctx.fps,
      drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles, points: renderer.info.render.points,
      programs: renderer.info.programs?.length ?? 0, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures,
      xr: renderer.xr.isPresenting, mode: ctx.mode, energy: ctx.energy, errors: ctx.errors.slice(),
      hands: { left: ctx.hands.left.visible, right: ctx.hands.right.visible, pinchL: ctx.hands.left.pinch.active, pinchR: ctx.hands.right.pinch.active, submergedR: ctx.hands.right.submerged, debug: ctx.hands.debugInfo?.() },
      calibrated: ctx.playerCtl.state.calibrated, seated: ctx.playerCtl.state.seated, calm: ctx.calm,
      moonAltitudeDeg: ctx.sky?.moonAltitudeDeg, lanternStars: ctx.sky?.lanternStarCount?.(), aurora: ctx.aurora?.intensity,
      lanterns: ctx.lanterns?.count, fireflies: ctx.fireflies?.count, fireflyLanded: ctx.fireflies?.landedCount, lotusOpen: ctx.lotus?.flowers?.filter((f) => f.open).length,
      player: { x: player.position.x, y: player.position.y, z: player.position.z },
      water: ctx.water.level,
    }),
    ctx,
  };

  if (HARNESS) enterDesktop(true);

  async function enterXR() {
    ctx.audio.unlock();           // synchronous, inside the click: keeps the transient activation for requestSession
    await ctx.xr.start();
  }
  function enterDesktop(quiet) {
    ctx.mode = 'desktop';
    ui.landing?.classList.add('hidden');
    if (!quiet) { ui.hud?.classList.add('show'); setTimeout(() => ui.hud?.classList.remove('show'), 12000); }
    ctx.audio.unlock();
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
