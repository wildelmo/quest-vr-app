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
 *  - the ribbon: an open hand carried slowly through the dark, palm up, recruits fireflies one by one
 *    from the nearest cloud; they fly in and then string out along the path the hand has taken (a
 *    distance-sampled trail, 8 cm apart), so the strand follows every slow curve. Stop, and the hand
 *    becomes an open still hand: the nearest of them take the landing slots; move fast and they scatter
 *  - the escort: letting a lantern go takes up to ten nearby fireflies (any resting on the releasing hand first)
 *    up with it; they spiral round the flame as it rises ('fireflyescort'; lanterns.js reads L.escorts to flare the
 *    flame) and ~4 s up they spill away as sparks ('fireflyspill') while their home cloud is kicked into step
 *  - the lake passes it on: 0.8 s after that lantern becomes a star, a wave of flashes rolls out from the player at
 *    walking pace ('lakewave'; every flash is re-phased to peak as the front reaches it, and the clouds hold that
 *    phase for a few seconds); lotus.js and the audio answer the same event
 * Per-firefly flash, shaped like a Photinus flash: a fast rise (~0.15 s), a slower decay (~0.5 s) and a
 * dim ember in between, repeating every 1.4–3.2 s; ~15% are long-glowers that breathe slowly instead.
 * Loose synchrony: every SYNC.dt each home cloud's flashers are nudged toward the cloud's mean phase
 * (a mean-field Kuramoto step, O(N) per pass, no pair terms) with a coupling that swells and relaxes
 * over ~26–41 s per cloud, so a cloud drifts into waves of near-synchronous flashing and back out again.
 * Landed fireflies glow steadily. Seeded PRNG so a run is reproducible. Exposes ctx.fireflies for the
 * audio module (positions, brightness, states, homes, per-cloud coherence, escortCount, kickedCloud, wave).
 * Cross-module field: rising lantern records get `escorts` (how many fireflies orbit them this frame) and
 * `spilled` (the escort has already spilled; lanterns.js resets it on grab and respawn).
 */

