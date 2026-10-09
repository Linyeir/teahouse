#!/usr/bin/env python3
"""Regenerates the whole Teahouse icon set from the geometry below.

Requires: pip install cairosvg resvg-py pillow
Run:      python3 build_icons.py   (writes next to this script)
"""
import io
import json
import os
import shutil

import cairosvg
from PIL import Image

OUT = os.path.dirname(os.path.abspath(__file__))

# ---- palette -------------------------------------------------------------
GREEN, GREEN_LIGHT, GOLD = "#0F3A2E", "#1A4D3D", "#D4AF62"
TEA = "#E3E9C6"    # tea surface / speech bubble
TILE = "#F4ECD8"   # background tile

# ---- bowl geometry (212 x 182 units, symmetric around x = 106) ------------
BOWL_W, BOWL_H = 212, 182
BOWL = f"""
<path d="M0 35C6.5 52 23.5 69.5 26.5 84.5C29.5 99.5 53 149.642 67.5 156.071C82 162.5 130 162.5 144.5 156.071C159 149.642 182.5 99.5 185.5 84.5C188.5 69.5 205.5 52 212 35H0Z" fill="{GREEN}"/>
<path d="M181.501 99.927C180.285 103.972 178.845 108.386 177.199 112.906C129.792 121.166 82.208 121.166 34.801 112.906C33.155 108.386 31.715 103.972 30.499 99.927C80.885 109.513 131.115 109.513 181.501 99.927Z" fill="{GOLD}"/>
<path d="M69.5 165.5C83.27 171.9 128.73 171.9 142.5 165.5L142.5 175.5C128.73 181.9 83.27 181.9 69.5 175.5Z" fill="{GREEN}" stroke="{GREEN}" stroke-width="3" stroke-linejoin="round"/>
<ellipse cx="106" cy="32" rx="106" ry="32" fill="{GREEN}"/>
<ellipse cx="106" cy="32" rx="99.51" ry="27.64" fill="{GREEN_LIGHT}"/>
<ellipse cx="106" cy="43.5" rx="81.5" ry="15.5" fill="{TEA}"/>
<path d="M64.359 42.885C63.068 60.072 53.381 70.746 35.297 74.906C36.588 57.719 46.276 47.045 64.359 42.885Z" fill="{GOLD}"/>
""".strip()
# The foot's stroke adds 1.5 units below y=180.7, so the drawn bowl ends at ~182.

# Single-color version (Android themed icons): silhouette with tea, band and leaf cut out.
# The inner rim edge is kept as a thin cut line so the bowl still reads as open.
_MONO_MASK = (BOWL.replace(f'fill="{GREEN}"', 'fill="white"')
              .replace(f'stroke="{GREEN}"', 'stroke="white"')
              .replace(f'fill="{GOLD}"', 'fill="black"')
              .replace(f'fill="{TEA}"', 'fill="black"')
              .replace(f'fill="{GREEN_LIGHT}"', 'fill="white" stroke="black" stroke-width="2.5"'))
BOWL_MONO = (f'<mask id="m" maskUnits="userSpaceOnUse" x="-10" y="-10" width="232" height="202">'
             f'<rect x="-10" y="-10" width="232" height="202" fill="black"/>{_MONO_MASK}</mask>'
             f'<rect x="-10" y="-10" width="232" height="202" fill="white" mask="url(#m)"/>')


def svg(size=1024, bowl_width=0.62, bg=None, radius=0.0, dy=0.0, mono=False):
    """bowl_width: share of the canvas width the bowl takes.
    bg: None (transparent), 'square' or 'rounded' / 'circle' with TILE color.
    dy: optical vertical offset as a share of the canvas."""
    s = size * bowl_width / BOWL_W
    tx = (size - BOWL_W * s) / 2
    ty = (size - BOWL_H * s) / 2 + dy * size
    back = ""
    if bg == "square":
        back = f'<rect width="{size}" height="{size}" fill="{TILE}"/>'
    elif bg == "rounded":
        back = f'<rect width="{size}" height="{size}" rx="{size * radius:.2f}" fill="{TILE}"/>'
    elif bg == "circle":
        back = f'<circle cx="{size / 2}" cy="{size / 2}" r="{size / 2}" fill="{TILE}"/>'
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" '
            f'viewBox="0 0 {size} {size}"><title>Teahouse</title>{back}'
            f'<g transform="translate({tx:.3f} {ty:.3f}) scale({s:.5f})">{BOWL_MONO if mono else BOWL}</g></svg>\n')


# Variants. Small sizes (<= 32 px) get a bigger bowl so it stays legible.
TILE_LG = dict(bowl_width=0.62, bg="rounded", radius=0.225, dy=0.01)   # app tile, desktop, web
TILE_SM = dict(bowl_width=0.80, bg="rounded", radius=0.18)             # favicons / tiny sizes
FULL = dict(bowl_width=0.62, bg="square")                              # OS applies the mask (iOS, maskable)
ROUND = dict(bowl_width=0.60, bg="circle")                             # Android legacy round
BARE = dict(bowl_width=0.92)                                           # transparent, tight
ADAPTIVE_FG = dict(bowl_width=0.52)                                    # inside Android's 66/108 safe circle
ADAPTIVE_MONO = dict(bowl_width=0.52, mono=True)


def tile(size):
    return TILE_SM if size <= 32 else TILE_LG


