import * as THREE from 'three';

/**
 * Hush. Rest an open palm flat on the water and keep it there: after a moment a circle of perfect
 * stillness spreads from under the hand. Ripples die at its edge, the plankton go dark inside it and the
 * stars come up through the glass-still disc; a bowl note holds and raindrop notes begin to fall
 * (sfx/music). Lifting the hand lets the lake breathe again.
 *
 * No geometry of its own: two circles (one per hand) are written into two vec4 uniforms every frame —
 * ctx.water.hush.data for the wave sim (uv centre, uv radius, strength) and ctx.water.hushWorld for the
 * surface shader (world x, z, radius, strength). wavesim and water run before this module, so they read
 * the previous frame's values: a one-frame lag nobody can see, and no dependence on module order.
 * Exposes ctx.hush = { strength, circles: [{ x, z, r, s, active }, …], count } for the audio, the hints
 * and the harness. Events: 'hush' { hand, pos } when a circle takes, 'hushend' { hand } when it is gone.
 */
const HUSH = {
  normalY: -0.8,   // palm facing down
  yMin: -0.05,     // palm joint height above the surface, metres: pressed deeper than 5 cm gets nothing
  yMax: 0.03,
  hold: 0.6,       // seconds of the pose before the circle takes
  holdDecay: 3,    // the hold undoes itself ×3 faster than it accrues
  tauIn: 0.8,      // strength ease in / out, seconds
  tauOut: 1.2,
  r0: 0.25,        // radius under the hand at first, metres
  r1: 1.2,         // fully grown
  grow: 3.0,       // seconds to grow (ease-out cubic)
  follow: 1.0,     // the centre drifts after the palm at this fraction per second
  onAt: 0.05,      // strength thresholds for the events
  offAt: 0.02,
  calmGain: 0.6,   // how much a full hush counts as calm for the sim damping and the surface (used in wavesim/water)
};
const easeOutCubic = (u) => 1 - Math.pow(1 - u, 3);
const frac = (v) => v - Math.floor(v);

export const hush = {
  name: 'hush',
  init(ctx) {
    if (!ctx.water.hush || !ctx.water.hushWorld) throw new Error('hush needs the wave sim (ctx.water.hush)');
    const circles = [];
    for (let i = 0; i < 2; i++) circles.push({ x: 0, z: 0, r: 0, s: 0, hold: 0, growT: 0, rGrown: HUSH.r0, active: false, wasActive: false, prevPose: false });
    ctx.hush = { strength: 0, circles, count: 0 };
    this._ = { circles, tile: ctx.water.tileSize };
    // a session change (or the desktop fallback) starts clean; the arrays go to zero on the next update
    const reset = () => { for (const c of circles) { c.active = false; c.wasActive = false; c.hold = 0; c.s = 0; c.r = 0; c.prevPose = false; } ctx.hush.strength = 0; ctx.water.hush.strength = 0; };
    ctx.events.on('xrstart', reset);
    ctx.events.on('xrend', reset);
  },

  update(ctx, dt) {
    const { circles, tile } = this._;
    const level = ctx.water.level;
    const hw = ctx.water.hushWorld, hd = ctx.water.hush.data;
    let strength = 0;
    for (let hi = 0; hi < 2; hi++) {
      const h = ctx.hands.list[hi], c = circles[hi];
      // the pose: open, palm down, the palm joint within a few centimetres of the surface (the pads dip: h.still
      // is computed regardless of submersion), still, not pinching and not holding anything
      let pose = false;
      if (h && h.visible && h.active && h.open && h.still && !h.pinch.active && !h.grabbed && h.palm.normal.y < HUSH.normalY) {
        const dy = h.palm.position.y - level;
        pose = dy >= HUSH.yMin && dy <= HUSH.yMax;
      }
      if (pose) c.hold = Math.min(HUSH.hold, c.hold + dt); else c.hold = Math.max(0, c.hold - HUSH.holdDecay * dt);

      if (!c.active && pose && c.hold >= HUSH.hold) {
        c.active = true; c.wasActive = false;
        c.x = h.palm.position.x; c.z = h.palm.position.z;
        c.r = HUSH.r0; c.rGrown = HUSH.r0; c.s = 0; c.growT = 0;
        ctx.hush.count++;
      }
      if (c.active) {
        if (pose) {
          // the pose came back while the circle was fading: carry the growth on from the radius it has now, no pop
          if (!c.prevPose && c.r < c.rGrown) c.growT = HUSH.grow * (1 - Math.cbrt(Math.max(0, 1 - (c.r - HUSH.r0) / (HUSH.r1 - HUSH.r0))));
          c.s += (1 - c.s) * (1 - Math.exp(-dt / HUSH.tauIn));
          const k = Math.min(1, HUSH.follow * dt);
          c.x += (h.palm.position.x - c.x) * k;
          c.z += (h.palm.position.z - c.z) * k;
          c.growT += dt;
          c.rGrown = HUSH.r0 + (HUSH.r1 - HUSH.r0) * easeOutCubic(Math.min(1, c.growT / HUSH.grow));
          c.r = c.rGrown;
        } else {
          // the hand lifts (or tracking goes): the stillness dissolves, the disc shrinking no faster than it fades
          c.s += (0 - c.s) * (1 - Math.exp(-dt / HUSH.tauOut));
          c.r = Math.max(HUSH.r0, c.rGrown * c.s);
        }
        if (!c.wasActive && c.s >= HUSH.onAt) {
          c.wasActive = true;
          ctx.events.emit('hush', { hand: h, pos: h.palm.position.clone() });
        }
        // gone: below the off threshold after it took, or the pose broke before it ever took
        if (c.s < HUSH.offAt && (c.wasActive || !pose)) {
          if (c.wasActive) ctx.events.emit('hushend', { hand: h });
          c.active = false; c.wasActive = false; c.s = 0; c.r = 0; c.hold = 0;
        }
      }
      c.prevPose = pose;
      if (c.s > strength) strength = c.s;
      // the two uniforms: world metres for the surface, tile uv for the sim
      const o = hi * 4;
      hw[o] = c.x; hw[o + 1] = c.z; hw[o + 2] = c.r; hw[o + 3] = c.s;
      hd[o] = frac(c.x / tile); hd[o + 1] = frac(c.z / tile); hd[o + 2] = c.r / tile; hd[o + 3] = c.s;
    }
    ctx.hush.strength = strength;
    ctx.water.hush.strength = strength;
  },
};

export { HUSH };