const WANDER = 0, APPROACH = 1, LANDED = 2, SCATTER = 3, ESCORT = 4, FOLLOW = 5;
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
// the ribbon: the hand must drift sideways (m/s) with its palm up; a pause or a tracking blip within the graces keeps
// the gesture; recruiting starts after recruitAfter s and adds one firefly per recruitEvery s up to max (× particleScale).
// The trail is sampled every sampleStep m into a ring (5 m); follower k sits spacing samples behind follower k-1,
// lift m above the palm; a follower more than inbound m from the hand flies to the hand first, then joins the strand.
export const RIB = {
  speedMin: 0.05, speedMax: 0.35, breakSpeed: 0.5, normalY: 0.15,
  pauseGrace: 0.4, lostGrace: 0.4, recruitAfter: 0.5, recruitEvery: 0.3, max: 16,
  sampleStep: 0.02, ring: 256, spacing: 4, lift: 0.09, inbound: 0.3, releaseCooldown: 4,
};
// the escort: up to max fireflies join a released lantern — wanderers within wanderRange of it, and anything on the
// releasing hand within handRange; they orbit at orbitA rad/s on a radius orbitR (+ jitter) until the lantern has
// risen spillAt s, then spill as sparks and their cloud is kicked into synchrony for kick s at kickGain × the peak coupling
export const ESC = { max: 10, wanderRange: 3.0, handRange: 0.6, spillAt: 4.2, orbitA: 2.6, orbitR: 0.14, orbitRJit: 0.12, speedMax: 1.0, kick: 6, kickGain: 2.0 };
// the lake wave: delay s after a star, a front of flashes spreads from the player at speed m/s; the clouds hold their
// phases (no synchrony nudges) for hold s so the pattern is not pulled apart at once
export const WAVE = { speed: 2.5, hold: 6, delay: 0.8 };
const WAVE_SAMPLES = 32;   // the harness reads the first 32 re-phased fireflies of cloud 0 and their peak times

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
      const S = this._;
      if (S) { if (S.waveAt > 0) S.waveAt = Math.min(S.waveAt, nt + 1); S.waveHold = Math.min(S.waveHold, 1); }
    });

    // ---- synchrony scratch: per cloud the mean phase vector (cos, sin, count), then mean phase and nudge gain
    const syncAcc = new Float32Array(HOME_SPECS.length * 3);
    const syncPsi = new Float32Array(HOME_SPECS.length), syncGain = new Float32Array(HOME_SPECS.length);
    const coherence = new Float32Array(HOME_SPECS.length);   // Kuramoto order parameter R per cloud, 0..1

    // ---- the ribbon: per-firefly follow state and per-hand gesture state (its own PRNG so the cloud layout above is unchanged)
    const followHand = new Int8Array(N).fill(-1), followIdx = new Int8Array(N).fill(-1);
    const followPhase = new Uint8Array(N);          // 0 inbound (flying to the hand), 1 on the strand, 2 arrived at its sample
    const followOff = new Float32Array(N * 3);      // a fixed ±3 cm offset per firefly so the strand is not a string of beads
    const rnd2 = mulberry32(0x5EED6);
    for (let i = 0; i < N * 3; i++) followOff[i] = (rnd2() - 0.5) * 0.06;
    const ribMax = Math.max(1, Math.round(RIB.max * (ctx.quality.particleScale || 1)));
    const rib = {
      max: ribMax,
      slowFor: new Float32Array(2), pauseT: new Float32Array(2), lostT: new Float32Array(2), followT: new Float32Array(2), breakT: new Float32Array(2),
      drifting: [false, false], hold: [false, false],
      slots: new Int16Array(2 * ribMax).fill(-1),           // follower index k per hand → firefly, so k is unique
      trail: [new Float32Array(3 * RIB.ring), new Float32Array(3 * RIB.ring)],
      trailHead: new Int16Array(2), trailN: new Int16Array(2),   // head = next write slot; head-1 is the newest sample
      trailLast: [new THREE.Vector3(), new THREE.Vector3()], T: new THREE.Vector3(),
      followers: new Int16Array(2), followArrived: new Int16Array(2), followCentroid: new Float32Array(6),
      cnt: new Int16Array(4), newArr: new Int16Array(2),   // this frame's followers/arrived per hand, arrivals this frame
    };

    // ---- the escort: which lantern (index into ctx.lanterns.list) each firefly orbits, nearest-first recruiting scratch,
    // per-lantern escort counts, and the synchrony kick a spill gives the cloud it came from
    const escortL = new Int8Array(N).fill(-1);
    const escIdx = new Int16Array(ESC.max), escD = new Float32Array(ESC.max);
    const escPerL = new Int8Array(24), escPerCloud = new Int16Array(HOME_SPECS.length);
    const syncKick = new Float32Array(HOME_SPECS.length);
    // the lake wave: fired once per star, and what the harness reads back
    const wave = { fired: false, t0: 0, ox: 0, oz: 0, speed: WAVE.speed, count: 0, sample: new Int16Array(WAVE_SAMPLES), sampleT: new Float32Array(WAVE_SAMPLES) };

    ctx.fireflies = {
      count: N, landedCount: 0, positions: pos, brightness: bright, states: state, homes, coherence,
      followers: rib.followers, followArrived: rib.followArrived, followCentroid: rib.followCentroid,
      escortCount: 0, kickedCloud: -1, wave,
    };

    // free a firefly from any hand slot, ribbon slot or escort it holds (shared by the update paths and the event handlers)
    const releaseSlot = (i) => {
      const sh = slotHand[i];
      if (sh >= 0) { const ss = slotIdx[i]; if (slots[sh][ss] === i) slots[sh][ss] = -1; }
      slotHand[i] = -1; slotIdx[i] = -1;
      const fh = followHand[i];
      if (fh >= 0) { const fk = fh * rib.max + followIdx[i]; if (rib.slots[fk] === i) rib.slots[fk] = -1; }
      followHand[i] = -1; followIdx[i] = -1;
      escortL[i] = -1;
    };

    // a lantern let go above the water: the nearest wanderers within reach and whatever rests on the releasing hand lift off with it
    ctx.events.on('lanternrelease', (e) => {
      const L = e && e.lantern;
      if (!L || !L.position || typeof L.i !== 'number' || L.i >= escPerL.length) return;
      const lp = L.position;
      let n = 0;
      for (let i = 0; i < N; i++) {
        const st = state[i];
        let range;
        if (st === WANDER) { if (cooldown[i] > 0) continue; range = ESC.wanderRange; }
        else if ((st === LANDED || st === APPROACH) && ctx.hands.list[slotHand[i]] === e.hand) range = ESC.handRange;   // only the releasing hand's own
        else continue;   // escorts of another lantern, the ribbon's followers and scattering fireflies stay where they are
        const dx = pos[i * 3] - lp.x, dy = pos[i * 3 + 1] - lp.y, dz = pos[i * 3 + 2] - lp.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > range * range) continue;
        if (n === ESC.max && d2 >= escD[n - 1]) continue;
        // nearest-first insertion into the fixed slots
        let k = n < ESC.max ? n : ESC.max - 1;
        while (k > 0 && escD[k - 1] > d2) { escD[k] = escD[k - 1]; escIdx[k] = escIdx[k - 1]; k--; }
        escD[k] = d2; escIdx[k] = i;
        if (n < ESC.max) n++;
      }
      L.spilled = false; L.escorts = n;
      for (let k = 0; k < n; k++) {
        const i = escIdx[k];
        releaseSlot(i);
        state[i] = ESCORT; escortL[i] = L.i; cooldown[i] = 0;
      }
      if (n > 0) ctx.events.emit('fireflyescort', { pos: lp.clone(), count: n, lantern: L });
    });

    // the star's own sparkle strikes first; the lake answers WAVE.delay later, from where the player stands
    ctx.events.on('lanternstar', () => {
      const S = this._;
      if (!S) return;
      const head = ctx.playerCtl.state.headWorld;
      S.waveAt = ctx.time.t + WAVE.delay; S.waveOX = head.x; S.waveOZ = head.z;
    });

    this._ = {
      N, rnd, pos, vel, bright, seed, homeIdx, homeOff, state, slotHand, slotIdx, timer, stay, cooldown, period, phase, steady,
      homes, homeRel, following: false, geo, posAttr, brightAttr, matMain, matMirror, points, mirror, slots, recruitT, hf,
      syncT: SYNC.dt, syncAcc, syncPsi, syncGain, coherence,
      followHand, followIdx, followPhase, followOff, rib, releaseSlot,
      escortL, escPerL, escPerCloud, syncKick, kickedCloud: -1, escortCount: 0,
      waveAt: -1, waveOX: 0, waveOZ: 0, waveHold: 0, wave,
    };
  },

  update(ctx, dt) {
    const S = this._;
    const { N, rnd, pos, vel, bright, seed, homeIdx, homeOff, state, slotHand, slotIdx, timer, stay, cooldown, period, phase, steady, homes, homeRel, slots, recruitT, hf } = S;
    const { followHand, followIdx, followPhase, followOff, rib, releaseSlot, escortL, escPerL, escPerCloud, syncKick } = S;
    const t = ctx.time.t;
    const lanterns = ctx.lanterns ? ctx.lanterns.list : null;
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

    // ---- the ribbon gesture: an open hand, palm up, drifting sideways at 5–35 cm/s. Followers stay for as long as
    // the hand is open, above the water, not pinching and under breakSpeed — stopped or not (a stop is how they land);
    // the drift accumulator (which gates recruiting) survives a pause or a tracking blip within the graces.
    for (let hi = 0; hi < 2; hi++) {
      const hs = hands[hi];
      const sp = hs ? hs.palm.speed : 0;
      if (hs && sp > RIB.breakSpeed) rib.breakT[hi] += dt; else rib.breakT[hi] = 0;   // one jittery frame over the break speed is not a fling
      let hold = !!hs && !hs.submerged && !hs.pinch.active && !hs.grabbed && hs.open && rib.breakT[hi] < 0.1;
      if (hold && (!hs.visible || !hs.tracked)) { rib.lostT[hi] += dt; if (rib.lostT[hi] >= RIB.lostGrace) hold = false; }
      else rib.lostT[hi] = 0;
      const poseOk = hold && hs.visible && hs.active && hs.palm.normal.y > RIB.normalY;
      const drifting = poseOk && !hs.still && sp >= RIB.speedMin && sp <= RIB.speedMax && hs.palm.speedH >= 0.6 * sp;
      if (drifting) { rib.slowFor[hi] += dt; rib.pauseT[hi] = 0; }
      else if (poseOk && sp <= RIB.speedMax && (sp < RIB.speedMin || hs.still) && rib.pauseT[hi] < RIB.pauseGrace) rib.pauseT[hi] += dt;
      else if (hold && (!hs.visible || !hs.tracked)) { /* lost within the grace: keep the accumulator */ }
      else rib.slowFor[hi] = 0;
      rib.drifting[hi] = drifting; rib.hold[hi] = hold;
      rib.followT[hi] -= dt;
      const hasFollowers = rib.followers[hi] > 0;
      if (!hold) {
        if (hasFollowers) releaseFollowers(hi);
        rib.trailN[hi] = 0; rib.trailHead[hi] = 0;
        continue;
      }
      if (!hasFollowers && !drifting) { rib.trailN[hi] = 0; rib.trailHead[hi] = 0; continue; }   // nothing to lead: start the trail afresh
      if (!hs.visible) continue;
      // the trail: samples of the point 9 cm above the palm, every 2 cm of travel (distance-based, so the strand keeps its spacing at any speed)
      const pp = hs.palm.position, pn = hs.palm.normal, T = rib.T;
      T.set(pp.x + pn.x * RIB.lift, pp.y + pn.y * RIB.lift, pp.z + pn.z * RIB.lift);
      if (rib.trailN[hi] === 0 || T.distanceTo(rib.trailLast[hi]) >= RIB.sampleStep) {
        const tr = rib.trail[hi], h3 = rib.trailHead[hi] * 3;
        tr[h3] = T.x; tr[h3 + 1] = T.y; tr[h3 + 2] = T.z;
        rib.trailHead[hi] = (rib.trailHead[hi] + 1) % RIB.ring;
        if (rib.trailN[hi] < RIB.ring) rib.trailN[hi]++;
        rib.trailLast[hi].copy(T);
      }
    }
    function releaseFollowers(hi) {
      const base = hi * rib.max;
      for (let k = 0; k < rib.max; k++) {
        const i = rib.slots[base + k];
        if (i < 0) continue;
        rib.slots[base + k] = -1;
        if (followHand[i] !== hi) continue;
        followHand[i] = -1; followIdx[i] = -1;
        if (state[i] === FOLLOW) { state[i] = WANDER; cooldown[i] = RIB.releaseCooldown; }
      }
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

    // ---- ribbon recruiting: once the hand has drifted for recruitAfter s, the nearest free wanderer joins every recruitEvery s
    for (let hi = 0; hi < 2; hi++) {
      if (!rib.hold[hi] || rib.slowFor[hi] <= RIB.recruitAfter || rib.followT[hi] > 0) continue;
      const base = hi * rib.max;
      let k = -1;
      for (let s = 0; s < rib.max; s++) { if (rib.slots[base + s] < 0) { k = s; break; } }
      if (k < 0) continue;
      const pp = hands[hi].palm.position;
      let best = -1, bestD = P.recruitRange * P.recruitRange;
      for (let i = 0; i < N; i++) {
        if (state[i] !== WANDER || cooldown[i] > 0) continue;
        const dx = pos[i * 3] - pp.x, dy = pos[i * 3 + 1] - pp.y, dz = pos[i * 3 + 2] - pp.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestD) { bestD = d2; best = i; }
      }
      if (best >= 0) {
        state[best] = FOLLOW; followHand[best] = hi; followIdx[best] = k; followPhase[best] = 0; rib.slots[base + k] = best;
        rib.followT[hi] = RIB.recruitEvery;
      }
    }

    // ---- hand-off: a hand with followers that is open and still gives its free landing slots to the nearest of them; they
    // land through the ordinary approach path (the rest keep hovering on their samples and step in as slots free up)
    for (let hi = 0; hi < 2; hi++) {
      if (!hf.attract[hi] || rib.followers[hi] === 0) continue;
      const hs = hands[hi], base = hi * rib.max;
      for (let s = 0; s < SLOTS; s++) {
        if (slots[hi][s] >= 0) continue;
        const j = hs.joints[SLOT_JOINTS[s]];
        if (!j.valid) continue;
        let best = -1, bestK = -1, bestD = Infinity;
        for (let k = 0; k < rib.max; k++) {
          const i = rib.slots[base + k];
          if (i < 0 || state[i] !== FOLLOW) continue;
          const dx = pos[i * 3] - j.position.x, dy = pos[i * 3 + 1] - j.position.y, dz = pos[i * 3 + 2] - j.position.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < bestD) { bestD = d2; best = i; bestK = k; }
        }
        if (best < 0) break;
        rib.slots[base + bestK] = -1; followHand[best] = -1; followIdx[best] = -1;
        state[best] = APPROACH; slotHand[best] = hi; slotIdx[best] = s; slots[hi][s] = best;
      }
    }
    rib.cnt.fill(0); rib.newArr.fill(0);
    const cen = rib.followCentroid;
    cen.fill(0);
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

    // ---- the lake passes it on: once per star, every free flasher is re-phased so its flash peaks exactly as a front
    // travelling at WAVE.speed from the player reaches it; the clouds then hold that phase for WAVE.hold s
    if (S.waveAt > 0 && t >= S.waveAt) {
      S.waveAt = -1;
      const ox = S.waveOX, oz = S.waveOZ, wv = S.wave;
      let count = 0, ns = 0;
      for (let i = 0; i < N; i++) {
        const st = state[i];
        if (steady[i] || (st !== WANDER && st !== SCATTER)) continue;   // hand-resting, escorting and following fireflies keep their own light
        const d = Math.hypot(pos[i * 3] - ox, pos[i * 3 + 2] - oz);
        const tPeak = t + d / WAVE.speed;
        const rise = FLASH.rise * (0.85 + 0.3 * seed[i]);
        const pd = period[i];
        phase[i] = ((rise - tPeak) % pd + pd) % pd;
        count++;
        if (ns < WAVE_SAMPLES && homeIdx[i] === 0) { wv.sample[ns] = i; wv.sampleT[ns] = tPeak; ns++; }
      }
      for (let k = ns; k < WAVE_SAMPLES; k++) { wv.sample[k] = -1; wv.sampleT[k] = 0; }
      wv.fired = true; wv.t0 = t; wv.ox = ox; wv.oz = oz; wv.speed = WAVE.speed; wv.count = count;
      S.waveHold = WAVE.hold;
      ctx.events.emit('lakewave', { pos: new THREE.Vector3(ox, level, oz), count });
    }
    if (S.waveHold > 0) S.waveHold -= dt;

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
        const kicked = syncKick[k] > 0;   // a spill kicks its cloud: strong coupling for a few seconds locks it into a common flash
        if (kicked) syncKick[k] -= SYNC.dt;
        const n = acc[k * 3 + 2];
        if (n < 2) { coh[k] = 0; kg[k] = 0; continue; }
        const cx = acc[k * 3] / n, cy = acc[k * 3 + 1] / n;
        const R = Math.sqrt(cx * cx + cy * cy);
        coh[k] = R; psi[k] = Math.atan2(cy, cx);
        const w = 0.5 + 0.5 * Math.sin(t * TAU / SYNC.swell[k] + k * 2.1);
        kg[k] = SYNC.kMax * w * w * R * SYNC.dt;
        if (kicked) kg[k] = Math.max(kg[k], ESC.kickGain * SYNC.kMax * R * SYNC.dt);
        if (S.waveHold > 0) kg[k] = 0;   // the lake wave's hold wins over a kick: the pattern it laid down is left alone
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
    let landed = 0, escorting = 0;
    escPerL.fill(0);
    // the spill: every escort of lantern L bursts outward and down as a spark and its home cloud is kicked into step
    const spill = (L) => {
      escPerCloud.fill(0);
      let n = 0, sx = 0, sz = 0;
      const lp = L.position;
      for (let j = 0; j < N; j++) {
        if (state[j] !== ESCORT || escortL[j] !== L.i) continue;
        const j3 = j * 3;
        let ox = pos[j3] - lp.x, oz = pos[j3 + 2] - lp.z;
        let l = Math.hypot(ox, oz);
        if (l < 1e-3) { const a = rnd() * Math.PI * 2; ox = Math.cos(a); oz = Math.sin(a); l = 1; }
        vel[j3] = ox / l * 0.9 + (rnd() - 0.5) * 0.3;
        vel[j3 + 1] = -0.25 + rnd() * 0.3;
        vel[j3 + 2] = oz / l * 0.9 + (rnd() - 0.5) * 0.3;
        state[j] = SCATTER; timer[j] = t + 1.0 + rnd() * 0.6; cooldown[j] = 4; bright[j] = 1; escortL[j] = -1;
        escPerCloud[homeIdx[j]]++; sx += pos[j3]; sz += pos[j3 + 2]; n++;
      }
      L.spilled = true; L.escorts = 0;
      if (n === 0) return;
      let k = 0;
      for (let c = 1; c < HOME_SPECS.length; c++) if (escPerCloud[c] > escPerCloud[k]) k = c;
      syncKick[k] = ESC.kick; S.kickedCloud = k; ctx.fireflies.kickedCloud = k;
      ctx.events.emit('fireflyspill', { pos: new THREE.Vector3(sx / n, lp.y, sz / n), count: n, lantern: L });
    };

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

      if (st === ESCORT) {
        const li = escortL[i];
        const L = li >= 0 && lanterns ? lanterns[li] : null;
        if (!L || L.state !== 'rising' || L.riseTime > ESC.spillAt) {
          // the lantern is high enough, was caught again, or fell: the whole escort spills at once
          if (L && !L.spilled) spill(L);
          else { escortL[i] = -1; state[i] = WANDER; cooldown[i] = 4; }
          st = state[i]; vx = vel[i3]; vy = vel[i3 + 1]; vz = vel[i3 + 2];
        } else {
          // spiral round the flame: a point on a jittered ring about the body, a little above its centre
          const lp = L.position;
          const a = t * ESC.orbitA + seed[i] * 6.283, r = ESC.orbitR + ESC.orbitRJit * seed[i];
          const tx = lp.x + Math.cos(a) * r, ty = lp.y + 0.05 + (seed[i] - 0.5) * 0.25, tz = lp.z + Math.sin(a) * r;
          const dx = tx - x, dy = ty - y, dz = tz - z;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          const sp = Math.min(ESC.speedMax, 0.15 + d * 3);
          const inv = d > 1e-5 ? sp / d : 0;
          const k = Math.min(1, dt * 5);
          vx += (dx * inv - vx) * k; vy += (dy * inv - vy) * k; vz += (dz * inv - vz) * k;
          x += vx * dt; y += vy * dt; z += vz * dt;
          bright[i] = Math.max(blink(i), 0.55);
          escPerL[li]++; escorting++;
          // the lantern climbs past the fireflies' band: no clamp for an escort
          state[i] = st;
          pos[i3] = x; pos[i3 + 1] = y; pos[i3 + 2] = z;
          vel[i3] = vx; vel[i3 + 1] = vy; vel[i3 + 2] = vz;
          continue;
        }
      }

      if (st === FOLLOW) {
        const hi = followHand[i], k = followIdx[i];
        if (hi < 0 || rib.slots[hi * rib.max + k] !== i || !rib.hold[hi]) {
          releaseSlot(i); st = WANDER; cooldown[i] = RIB.releaseCooldown;
        } else {
          const hs = hands[hi];
          const pp = hs.palm.position, pn = hs.palm.normal;
          const Tx = pp.x + pn.x * RIB.lift, Ty = pp.y + pn.y * RIB.lift, Tz = pp.z + pn.z * RIB.lift;
          // this follower's place: spacing samples behind the previous one (the oldest sample while the trail is short), plus its own offset
          let tx, ty, tz;
          const n = rib.trailN[hi];
          if (n > 0) {
            let back = RIB.spacing * (k + 1);
            if (back > n - 1) back = n - 1;
            const s3 = ((rib.trailHead[hi] - 1 - back + RIB.ring * 2) % RIB.ring) * 3;
            const tr = rib.trail[hi];
            tx = tr[s3] + followOff[i3]; ty = tr[s3 + 1] + followOff[i3 + 1]; tz = tr[s3 + 2] + followOff[i3 + 2];
          } else { tx = Tx + followOff[i3]; ty = Ty + followOff[i3 + 1]; tz = Tz + followOff[i3 + 2]; }
          let dx = tx - x, dy = ty - y, dz = tz - z;
          let d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          let ph = followPhase[i];
          if (ph === 0) {
            // inbound: fly to the hand itself; join the strand once within reach of it
            const ex = Tx - x, ey = Ty - y, ez = Tz - z;
            const dT = Math.sqrt(ex * ex + ey * ey + ez * ez);
            if (dT < RIB.inbound) ph = 1;
            else { dx = ex; dy = ey; dz = ez; d = dT; }
          }
          if (ph > 0) {
            if (d < RIB.inbound) {
              if (ph === 1) {
                ph = 2;
                const count = rib.followArrived[hi] + (++rib.newArr[hi]);   // followArrived still holds last frame's total here
                ctx.events.emit('fireflyfollow', { hand: hs, pos: new THREE.Vector3(x, y, z), count });
              }
            } else if (ph === 2 && d > RIB.inbound + 0.2) ph = 1;   // fell behind: dim again, chime again on return
          }
          followPhase[i] = ph;
          // the approach easing, with the same wobble
          const sp = Math.min(P.approachMax, 0.08 + d * 2.2);
          const inv = d > 1e-5 ? sp / d : 0;
          const s1 = seed[i] * 97, wob = 0.12 * Math.min(1, d);
          const dvx = dx * inv + wob * Math.sin(t * 5.1 + s1);
          const dvy = dy * inv + wob * Math.sin(t * 4.3 + s1 * 1.7);
          const dvz = dz * inv + wob * Math.cos(t * 4.7 + s1 * 0.5);
          const kk = Math.min(1, dt * 3.5);
          vx += (dvx - vx) * kk; vy += (dvy - vy) * kk; vz += (dvz - vz) * kk;
          x += vx * dt; y += vy * dt; z += vz * dt;
          rib.cnt[hi]++;
          if (ph === 2) {
            bright[i] = 0.7 + 0.2 * Math.sin(t * 2.1 + seed[i] * 31);
            rib.cnt[2 + hi]++;
            cen[hi * 3] += x; cen[hi * 3 + 1] += y; cen[hi * 3 + 2] += z;
          } else bright[i] = Math.max(blink(i), 0.35);
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
      else if (y > yMax) {
        if (st === SCATTER || st === WANDER) vy = Math.min(vy, -(y - yMax) * 1.5);   // sparks spilled above the band sink back, no snap
        else { y = yMax; if (vy > 0) vy = -vy * 0.5; }
      }

      state[i] = st;
      pos[i3] = x; pos[i3 + 1] = y; pos[i3 + 2] = z;
      vel[i3] = vx; vel[i3 + 1] = vy; vel[i3 + 2] = vz;
    }

    S.posAttr.needsUpdate = true;
    S.brightAttr.needsUpdate = true;
    ctx.fireflies.landedCount = landed;
    // the escort's counters: how many fireflies orbit each rising lantern (lanterns.js flares the flame with them)
    S.escortCount = escorting; ctx.fireflies.escortCount = escorting;
    if (lanterns) for (let li = 0; li < lanterns.length && li < escPerL.length; li++) { const L = lanterns[li]; if (L.state === 'rising') L.escorts = escPerL[li]; }
    // the ribbon's counters and the centroid of each hand's arrived followers (the hand itself while there are none)
    for (let hi = 0; hi < 2; hi++) {
      rib.followers[hi] = rib.cnt[hi];
      const na = rib.cnt[2 + hi];
      rib.followArrived[hi] = na;
      if (na > 0) { cen[hi * 3] /= na; cen[hi * 3 + 1] /= na; cen[hi * 3 + 2] /= na; }
      else if (hands[hi]) { const pp = hands[hi].palm.position; cen[hi * 3] = pp.x; cen[hi * 3 + 1] = pp.y; cen[hi * 3 + 2] = pp.z; }
    }
  },
};
