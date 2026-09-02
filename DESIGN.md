# NOCTURNE — a night on the water

*A hand-tracked WebXR experience for Meta Quest. No controllers. Nothing to install.*

You are standing waist-deep in a still lake, at night, under a real sky.
The water around you is alive: when you move your hands through it, it lights up.
Paper lanterns drift by. Fireflies come to rest on your fingertips. Lotus buds
open when you touch them, and each one sings a note. Overhead, the Milky Way
(a real photograph of it) wheels slowly, and when you release a lantern into the
sky, the aurora answers.

Everything you see reacts to you. Everything you hear is either a real
public-domain recording or synthesized live in Web Audio in response to what you do.

---

## 1. Design pillars

1. **The world answers.** Every gesture has an immediate, layered response: light,
   sound, motion. Nothing is decorative-only; the sky, the water, the creatures all
   listen.
2. **Real artifacts, honestly used.** The sky is ESO's Milky Way panorama
   (CC BY 4.0, Serge Brunier) with every naked-eye star from the Yale Bright Star
   Catalog placed at its true position and tinted by its true colour. Sounds come
   from CC0 recordings or are synthesized. Credits live in `CREDITS.md`.
3. **Hands only.** Pinch, touch, sweep, hold still. No menus, no buttons, no laser
   pointers. The body is the controller.
4. **Comfort is beauty.** 72 fps on Quest 2, a floor under your feet, slow motion,
   soft light. Nothing pops into your face. Locomotion is optional and gentle.
5. **Never finished, never empty.** Lanterns keep arriving from the far shore; the
   sky keeps turning; the music never loops. Ten minutes or an hour both work.

## 2. The experience, minute by minute

