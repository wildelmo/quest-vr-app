"""Sky panorama, galactic-coordinate alignment verification and star catalog.

Outputs
  assets/sky/milkyway_4k.jpg, milkyway_2k.jpg   ESO/S. Brunier panorama (CC BY 4.0)
  assets/sky/sky.json                            verified (l,b) -> (u,v) mapping
  assets/sky/stars.bin, stars.json               Yale BSC5 as Float32 [ra, dec, vmag, bv]
  tools/assets/out/alignment_check.jpg           catalog stars circled on the panorama
  tools/assets/out/alignment_crops.jpg           full-res crops around six check stars
"""
import json
import math
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy.ndimage import gaussian_filter
from scipy.optimize import least_squares
from scipy.spatial.transform import Rotation

from common import SRC, ASSETS, OUT, log, write_json

Image.MAX_IMAGE_PIXELS = None

PANO = SRC / "milky-way-skybox-for-unity/Packages/dev.dyrda.milky-way-skybox/Runtime/Textures/eso0932a_highestQuality.tif"
CATALOG = SRC / "YaleBrightStarCatalog/bsc5-all.json"

# J2000 galactic pole / node constants (Reid & Brunthaler 2004 / IAU 1958 precessed to J2000).
RA_NGP_DEG = 192.85948
DEC_NGP_DEG = 27.12825
L_NCP_DEG = 122.93192

BLACK_LIFT = 4.0 / 255.0     # the 0.5th percentile of the source is exactly 0 -> lift to 4/255

GREEK = {"α": "Alp", "β": "Bet", "γ": "Gam", "δ": "Del", "ε": "Eps", "ζ": "Zet", "η": "Eta", "θ": "The",
         "ι": "Iot", "κ": "Kap", "λ": "Lam", "μ": "Mu", "ν": "Nu", "ξ": "Xi", "ο": "Omi", "π": "Pi",
         "ρ": "Rho", "σ": "Sig", "τ": "Tau", "υ": "Ups", "φ": "Phi", "χ": "Chi", "ψ": "Psi", "ω": "Ome"}
SUPERSCRIPT = {"¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5"}

CHECK_STARS = [  # name, l, b (from the task brief) -- used for the crop montage
    ("Sirius", 227.23, -8.89), ("Canopus", 261.21, -25.29), ("Rigil Kentaurus", 315.73, -0.68),
    ("Vega", 67.45, 19.24), ("Arcturus", 15.05, 69.11), ("Achernar", 290.84, -58.79),
]

# --------------------------------------------------------------------------- coordinates

def eq2gal(ra_rad, dec_rad):
    """Equatorial J2000 (radians) -> galactic (l, b) in degrees. Vectorised."""
    ra_ngp, dec_ngp, l_ncp = map(math.radians, (RA_NGP_DEG, DEC_NGP_DEG, L_NCP_DEG))
    sb = np.sin(dec_rad) * math.sin(dec_ngp) + np.cos(dec_rad) * math.cos(dec_ngp) * np.cos(ra_rad - ra_ngp)
    b = np.arcsin(np.clip(sb, -1.0, 1.0))
    y = np.cos(dec_rad) * np.sin(ra_rad - ra_ngp)
    x = np.sin(dec_rad) * math.cos(dec_ngp) - np.cos(dec_rad) * math.sin(dec_ngp) * np.cos(ra_rad - ra_ngp)
    l = (l_ncp - np.arctan2(y, x)) % (2 * math.pi)
    return np.degrees(l), np.degrees(b)


def eq2gal_matrix():
    """3x3 matrix M with g = M @ e (unit vectors), derived from the constants above."""
    cols = []
    for ra, dec in ((0.0, 0.0), (90.0, 0.0), (0.0, 90.0)):
        l, b = eq2gal(np.radians(ra), np.radians(dec))
        l, b = math.radians(float(l)), math.radians(float(b))
        cols.append([math.cos(b) * math.cos(l), math.cos(b) * math.sin(l), math.sin(b)])
    M = np.array(cols).T
    return M


