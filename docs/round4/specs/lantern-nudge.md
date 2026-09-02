# Touch and nudge (lantern-nudge)

Events: lanterntouch { pos, hand, lantern, speed }
Exposes: ctx.lanterns.touches (count); lantern records gain { push: Vector2, spinKick, touchT, inContact }; world().lanterns entries gain { push }; stats().lanternTouches
Files: src/world/lanterns.js, src/audio/sfx.js, src/main.js, tools/harness/scenario.mjs, DESIGN.md

# Touch and nudge

Today a hand passes straight through a floating lantern. Now an open hand meets it: a slow hand rests it against the fingers where it nuzzles; a brisk sideways brush sends it gliding off with a slow spin, its flame leaning and guttering, and a ring spreading from the hull. Nothing to learn; zero draw calls; ~130 lines in `src/world/lanterns.js` plus one sound.

## Gesture (lanterns.js update, inside the floating branch, after the attraction term and before the head-avoidance term)
Constants `NUDGE = { reach: 0.45, skin: 0.008, body: 0.075, pushMax: 0.7, pushK: 0.9, spinK: 2.5, spinMax: 2.5, pushDecay: 1.5, spinDecay: 0.9, gutterSpeed: 0.35, eventGap: 0.25, attEaseNear: 0.095, attEaseFar: 0.175 }`. Contact joints: `['wrist', 'middle-finger-metacarpal', 'index-finger-phalanx-proximal', 'middle-finger-phalanx-proximal', 'ring-finger-phalanx-proximal', 'pinky-finger-phalanx-proximal', ...TIP_NAMES]` (import TIP_NAMES from core/hands.js). New record fields allocated at spawn: `push: new THREE.Vector2(), spinKick: 0, touchT: -1e9, inContact: false`.

Per hand `h` with `h.visible && h.active && !h.pinch.active && !h.grasp && !h.grabbed` (a grasp within reach already grabs via hands.js; a pinching hand is grabbing or pulling the world), skip unless `h.palm.position.distanceToSquared(L.position) < NUDGE.reach^2`. Only for `L.state === 'floating' && !L.dropping`. For each contact joint `j` with `j.valid`: `jr = j.radius + NUDGE.skin`; vertical band `L.position.y - 0.11 < j.position.y < L.top.y - 0.02` (the paper flank only; a joint above the rim never pushes); `dx = L.position.x - j.position.x, dz = L.position.z - j.position.z, d = hypot(dx, dz)`; contact if `d < NUDGE.body + jr` and `d > 1e-4`. Resolution: `pen = NUDGE.body + jr - d; n = (dx, dz) / d; P.x += n.x * pen; P.z += n.z * pen` (positional, no vertical push). Velocity transfer from the WORLD palm velocity `v = h.palm.velocity`: `vn = max(0, v.x * n.x + v.z * n.z)`; if `vn * NUDGE.pushK > push.dot(n)` then `push += n * (vn * NUDGE.pushK - push.dot(n))`; clamp `|push| <= NUDGE.pushMax`. Tangential: `vt = (v.x - n.x * vn, v.z - n.z * vn)`; `L.spinKick = clamp(L.spinKick + (n.x * vt.y - n.z * vt.x) * NUDGE.spinK * dt * 30, -NUDGE.spinMax, NUDGE.spinMax)`. Contact start (no contact last frame for this lantern, and `t - L.touchT > NUDGE.eventGap`): `L.touchT = t`; gutter if `vn > NUDGE.gutterSpeed`: `L.bright = max(0.3, L.bright - 0.2)` (the existing easing restores it); `ctx.water.disturb(P.x, P.z, 0.1, 0.05 + 0.2 * min(1, vn))`; `ctx.lanterns.touches++`; emit `'lanterntouch' { pos: P.clone(), hand: h, lantern: L, speed: vn }`. Set `L.inContact` for next frame.
Every frame (floating): `push *= max(0, 1 - NUDGE.pushDecay * dt); spinKick *= max(0, 1 - NUDGE.spinDecay * dt); vx += push.x; vz += push.y; L.leanT += push * 0.5` (heels away, added to the existing leanT), and the flame target becomes `max(existing target, 1 + min(0.7, |push| * 1.2))` while `|push| > 0.05`. Yaw: `L.yaw += (L.spin + L.spinKick) * dt` in the floating case. Attraction ease-out (so the nuzzle does not jitter against the pull): multiply the existing `ATTRACT_K` contribution by `smoothstep(ad, NUDGE.attEaseNear, NUDGE.attEaseFar)` where `ad` is the horizontal distance from `h.pinch.point` to `P`. Held and rising lanterns are never pushed.

