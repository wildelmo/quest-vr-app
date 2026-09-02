# NOCTURNE headless test harness

Runs the site in headless Chromium (Playwright + SwiftShader WebGL) in two modes —
the desktop fallback and a **fake WebXR device** — and fails on anything that
would be a bug on a Quest: page errors, `console.error`, shader compile errors,
WebGL errors, 404s. Screenshots are saved for visual review.

```
tools/harness/
  run.mjs        CLI entry point (npm run harness)
  serve.mjs      dependency-free static server for the repo root (npm run serve)
  fake-xr.js     fake WebXR Device API, injected before any page script
  fixtures/minimal/   tiny Three.js scene implementing the window.__nocturne contract
  out/           default output dir (git-ignored via its own .gitignore)
```

## Running

```sh
npm install                       # playwright 1.56.1 only; browsers are preinstalled (PLAYWRIGHT_BROWSERS_PATH)
npm run harness                   # tests /index.html (the real app)
npm run harness:fixture           # tests tools/harness/fixtures/minimal — validates the harness itself
node tools/harness/run.mjs --url /index.html --frames 240 --out tools/harness/out
node tools/harness/serve.mjs 8787 # just serve the repo root (http://127.0.0.1:8787/)
```

Options for `run.mjs`:

| flag | default | meaning |
|---|---|---|
| `--url <path>` | `/index.html` | page to test, relative to the repo root (`?harness=1` is appended) |
| `--frames <N>` | `240` | XR frames to render; the hand timeline is spread evenly over them |
| `--out <dir>` | `tools/harness/out` | where screenshots and `summary.json` go |
| `--no-xr` | | desktop phase only |
| `--timeout <ms>` | `90000` | budget for `window.__nocturne.ready` (SwiftShader is slow) |
| `--timeline <file>` | | extra script injected before the page; see *Timeline scripts* |
| `--shots <s,s,..>` | `3,7,11,14` | timeline seconds at which XR screenshots are taken |
| `--headless-shell` | | use Chromium's headless shell instead of the new headless mode |
| `--verbose` | | echo console messages while running |

Exit code is `0` on PASS, `1` on FAIL. Progress goes to stderr, the summary JSON
to stdout, and everything (including every console message) to `out/summary.json`.

## What a run does

1. Starts `serve.mjs` on a free port, launches Chromium
   (`--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader …`),
   1600×800 viewport, device scale factor 1, and injects `fake-xr.js` with
   `page.addInitScript` so `navigator.xr` exists before the app boots.
2. Opens the page with `?harness=1` and waits for `window.__nocturne.ready`.
3. Desktop phase: `desktop_0.png` (default look), `desktop_1.png`
   (`look(90, 10)`), `desktop_2.png` (`look(-60, -25)` with
   `setHand({x: 0.6, y: 0.6, pinch: true, submerged: true})`), calling
   `setTime(0 / 15 / 30)` between shots.
4. XR phase: `enterXR()`, waits for `stats().xr === true`, switches the fake
   device clock to manual (`duration / frames` seconds per frame, so results do
   not depend on how fast SwiftShader renders), runs N frames and takes
   `xr_t3.png`, `xr_t7.png`, `xr_t11.png`, `xr_t14.png` when the timeline passes
   those seconds. Each XR screenshot shows both eyes side by side (left | right).
5. `exitXR()`, checks `stats().xr === false`, writes `summary.json`:
   `{ ok, errors, warnings, stats: {ready, desktop_*, xr_t*, afterExit}, screenshots,
   timings, playwright, fakeXR: {frames, events, warnings}, console }`.

### Failure conditions

- any `pageerror` (uncaught exception, including inside animation-frame callbacks)
- any `console.error`
- any console text containing `THREE.WebGLProgram`, `Shader Error`,
  `WebGL: INVALID`, `GL_INVALID`, `404` (as a word), or `Failed to load`
- any failed request or HTTP status ≥ 400 (assets must be local — `cdn.jsdelivr.net`
  is blocked in CI, so `XRHandModelFactory`'s default mesh path will fail;
  use `setPath('/assets/hands/')`)
- `ready` timeout, `enterXR()`/`exitXR()` failing, the XR loop stalling
- anything the app reports in `stats().errors`

Warnings (do not fail the run): `console.warn`, aborted requests (media element
cancellations), fake-device notes such as *hand-tracking feature not requested*.

## The app contract

The page must expose `window.__nocturne` (see DESIGN.md §7):

```js
window.__nocturne = {
  ready,                 // Promise: assets loaded and first frame rendered
  enterXR(), exitXR(),   // same as the Enter VR button: navigator.xr.requestSession('immersive-vr', …) + renderer.xr.setSession
  look(yawDeg, pitchDeg),
  setHand({ x, y, pinch, submerged }),
  setTime(seconds),
  stats() // { frame, drawCalls, triangles, programs, geometries, textures, fps, xr, energy, errors: [] }
};
```

