import * as THREE from 'three';
import { CONFIG } from '../config.js';

/**
 * Leaving. There is no menu; the way out is a gesture that never happens by accident: press both palms
 * together (a small bow) and hold. After a moment the water writes "keep your palms together to leave",
 * the view darkens with the hold, and at CONFIG.player.leaveHoldTime the session ends — the landing page
 * then says how long you stayed and how many stars you left. Letting go before that undoes it.
 * Tracking often drops one hand when they touch, so a short grace period keeps the hold alive.
 * Exposes ctx.leave = { progress (0..1), holding } for the hints and the harness.
 */
const _ab = new THREE.Vector3();

export const leave = {
  name: 'leave',
  init(ctx) {
    this._ = { hold: 0, grace: 0, ending: false };
    ctx.leave = { progress: 0, holding: false };
    const reset = () => { this._.hold = 0; this._.grace = 0; this._.ending = false; ctx.leave.progress = 0; ctx.leave.holding = false; ctx.playerCtl.setLeave?.(0); };
    ctx.events.on('xrstart', reset);
    ctx.events.on('xrend', reset);
  },

  update(ctx, dt) {
    const s = this._;
    if (!ctx.renderer.xr.isPresenting) { if (ctx.leave.progress) { ctx.leave.progress = 0; ctx.leave.holding = false; } return; }
    const [a, b] = ctx.hands.list;
    let pose = false;
    if (a && b && a.tracked && b.tracked && !a.submerged && !b.submerged && !a.pinch.active && !b.pinch.active && !a.grabbed && !b.grabbed) {
      const d = a.palm.position.distanceTo(b.palm.position);
      if (d < 0.09) {
        // palms pressed together: each palm faces the other
        _ab.subVectors(b.palm.position, a.palm.position).normalize();
        const fa = a.palm.normal.dot(_ab), fb = b.palm.normal.dot(_ab);
        pose = fa > 0.45 && fb < -0.45 && a.palm.normal.dot(b.palm.normal) < -0.5;
      }
    }
    const bothTracked = !!(a && b && a.tracked && b.tracked);
    if (pose) { s.hold += dt; s.grace = 0.5; }
    else if (s.grace > 0 && !bothTracked) s.grace -= dt;     // one hand briefly lost while they touch: keep the hold
    else { s.grace = 0; s.hold = Math.max(0, s.hold - dt * 3); }  // let go: it undoes itself quickly
    const T = CONFIG.player.leaveHoldTime;
    const p = THREE.MathUtils.clamp(s.hold / T, 0, 1);
    ctx.leave.progress = p;
    ctx.leave.holding = pose;
    // darken from a third of the way in, fully black at the end
    ctx.playerCtl.setLeave?.(THREE.MathUtils.smoothstep(p, 0.33, 1.0));
    if (p >= 1 && !s.ending) {
      s.ending = true;
      ctx.events.emit('leave', {});
      Promise.resolve(ctx.xr.end()).catch(() => {}).finally(() => { s.ending = false; s.hold = 0; });
    }
  },
};
