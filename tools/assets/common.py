"""Shared paths and helpers for the NOCTURNE asset pipeline."""
import os
import sys
import json
import time
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
ASSETS = REPO / "assets"
OUT = HERE / "out"

# Source locations (override with env vars if the sources live elsewhere).
SRC = Path(os.environ.get("NOCTURNE_ASSET_SRC", "/home/user/assets-src"))
THREE_TEX = Path(os.environ.get("NOCTURNE_THREE_TEXTURES", "/home/user/mrdoob/three.js/examples/textures"))
HANDS_SRC = Path(os.environ.get(
    "NOCTURNE_HANDS_SRC",
    "/tmp/claude-0/-home-user-quest-vr-app/ae7f4cfd-c264-5184-9059-7a8ed9aad3c0/scratchpad/pkgs/hands/package"))

CC0_SOUNDS = SRC / "CC0-Public-Domain-Sounds"
AMBIENT = SRC / "ambientsounds"

_T0 = time.time()


def log(*args):
    print(f"[{time.time() - _T0:7.1f}s]", *args, flush=True)


def ffmpeg_exe():
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def run(cmd, **kw):
    return subprocess.run(cmd, check=True, capture_output=True, **kw)


def fmt_size(n):
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n / 1024 / 1024:.2f} MB"


def write_json(path, obj):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
        f.write("\n")


def ensure_dirs():
    for d in ("sky", "textures", "audio", "hands", "fonts"):
        (ASSETS / d).mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
