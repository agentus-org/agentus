#!/usr/bin/env python3
"""Build every Agentus brand asset from the master logo PNG.

Source of truth
---------------
assets/logo/source/agentus-logo-source.png — the AI-generated master, kept verbatim so the
whole pipeline below is reproducible. Nothing downstream is hand-edited: change the master,
rerun, get new assets.

What it produces
----------------
assets/logo/            vector master (icon / wordmark / lockup) + PNG exports
packages/web/public/    favicon.svg, favicon.ico, apple-touch-icon, PWA icons (incl. maskable)
android/app/src/main/   launcher icons (adaptive + legacy + round) and the notification glyph

How
---
The master is a 2-ink raster (slate mark, sky-blue nodes) on a textured cream field. We
colour-classify those two inks, denoise hard (the AI render's field texture would otherwise
be traced as thousands of specks), trace each layer with potrace into flat SVG paths, and
rasterise the SVG at every size the web UI and the Android app need. The result is a real,
scalable source file we own instead of an upscaled bitmap.

Requirements: python3 + pillow + numpy, potrace, librsvg (rsvg-convert).
    python3 -m venv .venv && .venv/bin/pip install pillow numpy   # once
    brew install potrace librsvg

Run:  python3 scripts/build-brand-assets.py [--check]
      --check  only re-verify the committed assets against the master (no writes)
"""
from __future__ import annotations

import argparse
import io
import os
import re
import subprocess
import sys
from pathlib import Path

try:
    import numpy as np
    from PIL import Image, ImageDraw, ImageFilter
except ImportError:  # pragma: no cover
    sys.exit("needs pillow + numpy:  python3 -m venv .venv && .venv/bin/pip install pillow numpy")

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets/logo/source/agentus-logo-source.png"
OUT = ROOT / "assets/logo"
WEB_ICONS = ROOT / "packages/web/public/icons"
WEB_PUBLIC = ROOT / "packages/web/public"
ANDROID = ROOT / "android/app/src/main/res"

# ── the brand ────────────────────────────────────────────────────────────────────────────
INK = "#424D54"      # the mark: slate, measured off the master's core
ACCENT = "#76BBDF"   # the nodes: sky blue
CANVAS = "#FEFDF9"   # brand field: warm off-white
# Dark theme swaps work on a near-black background, so the mark lightens; the accent stays.
INK_DARK = "#DCE3E8"
ACCENT_DARK = "#8CCBF0"

# ── geometry of the master (found by scanning it, not guessed) ───────────────────────────
ICON_BOX = (133, 247, 1651, 1163)   # the mark
WORD_BOX = (120, 1280, 1700, 1630)  # the wordmark
TRACE_SCALE = 3                     # trace at 3x so curve fitting has room
TRACE_BLUR = 3.0                    # pre-blur: kills the field texture, keeps shapes crisp
TRACE_TURD = 60                     # drop specks below this area
TRACE_ALPHA = 2.5                   # corner threshold
TRACE_OPT = 2.0                     # curve optimisation tolerance
MASK_MARGIN = 25                    # colour-classification confidence
CLEAN_DENOISE = 9                   # median filter on the source before classifying


def write_pbm(mask: "np.ndarray", path: Path) -> None:
    """potrace reads PBM/PGM; write P4 by hand (PIL's convert('1') dithers and wrecks masks)."""
    h, w = mask.shape
    with open(path, "wb") as f:
        f.write(f"P4\n{w} {h}\n".encode())
        f.write(np.packbits(mask.astype(np.uint8), axis=1).tobytes())


def classify(box, gblur: float):
    """Split the crop into (ink mask, accent mask). Each pixel votes for the nearest ink."""
    im = Image.open(SRC).convert("RGB").crop(box).filter(ImageFilter.MedianFilter(CLEAN_DENOISE))
    if gblur:
        im = im.filter(ImageFilter.GaussianBlur(gblur))
    a = np.asarray(im).astype(float)
    reference = {
        "ink": np.array([0x42, 0x4D, 0x54], dtype=float),
        "accent": np.array([0x76, 0xBB, 0xDF], dtype=float),
        "canvas": np.array([0xFE, 0xFD, 0xF9], dtype=float),
    }
    d = {k: np.linalg.norm(a - v, axis=2) for k, v in reference.items()}
    ink = (d["ink"] + MASK_MARGIN < d["accent"]) & (d["ink"] + MASK_MARGIN < d["canvas"])
    accent = (d["accent"] + MASK_MARGIN < d["ink"]) & (d["accent"] + MASK_MARGIN < d["canvas"])

    def clean(m):
        img = Image.fromarray((m * 255).astype(np.uint8))
        for _ in range(2):
            img = img.filter(ImageFilter.MedianFilter(5))
        return np.asarray(img) > 127

    return clean(ink), clean(accent)


