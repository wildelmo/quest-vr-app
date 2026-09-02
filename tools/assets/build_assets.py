#!/usr/bin/env python3
"""Build every runtime asset for NOCTURNE from the licensed sources (see README.md).

    python3 tools/assets/build_assets.py            # everything
    python3 tools/assets/build_assets.py --only audio,textures

Requires python3 with numpy, pillow, imageio-ffmpeg (bundled ffmpeg with libvorbis).
"""
import argparse
import json
import os
import struct
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ASSETS, OUT, REPO, ffmpeg_exe, log, fmt_size, write_json, ensure_dirs  # noqa: E402

STEPS = ["sky", "textures", "audio", "hands", "fonts"]
BUDGET_TOTAL = 30 * 1024 * 1024
BUDGET_AUDIO = 12 * 1024 * 1024


def verify(report):
    from PIL import Image
    problems = []
    log("verify: images")
    expect = {"sky/milkyway_4k.jpg": ((4096, 2048), "RGB"), "sky/milkyway_2k.jpg": ((2048, 1024), "RGB"),
              "textures/glow_soft.png": ((256, 256), "RGBA"), "textures/glow_firefly.png": ((64, 64), "RGBA"),
              "textures/paper.png": ((512, 512), "RGBA"), "textures/ripple_ring.png": ((128, 128), "RGBA"),
              "textures/moon_512.jpg": ((512, 256), "RGB"), "textures/caustic.jpg": ((512, 512), "L")}
    for rel, (size, mode) in expect.items():
        p = ASSETS / rel
        if not p.exists():
            problems.append(f"missing {rel}"); continue
        im = Image.open(p)
        if im.size != size or im.mode != mode:
            problems.append(f"{rel}: {im.size} {im.mode} != {size} {mode}")
    for p in sorted((ASSETS / "textures").glob("*")):
        if p.suffix in (".png", ".jpg"):
            Image.open(p).verify()

    log("verify: ogg decode")
    for p in sorted((ASSETS / "audio").glob("*.ogg")):
        r = subprocess.run([ffmpeg_exe(), "-v", "error", "-i", str(p), "-f", "null", "-"], capture_output=True)
        if r.returncode != 0 or r.stderr:
            problems.append(f"{p.name}: ffmpeg decode error {r.stderr.decode()[:200]}")
    man = json.load(open(ASSETS / "audio" / "manifest.json"))
    for e in man:
        if not (ASSETS / "audio" / e["file"]).exists():
            problems.append(f"manifest references missing {e['file']}")

    log("verify: stars.bin")
    sj = json.load(open(ASSETS / "sky" / "stars.json"))
    nbytes = (ASSETS / "sky" / "stars.bin").stat().st_size
    if nbytes != sj["count"] * 16:
        problems.append(f"stars.bin is {nbytes} bytes, expected {sj['count'] * 16}")
    if sj["validation"]["maxErrLongitudeDeg"] > 0.1 or sj["validation"]["maxErrLatitudeDeg"] > 0.1:
        problems.append("galactic conversion error > 0.1 deg")
    for rel in ("hands/left.glb", "hands/right.glb", "hands/profile.json", "fonts/fonts.css", "sky/sky.json"):
        if not (ASSETS / rel).exists():
            problems.append(f"missing {rel}")
    report["verify"] = {"problems": problems}
    return problems


def size_table(report):
    rows = []
    total = 0
    per_dir = {}
    for p in sorted(ASSETS.rglob("*")):
        if p.is_file():
            n = p.stat().st_size
            rows.append((p.relative_to(ASSETS).as_posix(), n))
            total += n
            d = p.relative_to(ASSETS).parts[0]
            per_dir[d] = per_dir.get(d, 0) + n
    print("\n" + "=" * 64)
    print(f"{'assets/ file':46s} {'size':>12s}")
    print("-" * 64)
    for rel, n in rows:
        print(f"{rel:46s} {fmt_size(n):>12s}")
    print("-" * 64)
    for d, n in sorted(per_dir.items()):
        print(f"{d + '/':46s} {fmt_size(n):>12s}")
    print(f"{'TOTAL':46s} {fmt_size(total):>12s}   (budget {fmt_size(BUDGET_TOTAL)})")
    print("=" * 64)
    report["sizes"] = {"files": dict(rows), "dirs": per_dir, "total": total}
    return total, per_dir


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", default="all", help="comma list of steps: " + ",".join(STEPS))
    ap.add_argument("--no-verify", action="store_true")
    args = ap.parse_args()
    steps = STEPS if args.only == "all" else [s.strip() for s in args.only.split(",")]
    ensure_dirs()
    report = {"startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "steps": steps}
    if "sky" in steps:
        import sky; sky.build(report)
    if "textures" in steps:
        import textures; textures.build(report)
    if "audio" in steps:
        import audio; audio.build(report)
    if "hands" in steps:
        import hands_fonts; hands_fonts.build_hands(report)
    if "fonts" in steps:
        import hands_fonts; hands_fonts.build_fonts(report)
    problems = [] if args.no_verify else verify(report)
    total, per_dir = size_table(report)
    if total > BUDGET_TOTAL:
        problems.append(f"assets/ total {fmt_size(total)} exceeds 30 MB budget")
    if per_dir.get("audio", 0) > BUDGET_AUDIO:
        problems.append(f"assets/audio {fmt_size(per_dir['audio'])} exceeds 12 MB budget")
    write_json(OUT / "build_report.json", report)
    if problems:
        print("PROBLEMS:\n  " + "\n  ".join(problems))
        sys.exit(1)
    log("build OK")


if __name__ == "__main__":
    main()
