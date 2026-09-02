"""Audio: decode -> trim -> normalise -> (loop) -> OGG Vorbis, plus pitch/key analysis and manifest."""
import math
import subprocess
import numpy as np

from common import CC0_SOUNDS, AMBIENT, ASSETS, OUT, ffmpeg_exe, log, write_json

SR = 44100
DST = ASSETS / "audio"
NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# --------------------------------------------------------------------------- sources / credits

BURNES = {"author": "Ben Burnes (Abstraction)", "license": "CC0 1.0",
          "url": "https://github.com/lavenderdotpet/CC0-Public-Domain-Sounds (packs by abstractionmusic.com)"}
RUBBERDUCK_NOTE = ("unknown author, CC0 via lavenderdotpet/CC0-Public-Domain-Sounds "
                   "(pack names match rubberduck's OpenGameArt CC0 packs; not verifiable offline)")
OGA_PACK = {"author": RUBBERDUCK_NOTE, "license": "CC0 1.0", "url": "https://github.com/lavenderdotpet/CC0-Public-Domain-Sounds"}
WIND_SRC = {"title": "Wind (freesound #139337)", "author": "felix.blume", "license": "CC0 1.0",
            "url": "https://freesound.org/people/felix.blume/sounds/139337/"}
STREAM_SRC = {"title": "Stream (freesound #7138)", "author": "mystiscool", "license": "CC BY 3.0",
              "url": "https://freesound.org/people/mystiscool/sounds/7138/"}

def burnes(title, pack):
    return dict(BURNES, title=f"{title} ({pack})")

def oga(title, pack):
    return dict(OGA_PACK, title=f"{title} ({pack})")

BB4 = CC0_SOUNDS / "BB_2HTC Samples Vol 4"
BB4A = CC0_SOUNDS / "BB_2HTC Samples Vol 4 Addendum"
RETAIL = CC0_SOUNDS / "BB_Retail Therapy Sample Pack"
SFX100 = CC0_SOUNDS / "100-CC0-SFX"
WATER40 = CC0_SOUNDS / "40-cc0-water-splash-slime-sfx"
LOOPS30 = CC0_SOUNDS / "30-cc0-sfx-loops"
WOOSH = CC0_SOUNDS / "Micro Pack - Organic Wooshes"
CELLO = CC0_SOUNDS / "bb - Novice Cello (Nov 2021)"
PLOPS = CC0_SOUNDS / "bb - Bottle Plops (Apr 2021)"

# gain suggestions (linear) for a mix where wind = 0.35 and a bowl = 0.6
GAIN = {"wind": 0.35, "stream": 0.30, "water": 0.30, "bubbles": 0.22, "pad": 0.40, "bowl": 0.60, "glass": 0.50,
        "bell": 0.50, "gong": 0.45, "splash": 0.50, "pluck": 0.55, "whoosh": 0.40, "plop": 0.45, "ting": 0.45}

# --------------------------------------------------------------------------- dsp helpers

def decode(path, channels):
    cmd = [ffmpeg_exe(), "-v", "error", "-i", str(path), "-f", "f32le", "-acodec", "pcm_f32le",
           "-ar", str(SR), "-ac", str(channels), "-"]
    raw = subprocess.run(cmd, check=True, capture_output=True).stdout
    x = np.frombuffer(raw, dtype=np.float32).reshape(-1, channels).astype(np.float64)
    return x


def encode_ogg(x, path):
    x = np.clip(x, -1.0, 1.0).astype(np.float32)
    ch = x.shape[1]
    cmd = [ffmpeg_exe(), "-v", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", str(ch), "-i", "-",
           "-c:a", "libvorbis", "-q:a", "4", "-ar", str(SR), str(path)]
    subprocess.run(cmd, input=x.tobytes(), check=True, capture_output=True)


def db(x):
    return 20 * math.log10(max(x, 1e-12))


