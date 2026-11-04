"""Regenerates the PNG icons (192, 512, maskable 512, apple-touch 180) with Pillow. Not served by the app.
Run: python3 public/icons/generate_icons.py   (keeps icon.svg as the design source of truth)."""
import os
from PIL import Image, ImageDraw

OUT = os.path.dirname(os.path.abspath(__file__))
BLUE, WHITE = (21, 88, 192, 255), (255, 255, 255, 255)
S = 4  # supersampling for smooth edges


def draw(size, safe):
    """safe: fraction of the canvas the glyph may use (maskable icons need the central 80%)."""
    n = size * S
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if safe < 1:
        d.rectangle([0, 0, n, n], fill=BLUE)  # maskable: full-bleed, the OS applies its own mask
    else:
        d.rounded_rectangle([0, 0, n - 1, n - 1], radius=int(n * 0.22), fill=BLUE)
    k = n / 512 * safe
    off = n * (1 - safe) / 2
    p = lambda x, y: (off + x * k, off + y * k)
    w = max(int(28 * k), 2)
    # house outline + door, same geometry as icon.svg
    d.line([p(140, 372), p(140, 196), p(256, 128), p(372, 196), p(372, 372)], fill=WHITE, width=w, joint="curve")
    d.line([p(200, 372), p(200, 282), p(312, 282), p(312, 372)], fill=WHITE, width=w, joint="curve")
    d.line([p(200, 232), p(312, 232)], fill=WHITE, width=w)
    return img.resize((size, size), Image.LANCZOS)


for name, size, safe in [("icon-192.png", 192, 1), ("icon-512.png", 512, 1), ("icon-maskable-512.png", 512, 0.8), ("apple-touch-icon.png", 180, 0.84)]:
    draw(size, safe).save(os.path.join(OUT, name))
    print("wrote", name)