def png(spec, size):
    if spec.get("mono"):  # cairosvg ignores SVG masks, resvg handles them
        import resvg_py
        data = bytes(resvg_py.svg_to_bytes(svg_string=svg(1024, **spec), width=size, height=size))
        return Image.open(io.BytesIO(data)).convert("RGBA")
    data = cairosvg.svg2png(bytestring=svg(1024, **spec).encode(), output_width=size, output_height=size)
    return Image.open(io.BytesIO(data)).convert("RGBA")


def save(img, *parts, opaque=False):
    path = os.path.join(OUT, *parts)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if opaque:
        img = img.convert("RGB")
    img.save(path)
    return img


def write(text, *parts):
    path = os.path.join(OUT, *parts)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


def main():
    for d in ("svg", "png", "web", "ios", "android", "desktop"):
        shutil.rmtree(os.path.join(OUT, d), ignore_errors=True)

    # --- SVG masters
    write(svg(1024, **TILE_LG), "svg", "teahouse-icon.svg")
    write(svg(1024, **TILE_SM), "svg", "teahouse-icon-small.svg")
    write(svg(1024, **FULL), "svg", "teahouse-icon-fullbleed.svg")
    write(svg(1024, **BARE), "svg", "teahouse-icon-transparent.svg")
    write(f'<svg xmlns="http://www.w3.org/2000/svg" width="{BOWL_W}" height="{BOWL_H}" '
          f'viewBox="0 0 {BOWL_W} {BOWL_H}"><title>Teahouse</title>{BOWL}</svg>\n', "svg", "teahouse-mark.svg")
    write(svg(1024, bowl_width=0.92, mono=True), "svg", "teahouse-icon-monochrome.svg")

    # --- generic PNGs, with and without background
    sizes = [16, 24, 32, 48, 64, 96, 128, 192, 256, 512, 1024]
    for n in sizes:
        save(png(tile(n), n), "png", "with-bg", f"teahouse-{n}.png")
        save(png(BARE, n), "png", "transparent", f"teahouse-{n}.png")

    # --- web
    os.makedirs(os.path.join(OUT, "web"), exist_ok=True)
    ico = [png(tile(n), n) for n in (16, 32, 48)]
    ico[-1].save(os.path.join(OUT, "web", "favicon.ico"),
                 sizes=[(16, 16), (32, 32), (48, 48)], append_images=ico[:-1])
    write(svg(1024, **TILE_SM), "web", "favicon.svg")
    save(png(FULL, 180), "web", "apple-touch-icon.png", opaque=True)
    save(png(TILE_LG, 192), "web", "icon-192.png")
    save(png(TILE_LG, 512), "web", "icon-512.png")
    save(png(FULL, 512), "web", "icon-maskable-512.png", opaque=True)
    manifest_icons = {"icons": [
        {"src": "/icon-192.png", "sizes": "192x192", "type": "image/png"},
        {"src": "/icon-512.png", "sizes": "512x512", "type": "image/png"},
        {"src": "/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
    ], "theme_color": GREEN, "background_color": TILE}
    write(json.dumps(manifest_icons, indent=2) + "\n", "web", "manifest-icons.json")

    # --- iOS: one opaque 1024 px square, iOS applies the rounded mask itself
    save(png(FULL, 1024), "ios", "AppIcon-1024.png", opaque=True)
    write(json.dumps({"images": [{"filename": "AppIcon-1024.png", "idiom": "universal",
                                  "platform": "ios", "size": "1024x1024"}],
                      "info": {"author": "xcode", "version": 1}}, indent=2) + "\n", "ios", "Contents.json")

    # --- Android
    res = os.path.join("android", "res")
    for dpi, mult in (("mdpi", 1), ("hdpi", 1.5), ("xhdpi", 2), ("xxhdpi", 3), ("xxxhdpi", 4)):
        n, fg = int(48 * mult), int(108 * mult)
        save(png(TILE_LG, n), res, f"mipmap-{dpi}", "ic_launcher.png")
        save(png(ROUND, n), res, f"mipmap-{dpi}", "ic_launcher_round.png")
        save(png(ADAPTIVE_FG, fg), res, f"mipmap-{dpi}", "ic_launcher_foreground.png")
        save(png(ADAPTIVE_MONO, fg), res, f"mipmap-{dpi}", "ic_launcher_monochrome.png")
    adaptive = ('<?xml version="1.0" encoding="utf-8"?>\n'
                '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
                '    <background android:drawable="@color/ic_launcher_background"/>\n'
                '    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n'
                '    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>\n'
                '</adaptive-icon>\n')
    write(adaptive, res, "mipmap-anydpi-v26", "ic_launcher.xml")
    write(adaptive, res, "mipmap-anydpi-v26", "ic_launcher_round.xml")
    write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
          f'    <color name="ic_launcher_background">{TILE}</color>\n</resources>\n',
          res, "values", "ic_launcher_background.xml")
    save(png(FULL, 512), "android", "play-store-512.png", opaque=True)

    # --- desktop
    os.makedirs(os.path.join(OUT, "desktop"), exist_ok=True)
    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    ico_imgs = [png(tile(n), n) for n in ico_sizes]
    ico_imgs[-1].save(os.path.join(OUT, "desktop", "teahouse.ico"),
                      sizes=[(n, n) for n in ico_sizes], append_images=ico_imgs[:-1])
    big = png(TILE_LG, 1024)
    big.save(os.path.join(OUT, "desktop", "teahouse.icns"))
    for n in (16, 32, 48, 64, 128, 256, 512):
        save(png(tile(n), n), "desktop", "linux", f"{n}x{n}", "teahouse.png")
    write(svg(1024, **TILE_LG), "desktop", "linux", "scalable", "teahouse.svg")


if __name__ == "__main__":
    main()