def tight_bbox(box, masks):
    m = np.logical_or.reduce([np.asarray(x) for x in masks])
    ys, xs = np.where(m)
    return (int(box[0] + xs.min()), int(box[1] + ys.min()), int(box[0] + xs.max() + 1), int(box[1] + ys.max() + 1))


def trace(mask, tag: str):
    """potrace a mask; return (svg text, source-crop size)."""
    h, w = mask.shape
    img = Image.fromarray((mask * 255).astype(np.uint8)).resize((w * TRACE_SCALE, h * TRACE_SCALE), Image.LANCZOS)
    if TRACE_BLUR:
        img = img.filter(ImageFilter.GaussianBlur(TRACE_BLUR))
    pbm = OUT / f".{tag}.pbm"
    svg = OUT / f".{tag}.svg"
    write_pbm(np.asarray(img) > 110, pbm)
    subprocess.run(
        ["potrace", "-s", "-o", str(svg), "--turdsize", str(TRACE_TURD),
         "-a", str(TRACE_ALPHA), "-O", str(TRACE_OPT), "-u", "10", str(pbm)],
        check=True,
    )
    text = svg.read_text()
    pbm.unlink()
    svg.unlink()
    return text, (h, w)


def _round(d: str, prec: int = 1) -> str:
    return re.sub(r"-?\d+\.\d+", lambda m: (f"{float(m.group(0)):.{prec}f}").rstrip("0").rstrip("."), d)


def paths(svg: str) -> str:
    b = re.search(r'<g transform="[^"]*"[^>]*>(.*)</g>', svg, re.S).group(1)
    return re.sub(r'\sd="([^"]*)"', lambda m: f' d="{_round(m.group(1))}"', b)


def layout(svg: str, color: str, origin, scale: float = 1 / TRACE_SCALE) -> str:
    """Place a traced layer at its true position in the master's pixel space."""
    t = re.search(r'<g transform="([^"]*)"', svg).group(1)
    return (f'<g transform="translate({origin[0]},{origin[1]}) scale({scale})">'
            f'<g fill="{color}" transform="{t}">{paths(svg)}</g></g>')


def svg_doc(viewbox, body: str, width=None, height=None) -> str:
    vb = " ".join(f"{v:.1f}".rstrip("0").rstrip(".") if isinstance(v, float) else str(v) for v in viewbox)
    dim = f' width="{width}" height="{height}"' if width else ""
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}"{dim}>\n{body}\n</svg>\n'


def raster(svg_text: str, path: Path, width: int, background: str | None = None) -> None:
    tmp = OUT / ".raster.svg"
    tmp.write_text(svg_text)
    cmd = ["rsvg-convert", "-w", str(width), "-o", str(path)]
    if background:
        cmd += ["-b", background]
    subprocess.run(cmd + [str(tmp)], check=True)
    tmp.unlink()


def raster_doc(viewbox, body, path: Path, width: int, background=None) -> None:
    raster(svg_doc(viewbox, body), path, width, background)


