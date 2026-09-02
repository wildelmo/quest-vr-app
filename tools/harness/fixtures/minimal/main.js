/**
 * Minimal fixture implementing the full `window.__nocturne` contract so the harness
 * (tools/harness/run.mjs + fake-xr.js) can be validated end to end without the real app.
 *
 * Scene: sky-blue background, floor grid, translucent "water" plane at y = 0.9, a box
 * that turns orange while a hand is pinching, two XRHandModelFactory 'spheres' hands
 * (tinted cyan when any joint is under water), a cyan marker on every index-finger-tip
 * read from renderer.xr.getHand(i).joints, a desktop virtual hand and mouse-look.
 */
import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';

const WATER_LEVEL = 0.9;
const params = new URLSearchParams(location.search);
const HARNESS = params.get('harness') === '1';
const SESSION_INIT = { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'] };
const errors = [];
window.addEventListener('error', (e) => errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason && e.reason.message || e.reason)));

// ---------------------------------------------------------------- renderer / scene
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
renderer.xr.setFoveation(1);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x7fb8e6);
scene.fog = new THREE.Fog(0x7fb8e6, 15, 45);

const player = new THREE.Group();
player.name = 'player';
scene.add(player);
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 100);
camera.position.set(0, 1.6, 0);
player.add(camera);

scene.add(new THREE.HemisphereLight(0xffffff, 0x335577, 1.4));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(1, 3, 1.5);
scene.add(sun);

const grid = new THREE.GridHelper(40, 40, 0x1d3a5c, 0x2f5f8f);
scene.add(grid);

const water = new THREE.Mesh(
  new THREE.PlaneGeometry(40, 40),
  new THREE.MeshBasicMaterial({ color: 0x2266aa, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }),
);
water.rotation.x = -Math.PI / 2;
water.position.y = WATER_LEVEL;
water.renderOrder = 2;
scene.add(water);

const BOX_IDLE = 0x6a7f99;
const BOX_PINCH = 0xff8a3c;
const box = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), new THREE.MeshStandardMaterial({ color: BOX_IDLE, roughness: 0.6 }));
box.position.set(0, 1.15, -0.8);
scene.add(box);

// a few posts for depth cues
const postGeo = new THREE.CylinderGeometry(0.05, 0.05, 2.5, 8);
const postMat = new THREE.MeshStandardMaterial({ color: 0x8b6b4a });
for (const [x, z] of [[-3, -4], [3, -4], [-4, 3], [4, 3], [0, -8]]) {
  const post = new THREE.Mesh(postGeo, postMat);
  post.position.set(x, 1.25, z);
  scene.add(post);
}

// ---------------------------------------------------------------- hands (XR)
const handFactory = new XRHandModelFactory();
const hands = [];
for (let i = 0; i < 2; i++) {
  const hand = renderer.xr.getHand(i);
  const model = handFactory.createHandModel(hand, 'spheres');
  hand.add(model);
  player.add(hand);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.012, 12, 12), new THREE.MeshBasicMaterial({ color: 0x00ffff }));
  tip.visible = false;
  player.add(tip);
  const h = { index: i, hand, model, tip, handedness: null, connected: false, pinching: false, submerged: false };
  hand.addEventListener('connected', (event) => { h.handedness = event.data ? event.data.handedness : null; h.connected = true; });
  hand.addEventListener('disconnected', () => { h.connected = false; h.handedness = null; h.pinching = false; h.tip.visible = false; });
  hands.push(h);
}

function updateXRHands() {
  let anyPinch = false;
  for (const h of hands) {
    const joints = h.hand.joints;
    const indexTip = joints['index-finger-tip'];
    const thumbTip = joints['thumb-tip'];
    if (!h.hand.visible || !indexTip || !thumbTip || !indexTip.visible || !thumbTip.visible) {
      h.tip.visible = false;
      h.pinching = false;
      continue;
    }
    // raw joint read: the hand group is a child of the player rig, so joint.position is in rig space
    h.tip.visible = true;
    h.tip.position.copy(indexTip.position);
    const d = indexTip.position.distanceTo(thumbTip.position);
    if (!h.pinching && d < 0.02) h.pinching = true;
    else if (h.pinching && d > 0.035) h.pinching = false;
    anyPinch = anyPinch || h.pinching;
    let submerged = false;
    for (const name in joints) {
      const j = joints[name];
      if (j.visible && j.position.y < WATER_LEVEL) { submerged = true; break; }
    }
    h.submerged = submerged;
    const mc = h.model.motionController;
    if (mc && mc.handMesh) mc.handMesh.material.color.set(submerged ? 0x40e0ff : 0xf2f2f2);
  }
  return anyPinch;
}

// ---------------------------------------------------------------- desktop hand + look
const view = { yaw: 0, pitch: 0 };
const virtualHand = { x: 0.5, y: 0.5, pinch: false, submerged: false, active: false };
const vhand = new THREE.Mesh(new THREE.SphereGeometry(0.03, 16, 16), new THREE.MeshStandardMaterial({ color: 0xf2f2f2 }));
vhand.visible = false;
scene.add(vhand);
const _v = new THREE.Vector3();
const _cam = new THREE.Vector3();

