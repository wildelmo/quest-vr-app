import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { LOTUS_FLOWER_VERT, LOTUS_FLOWER_FRAG, LOTUS_GLOW_VERT, LOTUS_GLOW_FRAG } from '../shaders/lotus.js';

/**
 * Lotus clusters: 6 flowers floating among lily pads around the player. Touch a closed bud with any
 * fingertip and it opens (petals rotate open in the vertex shader), glows in its cluster colour,
 * sings a pentatonic degree ('lotusbloom'), bumps the world energy and pushes a ring into the water.
 * It closes again after a minute. When all six are open at once, 'lotuschord' fires once.
 *
 * A closed bud also answers a hand that merely comes near: it leans toward the nearest fingertip
 * within 35 cm (pivoting at its base) and its halo warms. Hold a fingertip still 9–22 cm above the
 * pod and after 0.6 s a thin whisper rises ('lotusstir'); at 2 s the bud opens by itself with a
 * softer, longer note ('lotusbloom' cause 'patient'). Touching it still opens it at once.
 *
 * A lantern the player has carried and set down among the pads warms a bud too: its light falls amber on
 * the near side of the petals (per-instance aLantern in the shader), and after 2.5 s within 45 cm the bud
 * opens slowly, over 5 s ('lotusbloom' cause 'lantern'), and stays open until 10 s after the lantern
 * drifts away. Lanterns that merely home in by themselves (never touched) do not count.
 *
 * Four draw calls: one InstancedMesh of pads (MeshLambert, lit by the moon + hemisphere light), one
 * InstancedMesh of flowers (custom ShaderMaterial, per-instance aBloom/aColor), one instanced set of
 * additive billboard quads for the glows (renderOrder 4) and their reflection drawn on the surface just
 * after the water (renderOrder 3).
 *
 * When the lake wave rolls out from the player ('lakewave', fireflies.js), every open flower it passes brightens for two
 * seconds as the front reaches it (its glow surges the way the chord's surge does; the audio restates its note in step).
 *
 * Public surface: ctx.lotus = { flowers: [{ index, position, bud, bloom, color, note, open, state, lean, leanX, leanZ,
 *   hoverT, openSeconds, warm, warmNear, lanternIdx, waveAt }], open(i, opts), clusters }
 * Events: 'lotusbloom' { index, note, pos, color, cause: 'touch'|'patient'|'lantern', hand }, 'lotusstir' { index, note, pos, hand },
 *   'lotuschord' {}
 */

const CLUSTERS = 6;
const SEED = 0x10705;
const FRONT_HALF_DEG = 35;          // keep the front sector (around -Z) clear
const R_MIN = 1.4, R_MAX = 3.8;     // metres from the origin
const PREF_SEP = 1.3, MIN_SEP = 0.9;
const TOUCH_RADIUS = 0.08, TOUCH_MAX_BLOOM = 0.25;
const OPEN_SECONDS = 1.6, CLOSE_SECONDS = 6, STAY_MIN = 55, STAY_MAX = 75;
const PAD_LIFT = 0.004, FLOWER_LIFT = 0.006, BUD_HEIGHT = 0.045;
const GLOW_SIZE = 0.35, MIRROR_GAIN = 0.3, SURGE_SECONDS = 3.0; // the reflection is drawn on the surface, so it needs less gain
const GLOW_GAIN_CLOSED = 0.08, GLOW_GAIN_OPEN = 0.40; // additive halo brightness (the petals carry their own glow)
const WARM_GAIN = 0.14;                                 // extra halo on a closed bud with a hand near it
// the lean toward a fingertip: full angle inside `near`, none beyond `far`; the patience band is the height
// above the pod (not touching) where a still fingertip counts, whispering at stirAt and opening at openAt
const LEAN = { far: 0.35, near: 0.08, angle: 0.40, tauIn: 0.6, tauOut: 1.2, hoverMin: 0.09, hoverMax: 0.22, stirAt: 0.6, openAt: 2.0, decay: 2 };
// a set-down lantern warming a bud: enter/exit is a horizontal hysteresis band, `need` seconds of warmth open it
// over `openSeconds`, and it lingers open `linger` seconds after the lantern leaves; glowLight is the reach of
// the amber light on the petals (shader), energy the (small) world-energy bump for such a bloom
const WARM = { enter: 0.45, exit: 0.55, minBright: 0.3, need: 2.5, cap: 3.5, openSeconds: 5.0, linger: 10, energy: 0.08, glowLight: 0.6 };
const WARM_HALO = 0.10;                                 // extra halo gain as the lantern's warmth builds
const WAVE_SPEED = 2.5, WAVE_SECONDS = 2.0, WAVE_SURGE = 0.7; // the lake wave's front speed, a flower's brightening and its strength
const PAD_COLOR = 0x0f2a1c, PAD_EMISSIVE = 0x02110a;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const easeOutCubic = (u) => 1 - Math.pow(1 - u, 3);
const smooth = (u) => u * u * (3 - 2 * u);

