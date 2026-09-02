# Buds that turn to the hand (lotus-lean)

Events: lotusstir { index, note, pos, hand }; lotusbloom gains { cause: 'touch'|'patient'|'lantern', hand }
Exposes: flowers[i] gain { lean, leanX, leanZ, hoverT, openSeconds }; ctx.lotus.open(i, opts); world().lotus entries gain { state, lean }
Files: src/world/lotus.js, src/audio/sfx.js, src/main.js, tools/harness/scenario.mjs, DESIGN.md

# Buds that turn to the hand

A closed lotus bud leans toward the nearest fingertip of a hand within 35 cm, its glow warming as the hand nears. Hold a fingertip still 9–22 cm above the bud (not touching) and after 0.6 s a thin rising whisper starts; at 2 s the bud opens by itself with a softer, longer note than a touch gives. Zero draw calls, ~90 lines, all in `src/world/lotus.js`.

## Gesture (lotus.js update, after the existing float/bud pass, before the touch test)
Add to each flower record: `leanX = 0, leanZ = 0, lean = 0, hoverT = 0, stirred = false, warmGlow = 0`. Constants in a module object `LEAN = { far: 0.35, near: 0.08, angle: 0.40, tauIn: 0.6, tauOut: 1.2, hoverMin: 0.09, hoverMax: 0.22, stirAt: 0.6, openAt: 2.0, decay: 2 }` (no config.js change).

For each flower with `f.state === 'closed'` (skip opening/open/closing): over hands `h` with `h.visible && h.active && !h.submerged && !h.pinch.active && !h.grabbed`, find the nearest of `h.tips[0..4]` to `f.bud` (squared distances; 6 flowers x 2 hands x 5 tips = 60 checks). Let `d` be that distance and `h*` that hand.
- If `d < LEAN.far`: `p = 1 - smoothstep(LEAN.near, LEAN.far, d)`; horizontal unit `u = normalize((tip - bud).xz)`; target lean vector `= u * LEAN.angle * p`; ease `f.leanX/f.leanZ` toward it with `k = 1 - exp(-dt / LEAN.tauIn)`. Else ease toward 0 with `k = 1 - exp(-dt / LEAN.tauOut)`. `f.lean = hypot(leanX, leanZ)`. `f.warmGlow = p` (0 when no hand).
- Patience: if `LEAN.hoverMin <= d <= LEAN.hoverMax && h*.still` then `f.hoverT += dt`, else `f.hoverT = max(0, f.hoverT - LEAN.decay * dt)`; when hoverT reaches 0 set `f.stirred = false`.
- At `f.hoverT >= LEAN.stirAt && !f.stirred`: `f.stirred = true`; emit `'lotusstir' { index, note, pos: f.bud.clone(), hand: h* }`.
- At `f.hoverT >= LEAN.openAt`: `openFlower(i, { cause: 'patient', hand: h* })`; reset hoverT/stirred.
Open/opening/closing flowers ease lean to 0 and keep hoverT = 0.

## openFlower signature (shared with Lantern among the lily pads — identical in both)
Change to `openFlower(i, opts = {})` with `const { cause = 'touch', hand = null, openSeconds = OPEN_SECONDS } = opts`; store `f.openSeconds = openSeconds`; the `'opening'` branch uses `f.openSeconds` instead of `OPEN_SECONDS`. Event becomes `'lotusbloom' { index, note, pos, color, cause, hand }`. `ctx.lotus.open(i, opts)` passes opts through. The touch loop calls `openFlower(f.index, { cause: 'touch', hand: h })` (pass the hand whose tip hit). Energy/disturb unchanged for every cause.

## Visual
The lean goes into the instance matrix, pivoting at the base (geometry origin): if `f.lean > 1e-4`, `_q.setFromAxisAngle(axis = (leanZ, 0, -leanX) / lean, lean).multiply(_qy)` else `_q.copy(_qy)`; `_m.compose(f.position, _q, _s)`. Recompute `f.bud = (0, BUD_HEIGHT * f.scale, 0).applyQuaternion(_q).add(f.position)` every frame BEFORE the touch test and the glow update, so the touch target and the halo follow the leaning pod. Order inside update: float -> lean -> bud -> touch -> chord -> instances. Closed-bud halo gain becomes `GLOW_GAIN_CLOSED + 0.14 * f.warmGlow` (only while bloom < 0.25). If a screenshot shows the pod clipping a neighbouring pad, drop LEAN.angle to 0.30.

## Sound (src/audio/sfx.js)
- `on('lotusstir', e)`: `noiseBurst(S, { pos: e.pos, dur: 1.4, gain: 0.035, type: 'bandpass', freq: 2 * mtof(pitchFor(S, e.note, 6)), q: 14, sweepTo: 3 * mtof(pitchFor(S, e.note, 6)), kind: 'white', refDistance: 1.0 })` — a thin rising whisper that simply finishes if the hand leaves.
- In `onLotus`: when `e.cause === 'patient'` use `attack: 0.06, dur: 4.2, gain: 0.40` for the FM bell (everything else unchanged).

## Hint
None. The lean and the warming glow are the invitation; the existing 'lotus' hint stays.

## Edge cases
Tracking loss: `visible` false drops the hand from the search; lean decays over 1.2 s; hoverT decays at 2/s. Submerged hand: ignored entirely (a hush palm on the water near a bud never opens it by patience; the existing 8 cm touch rule still can). Pinching/grabbing hand: ignored, so pull-the-world and carrying a lantern past a bud only make it lean if the hand is open — and it is excluded anyway by `!pinch.active`. Both hands: nearest tip wins per flower. Locomotion active: hands are pinching, excluded. A still open hand also attracts fireflies: both rewards for stillness happen together. Interplay with 'lotus-lantern': a lantern-warmed bud has state 'opening' -> skipped.

## Harness (main.js + scenario.mjs)
main.js: add `'lotusstir'` to the eventLog list; add `'cause'` to summarize()'s key list; world().lotus entries gain `state: f.state, lean: +(f.lean || 0).toFixed(3)`.
Scenario, BEFORE the existing 'lotus-bloomed' step (so cluster 0 is still closed): `B = nearest world().lotus with open === false`; `setHand('right', [B.x, B.y + 0.18, B.z + 0.175], 0, { pitchDeg: 0, rollDeg: 0, curl: 0.15 })` — with the fake skeleton the index/middle tips sit ~0.15 m above the pod and 1–3 cm off axis: inside the 0.09–0.22 hover band, outside the 0.08 touch radius. `frames(20)`; `step('lotus-leans', world().lotus[B.index].lean >= 0.15)`. `frames(100)` (hand still: `still` after 0.5 s, stir at ~1.1 s, open at ~2.5 s); `step('lotus-patient-open', events() has 'lotusstir' {index: B.index} followed by 'lotusbloom' {index: B.index, cause: 'patient'} && world().lotus[B.index].open === true)`. Negative: `C = next closed bud`; `setHand('right', [C.x, C.y + 0.33, C.z + 0.175], 0, same extras)`; `frames(110)`; assert no 'lotusbloom' with index C.index. Then park the hand at `[0.25, 1.25, -0.4]` with `curl: 0.6` and continue with the existing lotus-bloomed step (it now picks the next closed bud).

## DESIGN.md
Add an interaction-table row: "Fingertip near a closed bud | nearest fingertip within 35 cm; still 9–22 cm above the pod for 2 s | the bud leans toward the finger and its glow warms; a whisper at 0.6 s, then it opens with a softer, longer note (`lotusbloom` cause 'patient')". Note the `openFlower(i, opts)` / `cause` field in the ctx notes.
