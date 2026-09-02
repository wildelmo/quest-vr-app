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
  they drift over and settle on your fingertips, each landing with a tiny bell
  note. Move fast and they scatter.
- **1:30** Lotus buds float nearby. Touch one: it opens, glows in its own colour,
  and plays a note from a pentatonic scale. Open several and they form a chord
  that folds into the music. They close again after a minute.
- **2:00+** Sweep a submerged hand and you glide through the water in the
  opposite direction (wading). Far away are reed beds, a small islet, the shore
  hills with their pines against the sky. The whole time the sky turns (about
  15× real sidereal rate — the Milky Way visibly rises over ten minutes).

## 3. Interaction model (hand tracking)

| Gesture | Detection | Response |
|---|---|---|
| Hand in water | any tracked joint below water level | plankton glow + ripples, cyan tint on the submerged part of the hand, water swish (volume ∝ speed) |
| Sweep (wading) | palm submerged and moving > 0.35 m/s horizontally | player rig accelerates opposite to hand velocity (×0.35), drag 2/s, max 1.2 m/s, soft vignette while moving. Radius clamped to 50 m. |
| Pinch | index-tip ↔ thumb-tip < 2.0 cm (release at > 3.5 cm, hysteresis) | grab nearest grabbable within 12 cm of the pinch point |
| Release lantern | pinch ends while lantern is above water | lantern ascends (buoyancy + wind), aurora energy += 1, chime swell; on reaching the sky it becomes a star |
| Release lantern in water | pinch ends while below water | lantern floats again |
| Open still hand | palm up or forward, joint speeds < 0.15 m/s for 1.5 s, above water | fireflies approach and land on fingertips; "tink" per landing |
| Touch lotus bud | any fingertip within 8 cm of a bud | bloom + note + glow |
| Two hands submerged, still | both palms below water, still for 2 s | "calm": ripples damp faster and the plankton show a slow breathing glow around you (a reward for stillness) |

Desktop fallback (also used by the headless test harness): mouse-look + WASD,
a virtual right hand on a plane 0.5 m in front of the camera that follows the
mouse; left button = pinch; hold `Shift` to lower the hand into the water.

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
  examples), 12° altitude to the left; halo sprite; a dim directional light.
- **Water**: single large plane, custom shader. Normal = two scrolling samples of
  a real water normal map (1 m and 4 m tiles) + gradient of the wave simulation.
  Reflection samples the sky panorama equirectangularly along the reflected view
  vector, mixed with deep-water colour via Schlick Fresnel. Bioluminescence: emissive
  cyan proportional to wave energy, plus a slow-decay "afterglow" channel so trails
  linger ~3 s. Exponential fog. Opaque-with-alpha layering: underwater things
  render first (renderOrder 1), water second (renderOrder 2, alpha 0.88), things
  above water after (renderOrder 3+).
- **Wave simulation**: GPGPU ping-pong, 512², one pass per frame, wave equation
  with damping, tiling world-space (tile = 16 m; uv = fract(xz / 16)). Up to 16
  disturbance points per frame (hand joints + head column). Channels: R = height,
  G = previous height, B = afterglow.
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
- **Fireflies**: 300 additive points, wander + attraction, mirrored copy.
- **Lotus**: instanced pads + buds; petals open via a per-instance `bloom` attribute
  in the vertex shader; glow sprite.
- **Shore**: ring heightfield (noise) r 60–140 m, dark material with rim from the
  moon; ~600 instanced pines; reed patches; an islet at ~12 m. Mist: ~40 soft
  additive sprites drifting at water level.

Performance budget (Quest 2): ≤ 60 draw calls, ≤ 250 k triangles, no
post-processing, no shadows, one 512² compute pass, textures ≤ 40 MB GPU,
`renderer.xr.setFoveation(1)`, framebuffer scale 1.0.

## 5. Sound design

All audio runs through one `AudioContext` created on the first user gesture
(the Enter VR click), with a master bus → procedural convolution reverb (4 s
decaying noise IR) → compressor → destination. Spatial sounds use Three.js
`AudioListener`/`PositionalAudio` (PannerNode) so anything can be positioned.

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
src/world/sky.js  wavesim.js  water.js  aurora.js  plankton.js  fireflies.js
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
