"""Step 2 of the README hero GIF: assemble the frames captured by `gif.mjs`.

    node gif.mjs && python3 gif.py

Needs Pillow only (`pip install Pillow`) — there is no ffmpeg in the toolchain
and a GIF is the one animated format GitHub renders inline anyway.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / ".gif-frames"
OUT = HERE.parent / "docs" / "screenshots" / "player.gif"

WIDTH = 1080
COLORS = 128
FPS = 12
HOLD_MS = 1100  # linger on the finished pass map before the loop restarts
LEAD_MS = 400   # and on the empty pitch, so the sweep reads from the start

paths = sorted(SRC.glob("f*.png"))
if not paths:
    raise SystemExit(f"no frames in {SRC} — run `node gif.mjs` first")

frames = []
for p in paths:
    im = Image.open(p).convert("RGB")
    frames.append(im.resize((WIDTH, round(im.height * WIDTH / im.width)), Image.LANCZOS))

# One shared palette for every frame. The UI is a fixed dark scheme, so a
# per-frame palette only adds churn — and file size — between near-identical
# frames. The middle frame is the one with the most ink on the pitch.
palette = frames[len(frames) // 2].quantize(colors=COLORS, method=Image.MEDIANCUT)
quantized = [f.quantize(palette=palette, dither=Image.FLOYDSTEINBERG) for f in frames]

durations = [round(1000 / FPS)] * len(quantized)
durations[0] = LEAD_MS
durations[-1] = HOLD_MS

OUT.parent.mkdir(parents=True, exist_ok=True)
quantized[0].save(
    OUT,
    save_all=True,
    append_images=quantized[1:],
    duration=durations,
    loop=0,
    optimize=True,
)
print(
    f"{OUT.relative_to(HERE.parent)}  {len(quantized)} frames  "
    f"{WIDTH}x{quantized[0].height}  {OUT.stat().st_size / 1_048_576:.2f} MB"
)
