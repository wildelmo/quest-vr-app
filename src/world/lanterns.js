import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';
import {
  LANTERN_BODY_VERT, LANTERN_BODY_FRAG,
  LANTERN_GLOW_VERT, LANTERN_MIRROR_VERT, LANTERN_GLOW_FRAG,
  LANTERN_FLAME_VERT, LANTERN_FLAME_FRAG,
} from '../shaders/lanterns.js';

/**
 * Paper lanterns. Up to MAX of them float on the lake, can be pinched and carried, and rise into the
 * sky when released above the water, becoming a new star (the 'lanternstar' event, handled by sky.js).
 *
 * Draw calls: 4 — one InstancedMesh (bodies), one Points (glows, renderOrder 4), one Points (mirrored
 * glows under the water, renderOrder 1) and one Points (flames). Everything is in world space.
 *
 * States: 'floating' | 'held' | 'rising'.
 *  - floating: sits on the swell, drifts with a per-lantern wind + random walk; arrivals home in from
 *    ~45 m (fog) and loiter at 5-8 m while 6 lanterns are already within reach; a gentle pull toward an
 *    open hand turns near-misses into grabs.
 *  - held: a point mass on an 8 cm string under the pinch point (position-based pendulum, unilateral
 *    so it can go slack and float when pushed under water); the body tilts along the string.
 *  - rising: the string's anchor becomes a virtual balloon: 0.4 s buoyancy ramp, 0.25 -> 0.5 m/s,
 *    then an eased climb to ~60 m over 25 s, fading out over the last 5 s -> 'lanternstar' -> recycled.
 *
 * Grab protocol (src/core/hands.js): each lantern keeps an entry in ctx.grabbables
 * { position, radius, active, held, warm, onGrab(hand), onRelease(hand, velocity, { lost }) }.
 *
 * Public surface: ctx.lanterns = { list, count, MAX }; list entries expose { position (centre, Vector3),
 * top (Vector3), state, bright, seed, held, attracted }.
 * Events: 'lanterngrab' {pos, hand}, 'lanternrelease' {pos, hand}, 'lanternsplash' {pos}, 'lanternstar' {dir, pos}.
 */
const MAX = 24;
const H = 0.26;               // lantern height (m); geometry origin is at the top (hanging point)
const RADIUS = 0.075;         // widest radius
const SUBMERGE = 0.03;        // how deep the bottom sits when floating
const STRING = 0.08;          // string length: top of the lantern below the pinch point when carried
const GRAB_RADIUS = 0.12;
const KEEP_RADIUS = 28;       // a lantern that has drifted beyond this comes back as a new arrival
const SPAWN_RADIUS = 45;      // arrivals start here, in the fog
const SPAWN_INTERVAL = 40;
const INITIAL_NEAR = 6, INITIAL_MID = 4;
const NEAR_LIMIT = 6, NEAR_RADIUS = 3.5;
const WIND_SPEED = 0.04;
const WIND_DIR = new THREE.Vector2(-1, 0.55).normalize(); // toward -x, +z-ish
const RISE_GRAB_WINDOW = 3;   // seconds after release during which it can be caught again
const RISE_TOTAL = 25;        // seconds from release to becoming a star
const RISE_FADE = 5;          // fade-out over the last seconds
const ENERGY_ALT = 3;         // altitude at which the aurora answers
const SWAY_AMP = 0.3, SWAY_PERIOD = 6;
const BRIGHT_FLOAT = 0.55;
const GRAVITY = 9.81;
const ATTRACT_RADIUS = 0.35, ATTRACT_K = 2.5, ATTRACT_VMAX = 0.25;

// mulberry32: small seeded PRNG so placement is deterministic (and testable)
function makeRng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const easeOutBack = (x) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
const smooth01 = (x) => { x = THREE.MathUtils.clamp(x, 0, 1); return x * x * (3 - 2 * x); };