// ---------------------------------------------------------------------------------------------
// Layout (seeded, deterministic)
function layoutClusters(rnd) {
  const out = [];
  // cluster 0 is within arm's reach from the start (front-left, 0.55–0.75 m; the near lanterns sit
  // front-right and back-left), the others are scenery 1.4–3.8 m out around the player
  {
    const azDeg = -55 + (rnd() - 0.5) * 8;
    const az = THREE.MathUtils.degToRad(azDeg);
    const r = 0.55 + rnd() * 0.2;
    out.push({ x: Math.sin(az) * r, z: -Math.cos(az) * r, azDeg, r });
  }
  const slot = (360 - 2 * FRONT_HALF_DEG) / (CLUSTERS - 1);
  for (let i = 1; i < CLUSTERS; i++) {
    let best = null, bestScore = -1;
    for (let k = 0; k < 60; k++) {
      const azDeg = FRONT_HALF_DEG + slot * (i - 0.5) + (rnd() - 0.5) * slot * 0.8;
      const az = THREE.MathUtils.degToRad(azDeg);
      const r = R_MIN + (R_MAX - R_MIN) * rnd();
      const x = Math.sin(az) * r, z = -Math.cos(az) * r;
      let minD = Infinity;
      for (const c of out) minD = Math.min(minD, Math.hypot(c.x - x, c.z - z));
      if (minD >= PREF_SEP) { best = { x, z, azDeg, r }; break; }
      if (minD > bestScore && minD >= MIN_SEP) { bestScore = minD; best = { x, z, azDeg, r }; }
      if (!best) best = { x, z, azDeg, r };
    }
    out.push(best);
  }
  return out;
}

function layoutPads(rnd, cluster) {
  const n = 3 + Math.floor(rnd() * 3); // 3..5
  const pads = [];
  for (let j = 0; j < n; j++) {
    const radius = 0.14 + rnd() * 0.12;
    let best = null, bestD = -1;
    for (let k = 0; k < 14; k++) {
      const a = rnd() * Math.PI * 2;
      const d = 0.12 + rnd() * 0.28;
      const x = cluster.x + Math.cos(a) * d, z = cluster.z + Math.sin(a) * d;
      let minGap = Infinity;
      for (const p of pads) minGap = Math.min(minGap, Math.hypot(p.x - x, p.z - z) - (p.radius + radius) * 0.85);
      if (minGap >= 0) { best = { x, z }; break; }
      if (minGap > bestD) { bestD = minGap; best = { x, z }; }
    }
    pads.push({
      x: best.x, z: best.z, homeX: best.x, homeZ: best.z, radius,
      yaw: rnd() * Math.PI * 2, rotSpeed: (rnd() - 0.5) * 0.03, driftPhase: rnd() * Math.PI * 2, driftAmp: 0.012 + rnd() * 0.012,
      variant: j === 0 ? 1 : 0, // exactly one pad per cluster has the classic wedge notch
    });
  }
  return pads;
}

