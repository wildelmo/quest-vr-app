import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { FIREFLY_VERT, FIREFLY_MIRROR_VERT, FIREFLY_FRAG } from '../shaders/fireflies.js';

/**
 * Fireflies: N additive point sprites (one draw call) plus a mirrored, dimmer copy drawn as a glint
 * on the water surface, after the water (one more draw call, same geometry; the mirror vertex shader
 * slides each virtual image to where its view ray meets the surface). All behaviour runs on the CPU
 * over typed arrays:
 *  - three "home" clouds a few metres from the player; each firefly wanders with sum-of-sines
 *    steering, softly pulled toward its own spot in its cloud, kept above the water
 *  - the homes drift after the player when the player wades far away
 *  - an open, still hand above the water recruits up to six fireflies (one per fingertip, thumb
 *    last, then the middle knuckle); they ease in and land on the tip, glow steadily, then leave
 *    with an upward burst when the hand moves, dips, disappears, or after 8–18 s
 *  - a fast hand scatters everything within 0.6 m
 * Per-firefly flash, shaped like a Photinus flash: a fast rise (~0.15 s), a slower decay (~0.5 s) and a
 * dim ember in between, repeating every 1.4–3.2 s; ~15% are long-glowers that breathe slowly instead.
 * Loose synchrony: every SYNC.dt each home cloud's flashers are nudged toward the cloud's mean phase
 * (a mean-field Kuramoto step, O(N) per pass, no pair terms) with a coupling that swells and relaxes
 * over ~26–41 s per cloud, so a cloud drifts into waves of near-synchronous flashing and back out again.
 * Landed fireflies glow steadily. Seeded PRNG so a run is reproducible. Exposes ctx.fireflies for the
 * audio module (positions, brightness, states, homes, per-cloud coherence).
 */

const WANDER = 0, APPROACH = 1, LANDED = 2, SCATTER = 3;
// landing spots, in the order they fill: fingertips, but also knuckles and the palm so they don't all perch on the tips
const SLOT_JOINTS = ['index-finger-tip', 'middle-finger-phalanx-proximal', 'ring-finger-tip', 'index-finger-metacarpal', 'thumb-tip', 'pinky-finger-tip', 'middle-finger-tip', 'ring-finger-phalanx-proximal'];
const SLOTS = SLOT_JOINTS.length;
// home clouds: azimuth (degrees, left - / right + of the initial -Z forward) and distance from the player
const HOME_SPECS = [{ az: -40, dist: 3.6 }, { az: 48, dist: 5.4 }, { az: 150, dist: 7.2 }];
const HOME_HEIGHT = 0.9;      // above the water level
const HOME_RADIUS = 1.6;      // horizontal spread of a cloud
const HOME_THICK = 1.1;       // vertical spread of a cloud

