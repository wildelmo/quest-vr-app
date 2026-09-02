import * as THREE from 'three';
import { CONFIG } from '../config.js';

/**
 * Hints written in the water. Never scheduled, only conditional: each appears when the player has
 * evidently not found something for a while, one at a time, never repeated (learned flags persist
 * in localStorage). Rendered as a canvas texture on a plane just under the surface ahead of the player,
 * drawn before the water so the surface tints it — text made of plankton light.
 */
const HINTS = [
  { id: 'water', text: 'put a hand in the water', after: 15, done: (ctx, s) => s.touchedWater, ready: (ctx, s) => s.handsSeen },
  { id: 'lantern', text: 'pinch a lantern to lift it', after: 40, done: (ctx, s) => s.grabbed, ready: (ctx, s) => s.touchedWater && nearestLantern(ctx) < 1.4 },
  { id: 'still', text: 'hold a hand open and still', after: 95, done: (ctx, s) => s.fireflyLanded, ready: (ctx, s) => s.touchedWater },
  { id: 'wade', text: 'push the water to drift', after: 170, done: (ctx, s) => s.moved, ready: (ctx, s) => s.touchedWater },
  { id: 'lotus', text: 'the buds open when you touch them', after: 130, done: (ctx, s) => s.bloomed, ready: (ctx, s) => s.touchedWater && nearestLotus(ctx) < 1.6 },
];
const SHOW_HANDS = { id: 'hands', text: 'show your hands to the headset', repeat: true };
const NO_TRACKING = { id: 'notracking', text: 'turn on hand tracking · settings → movement tracking', repeat: true };

function nearestLantern(ctx) {
  const l = ctx.lanterns?.list; if (!l || !l.length) return Infinity;
  const h = ctx.playerCtl.state.headWorld; let best = Infinity;
  for (const e of l) { if (e.state && e.state !== 'floating') continue; const d = e.position.distanceTo(h); if (d < best) best = d; }
  return best;
}
function nearestLotus(ctx) {
  const f = ctx.lotus?.flowers; if (!f || !f.length) return Infinity;
  const h = ctx.playerCtl.state.headWorld; let best = Infinity;
  for (const e of f) { const d = e.position.distanceTo(h); if (d < best) best = d; }
  return best;
}

function loadLearned() { try { return JSON.parse(localStorage.getItem('nocturne.hints') || '{}'); } catch { return {}; } }
function saveLearned(l) { try { localStorage.setItem('nocturne.hints', JSON.stringify(l)); } catch { /* */ } }

