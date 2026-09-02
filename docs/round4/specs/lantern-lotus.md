# Lantern among the lily pads (lantern-lotus)

Events: lotusbloom { index, note, pos, color, cause: 'lantern', hand: null }; lanternsplash (existing, at set-down)
Exposes: flowers[i] gain { warm, warmNear, openSeconds }; lantern records gain { touched, amongPads }; world().lanterns entries gain { pads, touched }
Files: src/world/lotus.js, src/world/lanterns.js, src/shaders/lotus.js, src/audio/sfx.js, src/world/hints.js, src/main.js, tools/harness/scenario.mjs, DESIGN.md, README.md

# Lantern among the lily pads

Carry a lantern to a closed lotus cluster and let it go in the water: the pads hold it, its amber light falls on the petals, and after ~2.5 s the bud opens slowly (5 s) as if warmed, staying open for as long as the lantern stays. No new gesture; zero draw calls; ~130 lines across lotus.js, lanterns.js and the lotus shader.

## openFlower signature (identical to 'lotus-lean' — implement the same change)
`openFlower(i, opts = {})`, `const { cause = 'touch', hand = null, openSeconds = OPEN_SECONDS } = opts`; `f.openSeconds` stored and used by the 'opening' branch; `'lotusbloom' { index, note, pos, color, cause, hand }`; `ctx.lotus.open(i, opts)` passes opts through; the touch loop passes `{ cause: 'touch', hand: h }`.

## Lanterns side (src/world/lanterns.js)
- Record fields: `touched = false` (set true in `onGrab`; reset false in `respawnFar`), `amongPads = false`.
- Floating branch, right after `vx/vz` are built from wind + walk + incoming/homing and BEFORE the hand-attraction term: `L.amongPads = false`; if `ctx.lotus?.clusters` exists, find the nearest cluster horizontally (6 hypot); if `< PADS.hold (0.40)` then `vx *= 0.25; vz *= 0.25; L.amongPads = true`. The attraction, head-avoidance and separation terms are added after, unchanged, so an open hand can still coax it out. Constants: `const PADS = { hold: 0.40 }`.

## Lotus side (src/world/lotus.js)
Constants `WARM = { enter: 0.45, exit: 0.55, minBright: 0.3, need: 2.5, cap: 3.5, openSeconds: 5.0, linger: 10, energy: 0.08, glowLight: 0.6 }`. Flower fields: `warm = 0, warmNear = false, lanternIdx = -1`.
Each frame (after the bud pass, before the touch test): for each flower, scan `ctx.lanterns.list` (<= 24 hypot): candidates are `L.state === 'floating' && L.touched && !L.incoming && !L.dropping && L.bright > WARM.minBright`; `d = hypot(L.position.x - f.position.x, L.position.z - f.position.z)`. Hysteresis: `f.warmNear` becomes true when the nearest candidate `d < WARM.enter`, false when `> WARM.exit`. `f.warm = clamp(f.warm + (warmNear ? dt : -2 * dt), 0, WARM.cap)`. If `f.warm > WARM.need && f.state === 'closed' && f.bloom < 0.25`: `openFlower(i, { cause: 'lantern', openSeconds: WARM.openSeconds })` — inside openFlower the energy bump for cause 'lantern' is `WARM.energy` (0.08) instead of `CONFIG.energy.lotus`, and the disturb is `(0.18, 0.18)`. While `warmNear && f.state === 'open'`: `f.timer = min(f.timer, f.stay - WARM.linger)` so it closes only 10 s after the lantern leaves.
Also record, for the shader, the brightest lantern (any state except rising, bright > 0.05) within `WARM.glowLight` of each flower: `aLantern[i] = (L.position.x, y, z, L.bright * smoothstep(0.6, 0.35, d))`, else w = 0.

