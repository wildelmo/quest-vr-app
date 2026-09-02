"""Hand meshes (@webxr-input-profiles/assets) and self-hosted Google Fonts."""
import re
import shutil
import struct
import urllib.request

from common import HANDS_SRC, ASSETS, log, write_json

HANDS_DST = ASSETS / "hands"
FONTS_DST = ASSETS / "fonts"

FONTS_CSS_URL = ("https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400"
                 "&family=Inter:wght@400;600&display=swap")
CHROME_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
             "Chrome/128.0.0.0 Safari/537.36")

FALLBACK_CSS = """/* Google Fonts could not be downloaded at build time: system fallbacks only. */
:root {
  --font-display: 'Cormorant Garamond', 'Garamond', 'EB Garamond', 'Times New Roman', serif;
  --font-body: 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
}
"""

# --------------------------------------------------------------------------- hands

def build_hands(report):
    HANDS_DST.mkdir(parents=True, exist_ok=True)
    src = HANDS_SRC / "dist/profiles/generic-hand"
    files = {}
    # XRHandMeshModel builds `${path}${handedness}.glb`, so the files must be exactly left.glb / right.glb
    # directly inside the directory, and the path given to XRHandModelFactory.setPath() must end with '/'.
    for name in ("left.glb", "right.glb", "profile.json"):
        shutil.copyfile(src / name, HANDS_DST / name)
        files[name] = (HANDS_DST / name).stat().st_size
    shutil.copyfile(HANDS_SRC / "LICENSE.md", HANDS_DST / "LICENSE.md")
    pkg = (HANDS_SRC / "package.json").read_text()
    version = re.search(r'"version":\s*"([^"]+)"', pkg).group(1)
    license_text = (HANDS_SRC / "LICENSE.md").read_text().splitlines()[0].strip()
    write_json(HANDS_DST / "hands.json", {
        "package": "@webxr-input-profiles/assets", "version": version, "profile": "generic-hand",
        "license": f"{license_text} (see LICENSE.md; Copyright (c) 2019 Amazon)",
        "url": "https://github.com/immersive-web/webxr-input-profiles",
        "files": list(files),
        "usage": "new XRHandModelFactory().setPath('assets/hands/')  -- trailing slash required: "
                 "XRHandMeshModel loads `${path}${handedness}.glb`",
    })
    log(f"hands: {files} license={license_text} version={version}")
    report["hands"] = {"files": files, "license": license_text, "version": version}

# --------------------------------------------------------------------------- fonts