def trim_silence(x, thresh_db=-60.0, fade_ms=5.0, pad_ms=0.0):
    thr = 10 ** (thresh_db / 20)
    env = np.abs(x).max(axis=1)
    idx = np.nonzero(env > thr)[0]
    if len(idx) == 0:
        return x
    a = max(0, idx[0] - int(pad_ms * SR / 1000))
    b = min(len(x), idx[-1] + 1 + int(pad_ms * SR / 1000))
    y = x[a:b].copy()
    n = min(int(fade_ms * SR / 1000), len(y) // 2)
    if n > 0:
        ramp = np.linspace(0, 1, n)[:, None]
        y[:n] *= ramp
        y[-n:] *= ramp[::-1]
    return y


def normalize_peak(x, peak_db=-1.0):
    p = np.abs(x).max()
    if p <= 0:
        return x
    return x * (10 ** (peak_db / 20) / p)


def make_loop(src, start_s, loop_s, xfade_s):
    """Seamless loop: output = src[start+X : start+X+L]; the last X samples are crossfaded (equal power)
    into the X samples that *precede* the output start, so sample L-1 flows into sample 0 like the original."""
    X = int(round(xfade_s * SR))
    L = int(round(loop_s * SR))
    s0 = int(round(start_s * SR))
    seg = src[s0: s0 + L + X]
    assert len(seg) == L + X, "source too short for the requested loop"
    out = seg[X:X + L].copy()
    t = np.linspace(0, 1, X)[:, None]
    w_in = np.sin(0.5 * math.pi * t)          # equal-power crossfade
    w_out = np.cos(0.5 * math.pi * t)
    out[L - X:] = out[L - X:] * w_out + seg[:X] * w_in
    return out


def loop_continuity(x, win_s=0.25):
    """Metrics at the wrap point of loop x (end -> start)."""
    jump = float(np.abs(x[-1] - x[0]).max())
    typical = float(np.median(np.abs(np.diff(x, axis=0)).max(axis=1)) + 1e-12)
    n = int(win_s * SR)
    rms_end = float(np.sqrt((x[-n:] ** 2).mean()))
    rms_start = float(np.sqrt((x[:n] ** 2).mean()))
    return {"sampleJump": jump, "typicalSampleStep": typical, "jumpRatio": jump / typical,
            "rmsEndDb": db(rms_end), "rmsStartDb": db(rms_start), "rmsMismatchDb": abs(db(rms_end) - db(rms_start))}


def loop_quality_score(x, win_s=0.1):
    """How well a raw file already loops: RMS mismatch + log-spectral distance between its first and last window."""
    n = int(win_s * SR)
    a = x[:n].mean(axis=1) * np.hanning(n)
    b = x[-n:].mean(axis=1) * np.hanning(n)
    A = np.log10(np.abs(np.fft.rfft(a)) + 1e-6)
    B = np.log10(np.abs(np.fft.rfft(b)) + 1e-6)
    spec = float(np.abs(A - B).mean())
    rms = abs(db(float(np.sqrt((x[:n] ** 2).mean()))) - db(float(np.sqrt((x[-n:] ** 2).mean()))))
    return {"rmsMismatchDb": rms, "logSpectralDistance": spec, "score": rms + 10 * spec}


def best_loop_start(src, loop_s, xfade_s, candidates_s):
    """Pick the start offset whose crossfade head/tail regions match best in loudness and spectrum."""
    X = int(round(xfade_s * SR)); L = int(round(loop_s * SR))
    best = None
    for st in candidates_s:
        s0 = int(round(st * SR))
        if s0 + L + X > len(src):
            continue
        head = src[s0:s0 + X]                 # what gets faded in at the end
        tail = src[s0 + L:s0 + L + X]         # what gets faded out at the end
        q = loop_quality_score(np.concatenate([tail, head]), win_s=min(0.5, xfade_s))
        if best is None or q["score"] < best[1]["score"]:
            best = (st, q)
    return best

# --------------------------------------------------------------------------- pitch analysis

def _onset(x):
    env = np.abs(x)
    peak = env.max()
    i0 = int(np.argmax(env > 0.1 * peak))          # -20 dB rel. peak
    ipk = int(np.argmax(env))
    return i0, ipk


def _spectral_peaks(seg, fmin=40.0, fmax=8000.0, max_peaks=40):
    """Prominent partials of a windowed segment: (frequency Hz, amplitude relative to the strongest)."""
    N = 1 << 17
    spec = np.abs(np.fft.rfft(seg * np.hanning(len(seg)), N))
    f = np.fft.rfftfreq(N, 1.0 / SR)
    df = f[1] - f[0]
    mag = np.where((f >= fmin) & (f <= fmax), spec, 0.0)
    m = mag.max()
    if m <= 0:
        return [], spec, f
    idx = np.nonzero((mag[1:-1] > mag[:-2]) & (mag[1:-1] >= mag[2:]) & (mag[1:-1] > 0.01 * m))[0] + 1
    w = int(150.0 / df)
    peaks = []
    for k in idx:
        local = np.median(mag[max(0, k - w):k + w + 1])
        if mag[k] < 2.0 * local:               # < 6 dB above the local floor: not a partial
            continue
        a, b, c = mag[k - 1], mag[k], mag[k + 1]
        d = 0.5 * (a - c) / (a - 2 * b + c) if (a - 2 * b + c) != 0 else 0.0
        peaks.append((float(f[k] + d * df), float(b / m)))
    peaks.sort(key=lambda p: -p[1])
    return peaks[:max_peaks], spec, f


def _amp_at(peaks, fk, tol=0.02):
    amps = [a for fp, a in peaks if abs(fp - fk) <= tol * fk]
    return max(amps) if amps else 0.0


def _harmonic_score(f0, peaks, tol=0.02, nharm=8):
    """Own amplitude plus 1/sqrt(k)-weighted amplitudes of partials found at k*f0 (+-tol). Candidates below
    120 Hz must be supported by at least two harmonics, which rejects handling/room rumble."""
    if f0 < 120.0 and sum(1 for k in range(2, nharm + 1) if _amp_at(peaks, k * f0, tol) > 0.05) < 2:
        return 0.0
    return sum(_amp_at(peaks, k * f0, tol) / math.sqrt(k) for k in range(1, nharm + 1))


def estimate_pitch(x, fmin=50.0, fmax=8000.0, win_s=0.2, delay_s=0.02):
    """Fundamental of the sustained portion: a ~200 ms window starting `delay_s` after the attack peak.
    Method: find prominent partials, score every partial (plus 1/2 and 1/3 of the strongest one when such a
    partial really exists) as a candidate f0 by the harmonic series it explains (own amplitude + 1/k-weighted
    harmonics weighted 1/sqrt(k), 2 % tolerance; sub-120 Hz candidates need >= 2 harmonics so room
    rumble cannot win) and take the best. For inharmonic
    bowls/bells with one dominant partial this returns that partial, i.e. the perceived strike tone.
    Autocorrelation is reported as a cross-check only."""
    m = x.mean(axis=1) if x.ndim == 2 else x
    i0, ipk = _onset(m)
    start = ipk + int(delay_s * SR)
    n = int(win_s * SR)
    if start + n > len(m):
        start = max(i0, len(m) - n)
    seg = m[start:start + n]
    if len(seg) < int(0.05 * SR):
        return None
    seg = seg - seg.mean()
    peaks, spec, f = _spectral_peaks(seg)
    if not peaks:
        return None
    f_top = peaks[0][0]
    cands = [fp for fp, a in peaks if fmin <= fp <= fmax and a >= 0.1]
    for div in (2, 3):
        sub = f_top / div
        if fmin <= sub <= fmax and _amp_at(peaks, sub) >= 0.2:
            cands.append(sub)
    if not cands:
        cands = [f_top]
    scored = sorted(((_harmonic_score(c, peaks), c) for c in cands), key=lambda t: (-t[0], t[1]))
    f0 = float(scored[0][1])
    # autocorrelation cross-check: first peak after the first minimum of the normalised ACF
    ac = np.fft.irfft(np.abs(np.fft.rfft(seg * np.hanning(len(seg)), 1 << 17)) ** 2)[:len(seg)]
    ac /= (ac[0] + 1e-12)
    lag_min, lag_max = int(SR / fmax), int(SR / fmin)
    first_min = lag_min + int(np.argmax(np.diff(ac[lag_min:lag_max]) > 0)) if lag_max > lag_min + 2 else lag_min
    lag = first_min + int(np.argmax(ac[first_min:lag_max]))
    f_ac = SR / max(lag, 1)
    midi_f = 69 + 12 * math.log2(f0 / 440.0)
    midi = int(round(midi_f))
    cents = 100.0 * (midi_f - midi)
    return {"pitchHz": round(f0, 2), "midi": midi, "note": f"{NOTE_NAMES[midi % 12]}{midi // 12 - 1}",
            "cents": round(cents, 1), "method": "harmonic-peak-scoring", "harmonicScore": round(scored[0][0], 3),
            "acfHz": round(f_ac, 2), "strongestPartialHz": round(f_top, 2),
            "partialsHz": [round(fp, 1) for fp, _ in peaks[:6]], "windowStartSec": round(start / SR, 3)}


KK_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KK_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def chroma_key(x, fmin=80.0, fmax=2000.0):
    m = x.mean(axis=1) if x.ndim == 2 else x
    n, hop = 8192, 4096
    win = np.hanning(n)
    chroma = np.zeros(12)
    f = np.fft.rfftfreq(n, 1.0 / SR)
    band = (f >= fmin) & (f <= fmax)
    pcs = (np.round(69 + 12 * np.log2(np.maximum(f, 1e-3) / 440.0)).astype(int) % 12)
    for s in range(0, max(1, len(m) - n), hop):
        seg = m[s:s + n]
        if len(seg) < n:
            break
        mag = np.abs(np.fft.rfft(seg * win))
        # keep only local spectral peaks so broadband energy does not smear the chroma
        peaks = (mag[1:-1] > mag[:-2]) & (mag[1:-1] > mag[2:])
        sel = np.zeros_like(mag, dtype=bool); sel[1:-1] = peaks
        sel &= band
        np.add.at(chroma, pcs[sel], mag[sel])
    if chroma.sum() <= 0:
        return None
    chroma /= chroma.sum()
    top3 = [NOTE_NAMES[i] for i in np.argsort(chroma)[::-1][:3]]
    best = None
    for tonic in range(12):
        for name, prof in (("major", KK_MAJOR), ("minor", KK_MINOR)):
            r = float(np.corrcoef(np.roll(prof, tonic), chroma)[0, 1])
            if best is None or r > best[2]:
                best = (tonic, name, r)
    return {"key": f"{NOTE_NAMES[best[0]]} {best[1]}", "keyCorrelation": round(best[2], 3), "topPitchClasses": top3,
            "chroma": [round(float(c), 3) for c in chroma]}

# --------------------------------------------------------------------------- build

def _entry(file, kind, x, loop, gain, source, tonal=False, pad=False, extra=None):
    e = {"file": file, "kind": kind, "channels": int(x.shape[1]), "duration": round(len(x) / SR, 3), "loop": loop,
         "gain": gain, "pitchHz": None, "midi": None, "note": None, "cents": None, "key": None, "source": source}
    analysis = dict(extra or {})
    if tonal or pad:
        p = estimate_pitch(x)
        if p:
            e.update({k: p[k] for k in ("pitchHz", "midi", "note", "cents")})
            analysis["pitch"] = p
    if pad:
        ck = chroma_key(x)
        if ck:
            e["key"] = ck["key"]
            analysis["key"] = ck
    if analysis:
        e["analysis"] = analysis
    return e


def process_oneshot(src, name, channels, gain, source, tonal=False, pad=False):
    x = decode(src, channels)
    x = normalize_peak(trim_silence(x))
    encode_ogg(x, DST / name)
    return _entry(name, "pad" if pad else "oneshot", x, False, gain, source, tonal=tonal, pad=pad)


def process_loop(src, name, channels, gain, source, loop_s=None, xfade_s=2.0, candidates=None):
    raw = decode(src, channels)
    if loop_s is None:                      # whole file is the loop (short loop files)
        xfade_s = min(xfade_s, 0.1 * len(raw) / SR)
        loop_s = len(raw) / SR - xfade_s
        start, q = 0.0, None
    else:
        start, q = best_loop_start(raw, loop_s, xfade_s, candidates or [0.0])
    x = normalize_peak(make_loop(raw, start, loop_s, xfade_s))
    encode_ogg(x, DST / name)
    cont = loop_continuity(x)
    extra = {"loopStartSec": start, "loopCrossfadeSec": xfade_s, "loopContinuity": cont}
    if q:
        extra["loopStartSearch"] = q
    log(f"  loop {name}: start={start:.1f}s len={loop_s:.2f}s xfade={xfade_s:.2f}s "
        f"jumpRatio={cont['jumpRatio']:.2f} rmsMismatch={cont['rmsMismatchDb']:.2f} dB")
    return _entry(name, "loop", x, True, gain, source, extra=extra)


def gentleness_table():
    """Rank the 15 splashes: crest factor (peak/RMS, dB, ascending) + attack time (onset->90% peak, descending)."""
    rows = []
    for i in range(1, 16):
        p = WATER40 / f"splash_{i:02d}.ogg"
        x = normalize_peak(trim_silence(decode(p, 1)))
        m = x[:, 0]
        peak = np.abs(m).max(); rms = np.sqrt((m ** 2).mean())
        crest = db(peak) - db(rms)
        i0, _ = _onset(m)
        i90 = int(np.argmax(np.abs(m) >= 0.9 * peak))
        attack = (i90 - i0) / SR
        rows.append({"file": p.name, "crestDb": round(crest, 2), "attackSec": round(attack, 4), "duration": round(len(m) / SR, 3)})
    by_crest = sorted(range(len(rows)), key=lambda i: rows[i]["crestDb"])
    by_attack = sorted(range(len(rows)), key=lambda i: -rows[i]["attackSec"])
    for rank, i in enumerate(by_crest):
        rows[i]["rankCrest"] = rank
    for rank, i in enumerate(by_attack):
        rows[i]["rankAttack"] = rank
    for r in rows:
        r["rankSum"] = r["rankCrest"] + r["rankAttack"]
    rows.sort(key=lambda r: (r["rankSum"], r["crestDb"]))
    return rows


def build(report):
    DST.mkdir(parents=True, exist_ok=True)
    manifest = []
    decisions = {}

    # ---- beds / loops
    log("audio: wind loop")
    manifest.append(process_loop(AMBIENT / "wind.ogg", "wind_loop.ogg", 2, GAIN["wind"], WIND_SRC,
                                 loop_s=75.0, xfade_s=2.0, candidates=[float(s) for s in range(5, 90, 5)]))
    log("audio: stream loop")
    manifest.append(process_loop(AMBIENT / "stream.ogg", "stream_loop.ogg", 1, GAIN["stream"], STREAM_SRC,
                                 loop_s=45.0, xfade_s=2.0, candidates=[float(s) for s in range(0, 74, 4)]))

    cands = {"water_flowing.ogg": (LOOPS30 / "water_flowing.ogg", oga("water_flowing", "30 CC0 SFX loops")),
             "loop_water_03.ogg": (WATER40 / "loop_water_03.ogg", oga("loop_water_03", "40 CC0 water/splash/slime SFX"))}
    scores = {k: loop_quality_score(decode(v[0], 1)) for k, v in cands.items()}
    pick = min(scores, key=lambda k: scores[k]["score"])
    decisions["water_loop_1"] = {"candidates": scores, "picked": pick}
    log(f"audio: water loop candidates {scores} -> {pick}")
    manifest.append(process_loop(cands[pick][0], "water_loop_1.ogg", 1, GAIN["water"], cands[pick][1], xfade_s=0.25))

    bcands = {"loop_bubbles_1.ogg": WATER40 / "loop_bubbles_1.ogg", "loop_bubbles_02.ogg": WATER40 / "loop_bubbles_02.ogg"}
    bscores = {k: loop_quality_score(decode(v, 1)) for k, v in bcands.items()}
    bpick = min(bscores, key=lambda k: bscores[k]["score"])
    decisions["bubbles_loop"] = {"candidates": bscores, "picked": bpick}
    manifest.append(process_loop(bcands[bpick], "bubbles_loop.ogg", 1, GAIN["bubbles"],
                                 oga(bpick[:-4], "40 CC0 water/splash/slime SFX"), xfade_s=0.25))

    # ---- pads (stereo, full length)
    log("audio: pads")
    pads = [
        (BB4A / "Pads/2024-01-13 Bioluminescence - Watery Pad.wav", "pad_bioluminescence.ogg",
         burnes("Bioluminescence - Watery Pad", "2HTC Samples Vol 4 Addendum")),
        (BB4 / "Pads/2022-09-07 Swimming in the Northern Lights - Swell Pads.wav", "pad_northern_swell.ogg",
         burnes("Swimming in the Northern Lights - Swell Pads", "2HTC Samples Vol 4")),
        (BB4 / "Pads/2022-09-07 Swimming in the Northern Lights - Brilliant Lights.wav", "pad_northern_brilliant.ogg",
         burnes("Swimming in the Northern Lights - Brilliant Lights", "2HTC Samples Vol 4")),
        (BB4A / "Weird/2023-10-15 Seafoam - Quiet Waves.wav", "pad_seafoam_waves.ogg",
         burnes("Seafoam - Quiet Waves", "2HTC Samples Vol 4 Addendum")),
    ]
    for src, name, meta in pads:
        manifest.append(process_oneshot(src, name, 2, GAIN["pad"], meta, pad=True))

    # ---- tonal one-shots (mono)
    log("audio: tonal one-shots")
    for i in range(1, 8):
        manifest.append(process_oneshot(RETAIL / f"Ceramic Bowl {i}.wav", f"bowl_{i}.ogg", 1, GAIN["bowl"],
                                        burnes(f"Ceramic Bowl {i}", "Retail Therapy Sample Pack"), tonal=True))
    manifest.append(process_oneshot(RETAIL / "Glass Glasses 1.wav", "glass_1.ogg", 1, GAIN["glass"],
                                    burnes("Glass Glasses 1", "Retail Therapy Sample Pack"), tonal=True))
    manifest.append(process_oneshot(SFX100 / "glass_02.ogg", "glass_2.ogg", 1, GAIN["glass"],
                                    oga("glass_02", "100 CC0 SFX"), tonal=True))
    for i in range(1, 4):
        manifest.append(process_oneshot(SFX100 / f"bell_{i:02d}.ogg", f"bell_{i}.ogg", 1, GAIN["bell"],
                                        oga(f"bell_{i:02d}", "100 CC0 SFX"), tonal=True))
    for i in range(1, 3):
        manifest.append(process_oneshot(SFX100 / f"gong_{i:02d}.ogg", f"gong_{i}.ogg", 1, GAIN["gong"],
                                        oga(f"gong_{i:02d}", "100 CC0 SFX"), tonal=True))
    for note in ("C2", "G2", "D3", "A3"):
        manifest.append(process_oneshot(CELLO / f"{note} - Pluck 1.wav", f"pluck_cello_{note.lower()}.ogg", 1, GAIN["pluck"],
                                        burnes(f"{note} - Pluck 1", "Novice Cello (Nov 2021)"), tonal=True))
    for i in range(1, 5):
        manifest.append(process_oneshot(RETAIL / f"Silverware Ting {i}.wav", f"ting_{i}.ogg", 1, GAIN["ting"],
                                        burnes(f"Silverware Ting {i}", "Retail Therapy Sample Pack"), tonal=True))

    # ---- splashes: 4 gentlest
    log("audio: splashes")
    table = gentleness_table()
    decisions["splash_soft"] = {"method": "rank-sum of crest factor (peak/RMS dB, ascending) and attack time "
                                          "(onset(-20 dB) -> 90% of peak, descending), ties by crest", "table": table}
    for k, row in enumerate(table[:4], start=1):
        manifest.append(process_oneshot(WATER40 / row["file"], f"splash_soft_{k}.ogg", 1, GAIN["splash"],
                                        oga(row["file"][:-4], "40 CC0 water/splash/slime SFX")))
        manifest[-1].setdefault("analysis", {})["gentleness"] = row
    log("  gentlest: " + ", ".join(f"{r['file']} (crest {r['crestDb']} dB, attack {r['attackSec'] * 1000:.0f} ms)" for r in table[:4]))

    # ---- extras that fit a quiet night lake
    log("audio: extras")
    manifest.append(process_oneshot(WOOSH / "Gentle Swish.wav", "whoosh_gentle.ogg", 1, GAIN["whoosh"],
                                    burnes("Gentle Swish", "Micro Pack - Organic Wooshes")))
    for i in (1, 2):
        manifest.append(process_oneshot(WOOSH / f"Twirl Smol {i}.wav", f"whoosh_twirl_{i}.ogg", 1, GAIN["whoosh"],
                                        burnes(f"Twirl Smol {i}", "Micro Pack - Organic Wooshes")))
    manifest.append(process_oneshot(PLOPS / "Plop - Airy 1.wav", "plop_airy_1.ogg", 1, GAIN["plop"],
                                    burnes("Plop - Airy 1", "Bottle Plops (Apr 2021)")))

    decisions["outside_wav"] = ("bb - Fans and Drones (Jul 2021)/Outside.wav rejected: 53 s stereo recording whose "
                                "spectrum is a stationary 72 Hz hum with 51% of the energy below 200 Hz and only 2% above "
                                "2 kHz (no insects, leaves or water); it reads as distant machinery/traffic rumble, not nature.")

    for e in manifest:
        e["bytes"] = (DST / e["file"]).stat().st_size
    total = sum(e["bytes"] for e in manifest)
    log(f"audio: {len(manifest)} files, {total / 1e6:.2f} MB")
    write_json(DST / "manifest.json", manifest)
    write_json(OUT / "audio_decisions.json", decisions)
    report["audio"] = {"files": len(manifest), "bytes": total, "decisions": decisions,
                       "pitch": [{k: e.get(k) for k in ("file", "pitchHz", "midi", "note", "cents", "key")}
                                 for e in manifest if e.get("pitchHz")]}
