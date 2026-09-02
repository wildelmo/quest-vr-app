import * as THREE from 'three';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';
import { CONFIG } from '../config.js';

export const JOINT_NAMES = [
  'wrist',
  'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip',
  'index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip',
  'middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip',
  'ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip',
  'pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip',
];
export const TIP_NAMES = ['index-finger-tip', 'middle-finger-tip', 'ring-finger-tip', 'pinky-finger-tip', 'thumb-tip'];
// joints used to disturb the water (a good spread of the hand for few samples)
export const WATER_JOINTS = ['wrist', 'thumb-tip', 'index-finger-tip', 'middle-finger-phalanx-proximal', 'middle-finger-tip', 'ring-finger-tip', 'pinky-finger-tip'];
const FINGERS = ['index-finger', 'middle-finger', 'ring-finger', 'pinky-finger'];
const FINGER_CHAIN = ['metacarpal', 'phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal', 'tip'];

const H = CONFIG.hands;
const RING = 36; // ~0.5 s at 72 Hz

function makeState(handedness) {
  const joints = {};
  for (const n of JOINT_NAMES) joints[n] = { position: new THREE.Vector3(), local: new THREE.Vector3(), prev: new THREE.Vector3(), velocity: new THREE.Vector3(), radius: 0.01, valid: false };
  return {
    handedness, visible: false, tracked: false, active: false, alpha: 0, lostFor: 0, reacqFrames: 0, everTracked: false,
    joints,
    palm: { position: new THREE.Vector3(), normal: new THREE.Vector3(0, -1, 0), velocity: new THREE.Vector3(), velocityLocal: new THREE.Vector3(), speed: 0, speedH: 0, filtered: new THREE.Vector3() },
    tips: TIP_NAMES.map(() => new THREE.Vector3()),
    speed: 0, submergedDepth: 0, submerged: false, submergedJoints: [], enteredWater: false, leftWater: false,
    curl: [0, 0, 0, 0], meanCurl: 0, open: false, grasp: false,
    pinch: { active: false, justStarted: false, justReleased: false, point: new THREE.Vector3(), strength: 0, distance: 1, os: false, onFrames: 0, offFrames: 0, kind: 'none' },
    stillDisp: 1, still: false, stillFor: 0, openStill: false, attraction: 0,
    grabbed: null, source: 'none', // 'xr' | 'desktop'
    _ring: Array.from({ length: RING }, () => new THREE.Vector3()), _ringI: 0, _ringN: 0, _prevSubmerged: false,
  };
}