For hand velocity to be deterministic in XR, derive `dt` from the `time`
argument of `renderer.setAnimationLoop((time, frame) => …)` — the fake device
advances that timestamp in lockstep with its timeline. `THREE.Clock` /
`performance.now()` measure SwiftShader's real frame time instead.

## The fake WebXR device (`fake-xr.js`)

Implements enough of the WebXR Device API + Hand Input for Three.js r185's
`WebXRManager`/`WebXRController` and the `XRButton`, `VRButton`,
`XRHandModelFactory` (spheres/boxes/mesh) addons:

- `navigator.xr`: `isSessionSupported` (true for `immersive-vr` and `inline`),
  `requestSession`, `offerSession` (pending until `__fakeXR.acceptOffer()`),
  `devicechange`/`sessiongranted` listeners.
- `XRSession` (an `EventTarget`): `renderState` without a `layers` property (so
  Three.js takes the `XRWebGLLayer` path; `XRWebGLBinding` is explicitly
  undefined), `updateRenderState`, `requestReferenceSpace` for `viewer`, `local`,
  `local-floor`, `bounded-floor` (3×3 m bounds) and `unbounded`, offset
  reference spaces, `requestAnimationFrame`/`cancelAnimationFrame` driven by the
  window's rAF, `inputSources`, `visibilityState`, `environmentBlendMode`,
  `interactionMode`, `enabledFeatures`, `supportedFrameRates` (72, 90),
  `frameRate`, `updateTargetFrameRate`, `isSystemKeyboardSupported`, `end()`,
  `on*` handler attributes, and `select`/`selectstart`/`selectend` events fired
  on pinch (index-tip ↔ thumb-tip < 1.5 cm, release > 3 cm).
- `XRWebGLLayer`: `framebuffer = null` (the canvas), 1600×800 by default
  (`__fakeXR.config.framebufferWidth/Height`), `getViewport(view)` = left/right
  half, `fixedFoveation`, `getNativeFramebufferScaleFactor`.
  `WebGL(2)RenderingContext.prototype.makeXRCompatible` resolves.
- `XRFrame`: `getViewerPose` (two eyes, ±IPD/2 = 0.032 m, symmetric 90° FOV,
  near/far from `renderState`), `getPose`, `getJointPose`, `fillPoses`,
  `fillJointRadii`; returns `null` for an unready/foreign reference space.
- Two hand input sources (`handedness` left/right, `targetRayMode`
  `tracked-pointer`, `profiles ['generic-hand','generic-trigger']`,
  `gamepad null`, `hand` = Map-like with the 25 joints in spec order, each an
  `XRJointSpace` with `jointName`), connected on the 2nd frame via
  `inputsourceschange`.
- Global constructors `XRSession`, `XRFrame`, `XRSpace`, `XRReferenceSpace`,
  `XRBoundedReferenceSpace`, `XRJointSpace`, `XRHand`, `XRInputSource`, `XRView`,
  `XRViewerPose`, `XRPose`, `XRJointPose`, `XRRigidTransform`, `XRWebGLLayer`,
  `XRSessionEvent`, `XRInputSourcesChangeEvent`, `XRInputSourceEvent`, so
  `instanceof` and feature checks pass.

Coordinates are WebXR metres, +Y up, −Z forward; the world frame is
`local-floor` (floor at y = 0, head at (0, 1.6, 0)). The hand skeleton is
procedural: wrist at the origin, fingers along −Z, back of the hand +Y (palm
faces −Y when palm-down), thumb on the −X side for the right hand, mirrored for
the left. Joint orientation: −Z along the bone toward the fingertip, +Y toward
the back of the hand. Radii: 2 cm wrist, ~1.3 cm metacarpals, ~0.75 cm tips.

### Default timeline (15 s)

| t (s) | right hand | left hand (mirrors with 1 s lag, never below y = 1.0) |
|---|---|---|
| 0–2 | rest by the hips (0.25, 0.9, −0.3) | rest (−0.25, 1.0, −0.3) |
| 2–5 | raises to (0.25, 1.2, −0.45) | follows |
| 5–6 | dips to y = 0.6 (water is at 0.9), fingers tilt down | stays at y = 1.0 |
| 6–9 | sweeps x 0.3 → −0.3 → 0.3 at 0.4 m/s | mirrored sweep above water |
| 9–10 | rises to (0.25, 1.15, −0.45) | |
| 10–12 | pinches (10–10.5 s), thumb-tip and index-tip meet, holds | pinches at 11–13 s |
| 12–15 | releases, opens, turns palm up at (0.25, 1.3, −0.4), still | |