function makeBodyGeometry() {
  // gently bulging paper profile (radius, height from the bottom); origin moved to the top
  const profile = [[0.046, 0], [0.062, 0.022], [0.071, 0.06], [RADIUS, 0.115], [0.073, 0.17], [0.066, 0.215], [0.054, 0.245], [0.045, H]];
  const lathe = new THREE.LatheGeometry(profile.map(([x, y]) => new THREE.Vector2(x, y - H)), 24);
  const ring = (y) => { const g = new THREE.CylinderGeometry(0.048, 0.048, 0.012, 24, 1, false); g.translate(0, y, 0); return g; };
  const top = ring(-0.006), bottom = ring(-H + 0.006);
  const tag = (g, v) => g.setAttribute('aPart', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count).fill(v), 1));
  tag(lathe, 0); tag(top, 1); tag(bottom, 1);
  const merged = mergeGeometries([lathe, top, bottom], false);
  lathe.dispose(); top.dispose(); bottom.dispose();
  return merged;
}

// vertical speed of the virtual balloon, seconds after release
function riseSpeed(tau) {
  if (tau < 0.4) return 0.25 * smooth01(tau / 0.4);                       // buoyancy ramps up
  if (tau < 3.4) return 0.25 + 0.25 * smooth01((tau - 0.4) / 3);           // 0.25 -> 0.5 m/s in reach
  const u = THREE.MathUtils.clamp((tau - 3.4) / (RISE_TOTAL - 3.4), 0, 1);
  return 0.5 + 3.4 * Math.pow(Math.sin(Math.PI * u), 0.8);                 // eased climb to ~60 m by RISE_TOTAL
}