def bv_from_temperature(T):
    """Invert Ballesteros' formula T(B-V) numerically."""
    bv = np.linspace(-0.4, 2.2, 2601)
    Tg = 4600.0 * (1.0 / (0.92 * bv + 1.7) + 1.0 / (0.92 * bv + 0.62))  # monotonically decreasing
    return float(np.interp(T, Tg[::-1], bv[::-1]))


def bayer_abbrev(greek):
    if not greek:
        return ""
    out = ""
    for ch in greek:
        out += GREEK.get(ch, SUPERSCRIPT.get(ch, ch))
    return out

# --------------------------------------------------------------------------- catalog

def load_catalog():
    raw = json.load(open(CATALOG, encoding="utf-8"))
    stars = []
    filled = 0
    for s in raw:
        try:
            vmag = float(s["Vmag"])
        except (KeyError, TypeError, ValueError):
            continue
        try:
            ra = (float(s["RAh"]) + float(s["RAm"]) / 60.0 + float(s["RAs"]) / 3600.0) * 15.0
            dec = (float(s["DEd"]) + float(s["DEm"]) / 60.0 + float(s["DEs"]) / 3600.0)
            if s.get("DE-") == "-":
                dec = -dec
        except (KeyError, TypeError, ValueError):
            continue
        bv = None
        try:
            bv = float(s["B-V"])
        except (KeyError, TypeError, ValueError):
            pass
        K = None
        try:
            K = float(s["K"])
        except (KeyError, TypeError, ValueError):
            pass
        bv_est = False
        if bv is None:
            bv_est = True
            filled += 1
            bv = bv_from_temperature(K) if K else 0.6
        def f(k):
            try:
                return float(s[k])
            except (KeyError, TypeError, ValueError):
                return None
        greek = s.get("Bayer") or ""
        con = s.get("Constellation") or ""
        stars.append(dict(
            hr=int(s["HR"]), vmag=vmag, ra=ra, dec=dec, bv=bv, bv_est=bv_est, K=K,
            glon=f("GLON"), glat=f("GLAT"),
            common=s.get("Common") or "",
            greek=(greek + " " + con).strip() if greek else "",
            bayer=(bayer_abbrev(greek) + " " + con).strip() if greek else "",
            flamsteed=(str(s.get("Flamsteed")) + " " + con).strip() if s.get("Flamsteed") else "",
            con=con, sptype=s.get("SpType") or "",
        ))
    stars.sort(key=lambda d: (d["vmag"], d["hr"]))
    log(f"catalog: {len(stars)} stars with Vmag; B-V estimated from colour temperature for {filled}")
    return stars, filled

# --------------------------------------------------------------------------- panorama

def load_panorama():
    im = Image.open(PANO)
    assert im.size == (6000, 3000), im.size
    return im.convert("RGB")


def build_panorama_jpegs(im):
    a = np.asarray(im).astype(np.float32) / 255.0
    lum = 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]
    p05 = float(np.percentile(lum, 0.5))
    # Mild linear lift so the darkest tones do not get crushed by JPEG: p05 -> BLACK_LIFT, 1 -> 1.
    if p05 < BLACK_LIFT:
        lift = (BLACK_LIFT - p05) / (1.0 - p05)
        a = lift + (a - p05) * (1.0 - lift) / (1.0 - p05)
    a = np.clip(a * 255.0 + 0.5, 0, 255).astype(np.uint8)
    lifted = Image.fromarray(a, "RGB")
    info = {"source": str(PANO), "sourceSize": im.size, "sourceIccProfile": "sRGB IEC61966-2.1",
            "luminance0_5thPercentile": p05, "blackLiftTarget": BLACK_LIFT, "files": {}}
    for name, size in (("milkyway_4k.jpg", (4096, 2048)), ("milkyway_2k.jpg", (2048, 1024))):
        small = lifted.resize(size, Image.LANCZOS)
        path = ASSETS / "sky" / name
        small.save(path, "JPEG", quality=88, subsampling=0, optimize=True)
        info["files"][name] = {"size": size, "bytes": path.stat().st_size}
        log(f"wrote {path.name} {size} {path.stat().st_size} bytes")
    return info

