# NOCTURNE — a night on the water

A hand-tracked WebXR experience for Meta Quest. No controllers, nothing to install: open a web page
in the Quest Browser and press *Enter VR*.

You stand waist-deep in a still lake under the real night sky — ESO's Milky Way panorama with every
naked-eye star from the Yale Bright Star Catalog at its true position. The water lights up where your
hands move through it. Paper lanterns drift by; pinch one and let it go, and it climbs into the sky,
the aurora answers, and it becomes a new star in your sky. Fireflies land on a hand held open and
still. Lotus buds open when you touch them and each one sings a note that fits the music. Your fingers
raise real ripples that the lanterns' light breaks up into glints. To move, pinch the water (or the air)
where nothing is in reach and pull it toward you; let go and you glide. Lanterns also drift over to you
whenever fewer than three are within arm's length.

Everything you hear is either a public-domain recording or synthesized live in Web Audio in response
to what you do. See [DESIGN.md](DESIGN.md) for the full design and [CREDITS.md](CREDITS.md) for
sources and licenses.

## Try it on a Quest

1. Publish the site (below) or serve the repo root over HTTPS. WebXR needs a secure origin.
2. On the headset: put the controllers down and turn on **Hand Tracking**
   (Settings → Movement Tracking → Hand and Body Tracking). Good room light helps the cameras see your hands.
3. Open the page in the **Quest Browser** and press **Enter VR**. Works standing or seated
   (the water level adapts to your height). Sound on.

What to do in there: dip a hand in the water · pinch a lantern and let it go above the water · hold a
hand open and still · touch a lotus bud · push the water with your palm to drift · stay still for a while.

## Publish with GitHub Pages

The site is plain static files (no build step). Two ways:

- **GitHub Actions (recommended):** in the repository go to *Settings → Pages → Build and deployment*
  and set *Source* to **GitHub Actions**. The workflow in `.github/workflows/pages.yml` publishes on every
  push to `main` (or run it manually from the Actions tab on any branch). The URL is
  `https://<owner>.github.io/<repo>/`.
- **Deploy from a branch:** set *Source* to *Deploy from a branch*, pick the branch and `/ (root)`.
  A `.nojekyll` file is included so nothing gets filtered.

## Run locally

```bash
npm install                 # only needed for the test harness (Playwright)
npm run serve               # http://localhost:8787
```

Open it in a desktop browser for a mouse-and-keyboard preview (right-drag or Q/E to look, WASD to wade,
the mouse is your right hand, click to pinch — and pinch-drag with nothing in reach to pull yourself
along — hold Shift to dip the hand into the water). To try it on a headset from
a local server you need HTTPS or the Chrome remote-debugging port forward to the Quest.

## Test harness

`npm run harness` runs the whole app in headless Chromium: the desktop mode and then a **fake WebXR
device** (`tools/harness/fake-xr.js`) with two animated tracked hands that dip, sweep, pinch and hold
still, driving the real WebXR code path. It fails on any console error or shader compile error and
writes per-eye screenshots and stats to `tools/harness/out/`. See `tools/harness/README.md`.

## Layout

```
index.html            landing page, import map, canvas
src/main.js           boot + frame loop + test hooks (window.__nocturne)
src/core/             xr session, player rig (calibration, wading, comfort), hands (tracking, pinch, grabs)
src/world/            wave sim (GPGPU), water, sky (panorama + catalog + moon), aurora, plankton,
                      fireflies, lanterns, lotus, shore, mist, hints
src/audio/            engine (buses, reverb), ambience, generative music, sfx
assets/               sky (4k/2k panorama, star catalog), textures, audio (OGG), hand models, fonts
vendor/three/         three.js r185 + the addons used (import map, no bundler)
tools/assets/         reproducible asset pipeline (Python)
tools/harness/        Playwright harness + fake WebXR device
```

## Performance notes (Quest 2)

One 384²/512² wave-sim pass, 58 draw calls, ~115k triangles and ~28k points with everything on
(measured in the harness), no post-processing, no shadows, foveation 0.5 at rest and 1.0 while gliding,
72 Hz target. Quest 2 gets the 2k panorama and fewer particles; Quest 3 and desktop get the 4k panorama.

`npm run scenario` drives the fake headset through the whole interaction loop (grab a lantern, let it go,
watch it become a star; touch a lotus; hold still for a firefly; paddle; pinch and pull the world) and
fails if any step does not happen.
