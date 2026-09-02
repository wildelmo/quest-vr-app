/**
 * fake-xr.js — a fake WebXR Device API for headless testing.
 *
 * Injected with `page.addInitScript()` BEFORE any page script runs (plain script,
 * no modules). It installs `navigator.xr` plus the XR* globals that Three.js r185's
 * WebXRManager / WebXRController (and the XRButton / VRButton / XRHandModelFactory
 * addons) touch, so the real VR code path — stereo XRWebGLLayer rendering into the
 * canvas, reference spaces, and two hand input sources with 25 animated joints —
 * runs end to end in headless Chromium.
 *
 * Control surface (see README.md):
 *   window.__fakeXR.clock        controllable timeline clock ('auto' | 'manual')
 *   window.__fakeXR.timeline     { fn(t) -> pose spec, duration }
 *   window.__fakeXR.setTimeline(fn, duration)
 *   window.__fakeXR.setHead([x,y,z], yawDeg, pitchDeg, rollDeg)
 *   window.__fakeXR.setHandPose('left'|'right', { position, yawDeg, pitchDeg, rollDeg, pinch, curl, spread, visible })
 *   window.__fakeXR.clearOverrides() / pause() / resume()
 *   window.__fakeXR.frames       frames delivered in the current session
 *   window.__fakeXR.getState()   summary of the last frame (head, joints, pinch distance)
 *
 * Conventions: WebXR right-handed metres, +Y up, -Z forward. The world frame is the
 * 'local-floor' frame (floor at y = 0). Right-hand local frame: wrist at the origin,
 * fingers along -Z, back of the hand +Y (palm faces -Y for a palm-down hand), thumb
 * on the -X side; the left hand is the X mirror. Joint orientation: -Z along the
 * bone toward the fingertip, +Y toward the back of the hand.
 *
 * This file logs nothing to the console except genuine errors.
 */
