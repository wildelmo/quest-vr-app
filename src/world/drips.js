import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { TIP_NAMES } from '../core/hands.js';
import { DRIPS_VERT, DRIPS_FRAG } from '../shaders/drips.js';

/**
 * Drips: when a hand comes up out of the water, droplets of plankton-lit water fall from the fingers
 * for about a second, each leaving a tiny ring where it lands. A delight moment, kept cheap:
 *  - one THREE.Points over a pool of MAX droplets (typed arrays, slots reused, no per-frame
 *    allocation), additive, drawn after the water (renderOrder 3) and only while something is falling
 *  - source: HandState.leftWater (the frame the hand's lowest joint clears the surface). Droplets are
 *    shed by the fingertip and knuckle joints that were under the surface within the last second and
 *    are now above it, preferring the lowest of them (water gathers at the lowest point of a hand):
 *    a burst of 4–8 on exit, then a rate that decays from 12/s to 0 over a second
 *  - a droplet keeps a fraction of the joint's velocity, falls under gravity with a little air drag,
 *    and dies when it meets the surface (a small disturbance in the wave sim, and a rate-limited
 *    'drip' event for the audio) or after 1.5 s
 *  - brightness follows how "charged" the hand is (how long it was under water), dims for the later
 *    droplets as the hand drains, and fades with age
 * The desktop mouse hand goes through exactly the same path: it only drips after a Shift dip.
 * Exposes ctx.drips = { count, spawned, landed, emitted } for tests.
 */
const MAX = 256;
const NH = 2;
const DRIP_JOINTS = [
  ...TIP_NAMES,
  'index-finger-phalanx-proximal', 'middle-finger-phalanx-proximal', 'ring-finger-phalanx-proximal', 'pinky-finger-phalanx-proximal',
  'thumb-phalanx-distal', 'index-finger-phalanx-distal', 'middle-finger-phalanx-distal',
];
const NJ = DRIP_JOINTS.length;

const P = {
  dripTime: 1.0,        // seconds of dripping after the hand leaves the water
  rate: 12,             // droplets / s per hand at the moment of exit, falling linearly to 0 over dripTime
  burstMin: 4, burstMax: 8, burstPerFrame: 4,
  wetTime: 1.0,         // a joint stays wet this long after it was last under the surface
  chargeTime: 0.5,      // seconds under water for full brightness
  chargeMin: 0.3,       // a hand that barely touched the surface still glows a little
  retrigger: 0.25,      // a hand bobbing on the surface does not burst every frame
  life: 1.5,
  gravity: 9.8, drag: 0.5,
  carry: 0.35, carryMax: 0.8,   // fraction of the hand's velocity a droplet keeps, and its cap (m/s)
  ringRadius: 0.045, ringStrength: 0.035, disturbPerFrame: 6,
  emitInterval: 0.125,  // 'drip' events: at most 8 per second overall
  size: 0.014, maxPx: 28, gain: 1.0,
};

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const _v = new THREE.Vector3();

