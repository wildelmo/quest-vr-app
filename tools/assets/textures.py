"""Textures: copies from the three.js examples plus procedural sprites (numpy/PIL)."""
import shutil
import numpy as np
from PIL import Image

from common import THREE_TEX, ASSETS, log

DST = ASSETS / "textures"

# (source relative to three.js examples/textures, destination name)
COPIES = [
    ("waternormals.jpg", "waternormals.jpg"),
    ("planets/moon_1024.jpg", "moon_1024.jpg"),
    ("sprites/spark1.png", "spark1.png"),
    ("sprites/disc.png", "disc.png"),
    ("sprites/circle.png", "circle.png"),
    ("sprites/blossom.png", "blossom.png"),
    ("opengameart/smoke1.png", "smoke1.png"),
    ("noise.png", "noise.png"),
]
# lensflare/lensflare0_alpha.png is deliberately NOT copied: examples/textures/lensflare/LICENSE.txt puts the
# ROME lens-flare textures under CC BY-NC-SA 3.0 (non-commercial, share-alike). moon_halo.png replaces it.


def _radial(n):
    y, x = np.mgrid[0:n, 0:n].astype(np.float64)
    c = (n - 1) / 2.0
    r = np.sqrt((x - c) ** 2 + (y - c) ** 2) / (n / 2.0)
    return r


def _rgba_white(alpha):
    a = np.clip(alpha, 0, 1)
    h, w = a.shape
    img = np.zeros((h, w, 4), dtype=np.uint8)
    img[..., :3] = 255
    img[..., 3] = np.round(a * 255).astype(np.uint8)
    return Image.fromarray(img, "RGBA")


def glow_soft(n=256):
    r = _radial(n)
    base = np.clip(1 - r ** 2, 0, 1) ** 2               # (1 - r^2)^2 falloff
    core = np.exp(-(r / 0.12) ** 2)                      # slightly brighter core
    return _rgba_white(0.86 * base + 0.14 * core)


def glow_firefly(n=64):
    r = _radial(n)
    core = np.exp(-(r / 0.16) ** 2)
    halo = 0.35 * np.clip(1 - r ** 2, 0, 1) ** 3
    return _rgba_white(core + halo)


def ripple_ring(n=128, radius=0.68, width=0.055):
    r = _radial(n)
    ring = np.exp(-((r - radius) / width) ** 2)
    edge = np.clip((1.0 - r) / 0.08, 0, 1)               # fade out at the sprite border
    return _rgba_white(0.95 * ring * edge)


def moon_halo(n=256):
    r = _radial(n)
    glow = 0.80 * np.exp(-(r / 0.30) ** 1.6)
    ring = 0.12 * np.exp(-((r - 0.72) / 0.07) ** 2)      # faint 22-degree-style halo ring
    edge = np.clip((1.0 - r) / 0.06, 0, 1)
    return _rgba_white((glow + ring) * edge)


def _periodic_noise(n, rng, weight_fn):
    """Gaussian noise shaped in the frequency domain -> periodic (tileable) by construction."""
    white = rng.standard_normal((n, n))
    F = np.fft.fft2(white)
    fx = np.fft.fftfreq(n)[None, :]
    fy = np.fft.fftfreq(n)[:, None]
    F = F * weight_fn(fx, fy)
    x = np.real(np.fft.ifft2(F))
    x -= x.mean()
    return x / (x.std() + 1e-12)


