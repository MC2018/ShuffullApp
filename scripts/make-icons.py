#!/usr/bin/env python3
"""Regenerate every app icon from the one Shuffull logo.

    python3 scripts/make-icons.py      # needs Pillow

Source: assets/images/logo-source.png, the original 2021 logo (gradient note inside two looping arrows,
transparent background). It is only 300x300 and no vector original survives, so any output that draws the art
wider than that is an upscale: icon.png, adaptive-icon.png, splash.png, desktop/icon.png and the Android splash
icon at xxhdpi and up. The launcher icons stay under it.

Writes:
  assets/images/icon.png             1024, opaque white square (Expo's `icon`; iOS rounds the corners itself)
  assets/images/adaptive-icon.png    1024, transparent, art inside the adaptive-icon safe zone
  assets/images/favicon.png          48, transparent (web favicon)
  assets/images/splash.png           1284x2778, logo centred on white (Expo's `splash`)
  desktop/icon.png                   512, transparent (Electron window and taskbar icon)
  android/.../main/res/mipmap-*/ic_launcher_foreground.webp   adaptive foreground, shared by both builds; the
                                         background is @color/iconBackground (white; orange #E8590C for the dev build)
  android/.../main/res/mipmap-*/ic_launcher.webp, ic_launcher_round.webp   pre-Android-8 launchers (minSdk is 24):
                                         white tile / circle
  android/.../dev/res/mipmap-*/ic_launcher.webp, ic_launcher_round.webp    the same on orange, for "Shuffull Dev"
  android/.../drawable-*/splashscreen_logo.png       Android 12+ splash icon, inside its circular mask

android/ is committed and is what builds actually use, so it is written directly rather than via expo prebuild.
"""

import math
from pathlib import Path

from PIL import Image, ImageDraw

APP = Path(__file__).resolve().parent.parent
SRC = APP / "assets/images/logo-source.png"
RES = APP / "android/app/src/main/res"
DEV_RES = APP / "android/app/src/dev/res"  # "Shuffull Dev" build-type overrides
WHITE = (255, 255, 255, 255)
DEV_ORANGE = (0xE8, 0x59, 0x0C, 255)  # matches iconBackground in android/app/src/dev/res/values/colors.xml

# Density buckets: mdpi multiplier.
DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}


def load_art():
    """The logo cropped to its pixels, plus the radius (from the crop's centre) that encloses all of them."""
    im = Image.open(SRC).convert("RGBA")
    im = im.crop(im.getbbox())
    alpha = im.getchannel("A")
    cx, cy = im.width / 2, im.height / 2
    px = alpha.load()
    radius = max(
        math.hypot(x + 0.5 - cx, y + 0.5 - cy)
        for y in range(im.height)
        for x in range(im.width)
        if px[x, y] > 32
    )
    return im, radius


ART, ART_RADIUS = load_art()


def place(canvas, radius):
    """Paste the logo centred on `canvas`, scaled so every visible pixel sits within `radius` px of the centre."""
    scale = radius / ART_RADIUS
    w, h = round(ART.width * scale), round(ART.height * scale)
    art = ART.resize((w, h), Image.LANCZOS)
    layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    layer.paste(art, ((canvas.width - w) // 2, (canvas.height - h) // 2))
    canvas.alpha_composite(layer)
    return canvas


def blank(w, h=None, fill=(0, 0, 0, 0)):
    return Image.new("RGBA", (w, h or w), fill)


def tile(size, shape, fill=WHITE):
    """A solid tile on transparency, drawn at 4x and shrunk so its edge is antialiased."""
    big = size * 4
    mask = Image.new("L", (big, big), 0)
    d = ImageDraw.Draw(mask)
    inset = big * 0.04
    box = (inset, inset, big - inset, big - inset)
    if shape == "circle":
        d.ellipse(box, fill=255)
    else:
        d.rounded_rectangle(box, radius=big * 0.18, fill=255)
    out = blank(size)
    out.paste(fill, (0, 0), mask.resize((size, size), Image.LANCZOS))
    return out


def save(im, path, **kw):
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path, **kw)
    print(f"{im.width}x{im.height}  {path.relative_to(APP)}")


def main():
    # Expo / iOS: opaque, no transparency allowed in the store icon.
    save(place(blank(1024, fill=WHITE), 1024 * 0.40).convert("RGB"), APP / "assets/images/icon.png")
    # Adaptive icon foreground: a 108dp canvas whose guaranteed-visible safe zone is a 66dp circle (radius 0.306);
    # 0.26 leaves some air inside the 72dp circle a round launcher actually shows.
    save(place(blank(1024), 1024 * 0.26), APP / "assets/images/adaptive-icon.png")
    save(place(blank(48), 48 * 0.49), APP / "assets/images/favicon.png")
    splash = blank(1284, 2778, WHITE)
    save(place(splash, 1284 * 0.22).convert("RGB"), APP / "assets/images/splash.png")
    save(place(blank(512), 512 * 0.49), APP / "desktop/icon.png")

    for name, m in DENSITIES.items():
        mip = RES / f"mipmap-{name}"
        fg = round(108 * m)
        save(place(blank(fg), fg * 0.26), mip / "ic_launcher_foreground.webp", lossless=True)
        legacy = round(48 * m)
        save(place(tile(legacy, "square"), legacy * 0.36), mip / "ic_launcher.webp", lossless=True)
        save(place(tile(legacy, "circle"), legacy * 0.34), mip / "ic_launcher_round.webp", lossless=True)
        dev = DEV_RES / f"mipmap-{name}"
        save(place(tile(legacy, "square", DEV_ORANGE), legacy * 0.36), dev / "ic_launcher.webp", lossless=True)
        save(place(tile(legacy, "circle", DEV_ORANGE), legacy * 0.34), dev / "ic_launcher_round.webp", lossless=True)
        # The dev build inherits main's foreground; an override here would only drift from it.
        (dev / "ic_launcher_foreground.webp").unlink(missing_ok=True)
        # Android 12 splash icon without a background: 288dp canvas, masked to a 192dp circle (radius 0.333).
        sp = round(288 * m)
        save(place(blank(sp), sp * 0.30), RES / f"drawable-{name}" / "splashscreen_logo.png")


if __name__ == "__main__":
    main()