## Visual
No new geometry: push/spin/lean go through the instance matrix, the flare through `pFlame`, the gutter through `aBright`; the water lights and the strength-scaled hull ripple follow automatically. No per-frame allocation (scalars + the record's Vector2).

## Sound (sfx.js)
`on('lanterntouch', e)`: `sp = clamp(e.speed / 0.8, 0, 1)`; `noiseBurst(S, { pos: e.pos, dur: 0.05 + 0.05 * sp, gain: 0.03 + 0.10 * sp, type: 'bandpass', freq: 900, q: 1.2 })` — a soft paper tap, louder for a brisk brush, nothing for a sustained nuzzle (rate-limited by the 0.25 s contact-start rule). The crackle slot rises with `L.flame` by itself.

## Hint
None. Do not count a touch as `s.grabbed`.

## Edge cases
Tracking loss: `visible` false ends contact; push decays. Submerged hand: the flank band starts 1 cm below the surface, so paddling joints are outside it; a hand half in the water can still nudge — intended. Both hands: each hand's joints tested independently. Locomotion active: pinching -> excluded. Fast swipe tunnelling (4 m/s cap = 5.5 cm/frame vs a 15 cm body): accepted. Pushed lantern drifting out of reach: existing homing returns it. Interplay with 'lantern-lotus': damping is applied before push is added, so a lantern among pads can still be nudged out. Leave pose: inside the 0.42 m head-avoidance radius, no lantern is there.

## Harness
main.js: add `'lanterntouch'` to the eventLog list; world().lanterns entries gain `push: +(l.push ? l.push.length() : 0).toFixed(3)`; stats() gains `lanternTouches: ctx.lanterns?.touches`. Scenario, right after the existing 'lantern-star' step (clock back at 1/36): `L = nearest floating lantern from world()`, `rig0 = world().rig`. Pose the right hand open with fingers along -X: `setHand('right', [L.x + 0.32, L.y + 0.02, L.z], 0, { yawDeg: 90, pitchDeg: 0, rollDeg: 0, curl: 0.05 })`; `frames(8)`; `L0 = world().lanterns[L.index]`. Sweep the wrist x from `L.x + 0.32` to `L.x + 0.05` over 20 frames (~0.49 m/s; the fingertips, 0.175 m ahead, pass through the body), sampling `world()` every 2 frames and keeping `minX`; `frames(10)`, sampling too. `step('lantern-nudged', events().some(e => e.type === 'lanterntouch' && e.detail.speed > 0.2 && e.detail.hand === 'right') && minX < L0.x - 0.10 && stats().hands.pinchR === false && no 'grab'/'pinchmiss' since the step began && hypot(rig - rig0) < 0.005)`. Then move the hand to `[0.25, 1.25, -0.4]` with `curl: 0.6`; `frames(30)`; assert `stats().lanternTouches >= 1` and the lantern is still 'floating'.

## DESIGN.md
Interaction row: "Touch a floating lantern | open, non-pinching hand; any finger/knuckle joint meets the paper flank | it gives: a slow hand rests it against the fingers, a brisk brush (> 0.35 m/s) sends it gliding with a slow spin, the flame flares and gutters, a ring spreads from the hull, a paper tap (`lanterntouch`)".