def paper(n=512, seed=7):
    rng = np.random.default_rng(seed)

    def fibres(angle_deg, length=0.012, thickness=0.09):
        a = np.radians(angle_deg)
        def w(fx, fy):
            fa = fx * np.cos(a) + fy * np.sin(a)          # along-fibre frequency (long -> low freq)
            fp = -fx * np.sin(a) + fy * np.cos(a)         # across-fibre frequency (thin -> high freq band)
            along = np.exp(-(fa / length) ** 2)
            across = np.exp(-((np.abs(fp) - thickness) / (0.6 * thickness)) ** 2)
            return along * across
        return _periodic_noise(n, rng, w)

    def mottle(scale=0.02):
        return _periodic_noise(n, rng, lambda fx, fy: np.exp(-((fx ** 2 + fy ** 2) / scale ** 2)))

    def grain():
        return _periodic_noise(n, rng, lambda fx, fy: np.ones_like(fx + fy))

    f1 = fibres(12.0)
    f2 = fibres(-38.0, length=0.016, thickness=0.12)
    f3 = fibres(70.0, length=0.02, thickness=0.15)
    m = mottle(0.012)
    m2 = mottle(0.035)
    g = grain()
    v = 0.56 + 0.045 * f1 + 0.035 * f2 + 0.02 * f3 + 0.05 * m + 0.03 * m2 + 0.012 * g
    v = np.clip(v, 0, 1)
    img = np.zeros((n, n, 4), dtype=np.uint8)
    gray = np.round(v * 255).astype(np.uint8)
    img[..., 0] = img[..., 1] = img[..., 2] = gray
    img[..., 3] = 255
    # seam check: wrap-around difference vs interior neighbour difference (should be ~1.0)
    wrap = np.abs(v[:, 0] - v[:, -1]).mean() + np.abs(v[0, :] - v[-1, :]).mean()
    inner = np.abs(np.diff(v, axis=1)).mean() + np.abs(np.diff(v, axis=0)).mean()
    return Image.fromarray(img, "RGBA"), float(wrap / inner)


def build(report):
    DST.mkdir(parents=True, exist_ok=True)
    made = {}
    for src, dst in COPIES:
        s = THREE_TEX / src
        d = DST / dst
        shutil.copyfile(s, d)
        im = Image.open(d)
        made[dst] = {"size": im.size, "mode": im.mode, "bytes": d.stat().st_size, "from": f"three.js examples/textures/{src}"}

    moon = Image.open(THREE_TEX / "planets/moon_1024.jpg").convert("RGB")
    moon.resize((512, 256), Image.LANCZOS).save(DST / "moon_512.jpg", "JPEG", quality=88, optimize=True)
    made["moon_512.jpg"] = {"size": (512, 256), "mode": "RGB", "bytes": (DST / "moon_512.jpg").stat().st_size,
                            "from": "three.js examples/textures/planets/moon_1024.jpg (Lanczos 1/2)"}

    caustic = Image.open(THREE_TEX / "opengameart/Caustic_Free.jpg")
    arr = np.asarray(caustic.convert("RGB")).astype(np.int16)
    colourful = float(np.abs(arr[..., 0] - arr[..., 1]).mean() + np.abs(arr[..., 1] - arr[..., 2]).mean())
    c = caustic.convert("L")
    if c.size != (512, 512):
        c = c.resize((512, 512), Image.LANCZOS)
    c.save(DST / "caustic.jpg", "JPEG", quality=85, optimize=True)
    made["caustic.jpg"] = {"size": c.size, "mode": "L", "bytes": (DST / "caustic.jpg").stat().st_size,
                           "from": "three.js examples/textures/opengameart/Caustic_Free.jpg -> grayscale",
                           "sourceMode": caustic.mode, "sourceChannelDifference": colourful}

    procedural = {
        "glow_soft.png": glow_soft(),
        "glow_firefly.png": glow_firefly(),
        "ripple_ring.png": ripple_ring(),
        "moon_halo.png": moon_halo(),
    }
    pap, seam = paper()
    procedural["paper.png"] = pap
    for name, im in procedural.items():
        im.save(DST / name, "PNG", optimize=True)
        made[name] = {"size": im.size, "mode": im.mode, "bytes": (DST / name).stat().st_size, "from": "procedural (textures.py)"}
    made["paper.png"]["seamRatio"] = seam
    log(f"paper.png seam ratio (wrap diff / interior diff) = {seam:.3f}")
    for k, v in made.items():
        log(f"  {k:22s} {str(v['size']):12s} {v['mode']:5s} {v['bytes']:8d} B")
    report["textures"] = made