// ---------------------------------------------------------------------------------------------
// Geometry
// One geometry holds both a plain disc (part 0) and a notched disc (part 1); a per-instance aVariant
// picks one in the vertex shader by collapsing the other's vertices (degenerate triangles).
function padDisc(notched) {
  const s = new THREE.Shape();
  if (notched) {
    const half = 0.20, depth = 0.45;
    s.moveTo(Math.cos(half), Math.sin(half));
    s.absarc(0, 0, 1, half, Math.PI * 2 - half, false);
    s.lineTo(1 - depth, 0);
    s.closePath();
  } else {
    s.absarc(0, 0, 1, 0, Math.PI * 2, false);
  }
  const g = new THREE.ShapeGeometry(s, 12); // arcs get 2×divisions => 24 segments
  g.rotateX(-Math.PI / 2);                  // XY disc -> XZ, normal +Y
  return g;
}
function buildPadGeometry() {
  const parts = [padDisc(false), padDisc(true)];
  const pos = [], nrm = [], col = [], part = [], idx = [];
  let base = 0;
  parts.forEach((g, pi) => {
    const p = g.attributes.position, n = g.attributes.normal, ind = g.index.array;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      pos.push(x, y, z); nrm.push(n.getX(i), n.getY(i), n.getZ(i));
      const r = Math.min(1, Math.hypot(x, z));
      const shade = 1.0 - 0.3 * r * r; // slightly darker rim
      col.push(shade, shade, shade); part.push(pi);
    }
    for (let i = 0; i < ind.length; i++) idx.push(ind[i] + base);
    base += p.count;
    g.dispose();
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
  geo.setIndex(idx);
  return geo;
}

// 6 inner + 8 outer petals (5 rows × 3 columns each, lofted in the vertex shader) + bud + base.
function buildFlowerGeometry(rnd) {
  const pos = [], nrm = [], uv = [], petal = [], idx = [];
  const ROWS_T = [0, 0.3, 0.55, 0.8, 1.0];
  const ROWS_W = [0.35, 0.95, 1.0, 0.7, 0.0]; // width profile: narrow base, widest mid, pointed tip
  const COLS = [-1, 0, 1];
  const rings = [
    { n: 6, L: 0.075, hw: 0.014, part: 0, a0: 0 },
    { n: 8, L: 0.100, hw: 0.018, part: 1, a0: Math.PI / 8 },
  ];
  for (const ring of rings) {
    for (let k = 0; k < ring.n; k++) {
      const phi = ring.a0 + (k / ring.n) * Math.PI * 2 + (rnd() - 0.5) * 0.08;
      const L = ring.L * (0.92 + rnd() * 0.16);
      const v0 = pos.length / 3;
      for (let r = 0; r < ROWS_T.length; r++) {
        for (const xn of COLS) {
          pos.push(xn * ROWS_W[r] * ring.hw, ROWS_T[r], 0);
          nrm.push(0, 0, 1);
          uv.push(xn, ROWS_T[r]);
          petal.push(phi, ring.part, L);
        }
      }
      for (let r = 0; r < ROWS_T.length - 1; r++) {
        for (let c = 0; c < COLS.length - 1; c++) {
          const a = v0 + r * 3 + c, b = a + 1, cc = a + 3, d = a + 4;
          idx.push(a, cc, b, b, cc, d);
        }
      }
    }
  }
  const addSphere = (geom, sx, sy, sz, ty, part) => {
    const p = geom.attributes.position, n = geom.attributes.normal, ind = geom.index.array;
    const v0 = pos.length / 3;
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i) * sx, p.getY(i) * sy + ty, p.getZ(i) * sz);
      // normal of a scaled sphere: divide by the scale, renormalise
      const nx = n.getX(i) / sx, ny = n.getY(i) / sy, nz = n.getZ(i) / sz;
      const l = Math.hypot(nx, ny, nz) || 1;
      nrm.push(nx / l, ny / l, nz / l);
      uv.push(0, 0.5);
      petal.push(0, part, 0);
    }
    for (let i = 0; i < ind.length; i++) idx.push(ind[i] + v0);
    geom.dispose();
  };
  addSphere(new THREE.SphereGeometry(1, 10, 7), 0.011, 0.024, 0.011, 0.034, 2);   // bud / seed pod
  addSphere(new THREE.SphereGeometry(1, 12, 4), 0.032, 0.007, 0.032, 0.004, 3);   // floating base
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('aPetal', new THREE.Float32BufferAttribute(petal, 3));
  geo.setIndex(idx);
  return geo;
}

