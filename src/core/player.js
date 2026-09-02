import * as THREE from 'three';
import { CONFIG } from '../config.js';

/**
 * The player rig: a Group that owns the camera and the hands. In XR the headset pose moves the
 * camera inside the rig; locomotion moves/rotates the rig. Handles:
 *  - height calibration (water at the waist standing, chest seated; the world never moves)
 *  - locomotion: pinch-and-pull only. A pinch with nothing in reach holds the world; once the palm has
 *    travelled a small dead zone (a missed grab never moves you) the rig follows the palm one-to-one,
 *    with momentum on release. Both hands pinched: the world also turns with the line between them.
 *  - the "leave" fade requested by the leave gesture (src/world/leave.js)
 *  - the comfort vignette (per-eye, in clip space), the opening fade and foveation while moving
 *  - ctx.calm (stillness of the whole body) for the modules that reward it
 *  - desktop mouse-look (right button / Q,E) and WASD fallback
 */
export function createPlayer(ctx) {
  const { player, camera, renderer } = ctx;
  const P = CONFIG.player;
  const vel = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const rightV = new THREE.Vector3();
  const headWorld = new THREE.Vector3();
  const prevHead = new THREE.Vector3();
  const headVel = new THREE.Vector3();
  const _v = new THREE.Vector3();

  let desktop = false;
  let yaw = 0, pitch = 0;
  const keys = new Set();
  let dragging = false, lastX = 0, lastY = 0;
  let calibrated = false;
  const calibSamples = [];
  let calibStart = 0;
  let eyeHeight = P.eyeHeightDesktop, seated = false, eyeEMA = 0, driftFor = 0, rigTargetY = 0;
  let speedSmooth = 0, yawSmooth = 0;
  let fade = 1, fadeStart = -1, fadeDur = 4, fadeDelay = 1.5; // black until a session or the desktop preview starts
  let foveation = 0.5;
  let calm = 0;
  // pinch-and-pull: the palm is the anchor (not the pinch point: fingertips jump a few centimetres when a pinch
  // opens, the palm does not). One hand → its palm; both hands → their midpoint, and the line between them turns.
  const pulls = { left: makePull(), right: makePull() };
  function makePull() { return { active: false, time: 0, start: new THREE.Vector3(), local: new THREE.Vector3() }; }
  const hold = { mode: 0, anchor: null, engaged: false, turning: false, time: 0, accum: 0, start: new THREE.Vector3(), prev: new THREE.Vector3(), cur: new THREE.Vector3(), line: new THREE.Vector2(), moveVel: new THREE.Vector3() };
  const rigVel = new THREE.Vector3();   // the rig's actual world velocity (pull, turn and glide), for the wave sim and drips
  const prevRig = new THREE.Vector3();
  const rigInv = new THREE.Matrix4();
  const pullDelta = new THREE.Vector3();
  const _l2 = new THREE.Vector2();
  let turnRate = 0;      // rad/s applied by a two-hand turn this frame (for the comfort vignette)
  let leaveFade = 0;     // 0..1, set by the leave gesture

  // ---- comfort vignette + opening fade (camera-attached quad; the radius is measured in clip space so it is
  // centred per eye and independent of the field of view)
  const vignette = new THREE.Mesh(
    new THREE.PlaneGeometry(4, 4),
    new THREE.ShaderMaterial({
      uniforms: { uStrength: { value: 0 }, uFull: { value: 1 } },
      vertexShader: `varying vec2 vNdc; void main(){ vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); vNdc = p.xy / p.w; gl_Position = p; }`,
      fragmentShader: `uniform float uStrength; uniform float uFull; varying vec2 vNdc;
        void main(){ float r = length(vNdc); float a = smoothstep(0.5, 1.15, r) * uStrength; a = max(a, uFull); gl_FragColor = vec4(0.0, 0.0, 0.0, a); }`,
      transparent: true, depthTest: false, depthWrite: false, fog: false,
    })
  );
  vignette.position.set(0, 0, -0.5);
  vignette.renderOrder = 1000;
  vignette.frustumCulled = false;
  camera.add(vignette);

  function beginFade(delay, dur) { if (ctx.harness) { delay = 0; dur = 0.05; } fadeStart = ctx.time.t; fadeDelay = delay; fadeDur = dur; fade = 1; }
  ctx.events.on('xrstart', () => { calibrated = false; calibSamples.length = 0; calibStart = ctx.time.t; vel.set(0, 0, 0); player.position.y = 0; player.rotation.set(0, 0, 0); beginFade(1.5, 4); });
  ctx.events.on('xrend', () => {
    leaveFade = 0; hold.mode = 0; hold.engaged = false; hold.turning = false;
    player.position.y = 0; player.rotation.set(0, 0, 0);
    camera.position.set(0, P.eyeHeightDesktop, 0);
    camera.fov = 75; camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
    applyLook();
  });
  ctx.events.on('desktopstart', () => beginFade(0.3, 2.2));

  function enableDesktop() {
    if (desktop) return;
    desktop = true;
    player.position.y = 0;
    camera.position.set(0, P.eyeHeightDesktop, 0);
    applyLook();
    const canvas = renderer.domElement;
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    // look: right/middle button drag (the left button is the hand's pinch), or Q/E
    canvas.addEventListener('pointerdown', (e) => { if (e.button !== 2 && e.button !== 1) return; dragging = true; lastX = e.clientX; lastY = e.clientY; canvas.setPointerCapture?.(e.pointerId); e.preventDefault(); });
    window.addEventListener('pointerup', () => { dragging = false; });
    window.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY; lastX = e.clientX; lastY = e.clientY;
      yaw -= dx * 0.0032; pitch = THREE.MathUtils.clamp(pitch - dy * 0.0032, -1.45, 1.45); applyLook();
    });
    window.addEventListener('keydown', (e) => { keys.add(e.code); });
    window.addEventListener('keyup', (e) => { keys.delete(e.code); });
    window.addEventListener('blur', () => keys.clear());
  }

  function look(yawDeg, pitchDeg) { yaw = THREE.MathUtils.degToRad(yawDeg); pitch = THREE.MathUtils.degToRad(pitchDeg); applyLook(); }
  function applyLook() { if (!renderer.xr.isPresenting) camera.rotation.set(pitch, yaw, 0, 'YXZ'); }

  function calibrate() {
    const hy = camera.position.y; // eye height above the real floor (rig-local)
    if (hy > 0.4 && hy < 2.6) calibSamples.push(hy);
    const elapsed = ctx.time.t - calibStart;
    if (calibSamples.length >= 12 && elapsed > 1.0) {
      const sorted = calibSamples.slice().sort((a, b) => a - b);
      eyeHeight = sorted[Math.floor(sorted.length / 2)];
      seated = eyeHeight < P.seatedEyeHeight;
      const above = seated ? P.headAboveWaterSeated : P.headAboveWaterStanding;
      rigTargetY = ctx.water.level + above - eyeHeight;
      player.position.y = rigTargetY;
      eyeEMA = eyeHeight;
      calibrated = true;
      ctx.seated = seated;
      ctx.events.emit('calibrated', { eyeHeight, seated, rigY: player.position.y });
    }
  }

  // if the user sits down / stands up, drift the rig slowly so the water never visibly rises
  function rebaseline(dt) {
    const hy = camera.position.y;
    if (hy < 0.4 || hy > 2.6) return;
    eyeEMA += (hy - eyeEMA) * Math.min(1, dt / 5);
    if (Math.abs(eyeEMA - eyeHeight) > 0.3) driftFor += dt; else driftFor = 0;
    if (driftFor > 5) {
      eyeHeight = eyeEMA; seated = eyeHeight < P.seatedEyeHeight; ctx.seated = seated;
      rigTargetY = ctx.water.level + (seated ? P.headAboveWaterSeated : P.headAboveWaterStanding) - eyeHeight;
      driftFor = 0;
    }
    if (Math.abs(player.position.y - rigTargetY) > 1e-4) player.position.y += (rigTargetY - player.position.y) * Math.min(1, dt / 15);
  }

  // yaw the rig about a vertical axis through a world point (the head, or the point the hands hold)
  function rotateRigAbout(pivot, angle) {
    _v.subVectors(player.position, pivot);
    _v.applyAxisAngle(THREE.Object3D.DEFAULT_UP, angle);
    player.position.copy(pivot).add(_v);
    player.rotation.y += angle;
    player.updateMatrixWorld(true);
  }
  function rotateRigAboutHead(angle) { camera.getWorldPosition(headWorld); rotateRigAbout(headWorld, angle); }
  const pivot = new THREE.Vector3();

  // Returns true while a hand holds the world (pinched with nothing in reach). Moving the rig only starts once
  // the anchor has left the dead zone, so a pinch that merely missed a lantern never shifts the view.
  function pulling(dt) {
    rigInv.copy(player.matrixWorld).invert();
    let nActive = 0;
    for (const h of ctx.hands.list) {
      const pl = pulls[h.handedness];
      const on = h.active && h.pinch.active && h.pinch.kind === 'pinch' && !h.grabbed;
      if (!on) { pl.active = false; continue; }
      pl.local.copy(h.palm.position).applyMatrix4(rigInv); pl.local.y = 0;   // rig-local, horizontal
      if (!pl.active) { pl.active = true; pl.time = 0; pl.start.copy(pl.local); } else pl.time += dt;
      nActive++;
    }
    const L = pulls.left, R = pulls.right;
    const mode = nActive === 2 ? 2 : nActive === 1 ? 1 : 0;
    turnRate = 0;
    pullDelta.set(0, 0, 0);
    // a hand-over-hand swap on one frame keeps mode 1 but changes the anchoring palm: treat it as a change of grip
    const anchor = mode === 1 ? (L.active ? L : R) : null;
    if (mode !== hold.mode || anchor !== hold.anchor) {
      // letting go (or changing grip) carries the momentum of the last engaged pull into a glide
      if (hold.engaged) vel.add(hold.moveVel);
      hold.mode = mode; hold.anchor = anchor; hold.engaged = false; hold.turning = false; hold.accum = 0; hold.time = 0; hold.moveVel.set(0, 0, 0);
      if (mode === 1) hold.cur.copy(L.active ? L.local : R.local);
      else if (mode === 2) { hold.cur.addVectors(L.local, R.local).multiplyScalar(0.5); hold.line.set(R.local.x - L.local.x, R.local.z - L.local.z); }
      hold.start.copy(hold.cur); hold.prev.copy(hold.cur);
      return mode > 0;
    }
    if (mode === 0) return false;
    hold.time += dt;
    if (mode === 1) hold.cur.copy(L.active ? L.local : R.local);
    else hold.cur.addVectors(L.local, R.local).multiplyScalar(0.5);
    if (!hold.engaged) {
      if (hold.time >= P.pullHoldTime && hold.cur.distanceTo(hold.start) >= P.pullDeadZone) hold.engaged = true;
      hold.prev.copy(hold.cur); // the dead zone is forgiven: motion counts from here, no catch-up jump
    }
    if (hold.engaged) {
      tmp.subVectors(hold.cur, hold.prev); hold.prev.copy(hold.cur);
      tmp.applyQuaternion(player.quaternion);                   // into world axes
      const step = Math.min(tmp.length(), P.pullMaxStep);
      if (step > 0) { tmp.setLength(step); player.position.sub(tmp); pullDelta.copy(tmp); }
      hold.moveVel.lerp(_v.set(-tmp.x / Math.max(dt, 1e-3), 0, -tmp.z / Math.max(dt, 1e-3)), Math.min(1, dt * 12));
      vel.set(0, 0, 0);                                          // while holding on, the world only moves with the hand
    } else {
      vel.multiplyScalar(Math.max(0, 1 - 8 * dt));               // taking hold eases a glide out
    }
    if (mode === 2) {
      // the world turns with the line between the hands (signed angle about +y, after its own dead zone)
      _l2.set(R.local.x - L.local.x, R.local.z - L.local.z);
      const dot = hold.line.x * _l2.x + hold.line.y * _l2.y;
      const crossY = hold.line.y * _l2.x - hold.line.x * _l2.y;
      // hands close together turn tracking jitter into yaw: the turn fades out below 25 cm of separation, and
      // sub-0.1° wobbles are ignored
      const sep = THREE.MathUtils.clamp(_l2.length() / 0.25, 0, 1);
      let d = THREE.MathUtils.clamp(Math.atan2(crossY, dot), -0.2, 0.2) * sep;
      if (Math.abs(d) < 0.0017) d = 0;
      hold.line.copy(_l2);
      if (!hold.turning) { hold.accum += d; if (hold.time >= P.pullHoldTime && Math.abs(hold.accum) >= THREE.MathUtils.degToRad(P.turnDeadZoneDeg)) hold.turning = true; }
      else if (Math.abs(d) > 1e-6) {
        // turn about the point the hands hold (their midpoint), so the world stays under the hands
        player.updateMatrixWorld(true);
        pivot.copy(hold.cur).applyMatrix4(player.matrixWorld);
        rotateRigAbout(pivot, -d);
        turnRate = d / Math.max(dt, 1e-3);
      }
    }
    return true;
  }

  function desktopMove(dt) {
    if (!desktop) return;
    camera.getWorldDirection(fwd); fwd.y = 0; fwd.normalize();
    const right = tmp.set(-fwd.z, 0, fwd.x);
    let mx = 0, mz = 0;
    if (keys.has('KeyW') || keys.has('ArrowUp')) mz += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) mz -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) mx += 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) mx -= 1;
    if (keys.has('KeyQ')) { yaw += 1.4 * dt; applyLook(); }
    if (keys.has('KeyE')) { yaw -= 1.4 * dt; applyLook(); }
    if (mx || mz) {
      const n = Math.hypot(mx, mz);
      vel.x += (fwd.x * mz + right.x * mx) / n * P.desktopSpeed * 3 * dt;
      vel.z += (fwd.z * mz + right.z * mx) / n * P.desktopSpeed * 3 * dt;
      const s = Math.hypot(vel.x, vel.z);
      if (s > P.desktopSpeed) { vel.x *= P.desktopSpeed / s; vel.z *= P.desktopSpeed / s; }
    }
  }

  function updateCalm(dt) {
    const headSpeed = Math.hypot(headVel.x, headVel.y, headVel.z);
    let handsStill = true;
    for (const h of ctx.hands.list) if (h.tracked && h.stillDisp > 0.05) handsStill = false;
    const still = headSpeed < 0.08 && handsStill && !hold.engaged && Math.hypot(vel.x, vel.z) < 0.05;
    calm = THREE.MathUtils.clamp(calm + (still ? 0.25 : -0.8) * dt, 0, 1);
    // the two-palm pose (both hands submerged and still) is a bonus
    const twoPalms = ctx.hands.list.every((h) => h.tracked && h.submerged && h.still);
    ctx.calm = calm;
    ctx.water.calm = Math.min(1, calm * 0.6 + (twoPalms ? 0.5 : 0) * calm);
  }

  function update(dt) {
    const presenting = renderer.xr.isPresenting;
    if (presenting) { if (!calibrated) calibrate(); else rebaseline(dt); }
    const held = (presenting || desktop) ? pulling(dt) : false;
    desktopMove(dt);

    // integrate with drag; the boundary is a cushion of drag rather than a wall
    const r0 = Math.hypot(player.position.x, player.position.z);
    const drag = P.drag + 6 * THREE.MathUtils.smoothstep(r0, P.radiusLimit - 4, P.radiusLimit);
    const damp = Math.max(0, 1 - drag * dt);
    vel.x *= damp; vel.z *= damp;
    { const sp = Math.hypot(vel.x, vel.z); if (sp > P.pullMaxSpeed) { vel.x *= P.pullMaxSpeed / sp; vel.z *= P.pullMaxSpeed / sp; } }
    if (Math.abs(vel.x) + Math.abs(vel.z) > 1e-4) {
      player.position.x += vel.x * dt;
      player.position.z += vel.z * dt;
      const r = Math.hypot(player.position.x, player.position.z);
      if (r > P.radiusLimit) { const k = P.radiusLimit / r; player.position.x *= k; player.position.z *= k; vel.multiplyScalar(0.5); }
    }
    player.updateMatrixWorld(true);
    // the rig's real world velocity this frame (a pull moves the rig without touching vel)
    if (ctx.time.frame > 1) rigVel.subVectors(player.position, prevRig).divideScalar(Math.max(dt, 1e-3)); else rigVel.set(0, 0, 0);
    prevRig.copy(player.position);
    if (rigVel.length() > 6) rigVel.setLength(6);
    // head velocity in world (for the wave sim / audio / calm)
    camera.getWorldPosition(headWorld);
    if (ctx.time.frame > 1) headVel.subVectors(headWorld, prevHead).divideScalar(Math.max(dt, 1e-3));
    prevHead.copy(headWorld);
    if (headVel.length() > 5) headVel.setLength(5);

    // motion for the comfort vignette: glide speed, or the hand's pull speed while holding on
    let speed = Math.hypot(vel.x, vel.z);
    const pullSpeed = hold.engaged ? Math.min(P.pullMaxSpeed, pullDelta.length() / Math.max(dt, 1e-3)) : 0;
    if (held) speed = Math.max(speed, pullSpeed);
    speedSmooth += (speed - speedSmooth) * Math.min(1, dt * 6);
    yawSmooth += (Math.abs(turnRate) - yawSmooth) * Math.min(1, dt * 6);
    const motion = Math.max(speedSmooth / P.maxSpeed, yawSmooth / P.turnRate);
    const strength = THREE.MathUtils.clamp(motion, 0, 1) * 0.85;
    // opening fade
    if (fadeStart >= 0) {
      const a = ctx.time.t - fadeStart - fadeDelay;
      fade = a < 0 ? 1 : THREE.MathUtils.clamp(1 - a / fadeDur, 0, 1);
      fade = fade * fade * (3 - 2 * fade);
      if (a > fadeDur) { fadeStart = -1; fade = 0; }
    }
    vignette.material.uniforms.uStrength.value = strength;
    const full = Math.max(fade, leaveFade);
    vignette.material.uniforms.uFull.value = full;
    vignette.visible = strength > 0.01 || full > 0.001;
    // foveation: relaxed at rest, full while gliding under the vignette
    const fov = motion > 0.25 ? 1.0 : 0.5;
    if (presenting && fov !== foveation) { foveation = fov; try { renderer.xr.setFoveation(fov); } catch { /* */ } }

    updateCalm(dt);

    state.speed = Math.hypot(vel.x, vel.z);
    state.pullSpeed = pullSpeed;
    state.holding = held;
    state.pulling = hold.engaged;
    state.turning = hold.turning;
    state.turnRate = turnRate;
    state.calibrated = calibrated;
    state.seated = seated;
    state.eyeHeight = eyeHeight;
  }

  function setLeave(v) { leaveFade = THREE.MathUtils.clamp(v || 0, 0, 1); }

  const state = { speed: 0, headWorld, headVelocity: headVel, calibrated: false, velocity: rigVel, seated: false, eyeHeight, holding: false, pulling: false, turning: false, turnRate: 0, pullSpeed: 0 };
  return { update, enableDesktop, look, setLeave, state, get velocity() { return rigVel; }, get calm() { return calm; } };
}