(function installFakeXR() {
  'use strict';
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return;
  const g = window;
  if (g.__fakeXR && g.__fakeXR.installed) return;

  const nativeRAF = g.requestAnimationFrame.bind(g);
  const nativeCAF = g.cancelAnimationFrame.bind(g);
  const perfNow = () => performance.now();

  // ------------------------------------------------------------------ math
  const DEG = Math.PI / 180;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const clamp01 = (v) => clamp(Number.isFinite(v) ? v : 0, 0, 1);
  const smooth = (t) => t * t * (3 - 2 * t);
  const lerp = (a, b, t) => a + (b - a) * t;

  const vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const vscale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const vlen = (a) => Math.hypot(a[0], a[1], a[2]);
  const vnorm = (a) => { const l = vlen(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const vlerp = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  const vdist = (a, b) => vlen(vsub(a, b));

  const qaxis = (axis, rad) => { const n = vnorm(axis), s = Math.sin(rad / 2); return [n[0] * s, n[1] * s, n[2] * s, Math.cos(rad / 2)]; };
  const qmul = (a, b) => [
    a[0] * b[3] + a[3] * b[0] + a[1] * b[2] - a[2] * b[1],
    a[1] * b[3] + a[3] * b[1] + a[2] * b[0] - a[0] * b[2],
    a[2] * b[3] + a[3] * b[2] + a[0] * b[1] - a[1] * b[0],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
  const qnorm = (q) => { const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; };
  const qrot = (q, v) => {
    const [qx, qy, qz, qw] = q; const [x, y, z] = v;
    const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
    return [x + qw * tx + (qy * tz - qz * ty), y + qw * ty + (qz * tx - qx * tz), z + qw * tz + (qx * ty - qy * tx)];
  };
  // yaw about +Y, then pitch about local +X (positive = look up), then roll about local +Z
  const qypr = (yawDeg = 0, pitchDeg = 0, rollDeg = 0) =>
    qmul(qmul(qaxis([0, 1, 0], (yawDeg || 0) * DEG), qaxis([1, 0, 0], (pitchDeg || 0) * DEG)), qaxis([0, 0, 1], (rollDeg || 0) * DEG));
  // quaternion from an orthonormal basis given as column vectors
  const qbasis = (X, Y, Z) => {
    const m11 = X[0], m12 = Y[0], m13 = Z[0], m21 = X[1], m22 = Y[1], m23 = Z[1], m31 = X[2], m32 = Y[2], m33 = Z[2];
    const trace = m11 + m22 + m33;
    let x, y, z, w, s;
    if (trace > 0) { s = 0.5 / Math.sqrt(trace + 1); w = 0.25 / s; x = (m32 - m23) * s; y = (m13 - m31) * s; z = (m21 - m12) * s; }
    else if (m11 > m22 && m11 > m33) { s = 2 * Math.sqrt(1 + m11 - m22 - m33); w = (m32 - m23) / s; x = 0.25 * s; y = (m12 + m21) / s; z = (m13 + m31) / s; }
    else if (m22 > m33) { s = 2 * Math.sqrt(1 + m22 - m11 - m33); w = (m13 - m31) / s; x = (m12 + m21) / s; y = 0.25 * s; z = (m23 + m32) / s; }
    else { s = 2 * Math.sqrt(1 + m33 - m11 - m22); w = (m21 - m12) / s; x = (m13 + m31) / s; y = (m23 + m32) / s; z = 0.25 * s; }
    return qnorm([x, y, z, w]);
  };
  // orientation whose -Z points along `forward` and whose +Y is as close as possible to `up`
  const qlook = (forward, up) => {
    const Z = vnorm(vscale(forward, -1));
    let X = vcross(up, Z);
    if (vlen(X) < 1e-5) X = vcross([0, 0, -1], Z);
    if (vlen(X) < 1e-5) X = vcross([1, 0, 0], Z);
    X = vnorm(X);
    const Y = vcross(Z, X);
    return qbasis(X, Y, Z);
  };

  const mident = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const mcompose = (p, q) => {
    const [x, y, z, w] = q;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
    const m = new Float32Array(16);
    m[0] = 1 - (yy + zz); m[1] = xy + wz; m[2] = xz - wy; m[3] = 0;
    m[4] = xy - wz; m[5] = 1 - (xx + zz); m[6] = yz + wx; m[7] = 0;
    m[8] = xz + wy; m[9] = yz - wx; m[10] = 1 - (xx + yy); m[11] = 0;
    m[12] = p[0]; m[13] = p[1]; m[14] = p[2]; m[15] = 1;
    return m;
  };
  const mmul = (a, b) => {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
    }
    return o;
  };
  // inverse of a rigid (rotation + translation) transform
  const minvRigid = (m) => {
    const o = new Float32Array(16);
    o[0] = m[0]; o[1] = m[4]; o[2] = m[8]; o[3] = 0;
    o[4] = m[1]; o[5] = m[5]; o[6] = m[9]; o[7] = 0;
    o[8] = m[2]; o[9] = m[6]; o[10] = m[10]; o[11] = 0;
    o[12] = -(o[0] * m[12] + o[4] * m[13] + o[8] * m[14]);
    o[13] = -(o[1] * m[12] + o[5] * m[13] + o[9] * m[14]);
    o[14] = -(o[2] * m[12] + o[6] * m[13] + o[10] * m[14]);
    o[15] = 1;
    return o;
  };
  const mdecompose = (m) => {
    const p = [m[12], m[13], m[14]];
    const X = vnorm([m[0], m[1], m[2]]), Y = vnorm([m[4], m[5], m[6]]), Z = vnorm([m[8], m[9], m[10]]);
    return { position: p, orientation: qbasis(X, Y, Z) };
  };
  const mperspective = (fovYRad, aspect, near, far) => {
    const f = 1 / Math.tan(fovYRad / 2);
    const m = new Float32Array(16);
    m[0] = f / aspect; m[5] = f; m[11] = -1;
    if (Number.isFinite(far)) { m[10] = (far + near) / (near - far); m[14] = (2 * far * near) / (near - far); }
    else { m[10] = -1; m[14] = -2 * near; }
    return m;
  };

  const toVec = (v, fallback) => {
    if (Array.isArray(v) && v.length >= 3) return [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0];
    if (v && typeof v === 'object' && 'x' in v) return [Number(v.x) || 0, Number(v.y) || 0, Number(v.z) || 0];
    return fallback.slice();
  };
  const domPoint = (x, y, z, w) => (typeof DOMPointReadOnly === 'function' ? new DOMPointReadOnly(x, y, z, w) : Object.freeze({ x, y, z, w }));
  const domErr = (msg, name) => new DOMException(msg, name);

  // ------------------------------------------------------------------ public state
  const config = {
    framebufferWidth: 1600,          // XRWebGLLayer size (both eyes side by side); null = canvas drawing buffer
    framebufferHeight: 800,
    fovDeg: 90,                      // per-eye symmetric field of view (vertical; horizontal follows the viewport aspect)
    ipd: 0.064,                      // metres between the eyes
    inputSourceDelayFrames: 2,       // hands connect on this frame of the session
    frameRate: 72,
    supportedFrameRates: [72, 90],
    strictFeatures: false,           // true = hands/local-floor only when the app asked for the features
    handProfiles: ['generic-hand', 'generic-trigger'],
    selectStartDistance: 0.015,      // pinch distance that fires selectstart
    selectEndDistance: 0.03,         // pinch distance that fires selectend/select
    boundsHalfSize: 1.5,             // bounded-floor bounds geometry (square, metres)
  };

  const clock = {
    mode: 'auto',   // 'auto' = wall clock × rate; 'manual' = += step every frame
    rate: 1,
    step: 1 / 72,
    time: 0,        // timeline seconds since session start
    paused: false,
    _lastRaf: null,
    _first: true,
    set(t) { this.time = Math.max(0, Number(t) || 0); },
    advance(dt) { this.time += Number(dt) || 0; },
    pause() { this.paused = true; },
    resume() { this.paused = false; },
    reset() { this.time = 0; this._lastRaf = null; this._first = true; },
    _tick(rafTime) {
      if (this._first) { this._first = false; this._lastRaf = rafTime; return; }
      if (!this.paused) {
        if (this.mode === 'manual') this.time += this.step;
        else if (this._lastRaf != null) this.time += ((rafTime - this._lastRaf) / 1000) * this.rate;
      }
      this._lastRaf = rafTime;
    },
  };

  const warnings = [];
  const warn = (msg) => { if (!warnings.includes(msg)) warnings.push(msg); };
  const report = (err) => {
    // surface exceptions from the app's frame callbacks like a real rAF would (uncaught → pageerror)
    if (typeof g.reportError === 'function') g.reportError(err);
    else setTimeout(() => { throw err; }, 0);
  };

  // ------------------------------------------------------------------ hand skeleton
  const JOINT_NAMES = [
    'wrist',
    'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip',
    'index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip',
    'middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip',
    'ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip',
    'pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip',
  ];
  const J = {}; JOINT_NAMES.forEach((n, i) => { J[n] = i; });
  const WRIST_RADIUS = 0.02;
  // Right hand, palm down, fingers along -Z, thumb toward -X. Lengths in metres.
  const FINGERS = [
    { name: 'thumb', first: J['thumb-metacarpal'], base: [-0.024, -0.006, -0.022], lengths: [0.046, 0.032, 0.028],
      radii: [0.014, 0.012, 0.010, 0.009], restDirs: [[-0.72, -0.30, -0.63], [-0.55, -0.20, -0.81], [-0.38, -0.14, -0.91]] },
    { name: 'index', first: J['index-finger-metacarpal'], base: [-0.028, 0.000, -0.030], lengths: [0.062, 0.040, 0.026, 0.023],
      radii: [0.013, 0.011, 0.0095, 0.0085, 0.0075], abduct: 12, bends: [0.05, 1.2, 1.5, 1.0] },
    { name: 'middle', first: J['middle-finger-metacarpal'], base: [-0.009, 0.002, -0.031], lengths: [0.066, 0.044, 0.028, 0.024],
      radii: [0.013, 0.011, 0.0095, 0.0085, 0.0075], abduct: 3, bends: [0.05, 1.2, 1.5, 1.0] },
    { name: 'ring', first: J['ring-finger-metacarpal'], base: [0.010, 0.001, -0.030], lengths: [0.060, 0.040, 0.026, 0.022],
      radii: [0.012, 0.010, 0.009, 0.008, 0.0075], abduct: -5, bends: [0.05, 1.2, 1.5, 1.0] },
    { name: 'pinky', first: J['pinky-finger-metacarpal'], base: [0.028, -0.002, -0.027], lengths: [0.054, 0.032, 0.020, 0.020],
      radii: [0.011, 0.009, 0.008, 0.0075, 0.007], abduct: -14, bends: [0.05, 1.2, 1.5, 1.0] },
  ];

  /** Local-frame skeleton for a right hand. Returns { P: [25][3], R: [25], Q: [25][4] }. */
  function skeletonLocal(spec, mirror) {
    const pinch = clamp01(spec.pinch), curl = clamp01(spec.curl), spread = clamp01(spec.spread);
    const P = new Array(25), R = new Array(25), D = new Array(25);
    P[0] = [0, 0, 0]; R[0] = WRIST_RADIUS;
    for (const f of FINGERS) {
      let pos = f.base.slice();
      P[f.first] = pos;
      R[f.first] = f.radii[0];
      if (f.name === 'thumb') {
        const qOpp = qmul(qaxis([0, 1, 0], -pinch * 50 * DEG), qaxis([1, 0, 0], -pinch * 15 * DEG));
        for (let s = 0; s < f.lengths.length; s++) {
          const dir = qrot(qOpp, vnorm(f.restDirs[s]));
          D[f.first + s] = dir;
          pos = vadd(pos, vscale(dir, f.lengths[s]));
          P[f.first + s + 1] = pos;
          R[f.first + s + 1] = f.radii[s + 1];
        }
        D[f.first + f.lengths.length] = D[f.first + f.lengths.length - 1];
      } else {
        const fingerCurl = f.name === 'index' ? clamp01(curl + 0.55 * pinch) : clamp01(curl + 0.1 * pinch);
        const abd = (spread - 0.5) * 2 * f.abduct * DEG;
        const qAbd = qaxis([0, 1, 0], abd);
        let dir = qrot(qAbd, [0, 0, -1]);
        const lateral = qrot(qAbd, [1, 0, 0]);
        for (let s = 0; s < f.lengths.length; s++) {
          dir = qrot(qaxis(lateral, -f.bends[s] * fingerCurl), dir);
          D[f.first + s] = dir;
          pos = vadd(pos, vscale(dir, f.lengths[s]));
          P[f.first + s + 1] = pos;
          R[f.first + s + 1] = f.radii[s + 1];
        }
        D[f.first + f.lengths.length] = dir;
      }
    }
    // pinch: drag thumb and index chains so the tips meet at a common point
    if (pinch > 0) {
      const k = smooth(pinch);
      const tt = J['thumb-tip'], it = J['index-finger-tip'];
      const mid = vlerp(P[tt], P[it], 0.5);
      const dragT = vscale(vsub(mid, P[tt]), k), dragI = vscale(vsub(mid, P[it]), k);
      const wT = [0, 0.15, 0.55, 1.0], wI = [0, 0.1, 0.35, 0.7, 1.0];
      for (let s = 0; s < 4; s++) P[J['thumb-metacarpal'] + s] = vadd(P[J['thumb-metacarpal'] + s], vscale(dragT, wT[s]));
      for (let s = 0; s < 5; s++) P[J['index-finger-metacarpal'] + s] = vadd(P[J['index-finger-metacarpal'] + s], vscale(dragI, wI[s]));
      // recompute bone directions from the moved positions
      for (const f of [FINGERS[0], FINGERS[1]]) {
        const n = f.lengths.length;
        for (let s = 0; s < n; s++) D[f.first + s] = vnorm(vsub(P[f.first + s + 1], P[f.first + s]));
        D[f.first + n] = D[f.first + n - 1];
      }
    }
    D[0] = vnorm(vsub(P[J['middle-finger-phalanx-proximal']], P[0]));
    if (mirror) {
      for (let i = 0; i < 25; i++) { P[i] = [-P[i][0], P[i][1], P[i][2]]; D[i] = [-D[i][0], D[i][1], D[i][2]]; }
    }
    const Q = new Array(25);
    for (let i = 0; i < 25; i++) Q[i] = qlook(D[i], [0, 1, 0]);
    return { P, R, Q };
  }

  // ------------------------------------------------------------------ timeline
  const REST_HEAD = { position: [0, 1.6, 0], yawDeg: 0, pitchDeg: 0, rollDeg: 0 };
  const restHand = (h) => ({ position: [h === 'left' ? -0.25 : 0.25, 0.9, -0.3], yawDeg: 0, pitchDeg: 0, rollDeg: 0, pinch: 0, curl: 0.15, spread: 0.5, visible: true });

  function defaultRight(t) {
    const s = (t0, t1) => smooth(clamp01((t - t0) / (t1 - t0)));
    const lin = (t0, t1) => clamp01((t - t0) / (t1 - t0));
    let p = [0.25, 0.9, -0.3], pitch = 0, roll = 0, pinch = 0, curl = 0.15;
    if (t < 2) { /* rest by the hips */ }
    else if (t < 5) { p = vlerp([0.25, 0.9, -0.3], [0.25, 1.2, -0.45], s(2, 5)); curl = 0.15 - 0.05 * s(2, 5); }
    else if (t < 6) { p = vlerp([0.25, 1.2, -0.45], [0.3, 0.6, -0.45], s(5, 6)); pitch = -20 * s(5, 6); curl = 0.1; }
    else if (t < 7.5) { p = [0.3 - 0.6 * lin(6, 7.5), 0.6, -0.45]; pitch = -20; curl = 0.1; }          // sweep at 0.4 m/s
    else if (t < 9) { p = [-0.3 + 0.6 * lin(7.5, 9), 0.6, -0.45]; pitch = -20; curl = 0.1; }           // sweep back
    else if (t < 10) { p = vlerp([0.3, 0.6, -0.45], [0.25, 1.15, -0.45], s(9, 10)); pitch = -20 * (1 - s(9, 10)); curl = 0.1; }
    else if (t < 12) { p = [0.25, 1.15, -0.45]; pinch = s(10, 10.5); curl = 0.1; }
    else if (t < 13) { p = vlerp([0.25, 1.15, -0.45], [0.25, 1.3, -0.4], s(12, 13)); pinch = 1 - s(12, 12.5); roll = 180 * s(12, 13); curl = 0.1 - 0.08 * s(12, 13); }
    else { p = [0.25, 1.3, -0.4]; roll = 180; curl = 0.02; }
    return { position: p, yawDeg: 0, pitchDeg: pitch, rollDeg: roll, pinch, curl, spread: 0.5, visible: true };
  }
  const HEAD_PITCH_KEYS = [[0, -30], [5, -30], [6, -40], [9, -40], [10, -30], [12, -30], [13, -25], [1e9, -25]];
  function headPitch(t) {
    for (let i = 1; i < HEAD_PITCH_KEYS.length; i++) {
      const [t0, a] = HEAD_PITCH_KEYS[i - 1], [t1, b] = HEAD_PITCH_KEYS[i];
      if (t <= t1) return lerp(a, b, smooth(clamp01((t - t0) / (t1 - t0))));
    }
    return HEAD_PITCH_KEYS[HEAD_PITCH_KEYS.length - 1][1];
  }
  function defaultTimeline(t) {
    const right = defaultRight(t);
    const l0 = defaultRight(Math.max(0, t - 1));
    const left = { ...l0, position: [-l0.position[0], Math.max(l0.position[1], 1.0), l0.position[2]], rollDeg: -l0.rollDeg };
    return {
      head: { position: [0, 1.6, 0], yawDeg: 5 * Math.sin((2 * Math.PI * t) / 8), pitchDeg: headPitch(t), rollDeg: 0 },
      left,
      right,
    };
  }

  const timeline = { fn: defaultTimeline, duration: 15, name: 'default' };
  const overrides = { head: null, left: null, right: null };

  function normHead(spec, base) {
    if (!spec) return base;
    return {
      position: toVec(spec.position, base.position),
      yawDeg: Number.isFinite(spec.yawDeg) ? spec.yawDeg : base.yawDeg,
      pitchDeg: Number.isFinite(spec.pitchDeg) ? spec.pitchDeg : base.pitchDeg,
      rollDeg: Number.isFinite(spec.rollDeg) ? spec.rollDeg : base.rollDeg,
    };
  }
  function normHand(spec, base) {
    if (!spec) return base;
    const out = { ...base, position: toVec(spec.position, base.position) };
    for (const k of ['yawDeg', 'pitchDeg', 'rollDeg', 'pinch', 'curl', 'spread']) if (Number.isFinite(spec[k])) out[k] = spec[k];
    if (typeof spec.pinch === 'boolean') out.pinch = spec.pinch ? 1 : 0;
    if (typeof spec.visible === 'boolean') out.visible = spec.visible;
    return out;
  }

  /** Compute everything a frame needs (world-space matrices) for timeline time t. */
  function computeFrameState(t) {
    let spec;
    try { spec = timeline.fn(t) || {}; }
    catch (err) {
      console.error('[fake-xr] timeline function threw; reverting to the default timeline.', err);
      timeline.fn = defaultTimeline; timeline.name = 'default';
      spec = defaultTimeline(t);
    }
    const head = normHead(overrides.head, normHead(spec.head, REST_HEAD));
    const headQ = qypr(head.yawDeg, head.pitchDeg, head.rollDeg);
    const headM = mcompose(head.position, headQ);
    const hands = {};
    for (const h of ['left', 'right']) {
      const hs = normHand(overrides[h], normHand(spec[h], restHand(h)));
      const handQ = qypr(hs.yawDeg, hs.pitchDeg, hs.rollDeg);
      const sk = skeletonLocal(hs, h === 'left');
      const joints = new Array(25);
      for (let i = 0; i < 25; i++) {
        const p = vadd(hs.position, qrot(handQ, sk.P[i]));
        const q = qmul(handQ, sk.Q[i]);
        joints[i] = { position: p, orientation: q, radius: sk.R[i], matrix: mcompose(p, q) };
      }
      hands[h] = {
        tracked: hs.visible !== false,
        spec: hs,
        joints,
        grip: mcompose(joints[J.wrist].position, handQ),
        targetRay: mcompose(joints[J['index-finger-metacarpal']].position, handQ),
        pinchDistance: vdist(joints[J['thumb-tip']].position, joints[J['index-finger-tip']].position),
      };
    }
    return { time: t, head: { spec: head, position: head.position, orientation: headQ, matrix: headM }, hands };
  }

  // ------------------------------------------------------------------ WebXR classes
  class XRRigidTransform {
    constructor(position, orientation) {
      const p = position || {};
      const o = orientation || {};
      const px = Number(p.x ?? 0), py = Number(p.y ?? 0), pz = Number(p.z ?? 0);
      let ox = Number(o.x ?? 0), oy = Number(o.y ?? 0), oz = Number(o.z ?? 0), ow = Number(o.w ?? 1);
      if (![px, py, pz, ox, oy, oz, ow].every(Number.isFinite)) throw new TypeError('XRRigidTransform: non-finite value');
      if (p.w !== undefined && Number(p.w) !== 1) throw new TypeError('XRRigidTransform: position.w must be 1');
      const l = Math.hypot(ox, oy, oz, ow);
      if (l === 0) throw domErr('XRRigidTransform: orientation has zero length', 'InvalidStateError');
      ox /= l; oy /= l; oz /= l; ow /= l;
      this._p = domPoint(px, py, pz, 1);
      this._o = domPoint(ox, oy, oz, ow);
      this._m = null;
      this._inv = null;
    }
    static _fromMatrix(m) {
      const d = mdecompose(m);
      const t = new XRRigidTransform({ x: d.position[0], y: d.position[1], z: d.position[2] }, { x: d.orientation[0], y: d.orientation[1], z: d.orientation[2], w: d.orientation[3] });
      t._m = new Float32Array(m);
      return t;
    }
    get position() { return this._p; }
    get orientation() { return this._o; }
    get matrix() {
      if (!this._m) this._m = mcompose([this._p.x, this._p.y, this._p.z], [this._o.x, this._o.y, this._o.z, this._o.w]);
      return this._m;
    }
    get inverse() {
      if (!this._inv) { this._inv = XRRigidTransform._fromMatrix(minvRigid(this.matrix)); this._inv._inv = this; }
      return this._inv;
    }
  }

  class XRSpace extends EventTarget {
    constructor(session, resolver) { super(); this._session = session; this._resolver = resolver; }
    /** world-space matrix of this space's origin for the given frame state, or null when untracked */
    _world(state) { return this._resolver ? this._resolver(state) : null; }
  }

  const REFERENCE_SPACE_TYPES = ['viewer', 'local', 'local-floor', 'bounded-floor', 'unbounded'];
  class XRReferenceSpace extends XRSpace {
    constructor(session, type, offset) {
      super(session, null);
      this._type = type;
      this._offset = offset || mident();
      this._onreset = null;
    }
    _world(state) {
      let base;
      if (this._type === 'viewer') base = state.head.matrix;
      else if (this._type === 'local') base = this._session._localOrigin || mident();
      else base = mident();
      return mmul(base, this._offset);
    }
    getOffsetReferenceSpace(originOffset) {
      if (!(originOffset instanceof XRRigidTransform)) throw new TypeError('getOffsetReferenceSpace: argument must be an XRRigidTransform');
      const offset = mmul(this._offset, originOffset.matrix);
      const space = this._type === 'bounded-floor' ? new XRBoundedReferenceSpace(this._session, this._type, offset) : new XRReferenceSpace(this._session, this._type, offset);
      return space;
    }
    get onreset() { return this._onreset; }
    set onreset(fn) { if (this._onreset) this.removeEventListener('reset', this._onreset); this._onreset = typeof fn === 'function' ? fn : null; if (this._onreset) this.addEventListener('reset', this._onreset); }
  }
  class XRBoundedReferenceSpace extends XRReferenceSpace {
    get boundsGeometry() {
      const s = config.boundsHalfSize;
      return Object.freeze([domPoint(-s, 0, -s, 1), domPoint(s, 0, -s, 1), domPoint(s, 0, s, 1), domPoint(-s, 0, s, 1)]);
    }
  }

  class XRJointSpace extends XRSpace {
    constructor(session, handedness, jointName, index) {
      super(session, (state) => { const h = state.hands[handedness]; return h && h.tracked ? h.joints[index].matrix : null; });
      this._jointName = jointName;
      this._index = index;
      this._handedness = handedness;
    }
    get jointName() { return this._jointName; }
    _radius(state) { const h = state.hands[this._handedness]; return h && h.tracked ? h.joints[this._index].radius : null; }
  }

  class XRHand {
    constructor(session, handedness) {
      this._map = new Map(JOINT_NAMES.map((name, i) => [name, new XRJointSpace(session, handedness, name, i)]));
    }
    get size() { return this._map.size; }
    get(name) { return this._map.get(name); }
    has(name) { return this._map.has(name); }
    keys() { return this._map.keys(); }
    values() { return this._map.values(); }
    entries() { return this._map.entries(); }
    forEach(cb, thisArg) { this._map.forEach((v, k) => cb.call(thisArg, v, k, this)); }
    [Symbol.iterator]() { return this._map.entries(); }
  }

  class XRInputSource {
    constructor(session, handedness) {
      this._session = session;
      this._handedness = handedness;
      this._targetRaySpace = new XRSpace(session, (state) => { const h = state.hands[handedness]; return h && h.tracked ? h.targetRay : null; });
      this._gripSpace = new XRSpace(session, (state) => { const h = state.hands[handedness]; return h && h.tracked ? h.grip : null; });
      this._hand = new XRHand(session, handedness);
      this._profiles = Object.freeze(config.handProfiles.slice());
      this._selecting = false;
    }
    get handedness() { return this._handedness; }
    get targetRayMode() { return 'tracked-pointer'; }
    get targetRaySpace() { return this._targetRaySpace; }
    get gripSpace() { return this._gripSpace; }
    get profiles() { return this._profiles; }
    get gamepad() { return null; }
    get hand() { return this._hand; }
    get skipRendering() { return false; }
  }

  class XRPose {
    constructor(transform, emulatedPosition = false) { this._t = transform; this._e = emulatedPosition; }
    get transform() { return this._t; }
    get emulatedPosition() { return this._e; }
    get linearVelocity() { return null; }
    get angularVelocity() { return null; }
  }
  class XRJointPose extends XRPose {
    constructor(transform, radius) { super(transform, false); this._r = radius; }
    get radius() { return this._r; }
  }
  class XRView {
    constructor(session, eye, projectionMatrix, transform) { this._session = session; this._eye = eye; this._proj = projectionMatrix; this._t = transform; }
    get eye() { return this._eye; }
    get projectionMatrix() { return this._proj; }
    get transform() { return this._t; }
    get recommendedViewportScale() { return null; }
    get isFirstPersonObserver() { return false; }
    get camera() { return null; }
    requestViewportScale(/* scale */) {}
  }
  class XRViewerPose extends XRPose {
    constructor(transform, views) { super(transform, false); this._views = Object.freeze(views); }
    get views() { return this._views; }
  }
  class XRViewport {
    constructor(x, y, width, height) { this._x = x; this._y = y; this._w = width; this._h = height; }
    get x() { return this._x; }
    get y() { return this._y; }
    get width() { return this._w; }
    get height() { return this._h; }
  }

  class XRRenderState {
    constructor(init) {
      this._depthNear = init.depthNear;
      this._depthFar = init.depthFar;
      this._inlineVerticalFieldOfView = init.inlineVerticalFieldOfView;
      this._baseLayer = init.baseLayer;
      // deliberately NO `layers` property → Three.js takes the XRWebGLLayer path
    }
    get depthNear() { return this._depthNear; }
    get depthFar() { return this._depthFar; }
    get inlineVerticalFieldOfView() { return this._inlineVerticalFieldOfView; }
    get baseLayer() { return this._baseLayer; }
    get passthroughFullyObscured() { return undefined; }
  }

  const isWebGL = (ctx) => (g.WebGL2RenderingContext && ctx instanceof g.WebGL2RenderingContext) || (g.WebGLRenderingContext && ctx instanceof g.WebGLRenderingContext);

  class XRWebGLLayer {
    constructor(session, context, layerInit = {}) {
      if (!(session instanceof XRSession)) throw new TypeError('XRWebGLLayer: first argument must be an XRSession');
      if (session._ended) throw domErr('XRWebGLLayer: session has ended', 'InvalidStateError');
      if (!isWebGL(context)) throw new TypeError('XRWebGLLayer: second argument must be a WebGL or WebGL2 rendering context');
      const scale = clamp(Number(layerInit.framebufferScaleFactor ?? 1) || 1, 0.2, 4);
      const baseW = config.framebufferWidth || context.drawingBufferWidth || 1600;
      const baseH = config.framebufferHeight || context.drawingBufferHeight || 800;
      this._session = session;
      this._context = context;
      this._antialias = layerInit.antialias !== undefined ? !!layerInit.antialias : true;
      this._w = Math.max(2, Math.round(baseW * scale));
      this._h = Math.max(2, Math.round(baseH * scale));
      this.fixedFoveation = 0;   // writable, like the Quest browser exposes it
    }
    get antialias() { return this._antialias; }
    get ignoreDepthValues() { return false; }
    get framebuffer() { return null; }          // null = the context's default framebuffer (the canvas)
    get framebufferWidth() { return this._w; }
    get framebufferHeight() { return this._h; }
    get context() { return this._context; }
    getViewport(view) {
      if (!(view instanceof XRView)) throw new TypeError('getViewport: argument must be an XRView');
      if (view._session !== this._session) throw domErr('getViewport: view belongs to another session', 'InvalidStateError');
      const half = Math.floor(this._w / 2);
      if (view.eye === 'left') return new XRViewport(0, 0, half, this._h);
      if (view.eye === 'right') return new XRViewport(half, 0, this._w - half, this._h);
      return new XRViewport(0, 0, this._w, this._h);
    }
    static getNativeFramebufferScaleFactor(/* session */) { return 1; }
  }

  class XRFrame {
    constructor(session, state, time) { this._session = session; this._state = state; this._time = time; }
    get session() { return this._session; }
    get predictedDisplayTime() { return this._time; }
    get trackedAnchors() { return undefined; }
    get detectedPlanes() { return undefined; }
    _check(space, what) {
      if (!(space instanceof XRSpace)) throw new TypeError(`${what}: argument must be an XRSpace`);
      if (space._session !== this._session) throw domErr(`${what}: space belongs to another session`, 'InvalidStateError');
    }
    getViewerPose(referenceSpace) {
      if (!(referenceSpace instanceof XRReferenceSpace)) {
        if (referenceSpace == null) return null;
        throw new TypeError('getViewerPose: argument must be an XRReferenceSpace');
      }
      if (referenceSpace._session !== this._session || this._session._ended) return null;
      const st = this._state;
      const base = referenceSpace._world(st);
      if (!base) return null;
      const invBase = minvRigid(base);
      const headInRef = mmul(invBase, st.head.matrix);
      const rs = this._session._renderState;
      const near = rs.depthNear, far = rs.depthFar;
      const views = [];
      if (this._session._mode === 'inline') {
        const canvas = rs.baseLayer ? rs.baseLayer.context.canvas : null;
        const aspect = canvas && canvas.height ? canvas.width / canvas.height : 2;
        views.push(new XRView(this._session, 'none', mperspective(rs.inlineVerticalFieldOfView || Math.PI / 2, aspect, near, far), XRRigidTransform._fromMatrix(headInRef)));
      } else {
        const layer = rs.baseLayer;
        const w = layer ? layer.framebufferWidth : config.framebufferWidth, h = layer ? layer.framebufferHeight : config.framebufferHeight;
        const aspect = (w / 2) / h;
        const proj = mperspective(config.fovDeg * DEG, aspect, near, far);
        for (const [eye, sign] of [['left', -1], ['right', 1]]) {
          const eyeM = mmul(headInRef, mcompose([sign * config.ipd / 2, 0, 0], [0, 0, 0, 1]));
          views.push(new XRView(this._session, eye, proj, XRRigidTransform._fromMatrix(eyeM)));
        }
      }
      return new XRViewerPose(XRRigidTransform._fromMatrix(headInRef), views);
    }
    _relative(space, baseSpace) {
      const sm = space._world(this._state);
      const bm = baseSpace._world(this._state);
      if (!sm || !bm) return null;
      return mmul(minvRigid(bm), sm);
    }
    getPose(space, baseSpace) {
      this._check(space, 'getPose'); this._check(baseSpace, 'getPose');
      if (this._session._ended) return null;
      const m = this._relative(space, baseSpace);
      return m ? new XRPose(XRRigidTransform._fromMatrix(m), false) : null;
    }
    getJointPose(jointSpace, baseSpace) {
      if (!(jointSpace instanceof XRJointSpace)) throw new TypeError('getJointPose: first argument must be an XRJointSpace');
      this._check(baseSpace, 'getJointPose');
      if (this._session._ended) return null;
      const m = this._relative(jointSpace, baseSpace);
      if (!m) return null;
      return new XRJointPose(XRRigidTransform._fromMatrix(m), jointSpace._radius(this._state));
    }
    fillPoses(spaces, baseSpace, transforms) {
      const list = Array.from(spaces);
      this._check(baseSpace, 'fillPoses');
      if (!(transforms instanceof Float32Array) || transforms.length < list.length * 16) throw new TypeError('fillPoses: transforms array is too small');
      let all = true;
      for (let i = 0; i < list.length; i++) {
        this._check(list[i], 'fillPoses');
        const m = this._relative(list[i], baseSpace);
        if (m) transforms.set(m, i * 16);
        else { transforms.fill(NaN, i * 16, i * 16 + 16); all = false; }
      }
      return all;
    }
    fillJointRadii(jointSpaces, radii) {
      const list = Array.from(jointSpaces);
      if (!(radii instanceof Float32Array) || radii.length < list.length) throw new TypeError('fillJointRadii: radii array is too small');
      let all = true;
      for (let i = 0; i < list.length; i++) {
        if (!(list[i] instanceof XRJointSpace)) throw new TypeError('fillJointRadii: spaces must be XRJointSpaces');
        const r = list[i]._radius(this._state);
        if (r == null) { radii[i] = NaN; all = false; } else radii[i] = r;
      }
      return all;
    }
  }

  class XRSessionEvent extends Event {
    constructor(type, init = {}) { super(type, init); this._session = init.session; }
    get session() { return this._session; }
  }
  class XRInputSourcesChangeEvent extends Event {
    constructor(type, init = {}) { super(type, init); this._session = init.session; this._added = Object.freeze(Array.from(init.added || [])); this._removed = Object.freeze(Array.from(init.removed || [])); }
    get session() { return this._session; }
    get added() { return this._added; }
    get removed() { return this._removed; }
  }
  class XRInputSourceEvent extends Event {
    constructor(type, init = {}) { super(type, init); this._frame = init.frame; this._inputSource = init.inputSource; }
    get frame() { return this._frame; }
    get inputSource() { return this._inputSource; }
  }

  const SUPPORTED_FEATURES = new Set(['viewer', 'local', 'local-floor', 'bounded-floor', 'unbounded', 'hand-tracking']);
  const SESSION_EVENT_HANDLERS = ['end', 'inputsourceschange', 'select', 'selectstart', 'selectend', 'squeeze', 'squeezestart', 'squeezeend', 'visibilitychange', 'frameratechange'];

  class XRSession extends EventTarget {
    constructor(mode, enabledFeatures) {
      super();
      this._mode = mode;
      this._ended = false;
      this._ending = null;
      this._callbacks = [];
      this._nextHandle = 1;
      this._rafId = null;
      this._frameCount = 0;
      this._startPerf = perfNow();
      this._lastFrameTime = -Infinity;
      this._inputSources = [];
      this._enabledFeatures = Object.freeze(enabledFeatures.slice());
      this._frameRate = mode === 'immersive-vr' ? config.frameRate : undefined;
      this._renderState = new XRRenderState({ depthNear: 0.1, depthFar: 1000, inlineVerticalFieldOfView: mode === 'inline' ? Math.PI / 2 : null, baseLayer: null });
      this._localOrigin = null;
      this._state = null;
      this._handlers = {};
      for (const name of SESSION_EVENT_HANDLERS) this._handlers[name] = null;
    }
    get renderState() { return this._renderState; }
    get inputSources() { return this._inputSources; }
    get visibilityState() { return 'visible'; }
    get environmentBlendMode() { return 'opaque'; }
    get interactionMode() { return 'world-space'; }
    get enabledFeatures() { return this._enabledFeatures; }
    get supportedFrameRates() { return this._mode === 'immersive-vr' ? new Float32Array(config.supportedFrameRates) : undefined; }
    get frameRate() { return this._frameRate; }
    get isSystemKeyboardSupported() { return false; }
    get domOverlayState() { return null; }
    get preferredReflectionFormat() { return undefined; }
    get persistentAnchors() { return undefined; }

    updateRenderState(state = {}) {
      if (this._ended) throw domErr('updateRenderState: session has ended', 'InvalidStateError');
      if (state.baseLayer !== undefined && state.baseLayer !== null) {
        if (!(state.baseLayer instanceof XRWebGLLayer)) throw new TypeError('updateRenderState: baseLayer must be an XRWebGLLayer');
        if (state.baseLayer._session !== this) throw domErr('updateRenderState: baseLayer was created for another session', 'InvalidStateError');
      }
      if (state.inlineVerticalFieldOfView !== undefined && this._mode !== 'inline') throw domErr('updateRenderState: inlineVerticalFieldOfView is only valid for inline sessions', 'InvalidStateError');
      if (state.layers !== undefined) throw domErr('updateRenderState: the "layers" feature is not supported by the fake XR device', 'NotSupportedError');
      const cur = this._renderState;
      this._renderState = new XRRenderState({
        depthNear: state.depthNear !== undefined ? Number(state.depthNear) : cur.depthNear,
        depthFar: state.depthFar !== undefined ? Number(state.depthFar) : cur.depthFar,
        inlineVerticalFieldOfView: state.inlineVerticalFieldOfView !== undefined ? Number(state.inlineVerticalFieldOfView) : cur.inlineVerticalFieldOfView,
        baseLayer: state.baseLayer !== undefined ? state.baseLayer : cur.baseLayer,
      });
    }
    requestReferenceSpace(type) {
      if (this._ended) return Promise.reject(domErr('requestReferenceSpace: session has ended', 'InvalidStateError'));
      if (!REFERENCE_SPACE_TYPES.includes(type)) return Promise.reject(new TypeError(`requestReferenceSpace: unknown reference space type "${type}"`));
      if (!this._enabledFeatures.includes(type)) return Promise.reject(domErr(`requestReferenceSpace: the "${type}" feature was not requested for this session`, 'NotSupportedError'));
      if (this._mode === 'inline' && type !== 'viewer') return Promise.reject(domErr('requestReferenceSpace: inline sessions only support "viewer"', 'NotSupportedError'));
      const space = type === 'bounded-floor' ? new XRBoundedReferenceSpace(this, type) : new XRReferenceSpace(this, type);
      return Promise.resolve(space);
    }
    requestAnimationFrame(callback) {
      if (typeof callback !== 'function') throw new TypeError('requestAnimationFrame: callback must be a function');
      if (this._ended) return 0;
      const handle = this._nextHandle++;
      this._callbacks.push({ handle, callback });
      this._schedule();
      return handle;
    }
    cancelAnimationFrame(handle) {
      const i = this._callbacks.findIndex((c) => c.handle === handle);
      if (i >= 0) this._callbacks.splice(i, 1);
    }
    updateTargetFrameRate(rate) {
      if (this._ended) return Promise.reject(domErr('updateTargetFrameRate: session has ended', 'InvalidStateError'));
      if (this._mode !== 'immersive-vr') return Promise.reject(domErr('updateTargetFrameRate: not an immersive session', 'InvalidStateError'));
      if (!config.supportedFrameRates.includes(rate)) return Promise.reject(new TypeError(`updateTargetFrameRate: ${rate} is not a supported frame rate`));
      if (this._frameRate !== rate) {
        this._frameRate = rate;
        setTimeout(() => { if (!this._ended) this.dispatchEvent(new XRSessionEvent('frameratechange', { session: this })); }, 0);
      }
      return Promise.resolve();
    }
    end() {
      if (this._ended) return Promise.resolve();
      if (this._ending) return this._ending;
      this._ended = true;
      this._callbacks.length = 0;
      if (this._rafId != null) { nativeCAF(this._rafId); this._rafId = null; }
      this._inputSources.length = 0;
      if (fake.session === this) fake.session = null;
      if (xrSystem._activeImmersive === this) xrSystem._activeImmersive = null;
      this._ending = new Promise((resolve) => {
        setTimeout(() => {
          try { this.dispatchEvent(new XRSessionEvent('end', { session: this })); }
          catch (err) { report(err); }
          resolve();
        }, 0);
      });
      return this._ending;
    }

    // -- internals
    _schedule() {
      if (this._rafId != null || this._ended) return;
      this._rafId = nativeRAF((rafTime) => this._tick(rafTime));
    }
    _tick(rafTime) {
      this._rafId = null;
      if (this._ended) return;
      let frame;
      try {
        clock._tick(rafTime);
        const state = computeFrameState(clock.time);
        if (!this._localOrigin) this._localOrigin = mcompose(state.head.position, [0, 0, 0, 1]);
        this._state = state;
        let time = this._startPerf + clock.time * 1000;
        if (time <= this._lastFrameTime) time = this._lastFrameTime + 0.01;   // keep timestamps monotonic if the clock is rewound
        this._lastFrameTime = time;
        frame = new XRFrame(this, state, time);
        if (this._mode === 'immersive-vr' && this._frameCount === config.inputSourceDelayFrames) this._connectHands();
        this._dispatchSelectEvents(frame, state);
      } catch (err) {
        report(err);
        this._schedule();
        return;
      }
      const cbs = this._callbacks;
      this._callbacks = [];
      for (const { callback } of cbs) {
        if (this._ended) break;
        try { callback(frame.predictedDisplayTime, frame); }
        catch (err) { report(err); }
      }
      this._frameCount++;
      fake.frames++;
      fake.lastState = this._state;
      if (this._callbacks.length && !this._ended) this._schedule();
    }
    _connectHands() {
      if (!this._enabledFeatures.includes('hand-tracking')) return;
      const added = [new XRInputSource(this, 'left'), new XRInputSource(this, 'right')];
      this._inputSources.push(...added);
      this.dispatchEvent(new XRInputSourcesChangeEvent('inputsourceschange', { session: this, added, removed: [] }));
    }
    _dispatchSelectEvents(frame, state) {
      for (const src of this._inputSources) {
        const h = state.hands[src.handedness];
        if (!h) continue;
        const fire = (type) => this.dispatchEvent(new XRInputSourceEvent(type, { frame, inputSource: src }));
        if (!src._selecting && h.tracked && h.pinchDistance < config.selectStartDistance) { src._selecting = true; fire('selectstart'); fake.events.push({ t: state.time, type: 'selectstart', hand: src.handedness }); }
        else if (src._selecting && (!h.tracked || h.pinchDistance > config.selectEndDistance)) { src._selecting = false; fire('selectend'); fire('select'); fake.events.push({ t: state.time, type: 'select', hand: src.handedness }); }
      }
      if (fake.events.length > 200) fake.events.splice(0, fake.events.length - 200);
    }
  }
  for (const name of SESSION_EVENT_HANDLERS) {
    Object.defineProperty(XRSession.prototype, 'on' + name, {
      configurable: true,
      get() { return this._handlers[name]; },
      set(fn) {
        if (this._handlers[name]) this.removeEventListener(name, this._handlers[name]);
        this._handlers[name] = typeof fn === 'function' ? fn : null;
        if (this._handlers[name]) this.addEventListener(name, this._handlers[name]);
      },
    });
  }

  class XRSystem extends EventTarget {
    constructor() { super(); this._activeImmersive = null; this._pendingOffer = null; this._ondevicechange = null; }
    isSessionSupported(mode) {
      if (typeof mode !== 'string') return Promise.reject(new TypeError('isSessionSupported: mode must be a string'));
      return Promise.resolve(mode === 'immersive-vr' || mode === 'inline');
    }
    requestSession(mode = 'inline', init = {}) {
      if (mode !== 'immersive-vr' && mode !== 'inline') return Promise.reject(domErr(`The session mode "${mode}" is not supported by the fake XR device`, 'NotSupportedError'));
      if (mode === 'immersive-vr' && this._activeImmersive && !this._activeImmersive._ended) return Promise.reject(domErr('An immersive session is already active', 'InvalidStateError'));
      const required = Array.from((init && init.requiredFeatures) || []);
      const optional = Array.from((init && init.optionalFeatures) || []);
      for (const f of required) if (!SUPPORTED_FEATURES.has(f)) return Promise.reject(domErr(`Required feature "${f}" is not supported by the fake XR device`, 'NotSupportedError'));
      const enabled = new Set(['viewer', 'local']);
      for (const f of [...required, ...optional]) if (SUPPORTED_FEATURES.has(f)) enabled.add(f);
      if (mode === 'immersive-vr') {
        for (const f of ['local-floor', 'hand-tracking']) {
          if (!enabled.has(f)) {
            warn(`requestSession('immersive-vr') did not request the "${f}" feature; a real Quest would not provide it. ` + (config.strictFeatures ? 'Not enabled (strictFeatures).' : 'Enabled anyway (config.strictFeatures = false).'));
            if (!config.strictFeatures) enabled.add(f);
          }
        }
      }
      const session = new XRSession(mode, Array.from(enabled));
      if (mode === 'immersive-vr') { this._activeImmersive = session; fake.session = session; fake.frames = 0; fake.events.length = 0; clock.reset(); fake.sessions++; }
      return new Promise((resolve) => setTimeout(() => resolve(session), 0));
    }
    // Resolves only when a test calls window.__fakeXR.acceptOffer() (no browser UI here).
    offerSession(mode, init = {}) {
      return new Promise((resolve, reject) => { this._pendingOffer = { mode, init, resolve, reject }; });
    }
    get ondevicechange() { return this._ondevicechange; }
    set ondevicechange(fn) { if (this._ondevicechange) this.removeEventListener('devicechange', this._ondevicechange); this._ondevicechange = typeof fn === 'function' ? fn : null; if (this._ondevicechange) this.addEventListener('devicechange', this._ondevicechange); }
  }

  // ------------------------------------------------------------------ install
  const xrSystem = new XRSystem();
  const defineGlobal = (name, value) => {
    try { Object.defineProperty(g, name, { value, writable: true, configurable: true, enumerable: false }); }
    catch { try { g[name] = value; } catch { /* ignore */ } }
  };
  const classes = { XRSystem, XRSession, XRRenderState, XRFrame, XRSpace, XRReferenceSpace, XRBoundedReferenceSpace, XRJointSpace, XRHand, XRInputSource, XRPose, XRJointPose, XRView, XRViewerPose, XRViewport, XRRigidTransform, XRWebGLLayer, XRSessionEvent, XRInputSourcesChangeEvent, XRInputSourceEvent };
  for (const [name, cls] of Object.entries(classes)) defineGlobal(name, cls);
  defineGlobal('XRWebGLBinding', undefined);   // no WebXR Layers → Three.js uses XRWebGLLayer
  try { Object.defineProperty(navigator, 'xr', { value: xrSystem, configurable: true, enumerable: true, writable: false }); }
  catch { try { Object.defineProperty(Navigator.prototype, 'xr', { get: () => xrSystem, configurable: true }); } catch { /* ignore */ } }
  for (const C of [g.WebGLRenderingContext, g.WebGL2RenderingContext]) {
    if (C && C.prototype) {
      try { Object.defineProperty(C.prototype, 'makeXRCompatible', { value: function makeXRCompatible() { return Promise.resolve(); }, writable: true, configurable: true }); }
      catch { /* ignore */ }
    }
  }

  const fake = {
    installed: true,
    version: '1.0.0',
    config,
    clock,
    timeline,
    overrides,
    warnings,
    events: [],
    frames: 0,
    sessions: 0,
    session: null,
    lastState: null,
    classes,
    jointNames: JOINT_NAMES.slice(),
    defaultTimeline,
    setTimeline(fn, duration) {
      if (fn == null) { timeline.fn = defaultTimeline; timeline.name = 'default'; timeline.duration = 15; return; }
      if (typeof fn !== 'function') throw new TypeError('setTimeline: expected a function (t seconds) => { head, left, right }');
      timeline.fn = fn; timeline.name = fn.name || 'custom';
      if (Number.isFinite(duration)) timeline.duration = duration;
    },
    setHead(position, yawDeg, pitchDeg, rollDeg) {
      overrides.head = position == null && yawDeg == null ? null : { position, yawDeg, pitchDeg, rollDeg };
    },
    setHandPose(handedness, spec) {
      if (handedness !== 'left' && handedness !== 'right') throw new TypeError('setHandPose: handedness must be "left" or "right"');
      overrides[handedness] = spec ? { ...spec } : null;
    },
    clearOverrides() { overrides.head = overrides.left = overrides.right = null; },
    pause() { clock.pause(); },
    resume() { clock.resume(); },
    acceptOffer() {
      const o = xrSystem._pendingOffer;
      if (!o) return Promise.reject(new Error('no pending offerSession()'));
      xrSystem._pendingOffer = null;
      return xrSystem.requestSession(o.mode, o.init).then((s) => { o.resolve(s); return s; }, (e) => { o.reject(e); throw e; });
    },
    getState() {
      const st = fake.lastState;
      if (!st) return null;
      const hand = (h) => {
        const H = st.hands[h];
        return {
          tracked: H.tracked,
          position: H.spec.position,
          pinch: H.spec.pinch,
          pinchDistance: H.pinchDistance,
          wrist: H.joints[J.wrist].position,
          indexTip: H.joints[J['index-finger-tip']].position,
          thumbTip: H.joints[J['thumb-tip']].position,
          lowestJointY: Math.min(...H.joints.map((j) => j.position[1])),
        };
      };
      return { time: st.time, frames: fake.frames, head: { position: st.head.position, yawDeg: st.head.spec.yawDeg, pitchDeg: st.head.spec.pitchDeg }, left: hand('left'), right: hand('right') };
    },
  };
  Object.defineProperty(g, '__fakeXR', { value: fake, configurable: true, enumerable: false, writable: true });
})();