export const drips = {
  name: 'drips',

  init(ctx) {
    const rnd = mulberry32(0xD0F1E7);
    const pos = new Float32Array(MAX * 3), vel = new Float32Array(MAX * 3);
    const bright = new Float32Array(MAX), seed = new Float32Array(MAX);
    const base = new Float32Array(MAX), age = new Float32Array(MAX);
    const alive = new Uint8Array(MAX), hand = new Int8Array(MAX).fill(-1);
    const free = new Int16Array(MAX);
    for (let i = 0; i < MAX; i++) { seed[i] = rnd(); free[i] = MAX - 1 - i; pos[i * 3 + 1] = -100; }

    const geo = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    const brightAttr = new THREE.BufferAttribute(bright, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', posAttr);
    geo.setAttribute('aBright', brightAttr);
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: ctx.assets.tex.glowFirefly },
        uC0: { value: new THREE.Color(CONFIG.water.planktonColor) },
        uC1: { value: new THREE.Color(CONFIG.water.planktonColor2) },
        uPixelScale: { value: 800 },
        uSize: { value: P.size },
        uFogDensity: { value: ctx.scene.fog ? ctx.scene.fog.density : CONFIG.fog.density },
        uMaxPx: { value: P.maxPx },
        uGain: { value: P.gain },
      },
      vertexShader: DRIPS_VERT,
      fragmentShader: DRIPS_FRAG,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, fog: false,
    });
    const points = new THREE.Points(geo, mat);
    points.renderOrder = 3; points.frustumCulled = false; points.matrixAutoUpdate = false; points.name = 'drips';
    points.visible = false;
    ctx.scene.add(points);

    // per-hand: time under water (charge), the last exit, the spawn accumulator, the burst still owed,
    // and per drip joint the time until which it counts as wet
    const S = {
      rnd, pos, vel, bright, seed, base, age, alive, hand, free, top: MAX, live: 0,
      geo, posAttr, brightAttr, mat, points,
      subT: new Float32Array(NH), charge: new Float32Array(NH), exitT: new Float64Array(NH).fill(-1e9),
      acc: new Float32Array(NH), burstLeft: new Uint8Array(NH), wetUntil: new Float64Array(NH * NJ),
      elig: new Uint8Array(NJ), lastEmit: -1e9,
      spawned: 0, landed: 0, emitted: 0,
    };
    this._ = S;
    ctx.drips = { count: 0, spawned: 0, landed: 0, emitted: 0, max: MAX, positions: pos, brightness: bright };

    // shed one drop from the eligible joints elig[0..n) of hand h (index hi) at brightness b
    S.spawn = (h, hi, n, b) => {
      if (S.top === 0) return;
      const elig = S.elig;
      // the lower of two random wet joints: water gathers at the lowest points of the hand
      const ja = h.joints[DRIP_JOINTS[elig[(rnd() * n) | 0]]], jb = h.joints[DRIP_JOINTS[elig[(rnd() * n) | 0]]];
      const j = jb.position.y < ja.position.y ? jb : ja;
      const i = free[--S.top], i3 = i * 3;
      const r = j.radius || 0.008;
      pos[i3] = j.position.x + (rnd() - 0.5) * r * 1.2;
      pos[i3 + 1] = j.position.y - r * 0.8;                 // the drop forms on the underside
      pos[i3 + 2] = j.position.z + (rnd() - 0.5) * r * 1.2;
      // world velocity of the joint (rig-local, turned into the world, plus the player's glide)
      _v.copy(j.velocity).applyQuaternion(ctx.player.quaternion).add(ctx.playerCtl.velocity).multiplyScalar(P.carry);
      const l = _v.length();
      if (l > P.carryMax) _v.multiplyScalar(P.carryMax / l);
      vel[i3] = _v.x + (rnd() - 0.5) * 0.12;
      vel[i3 + 1] = Math.min(_v.y, 0.1) - 0.05 - rnd() * 0.2;   // never flung upward; a little downward scatter
      vel[i3 + 2] = _v.z + (rnd() - 0.5) * 0.12;
      age[i] = 0; base[i] = b * (0.8 + 0.4 * rnd()); bright[i] = base[i];
      alive[i] = 1; hand[i] = hi; S.live++; S.spawned++;
    };
    S.kill = (i) => { alive[i] = 0; bright[i] = 0; hand[i] = -1; free[S.top++] = i; S.live--; };

    // a time jump (test hook) must not strand the timers in the far future or past
    ctx.events.on('timejump', () => {
      S.exitT.fill(-1e9); S.lastEmit = -1e9; S.wetUntil.fill(0);
      S.subT.fill(0); S.acc.fill(0); S.burstLeft.fill(0);
    });
  },

  update(ctx, dt) {
    const S = this._;
    const { rnd, pos, vel, bright, base, age, alive, hand, elig, spawn, kill } = S;
    const t = ctx.time.t, level = ctx.water.level;
    const hands = ctx.hands.list;
    const disturb = typeof ctx.water.disturb === 'function' ? ctx.water.disturb : null;
    const swell = typeof ctx.water.swell === 'function' ? ctx.water.swell : null;

    const u = S.mat.uniforms;
    u.uPixelScale.value = ctx.view && ctx.view.pixelScale > 0 ? ctx.view.pixelScale : ctx.renderer.domElement.height * 0.55;
    u.uFogDensity.value = ctx.scene.fog ? ctx.scene.fog.density : CONFIG.fog.density;

    // ---- hands: charge while under water, stamp wet joints, burst on exit, then a decaying trickle
    for (let hi = 0; hi < NH; hi++) {
      const h = hands[hi];
      if (!h || !h.visible) { S.subT[hi] = 0; S.burstLeft[hi] = 0; continue; }
      if (h.submerged) S.subT[hi] += dt;
      const wb = hi * NJ;
      for (let k = 0; k < NJ; k++) {
        const j = h.joints[DRIP_JOINTS[k]];
        if (j.valid && j.position.y < level + 0.003) S.wetUntil[wb + k] = t + P.wetTime;
      }
      if (h.leftWater && t - S.exitT[hi] > P.retrigger) {
        const charge = THREE.MathUtils.clamp(S.subT[hi] / P.chargeTime, P.chargeMin, 1);
        S.charge[hi] = charge; S.exitT[hi] = t; S.subT[hi] = 0; S.acc[hi] = 0;
        S.burstLeft[hi] = Math.round((P.burstMin + rnd() * (P.burstMax - P.burstMin)) * (0.5 + 0.5 * charge));
      }
      const f = (t - S.exitT[hi]) / P.dripTime;
      if (!(f >= 0 && f < 1)) { S.burstLeft[hi] = 0; S.acc[hi] = 0; continue; }
      S.acc[hi] = Math.min(S.acc[hi] + P.rate * (1 - f) * dt, 3);
      // joints that can shed a drop: wet, and above the surface
      let n = 0;
      for (let k = 0; k < NJ; k++) {
        const j = h.joints[DRIP_JOINTS[k]];
        if (j.valid && S.wetUntil[wb + k] > t && j.position.y - (j.radius || 0.008) * 0.8 > level + 0.006) elig[n++] = k;
      }
      if (n === 0) continue;
      let want = Math.min(S.burstLeft[hi], P.burstPerFrame);
      S.burstLeft[hi] -= want;
      while (S.acc[hi] >= 1) { S.acc[hi] -= 1; want++; }
      if (want === 0) continue;
      const b = S.charge[hi] * (1 - 0.6 * f);   // the later drops are dimmer: the hand is draining
      for (let s = 0; s < want; s++) spawn(h, hi, n, b);
    }

    // ---- droplets in flight
    if (S.live > 0) {
      const dragK = Math.max(0, 1 - P.drag * dt);
      const halfLife = P.life * 0.5;
      let disturbs = 0;
      for (let i = 0; i < MAX; i++) {
        if (!alive[i]) continue;
        const i3 = i * 3;
        const vx = vel[i3] * dragK, vy = (vel[i3 + 1] - P.gravity * dt) * dragK, vz = vel[i3 + 2] * dragK;
        vel[i3] = vx; vel[i3 + 1] = vy; vel[i3 + 2] = vz;
        const x = pos[i3] + vx * dt, y = pos[i3 + 1] + vy * dt, z = pos[i3 + 2] + vz * dt;
        const a = (age[i] += dt);
        const surf = level;   // the drawn surface is flat (the analytic swell only moves floating things)
        if (y <= surf) {
          // landed: a tiny ring, a quiet event (rate-limited; the audio listens), and the drop is gone
          if (disturb && disturbs < P.disturbPerFrame) { disturbs++; disturb(x, z, P.ringRadius, P.ringStrength * (0.6 + 0.4 * base[i])); }
          if (t - S.lastEmit >= P.emitInterval) {
            S.lastEmit = t; S.emitted++;
            const hs = hand[i] >= 0 ? hands[hand[i]] : null;
            ctx.events.emit('drip', { pos: new THREE.Vector3(x, surf, z), hand: hs, bright: base[i] });
          }
          S.landed++; kill(i);
          continue;
        }
        if (a >= P.life) { kill(i); continue; }
        pos[i3] = x; pos[i3 + 1] = y; pos[i3 + 2] = z;
        const k = a > halfLife ? 1 - (a - halfLife) / halfLife : 1;
        bright[i] = base[i] * k * k;
      }
      S.posAttr.needsUpdate = true;
      S.brightAttr.needsUpdate = true;
    }
    // no draw call at all while nothing is falling (the common state)
    S.points.visible = S.live > 0;
    const d = ctx.drips;
    d.count = S.live; d.spawned = S.spawned; d.landed = S.landed; d.emitted = S.emitted;
  },
};