export const lanterns = {
  name: 'lanterns',

  init(ctx) {
    const tex = ctx.assets.tex;
    const rng = makeRng(0x5eed1a17);
    const level = ctx.water.level;

    // ---- bodies: one InstancedMesh
    const bodyGeo = makeBodyGeometry();
    const seedArr = new Float32Array(MAX), brightArr = new Float32Array(MAX), heldArr = new Float32Array(MAX);
    const aSeed = new THREE.InstancedBufferAttribute(seedArr, 1);
    const aBright = new THREE.InstancedBufferAttribute(brightArr, 1).setUsage(THREE.DynamicDrawUsage);
    const aHeld = new THREE.InstancedBufferAttribute(heldArr, 1).setUsage(THREE.DynamicDrawUsage);
    bodyGeo.setAttribute('aSeed', aSeed);
    bodyGeo.setAttribute('aBright', aBright);
    bodyGeo.setAttribute('aHeld', aHeld);
    const bodyMat = new THREE.ShaderMaterial({
      uniforms: {
        uPaper: { value: tex.paper },
        uTime: { value: 0 },
        uHeight: { value: H },
        uColor: { value: new THREE.Color(CONFIG.colors.lantern) },
        uColorHot: { value: new THREE.Color(CONFIG.colors.lanternHot) },
        uFogColor: { value: new THREE.Color(CONFIG.fog.color) },
        uFogDensity: { value: CONFIG.fog.density },
      },
      vertexShader: LANTERN_BODY_VERT,
      fragmentShader: LANTERN_BODY_FRAG,
      side: THREE.FrontSide, transparent: false, depthWrite: true, depthTest: true, fog: false,
    });
    const bodies = new THREE.InstancedMesh(bodyGeo, bodyMat, MAX);
    bodies.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    bodies.count = 0;
    bodies.frustumCulled = false;
    bodies.renderOrder = 3;
    bodies.name = 'lanternBodies';
    ctx.scene.add(bodies);

    // ---- points: one geometry shared by the glow, the mirrored glow and the flames
    const pGeo = new THREE.BufferGeometry();
    const pPos = new Float32Array(MAX * 3), pBright = new Float32Array(MAX), pSeed = new Float32Array(MAX), pFlame = new Float32Array(MAX).fill(1);
    pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3).setUsage(THREE.DynamicDrawUsage));
    pGeo.setAttribute('aBright', new THREE.BufferAttribute(pBright, 1).setUsage(THREE.DynamicDrawUsage));
    pGeo.setAttribute('aFlame', new THREE.BufferAttribute(pFlame, 1).setUsage(THREE.DynamicDrawUsage));
    pGeo.setAttribute('aSeed', new THREE.BufferAttribute(pSeed, 1));
    pGeo.setDrawRange(0, 0);
    const glowUniforms = (gain) => ({
      uMap: { value: tex.glowSoft },
      uColor: { value: new THREE.Color(CONFIG.colors.lantern) },
      uColorHot: { value: new THREE.Color(CONFIG.colors.lanternHot) },
      uPixelScale: { value: 500 },
      uSize: { value: 0.55 },
      uWaterLevel: { value: level },
      uTime: { value: 0 },
      uPull: { value: 0.11 },
      uGain: { value: gain },
    });
    const glowMat = new THREE.ShaderMaterial({
      uniforms: glowUniforms(1.0), vertexShader: LANTERN_GLOW_VERT, fragmentShader: LANTERN_GLOW_FRAG,
      transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, fog: false,
    });
    const mirrorMat = new THREE.ShaderMaterial({
      uniforms: glowUniforms(0.45), vertexShader: LANTERN_MIRROR_VERT, fragmentShader: LANTERN_GLOW_FRAG,
      transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, fog: false,
    });
    const flameMat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: tex.glowFirefly }, uPixelScale: { value: 500 }, uTime: { value: 0 }, uPull: { value: 0.11 } },
      vertexShader: LANTERN_FLAME_VERT, fragmentShader: LANTERN_FLAME_FRAG,
      transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, fog: false,
    });
    const glow = new THREE.Points(pGeo, glowMat); glow.renderOrder = 4; glow.frustumCulled = false; glow.name = 'lanternGlow';
    // the reflection sprite sits on the surface, so it goes just after the water (see LANTERN_MIRROR_VERT)
    const mirror = new THREE.Points(pGeo, mirrorMat); mirror.renderOrder = 3; mirror.frustumCulled = false; mirror.name = 'lanternGlowMirror';
    const flames = new THREE.Points(pGeo, flameMat); flames.renderOrder = 4; flames.frustumCulled = false; flames.name = 'lanternFlames';
    ctx.scene.add(glow, mirror, flames);

    // ---- lantern records
    const list = [];
    ctx.lanterns = { list, count: 0, MAX };
    const s = this._ = {
      ctx, rng, list, bodies, bodyMat, glowMat, mirrorMat, flameMat, pGeo, pPos, pBright, pFlame, seedArr, brightArr, heldArr, aSeed, aBright, aHeld,
      spawnTimer: SPAWN_INTERVAL,
      tmp: { v: new THREE.Vector3(), v2: new THREE.Vector3(), q: new THREE.Quaternion(), q2: new THREE.Quaternion(), m: new THREE.Matrix4(), axis: new THREE.Vector3(), one: new THREE.Vector3(1, 1, 1) },
    };

    const rigPos = () => ctx.player.position;
    const surfaceY = (x, z, t, seed) => level + ctx.water.swell(x, z, t) + 0.005 * Math.sin(t * 1.1 + seed * 12);
    const floatCentreY = (x, z, t, seed) => surfaceY(x, z, t, seed) + H * 0.5 - SUBMERGE;

    function spawn(x, z, incoming) {
      if (list.length >= MAX) return null;
      const i = list.length;
      const seed = rng();
      const L = {
        i, seed, state: 'floating', held: null, incoming, attracted: false, dropping: false,
        position: new THREE.Vector3(x, floatCentreY(x, z, ctx.time.t, seed), z), // centre of the body (grab point)
        top: new THREE.Vector3(),          // hanging point (the pendulum bob while held/rising)
        anchor: new THREE.Vector3(),       // the other end of the string: pinch point, then the virtual balloon
        bobVel: new THREE.Vector3(),
        up: new THREE.Vector3(0, 1, 0),    // body axis (bottom -> top)
        vel: new THREE.Vector3(),
        att: new THREE.Vector2(),          // attraction velocity toward an open hand
        bright: incoming ? 0 : BRIGHT_FLOAT, flame: 1,
        yaw: rng() * Math.PI * 2, spin: (rng() - 0.5) * 0.3,
        lean: new THREE.Vector2(), leanT: new THREE.Vector2(),
        wind: WIND_DIR.clone().rotateAround(new THREE.Vector2(), THREE.MathUtils.degToRad((rng() - 0.5) * 40)).multiplyScalar(WIND_SPEED),
        walk: new THREE.Vector2(), walkT: new THREE.Vector2(), walkTimer: rng() * 3,
        loiterR: 5 + rng() * 3,
        grabT: 0, grabLen: STRING, riseTime: 0, energyFired: false, swayPhase: rng() * Math.PI * 2, swayAxis: new THREE.Vector2(),
        disturbT: rng() * 0.5,
        grab: null,
      };
      L.top.copy(L.position).y += H * 0.5;
      L.grab = {
        position: L.position, radius: GRAB_RADIUS, active: true, held: null, warm: true, kind: 'lantern', lantern: L,
        onGrab(hand) { onGrab(L, hand); },
        onRelease(hand, velocity, info) { onRelease(L, hand, velocity, info); },
      };
      list.push(L);
      ctx.grabbables.push(L.grab);
      seedArr[i] = seed; pSeed[i] = seed;
      aSeed.needsUpdate = true; pGeo.attributes.aSeed.needsUpdate = true;
      bodies.count = list.length; pGeo.setDrawRange(0, list.length);
      ctx.lanterns.count = list.length;
      return L;
    }

    function farPoint(out) {
      const p = rigPos();
      const az = rng() * Math.PI * 2, r = SPAWN_RADIUS + (rng() - 0.5) * 6;
      return out.set(p.x + Math.sin(az) * r, 0, p.z - Math.cos(az) * r);
    }

    function respawnFar(L) {
      farPoint(L.position);
      L.position.y = floatCentreY(L.position.x, L.position.z, ctx.time.t, L.seed);
      L.top.copy(L.position).y += H * 0.5;
      L.vel.set(0, 0, 0); L.bobVel.set(0, 0, 0); L.att.set(0, 0); L.up.set(0, 1, 0);
      L.lean.set(0, 0); L.leanT.set(0, 0);
      L.state = 'floating'; L.incoming = true; L.bright = 0; L.held = null; L.dropping = false; L.attracted = false;
      L.loiterR = 5 + rng() * 3;
      L.grab.active = true; L.grab.held = null;
    }

    function spawnFar() { const p = farPoint(s.tmp.v); return spawn(p.x, p.z, true); }

    // 'drop' = let it fall/settle onto the water (tracking loss); true = it is already in the water: splash now
    function setFloating(L, splash) {
      L.state = 'floating'; L.held = null;
      L.grab.active = true; L.grab.held = null;
      L.vel.copy(L.bobVel); L.att.set(0, 0);
      L.bobVel.set(0, 0, 0);
      if (splash === 'drop') L.dropping = true;
      else if (splash) {
        ctx.water.disturb?.(L.position.x, L.position.z, 0.14, 0.45);
        ctx.events.emit('lanternsplash', { pos: L.position.clone(), lantern: L });
      }
    }

    function onGrab(L, hand) {
      const wasRising = L.state === 'rising';
      L.state = 'held'; L.held = hand; L.incoming = false; L.attracted = false; L.dropping = false;
      L.anchor.copy(hand.pinch.point);
      if (!wasRising) { L.top.copy(L.position).addScaledVector(L.up, H * 0.5); L.bobVel.copy(L.vel); }
      L.att.set(0, 0);
      // ease the string from its current length to STRING over ~120 ms (with a little overshoot)
      L.grabT = 0; L.grabLen = Math.max(0.01, L.top.distanceTo(L.anchor));
      ctx.events.emit('lanterngrab', { pos: L.position.clone(), hand, lantern: L });
    }

    function onRelease(L, hand, velocity, info) {
      L.held = null; L.grab.held = null;
      if (info && info.lost) { setFloating(L, 'drop'); return; }   // tracking was lost: never rises
      if (L.top.y - H > level) {                                     // the bottom is clear of the water: it rises
        L.state = 'rising'; L.riseTime = 0; L.energyFired = false;
        // the string's anchor turns into a virtual balloon from the pinch point (the hand's lift carries over)
        if (velocity && velocity.y > 0) L.bobVel.y += velocity.y * 0.5;
        L.swayAxis.set(-L.wind.y, L.wind.x).normalize();
        L.swayPhase = rng() * Math.PI * 2;
        L.grab.active = true; // can be caught again during the first seconds
        ctx.events.emit('lanternrelease', { pos: L.position.clone(), hand, lantern: L });
      } else {
        setFloating(L, true);
      }
    }

    function becomeStar(L) {
      const head = ctx.playerCtl.state.headWorld;
      const dir = L.position.clone().sub(head).normalize();
      ctx.events.emit('lanternstar', { dir, pos: L.position.clone(), lantern: L });
      respawnFar(L);
    }

    // ---- initial placement: around the player but out of the front sector (-40..+40 deg about -Z)
    {
      const p = rigPos();
      const arc = 280, start = 40;
      for (let k = 0; k < INITIAL_NEAR; k++) {
        const az = THREE.MathUtils.degToRad(start + (k + 0.5) * (arc / INITIAL_NEAR) + (rng() - 0.5) * 16);
        const r = 1.3 + rng() * 1.9;
        spawn(p.x + Math.sin(az) * r, p.z - Math.cos(az) * r, false);
      }
      for (let k = 0; k < INITIAL_MID; k++) {
        const az = THREE.MathUtils.degToRad(start + (k + 0.5) * (arc / INITIAL_MID) + (rng() - 0.5) * 40);
        const r = 6 + rng() * 4;
        const L = spawn(p.x + Math.sin(az) * r, p.z - Math.cos(az) * r, true);
        if (L) L.bright = BRIGHT_FLOAT;
      }
    }

    Object.assign(s, { spawn, spawnFar, respawnFar, setFloating, becomeStar, floatCentreY, surfaceY });
  },

  update(ctx, dt) {
    const s = this._;
    const { list, tmp } = s;
    const t = ctx.time.t;
    const level = ctx.water.level;
    const rig = ctx.player.position;
    const head = ctx.playerCtl.state.headWorld;
    const swell = ctx.water.swell;
    const hands = ctx.hands ? ctx.hands.list : [];

    // arrivals from the far shore
    s.spawnTimer -= dt;
    if (s.spawnTimer <= 0) { s.spawnTimer = SPAWN_INTERVAL; if (list.length < MAX) s.spawnFar(); }

    // how many are already within reach (scarcity: arrivals wait at a distance while >= NEAR_LIMIT)
    let nearCount = 0;
    for (const L of list) { if (L.state !== 'rising' && Math.hypot(L.position.x - rig.x, L.position.z - rig.z) < NEAR_RADIUS) nearCount++; }
    const crowded = nearCount >= NEAR_LIMIT;

    for (let i = 0; i < list.length; i++) {
      const L = list[i];
      const P = L.position;

      if (L.state === 'held' || L.state === 'rising') {
        const A = L.anchor;
        let bilateral = false, len = STRING;
        if (L.state === 'held') {
          const hand = L.held;
          const tracked = hand && hand.tracked !== false;
          if (tracked) A.copy(hand.pinch.point);           // else: tracking-loss grace, keep the last anchor
          L.grabT += dt;
          if (L.grabT < 0.12) { len = THREE.MathUtils.lerp(L.grabLen, STRING, easeOutBack(L.grabT / 0.12)); bilateral = true; }
          else if (L.grabT < 0.3) bilateral = true;        // finish settling onto the string before it may go slack
          L.bright += ((tracked ? 1 : 0.6) - L.bright) * Math.min(1, dt * 3);
          if (P.y - H * 0.5 < level && (L.disturbT -= dt) <= 0) { L.disturbT = 0.25; ctx.water.disturb?.(P.x, P.z, 0.1, 0.08 + Math.min(0.3, L.bobVel.length() * 0.15)); }
        } else {
          L.riseTime += dt;
          const tau = L.riseTime;
          const vy = riseSpeed(tau);
          const alt = Math.max(0, A.y - level);
          const windK = 1 + Math.min(2, alt * 0.12);
          const ph = (Math.PI * 2 / SWAY_PERIOD) * tau + L.swayPhase;
          const sw = SWAY_AMP * (Math.PI * 2 / SWAY_PERIOD) * Math.cos(ph);
          A.x += (L.wind.x * windK + L.swayAxis.x * sw) * dt;
          A.z += (L.wind.y * windK + L.swayAxis.y * sw) * dt;
          A.y += vy * dt;
          const fade = tau > RISE_TOTAL - RISE_FADE ? 1 - (tau - (RISE_TOTAL - RISE_FADE)) / RISE_FADE : 1;
          L.bright += (Math.max(0, fade) - L.bright) * Math.min(1, dt * 2.5);
          if (L.riseTime > RISE_GRAB_WINDOW && L.grab.active) L.grab.active = false;
          if (!L.energyFired && P.y - level > ENERGY_ALT) { L.energyFired = true; ctx.energy = 1 - (1 - ctx.energy) * 0.65; }
          if (tau >= RISE_TOTAL) { s.becomeStar(L); continue; }
        }
        stepPendulum(L, A, dt, bilateral, len, level, tmp);
        // body axis follows the string when it hangs taut from above; when the string is slack or pulls
        // from below (a buoyant lantern held under the hand) it rights itself instead of flipping over
        tmp.v.subVectors(A, L.top);
        const d = tmp.v.length();
        if (d > len - 0.004 && d > 0.01) {
          tmp.v.divideScalar(d);
          const hang = THREE.MathUtils.smoothstep(tmp.v.y, -0.1, 0.35);
          tmp.v.multiplyScalar(hang).y += 1 - hang;
          tmp.v.normalize();
        } else tmp.v.set(0, 1, 0);
        L.up.lerp(tmp.v, Math.min(1, dt * 14)).normalize();
        P.copy(L.top).addScaledVector(L.up, -H * 0.5);
        L.vel.copy(L.bobVel);
        const la = Math.acos(THREE.MathUtils.clamp(L.up.y, -1, 1));
        const lh = Math.hypot(L.up.x, L.up.z);
        if (lh > 1e-5) L.leanT.set(L.up.x / lh * la, L.up.z / lh * la); else L.leanT.set(0, 0);
        L.lean.lerp(L.leanT, Math.min(1, dt * 14));
        L.flame += (1 - L.flame) * Math.min(1, dt * 3);
      } else { // floating
        // drift: wind (per-lantern direction) + slow random walk (+ homing while drifting in from far away)
        L.walkTimer -= dt;
        if (L.walkTimer <= 0) { L.walkTimer = 3 + s.rng() * 5; L.walkT.set((s.rng() - 0.5) * 0.06, (s.rng() - 0.5) * 0.06); }
        L.walk.lerp(L.walkT, Math.min(1, dt * 0.35));
        let vx = L.wind.x + L.walk.x, vz = L.wind.y + L.walk.y;
        const dxp = rig.x - P.x, dzp = rig.z - P.z;
        const dp = Math.hypot(dxp, dzp);
        if (L.incoming) {
          if (dp < 2.5) L.incoming = false;
          else {
            let sp = 0.12 + 0.35 * THREE.MathUtils.smoothstep(dp, 5, 25);
            if (crowded) sp *= THREE.MathUtils.smoothstep(dp, L.loiterR, L.loiterR + 1.5); // wait out here
            vx += dxp / dp * sp; vz += dzp / dp * sp;
          }
        }
        // near-miss help: a gentle pull toward an open, visible hand above the water
        let attracted = false;
        for (const h of hands) {
          if (!h || !h.visible || h.active === false || !h.open || h.submerged || h.pinch.active) continue;
          const hp = h.pinch.point;
          const ax = hp.x - P.x, az = hp.z - P.z;
          const ad = Math.hypot(ax, az);
          if (ad > ATTRACT_RADIUS || ad < 1e-4 || Math.abs(hp.y - P.y) > 0.6) continue;
          attracted = true;
          L.att.x += ax * ATTRACT_K * dt; L.att.y += az * ATTRACT_K * dt;
        }
        if (attracted) { if (L.att.length() > ATTRACT_VMAX) L.att.setLength(ATTRACT_VMAX); }
        else L.att.multiplyScalar(Math.max(0, 1 - 4 * dt));
        L.attracted = attracted;
        vx += L.att.x; vz += L.att.y;
        L.flame += ((attracted ? 1.3 : 1) - L.flame) * Math.min(1, dt * 4);
        // don't drift into the player's body
        const dxh = P.x - head.x, dzh = P.z - head.z;
        const dh = Math.hypot(dxh, dzh);
        if (dh < 0.5 && dh > 1e-4) { const k = (0.5 - dh) * 2.5; vx += dxh / dh * k; vz += dzh / dh * k; }
        // keep lanterns from overlapping
        for (let j = 0; j < list.length; j++) {
          if (j === i) continue;
          const O = list[j];
          if (O.state === 'rising') continue;
          const ox = P.x - O.position.x, oz = P.z - O.position.z;
          const d2 = ox * ox + oz * oz;
          if (d2 < 0.22 * 0.22 && d2 > 1e-6) { const d = Math.sqrt(d2), k = (0.22 - d) * 1.5; vx += ox / d * k; vz += oz / d * k; }
        }
        P.x += vx * dt; P.z += vz * dt;
        // vertical: damped spring onto the swell so it settles / bobs up when dropped in
        const ty = s.floatCentreY(P.x, P.z, t, L.seed);
        if (L.dropping) {
          // falling paper: gravity with drag, until it meets the water
          L.vel.y = Math.max(-1.2, L.vel.y - GRAVITY * 0.5 * dt);
          P.y += L.vel.y * dt;
          P.x += L.vel.x * dt * 0.5; P.z += L.vel.z * dt * 0.5; L.vel.x *= Math.max(0, 1 - 2 * dt); L.vel.z *= Math.max(0, 1 - 2 * dt);
          if (P.y <= ty + 0.01) {
            L.dropping = false; P.y = ty; L.vel.y *= 0.3;
            ctx.water.disturb?.(P.x, P.z, 0.12, 0.2);
            ctx.events.emit('lanternsplash', { pos: P.clone(), lantern: L });
          }
        } else {
          const w = 6, z = 0.7;
          L.vel.y += (w * w * (ty - P.y) - 2 * z * w * L.vel.y) * dt;
          L.vel.y = Math.max(-1.2, L.vel.y);
          P.y += L.vel.y * dt;
        }
        L.vel.x = vx; L.vel.z = vz;
        // lean with the wave slope (exaggerated a little) plus a slow wobble; right itself after a drop
        const e = 0.15;
        const sx = (swell(P.x + e, P.z, t) - swell(P.x - e, P.z, t)) / (2 * e);
        const sz = (swell(P.x, P.z + e, t) - swell(P.x, P.z - e, t)) / (2 * e);
        L.leanT.set(-sx * 2.5 + 0.04 * Math.sin(t * 0.9 + L.seed * 20), -sz * 2.5 + 0.04 * Math.cos(t * 0.7 + L.seed * 31));
        L.lean.lerp(L.leanT, Math.min(1, dt * 4));
        L.up.set(0, 1, 0);
        L.top.copy(P).y += H * 0.5;
        L.bright += (BRIGHT_FLOAT - L.bright) * Math.min(1, dt * (L.bright < BRIGHT_FLOAT ? (L.incoming ? 0.08 : 0.6) : 1.5));
        // tiny ripples from the moving hull (only where the wave sim is visible)
        L.disturbT -= dt;
        if (L.disturbT <= 0) {
          L.disturbT = 0.5;
          if (dp < 9 && !L.dropping) ctx.water.disturb?.(P.x, P.z, 0.09, 0.012 + Math.min(0.03, Math.hypot(vx, vz) * 0.12 + Math.abs(L.vel.y) * 0.05));
        }
        // drifted too far away: come back as a new arrival
        if (!L.incoming && dp > KEEP_RADIUS) s.respawnFar(L);
      }

      // spin
      L.yaw += L.spin * dt * (L.state === 'floating' ? 1 : 0.4);

      // instance matrix: rotate about the top (hanging point)
      const lx = L.lean.x, lz = L.lean.y;
      const la = Math.hypot(lx, lz);
      tmp.q2.setFromAxisAngle(tmp.axis.set(0, 1, 0), L.yaw);
      if (la > 1e-4) { tmp.axis.set(lz / la, 0, -lx / la); tmp.q.setFromAxisAngle(tmp.axis, la).multiply(tmp.q2); } else tmp.q.copy(tmp.q2);
      tmp.m.compose(L.top, tmp.q, tmp.one);
      s.bodies.setMatrixAt(i, tmp.m);
      s.brightArr[i] = L.bright; s.heldArr[i] = L.state === 'held' ? 1 : 0;
      s.pPos[i * 3] = P.x; s.pPos[i * 3 + 1] = P.y; s.pPos[i * 3 + 2] = P.z;
      s.pBright[i] = L.bright; s.pFlame[i] = L.flame;
    }

    s.bodies.instanceMatrix.needsUpdate = true;
    s.aBright.needsUpdate = true; s.aHeld.needsUpdate = true;
    s.pGeo.attributes.position.needsUpdate = true; s.pGeo.attributes.aBright.needsUpdate = true; s.pGeo.attributes.aFlame.needsUpdate = true;

    // uniforms
    const r = ctx.renderer;
    const pixelScale = r.xr.isPresenting ? 1700 / 2 : r.domElement.height / (2 * Math.tan(THREE.MathUtils.degToRad(ctx.camera.fov) * 0.5));
    s.bodyMat.uniforms.uTime.value = t;
    if (ctx.scene.fog) { s.bodyMat.uniforms.uFogColor.value.copy(ctx.scene.fog.color); s.bodyMat.uniforms.uFogDensity.value = ctx.scene.fog.density; }
    for (const m of [s.glowMat, s.mirrorMat]) { m.uniforms.uTime.value = t; m.uniforms.uPixelScale.value = pixelScale; m.uniforms.uWaterLevel.value = level; }
    s.flameMat.uniforms.uTime.value = t; s.flameMat.uniforms.uPixelScale.value = pixelScale;
  },
};

