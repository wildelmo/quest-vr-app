# NOCTURNE asset pipeline

Everything under `assets/` is generated from openly licensed sources by one script:

```sh
python3 tools/assets/build_assets.py              # all steps, verification, size table
python3 tools/assets/build_assets.py --only audio # sky | textures | audio | hands | fonts
```

Requirements: Python 3 with `numpy`, `scipy`, `pillow`, `imageio-ffmpeg` (its bundled ffmpeg has
libvorbis). Network access is needed only for the fonts step (fonts.googleapis.com / fonts.gstatic.com);
if it fails, `assets/fonts/fonts.css` falls back to system fonts. Source locations default to
`/home/user/assets-src`, `/home/user/mrdoob/three.js/examples/textures` and the unpacked
`@webxr-input-profiles/assets` package; override with `NOCTURNE_ASSET_SRC`, `NOCTURNE_THREE_TEXTURES`,
`NOCTURNE_HANDS_SRC`. The run writes `tools/assets/out/build_report.json` with every number quoted below.

Modules: `common.py` (paths), `sky.py`, `textures.py`, `audio.py`, `hands_fonts.py`, `build_assets.py`
(orchestration, verification, budgets: `assets/` <= 30 MB, `assets/audio` <= 12 MB). Attribution for all
sources is in the repo-root `CREDITS.md`.

## Sky (`assets/sky/`)

**Panorama.** `milkyway_4k.jpg` (4096x2048, 2.57 MB) and `milkyway_2k.jpg` (2048x1024, 0.50 MB) from the
ESO/S. Brunier panorama `eso0932a_highestQuality.tif` (6000x3000, embedded sRGB profile). Lanczos downscale,
JPEG quality 88 with 4:4:4 chroma (star colour fringes stay clean for +160 KB). The source's 0.5th
luminance percentile is exactly 0, so a linear levels lift maps black to 4/255 (white fixed) to keep JPEG
from crushing the deep sky; nothing else is graded.

**Mapping verification.** The panorama is in galactic coordinates. Eight candidate mappings were scored
by the mean panorama brightness in a 5x5 px window (on the 6000x3000 source) at the positions of the 92
catalog stars brighter than V 2.5, minus the mean at random longitudes with the same latitudes (this
baseline removes the bright galactic plane from the score):

| hypothesis | u | v (0 = top row) | score |
|---|---|---|---|
| **H1** | frac(0.5 - l/360) | 0.5 - b/180 | **+7.41** |
| H3 | frac(0.5 - l/360) | 0.5 + b/180 | +1.26 |
| H8 | frac(l/360) | 0.5 + b/180 | +0.05 |
| H2 | frac(0.5 + l/360) | 0.5 - b/180 | -0.25 |
| H6 | frac(l/360) | 0.5 - b/180 | -0.65 |
| H7 | frac(-l/360) | 0.5 + b/180 | -0.79 |
| H4 | frac(0.5 + l/360) | 0.5 + b/180 | -1.57 |
| H5 | frac(-l/360) | 0.5 - b/180 | -2.10 |

H1 wins by a wide margin (star mean 37.4 vs 30.0 for the same-latitude baseline and 17.9 for uniformly
random positions) and is written to `sky.json`. A +-4 px offset search around H1 finds no meaningful shift.

**The photo frame is rotated (important).** Full-resolution crops (`out/alignment_crops.jpg`) showed
that the photographic star images sit 1-3 degrees away from the H1 prediction, in directions that vary
across the sky. Measuring the actual position of each of the 92 bright stars (local maximum of the
smoothed panorama) and fitting a single rotation of the sphere (SciPy least squares, two passes with
neighbour-confusion rejection) explains almost all of it: rotation vector (-1.05, -1.72, -3.19) degrees,
|w| = 3.77 degrees; median star offset 3.33 degrees before, **0.13 degrees after** (rms 0.14, max 0.24, 86/92
inliers, 100 % within 0.5 degrees). Sirius, Canopus, Rigil Kentaurus, Vega, Arcturus and Achernar all land
within 0.15 degrees of their photographic images after the correction (they were 1.5-3.9 degrees off before).
So the mapping formula is right but the mosaic itself is rigidly rotated by ~3.8 degrees relative to true
J2000 galactic coordinates. `sky.json` carries this as `photoFrameCorrection.matrix` (photoDir = M *
galacticDir, then H1) - either transform catalog directions by M before placing star sprites, or rotate
the sky sphere by the transpose. Without it, every catalog star would float ~3.5 degrees away from its
photographic twin. Visual check: `out/alignment_check.jpg` (red = raw H1, green = corrected) and
`out/alignment_crops.jpg`.

