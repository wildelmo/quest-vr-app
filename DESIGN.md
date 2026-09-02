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
| Pinch-and-pull (the only locomotion) | thumb–index pinch with nothing within 13 cm, held ≥ 0.12 s, palm moved ≥ 6 cm (the dead zone: a pinch that merely missed a lantern never moves you) | the rig follows the palm one-to-one so the pinched spot stays under the fingers, above or below the water, seated or standing; letting go carries the momentum into a glide (drag 2/s, ≤ 1.6 m/s, a cushion of drag near the 48 m boundary); taking hold again eases a glide out; vignette ∝ pull speed, foveation 1.0 while moving. Both hands pinched: the midpoint pulls and, after a 4° dead zone, the world turns with the line between the hands (about the head). Reaching, stroking or paddling through the water never moves you. |
| Pinch / grasp | Meta's pinch event OR index↔thumb < 2 cm for 2 frames (release: > 3.5 cm for 3 frames and no OS pinch), OR a whole-hand grasp (mean finger curl > 0.55) | grab nearest grabbable within 13 cm; a pinch with nothing in reach still answers with a spark and a soft tick |
| Release lantern | pinch ends while the lantern is above water | it hangs on an 8 cm string while held; released it rises (0.25→0.5 m/s), the aurora brightens once it is ~3 m up, a swell plays; ~25 s later it fades into fog and becomes a permanent star (persisted in localStorage) |
| Release lantern in water / tracking lost while holding | pinch ends below water, or the hand is lost for > 1 s | it floats again (never rises) |
| Open still hand | every finger curl < 0.35, filtered palm displacement < 3 cm over 0.5 s, above water; fireflies start turning toward it after 0.3 s and land after 1 s | fireflies land on the fingertips, knuckles and the heel of the thumb (a different spot each) with a bell each; they scatter when the hand moves > 0.35 m/s |
| Touch lotus bud | any fingertip within reach of a closed bud | bloom over 1.6 s + a pentatonic note made consonant with the current chord + glow + a ring on the water; all six open → a chord swell |
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
- **Lotus**: instanced pads + buds; petals open via a per-instance `bloom` attribute
  in the vertex shader; glow sprite.
- **Shore**: ring heightfield (noise) r 60–140 m, dark material with rim from the
  moon; ~600 instanced pines; reed patches; an islet at ~12 m. Mist: ~40 soft
  additive sprites drifting at water level.

Performance budget (Quest 2): ≤ 60 draw calls, ≤ 250 k triangles, no
post-processing, no shadows, one 384²/512² compute pass, textures ≤ 40 MB GPU,
foveation 0.5 at rest / 1.0 while gliding, framebuffer scale 1.0. Measured in the
harness with everything on: 58 draw calls, ~115 k triangles, ~28 k points.
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
          lanterns.js  lotus.js  shore.js  mist.js  hints.js
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
  events,          // emitter: 'pinchstart' {hand}, 'pinchend' {hand}, 'lotusbloom' {index, note, pos},
                   //          'lanternrelease' {pos}, 'lanternstar' {dir}, 'fireflyland' {pos}, 'xrstart', 'xrend'
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

## 7. Testing

`tools/harness/` runs the site in headless Chromium (Playwright) in two modes:
desktop fallback, and a fake WebXR device (`fake-xr.js`) that implements enough
of the WebXR API (session, reference spaces, stereo views, `XRWebGLLayer`,
hand input sources with 25 animated joints) for Three.js's `WebXRManager` to run
the real VR code path. It fails on any console error or shader compile error and
saves screenshots for visual review.