- **0:00** Black fades to a still lake. Water at your waist (the level adapts to
  your height at session start so it's always within reach). Stars everywhere,
  doubled in the water. A crescent moon low over the far hills, its reflection a
  path across the lake. Wind, crickets, water lapping. A soft pad chord, barely there.
- **0:10** A hint floats in front of you: *touch the water*. Your hands are
  translucent glass, rimmed with light. Lowering one into the lake tints it cyan
  and a bloom of plankton light spreads from your fingers; the ripples carry the
  glow outward and it lingers for a few seconds. A soft water swish follows your
  hand's speed.
- **0:30** Lanterns are bobbing within reach. *pinch to lift one*. It follows your
  hand, warm light on your fingers, a faint paper-and-flame crackle. Let it go
  above the water and it rises — slowly, drifting on the wind — and the aurora
  brightens for a while. At the top of its climb it becomes a new, permanent
  star in your sky.
- **1:00** Fireflies notice you. Hold a hand open and still above the water and
  they drift over and settle on your fingers and knuckles, each landing with a tiny bell
  note. Move fast and they scatter.
- **1:30** Lotus buds float nearby. Touch one: it opens, glows in its own colour,
  and plays a note from a pentatonic scale. Open several and they form a chord
  that folds into the music. They close again after a minute.
- **2:00+** Sweep a submerged hand and you glide through the water in the
  opposite direction (wading). Far away are reed beds, a small islet, the shore
  hills with their pines against the sky. The whole time the sky turns (about
  15× real sidereal rate — the Milky Way visibly rises over ten minutes).

## 3. Interaction model (hand tracking)

The water sits inside the headset's hand-tracking cone: after a 1 s calibration the rig is offset so
the surface is 0.60 m below the eyes standing (0.45 m seated, detected from eye height < 1.35 m). If the
player sits down or stands up later the rig re-baselines over 15 s so the water never visibly moves.

| Gesture | Detection | Response |
|---|---|---|
| Hand in water | any tracked joint below water level (1 cm hysteresis) | real rings: every submerged joint pushes the wave simulation with a zero-mean kernel (a crest and a trough, so the water is displaced, never piled up) and the 12 m patch of surface around the player is vertex-displaced by the result; the plankton glow sits where the hand actually shears the water and trails behind it, and the nearest lanterns break into orange glints on the ripples; cyan tint and a meniscus line on the hand, water swish (volume ∝ speed), a "plip" on entry |
| Pinch-and-pull (the only locomotion) | thumb–index pinch with nothing within 13 cm, held ≥ 0.12 s, palm moved ≥ 6 cm (the dead zone: a pinch that merely missed a lantern never moves you) | the rig follows the palm one-to-one so the pinched spot stays under the fingers, above or below the water, seated or standing; letting go carries the momentum into a glide (drag 2/s, ≤ 1.6 m/s, a cushion of drag near the 48 m boundary); taking hold again eases a glide out; vignette ∝ pull speed, foveation 1.0 while moving. Both hands pinched: the midpoint pulls and, after a 4° dead zone, the world turns with the line between the hands, about their midpoint, so it stays under the hands (the head sweeps a little with it; the turn fades out when the hands are closer than 25 cm). Reaching, stroking or paddling through the water never moves you. |
| Pinch / grasp | Meta's pinch event OR index↔thumb < 2 cm for 2 frames (release: > 3.5 cm for 3 frames and no OS pinch), OR a whole-hand grasp (mean finger curl > 0.55) | grab nearest grabbable within 13 cm; a pinch with nothing in reach still answers with a spark and a soft tick |
| Release lantern | pinch ends while the lantern is above water | it hangs on an 8 cm string while held; released it rises (0.25→0.5 m/s), the aurora brightens once it is ~3 m up, a swell plays; ~25 s later it fades into fog and becomes a permanent star (persisted in localStorage); 0.8 s after any star is born a wave of firefly flashes rolls out across the lake from where you stand at walking pace (2.5 m/s, `lakewave`): every free firefly's next flash is timed to peak as the front reaches it and the clouds hold that pattern for 6 s, every open lotus brightens and restates its note as it passes, and the crickets fall quiet for a breath |
| Release lantern in water / tracking lost while holding | pinch ends below water, or the hand is lost for > 1 s | it floats again (never rises) |
| Open still hand | every finger curl < 0.35, filtered palm displacement < 3 cm over 0.5 s, above water; fireflies start turning toward it after 0.3 s and land after 1 s | fireflies land on the fingertips, knuckles and the heel of the thumb (a different spot each) with a bell each; they scatter when the hand moves > 0.35 m/s |
| Touch lotus bud | any fingertip within reach of a closed bud | bloom over 1.6 s + a pentatonic note made consonant with the current chord + glow + a ring on the water; all six open → a chord swell |
| Fingertip near a closed bud | the nearest fingertip of a visible, dry hand that is neither pinching nor grabbing, within 35 cm of the bud; patience: that fingertip 9–22 cm from the bud (not touching) and the hand still | the bud leans toward the finger (up to 0.4 rad, pivoting at its base, in 0.6 s and back in 1.2 s) and its halo warms; after 0.6 s of stillness a thin rising whisper (`lotusstir`), at 2 s it opens by itself with a softer, longer note (`lotusbloom` cause 'patient'); touching it still opens it at once |
| Lantern set down among lily pads | a lantern you have carried (never one that homed in by itself), floating, lit and settled within 45 cm of a cluster for 2.5 s (out again beyond 55 cm) | the pads hold it (its drift drops to a quarter within 40 cm of the cluster), its light falls amber on the near side of the petals and warms the halo, the bud opens slowly over 5 s (`lotusbloom` cause 'lantern': the note swells in instead of striking, a smaller energy bump, a softer ring) and stays open until 10 s after the lantern drifts away |
| Touch a floating lantern | a hand that is neither pinching nor grasping (it need not be open), palm within 45 cm; any fingertip, knuckle or the wrist meets the paper flank (a joint above the rim or below the waterline never pushes) | the hull gives instead of letting the hand through: a slow hand rests it against the fingers (the hand pull eases out within 10–17 cm of the pinch point so it is not tugged into them), a brisk brush (> 0.35 m/s) sends it gliding off (≤ 0.7 m/s, decaying) with a slow spin, heeling away, the flame flaring and guttering; a ring spreads from the hull and a paper tap plays (`lanterntouch`, once per fresh contact, at most every 0.25 s per lantern) |
| Slow open hand, palm up | open, above water, not pinching or grabbing, palm normal.y > 0.15, not still, moving 5–35 cm/s mostly sideways for 0.5 s (a pause or a tracking blip under 0.4 s is forgiven) | fireflies peel off the nearest cloud one every 0.3 s (up to 16, fewer on Quest 2) and string out 8 cm apart along the path the hand has taken, 9 cm above the palm, each chiming as it takes its place (`fireflyfollow`; a soft two-note hand voice swells with the strand); they stay while the hand is open, dry and under 0.5 m/s — stop, and the nearest of them land through the open-still rule; faster than that lets them go, and a fast hand scatters them as ever |
| Palm flat on the water | open, palm down (normal.y < −0.8), the palm joint between 5 cm below and 3 cm above the surface, still, not pinching or holding anything, for 0.6 s | a disc of glass-still water spreads from under the hand to 1.2 m over 3 s and follows the palm: the wave sim loses its momentum inside it so ripples die at its edge, the surface turns to a mirror and the stars come up through it, the plankton go dark inside and a thin ring of plankton light marks the spreading front; a low bowl note holds and raindrop notes fall while it lasts (`hush` / `hushend`); lifting the hand lets it dissolve over ~1.2 s. Two hands make two discs. |
| Release a lantern near fireflies | the ordinary release above the water; wandering fireflies within 3 m of the lantern and any landed or landing ones within 60 cm of it (the ones on the releasing hand) | up to ten lift off with it, nearest first (`fireflyescort`, a quick run of small bells), and spiral round the flame as it rises, the flame flaring with them; 4.2 s into the climb (or at once if it is caught again) they spill away as sparks (`fireflyspill`) and the cloud most of them came from is kicked into flashing together for a few seconds; the star it becomes sends the lake wave (see *Release lantern*) |
| Calm | head and hands still, not wading (ctx.calm rises 0.25/s); both palms submerged and still is a bonus | ripples damp faster, the plankton breathe softly around you, a low drone fades in |
| Tracking loss | wrist or index tip pose missing | hands dissolve over 350 ms instead of freezing; velocities are zeroed for 3 frames on reacquire; the Quest system menu (visible-blurred) freezes gestures and fades the audio |
| Leave | both palms pressed together (palms within 9 cm, each facing the other), above the water, no pinch; one hand may drop out for 0.5 s | after 15% of the hold the water writes "keep your palms together to leave"; the view darkens from a third of the way in; at 2.5 s the session ends and the landing page says how long you stayed and how many stars you left. Letting go undoes it in under a second. |

Reach: the player cannot move until they discover pulling, so one lantern
(front-right, ~0.55 m) and one lotus cluster (front-left, ~0.65 m) start within
arm's length, arriving lanterns come all the way in while nothing floats within
1 m, and whenever fewer than three lanterns float within reach every floating
lantern within 16 m homes slowly toward the player (5–14 cm/s, easing to a stop at
0.7 m) — the lake comes to you, so nobody has to travel to send a lantern off.
Hints ("put a hand in the water", "pinch a lantern to lift it", …) are written in
plankton light on the surface only when the player has evidently not found the
thing, gated on what is actually within reach; a hint counts as learned only when
the thing is done (persisted for 24 h), otherwise it may return a couple of times.
Holding controllers, or hand tracking being off, gets its own message.
Round four added four hints: "leave a lantern among the lily pads" (from 130 s, once a
lantern has been lifted and a bud opened, with a bud and a lantern both within reach;
learned on a lantern-caused bloom), "rest a hand flat on the water and be still" (from
140 s, once the water has been touched; learned only when a hush has fully taken, strength
≥ 0.8), "move an open hand slowly and they follow" (from 130 s, once the water has been
touched; learned on the first firefly to take its place in a ribbon) and "let a lantern go
with fireflies on your hand" (from 200 s, once a firefly has landed and a lantern has been
released, with a lantern within reach; learned when three or more escort one). The lean and
the nudge have no hint: the bud turning to the finger and the hull giving under it are the
invitation.

