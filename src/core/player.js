import * as THREE from 'three';
import { CONFIG } from '../config.js';

/**
 * The player rig: a Group that owns the camera and the hands. In XR the headset pose moves the
 * camera inside the rig; locomotion moves/rotates the rig. Handles:
 *  - height calibration (water at the waist standing, chest seated; the world never moves)
 *  - wading: a deliberate paddle stroke with a submerged, aligned palm glides you the other way;
 *    seated users get yaw from lateral strokes
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
  let speedSmooth = 0, yawSmooth = 0, yawRate = 0;
  let fade = 1, fadeStart = -1, fadeDur = 4, fadeDelay = 1.5; // black until a session or the desktop preview starts
  let foveation = 0.5;
  let calm = 0;
  const strokes = { left: makeStroke(), right: makeStroke() };
  function makeStroke() { return { active: false, path: 0, time: 0 }; }

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

  function rotateRigAboutHead(angle) {
    camera.getWorldPosition(headWorld);
    _v.subVectors(player.position, headWorld);
    _v.applyAxisAngle(THREE.Object3D.DEFAULT_UP, angle);
    player.position.copy(headWorld).add(_v);
    player.rotation.y += angle;
    player.updateMatrixWorld(true);
  }

  function wading(dt) {
    camera.getWorldDirection(fwd); fwd.y = 0; if (fwd.lengthSq() < 1e-6) return; fwd.normalize();
    rightV.set(-fwd.z, 0, fwd.x);
    camera.getWorldPosition(headWorld);
    const cosCone = Math.cos(THREE.MathUtils.degToRad(P.wadeConeDeg));
    yawRate = 0;
    for (const h of ctx.hands.list) {
      const s = strokes[h.handedness];
      const v = h.palm.velocityLocal;
      const speedH = Math.hypot(v.x, v.z);
      // a cupped paddling hand is fine; only a real pinch (holding something / pinching) disqualifies
      let ok = h.active && h.submergedDepth > P.strokeMinDepth && !(h.pinch.active && h.pinch.kind === 'pinch');
      let align = 0;
      if (ok && speedH > 0.05) {
        // palm must push the water: normal roughly along the (horizontal) motion; compare in world space
        _v.set(v.x, 0, v.z).applyQuaternion(player.quaternion).normalize();
        align = h.palm.normal.x * _v.x + h.palm.normal.z * _v.z;
        tmp.subVectors(h.palm.position, headWorld); tmp.y = 0; tmp.normalize();
        if (tmp.dot(fwd) < cosCone) ok = false; // hand hanging beside/behind the body: ignore
      }
      if (!s.active) {
        if (ok && speedH > P.wadeMinSpeed && align > P.strokeAlignOn) { s.active = true; s.path = 0; s.time = 0; }
      } else {
        if (!ok || speedH < P.strokeExitSpeed || align < P.strokeAlignOff) { s.active = false; continue; }
        s.path += speedH * dt; s.time += dt;
        if (s.path < P.strokeMinPath && s.time < P.strokeMinTime) continue;
        _v.set(v.x, 0, v.z).applyQuaternion(player.quaternion); // world-space hand velocity (rig-relative)
        const lateral = Math.abs(_v.x * rightV.x + _v.z * rightV.z) / Math.max(speedH, 1e-3);
        if (seated && lateral > 0.7) {
          // seated: a lateral stroke turns you instead of strafing (comfort: vignette follows yaw rate below)
          const rate = THREE.MathUtils.clamp(speedH * 0.6, 0, P.seatedYawRate) * Math.sign(_v.x * rightV.x + _v.z * rightV.z);
          rotateRigAboutHead(rate * dt);
          yawRate += rate;
        } else {
          const gain = P.wadeGain * THREE.MathUtils.clamp((speedH - P.wadeMinSpeed) / 0.6 + 0.4, 0.4, 1.2);
          vel.x -= _v.x * gain * dt;
          vel.z -= _v.z * gain * dt;
        }
      }
    }
    const sp = Math.hypot(vel.x, vel.z);
    if (sp > P.maxSpeed) { vel.x *= P.maxSpeed / sp; vel.z *= P.maxSpeed / sp; }
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
    let handsStill = true, anyStroke = false;
    for (const h of ctx.hands.list) {
      if (h.tracked && h.stillDisp > 0.05) handsStill = false;
      if (strokes[h.handedness].active) anyStroke = true;
    }
    const still = headSpeed < 0.08 && handsStill && !anyStroke && Math.hypot(vel.x, vel.z) < 0.05;
    calm = THREE.MathUtils.clamp(calm + (still ? 0.25 : -0.8) * dt, 0, 1);
    // the two-palm pose (both hands submerged and still) is a bonus
    const twoPalms = ctx.hands.list.every((h) => h.tracked && h.submerged && h.still);
    ctx.calm = calm;
    ctx.water.calm = Math.min(1, calm * 0.6 + (twoPalms ? 0.5 : 0) * calm);
  }

  function update(dt) {
    const presenting = renderer.xr.isPresenting;
    if (presenting) { if (!calibrated) calibrate(); else rebaseline(dt); }
    if (presenting || desktop) wading(dt);
    desktopMove(dt);

    // integrate with drag; the boundary is a cushion of drag rather than a wall
    const r0 = Math.hypot(player.position.x, player.position.z);
    const drag = P.drag + 6 * THREE.MathUtils.smoothstep(r0, P.radiusLimit - 4, P.radiusLimit);
    const damp = Math.max(0, 1 - drag * dt);
    vel.x *= damp; vel.z *= damp;
    if (Math.abs(vel.x) + Math.abs(vel.z) > 1e-4) {
      player.position.x += vel.x * dt;
      player.position.z += vel.z * dt;
      const r = Math.hypot(player.position.x, player.position.z);
      if (r > P.radiusLimit) { const k = P.radiusLimit / r; player.position.x *= k; player.position.z *= k; vel.multiplyScalar(0.5); }
    }
    player.updateMatrixWorld(true);
    // head velocity in world (for the wave sim / audio / calm)
    camera.getWorldPosition(headWorld);
    if (ctx.time.frame > 1) headVel.subVectors(headWorld, prevHead).divideScalar(Math.max(dt, 1e-3));
    prevHead.copy(headWorld);
    if (headVel.length() > 5) headVel.setLength(5);

    const speed = Math.hypot(vel.x, vel.z);
    speedSmooth += (speed - speedSmooth) * Math.min(1, dt * 6);
    yawSmooth += (Math.abs(yawRate) - yawSmooth) * Math.min(1, dt * 6);
    const motion = Math.max(speedSmooth / P.maxSpeed, yawSmooth / P.seatedYawRate);
    const strength = THREE.MathUtils.clamp(motion, 0, 1) * 0.85;
    // opening fade
    if (fadeStart >= 0) {
      const a = ctx.time.t - fadeStart - fadeDelay;
      fade = a < 0 ? 1 : THREE.MathUtils.clamp(1 - a / fadeDur, 0, 1);
      fade = fade * fade * (3 - 2 * fade);
      if (a > fadeDur) { fadeStart = -1; fade = 0; }
    }
    vignette.material.uniforms.uStrength.value = strength;
    vignette.material.uniforms.uFull.value = fade;
    vignette.visible = strength > 0.01 || fade > 0.001;
    // foveation: relaxed at rest, full while gliding under the vignette
    const fov = motion > 0.25 ? 1.0 : 0.5;
    if (presenting && fov !== foveation) { foveation = fov; try { renderer.xr.setFoveation(fov); } catch { /* */ } }

    updateCalm(dt);

    state.speed = speed;
    state.calibrated = calibrated;
    state.seated = seated;
    state.eyeHeight = eyeHeight;
    state.stroking = strokes.left.active || strokes.right.active;
  }

  const state = { speed: 0, headWorld, headVelocity: headVel, calibrated: false, velocity: vel, seated: false, eyeHeight, stroking: false };
  return { update, enableDesktop, look, state, get velocity() { return vel; }, get calm() { return calm; } };
}