## Visual (src/shaders/lotus.js)
flowerGeo gains `aLantern` (InstancedBufferAttribute vec4, 6 instances, DynamicDrawUsage, written each frame). LOTUS_FLOWER_VERT: declare `attribute vec4 aLantern; varying float vWarm;` and after `vNormalW` is set: `vec3 toL = aLantern.xyz - wp.xyz; float d2 = dot(toL, toL); vWarm = aLantern.w * max(dot(vNormalW, normalize(toL + vec3(1e-4))), 0.0) / (1.0 + 12.0 * d2);`. LOTUS_FLOWER_FRAG: declare `varying float vWarm;` and add `col += vWarm * vec3(1.0, 0.70, 0.34) * 0.9;` to the petal and pod branches before the fog mix (not the base). Petals read amber on the lantern side, moon-pale on the other. Halo gain: `+ 0.10 * smoothstep(0, 1, f.warm)` added to the per-instance glowGain (mirror follows). The 5 s open uses the existing easeOutCubic with `f.openSeconds`.

## Sound (src/audio/sfx.js onLotus)
When `e.cause === 'lantern'`: `triggerBell(S, { midi, pos, gain: 0.32, dur: 5.0, kind: 'ceramic', attack: 0.35, wet: 0.4, tag: 'lotus' })` so the note swells instead of striking; tuned bowl layer at gain 0.18. The lantern's crackle and the existing 'lanternsplash' at set-down need no change.

## Hint (src/world/hints.js)
Append to HINTS: `{ id: 'lanternlotus', text: 'leave a lantern among the lily pads', after: 130, done: (ctx, s) => s.lanternBloomed, ready: (ctx, s) => s.grabbed && s.bloomed && nearestLotus(ctx) < REACH + 0.15 && nearestLantern(ctx) < REACH + 0.15 }`; `s.lanternBloomed` set in init from `'lotusbloom'` with `e.cause === 'lantern'`.

## Edge cases
Pinch semantics untouched (grab + in-water release are existing). `L.touched` keeps homing lanterns (which stop right beside cluster 0) from opening buds by themselves. A dropped-on-tracking-loss lantern (`dropping`) does not count until it has landed. Bobbing: 0.45/0.55 hysteresis + 2.5 s dwell. Leave pose / fireflies / hush unaffected. A lantern parked at every cluster holds the chord open indefinitely — accepted (the 'lotuschord' swell still fires once per episode). Wind is damped to 1 cm/s among pads, so a placed lantern eventually leaves and the flower closes 10 s later.

## Harness
main.js: add `'cause'` to summarize()'s keys; world().lanterns entries gain `pads: !!l.amongPads, touched: !!l.touched`; world().lotus entries gain `state`. Scenario, AFTER the existing 'lotus-bloomed' step: `B = nearest world().lotus with open === false`; `L2 = nearest floating world().lanterns entry`; `head = world().head`; `u = normalize((B.x - head[0], B.z - head[2]))`. Grab: `setHand('right', [L2.x, L2.y + 0.12, L2.z], 0, { pitchDeg: 0, rollDeg: 0, curl: 0.1 }); frames(12); setHand(same, 1); frames(12)`; assert a 'grab'. Carry: 48 frames lerping the wrist (pinch 1) to `T = [B.x + 0.33 * u.x, level + 0.10, B.z + 0.33 * u.z + 0.135]` where `level = stats().water` — the pinch point lands ~0.30 m beyond the bud on the far side from the head (tips never within 0.08 of the bud), and the lantern's bottom hangs ~0.26 m below the pinch point, under water. `setHand('right', T, 0, same extras); frames(6)`; assert 'lanternsplash'. Park: `setHand('right', [0.25, 1.25, -0.4], 0, { curl: 0.6 })`. `frames(144)` (4 s). `step('lantern-warms-lotus', events().some(e => e.type === 'lotusbloom' && e.detail.cause === 'lantern' && e.detail.index === B.index) && world().lotus[B.index].open && world().lotus[B.index].bloom < 1 && world().lanterns[L2.index].pads === true && page.evaluate(i => window.__nocturneCtx.lotus.flowers[i].warm > 2.5, B.index))`. Optional: `clock.step = 0.1; frames(800)`; assert the flower is still open; restore step.

## DESIGN.md / README
Interaction row: "Lantern set down among lily pads | a lantern you have handled floats within 45 cm of a cluster for 2.5 s | the pads hold it, its light warms the petals amber, the bud opens over 5 s (`lotusbloom` cause 'lantern') and stays open until 10 s after the lantern drifts away". README 'What to do' line: add '· leave a lantern among the lily pads'.