def _fetch(url, binary=True):
    req = urllib.request.Request(url, headers={"User-Agent": CHROME_UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = r.read()
    return data if binary else data.decode("utf-8")


WOFF2_KNOWN_TAGS = ("cmap head hhea hmtx maxp name OS/2 post cvt  fpgm glyf loca prep CFF  VORG EBDT EBLC gasp hdmx "
                    "kern LTSH PCLT VDMX vhea vmtx BASE GDEF GPOS GSUB EBSC JSTF MATH CBDT CBLC COLR CPAL SVG  sbix "
                    "acnt avar bdat bloc bsln cvar fdsc feat fmtx fvar gvar hsty just lcar mort morx opbd prop trak "
                    "Zapf Silf Glat Gloc Feat Sill")


def woff2_tables(data):
    """Table tags of a WOFF2 file (enough to tell whether it is a variable font: has 'fvar')."""
    tags = [WOFF2_KNOWN_TAGS[i * 5:i * 5 + 4] for i in range(63)]
    assert data[:4] == b"wOF2"
    num_tables = struct.unpack(">H", data[12:14])[0]
    pos = 48
    out = []

    def base128():
        nonlocal pos
        v = 0
        for _ in range(5):
            b = data[pos]; pos += 1
            v = (v << 7) | (b & 0x7F)
            if not b & 0x80:
                return v
        raise ValueError("bad UIntBase128")

    for _ in range(num_tables):
        flags = data[pos]; pos += 1
        if flags & 0x3F == 0x3F:
            tag = data[pos:pos + 4].decode("latin-1"); pos += 4
        else:
            tag = tags[flags & 0x3F]
        base128()                                   # origLength
        xform = (flags >> 6) & 3
        transformed = (xform == 0) if tag.strip() in ("glyf", "loca") else (xform != 0)
        if transformed:
            base128()                               # transformLength
        out.append(tag.strip())
    return out


def build_fonts(report):
    FONTS_DST.mkdir(parents=True, exist_ok=True)
    info = {"ok": False, "files": {}, "license": "SIL Open Font License 1.1"}
    try:
        css = _fetch(FONTS_CSS_URL, binary=False)
        blocks = re.findall(r"/\* (\S+) \*/\s*@font-face \{(.*?)\}", css, re.S)
        faces = []
        for subset, body in blocks:
            if subset != "latin":
                continue
            fam = re.search(r"font-family: '([^']+)'", body).group(1)
            sty = re.search(r"font-style: (\w+)", body).group(1)
            wgt = re.search(r"font-weight: (\d+)", body).group(1)
            url = re.search(r"url\((\S+?)\)", body).group(1)
            faces.append((fam, sty, int(wgt), url))
        if not faces:
            raise RuntimeError("no latin @font-face blocks in the Google Fonts CSS")
        # download each unique URL once (Google serves one variable-font file for several weights)
        local = {}
        for fam, sty, wgt, url in faces:
            if url in local:
                continue
            data = _fetch(url)
            slug = fam.lower().replace(" ", "-")
            fname = f"{slug}-latin-{sty}-{len([u for u in local.values() if u.startswith(slug)]) + 1}.woff2"
            (FONTS_DST / fname).write_bytes(data)
            local[url] = fname
            tables = woff2_tables(data)
            info["files"][fname] = {"bytes": len(data), "variable": "fvar" in tables, "url": url}
        # merge weights that share a file into one @font-face with a weight range
        rules = {}
        for fam, sty, wgt, url in faces:
            key = (fam, sty, local[url])
            rules.setdefault(key, []).append(wgt)
        out = ["/* Self-hosted Google Fonts (latin subset), SIL Open Font License 1.1.",
               " * Cormorant Garamond: Christian Thalmann (Catharsis Fonts). Inter: Rasmus Andersson.",
               " * Fetched from fonts.googleapis.com by tools/assets/build_assets.py. */", ""]
        for (fam, sty, fname), wgts in rules.items():
            variable = info["files"][fname]["variable"]
            if variable and len(wgts) > 1:
                weight = f"{min(wgts)} {max(wgts)}"
            else:
                weight = " ".join(str(w) for w in sorted(set(wgts))) if variable else str(wgts[0])
            out += ["@font-face {", f"  font-family: '{fam}';", f"  font-style: {sty};", f"  font-weight: {weight};",
                    "  font-display: swap;", f"  src: url('{fname}') format('woff2');",
                    "  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, "
                    "U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;",
                    "}", ""]
        out += [":root {",
                "  --font-display: 'Cormorant Garamond', 'Garamond', 'Times New Roman', serif;",
                "  --font-body: 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;",
                "}", ""]
        (FONTS_DST / "fonts.css").write_text("\n".join(out))
        info["ok"] = True
        info["faces"] = [{"family": f, "style": s, "weight": w, "file": local[u]} for f, s, w, u in faces]
        log(f"fonts: {len(faces)} latin faces -> {len(local)} woff2 files: "
            + ", ".join(f"{k} ({v['bytes']} B, variable={v['variable']})" for k, v in info['files'].items()))
    except Exception as exc:  # network blocked or CSS format changed
        (FONTS_DST / "fonts.css").write_text(FALLBACK_CSS)
        info["error"] = repr(exc)
        log(f"fonts: download FAILED ({exc!r}); wrote system-font fallback fonts.css")
    (FONTS_DST / "LICENSE.txt").write_text(
        "Cormorant Garamond (Christian Thalmann / Catharsis Fonts) and Inter (Rasmus Andersson) are licensed under\n"
        "the SIL Open Font License, Version 1.1: https://openfontlicense.org/\n"
        "Files fetched from Google Fonts (fonts.gstatic.com), latin subset only.\n")
    report["fonts"] = info