# --------------------------------------------------------------------------- alignment

HYPOTHESES = {
    "H1": ("frac(0.5 - l/360)", "0.5 - b/180", lambda l: (0.5 - l / 360.0) % 1.0, lambda b: 0.5 - b / 180.0),
    "H2": ("frac(0.5 + l/360)", "0.5 - b/180", lambda l: (0.5 + l / 360.0) % 1.0, lambda b: 0.5 - b / 180.0),
    "H3": ("frac(0.5 - l/360)", "0.5 + b/180", lambda l: (0.5 - l / 360.0) % 1.0, lambda b: 0.5 + b / 180.0),
    "H4": ("frac(0.5 + l/360)", "0.5 + b/180", lambda l: (0.5 + l / 360.0) % 1.0, lambda b: 0.5 + b / 180.0),
    "H5": ("frac(-l/360)", "0.5 - b/180", lambda l: (-l / 360.0) % 1.0, lambda b: 0.5 - b / 180.0),
    "H6": ("frac(l/360)", "0.5 - b/180", lambda l: (l / 360.0) % 1.0, lambda b: 0.5 - b / 180.0),
    "H7": ("frac(-l/360)", "0.5 + b/180", lambda l: (-l / 360.0) % 1.0, lambda b: 0.5 + b / 180.0),
    "H8": ("frac(l/360)", "0.5 + b/180", lambda l: (l / 360.0) % 1.0, lambda b: 0.5 + b / 180.0),
}


def _window_mean(gray, u, v, r=2):
    H, W = gray.shape
    xs = np.round(u * W).astype(int) % W
    ys = np.clip(np.round(v * H).astype(int), 0, H - 1)
    vals = np.empty(len(xs), dtype=np.float64)
    for i, (x, y) in enumerate(zip(xs, ys)):
        cols = np.arange(x - r, x + r + 1) % W
        vals[i] = gray[max(0, y - r):min(H, y + r + 1)][:, cols].mean()
    return vals


def verify_alignment(im, stars, vmag_limit=2.5):
    gray = np.asarray(im.convert("L"), dtype=np.float32)
    bright = [s for s in stars if s["vmag"] < vmag_limit and s["glon"] is not None]
    L = np.array([s["glon"] for s in bright])
    B = np.array([s["glat"] for s in bright])
    rng = np.random.default_rng(12345)
    results = {}
    for key, (uexpr, vexpr, uf, vf) in HYPOTHESES.items():
        star_mean = float(_window_mean(gray, uf(L), vf(B)).mean())
        # Baseline 1: random longitude at the *same* latitudes (controls for the bright galactic plane).
        base_b = float(np.mean([_window_mean(gray, rng.uniform(0, 1, len(L)), vf(B)).mean() for _ in range(30)]))
        # Baseline 2: uniformly random positions.
        base_u = float(_window_mean(gray, rng.uniform(0, 1, 4 * len(L)), rng.uniform(0, 1, 4 * len(L))).mean())
        results[key] = {"u": uexpr, "v": vexpr, "starMean": star_mean, "sameLatitudeRandomMean": base_b,
                        "uniformRandomMean": base_u, "score": star_mean - base_b}
        log(f"  {key} u={uexpr:18s} v={vexpr:12s} stars={star_mean:6.2f} same-b random={base_b:6.2f} "
            f"uniform={base_u:6.2f} score={star_mean - base_b:+6.2f}")
    best = max(results, key=lambda k: results[k]["score"])
    second = sorted(results.values(), key=lambda r: -r["score"])[1]["score"]
    # Sub-pixel/offset sanity check around the winner (in source pixels).
    uf, vf = HYPOTHESES[best][2], HYPOTHESES[best][3]
    H, W = gray.shape
    offsets = {}
    for dx in (-4, -2, 0, 2, 4):
        for dy in (-4, -2, 0, 2, 4):
            offsets[f"{dx:+d},{dy:+d}"] = float(_window_mean(gray, uf(L) + dx / W, vf(B) + dy / H, r=1).mean())
    best_off = max(offsets, key=offsets.get)
    log(f"alignment best={best} score={results[best]['score']:+.2f} (runner-up {second:+.2f}); "
        f"best pixel offset {best_off} = {offsets[best_off]:.2f} vs (0,0) = {offsets['+0,+0']:.2f}")
    return {"best": best, "nStars": len(bright), "vmagLimit": vmag_limit, "window": "5x5 px on 6000x3000",
            "hypotheses": results, "offsetSearch": offsets, "bestOffsetPx": best_off}