Why these six: they add no new verbs. Each gives one of the three things players already
love — the lanterns, the lotus, the fireflies — more to do with the hands they already use,
and each gate is disjoint from the four gestures that already carry meaning. Pinch-and-pull
and grab: every new gate excludes a pinching or grabbing hand, so pulling the world or
carrying a lantern past a bud does nothing new. Leave: it needs two hands above the water,
still, palms facing each other; a hush hand is palm-down on the surface, a ribbon hand is
palm-up and moving. Landing: an open still hand still means *land*; the ribbon needs the
hand to be moving, and stopping simply hands the strand over to the landing rule. The lean,
the nudge and the escort have no gesture of their own at all — they answer what the hand
was doing anyway. None of the six adds a draw call.

Desktop fallback (also used by the headless test harness): right-drag / Q,E to
look + WASD, a virtual right hand on a plane 0.55 m in front of the camera that
follows the mouse; left button = pinch; hold `Shift` to dip the hand into the water.

## 4. Visual design

Palette: near-black blue-green water (#04101a), plankton cyan (#5cf0ff → #9fffe0),
lantern amber (#ffb257 → #ff7a1a), aurora green→teal→magenta (#42ff9c, #35d5c8,
#c46bff), moon (#ffe9c4), star colours from B−V. Fog colour #060a12.

- **Sky**: 4096×2048 JPEG of the ESO panorama on a sphere (r≈900 m), galactic
  coordinates mapped u = 0.5 − l/360, v = 0.5 − b/180 (verified against catalog
  stars). Catalog stars as additive point sprites on the same sphere: size from
  Vmag, colour from B−V, gentle per-star twinkle. Whole celestial sphere rotates
  about a pole tilted for latitude ≈ −30° (the photo was made from Chile/La Silla).
  Galactic centre starts ~35° above the horizon in front of the player.
- **Moon**: waxing crescent (real NASA-derived moon texture from three.js
  examples), lit as a sphere with earthshine, 21° up to the right (west); it sets a
  few minutes in — the lake goes darker, the plankton read brighter, and a meteor
  shower follows for a minute and a half. Halo sprites; a dim directional light while up.
- **Sky alignment**: the ESO mosaic is rotated ~3.8° relative to true J2000 galactic
  coordinates; the asset pipeline measured it on 92 bright stars and the correction
  matrix (`assets/sky/sky.json`) is applied in the dome and reflection shaders so every
  catalog sprite sits on its photographic star.
- **Meteors**: a pool of additive line streaks along great circles, one every 2–3
  minutes at rest, more when the sky is active.
- **Water**: two meshes sharing one shader: a large flat far plane, and a 12 m
  near patch (128²/160² segments) that follows the head and whose vertices are
  displaced by the wave simulation (3.5 cm per unit of height), so rings from your
  fingers are geometry, not just lighting; the far plane discards fragments inside
  the patch. Normal = three scrolling samples of a real water normal map + the
  slope of the displaced surface (×2.5 so rings read at night). Reflection samples
  the sky panorama equirectangularly along the reflected view vector, mixed with
  deep-water colour via Schlick Fresnel. Up to four nearby lanterns are point
  lights whose specular lobes break up on the ripples (orange glints, Schlick on
  the half vector). Bioluminescence: emissive cyan from the sim's energy and
  slow-decay "afterglow" channels, gathered on the ripple slopes. Exponential fog.
  Opaque-with-alpha layering: underwater things render first (renderOrder 1),
  water second (renderOrder 2, alpha 0.88), things above water after (renderOrder 3+).
- **Wave simulation**: GPGPU ping-pong, 512² (384² on Quest 2), wave equation with
  damping (0.98, rings travel ~0.7 m before fading), tiling world-space (tile = 16 m;
  uv = fract(xz / 16)), up to three substeps on long frames. Up to 16 disturbance
  points per frame (hand joints + head column), each a Laplacian-of-Gaussian
  kernel so it displaces water without adding volume. Channels: R = height,
  G = previous height, B = afterglow, A = energy. Energy comes from the injection
  itself (how hard something pushes here) plus a little from steep, fast crests —
  never from the rings that travel on, so the light stays with the hand while the
  geometry spreads across the lake.
- **Mirror trick for reflections of emissive objects**: lanterns, fireflies, lotus
  glow and the aurora draw a mirrored, dimmer copy below the water plane
  (renderOrder 1, additive) — cheap, convincing, no planar-reflection pass.
- **Hands**: `XRHandModelFactory` mesh model with a custom material: translucent
  glass (fresnel rim, cool white), tinted cyan below the water line, plus additive
  fingertip sprites. Fully unlit.
- **Aurora**: 4 curtain ribbons (r≈800 m, height 150–400 m) with fbm noise, vertical
  streaks, green→teal→magenta gradient, additive, intensity driven by `energy`.
- **Lanterns**: instanced paper cylinders with emissive gradient + flame flicker,
  additive glow sprite, mirrored glow. ≤ 24 active.
- **Fireflies**: 300 additive points, wander + attraction, mirrored copy. Each sprite is
  a light, not an insect: a Lorentzian halo (0.12 m) around a small saturated core that never
  clips to white, warming toward amber at the peak. Flashes are Photinus-shaped (0.15 s rise,
  0.5 s decay, a faint ember between) and each home cloud drifts into and out of near-synchrony
  over 26–41 s via a cheap mean-field phase nudge; landed fireflies glow steadily.
- **Drips**: when a hand comes up out of the water, plankton-lit droplets fall from the wet
  fingertips and knuckles for about a second (a 256-slot point pool, one draw call only while
  any droplet lives); each one that lands pushes a tiny ring into the wave sim and emits
  `drip` (rate-limited) for a faint plip.
- **Leave**: no menu; pressing both palms together and holding for 2.5 s darkens the view and
  ends the session (see the interaction table).
- **Hush**: no geometry; the two circles (one per hand) reach the wave sim and the surface shader
  as two vec4 uniforms each. Inside a circle the sim damps velocity ×0.3 and height ×0.85 per step,
  the surface normal is flattened (×0.08), the Fresnel term is lifted to ≥ 0.32 so the stars and the
  aurora come up through the disc at the steep viewing angle, the bioluminescence is cut to a tenth
  and a thin plankton ring rides the spreading edge (fading as the disc grows); a full hush also
  counts as 0.6 calm for the damping.
- **Lotus**: instanced pads + buds; petals open via a per-instance `bloom` attribute
  in the vertex shader; glow sprite. The lean toward a finger is a base-pivot rotation in the
  instance matrix (the bud, touch target and halo follow it); a per-instance `aLantern`
  (position, weight) lights the petals amber on the side facing the brightest lantern within
  60 cm, moon-pale on the other.
- **Shore**: ring heightfield (noise) r 60–140 m, dark material with rim from the
  moon; ~600 instanced pines; reed patches; an islet at ~12 m. Mist: ~40 soft
  additive sprites drifting at water level.

Performance budget (Quest 2): ≤ 60 draw calls, ≤ 250 k triangles, no
post-processing, no shadows, one 384²/512² compute pass, textures ≤ 40 MB GPU,
foveation 0.5 at rest / 1.0 while gliding, framebuffer scale 1.0. Measured in the
harness with everything on: 60 draw calls, ~115 k triangles, ~28 k points.
Tone mapping is Neutral (ACES pushed the cyan/amber glows to white); every custom
shader ends with the tone-mapping/colour-space chunks and the sky/water dither.

## 5. Sound design

All audio runs through one `AudioContext` created *synchronously* in the Enter VR
click (so the transient activation is still valid for `requestSession`); samples
decode after the session starts and the subsystems begin with a 6 s master fade.
Graph: bed / world / music / chimes buses → master → compressor → tanh soft
limiter → output, with a parallel convolution reverb (procedural 4.5 s IR that
darkens over its tail, pre-delay 30 ms) fed by per-bus sends. Spatial sounds use
Three.js `AudioListener`/`PositionalAudio` (PannerNode), equal-power except the
two hands (HRTF). Music lives in D Dorian and only uses chords the D minor
pentatonic is always consonant with; lotus and firefly notes are checked against
the current chord. The Quest system menu blurs the session: audio fades out and
back.

- **Bed**: real CC0 wind recording (felix.blume) with slow gain LFO; synthesized
  crickets (several "individuals": band-passed noise bursts ≈4.2 kHz at slightly
  different rates, panned around); synthesized water lapping (low-passed noise
  swelling with local wave energy).
- **Music**: a generative engine in D Dorian/pentatonic: slow pad chords (detuned
  saw+triangle through a low-pass, 12–20 s per chord, never the same voicing
  twice), sparse "raindrop" notes when the world is calm, and the real CC0 pad
  samples (*Bioluminescence – Watery Pad*, *Swimming in the Northern Lights –
  Swell Pads / Brilliant Lights*, Ben Burnes) pitch-matched and used as swells on
  big events (lantern ascent, full lotus chord).
- **Chimes**: FM bells (pentatonic, position-panned) for lotus and firefly
  landings; real ceramic-bowl/bell samples layered for variety.
- **Round four**: a bud stirring under a still fingertip is a thin rising band-passed whisper two
  octaves above its note; a patient bloom rings softer and longer, a lantern-warmed one swells in
  over 0.35 s. A hand meeting a lantern is a 900 Hz paper tap, louder for a brisk brush. A hush is a
  6 s ceramic bowl on the chord root (120 ms attack, half wet) with a real bowl an octave up, and
  raindrop notes fall 3–7 s apart while it holds (the calm drone counts a hush as calm). The ribbon
  rings a glass bell for the first and the eighth firefly to take its place, and a per-hand hand
  voice (two sines on the chord's root and fifth two octaves up, low-passed) swells at the strand's
  centroid as it fills. The escort is a run of up to five small ascending bells, the spill four falling
  ones and a brief hiss; the lake wave restates every open lotus note as the front reaches it under
  one soft breath while the crickets fall quiet for 2–4 s.
- **Water**: per-hand band-passed noise, gain from submerged speed, positioned at
  the hand. Lantern: soft crackle loop (filtered noise crackles) on the nearest 4.
- **Aurora**: a high, slowly shimmering pad whose level follows `energy`.

## 6. Architecture

Plain ES modules, no build step. `index.html` uses an import map to a vendored
Three.js (`vendor/three/`). Deployable as static files from the repo root.

```
index.html               landing page + canvas + import map
src/main.js              boot, loop, module registry
src/config.js            tunables (water level, tile size, colours, budgets)
src/core/xr.js           session, reference space, foveation, hand-tracking feature
src/core/player.js       rig (Group), desktop controls, wading, vignette
src/core/hands.js        joints, pinch, open-still detection, custom hand material, mouse hand
src/core/assets.js       loaders + manifest
src/core/events.js       tiny emitter
src/world/sky.js  wavesim.js  water.js  aurora.js  plankton.js  drips.js  fireflies.js  leave.js
          lanterns.js  lotus.js  shore.js  mist.js  hush.js  hints.js
src/audio/engine.js  ambience.js  music.js  sfx.js
src/shaders/*.js         GLSL as template strings
assets/                  sky, stars, textures, audio, hands, fonts
vendor/three/            three.module.js, three.core.js, addons/
tools/                   asset pipeline (python) + headless test harness (playwright)
```

### Shared context (`ctx`)

```js
ctx = {
  renderer, scene, camera, player /* Group; camera is its child */,
  time: { t, dt, frame },
  water: { level, tileSize, simTexture /* THREE.Texture */, swell(x, z, t) /* CPU analytic bob, metres */ },
  hands: {
    left, right,   // HandState
    any(fn),       // helper
  },
  energy,          // 0..1 world excitement, decays 0.02/s
  events,          // emitter: 'pinchstart' {hand}, 'pinchend' {hand}, 'lotusbloom' {index, note, pos, color, cause, hand},
                   //          'lotusstir' {index, note, pos, hand}, 'lanternrelease' {pos, hand, lantern}, 'lanternstar' {dir, pos, lantern},
                   //          'lanterntouch' {pos, hand, lantern, speed}, 'fireflyland' {pos, hand, joint, index},
                   //          'fireflyfollow' {hand, pos, count}, 'fireflyescort' {pos, count, lantern}, 'fireflyspill' {pos, count, lantern},
                   //          'lakewave' {pos, count}, 'hush' {hand, pos}, 'hushend' {hand}, 'xrstart', 'xrend'
  audio,           // AudioEngine (see src/audio/engine.js)
  assets,          // loaded textures/buffers/geometries by key
  grabbables,      // array of { position: Vector3, radius, onGrab(hand), onRelease(hand, velocity) }
  quality: { tier: 'quest2' | 'quest3' | 'desktop' }
}

HandState = {
  visible, handedness,
  joints: { [jointName]: { position: Vector3, radius } },   // 25 WebXR joints
  palm: { position, normal, velocity },                       // from middle-finger-metacarpal
  tips: [index, middle, ring, pinky, thumb] positions,
  speed, submergedDepth /* metres below water, 0 if above */, submerged,
  pinch: { active, justStarted, justReleased, point: Vector3, strength },
  openStill: boolean, stillFor: seconds,
  grabbed: object | null,
}
```

Every world/audio module exports `{ name, init(ctx), update(ctx, dt) }` and is
registered in `src/main.js`. Modules only talk through `ctx` and `ctx.events`.

Cross-module fields added in round four (each is named in both file headers):

- `lotus.js`: `openFlower(i, opts)`, exposed as `ctx.lotus.open(i, { cause: 'touch' | 'patient' | 'lantern',
  hand, openSeconds })`; `'lotusbloom'` carries `cause` and `hand`, and a lantern-caused bloom bumps energy
  by 0.08 with a softer ring. Flower records gain `lean`/`leanX`/`leanZ`/`hoverT`, `warm`/`warmNear`/`lanternIdx`,
  `openSeconds` and `waveAt` (when the lake wave's front reaches that flower). `lanterns.js` reads
  `ctx.lotus.clusters` to know where the pads are.
- `lanterns.js`: lantern records gain `touched` (has been in a hand — set on grab, cleared on respawn) and
  `amongPads` (held by a cluster this frame), which `lotus.js` reads to decide which lanterns may warm a bud;
  `push`, `spinKick` and `inContact` carry the nudge, and `ctx.lanterns.touches` counts touches. `fireflies.js`
  writes `L.escorts` (fireflies orbiting a rising lantern this frame; the flame flares with them, up to +30 % at
  four) and `L.spilled` (that escort has already spilled); `lanterns.js` resets both on grab and respawn.
- `fireflies.js`: states `WANDER = 0, APPROACH = 1, LANDED = 2, SCATTER = 3, ESCORT = 4, FOLLOW = 5`; ESCORT
  and FOLLOW are outside the synchrony pass and the landing paths and are cleared by every `releaseSlot`
  path (escort recruiting skips followers and vice versa). `ctx.fireflies` gains `followers` and
  `followArrived` (Int16Array(2), per hand), `followCentroid` (Float32Array(6)), `escortCount`, `kickedCloud`
  and `wave` (`fired, t0, ox, oz, speed, count, sample, sampleT` — what the harness reads back).
- `hush.js`: `ctx.hush = { strength, circles: [{ x, z, r, s, active }, …], count }`. `wavesim.js` allocates
  `ctx.water.hush = { data: Float32Array(8), strength }` (per hand: uv centre, uv radius, strength — bound
  directly as its `uHush` uniform) and `ctx.water.hushWorld` (Float32Array(8): world x, z, radius, strength,
  copied into the surface shader each frame); hush fills both every frame and throws at init if they are
  missing. Both shaders read the previous frame's values, so nothing depends on module order.

## 7. Testing

`tools/harness/` runs the site in headless Chromium (Playwright) in two modes:
desktop fallback, and a fake WebXR device (`fake-xr.js`) that implements enough
of the WebXR API (session, reference spaces, stereo views, `XRWebGLLayer`,
hand input sources with 25 animated joints) for Three.js's `WebXRManager` to run
the real VR code path. It fails on any console error or shader compile error and
saves screenshots for visual review.

`tools/harness/scenario.mjs` (`npm run scenario`) drives the fake headset through the whole
interaction loop and fails if any of its 36 steps does not happen, in this order: calibrated,
lantern-in-reach, lantern-grabbed, lantern-released, lantern-star, lantern-nudge-ready,
lantern-nudged, lantern-nudge-settles, lotus-leans, lotus-patient-open,
lotus-too-high-stays-closed, lotus-in-reach, lotus-bloomed, lantern-lotus-ready,
lantern-lotus-grabbed, lantern-lotus-set-down, lantern-warms-lotus, firefly-landed,
escort-lantern-ready, escort-lantern-grabbed, firefly-escort, firefly-spill,
spill-kicks-the-cloud, lake-wave, firefly-ribbon, ribbon-handoff, hush-circle-forms,
hush-stills-the-water, hush-dissolves, hush-no-new-draw-calls, stroke-does-not-move,
missed-pinch-does-not-move, pinch-pull-moves-rig, two-hand-turn, hand-swap-no-jolt,
leave-gesture-ends-session. Run it and the harness one at a time: two software-rendered
Chromium instances on four cores slow each other tenfold.