function updateDesktopHand() {
  if (!virtualHand.active || renderer.xr.isPresenting) { vhand.visible = false; return false; }
  camera.getWorldPosition(_cam);
  _v.set(virtualHand.x * 2 - 1, 1 - virtualHand.y * 2, 0.5).unproject(camera);
  _v.sub(_cam).normalize().multiplyScalar(0.6).add(_cam);
  if (virtualHand.submerged) _v.y = Math.min(_v.y, WATER_LEVEL - 0.06);
  vhand.position.copy(_v);
  vhand.material.color.set(_v.y < WATER_LEVEL ? 0x40e0ff : 0xf2f2f2);
  vhand.visible = true;
  return virtualHand.pinch;
}

let dragging = false;
renderer.domElement.addEventListener('pointerdown', (e) => { dragging = true; virtualHand.active = true; virtualHand.pinch = e.button === 0; });
window.addEventListener('pointerup', () => { dragging = false; virtualHand.pinch = false; });
window.addEventListener('pointermove', (e) => {
  virtualHand.x = e.clientX / window.innerWidth;
  virtualHand.y = e.clientY / window.innerHeight;
  virtualHand.active = true;
  if (dragging) { view.yaw -= e.movementX * 0.2; view.pitch = THREE.MathUtils.clamp(view.pitch - e.movementY * 0.2, -89, 89); }
});
window.addEventListener('keydown', (e) => { if (e.key === 'Shift') virtualHand.submerged = true; });
window.addEventListener('keyup', (e) => { if (e.key === 'Shift') virtualHand.submerged = false; });
window.addEventListener('resize', () => {
  if (renderer.xr.isPresenting) return;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------- XR session
let session = null;
async function enterXR() {
  if (session) return;
  const s = await navigator.xr.requestSession('immersive-vr', SESSION_INIT);
  session = s;
  s.addEventListener('end', () => { if (session === s) session = null; });
  await renderer.xr.setSession(s);
}
async function exitXR() {
  if (!session) return;
  const s = session;
  const ended = new Promise((resolve) => {
    if (!renderer.xr.isPresenting) return resolve();
    renderer.xr.addEventListener('sessionend', resolve, { once: true });
  });
  await s.end();
  await ended;
}
document.body.appendChild(VRButton.createButton(renderer, SESSION_INIT));

// ---------------------------------------------------------------- loop
const hud = document.getElementById('hud');
let worldTime = 0;
let lastTime = null;
let fps = 0;
let energy = 0;
let firstFrame = true;
let resolveReady;
const ready = new Promise((resolve) => { resolveReady = resolve; });
let wasPinching = false;

renderer.setAnimationLoop((time) => {
  const dt = lastTime == null ? 1 / 72 : THREE.MathUtils.clamp((time - lastTime) / 1000, 0, 0.25);
  lastTime = time;
  worldTime += dt;
  if (dt > 0) fps = fps ? fps * 0.9 + (1 / dt) * 0.1 : 1 / dt;

  if (!renderer.xr.isPresenting) camera.rotation.set(THREE.MathUtils.degToRad(view.pitch), THREE.MathUtils.degToRad(view.yaw), 0, 'YXZ');

  const pinching = updateXRHands() | updateDesktopHand();
  if (pinching && !wasPinching) energy = Math.min(1, energy + 0.5);
  wasPinching = !!pinching;
  energy = Math.max(0, energy - 0.02 * dt);
  box.material.color.set(pinching ? BOX_PINCH : BOX_IDLE);
  box.rotation.y = worldTime * 0.5;
  box.position.y = 1.15 + Math.sin(worldTime * 1.5) * 0.03;

  renderer.render(scene, camera);

  if (firstFrame) { firstFrame = false; resolveReady(); }
  if (hud && (renderer.info.render.frame & 7) === 0) {
    hud.textContent = `fixture: minimal  t=${worldTime.toFixed(1)}  xr=${renderer.xr.isPresenting}  pinch=${!!pinching}  hands=${hands.filter((h) => h.hand.visible).length}`;
  }
});

// ---------------------------------------------------------------- contract
window.__nocturne = {
  ready,
  enterXR,
  exitXR,
  look(yawDeg, pitchDeg) {
    view.yaw = Number(yawDeg) || 0;
    view.pitch = THREE.MathUtils.clamp(Number(pitchDeg) || 0, -89, 89);
  },
  setHand({ x = 0.5, y = 0.5, pinch = false, submerged = false } = {}) {
    virtualHand.x = x; virtualHand.y = y; virtualHand.pinch = !!pinch; virtualHand.submerged = !!submerged; virtualHand.active = true;
  },
  setTime(seconds) { worldTime = Number(seconds) || 0; },
  stats() {
    return {
      frame: renderer.info.render.frame,
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      programs: renderer.info.programs ? renderer.info.programs.length : 0,
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
      fps: Math.round(fps),
      xr: renderer.xr.isPresenting,
      energy,
      errors: errors.slice(),
      harness: HARNESS,
      hands: hands.map((h) => ({ handedness: h.handedness, visible: h.hand.visible, pinching: h.pinching, submerged: h.submerged })),
    };
  },
};