**Star catalog.** `stars.bin` is a little-endian Float32 array, 4 floats per star
`[ra_rad_J2000, dec_rad_J2000, vmag, bv]` for all 9096 BSC5 entries with a Vmag, sorted by Vmag ascending
(145,536 bytes = 9096 x 16). 310 stars without a catalog B-V get one inverted from the catalog colour
temperature K (Ballesteros' formula); one star has neither and gets 0.6. `stars.json` lists count/stride/
fields, every star with a common name plus the 60 brightest (`i`, `hr`, `name`, `bayer` as e.g. "Alp CMa",
`greek`, `con`, `vmag`), the 10 brightest with computed and catalog galactic coordinates, and the
equatorial-to-galactic rotation used (J2000: NGP RA 192.85948, Dec 27.12825, l of NCP 122.93192; the 3x3
matrix is included). Validation of our RA/Dec -> (l,b) against the catalog GLON/GLAT for the 100 brightest
stars: max error 0.047 degrees in l cos b and 0.030 degrees in b (the catalog gives 0.01-degree values).
Caveat recorded in the file: HR 5958 (T CrB) is listed at its nova maximum V 2.0.

## Textures (`assets/textures/`)

Copied from the three.js examples: `waternormals.jpg` (1024x1024), `moon_1024.jpg` (1024x512, plus a
Lanczos `moon_512.jpg`), `spark1.png`, `disc.png`, `circle.png`, `blossom.png`, `smoke1.png`, `noise.png`,
and `caustic.jpg` (Caustic_Free.jpg -> 512x512 grayscale JPEG; the source was already effectively
monochrome). `lensflare0_alpha.png` was **not** copied: `textures/lensflare/LICENSE.txt` puts the ROME
lens-flare set under CC BY-NC-SA 3.0, which does not fit a freely redistributable project. A procedural
`moon_halo.png` (256x256 RGBA: soft glow + faint outer ring) stands in for it.

Procedural (numpy, RGBA, white RGB with the shape in alpha unless noted):
`glow_soft.png` 256x256, alpha = 0.86 (1 - r^2)^2 + 0.14 exp(-(r/0.12)^2) (slightly brighter core);
`glow_firefly.png` 64x64, tight Gaussian core + soft (1 - r^2)^3 halo; `ripple_ring.png` 128x128, thin
Gaussian ring at r = 0.68; `paper.png` 512x512 grayscale in RGB (alpha 255), mid-gray base (mean 143/255)
with three faint fibre directions, two mottle scales and fine grain, all produced as frequency-domain
shaped Gaussian noise, so the texture is periodic by construction - the wrap seam difference is 1.12x the
interior neighbour difference, i.e. seamless. `firefly_wing.png` was skipped.

## Audio (`assets/audio/`, OGG Vorbis `-q:a 4`, 44.1 kHz)

Pipeline per file: decode with ffmpeg (mono for one-shots/positional sources, stereo for beds and pads)
-> trim leading/trailing silence below -60 dBFS with 5 ms fades -> peak-normalise to -1 dBFS -> encode.
Loops are built by taking `src[start+X : start+X+L]` and crossfading (equal power) its last X seconds with
the X seconds that precede the loop start, so the wrap point is an untouched stretch of the original;
continuity is verified by the end->start sample jump relative to the typical sample step (`jumpRatio`,
< ~1.5 means no click) and the RMS mismatch of the last/first 250 ms.

| loop | source | length | crossfade | jumpRatio | RMS mismatch |
|---|---|---|---|---|---|
| `wind_loop.ogg` (stereo) | felix.blume wind, start chosen at 80 s for best head/tail match | 75 s | 2 s | 0.45 | 1.1 dB |
| `stream_loop.ogg` (mono, positional) | mystiscool stream, start 48 s | 45 s | 2 s | 1.27 | 1.4 dB |
| `water_loop_1.ogg` | `water_flowing.ogg` (beat `loop_water_03`: 0.5 vs 4.7 dB end/start RMS mismatch, similar spectral distance) | 1.69 s | 0.19 s | 0.29 | 1.1 dB |
| `bubbles_loop.ogg` | `loop_bubbles_1.ogg` (beat `loop_bubbles_02`) | 4.16 s | 0.25 s | 1.46 | 1.7 dB |

Pads (stereo, full length): `pad_bioluminescence.ogg`, `pad_northern_swell.ogg`, `pad_northern_brilliant.ogg`,
`pad_seafoam_waves.ogg`. Mono one-shots: `bowl_1..7`, `glass_1`, `glass_2`, `bell_1..3`, `gong_1..2`,
`splash_soft_1..4`, plus extras that suit a quiet night lake: `pluck_cello_{c2,g2,d3,a3}` (pizzicato, C/G/D/A
fit the D Dorian engine), `whoosh_gentle`, `whoosh_twirl_1..2` (soft air movement for a lantern lifting off),
`plop_airy_1` (something set down in water), `ting_1..4` (tiny silverware tings for firefly landings).

**Splash choice.** All 15 splashes of the 40-CC0 water pack were ranked by crest factor (peak/RMS in dB,
ascending) and attack time (onset at -20 dB -> 90 % of peak, descending); the four with the lowest rank sum
are the gentlest: `splash_06` (21.9 dB, 172 ms), `splash_04` (22.0 dB, 207 ms), `splash_13` (25.1 dB, 224 ms),
`splash_08` (23.1 dB, 102 ms) -> `splash_soft_1..4`. Full table in `out/audio_decisions.json`.

**Rejected.** `bb - Fans and Drones/Outside.wav`: its spectrum is a stationary 72 Hz hum with 51 % of the
energy below 200 Hz and 2 % above 2 kHz - distant machinery/traffic rumble, not nature ambience.
Nothing cricket-like exists in the collection (crickets are synthesised per the design). The "Weird"
folder items with watery names (Ripples in the Pond, Water Pad, Pads to Water) are low-frequency synth
drones and were left out.

**Pitch analysis** (`analysis.pitch` in the manifest). A 200 ms window starting 20 ms after the attack
peak; prominent partials are found by FFT (2^17 zero-padded, 6 dB above the local floor); every partial
(and 1/2, 1/3 of the strongest one when such a partial exists) is scored as an f0 candidate by the harmonic
series it explains (own amplitude + 1/sqrt(k)-weighted harmonics within 2 %; candidates below 120 Hz must
show two harmonics so handling rumble cannot win). Inharmonic bowls/bells with one dominant partial therefore
report that partial - the perceived strike tone. Autocorrelation and the strongest partial are stored as
cross-checks. Pads also get a chroma histogram (spectral peaks 80-2000 Hz mapped to pitch classes) with the
top-3 pitch classes and a Krumhansl-profile key guess.

| file | dur (s) | f0 (Hz) | MIDI | note | cents | strongest partial | key guess (top-3 pitch classes) |
|---|---|---|---|---|---|---|---|
| `pad_bioluminescence.ogg` | 5.18 | 714.2 | 77 | F5 | +38 | 700 Hz | D# major (D#, F, C) |
| `pad_northern_swell.ogg` | 16.98 | 587.6 | 74 | D5 | +1 | 588 Hz | G minor (D, G, A#) |
| `pad_northern_brilliant.ogg` | 14.31 | 116.3 | 46 | A#2 | -4 | 55 Hz | G minor (G, F, D) |
| `pad_seafoam_waves.ogg` | 6.53 | 204.0 | 56 | G#3 | -31 | 204 Hz | G# minor (G#, B, A) |
| `bowl_1.ogg` | 1.05 | 2427.3 | 99 | D#7 | -44 | 2427 Hz |  |
| `bowl_2.ogg` | 0.73 | 1151.6 | 86 | D6 | -34 | 1152 Hz |  |
| `bowl_3.ogg` | 1.77 | 2447.9 | 99 | D#7 | -29 | 2448 Hz |  |
| `bowl_4.ogg` | 1.85 | 2360.8 | 98 | D7 | +8 | 2361 Hz |  |
| `bowl_5.ogg` | 0.90 | 115.3 | 46 | A#2 | -19 | 56 Hz |  |
| `bowl_6.ogg` | 2.37 | 497.4 | 71 | B4 | +12 | 54 Hz |  |
| `bowl_7.ogg` | 0.98 | 65.2 | 36 | C2 | -6 | 121 Hz |  |
| `glass_1.ogg` | 3.82 | 381.6 | 67 | G4 | -46 | 938 Hz |  |
| `glass_2.ogg` | 0.36 | 2238.8 | 97 | C#7 | +17 | 2279 Hz |  |
| `bell_1.ogg` | 1.25 | 4708.3 | 110 | D8 | +4 | 4708 Hz |  |
| `bell_2.ogg` | 0.47 | 2896.9 | 102 | F#7 | -37 | 2908 Hz |  |
| `bell_3.ogg` | 1.38 | 4549.5 | 109 | C#8 | +44 | 4550 Hz |  |
| `gong_1.ogg` | 1.42 | 1009.3 | 83 | B5 | +37 | 1009 Hz |  |
| `gong_2.ogg` | 1.05 | 226.4 | 57 | A3 | +50 | 226 Hz |  |
| `pluck_cello_c2.ogg` | 3.13 | 65.1 | 36 | C2 | -7 | 197 Hz |  |
| `pluck_cello_g2.ogg` | 6.20 | 97.7 | 43 | G2 | -5 | 98 Hz |  |
| `pluck_cello_d3.ogg` | 4.86 | 146.1 | 50 | D3 | -8 | 293 Hz |  |
| `pluck_cello_a3.ogg` | 5.97 | 220.2 | 57 | A3 | +2 | 220 Hz |  |
| `ting_1.ogg` | 0.67 | 1327.8 | 88 | E6 | +12 | 6553 Hz |  |
| `ting_2.ogg` | 1.03 | 4459.9 | 109 | C#8 | +10 | 4460 Hz |  |
| `ting_3.ogg` | 0.63 | 4443.8 | 109 | C#8 | +4 | 4463 Hz |  |
| `ting_4.ogg` | 0.58 | 886.1 | 81 | A5 | +12 | 4457 Hz |  |

**Gains** (`gain` in the manifest, linear): wind 0.35, stream 0.30, water loop 0.30, bubbles 0.22, pads 0.40,
bowls 0.60, glass/bells 0.50, gongs 0.45, splashes 0.50, cello plucks 0.55, whooshes 0.40, plop 0.45, tings 0.45.

`manifest.json` entries: `{file, kind: loop|oneshot|pad, channels, duration, loop, gain, pitchHz, midi, note,
cents, key, source{title,author,license,url}, bytes, analysis{...}}`.

## Hands (`assets/hands/`)

`left.glb`, `right.glb`, `profile.json` from `@webxr-input-profiles/assets` 1.0.20 `generic-hand` (MIT,
Copyright (c) 2019 Amazon; `LICENSE.md` copied alongside). `XRHandMeshModel` loads
`` `${path}${handedness}.glb` `` with no separator, so the files must be named exactly `left.glb` /
`right.glb` and the path given to `XRHandModelFactory.setPath()` must end with a slash:
`setPath('assets/hands/')` (with `'assets/hands'` it would request `assets/handsleft.glb`).

## Fonts (`assets/fonts/`)

`fonts.css` self-hosts the latin subsets of Cormorant Garamond (regular 400-600 as one variable woff2,
italic 400) and Inter (400-600 variable) fetched from Google Fonts with a Chrome user agent; the build
parses the WOFF2 table directory to confirm the `fvar` table before declaring a weight range. Both fonts
are SIL OFL 1.1 (`LICENSE.txt`). If the download fails the CSS contains system-font fallbacks only.