def _dir(l_deg, b_deg):
    l = np.radians(l_deg); b = np.radians(b_deg)
    return np.stack([np.cos(b) * np.cos(l), np.cos(b) * np.sin(l), np.sin(b)], -1)


def _lb(v):
    return (np.degrees(np.arctan2(v[..., 1], v[..., 0])) % 360.0,
            np.degrees(np.arcsin(np.clip(v[..., 2], -1.0, 1.0))))


def photo_lb(l_deg, b_deg, rotvec):
    """True galactic (l, b) -> where the panorama actually shows the star, given the fitted frame rotation."""
    Rm = Rotation.from_rotvec(np.asarray(rotvec)).as_matrix()
    return _lb(_dir(np.asarray(l_deg, dtype=float), np.asarray(b_deg, dtype=float)) @ Rm.T)


def measure_displacements(gray, stars, rotvec, radius, vmag_limit=2.5, confusion_limit=3.5, check=True):
    """Find each bright star's photographic image (local maximum of the smoothed panorama) near its
    predicted position and return the measured photo-frame (l, b). `check` rejects a peak that is closer
    to another catalog star's prediction than to the target's (neighbour confusion)."""
    H, W = gray.shape
    deg = 360.0 / W
    cand = [s for s in stars if s["vmag"] < confusion_limit and s["glon"] is not None]
    cl, cb = photo_lb([s["glon"] for s in cand], [s["glat"] for s in cand], rotvec)
    cx = ((0.5 - cl / 360.0) % 1.0) * W
    cy = (0.5 - cb / 180.0) * H
    out = []
    for i, s in enumerate(cand):
        if s["vmag"] >= vmag_limit:
            continue
        x0, y0 = cx[i], cy[i]
        xi, yi = int(round(x0)), int(round(y0))
        ys = slice(max(0, yi - radius), min(H, yi + radius + 1))
        xs = np.arange(xi - radius, xi + radius + 1) % W
        win = gray[ys][:, xs]
        k = np.unravel_index(int(np.argmax(win)), win.shape)
        px, py = xi - radius + k[1], ys.start + k[0]
        ok = True
        if check:
            ddx = np.abs(cx - px); ddx = np.minimum(ddx, W - ddx)
            j = int(np.argmin(ddx ** 2 + (cy - py) ** 2))
            ok = (j == i) or (abs(cl[j] - cl[i]) < 0.05 and abs(cb[j] - cb[i]) < 0.05)  # close doubles
        out.append({"star": s, "dx": float(px - x0), "dy": float(py - y0), "peak": float(win[k]), "ok": ok,
                    "photoL": float(cl[i] - (px - x0) * deg), "photoB": float(cb[i] - (py - y0) * deg)})
    return out


def _fit_rotation(meas, rot0):
    true = _dir([m["star"]["glon"] for m in meas], [m["star"]["glat"] for m in meas])
    photo = _dir([m["photoL"] for m in meas], [m["photoB"] for m in meas])

    def resid(p):
        pred = true @ Rotation.from_rotvec(p).as_matrix().T
        return np.degrees((pred - photo).ravel())

    fit = least_squares(resid, np.asarray(rot0, dtype=float), loss="soft_l1", f_scale=0.5)
    return fit.x