// ---------------------------------------------------------------------------------------------
// Glass hand material: fresnel rim, tinted below the water line, meniscus at the surface,
// warmed by a held lantern, fades with tracking confidence. Works for the skinned WebXR hand GLB
// and for instanced spheres (fallback / desktop hand).
function makeGlassMaterial(ctx, tint) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(tint) },
      uUnderColor: { value: new THREE.Color(CONFIG.water.planktonColor) },
      uWarmColor: { value: new THREE.Color(CONFIG.colors.lantern) },
      uAlpha: { value: 0 },
      uWaterLevel: { value: ctx.water.level },
      uTime: { value: 0 },
      uWarm: { value: new THREE.Vector3(0, -100, 0) },
      uWarmOn: { value: 0 },
      uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
    },
    vertexShader: /* glsl */`
      #include <common>
      #include <skinning_pars_vertex>
      varying vec3 vNormalW; varying vec3 vWorldPos;
      void main() {
        #include <beginnormal_vertex>
        #include <skinbase_vertex>
        #include <skinnormal_vertex>
        #include <begin_vertex>
        #include <skinning_vertex>
        vec4 wp = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          wp = instanceMatrix * wp;
          objectNormal = mat3(instanceMatrix) * objectNormal;
        #endif
        wp = modelMatrix * wp;
        vWorldPos = wp.xyz;
        vNormalW = normalize(mat3(modelMatrix) * objectNormal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor, uUnderColor, uWarmColor, uWarm, uMoonDir; uniform float uAlpha, uWaterLevel, uTime, uWarmOn;
      varying vec3 vNormalW; varying vec3 vWorldPos;
      void main() {
        vec3 N = normalize(vNormalW);
        vec3 V = normalize(cameraPosition - vWorldPos);
        float ndv = max(dot(N, V), 0.0);
        float fres = pow(1.0 - ndv, 2.2);
        float under = smoothstep(uWaterLevel + 0.015, uWaterLevel - 0.04, vWorldPos.y);
        vec3 col = mix(uColor, uUnderColor, under);
        float rim = 0.12 + 0.95 * fres;
        col *= rim * (1.0 + under * 1.6);
        // moon glint on the glass
        vec3 Hh = normalize(uMoonDir + V);
        col += vec3(0.9, 0.85, 0.7) * pow(max(dot(N, Hh), 0.0), 60.0) * 0.35;
        // meniscus: a thin bright line where the hand crosses the surface
        float men = 1.0 - smoothstep(0.0, 0.007, abs(vWorldPos.y - uWaterLevel));
        col += vec3(0.7, 1.0, 1.0) * men * 1.8;
        // warmth from a held lantern
        float dw = distance(vWorldPos, uWarm);
        float warm = uWarmOn / (1.0 + 45.0 * dw * dw);
        col += uWarmColor * warm * 0.9;
        float a = (0.10 + 0.70 * fres + men * 0.5 + warm * 0.3) * uAlpha;
        a *= 1.0 - 0.25 * under;
        gl_FragColor = vec4(col, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    // depthTest off: the water surface writes depth, and a submerged hand must stay visible through it
    transparent: true, depthWrite: false, depthTest: false, side: THREE.FrontSide, fog: false,
  });
  return mat;
}

// A plausible right-hand skeleton in a hand-local frame: +X thumb side, +Y back of hand, -Z toward the fingers.
const TEMPLATE = {
  'wrist': [0, 0, 0],
  'thumb-metacarpal': [0.028, -0.004, -0.02], 'thumb-phalanx-proximal': [0.052, -0.008, -0.045], 'thumb-phalanx-distal': [0.068, -0.01, -0.07], 'thumb-tip': [0.078, -0.012, -0.09],
  'index-finger-metacarpal': [0.02, 0, -0.04], 'index-finger-phalanx-proximal': [0.03, 0, -0.09], 'index-finger-phalanx-intermediate': [0.033, 0, -0.125], 'index-finger-phalanx-distal': [0.035, 0, -0.15], 'index-finger-tip': [0.036, 0, -0.17],
  'middle-finger-metacarpal': [0.005, 0, -0.04], 'middle-finger-phalanx-proximal': [0.008, 0, -0.095], 'middle-finger-phalanx-intermediate': [0.009, 0, -0.135], 'middle-finger-phalanx-distal': [0.01, 0, -0.16], 'middle-finger-tip': [0.01, 0, -0.18],
  'ring-finger-metacarpal': [-0.012, 0, -0.04], 'ring-finger-phalanx-proximal': [-0.015, 0, -0.09], 'ring-finger-phalanx-intermediate': [-0.017, 0, -0.128], 'ring-finger-phalanx-distal': [-0.018, 0, -0.152], 'ring-finger-tip': [-0.019, 0, -0.17],
  'pinky-finger-metacarpal': [-0.028, 0, -0.035], 'pinky-finger-phalanx-proximal': [-0.035, 0, -0.08], 'pinky-finger-phalanx-intermediate': [-0.039, 0, -0.108], 'pinky-finger-phalanx-distal': [-0.041, 0, -0.128], 'pinky-finger-tip': [-0.043, 0, -0.142],
};
const RADII = (n) => n === 'wrist' ? 0.022 : n.endsWith('tip') ? 0.008 : n.includes('metacarpal') ? 0.014 : 0.0105;

export function createHands(ctx) {
  const { renderer, player, camera } = ctx;
  const left = makeState('left');
  const right = makeState('right');
  const byHandedness = { left, right };
  const list = [left, right];
  const factory = new XRHandModelFactory();
  factory.setPath('assets/hands/'); // XRHandMeshModel builds `${path}${handedness}.glb`
  const DEBUG = ctx.debug;

  const mats = { left: makeGlassMaterial(ctx, CONFIG.colors.hand), right: makeGlassMaterial(ctx, CONFIG.colors.hand) };

  // ---- XR hands (index 0/1 map to handedness on 'connected')
  const xrHands = [];
  const meshModels = [];
  const sphereFallback = {};
  for (let i = 0; i < 2; i++) {
    const xrHand = renderer.xr.getHand(i);
    xrHand.name = `xrHand${i}`;
    player.add(xrHand);
    xrHand.userData.handedness = null;
    xrHand.userData.osPinch = false;
    // The factory loads the GLB when the hand's 'connected' event fires, so it must be created up front.
    const model = factory.createHandModel(xrHand, 'mesh');
    model.renderOrder = 3;
    xrHand.add(model);
    xrHand.userData.model = model;
    meshModels.push({ xrHand, model, styled: false });
    xrHand.addEventListener('connected', (e) => {
      const src = e.data;
      xrHand.userData.handedness = src?.handedness || null;
      xrHand.userData.hasHand = !!src?.hand;
      xrHand.userData.osPinch = false;
    });
    xrHand.addEventListener('disconnected', () => {
      const hs = xrHand.userData.handedness;
      if (hs && byHandedness[hs]) byHandedness[hs].tracked = false;
      xrHand.userData.handedness = null;
      xrHand.userData.osPinch = false;
    });
    // Meta's ML pinch arrives as select events on the controller object of the same input source.
    const ctl = renderer.xr.getController(i);
    ctl.addEventListener('selectstart', (e) => { if (e.data?.hand) xrHand.userData.osPinch = true; });
    ctl.addEventListener('selectend', (e) => { if (e.data?.hand) xrHand.userData.osPinch = false; });
    ctl.addEventListener('disconnected', () => { xrHand.userData.osPinch = false; });
    player.add(ctl);
    xrHands.push(xrHand);
  }

  // Sphere fallback (also the desktop hand's body): one InstancedMesh per hand.
  const sphereGeo = new THREE.SphereGeometry(1, 10, 8);
  for (const hs of ['left', 'right']) {
    const im = new THREE.InstancedMesh(sphereGeo, mats[hs], JOINT_NAMES.length);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.renderOrder = 3; im.frustumCulled = false; im.visible = false; im.name = `handSpheres_${hs}`;
    ctx.scene.add(im);
    sphereFallback[hs] = im;
  }

  // Fingertip glow points (both hands) + 2 pinch sparks, one draw call.
  const tipCount = TIP_NAMES.length * 2 + 2;
  const tipGeo = new THREE.BufferGeometry();
  const tipPos = new Float32Array(tipCount * 3);
  const tipA = new Float32Array(tipCount);
  const tipS = new Float32Array(tipCount).fill(1);
  tipGeo.setAttribute('position', new THREE.BufferAttribute(tipPos, 3).setUsage(THREE.DynamicDrawUsage));
  tipGeo.setAttribute('aAlpha', new THREE.BufferAttribute(tipA, 1).setUsage(THREE.DynamicDrawUsage));
  tipGeo.setAttribute('aSize', new THREE.BufferAttribute(tipS, 1).setUsage(THREE.DynamicDrawUsage));
  const tipMat = new THREE.ShaderMaterial({
    uniforms: { uMap: { value: ctx.assets.tex.glowFirefly }, uColor: { value: new THREE.Color(0xbfefff) }, uScale: { value: 300 }, uWaterLevel: { value: ctx.water.level } },
    vertexShader: /* glsl */`
      attribute float aAlpha; attribute float aSize; varying float vA; varying float vUnder; uniform float uScale; uniform float uWaterLevel;
      void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vA = aAlpha; vUnder = smoothstep(uWaterLevel + 0.01, uWaterLevel - 0.03, position.y);
        gl_PointSize = (0.022 + 0.02 * vUnder) * aSize * uScale / max(-mv.z, 0.05); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */`
      uniform sampler2D uMap; uniform vec3 uColor; varying float vA; varying float vUnder;
      void main(){ vec4 t = texture2D(uMap, gl_PointCoord); vec3 c = mix(uColor, vec3(0.45, 1.0, 0.95), vUnder);
        gl_FragColor = vec4(c * t.a * vA * (0.6 + vUnder), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment> }`,
    transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, fog: false,
  });
  const tipPoints = new THREE.Points(tipGeo, tipMat);
  tipPoints.renderOrder = 4; tipPoints.frustumCulled = false; tipPoints.name = 'fingertips';
  ctx.scene.add(tipPoints);
  const sparks = [{ t: -1, pos: new THREE.Vector3() }, { t: -1, pos: new THREE.Vector3() }];

  // ---- desktop virtual hand
  let desktopOn = false;
  const dh = { x: 0.62, y: 0.6, pinch: false, submerged: false, active: false };
  const desktopTarget = new THREE.Vector3();
  const desktopPos = new THREE.Vector3();
  let desktopPinchT = 0;
  function enableDesktop() {
    if (desktopOn) return;
    desktopOn = true;
    const canvas = renderer.domElement;
    window.addEventListener('pointermove', (e) => { dh.x = e.clientX / window.innerWidth; dh.y = e.clientY / window.innerHeight; dh.active = true; dh.submerged = e.shiftKey; });
    canvas.addEventListener('pointerdown', (e) => { if (e.button === 0) dh.pinch = true; });
    window.addEventListener('pointerup', () => { dh.pinch = false; });
    window.addEventListener('keydown', (e) => { if (e.key === 'Shift') dh.submerged = true; });
    window.addEventListener('keyup', (e) => { if (e.key === 'Shift') dh.submerged = false; });
  }
  function setDesktopHand(h) {
    if (typeof h.x === 'number') dh.x = h.x;
    if (typeof h.y === 'number') dh.y = h.y;
    if (typeof h.pinch === 'boolean') dh.pinch = h.pinch;
    if (typeof h.submerged === 'boolean') dh.submerged = h.submerged;
    dh.active = true;
  }

  const _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _e = new THREE.Euler();
  const meet = new THREE.Vector3();
  const rigInv = new THREE.Matrix4();

  function updateDesktopHand(dt) {
    const st = right;
    if (!dh.active) { st.tracked = false; return; }
    const cx = THREE.MathUtils.lerp(-0.38, 0.38, dh.x);
    // dip: put the hand ~15 cm under the surface wherever the mouse is
    const cy = THREE.MathUtils.lerp(0.22, -0.26, dh.y);
    desktopTarget.set(cx, cy, -0.55).applyMatrix4(camera.matrixWorld);
    if (dh.submerged) desktopTarget.y = Math.min(desktopTarget.y, ctx.water.level - 0.15);
    desktopTarget.y = Math.max(desktopTarget.y, ctx.water.level - 0.6);
    if (!st.tracked) desktopPos.copy(desktopTarget);
    desktopPos.lerp(desktopTarget, Math.min(1, dt * 14));
    _e.setFromQuaternion(camera.getWorldQuaternion(_q), 'YXZ');
    _q.setFromEuler(_e.set(0, _e.y, 0, 'YXZ'));
    desktopPinchT += ((dh.pinch ? 1 : 0) - desktopPinchT) * Math.min(1, dt * 18);
    meet.set(0.05, -0.012, -0.12);
    rigInv.copy(player.matrixWorld).invert();
    for (const n of JOINT_NAMES) {
      const j = st.joints[n];
      _v.fromArray(TEMPLATE[n]);
      if (n.startsWith('thumb') || n.startsWith('index')) {
        const k = n.endsWith('tip') ? 1 : n.endsWith('distal') ? 0.75 : n.endsWith('intermediate') ? 0.45 : n.endsWith('proximal') ? 0.2 : 0;
        _v.lerp(meet, desktopPinchT * k);
      }
      _v.applyQuaternion(_q).add(desktopPos);
      j.position.copy(_v);
      j.local.copy(_v).applyMatrix4(rigInv);
      j.radius = RADII(n);
      j.valid = true;
    }
    st.tracked = true; st.source = 'desktop';
    st.palm.normal.set(0, -1, 0);
    st.pinch.os = dh.pinch;
  }

  // ---- XR hand state extraction
  function readXRHand(xrHand, st) {
    const joints = xrHand.joints;
    if (!joints || !xrHand.visible || ctx.xrBlurred) { st.tracked = false; return; }
    const wrist = joints['wrist'], itip = joints['index-finger-tip'];
    if (!wrist || !wrist.visible || !itip || !itip.visible) { st.tracked = false; return; }
    for (const n of JOINT_NAMES) {
      const j = st.joints[n];
      const xj = joints[n];
      if (!xj || !xj.visible) { j.valid = false; continue; }
      j.local.copy(xj.position);
      j.position.copy(xj.position).applyMatrix4(player.matrixWorld);
      j.radius = xj.jointRadius || j.radius;
      j.valid = true;
    }
    const mc = joints['middle-finger-metacarpal'];
    if (mc && mc.visible) st.palm.normal.set(0, -1, 0).applyQuaternion(mc.quaternion).applyQuaternion(player.quaternion).normalize();
    st.tracked = true; st.source = 'xr';
    st.pinch.os = !!xrHand.userData.osPinch;
  }

  function fingerCurl(st, finger) {
    const chain = FINGER_CHAIN.map((p) => st.joints[`${finger}-${p}`]);
    if (chain.some((j) => !j.valid)) return 0;
    let len = 0;
    for (let i = 1; i < chain.length; i++) len += chain[i].position.distanceTo(chain[i - 1].position);
    if (len < 1e-4) return 0;
    const straight = chain[4].position.distanceTo(chain[0].position) / len;
    return THREE.MathUtils.clamp(1 - (straight - 0.45) / 0.5, 0, 1);
  }

  function finishState(st, dt) {
    const wasTracked = st.visible && st.lostFor === 0;
    if (st.tracked) {
      if (!wasTracked) { st.reacqFrames = 3; st.everTracked = true; }
      st.lostFor = 0; st.visible = true;
    } else {
      st.lostFor += dt;
      if (st.lostFor > H.lostFade) st.visible = false;
    }
    // confidence eases: down slowly (350 ms), up quickly (120 ms)
    const target = st.tracked ? 1 : 0;
    const tau = st.tracked ? 0.12 : 0.35;
    st.alpha += (target - st.alpha) * Math.min(1, dt / tau);
    st.active = st.tracked && st.alpha > 0.5;

    if (!st.tracked) {
      // grace period for a held object, then release it into the water (never into the sky)
      if (st.grabbed && st.lostFor > H.graceGrab) {
        const g = st.grabbed; st.grabbed = null; g.held = null; st.pinch.active = false;
        try { g.onRelease?.(st, _v.set(0, 0, 0), { lost: true }); } catch (e) { console.error(e); }
        ctx.events.emit('pinchend', { hand: st, lost: true, released: true });
      }
      if (st.pinch.active && st.lostFor > H.graceGrab) { st.pinch.active = false; }
      st.pinch.justStarted = false; st.pinch.justReleased = false; st.speed = 0;
      if (st.submerged && st.lostFor > 0.3) { st.submerged = false; st.submergedDepth = 0; st.submergedJoints.length = 0; }
      st.stillFor = 0; st.openStill = false; st.attraction = 0; st.still = false;
      st.palm.velocity.set(0, 0, 0); st.palm.velocityLocal.set(0, 0, 0); st.palm.speed = 0; st.palm.speedH = 0;
      st.enteredWater = false; st.leftWater = false;
      return;
    }

    // velocities (rig-local so the player's own glide doesn't count); zeroed for a few frames after reacquire
    const invDt = 1 / Math.max(dt, 1e-3);
    let maxSpeed = 0;
    const fresh = st.reacqFrames > 0;
    if (st.reacqFrames > 0) st.reacqFrames--;
    for (const n of JOINT_NAMES) {
      const j = st.joints[n];
      if (!j.valid) continue;
      if (!fresh) { _v.subVectors(j.local, j.prev).multiplyScalar(invDt); j.velocity.lerp(_v, 0.5); if (j.velocity.length() > 4) j.velocity.setLength(4); }
      else j.velocity.set(0, 0, 0);
      j.prev.copy(j.local);
      const s = j.velocity.length(); if (s > maxSpeed) maxSpeed = s;
    }
    st.speed = maxSpeed;
    const palmJ = st.joints['middle-finger-metacarpal'].valid ? st.joints['middle-finger-metacarpal'] : st.joints['wrist'];
    st.palm.position.copy(palmJ.position);
    st.palm.velocityLocal.copy(palmJ.velocity);
    st.palm.velocity.copy(palmJ.velocity).applyQuaternion(player.quaternion).add(ctx.playerCtl?.velocity || _v2.set(0, 0, 0));
    st.palm.speed = palmJ.velocity.length();
    st.palm.speedH = Math.hypot(palmJ.velocity.x, palmJ.velocity.z);
    // filtered palm position (tau 120 ms) and a 0.5 s ring buffer → stillness as max displacement
    if (fresh) { st.palm.filtered.copy(palmJ.local); st._ringN = 0; st._ringI = 0; }
    else st.palm.filtered.lerp(palmJ.local, Math.min(1, dt / 0.12));
    st._ring[st._ringI].copy(st.palm.filtered); st._ringI = (st._ringI + 1) % RING; st._ringN = Math.min(RING, st._ringN + 1);
    let disp = 0;
    for (let i = 0; i < st._ringN; i++) { const d = st._ring[i].distanceTo(st.palm.filtered); if (d > disp) disp = d; }
    st.stillDisp = disp;
    st.still = st._ringN >= RING / 2 && disp < H.stillDisp;
    // tips
    for (let i = 0; i < TIP_NAMES.length; i++) st.tips[i].copy(st.joints[TIP_NAMES[i]].position);
    // finger curl / open / grasp
    let mc = 0;
    for (let i = 0; i < 4; i++) { st.curl[i] = fingerCurl(st, FINGERS[i]); mc += st.curl[i]; }
    st.meanCurl = mc / 4;
    st.open = st.curl.every((c) => c < H.curlOpen);
    if (!st.grasp && st.meanCurl > H.graspOn) st.grasp = true;
    else if (st.grasp && st.meanCurl < H.graspOff) st.grasp = false;
    // water
    const level = ctx.water.level;
    let depth = 0; st.submergedJoints.length = 0;
    for (const n of WATER_JOINTS) { const j = st.joints[n]; if (!j.valid) continue; const d = level - j.position.y; if (d > 0) { st.submergedJoints.push(j); if (d > depth) depth = d; } }
    st.submergedDepth = depth;
    const wasSub = st.submerged;
    if (!wasSub && depth > 0.01) st.submerged = true; else if (wasSub && depth <= 0.0) st.submerged = false;
    st.enteredWater = st.submerged && !wasSub;
    st.leftWater = !st.submerged && wasSub;
    if (st.enteredWater) ctx.events.emit('handenter', { hand: st, speed: Math.abs(palmJ.velocity.y) });
    if (st.leftWater) ctx.events.emit('handexit', { hand: st });
    // pinch: fuse the OS pinch with tip distance (2 frames on / 3 frames off), or a whole-hand grasp
    const it = st.joints['index-finger-tip'], tt = st.joints['thumb-tip'];
    const d = (it.valid && tt.valid) ? it.position.distanceTo(tt.position) : 1;
    st.pinch.distance = d;
    st.pinch.justStarted = false; st.pinch.justReleased = false;
    const tipStrength = THREE.MathUtils.clamp((H.pinchOff - d) / (H.pinchOff - H.pinchOn), 0, 1);
    st.pinch.strength = Math.max(tipStrength, st.grasp ? 1 : 0, st.pinch.os ? 1 : 0);
    if (d < H.pinchOn) { st.pinch.onFrames++; st.pinch.offFrames = 0; } else if (d > H.pinchOff) { st.pinch.offFrames++; st.pinch.onFrames = 0; }
    const wantOn = st.pinch.os || st.pinch.onFrames >= 2 || st.grasp;
    const wantOff = !st.pinch.os && st.pinch.offFrames >= 3 && !st.grasp;
    if (st.grasp) st.pinch.point.copy(st.palm.position).addScaledVector(st.palm.normal, 0.035);
    else st.pinch.point.addVectors(it.position, tt.position).multiplyScalar(0.5);
    if (!st.pinch.active && wantOn && st.active) { st.pinch.active = true; st.pinch.justStarted = true; st.pinch.kind = st.grasp && d > H.pinchOff ? 'grasp' : 'pinch'; }
    else if (st.pinch.active && wantOff) { st.pinch.active = false; st.pinch.justReleased = true; }
    // stillness / openness → firefly attraction
    if (st.still && !st.submerged) st.stillFor += dt; else st.stillFor = 0;
    st.openStill = st.open && st.stillFor > H.stillTime && !st.submerged;
    st.attraction = st.open && !st.submerged ? THREE.MathUtils.smoothstep(st.stillFor, 0.3, 1.5) : 0;
    st._prevSubmerged = st.submerged;
  }

  function handleGrabs(st) {
    if (st.pinch.justStarted) {
      let best = null, bestD = H.grabRadius;
      for (const g of ctx.grabbables) {
        if (g.active === false || g.held) continue;
        const d = g.position.distanceTo(st.pinch.point) - (g.radius || 0);
        if (d < bestD) { bestD = d; best = g; }
      }
      if (best) { st.grabbed = best; best.held = st; try { best.onGrab?.(st); } catch (e) { console.error(e); } ctx.events.emit('grab', { hand: st, grabbable: best }); }
      else { const sp = sparks[st.handedness === 'left' ? 0 : 1]; sp.t = ctx.time.t; sp.pos.copy(st.pinch.point); ctx.events.emit('pinchmiss', { hand: st, point: st.pinch.point }); }
      ctx.events.emit('pinchstart', { hand: st, grabbed: !!best, kind: st.pinch.kind });
    }
    if (st.pinch.justReleased) {
      const g = st.grabbed;
      if (g) { st.grabbed = null; g.held = null; try { g.onRelease?.(st, st.palm.velocity, { lost: false }); } catch (e) { console.error(e); } }
      ctx.events.emit('pinchend', { hand: st, released: !!g });
    }
  }

  const _m = new THREE.Matrix4();
  function updateVisuals(dt) {
    for (const mm of meshModels) {
      if (mm.styled) continue;
      let sm = null;
      mm.model.traverse((o) => { if (!sm && o.isSkinnedMesh) sm = o; });
      if (sm) {
        const hs = mm.xrHand.userData.handedness || 'right';
        sm.material = mats[hs];
        sm.frustumCulled = false; sm.renderOrder = 3; sm.castShadow = false; sm.receiveShadow = false;
        mm.styled = true; mm.mesh = sm;
      }
    }
    const moonDir = ctx.sky?.moonDirWorld;
    for (const st of list) {
      const mat = mats[st.handedness];
      mat.uniforms.uAlpha.value = st.alpha;
      mat.uniforms.uWaterLevel.value = ctx.water.level;
      mat.uniforms.uTime.value = ctx.time.t;
      if (moonDir) mat.uniforms.uMoonDir.value.copy(moonDir);
      const g = st.grabbed;
      mat.uniforms.uWarmOn.value += (((g && g.warm !== false) ? 1 : 0) - mat.uniforms.uWarmOn.value) * Math.min(1, dt * 6);
      if (g) mat.uniforms.uWarm.value.copy(g.position);
      const hasMesh = meshModels.some((mm) => mm.styled && mm.xrHand.userData.handedness === st.handedness && mm.xrHand.visible);
      const useSpheres = st.alpha > 0.01 && (!hasMesh || st.source === 'desktop');
      const im = sphereFallback[st.handedness];
      im.visible = useSpheres;
      if (useSpheres) {
        for (let i = 0; i < JOINT_NAMES.length; i++) {
          const j = st.joints[JOINT_NAMES[i]];
          const r = j.valid ? j.radius : 0.0001;
          _m.makeScale(r, r, r).setPosition(j.position);
          im.setMatrixAt(i, _m);
        }
        im.instanceMatrix.needsUpdate = true;
      }
    }
    // fingertip glow + pinch sparks
    let k = 0;
    for (const st of list) {
      for (let i = 0; i < TIP_NAMES.length; i++) {
        const j = st.joints[TIP_NAMES[i]];
        tipPos[k * 3] = j.position.x; tipPos[k * 3 + 1] = j.position.y; tipPos[k * 3 + 2] = j.position.z;
        const isPinchTip = TIP_NAMES[i] === 'index-finger-tip' || TIP_NAMES[i] === 'thumb-tip';
        tipA[k] = j.valid ? st.alpha * (0.35 + 0.65 * st.pinch.strength * (isPinchTip ? 1 : 0.2)) : 0;
        tipS[k] = 1;
        k++;
      }
    }
    for (const sp of sparks) {
      const age = ctx.time.t - sp.t;
      const on = sp.t >= 0 && age < 0.18;
      tipPos[k * 3] = sp.pos.x; tipPos[k * 3 + 1] = sp.pos.y; tipPos[k * 3 + 2] = sp.pos.z;
      tipA[k] = on ? (1 - age / 0.18) * 1.2 : 0; tipS[k] = on ? 2.5 + age * 20 : 1;
      k++;
    }
    tipGeo.attributes.position.needsUpdate = true;
    tipGeo.attributes.aAlpha.needsUpdate = true;
    tipGeo.attributes.aSize.needsUpdate = true;
    tipMat.uniforms.uWaterLevel.value = ctx.water.level;
    tipMat.uniforms.uScale.value = (renderer.xr.isPresenting ? 1900 : renderer.domElement.height) * 0.55;
  }

  const headLocal = new THREE.Vector3();
  function debugLoss(st, xrHand) {
    if (!DEBUG || !st.everTracked || st.tracked || st.lostFor > 0) return;
    const w = st.joints['wrist'].local;
    headLocal.copy(camera.position);
    const dx = w.x - headLocal.x, dy = w.y - headLocal.y, dz = w.z - headLocal.z;
    const pitch = THREE.MathUtils.radToDeg(Math.atan2(dy, Math.hypot(dx, dz)));
    console.log(`[hands] ${st.handedness} lost at head-relative pitch ${pitch.toFixed(1)}°, dist ${Math.hypot(dx, dy, dz).toFixed(2)} m`);
  }

  function update(frame, dt) {
    const presenting = renderer.xr.isPresenting;
    if (presenting) {
      left.tracked = false; right.tracked = false;
      for (const xrHand of xrHands) {
        const hs = xrHand.userData.handedness;
        if (!hs || !byHandedness[hs]) continue;
        readXRHand(xrHand, byHandedness[hs]);
        if (DEBUG) debugLoss(byHandedness[hs], xrHand);
      }
    } else if (desktopOn) {
      left.tracked = false;
      updateDesktopHand(dt);
    } else { left.tracked = false; right.tracked = false; }
    for (const st of list) { finishState(st, dt); handleGrabs(st); }
    updateVisuals(dt);
  }

  return {
    left, right, list, byHandedness,
    any: (fn) => list.some(fn),
    update, enableDesktop, setDesktopHand,
    materials: mats,
    debugInfo: () => ({
      models: meshModels.map((mm) => ({ handedness: mm.xrHand.userData.handedness, styled: mm.styled, children: mm.model.children.length, visible: mm.xrHand.visible })),
      xr: xrHands.map((h) => ({ handedness: h.userData.handedness, hasHand: !!h.userData.hasHand, joints: h.joints ? Object.keys(h.joints).length : 0, visible: h.visible })),
    }),
  };
}
