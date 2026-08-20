#!/usr/bin/env python3
"""Render conch's placeholder app icon.

A logarithmic spiral — the shell — in the app's own palette, so the icon on the
home screen belongs to the same object as the ledger inside it. Deliberately a
PLACEHOLDER: Tyler is making the real one. It exists because App Store Connect
rejects any build without a 1024x1024 icon, so without it TestFlight cannot
begin at all.

Regenerate:  python3 tools/make-appicon.py
"""
import math
from PIL import Image, ImageDraw

SIZE = 1024
SS = 4  # supersample; PIL has no antialiased thick-line primitive
W = SIZE * SS

BG = (11, 13, 12)
CYAN = (88, 201, 212)
GOLD = (250, 214, 82)


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def main() -> None:
    # Draw on transparency first. A logarithmic spiral's mass sits far off its
    # mathematical centre — drawing straight onto the canvas left the shell low
    # and right with dead space above it, reading as a comma rather than a
    # shell. Rendering loose, then fitting the actual ink to the frame, keeps
    # the composition centred no matter how the spiral parameters are tuned.
    layer = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    cx = cy = W / 2
    # A logarithmic spiral: r = a*e^(b*theta). Growth tuned so ~2.6 turns fill
    # the icon's safe area without crowding the centre.
    turns = 2.6
    theta_max = turns * 2 * math.pi
    b = 0.28
    a = (W * 0.40) / math.exp(b * theta_max)

    steps = 3000
    points = []
    for i in range(steps + 1):
        theta = theta_max * i / steps
        r = a * math.exp(b * theta)
        # Rotate so the mouth of the shell opens toward the lower right.
        ang = theta - math.pi * 0.55
        points.append((cx + r * math.cos(ang), cy + r * math.sin(ang)))

    # Draw outward so the wide, bright outer whorl overlays the tight centre.
    for i in range(steps):
        t = i / steps
        width = max(2, int((W * 0.008) + (W * 0.055) * (t ** 2.1)))
        colour = lerp(GOLD, CYAN, t ** 0.8) + (255,)
        draw.line([points[i], points[i + 1]], fill=colour, width=width, joint="curve")
        # Round the stroke ends; PIL's joint="curve" leaves gaps on tight arcs.
        x, y = points[i + 1]
        r = width / 2
        draw.ellipse([x - r, y - r, x + r, y + r], fill=colour)

    # Fit the ink to the frame. 0.76 leaves margin for the mask iOS applies to
    # every icon, so the outer whorl is not clipped by the rounded corners.
    box = layer.getbbox()
    art = layer.crop(box)
    target = int(W * 0.76)
    scale = target / max(art.width, art.height)
    art = art.resize(
        (max(1, round(art.width * scale)), max(1, round(art.height * scale))),
        Image.LANCZOS,
    )

    img = Image.new("RGB", (W, W), BG)
    img.paste(art, ((W - art.width) // 2, (W - art.height) // 2), art)
    img = img.resize((SIZE, SIZE), Image.LANCZOS)
    out = "conch-ios/Assets.xcassets/AppIcon.appiconset/icon-1024.png"
    img.save(out)
    print("wrote", out)


if __name__ == "__main__":
    main()