def _separations(meas, rotvec):
    l, b = photo_lb([m["star"]["glon"] for m in meas], [m["star"]["glat"] for m in meas], rotvec)
    pred = _dir(l, b)
    photo = _dir([m["photoL"] for m in meas], [m["photoB"] for m in meas])
    return np.degrees(np.arccos(np.clip((pred * photo).sum(1), -1.0, 1.0)))


def fit_photo_frame(im, stars):
    """The panorama's stars are not exactly where J2000 galactic (l, b) predicts: fit a global rotation
    of the photo frame. Two passes: a loose one (no neighbour check) to get close, then a tight one."""
    gray = gaussian_filter(np.asarray(im.convert("L"), dtype=np.float32), 1.5)
    deg = 360.0 / gray.shape[1]
    zero = np.zeros(3)
    m1 = measure_displacements(gray, stars, zero, radius=70, check=False)
    raw = np.array([math.hypot(m["dx"], m["dy"]) for m in m1]) * deg
    rot1 = _fit_rotation(m1, zero)
    m2 = [m for m in measure_displacements(gray, stars, rot1, radius=35, check=True) if m["ok"]]
    rot2 = _fit_rotation(m2, rot1)
    sep2 = _separations(m2, rot2)
    inl = [m for m, s in zip(m2, sep2) if s < 1.0]
    rot = _fit_rotation(inl, rot2)
    sep_in = _separations(inl, rot)
    sep_all0 = _separations(m1, zero)
    R = Rotation.from_rotvec(rot)
    angle = float(np.degrees(np.linalg.norm(rot)))
    axis = (rot / np.linalg.norm(rot)).tolist()
    six = {}
    for m in m1:
        name = m["star"]["common"]
        if name in {n for n, _, _ in CHECK_STARS}:
            six[name] = {"rawOffsetPx": [round(m["dx"], 1), round(m["dy"], 1)],
                         "rawOffsetDeg": [round(m["dx"] * deg, 2), round(m["dy"] * deg, 2)]}
    for m, s in zip(inl, sep_in):
        name = m["star"]["common"]
        if name in six:
            six[name]["residualAfterCorrectionDeg"] = round(float(s), 2)
    info = {
        "rotationVectorDeg": [round(float(v), 4) for v in np.degrees(rot)],
        "angleDeg": round(angle, 3), "axis": [round(a, 5) for a in axis],
        "matrix": [[round(float(v), 7) for v in row] for row in R.as_matrix()],
        "starsMeasured": len(m1), "starsAfterNeighbourCheck": len(m2), "inliers": len(inl),
        "rawMedianOffsetDeg": round(float(np.median(raw)), 3),
        "rawMedianOffsetPx": [round(float(np.median([m["dx"] for m in m1])), 1),
                              round(float(np.median([m["dy"] for m in m1])), 1)],
        "rmsBeforeDeg": round(float(np.sqrt((sep_all0 ** 2).mean())), 3),
        "medianBeforeDeg": round(float(np.median(sep_all0)), 3),
        "rmsAfterDeg": round(float(np.sqrt((sep_in ** 2).mean())), 3),
        "medianAfterDeg": round(float(np.median(sep_in)), 3),
        "maxInlierAfterDeg": round(float(sep_in.max()), 3),
        "fractionWithin0_5Deg": round(float(np.mean(sep_in < 0.5)), 3),
        "checkStars": six,
    }
    log(f"photo frame: rotation {info['rotationVectorDeg']} deg (|w|={angle:.2f} deg); "
        f"median offset before {info['medianBeforeDeg']:.2f} deg -> after {info['medianAfterDeg']:.2f} deg "
        f"(rms {info['rmsAfterDeg']:.2f}, {len(inl)}/{len(m1)} inliers)")
    return info, rot