Head: (0, 1.6, 0), yaw sways ±5° with an 8 s period, pitch −30° (−40° while
the hand is in the water, −25° at the end) so the hands are in view.

### Control surface

```js
window.__fakeXR.clock                 // { mode: 'auto'|'manual', rate, step, time, set(t), advance(dt), pause(), resume() }
window.__fakeXR.timeline              // { fn, duration, name }
window.__fakeXR.setTimeline(fn, duration)
window.__fakeXR.setHead([x, y, z], yawDeg, pitchDeg, rollDeg)      // override until clearOverrides()
window.__fakeXR.setHandPose('right', { position: [x, y, z], yawDeg, pitchDeg, rollDeg, pinch: 0..1, curl: 0..1, spread: 0..1, visible })
window.__fakeXR.clearOverrides(); pause(); resume()
window.__fakeXR.frames                // frames delivered in the current session
window.__fakeXR.getState()            // last frame: head, per hand wrist/indexTip/thumbTip/pinchDistance/lowestJointY
window.__fakeXR.events                // select/selectstart log [{ t, type, hand }]
window.__fakeXR.warnings              // fidelity notes (e.g. features not requested)
window.__fakeXR.config                // framebuffer size, fov, ipd, frame rates, strictFeatures, …
```

`clock.mode = 'auto'` (default) follows wall-clock time × `rate`; the harness
switches to `'manual'` where every frame advances `clock.step` seconds. The
`time` passed to XR frame callbacks follows the fake clock.

### Timeline scripts

A timeline is a function `(t seconds) => { head?, left?, right? }`; missing
parts fall back to the rest pose, and `setHead`/`setHandPose` overrides win over
the timeline. Put one in a plain script and pass it with `--timeline`; it is
injected right after `fake-xr.js`, before the page loads:

```js
// my-timeline.js
window.__fakeXR.setTimeline(function stillHand(t) {
  return {
    head:  { position: [0, 1.6, 0], pitchDeg: -35 },
    right: { position: [0.25, 1.2, -0.45], rollDeg: 180, curl: 0.02 },   // open, palm up, still → fireflies
    left:  { visible: false },                                          // tracking lost
  };
}, 8);   // duration in seconds; --shots must fit inside it
```

```sh
node tools/harness/run.mjs --timeline my-timeline.js --frames 120 --shots 2,6
```

Inside a Playwright test you can also drive it directly:
`await page.evaluate(() => __fakeXR.setHandPose('right', { position: [0.2, 0.6, -0.4], pinch: 1 }))`.

## Known limitations

- **SwiftShader is slow.** A 1600×800 stereo frame of the full app can take
  hundreds of milliseconds; that is why the XR timeline is frame-driven, the
  `ready` timeout defaults to 90 s and the XR phase budget is 1.5 s × frames.
  `fps` in `stats()` is meaningless here.
- **No real hand tracking.** Joints come from a stylised procedural skeleton
  (plausible lengths, curl/pinch/spread parameters), not from a tracked hand:
  no jitter, no occlusion, no tracking loss unless a timeline sets
  `visible: false`. Pinch distance snaps exactly to 0.
- Symmetric 90° per-eye projection, no asymmetric Quest frustums, no
  `recommendedViewportScale`, no `XRWebGLBinding`/layers/depth-sensing/anchors/
  hit-test, no `linearVelocity` on poses, no controllers or gamepads,
  `requestSession` needs no user activation.
- `updateRenderState` applies immediately (a real device applies it next frame).
- Chromium on Linux has no WebXR at all, so everything XR-named on the page
  comes from `fake-xr.js`; do not use it to validate browser API conformance.
- Screenshots capture the page, not the compositor's view of a headset: the
  canvas shows the side-by-side `XRWebGLLayer` framebuffer plus any HTML overlay.

## Wave-simulation probe

`node tools/harness/sim-probe.mjs [--frames N] [--out dir]` runs the desktop mode, sweeps the virtual
hand through the water for N rendered frames, and writes `sim.png` (R = height, G = afterglow,
B = energy of the sim tile) plus `view.png` and prints tile statistics. Useful when tuning
`src/world/wavesim.js` — the numbers tell you whether glow is local to the hand or spreading.

## Interaction scenario

`npm run scenario` (`node tools/harness/scenario.mjs`) drives the fake device through the hero
interactions with the real app: calibration, grabbing the nearest lantern, lifting and releasing it
(it must rise and become a star, raising the aurora energy), touching the nearest lotus bud (it must
bloom), holding a hand open and still (a firefly must land) and a palm stroke under water (the rig
must glide). It prints PASS/FAIL per step, writes screenshots + `report.json` to
`tools/harness/out/scenario/`, and exits non-zero on any failure.