const P = {
  yMin: 0.08, yMax: 2.4, ySoftMin: 0.3, ySoftMax: 2.1,       // above the water level
  wanderSpeed: 0.32, wanderMax: 0.5, homeSpring: 0.3, homeMaxPull: 0.45,
  approachMax: 0.6, landDist: 0.025, landOffset: 0.01,
  leaveSpeed: 0.35, repelSpeed: 0.7, repelRadius: 0.6,
  stayMin: 8, stayMax: 18, cooldown: 5, abortCooldown: 3,
  followFar: 12, followNear: 6, followRate: 0.25,
  recruitInterval: 0.35, recruitRange: 14,
  size: 0.12, maxPx: 72, mirrorDim: 0.3, gain: 0.8,   // size: halo diameter; gain < 1 keeps the core below the tone mapper's knee
};
// flash envelope (seconds): rise to the peak, then decay; ember = the dim glow between flashes
const FLASH = { rise: 0.15, decay: 0.5, ember: 0.035 };
// synchrony: pass interval, peak coupling (rad/s; the clouds' natural rates spread over ~2–4.5 rad/s, so
// this locks most of a cloud at its peak and none of it near zero), and the swell period per cloud
const SYNC = { dt: 0.25, kMax: 2.4, swell: [26, 34, 41] };

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const fireflies = {
  name: 'fireflies',

  init(ctx) {
    const N = Math.max(8, Math.round(300 * (ctx.quality.particleScale || 1)));
    const rnd = mulberry32(0x5EED5);
    const level = ctx.water.level;

    // ---- per-firefly state (typed arrays; pos/bright are the GPU attributes)
    const pos = new Float32Array(N * 3), vel = new Float32Array(N * 3);
    const bright = new Float32Array(N), seed = new Float32Array(N);
    const homeIdx = new Uint8Array(N), homeOff = new Float32Array(N * 3);
    const state = new Uint8Array(N), slotHand = new Int8Array(N).fill(-1), slotIdx = new Int8Array(N).fill(-1);
    const timer = new Float32Array(N), stay = new Float32Array(N), cooldown = new Float32Array(N);
    const period = new Float32Array(N), phase = new Float32Array(N), steady = new Uint8Array(N);

    // ---- homes around the player's start position (forward = -Z)
    const homes = new Float32Array(HOME_SPECS.length * 3);
    const homeRel = new Float32Array(HOME_SPECS.length * 2);
    const px = ctx.player.position.x, pz = ctx.player.position.z;
    for (let k = 0; k < HOME_SPECS.length; k++) {
      const az = THREE.MathUtils.degToRad(HOME_SPECS[k].az), d = HOME_SPECS[k].dist;
      const dx = Math.sin(az) * d, dz = -Math.cos(az) * d;
      homeRel[k * 2] = dx; homeRel[k * 2 + 1] = dz;
      homes[k * 3] = px + dx; homes[k * 3 + 1] = level + HOME_HEIGHT; homes[k * 3 + 2] = pz + dz;
    }

    for (let i = 0; i < N; i++) {
      const k = i % HOME_SPECS.length;
      homeIdx[i] = k;
      const ang = rnd() * Math.PI * 2, r = HOME_RADIUS * Math.sqrt(rnd());
      homeOff[i * 3] = Math.cos(ang) * r;
      homeOff[i * 3 + 1] = (rnd() - 0.5) * HOME_THICK;
      homeOff[i * 3 + 2] = Math.sin(ang) * r;
      pos[i * 3] = homes[k * 3] + homeOff[i * 3] + (rnd() - 0.5) * 0.6;
      pos[i * 3 + 1] = THREE.MathUtils.clamp(homes[k * 3 + 1] + homeOff[i * 3 + 1] + (rnd() - 0.5) * 0.3, level + P.ySoftMin, level + P.ySoftMax);
      pos[i * 3 + 2] = homes[k * 3 + 2] + homeOff[i * 3 + 2] + (rnd() - 0.5) * 0.6;
      vel[i * 3] = (rnd() - 0.5) * 0.2; vel[i * 3 + 1] = (rnd() - 0.5) * 0.1; vel[i * 3 + 2] = (rnd() - 0.5) * 0.2;
      seed[i] = rnd();
      period[i] = 1.4 + rnd() * 1.8;
      phase[i] = rnd() * period[i];
      steady[i] = rnd() < 0.15 ? 1 : 0;
      state[i] = WANDER;
      bright[i] = steady[i] ? 0.12 : FLASH.ember;
    }

    // ---- geometry + the two layers
    const geo = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    const brightAttr = new THREE.BufferAttribute(bright, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', posAttr);
    geo.setAttribute('aBright', brightAttr);
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));

    const makeMaterial = (mirror) => new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: ctx.assets.tex.glowFirefly },
        uColor: { value: new THREE.Color(CONFIG.colors.firefly) },
        uPixelScale: { value: 800 },
        uSize: { value: P.size },
        uLevel: { value: level },
        uTime: { value: 0 },
        uFogDensity: { value: ctx.scene.fog ? ctx.scene.fog.density : CONFIG.fog.density },
        uMaxPx: { value: P.maxPx },
        uDim: { value: mirror ? P.mirrorDim : 1 },
        uGain: { value: P.gain },
      },
      vertexShader: mirror ? FIREFLY_MIRROR_VERT : FIREFLY_VERT,
      fragmentShader: FIREFLY_FRAG,
      transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, fog: false,
    });
    const matMain = makeMaterial(false), matMirror = makeMaterial(true);
    const points = new THREE.Points(geo, matMain);
    points.renderOrder = 3; points.frustumCulled = false; points.matrixAutoUpdate = false; points.name = 'fireflies';
    // the reflection sits on the surface, so it goes just after the water (renderOrder 2), depth-tested against it
    const mirror = new THREE.Points(geo, matMirror);
    mirror.renderOrder = 3; mirror.frustumCulled = false; mirror.matrixAutoUpdate = false; mirror.name = 'firefliesMirror';
    ctx.scene.add(points); ctx.scene.add(mirror);

    // ---- hand slots: which firefly is heading for / sitting on which joint of which hand
    const slots = [new Int16Array(SLOTS).fill(-1), new Int16Array(SLOTS).fill(-1)];
    const recruitT = new Float32Array(2);
    const hf = { attract: [false, false], hold: [false, false], approach: [false, false], repel: [false, false], still: [false, false] };

    // a time jump (test hook) must not leave timers stranded in the far future
    ctx.events.on('timejump', (e) => {
      const nt = e && typeof e.t === 'number' ? e.t : ctx.time.t;
      for (let i = 0; i < N; i++) {
        if (state[i] === SCATTER) timer[i] = Math.min(timer[i], nt + 1.4);
        else if (state[i] === LANDED) timer[i] = Math.min(timer[i], nt);
      }
    });

    // ---- synchrony scratch: per cloud the mean phase vector (cos, sin, count), then mean phase and nudge gain
    const syncAcc = new Float32Array(HOME_SPECS.length * 3);
    const syncPsi = new Float32Array(HOME_SPECS.length), syncGain = new Float32Array(HOME_SPECS.length);
    const coherence = new Float32Array(HOME_SPECS.length);   // Kuramoto order parameter R per cloud, 0..1

    ctx.fireflies = { count: N, landedCount: 0, positions: pos, brightness: bright, states: state, homes, coherence };

    this._ = {
      N, rnd, pos, vel, bright, seed, homeIdx, homeOff, state, slotHand, slotIdx, timer, stay, cooldown, period, phase, steady,
      homes, homeRel, following: false, geo, posAttr, brightAttr, matMain, matMirror, points, mirror, slots, recruitT, hf,
      syncT: SYNC.dt, syncAcc, syncPsi, syncGain, coherence,
    };
  },

  update(ctx, dt) {
    const S = this._;
    const { N, rnd, pos, vel, bright, seed, homeIdx, homeOff, state, slotHand, slotIdx, timer, stay, cooldown, period, phase, steady, homes, homeRel, slots, recruitT, hf } = S;
    const t = ctx.time.t;
    const level = ctx.water.level;
    const { renderer, camera } = ctx;
    const hands = ctx.hands.list;

    // ---- uniforms: perspective point scale = 0.5 * viewportHeight * proj[1][1] (== H / (2 tan(fov/2)); also
    // right for asymmetric XR frusta). main.js publishes it per frame as ctx.view.pixelScale; derive it here only
    // when that is missing (fixtures / older hosts).
    let pixelScale = ctx.view && ctx.view.pixelScale > 0 ? ctx.view.pixelScale : 0;
    if (!(pixelScale > 0)) {
      let h = 0, m5 = 0;
      if (renderer.xr.isPresenting) {
        const cams = renderer.xr.getCamera().cameras;
        if (cams && cams.length && cams[0].viewport && cams[0].viewport.w > 0) { h = cams[0].viewport.w; m5 = cams[0].projectionMatrix.elements[5]; }
        if (!(h > 0) || !(m5 > 0)) { h = 1700; m5 = 1; } // Quest-ish default: ~1700 px, 90° fov
      } else {
        h = renderer.domElement.height || 1000; m5 = camera.projectionMatrix.elements[5] || 1;
      }
      pixelScale = h * m5 * 0.5;
    }
    const fogDensity = ctx.scene.fog ? ctx.scene.fog.density : CONFIG.fog.density;
    for (const mat of [S.matMain, S.matMirror]) {
      mat.uniforms.uPixelScale.value = pixelScale;
      mat.uniforms.uLevel.value = level;
      mat.uniforms.uTime.value = t;
      mat.uniforms.uFogDensity.value = fogDensity;
    }

    // ---- homes drift after the player once the player has wandered off
    const head = ctx.playerCtl.state.headWorld;
    let cx = 0, cz = 0;
    for (let k = 0; k < HOME_SPECS.length; k++) { cx += homes[k * 3]; cz += homes[k * 3 + 2]; }
    cx /= HOME_SPECS.length; cz /= HOME_SPECS.length;
    const dHome = Math.hypot(head.x - cx, head.z - cz);
    if (!S.following && dHome > P.followFar) S.following = true;
    else if (S.following && dHome < P.followNear) S.following = false;
    if (S.following) {
      const a = Math.min(1, dt * P.followRate);
      for (let k = 0; k < HOME_SPECS.length; k++) {
        homes[k * 3] += (head.x + homeRel[k * 2] - homes[k * 3]) * a;
        homes[k * 3 + 2] += (head.z + homeRel[k * 2 + 1] - homes[k * 3 + 2]) * a;
      }
    }
    for (let k = 0; k < HOME_SPECS.length; k++) homes[k * 3 + 1] = level + HOME_HEIGHT;

    // ---- hand flags
    const stillSpeed = CONFIG.hands.stillSpeed ?? 0.15;
    for (let hi = 0; hi < 2; hi++) {
      const hs = hands[hi];
      const ok = !!hs && hs.visible && !hs.submerged;
      hf.attract[hi] = ok && hs.openStill;
      hf.hold[hi] = ok && hs.speed <= P.leaveSpeed;
      hf.approach[hi] = ok && hs.open && hs.speed <= P.leaveSpeed;
      hf.repel[hi] = !!hs && hs.visible && hs.speed > P.repelSpeed;
      hf.still[hi] = !!hs && (hs.still || hs.speed < stillSpeed);
    }

    // ---- recruiting: an open still hand pulls one wandering firefly per slot, staggered in time
    for (let hi = 0; hi < 2; hi++) {
      recruitT[hi] -= dt;
      if (!hf.attract[hi] || recruitT[hi] > 0) continue;
      const hs = hands[hi];
      let s = -1;
      for (let k = 0; k < SLOTS; k++) { if (slots[hi][k] < 0 && hs.joints[SLOT_JOINTS[k]].valid) { s = k; break; } }
      if (s < 0) continue;
      const jp = hs.joints[SLOT_JOINTS[s]].position;
      let best = -1, bestD = P.recruitRange * P.recruitRange;
      for (let i = 0; i < N; i++) {
        if (state[i] !== WANDER || cooldown[i] > 0) continue;
        const dx = pos[i * 3] - jp.x, dy = pos[i * 3 + 1] - jp.y, dz = pos[i * 3 + 2] - jp.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestD) { bestD = d2; best = i; }
      }
      if (best >= 0) {
        state[best] = APPROACH; slotHand[best] = hi; slotIdx[best] = s; slots[hi][s] = best;
        recruitT[hi] = P.recruitInterval + rnd() * 0.3;
      }
    }

    const releaseSlot = (i) => {
      const sh = slotHand[i];
      if (sh >= 0) { const ss = slotIdx[i]; if (slots[sh][ss] === i) slots[sh][ss] = -1; }
      slotHand[i] = -1; slotIdx[i] = -1;
    };
    // burst away along (ax, ay, az) with an upward bias; enters SCATTER for ~1 s
    const burst = (i, ax, ay, az, strength) => {
      let l = Math.hypot(ax, ay, az);
      if (l < 1e-4) { ax = 0; ay = 1; az = 0; l = 1; }
      const sp = strength * (0.8 + 0.4 * rnd());
      vel[i * 3] = (ax / l) * sp + (rnd() - 0.5) * 0.4;
      vel[i * 3 + 1] = Math.max(ay / l, 0.15) * sp * 0.6 + 0.45 + rnd() * 0.35;
      vel[i * 3 + 2] = (az / l) * sp + (rnd() - 0.5) * 0.4;
      state[i] = SCATTER; timer[i] = t + 0.8 + rnd() * 0.6; cooldown[i] = P.cooldown;
    };
    // flash level 0..1: a smooth ~0.15 s rise to the peak, a cubic ~0.5 s tail, an ember in between
    const blink = (i) => {
      if (steady[i]) return 0.11 + 0.06 * Math.sin(t * 0.9 + seed[i] * 97);   // the long-glowers breathe slowly
      const pd = period[i];
      let tau = (t + phase[i]) % pd;   // seconds since this flash began
      if (tau < 0) tau += pd;
      const rise = FLASH.rise * (0.85 + 0.3 * seed[i]);
      let env;
      if (tau < rise) { const x = tau / rise; env = x * x * (3 - 2 * x); }
      else { const d = 1 - (tau - rise) / (FLASH.decay * (0.9 + 0.25 * seed[i])); env = d > 0 ? d * d * d : 0; }
      return FLASH.ember + (1 - FLASH.ember) * env;
    };

    // ---- loose synchrony, at SYNC.dt: each cloud's flashers are pulled toward the cloud's mean phase by
    // K(t) * R * sin(psi - theta), K swelling and relaxing over the cloud's own period (peak: most of the
    // cloud locks within a few seconds; trough: their different rates pull them apart again)
    S.syncT -= dt;
    if (S.syncT <= 0) {
      S.syncT += SYNC.dt;
      if (S.syncT < 0) S.syncT = SYNC.dt;   // a long stall: one pass, not a burst of catch-up passes
      const acc = S.syncAcc, psi = S.syncPsi, kg = S.syncGain, coh = S.coherence;
      acc.fill(0);
      const TAU = Math.PI * 2;
      for (let i = 0; i < N; i++) {
        if (steady[i] || (state[i] !== WANDER && state[i] !== SCATTER)) continue;
        const th = TAU * (((t + phase[i]) / period[i]) % 1);
        const k3 = homeIdx[i] * 3;
        acc[k3] += Math.cos(th); acc[k3 + 1] += Math.sin(th); acc[k3 + 2] += 1;
      }
      for (let k = 0; k < HOME_SPECS.length; k++) {
        const n = acc[k * 3 + 2];
        if (n < 2) { coh[k] = 0; kg[k] = 0; continue; }
        const cx = acc[k * 3] / n, cy = acc[k * 3 + 1] / n;
        const R = Math.sqrt(cx * cx + cy * cy);
        coh[k] = R; psi[k] = Math.atan2(cy, cx);
        const w = 0.5 + 0.5 * Math.sin(t * TAU / SYNC.swell[k] + k * 2.1);
        kg[k] = SYNC.kMax * w * w * R * SYNC.dt;
      }
      for (let i = 0; i < N; i++) {
        if (steady[i] || (state[i] !== WANDER && state[i] !== SCATTER)) continue;
        const k = homeIdx[i];
        if (kg[k] <= 0) continue;
        const pd = period[i];
        const th = TAU * (((t + phase[i]) / pd) % 1);
        let p = phase[i] + kg[k] * Math.sin(psi[k] - th) / TAU * pd;
        p %= pd; if (p < 0) p += pd;
        phase[i] = p;
      }
    }

    const yMin = level + P.yMin, yMax = level + P.yMax, ySoftMin = level + P.ySoftMin, ySoftMax = level + P.ySoftMax;
    const repelR2 = P.repelRadius * P.repelRadius;
    let landed = 0;

    for (let i = 0; i < N; i++) {
      const i3 = i * 3;
      let x = pos[i3], y = pos[i3 + 1], z = pos[i3 + 2];
      let vx = vel[i3], vy = vel[i3 + 1], vz = vel[i3 + 2];
      let st = state[i];
      if (cooldown[i] > 0) cooldown[i] -= dt;

      // a fast hand scatters everything near it
      for (let hi = 0; hi < 2; hi++) {
        if (!hf.repel[hi]) continue;
        const pp = hands[hi].palm.position;
        const dx = x - pp.x, dy = y - pp.y, dz = z - pp.z;
        if (dx * dx + dy * dy + dz * dz < repelR2) {
          releaseSlot(i); burst(i, dx, dy + 0.3, dz, 1.4);
          st = SCATTER; vx = vel[i3]; vy = vel[i3 + 1]; vz = vel[i3 + 2];
        }
      }

      if (st === LANDED) {
        const hi = slotHand[i], hs = hands[hi], s = slotIdx[i];
        const j = hs.joints[SLOT_JOINTS[s]];
        if (!hf.hold[hi] || !j.valid || slots[hi][s] !== i || t - timer[i] > stay[i]) {
          releaseSlot(i); burst(i, rnd() - 0.5, 1, rnd() - 0.5, 1.0);
          st = SCATTER; vx = vel[i3]; vy = vel[i3 + 1]; vz = vel[i3 + 2];
        } else {
          const n = hs.palm.normal;
          x = j.position.x + n.x * P.landOffset; y = j.position.y + n.y * P.landOffset; z = j.position.z + n.z * P.landOffset;
          if (y < level + 0.03) y = level + 0.03;
          pos[i3] = x; pos[i3 + 1] = y; pos[i3 + 2] = z;
          vel[i3] = 0; vel[i3 + 1] = 0; vel[i3 + 2] = 0;
          bright[i] = 0.9 + 0.1 * Math.sin(t * 2.5 + seed[i] * 20);
          landed++;
          continue;
        }
      }

      if (st === APPROACH) {
        const hi = slotHand[i], hs = hands[hi], s = slotIdx[i];
        const j = hs.joints[SLOT_JOINTS[s]];
        if (!hf.approach[hi] || !j.valid || slots[hi][s] !== i) {
          releaseSlot(i); st = WANDER; cooldown[i] = P.abortCooldown;
        } else {
          const n = hs.palm.normal;
          const tx = j.position.x + n.x * P.landOffset, ty = j.position.y + n.y * P.landOffset, tz = j.position.z + n.z * P.landOffset;
          const dx = tx - x, dy = ty - y, dz = tz - z;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d < P.landDist && hf.still[hi]) {
            // LAND
            x = tx; y = ty; z = tz;
            if (y < level + 0.03) y = level + 0.03;
            pos[i3] = x; pos[i3 + 1] = y; pos[i3 + 2] = z;
            vel[i3] = 0; vel[i3 + 1] = 0; vel[i3 + 2] = 0;
            state[i] = LANDED; timer[i] = t; stay[i] = P.stayMin + rnd() * (P.stayMax - P.stayMin);
            bright[i] = 1;
            landed++;
            ctx.energy = Math.min(1, ctx.energy + CONFIG.energy.firefly);
            ctx.events.emit('fireflyland', { pos: new THREE.Vector3(x, y, z), hand: hs, joint: SLOT_JOINTS[s], index: i });
            continue;
          }
          const sp = Math.min(P.approachMax, 0.08 + d * 2.2);   // ease in over the last ~25 cm
          const inv = d > 1e-5 ? sp / d : 0;
          const s1 = seed[i] * 97, wob = 0.12 * Math.min(1, d); // a little wobble: not a straight line
          const dvx = dx * inv + wob * Math.sin(t * 5.1 + s1);
          const dvy = dy * inv + wob * Math.sin(t * 4.3 + s1 * 1.7);
          const dvz = dz * inv + wob * Math.cos(t * 4.7 + s1 * 0.5);
          const k = Math.min(1, dt * 3.5);
          vx += (dvx - vx) * k; vy += (dvy - vy) * k; vz += (dvz - vz) * k;
          x += vx * dt; y += vy * dt; z += vz * dt;
          bright[i] = Math.max(blink(i), 0.35);
        }
      }

      if (st === SCATTER) {
        if (t > timer[i]) st = WANDER;
        else {
          const damp = Math.max(0, 1 - 1.6 * dt);
          vx *= damp; vy = vy * damp + 0.2 * dt; vz *= damp;
          x += vx * dt; y += vy * dt; z += vz * dt;
          bright[i] = 0.5 + 0.5 * Math.abs(Math.sin(t * 23 + seed[i] * 50));
        }
      }

      if (st === WANDER) {
        const s1 = seed[i] * 97, f = 0.8 + 0.6 * seed[i];
        const wx = Math.sin(t * f + s1) * 0.7 + Math.sin(t * f * 2.7 + s1 * 1.9) * 0.3;
        const wy = Math.sin(t * f * 1.3 + s1 * 2.3) * 0.5 + Math.sin(t * f * 3.1 + s1 * 0.6) * 0.2;
        const wz = Math.cos(t * f * 0.9 + s1 * 1.4) * 0.7 + Math.cos(t * f * 2.3 + s1 * 3.1) * 0.3;
        const hk = homeIdx[i] * 3;
        const hx = homes[hk] + homeOff[i3] - x, hy = homes[hk + 1] + homeOff[i3 + 1] - y, hz = homes[hk + 2] + homeOff[i3 + 2] - z;
        const hd = Math.sqrt(hx * hx + hy * hy + hz * hz);
        const pk = hd > 1e-4 ? Math.min(P.homeMaxPull, hd * P.homeSpring) / hd : 0;
        let dvx = P.wanderSpeed * wx + hx * pk;
        let dvy = P.wanderSpeed * wy * 0.6 + hy * pk;
        let dvz = P.wanderSpeed * wz + hz * pk;
        if (y < ySoftMin) dvy += (ySoftMin - y) * 2.0;
        else if (y > ySoftMax) dvy -= (y - ySoftMax) * 2.0;
        const k = Math.min(1, dt * 1.8);
        vx += (dvx - vx) * k; vy += (dvy - vy) * k; vz += (dvz - vz) * k;
        const sp2 = vx * vx + vy * vy + vz * vz;
        if (sp2 > P.wanderMax * P.wanderMax) { const r = P.wanderMax / Math.sqrt(sp2); vx *= r; vy *= r; vz *= r; }
        x += vx * dt; y += vy * dt; z += vz * dt;
        bright[i] = blink(i);
      }

      // never below the water, never above the band
      if (y < yMin) { y = yMin; if (vy < 0) vy = -vy * 0.5; }
      else if (y > yMax) { y = yMax; if (vy > 0) vy = -vy * 0.5; }

      state[i] = st;
      pos[i3] = x; pos[i3 + 1] = y; pos[i3 + 2] = z;
      vel[i3] = vx; vel[i3 + 1] = vy; vel[i3 + 2] = vz;
    }

    S.posAttr.needsUpdate = true;
    S.brightAttr.needsUpdate = true;
    ctx.fireflies.landedCount = landed;
  },
};