def draw_alignment_check(im, stars, best, rotvec):
    uf, vf = HYPOTHESES[best][2], HYPOTHESES[best][3]
    W, H = 3000, 1500
    check = im.resize((W, H), Image.LANCZOS)
    d = ImageDraw.Draw(check)
    try:
        font = ImageFont.load_default(size=22)
    except TypeError:
        font = ImageFont.load_default()
    for s in stars:
        if s["vmag"] >= 3.0 or s["glon"] is None:
            continue
        r = 5 + 4 * (3.0 - s["vmag"])
        x, y = uf(s["glon"]) * W, vf(s["glat"]) * H
        d.ellipse([x - r, y - r, x + r, y + r], outline=(255, 40, 40), width=2)
        lp, bp = photo_lb(s["glon"], s["glat"], rotvec)
        xc, yc = uf(float(lp)) * W, vf(float(bp)) * H
        d.ellipse([xc - r, yc - r, xc + r, yc + r], outline=(60, 255, 90), width=2)
        if s["common"] and (s["vmag"] < 0.9 or s["common"] in {n for n, _, _ in CHECK_STARS}):
            d.text((xc + r + 4, yc - 12), s["common"], fill=(255, 230, 80), font=font)
    d.text((20, H - 40), "red: catalog (l,b) through u=0.5-l/360, v=0.5-b/180   green: same after the fitted photo-frame rotation",
           fill=(255, 255, 255), font=font)
    path = OUT / "alignment_check.jpg"
    check.save(path, "JPEG", quality=85)
    log(f"wrote {path}")

    # Full-resolution crops around the six check stars, centred on the corrected position.
    crop, scale = 120, 3
    tile = crop * scale
    montage = Image.new("RGB", (tile * 3, tile * 2))
    md = ImageDraw.Draw(montage)
    W6, H6 = im.size
    for i, (name, l, b) in enumerate(CHECK_STARS):
        lp, bp = photo_lb(l, b, rotvec)
        xc, yc = uf(float(lp)) * W6, vf(float(bp)) * H6
        xr, yr = uf(l) * W6, vf(b) * H6
        box = (int(round(xc - crop / 2)), int(round(yc - crop / 2)), int(round(xc + crop / 2)), int(round(yc + crop / 2)))
        c = im.crop(box).resize((tile, tile), Image.NEAREST)
        ox, oy = (i % 3) * tile, (i // 3) * tile
        montage.paste(c, (ox, oy))
        gx, gy = ox + tile / 2, oy + tile / 2
        md.ellipse([gx - 24, gy - 24, gx + 24, gy + 24], outline=(60, 255, 90), width=2)
        rx, ry = gx + (xr - xc) * scale, gy + (yr - yc) * scale
        md.ellipse([rx - 24, ry - 24, rx + 24, ry + 24], outline=(255, 40, 40), width=2)
        md.text((ox + 6, oy + 6), f"{name}  l={l} b={b}", fill=(255, 230, 80), font=font)
    md.text((6, tile * 2 - 26), "red: raw mapping   green: with photo-frame rotation", fill=(255, 255, 255), font=font)
    path2 = OUT / "alignment_crops.jpg"
    montage.save(path2, "JPEG", quality=90)
    log(f"wrote {path2}")
    return [str(path), str(path2)]


def write_sky_json(alignment, pano_info, frame):
    best = alignment["best"]
    h = alignment["hypotheses"][best]
    obj = {
        "coordinateFrame": "galactic",
        "mapping": {"u": f"u = {h['u']}", "v": f"v = {h['v']}  (v = 0 is the top row)"},
        "image": {"projection": "equirectangular", "center": "galactic centre (l=0, b=0) at u=0.5, v=0.5",
                  "longitudeIncreasesToward": "left (u decreases as l increases), i.e. the sky as seen from inside the sphere",
                  "files": pano_info["files"]},
        "verification": {
            "method": "mean panorama brightness in a 5x5 px window (6000x3000 source) at the positions of catalog stars "
                      "with Vmag < %.1f (%d stars), minus the mean at random longitudes with the same latitudes"
                      % (alignment["vmagLimit"], alignment["nStars"]),
            "bestHypothesis": best,
            "scores": {k: round(v["score"], 3) for k, v in alignment["hypotheses"].items()},
            "starMean": round(h["starMean"], 3), "sameLatitudeRandomMean": round(h["sameLatitudeRandomMean"], 3),
            "uniformRandomMean": round(h["uniformRandomMean"], 3),
            "pixelOffsetSearchBest": alignment["bestOffsetPx"],
            "visualCheck": "tools/assets/out/alignment_check.jpg, tools/assets/out/alignment_crops.jpg",
        },
        "photoFrameCorrection": {
            "why": "The photographic star positions are consistently rotated by ~%.1f deg relative to true J2000 "
                   "galactic (l, b) (measured on %d stars brighter than V 2.5: median offset %.2f deg before, "
                   "%.2f deg after the correction). The mapping formula above is right; the mosaic itself is slightly "
                   "rotated." % (frame["angleDeg"], frame["starsMeasured"], frame["medianBeforeDeg"], frame["medianAfterDeg"]),
            "usage": "photoDir = matrix * galacticDir, then (l_p, b_p) = (atan2(photoDir.y, photoDir.x), asin(photoDir.z)) "
                     "and the u/v mapping above. Equivalently rotate the sky sphere by the inverse (transpose) so the "
                     "photo lines up with catalog star sprites placed at true galactic directions.",
            "rotationVectorDeg": frame["rotationVectorDeg"], "angleDeg": frame["angleDeg"], "axis": frame["axis"],
            "matrix": frame["matrix"],
            "fit": {k: frame[k] for k in ("starsMeasured", "starsAfterNeighbourCheck", "inliers", "rawMedianOffsetPx",
                                           "rawMedianOffsetDeg", "rmsBeforeDeg", "medianBeforeDeg", "rmsAfterDeg",
                                           "medianAfterDeg", "maxInlierAfterDeg", "fractionWithin0_5Deg")},
            "checkStars": frame["checkStars"],
        },
        "processing": {"downscale": "Lanczos", "jpegQuality": 88, "chromaSubsampling": "4:4:4",
                       "blackLift": "linear levels: 0.5th percentile (%.4f) -> %.4f, white fixed"
                                    % (pano_info["luminance0_5thPercentile"], pano_info["blackLiftTarget"]),
                       "colorSpace": "sRGB (source ICC: sRGB IEC61966-2.1)"},
        "source": {"title": "The Milky Way panorama (eso0932a)", "author": "ESO/S. Brunier",
                   "license": "CC BY 4.0", "url": "https://www.eso.org/public/images/eso0932a/"},
        "notes": "Photographic panorama in galactic coordinates. The galactic centre is at the image centre; "
                 "l increases to the left because the map shows the sky as seen from Earth. "
                 "Sample with direction d (galactic frame): l = atan2(d.y, d.x), b = asin(d.z).",
    }
    write_json(ASSETS / "sky" / "sky.json", obj)
    return obj

# --------------------------------------------------------------------------- stars

def write_stars(stars, bv_filled):
    n = len(stars)
    arr = np.zeros((n, 4), dtype="<f4")
    arr[:, 0] = np.radians([s["ra"] for s in stars])
    arr[:, 1] = np.radians([s["dec"] for s in stars])
    arr[:, 2] = [s["vmag"] for s in stars]
    arr[:, 3] = [s["bv"] for s in stars]
    bin_path = ASSETS / "sky" / "stars.bin"
    bin_path.write_bytes(arr.tobytes(order="C"))
    assert bin_path.stat().st_size == n * 16

    # Validation: our RA/Dec -> (l, b) against the catalog GLON/GLAT for the 100 brightest.
    sub = [s for s in stars if s["glon"] is not None][:100]
    l, b = eq2gal(np.radians([s["ra"] for s in sub]), np.radians([s["dec"] for s in sub]))
    cl = np.array([s["glon"] for s in sub]); cb = np.array([s["glat"] for s in sub])
    dl = np.abs((l - cl + 180.0) % 360.0 - 180.0) * np.cos(np.radians(cb))
    db = np.abs(b - cb)
    validation = {"nStars": len(sub), "maxErrLongitudeDeg": float(dl.max()), "maxErrLatitudeDeg": float(db.max()),
                  "meanErrLongitudeDeg": float(dl.mean()), "meanErrLatitudeDeg": float(db.mean()),
                  "note": "longitude error is scaled by cos(b); catalog GLON/GLAT are given to 0.01 deg"}
    log(f"stars: galactic conversion max error l*cos(b)={dl.max():.4f} deg, b={db.max():.4f} deg (100 brightest)")

    named = []
    for i, s in enumerate(stars):
        if s["common"] or i < 60:
            e = {"i": i, "hr": s["hr"], "name": s["common"], "bayer": s["bayer"], "greek": s["greek"],
                 "con": s["con"], "vmag": s["vmag"]}
            if s["flamsteed"]:
                e["flamsteed"] = s["flamsteed"]
            named.append(e)

    brightest = []
    l10, b10 = eq2gal(np.radians([s["ra"] for s in stars[:10]]), np.radians([s["dec"] for s in stars[:10]]))
    for i, s in enumerate(stars[:10]):
        brightest.append({"i": i, "name": s["common"] or s["bayer"], "vmag": s["vmag"], "raDeg": round(s["ra"], 5),
                          "decDeg": round(s["dec"], 5), "glon": round(float(l10[i]), 3), "glat": round(float(b10[i]), 3),
                          "catalogGlon": s["glon"], "catalogGlat": s["glat"], "bv": s["bv"]})
    M = eq2gal_matrix()
    obj = {
        "count": n, "stride": 4, "fields": ["ra_rad_J2000", "dec_rad_J2000", "vmag", "bv"],
        "dtype": "float32 little-endian", "sortedBy": "vmag ascending", "file": "stars.bin",
        "source": {"title": "Yale Bright Star Catalog, 5th revised ed. (Hoffleit & Warren 1991)",
                   "conversion": "JSON by Bretton Wade (brettonw/YaleBrightStarCatalog, MIT)",
                   "url": "http://tdc-www.harvard.edu/catalogs/bsc5.html"},
        "bvEstimatedFromColourTemperature": bv_filled,
        "bvNote": "stars without a catalog B-V get one inverted from the catalog colour temperature K "
                  "(Ballesteros' formula); 0.6 if neither exists",
        "galacticRotation": {
            "epoch": "J2000", "raNorthGalacticPoleDeg": RA_NGP_DEG, "decNorthGalacticPoleDeg": DEC_NGP_DEG,
            "lNorthCelestialPoleDeg": L_NCP_DEG,
            "equatorialToGalacticMatrix": [[round(float(v), 9) for v in row] for row in M],
            "usage": "e = (cos(dec)cos(ra), cos(dec)sin(ra), sin(dec)); g = M * e; l = atan2(g.y, g.x); b = asin(g.z)",
            "matrixDeterminant": round(float(np.linalg.det(M)), 9),
        },
        "validation": validation,
        "brightest10": brightest,
        "named": named,
        "caveats": ["HR 5958 (T CrB, recurrent nova) is listed at its outburst magnitude V=2.0; it is ~V 10 in quiescence."],
    }
    write_json(ASSETS / "sky" / "stars.json", obj)
    log(f"wrote stars.bin ({n} stars, {n * 16} bytes) and stars.json ({len(named)} named/bright entries)")
    return obj


def build(report):
    im = load_panorama()
    pano_info = build_panorama_jpegs(im)
    stars, bv_filled = load_catalog()
    alignment = verify_alignment(im, stars)
    frame, rotvec = fit_photo_frame(im, stars)
    alignment["images"] = draw_alignment_check(im, stars, alignment["best"], rotvec)
    sky = write_sky_json(alignment, pano_info, frame)
    stars_json = write_stars(stars, bv_filled)
    report["sky"] = {"panorama": pano_info, "alignment": alignment, "mapping": sky["mapping"], "photoFrame": frame,
                     "stars": {"count": stars_json["count"], "validation": stars_json["validation"],
                               "brightest10": stars_json["brightest10"]}}