def centered_square(bbox, fill=0.86):
    """A square viewBox around a bbox — the shape every icon slot wants."""
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    side = max(w, h) / fill
    cx, cy = (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2
    return (cx - side / 2, cy - side / 2, side, side)


def report(name: str, path: Path) -> None:
    if path.suffix == ".svg":
        print(f"  {name:<34} {path.stat().st_size / 1024:7.1f} KB  (vector)")
        return
    im = Image.open(path)
    alpha = im.convert("RGBA").getchannel("A")
    bbox = alpha.getbbox()
    print(f"  {name:<34} {path.stat().st_size / 1024:7.1f} KB  {im.size[0]}x{im.size[1]} px  alpha={'yes' if alpha.getextrema()[0] < 255 else 'no'}  ink-bbox={bbox}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="verify committed assets only")
    args = ap.parse_args()
    if not SRC.exists():
        sys.exit(f"missing master: {SRC}")
    OUT.mkdir(parents=True, exist_ok=True)
    check_only = args.check

    # ── 1. classify + trace the master ───────────────────────────────────────────────────
    ink_icon, accent_icon = classify(ICON_BOX, 1.5)
    ink_word, _ = classify(WORD_BOX, 1.5)
    icon_bbox = tight_bbox(ICON_BOX, (ink_icon, accent_icon))
    word_bbox = tight_bbox(WORD_BOX, (ink_word,))
    print(f"master {Image.open(SRC).size[0]}x{Image.open(SRC).size[1]}  mark bbox={icon_bbox}  wordmark bbox={word_bbox}")

    traced_icon_ink, _ = trace(ink_icon, "icon-ink")
    traced_icon_accent, _ = trace(accent_icon, "icon-accent")
    traced_word, _ = trace(ink_word, "word")

    icon_body = "\n".join([
        layout(traced_icon_ink, INK, ICON_BOX[:2]),
        layout(traced_icon_accent, ACCENT, ICON_BOX[:2]),
    ])
    word_body = layout(traced_word, INK, WORD_BOX[:2])
    lock_bbox = (min(icon_bbox[0], word_bbox[0]), min(icon_bbox[1], word_bbox[1]),
                 max(icon_bbox[2], word_bbox[2]), max(icon_bbox[3], word_bbox[3]))

    # ── 2. the vector master ─────────────────────────────────────────────────────────────
    icon_vb = centered_square(icon_bbox)
    word_vb = (word_bbox[0], word_bbox[1], word_bbox[2] - word_bbox[0], word_bbox[3] - word_bbox[1])
    lock_vb = (lock_bbox[0], lock_bbox[1], lock_bbox[2] - lock_bbox[0], lock_bbox[3] - lock_bbox[1])
    files = {
        "agentus-icon.svg": svg_doc(icon_vb, icon_body),
        "agentus-wordmark.svg": svg_doc(word_vb, word_body),
        "agentus-logo.svg": svg_doc(lock_vb, icon_body + "\n" + word_body),
    }

    # ── 3. every raster the web UI and the app need ───────────────────────────────────────
    icon_svg = files["agentus-icon.svg"]
    lock_svg = files["agentus-logo.svg"]
    if not check_only:
        for name, text in files.items():
            (OUT / name).write_text(text)

        # web: transparent PNG set + lockup for docs/README
        for px in (1024, 512, 256, 192, 180, 96, 48, 32, 16):
            raster(icon_svg, OUT / f"agentus-icon-{px}.png", px)
        raster(lock_svg, OUT / "agentus-lockup-1024.png", 1024)
        # maskable: full-bleed brand field, mark inside the 60% safe zone
        small = centered_square(icon_bbox, fill=0.60)
        mask_body = (
            f'<rect x="{icon_vb[0]:.1f}" y="{icon_vb[1]:.1f}" width="{icon_vb[2]:.1f}" height="{icon_vb[3]:.1f}" fill="{CANVAS}"/>\n'
            f'<g transform="translate({icon_vb[0] + icon_vb[2] / 2:.1f},{icon_vb[1] + icon_vb[3] / 2:.1f}) '
            f'scale({icon_vb[2] / small[2]:.5f}) '
            f'translate({-small[0] - small[2] / 2:.1f},{-small[1] - small[3] / 2:.1f})">'
            + icon_body + '</g>'
        )
        raster(svg_doc(icon_vb, mask_body), OUT / "agentus-icon-maskable-512.png", 512)

        # web: the served icons (same filenames the manifest already points at)
        WEB_ICONS.mkdir(parents=True, exist_ok=True)
        (WEB_ICONS / "agentus-icon.svg").write_text(icon_svg)
        # dark surfaces need a lighter mark — same paths, the dark-theme inks. The UI picks
        # between the two by resolved theme; a single <img> cannot recolour itself.
        inverse = icon_svg.replace(INK, INK_DARK).replace(ACCENT, ACCENT_DARK)
        (WEB_ICONS / "agentus-icon-inverse.svg").write_text(inverse)
        (OUT / "agentus-icon-inverse.svg").write_text(inverse)
        # The UI wants the mark hugging its own box: the icon files are square-padded for
        # favicon/manifest, which would leave a header mark at half height in its <img>.
        mark_vb = (icon_bbox[0] - 8, icon_bbox[1] - 8,
                   icon_bbox[2] - icon_bbox[0] + 16, icon_bbox[3] - icon_bbox[1] + 16)
        mark_svg = svg_doc(mark_vb, icon_body)
        (WEB_ICONS / "agentus-mark.svg").write_text(mark_svg)
        (WEB_ICONS / "agentus-mark-inverse.svg").write_text(mark_svg.replace(INK, INK_DARK).replace(ACCENT, ACCENT_DARK))
        (OUT / "agentus-mark.svg").write_text(mark_svg)
        raster(icon_svg, WEB_ICONS / "icon-192.png", 192)
        raster(icon_svg, WEB_ICONS / "icon-512.png", 512)
        raster(svg_doc(icon_vb, mask_body), WEB_ICONS / "icon-maskable-512.png", 512)
        raster(icon_svg, WEB_ICONS / "apple-touch-icon-180.png", 180, background=CANVAS)
        # favicon.ico: 16/32/48 in one file
        ico_src = OUT / ".ico.png"
        raster(icon_svg, ico_src, 256)
        Image.open(ico_src).convert("RGBA").save(WEB_ICONS / "favicon.ico",
                                                 sizes=[(16, 16), (32, 32), (48, 48)])
        ico_src.unlink()

    # ── 4. Android: adaptive icon + legacy + round + the notification glyph ──────────────
    android_files = {}
    if not check_only:
        # Adaptive icons are 108dp boards with the art inside a 66dp safe circle: at the
        # mark's 1.7 aspect, a width above ~50% of the board clips its tips on round masks.
        fg_vb = centered_square(icon_bbox, fill=0.50)
        fg = svg_doc(fg_vb, icon_body)                       # foreground: mark on transparent
        legacy = svg_doc(icon_vb, f'<rect x="{icon_vb[0]:.1f}" y="{icon_vb[1]:.1f}" width="{icon_vb[2]:.1f}" height="{icon_vb[3]:.1f}" fill="{CANVAS}"/>\n{icon_body}')
        densities = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
        for name, factor in densities.items():
            d = ANDROID / f"mipmap-{name}"
            d.mkdir(parents=True, exist_ok=True)
            raster(fg, d / "ic_launcher_foreground.png", round(108 * factor))
            raster(legacy, d / "ic_launcher.png", round(48 * factor))
            raster(legacy, d / "ic_launcher_round.png", round(48 * factor))
        anydpi = ANDROID / "mipmap-anydpi-v26"
        anydpi.mkdir(parents=True, exist_ok=True)
        adaptive = ('<?xml version="1.0" encoding="utf-8"?>\n'
                    '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
                    '    <background android:drawable="@color/ic_launcher_background"/>\n'
                    '    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n'
                    '</adaptive-icon>\n')
        (anydpi / "ic_launcher.xml").write_text(adaptive)
        (anydpi / "ic_launcher_round.xml").write_text(adaptive)
        colors = ANDROID / "values/ic_launcher_colors.xml"
        if not colors.exists():
            colors.write_text('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
                              f'    <color name="ic_launcher_background">{CANVAS}</color>\n</resources>\n')

        # notification glyph: the same mark as a white silhouette. The system tints this one
        # (small icons are alpha-only), so both layers ship white and the node disks fill the
        # ring holes — a solid, legible 24dp glyph.
        def vd_group(svg_text: str, origin) -> str:
            """One traced layer as a VectorDrawable <group> in the master's pixel space."""
            t = re.search(r'<g transform="([^"]*)"', svg_text).group(1)
            tx, ty, sx, sy = (float(v) for v in re.findall(r'-?[\d.]+', t))
            inner = re.search(r'<g transform="[^"]*"[^>]*>(.*)</g>', svg_text, re.S).group(1)
            body = "".join(f'      <path android:fillColor="#FFFFFFFF" android:pathData="{p}"/>\n'
                           for p in re.findall(r' d="([^"]*)"', inner))
            k = 1 / TRACE_SCALE
            return (f'    <group android:translateX="{origin[0]}" android:translateY="{origin[1]}"\n'
                    f'           android:scaleX="{k:.5f}" android:scaleY="{k:.5f}">\n'
                    f'      <group android:translateX="{tx}" android:translateY="{ty}"\n'
                    f'             android:scaleX="{sx}" android:scaleY="{sy}">\n{body}      </group>\n    </group>\n')

        drawable = ANDROID / "drawable"
        drawable.mkdir(parents=True, exist_ok=True)
        (drawable / "ic_notify.xml").write_text(
            '<?xml version="1.0" encoding="utf-8"?>\n'
            '<!-- The Agentus mark as a monochrome notification glyph (24dp, white on clear).\n'
            '     Generated by scripts/build-brand-assets.py — do not hand-edit. -->\n'
            '<vector xmlns:android="http://schemas.android.com/apk/res/android"\n'
            '    android:width="24dp"\n    android:height="24dp"\n'
            f'    android:viewportWidth="{icon_vb[2]:.1f}"\n    android:viewportHeight="{icon_vb[3]:.1f}">\n'
            + vd_group(traced_icon_ink, ICON_BOX[:2])
            + vd_group(traced_icon_accent, ICON_BOX[:2])
            + '</vector>\n')

    # ── 5. verify: does each export actually carry the mark, and where ───────────────────
    print("\nvector master")
    for name in files:
        report(name, OUT / name)
    print("\nweb icons")
    for name in ("agentus-icon.svg", "icon-192.png", "icon-512.png", "icon-maskable-512.png",
                 "apple-touch-icon-180.png", "favicon.ico"):
        report(name, WEB_ICONS / name)
    print("\nmaster PNG set")
    for px in (1024, 512, 192, 32):
        report(f"agentus-icon-{px}.png", OUT / f"agentus-icon-{px}.png")
    print("\nandroid")
    for name, factor in densities.items():
        report(f"mipmap-{name}/ic_launcher.png", ANDROID / f"mipmap-{name}/ic_launcher.png")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
