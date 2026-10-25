"""Draws the Privany icon: a highlighter-yellow ≠ on ink navy. Run once; PNGs are committed."""
from pathlib import Path

from PIL import Image, ImageDraw

INK = (20, 33, 61, 255)
MARKER = (255, 228, 92, 255)
OUT = Path(__file__).resolve().parent.parent / "public" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

for size in (16, 32, 48, 128):
    s = size * 8  # supersample, then shrink for clean edges
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=INK)
    bar_w, bar_h = s * 0.56, s * 0.11
    x0 = (s - bar_w) / 2
    for cy in (s * 0.40, s * 0.60):
        d.rounded_rectangle([x0, cy - bar_h / 2, x0 + bar_w, cy + bar_h / 2], radius=bar_h / 2, fill=MARKER)
    # the slash that turns = into ≠
    w = s * 0.10
    d.line([(s * 0.62, s * 0.20), (s * 0.38, s * 0.80)], fill=MARKER, width=int(w))
    img.resize((size, size), Image.LANCZOS).save(OUT / f"icon{size}.png")
print("icons ->", OUT)
