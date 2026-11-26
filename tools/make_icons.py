"""Render the app icon to PNG (iOS needs PNG home-screen icons). Stdlib only.
Mirrors public/icon.svg: dark tile, faint grid, white flag, blue ball."""
import math
import struct
import sys
import zlib
from pathlib import Path

BG, GRID, WHITE, BLUE = (10, 10, 10), (30, 30, 30), (255, 255, 255), (103, 152, 255)
SEGS = [((196, 400), (196, 112)), ((196, 112), (346, 182)), ((346, 182), (196, 252))]


def seg_dist(px, py, a, b):
    ax, ay = a; bx, by = b
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)


def color_at(x, y):  # x, y in 512-space
    if math.hypot(x - 316, y - 392) <= 30:
        return BLUE
    if any(seg_dist(x, y, a, b) <= 14 for a, b in SEGS):
        return WHITE
    if any(abs(x - g) <= 2 or abs(y - g) <= 2 for g in (128, 256, 384)):
        return GRID
    return BG


def render(n, ss=3):
    rows = []
    k = 512 / n
    for j in range(n):
        row = bytearray([0])
        for i in range(n):
            acc = [0, 0, 0]
            for sj in range(ss):
                for si in range(ss):
                    c = color_at((i + (si + 0.5) / ss) * k, (j + (sj + 0.5) / ss) * k)
                    acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]
            row += bytes(v // (ss * ss) for v in acc)
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", n, n, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


if __name__ == "__main__":
    out = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).parent.parent / "public")
    for size in (180, 192, 512):
        (out / f"icon-{size}.png").write_bytes(render(size))
        print("wrote", out / f"icon-{size}.png")