// ---------------------------------------------------------------------------------------------
export const lotus = {
  name: 'lotus',

  init(ctx) {
    const rnd = mulberry32(SEED);
    const colors = CONFIG.colors.lotus;
    const clusters = layoutClusters(rnd);
    const fog = ctx.scene.fog;

    // ---- flowers (state objects double as the public ctx.lotus.flowers entries)
    const flowers = clusters.map((c, i) => ({
      index: i, note: i % 6,
      position: new THREE.Vector3(c.x, ctx.water.level + FLOWER_LIFT, c.z),
      bud: new THREE.Vector3(c.x, ctx.water.level + FLOWER_LIFT + BUD_HEIGHT, c.z),
      color: new THREE.Color(colors[i % colors.length]),
      bloom: 0, open: false,
      state: 'closed', timer: 0, bloomFrom: 0, stay: 0, openSeconds: OPEN_SECONDS,
      yaw: rnd() * Math.PI * 2, scale: 1.0 + rnd() * 0.25, phase: rnd() * Math.PI * 2, pulsePhase: rnd() * Math.PI * 2,
      // lean toward a near fingertip (radians, about the base) and the patience clock for opening by stillness
      leanX: 0, leanZ: 0, lean: 0, hoverT: 0, stirred: false, warmGlow: 0, rot: new THREE.Quaternion(),
      // warmth from a lantern set down among the pads (seconds, capped), and which lantern it is
      warm: 0, warmNear: false, lanternIdx: -1,
      waveAt: -1,   // when the lake wave's front reaches this flower (-1: none pending)
    }));

    // ---- pads
    const pads = [];
    clusters.forEach((c, i) => { for (const p of layoutPads(rnd, c)) { p.cluster = i; pads.push(p); } });

    const padGeo = buildPadGeometry();
    const padVariant = new Float32Array(pads.length);
    pads.forEach((p, i) => { padVariant[i] = p.variant; });
    padGeo.setAttribute('aVariant', new THREE.InstancedBufferAttribute(padVariant, 1));
    const padMat = new THREE.MeshLambertMaterial({ color: PAD_COLOR, emissive: PAD_EMISSIVE, vertexColors: true, side: THREE.FrontSide, fog: true });
    padMat.onBeforeCompile = (shader) => {
      shader.vertexShader = 'attribute float aPart; attribute float aVariant;\n' + shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n\ttransformed *= step(abs(aPart - aVariant), 0.5);',
      );
    };
    padMat.customProgramCacheKey = () => 'lotusPadVariant';
    const padMesh = new THREE.InstancedMesh(padGeo, padMat, pads.length);
    padMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    padMesh.renderOrder = 3; padMesh.frustumCulled = false; padMesh.name = 'lotusPads';
    padMesh.castShadow = false; padMesh.receiveShadow = false;
    ctx.scene.add(padMesh);

    // ---- flowers mesh
    const flowerGeo = buildFlowerGeometry(rnd);
    const bloomAttr = new THREE.InstancedBufferAttribute(new Float32Array(CLUSTERS), 1).setUsage(THREE.DynamicDrawUsage);
    const colorAttr = new THREE.InstancedBufferAttribute(new Float32Array(CLUSTERS * 3), 3);
    const phaseAttr = new THREE.InstancedBufferAttribute(new Float32Array(CLUSTERS), 1);
    // the brightest nearby lantern per flower (xyz, weight): amber light on the near side of the petals
    const lanternAttr = new THREE.InstancedBufferAttribute(new Float32Array(CLUSTERS * 4), 4).setUsage(THREE.DynamicDrawUsage);
    flowers.forEach((f, i) => { colorAttr.setXYZ(i, f.color.r, f.color.g, f.color.b); phaseAttr.setX(i, f.phase); });
    flowerGeo.setAttribute('aBloom', bloomAttr);
    flowerGeo.setAttribute('aColor', colorAttr);
    flowerGeo.setAttribute('aPhase', phaseAttr);
    flowerGeo.setAttribute('aLantern', lanternAttr);
    const flowerUniforms = {
      uTime: { value: 0 },
      uMoonDir: { value: new THREE.Vector3(0.3, 0.8, 0.5).normalize() },
      uMoonColor: { value: new THREE.Color(0xbfd0ff).multiplyScalar(0.55) },
      uFogColor: { value: new THREE.Color(fog ? fog.color : CONFIG.fog.color) },
      uFogDensity: { value: fog && fog.isFogExp2 ? fog.density : CONFIG.fog.density },
      uSurge: { value: 0 },
    };
    const flowerMat = new THREE.ShaderMaterial({
      uniforms: flowerUniforms, vertexShader: LOTUS_FLOWER_VERT, fragmentShader: LOTUS_FLOWER_FRAG,
      side: THREE.DoubleSide, transparent: false, depthWrite: true, depthTest: true, fog: false,
    });
    const flowerMesh = new THREE.InstancedMesh(flowerGeo, flowerMat, CLUSTERS);
    flowerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    flowerMesh.renderOrder = 3; flowerMesh.frustumCulled = false; flowerMesh.name = 'lotusFlowers';
    ctx.scene.add(flowerMesh);

    // ---- glow halos + their reflection: instanced billboard quads sharing the per-flower arrays
    const quad = new THREE.PlaneGeometry(1, 1);
    const glowPosArr = new Float32Array(CLUSTERS * 3), glowSizeArr = new Float32Array(CLUSTERS), glowGainArr = new Float32Array(CLUSTERS), glowColArr = new Float32Array(CLUSTERS * 3);
    flowers.forEach((f, i) => { glowColArr.set([f.color.r, f.color.g, f.color.b], i * 3); glowPosArr.set([f.bud.x, f.bud.y, f.bud.z], i * 3); });
    const glowGeos = [];
    const makeGlowGeo = () => {
      const g = new THREE.InstancedBufferGeometry();
      g.setIndex(quad.index);
      g.setAttribute('position', quad.attributes.position);
      g.setAttribute('uv', quad.attributes.uv);
      g.setAttribute('aCenter', new THREE.InstancedBufferAttribute(glowPosArr, 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('aSize', new THREE.InstancedBufferAttribute(glowSizeArr, 1).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('aGain', new THREE.InstancedBufferAttribute(glowGainArr, 1).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('aColor', new THREE.InstancedBufferAttribute(glowColArr, 3));
      g.instanceCount = CLUSTERS;
      glowGeos.push(g);
      return g;
    };
    const makeGlowMat = (mirror, gainMul) => new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: ctx.assets.tex.glowSoft }, uMirror: { value: mirror }, uLevel: { value: ctx.water.level },
        uGainMul: { value: gainMul },
      },
      vertexShader: LOTUS_GLOW_VERT, fragmentShader: LOTUS_GLOW_FRAG,
      transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide,
    });
    const glowMat = makeGlowMat(0, 1);
    const mirrorMat = makeGlowMat(1, MIRROR_GAIN);
    const glowPoints = new THREE.Mesh(makeGlowGeo(), glowMat);
    glowPoints.renderOrder = 4; glowPoints.frustumCulled = false; glowPoints.name = 'lotusGlow';
    // the reflection sits on the surface, so it is drawn just after the water (renderOrder 3), depth-tested
    const mirrorPoints = new THREE.Mesh(makeGlowGeo(), mirrorMat);
    mirrorPoints.renderOrder = 3; mirrorPoints.frustumCulled = false; mirrorPoints.name = 'lotusGlowMirror';
    ctx.scene.add(glowPoints); ctx.scene.add(mirrorPoints);
    const glowPos = { setXYZ: (i, x, y, z) => { glowPosArr[i * 3] = x; glowPosArr[i * 3 + 1] = y; glowPosArr[i * 3 + 2] = z; }, set needsUpdate(v) { for (const g of glowGeos) g.attributes.aCenter.needsUpdate = v; } };
    const glowSize = { setX: (i, v) => { glowSizeArr[i] = v; }, set needsUpdate(v) { for (const g of glowGeos) g.attributes.aSize.needsUpdate = v; } };
    const glowGain = { setX: (i, v) => { glowGainArr[i] = v; }, set needsUpdate(v) { for (const g of glowGeos) g.attributes.aGain.needsUpdate = v; } };

    // ---- interaction helpers
    // opts: cause 'touch' (default) | 'patient' | 'lantern', hand (the hand that did it), openSeconds
    const openFlower = (i, opts = {}) => {
      const { cause = 'touch', hand = null, openSeconds = OPEN_SECONDS } = opts;
      const f = flowers[i];
      if (!f || f.state === 'opening' || f.state === 'open') return false;
      f.state = 'opening'; f.timer = 0; f.bloomFrom = f.bloom; f.open = true; f.openSeconds = openSeconds;
      f.hoverT = 0; f.stirred = false;
      f.stay = STAY_MIN + rnd() * (STAY_MAX - STAY_MIN);
      // a lantern-warmed bloom is slow and quiet: a smaller bump to the world and a softer ring on the water
      const lantern = cause === 'lantern';
      ctx.energy = Math.min(1, ctx.energy + (lantern ? WARM.energy : CONFIG.energy.lotus));
      if (typeof ctx.water.disturb === 'function') ctx.water.disturb(f.position.x, f.position.z, 0.18, lantern ? 0.18 : 0.28);
      ctx.events.emit('lotusbloom', { index: i, note: f.note, pos: f.position.clone(), color: f.color, cause, hand });
      return true;
    };

    // the lake wave: each open flower brightens as the front (WAVE_SPEED m/s from the wave's origin) reaches it
    ctx.events.on('lakewave', (e) => {
      const o = e && e.pos;
      if (!o || typeof o.x !== 'number') return;
      const t = ctx.time.t;
      for (const f of flowers) f.waveAt = f.open ? t + Math.hypot(f.position.x - o.x, f.position.z - o.z) / WAVE_SPEED : -1;
    });

    ctx.lotus = {
      flowers, clusters, pads,
      /** Bloom flower i as if it had been touched (returns false if it is already open); opts as openFlower. */
      open: (i, opts) => openFlower(i, opts),
      chordCount: 0,
      nearestBudDistance: Infinity, // horizontal distance from the head to the nearest closed bud
    };

    this._ = {
      flowers, pads, padMesh, flowerMesh, flowerUniforms, bloomAttr, lanternAttr, glowPoints, mirrorPoints, glowMat, mirrorMat,
      glowPos, glowSize, glowGain, openFlower, rnd,
      moonLight: null, moonLookupFrame: -1,
      surgeT: SURGE_SECONDS, chordArmed: true,
      _m: new THREE.Matrix4(), _q: new THREE.Quaternion(), _qy: new THREE.Quaternion(), _p: new THREE.Vector3(),
      _s: new THREE.Vector3(), _n: new THREE.Vector3(), _up: new THREE.Vector3(0, 1, 0), _axis: new THREE.Vector3(),
    };
  },

  update(ctx, dt) {
    const S = this._;
    const t = ctx.time.t;
    const level = ctx.water.level;
    const swell = ctx.water.swell || (() => 0);
    const { _m, _q, _qy, _p, _s, _n, _up, _axis } = S;

    // ---- pads: float on the swell, tilt with its slope, drift and turn very slowly
    const E = 0.05;
    for (let i = 0; i < S.pads.length; i++) {
      const p = S.pads[i];
      p.yaw += p.rotSpeed * dt;
      const x = p.homeX + Math.sin(t * 0.07 + p.driftPhase) * p.driftAmp;
      const z = p.homeZ + Math.cos(t * 0.055 + p.driftPhase * 1.3) * p.driftAmp;
      const y = level + swell(x, z, t) + PAD_LIFT;
      const sx = (swell(x + E, z, t) - swell(x - E, z, t)) / (2 * E);
      const sz = (swell(x, z + E, t) - swell(x, z - E, t)) / (2 * E);
      _n.set(-sx, 1, -sz).normalize();
      _q.setFromUnitVectors(_up, _n);
      _qy.setFromAxisAngle(_up, p.yaw);
      _q.multiply(_qy);
      _p.set(x, y, z); _s.set(p.radius, p.radius, p.radius);
      _m.compose(_p, _q, _s);
      S.padMesh.setMatrixAt(i, _m);
      p.x = x; p.z = z;
    }
    S.padMesh.instanceMatrix.needsUpdate = true;

    // ---- bloom state machines
    for (const f of S.flowers) {
      f.timer += dt;
      if (f.state === 'opening') {
        const u = Math.min(1, f.timer / f.openSeconds);
        f.bloom = f.bloomFrom + (1 - f.bloomFrom) * easeOutCubic(u);
        if (u >= 1) { f.state = 'open'; f.timer = 0; f.bloom = 1; }
      } else if (f.state === 'open') {
        f.bloom = 1;
        if (f.timer >= f.stay) { f.state = 'closing'; f.timer = 0; f.bloomFrom = 1; }
      } else if (f.state === 'closing') {
        const u = Math.min(1, f.timer / CLOSE_SECONDS);
        f.bloom = f.bloomFrom * (1 - smooth(u));
        if (u >= 1) { f.state = 'closed'; f.timer = 0; f.bloom = 0; }
      } else {
        f.bloom = 0;
      }
      f.open = f.state === 'opening' || f.state === 'open';
      // float
      const y = level + swell(f.position.x, f.position.z, t) + FLOWER_LIFT;
      f.position.y = y;
      f.bud.set(f.position.x, y + BUD_HEIGHT * f.scale, f.position.z);
    }

    // ---- lean + patience: a closed bud turns toward the nearest fingertip of an open, dry, idle hand
    const hands = ctx.hands && ctx.hands.list ? ctx.hands.list : null;
    const kIn = 1 - Math.exp(-dt / LEAN.tauIn), kOut = 1 - Math.exp(-dt / LEAN.tauOut);
    for (let i = 0; i < S.flowers.length; i++) {
      const f = S.flowers[i];
      let tx = 0, tz = 0, p = 0, k = kOut;
      if (f.state === 'closed' && hands) {
        let bestD2 = Infinity, bestHand = null, bestTip = null;
        for (let hi = 0; hi < hands.length; hi++) {
          const h = hands[hi];
          if (!h.visible || !h.active || h.submerged || h.pinch.active || h.grabbed) continue;
          for (let j = 0; j < h.tips.length; j++) {
            const d2 = h.tips[j].distanceToSquared(f.bud);
            if (d2 < bestD2) { bestD2 = d2; bestHand = h; bestTip = h.tips[j]; }
          }
        }
        const d = Math.sqrt(bestD2);
        if (d < LEAN.far) {
          p = 1 - smooth(Math.min(1, Math.max(0, (d - LEAN.near) / (LEAN.far - LEAN.near))));
          const ux = bestTip.x - f.bud.x, uz = bestTip.z - f.bud.z, ul = Math.hypot(ux, uz);
          if (ul > 1e-5) { tx = ux / ul * LEAN.angle * p; tz = uz / ul * LEAN.angle * p; }
          k = kIn;
        }
        // patience: a still fingertip hovering in the band above the pod (not touching) opens it in time
        if (d >= LEAN.hoverMin && d <= LEAN.hoverMax && bestTip.y - f.bud.y >= LEAN.hoverMin * 0.7 && bestHand.still) f.hoverT += dt;   // above the pod, not beside it
        else { f.hoverT = Math.max(0, f.hoverT - LEAN.decay * dt); if (f.hoverT <= 0) f.stirred = false; }
        if (f.hoverT >= LEAN.stirAt && !f.stirred) {
          f.stirred = true;
          ctx.events.emit('lotusstir', { index: i, note: f.note, pos: f.bud.clone(), hand: bestHand });
        }
        if (f.hoverT >= LEAN.openAt) S.openFlower(i, { cause: 'patient', hand: bestHand });
      } else { f.hoverT = 0; f.stirred = false; }
      f.leanX += (tx - f.leanX) * k;
      f.leanZ += (tz - f.leanZ) * k;
      f.lean = Math.hypot(f.leanX, f.leanZ);
      f.warmGlow = p;
      // the pose pivots at the base; the bud (touch target, halo centre) follows it
      _qy.setFromAxisAngle(_up, f.yaw);
      if (f.lean > 1e-4) { _axis.set(f.leanZ / f.lean, 0, -f.leanX / f.lean); f.rot.setFromAxisAngle(_axis, f.lean).multiply(_qy); }
      else f.rot.copy(_qy);
      f.bud.set(0, BUD_HEIGHT * f.scale, 0).applyQuaternion(f.rot).add(f.position);
    }

    // ---- warmth: a lantern the player set down among the pads (floating, once held, settled, lit) warms the
    // bud open after a while and keeps it open; the brightest lantern nearby, whatever it is doing, lights the petals
    const lanterns = ctx.lanterns && ctx.lanterns.list ? ctx.lanterns.list : null;
    for (let i = 0; i < S.flowers.length; i++) {
      const f = S.flowers[i];
      let near = Infinity, nearIdx = -1, lightW = 0, light = null;
      if (lanterns) {
        for (let li = 0; li < lanterns.length; li++) {
          const L = lanterns[li];
          if (L.state === 'rising') continue;
          const d = Math.hypot(L.position.x - f.position.x, L.position.z - f.position.z);
          if (d < WARM.glowLight && L.bright > 0.05) {
            const w = L.bright * (1 - smooth(Math.min(1, Math.max(0, (d - 0.35) / 0.25))));
            if (w > lightW) { lightW = w; light = L; }
          }
          if (L.state === 'floating' && L.touched && !L.incoming && !L.dropping && L.bright > WARM.minBright && d < near) { near = d; nearIdx = li; }
        }
      }
      if (near < WARM.enter) f.warmNear = true; else if (near > WARM.exit) f.warmNear = false;
      f.lanternIdx = f.warmNear ? nearIdx : -1;
      f.warm = Math.min(WARM.cap, Math.max(0, f.warm + (f.warmNear ? dt : -2 * dt)));
      if (f.warm > WARM.need && f.state === 'closed' && f.bloom < TOUCH_MAX_BLOOM) S.openFlower(i, { cause: 'lantern', openSeconds: WARM.openSeconds });
      // while the lantern stays, the flower stays: it closes only `linger` seconds after the lantern has left
      if (f.warmNear && f.state === 'open') f.timer = Math.min(f.timer, f.stay - WARM.linger);
      if (light) S.lanternAttr.setXYZW(i, light.position.x, light.position.y, light.position.z, lightW);
      else S.lanternAttr.setW(i, 0);
    }
    S.lanternAttr.needsUpdate = true;

    // ---- nearest closed bud (for the hints)
    {
      const head = ctx.playerCtl ? ctx.playerCtl.state.headWorld : null;
      let best = Infinity;
      if (head) for (const f of S.flowers) { if (f.open) continue; const d = Math.hypot(f.bud.x - head.x, f.bud.z - head.z); if (d < best) best = d; }
      ctx.lotus.nearestBudDistance = best;
    }

    // ---- touch: any fingertip of a visible hand near a closed bud
    if (ctx.hands && ctx.hands.list) {
      const r2 = TOUCH_RADIUS * TOUCH_RADIUS;
      for (const f of S.flowers) {
        if (f.bloom >= TOUCH_MAX_BLOOM || f.open) continue;
        let hit = null;
        for (const h of ctx.hands.list) {
          if (!h.visible) continue;
          for (let k = 0; k < h.tips.length && !hit; k++) if (h.tips[k].distanceToSquared(f.bud) < r2) hit = h;
          if (hit) break;
        }
        if (hit) S.openFlower(f.index, { cause: 'touch', hand: hit });
      }
    }

    // ---- full chord: all six open at once (once per episode)
    const allOpen = S.flowers.every((f) => f.open && f.bloom > 0.6);
    if (allOpen && S.chordArmed) {
      S.chordArmed = false; S.surgeT = 0; ctx.lotus.chordCount++;
      ctx.events.emit('lotuschord', {});
    } else if (!allOpen) S.chordArmed = true;
    S.surgeT = Math.min(SURGE_SECONDS, S.surgeT + dt);
    const surge = Math.sin(Math.PI * Math.min(1, S.surgeT / SURGE_SECONDS));

    // ---- flower instances + glow attributes
    for (let i = 0; i < S.flowers.length; i++) {
      const f = S.flowers[i];
      _s.setScalar(f.scale);
      _m.compose(f.position, f.rot, _s);
      S.flowerMesh.setMatrixAt(i, _m);
      S.bloomAttr.setX(i, f.bloom);
      const pulse = f.open ? 1 + 0.1 * Math.sin(t * (Math.PI * 2 / 4) + f.pulsePhase) : 1;
      const closedGain = GLOW_GAIN_CLOSED + (f.bloom < TOUCH_MAX_BLOOM ? WARM_GAIN * f.warmGlow : 0); // warms as a hand nears
      const lanternGain = WARM_HALO * smooth(Math.min(1, f.warm));                                      // and as a lantern's warmth builds
      // the lake wave passing: this flower's own surge, a 2 s swell from the moment the front reaches it
      const sf = f.waveAt > 0 ? Math.sin(Math.PI * Math.min(1, Math.max(0, (t - f.waveAt) / WAVE_SECONDS))) : 0;
      const surgeF = Math.max(surge, WAVE_SURGE * sf);
      S.glowPos.setXYZ(i, f.bud.x, f.bud.y, f.bud.z);
      S.glowSize.setX(i, GLOW_SIZE * (0.2 + f.bloom) * f.scale * (1 + 0.15 * surgeF));
      S.glowGain.setX(i, (closedGain + lanternGain + (GLOW_GAIN_OPEN - GLOW_GAIN_CLOSED) * f.bloom) * pulse * (1 + 0.8 * surgeF));
    }
    S.flowerMesh.instanceMatrix.needsUpdate = true;
    S.bloomAttr.needsUpdate = true;
    S.glowPos.needsUpdate = true; S.glowSize.needsUpdate = true; S.glowGain.needsUpdate = true;

    // ---- uniforms
    const U = S.flowerUniforms;
    U.uTime.value = t;
    U.uSurge.value = surge;
    if (!S.moonLight && ctx.time.frame !== S.moonLookupFrame) { S.moonLookupFrame = ctx.time.frame; S.moonLight = ctx.scene.getObjectByName('moonLight') || null; }
    if (S.moonLight) {
      if (S.moonLight.position.lengthSq() > 1e-6) U.uMoonDir.value.copy(S.moonLight.position).normalize();
      U.uMoonColor.value.copy(S.moonLight.color).multiplyScalar(S.moonLight.intensity);
    }
    const fog = ctx.scene.fog;
    if (fog) { U.uFogColor.value.copy(fog.color); if (fog.isFogExp2) U.uFogDensity.value = fog.density; }

    for (const m of [S.glowMat, S.mirrorMat]) m.uniforms.uLevel.value = level;
  },
};