/**
 * Position-based pendulum step for the lantern's top (the bob) on a string from anchor A.
 * Gravity + damping (3/s in air, 10/s in water) + buoyancy when the body is pushed under; the string
 * is a rope (only pulls) unless `bilateral`, which is used while it eases onto the string after a grab.
 */
function stepPendulum(L, A, dt, bilateral, len, level, tmp) {
  const P = L.top, V = L.bobVel;
  const n = dt > 0.03 ? 2 : 1, h = dt / n;
  for (let k = 0; k < n; k++) {
    const bottom = P.y - H;
    let ay = -GRAVITY, damp = 3;
    if (bottom < level) { const depth = Math.min(1, (level - bottom) / (H * 0.6)); ay += GRAVITY * (0.6 + 1.2 * depth); damp = 10; }
    V.y += ay * h;
    V.multiplyScalar(Math.exp(-damp * h));
    tmp.v.copy(P).addScaledVector(V, h);
    tmp.v2.subVectors(tmp.v, A);
    const d = tmp.v2.length();
    if (d > 1e-5 && (bilateral || d > len)) { tmp.v2.multiplyScalar(len / d); tmp.v.copy(A).add(tmp.v2); }
    V.subVectors(tmp.v, P).divideScalar(h);
    const sp = V.length(); if (sp > 6) V.multiplyScalar(6 / sp);
    P.copy(tmp.v);
  }
}