export const hints = {
  name: 'hints',
  init(ctx) {
    const canvas = document.createElement('canvas');
    canvas.width = 1024; canvas.height = 256;
    const g2d = canvas.getContext('2d');
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    const mat = new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: 0, color: new THREE.Color(CONFIG.water.planktonColor2), blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, fog: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.275), mat);
    mesh.renderOrder = 1; mesh.frustumCulled = false; mesh.visible = false; mesh.name = 'hint';
    ctx.scene.add(mesh);

    const s = { handsSeen: false, touchedWater: false, grabbed: false, fireflyLanded: false, moved: false, bloomed: false, sessionStart: -1, handsLostSince: -1 };
    ctx.events.on('handenter', () => { s.touchedWater = true; });
    ctx.events.on('grab', () => { s.grabbed = true; });
    ctx.events.on('fireflyland', () => { s.fireflyLanded = true; });
    ctx.events.on('lotusbloom', () => { s.bloomed = true; });
    ctx.events.on('xrstart', (e) => { s.sessionStart = ctx.time.t; s.noTracking = e && e.hasHands === false; s.handsSeen = false; });
    ctx.events.on('desktopstart', () => { s.sessionStart = ctx.time.t; });

    const learned = ctx.harness ? {} : loadLearned();
    const st = { current: null, shownAt: 0, opacity: 0, target: 0, lastText: '', cooldownUntil: 0, showHandsOn: false };

    function draw(text) {
      if (text === st.lastText) return;
      st.lastText = text;
      const w = canvas.width, h = canvas.height;
      g2d.clearRect(0, 0, w, h);
      g2d.fillStyle = '#ffffff';
      g2d.textAlign = 'center'; g2d.textBaseline = 'middle';
      g2d.font = 'italic 96px "Cormorant Garamond", "Times New Roman", serif';
      g2d.shadowColor = 'rgba(255,255,255,0.9)'; g2d.shadowBlur = 24;
      g2d.fillText(text, w / 2, h / 2 + 4);
      g2d.shadowBlur = 0;
      g2d.fillText(text, w / 2, h / 2 + 4);
      texture.needsUpdate = true;
    }
    if (document.fonts?.load) document.fonts.load('italic 96px "Cormorant Garamond"').catch(() => {}).finally(() => { st.lastText = ''; });

    this._ = { mesh, mat, s, st, learned, draw, fwd: new THREE.Vector3(), target: new THREE.Vector3(), q: new THREE.Quaternion(), e: new THREE.Euler() };
  },

  update(ctx, dt) {
    const { mesh, mat, s, st, learned, draw, fwd, target, e, q } = this._;
    const t = ctx.time.t;
    if (s.sessionStart < 0) return;
    const elapsed = t - s.sessionStart;
    if (!s.handsSeen && ctx.hands.list.some((h) => h.tracked)) s.handsSeen = true;
    if (!s.moved && ctx.playerCtl.state.speed > 0.25) s.moved = true;
    const anyTracked = ctx.hands.list.some((h) => h.tracked);
    const presenting = ctx.renderer.xr.isPresenting;
    if (presenting && s.handsSeen) { if (!anyTracked) { if (s.handsLostSince < 0) s.handsLostSince = t; } else s.handsLostSince = -1; }

    // choose what to show
    let want = null;
    if (presenting && !s.handsSeen && (s.noTracking || elapsed > 12)) want = NO_TRACKING;
    else if (presenting && s.handsLostSince >= 0 && t - s.handsLostSince > 8) want = SHOW_HANDS;
    else if (t > st.cooldownUntil) {
      for (const h of HINTS) {
        if (learned[h.id] || h.done(ctx, s) || elapsed < h.after) continue;
        if (h.ready && !h.ready(ctx, s)) continue;
        want = h; break;
      }
    }
    if (st.current && !st.current.repeat) {
      const h = st.current;
      if (h.done(ctx, s) || t - st.shownAt > 14) { learned[h.id] = true; if (!ctx.harness) saveLearned(learned); st.current = null; st.cooldownUntil = t + 20; }
    } else if (st.current && st.current.repeat && want !== st.current) st.current = null;
    if (!st.current && want && want !== st.current) { st.current = want; st.shownAt = t; draw(want.text); }

    st.target = st.current ? 1 : 0;
    st.opacity += (st.target - st.opacity) * Math.min(1, dt / (st.target ? 0.9 : 0.6));
    mat.opacity = st.opacity * 0.9;
    mesh.visible = st.opacity > 0.01;
    if (!mesh.visible) return;
    // place it ahead of the player on the water, facing them, tilted up a little so it reads
    const cam = ctx.camera;
    cam.getWorldDirection(fwd); fwd.y = 0; if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1); fwd.normalize();
    const head = ctx.playerCtl.state.headWorld;
    target.copy(head).addScaledVector(fwd, 1.05); target.y = ctx.water.level - 0.015;
    mesh.position.lerp(target, Math.min(1, dt * 3));
    const yaw = Math.atan2(fwd.x, fwd.z) + Math.PI;
    e.set(-Math.PI / 2 + 0.55, yaw, 0, 'YXZ');
    q.setFromEuler(e);
    mesh.quaternion.slerp(q, Math.min(1, dt * 3));
  },
};
