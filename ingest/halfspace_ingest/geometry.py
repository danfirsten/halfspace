"""Pitch geometry: the single coordinate frame everything downstream lives in.

Halfspace normalizes every coordinate into the **possession team's** attacking
frame: that team attacks from x=0 toward x=120, y=0 is the touchline on their
left. The web app never flips anything.

Two mirror constants, and they are genuinely different (docs/statsbomb-notes.md
§3.2 and the §8 discrepancy log):

* Event ``location`` values are quantised onto a 0.1-offset grid, so an
  opponent's event mirrors into our frame at exactly ``(120.1 - x, 80.1 - y)``.
  Using 120/80 puts a systematic 0.1-yard bias into every opponent event and
  breaks exact joins against 360 actor positions.
* 360 freeze-frame coordinates are full-precision floats off that grid, so they
  mirror about the true pitch dimensions, ``(120 - x, 80 - y)``.
"""

from __future__ import annotations

import math

from .config import (
    BOX_X_MIN,
    BOX_Y_MAX,
    BOX_Y_MIN,
    CHANNEL_1,
    CHANNEL_2,
    EVENT_MIRROR_X,
    EVENT_MIRROR_Y,
    FINAL_THIRD_X,
    FRAME_MIRROR_X,
    FRAME_MIRROR_Y,
    MIDDLE_THIRD_X,
)

ZONES: tuple[str, ...] = (
    "def_third_left",
    "def_third_centre",
    "def_third_right",
    "mid_third_left",
    "mid_third_centre",
    "mid_third_right",
    "final_third_left",
    "final_third_centre",
    "final_third_right",
)

#: Index of each zone in ZONES, used for the one-hot block of the similarity vector.
ZONE_INDEX = {z: i for i, z in enumerate(ZONES)}


def mirror_event(x: float, y: float) -> tuple[float, float]:
    """Mirror an event location into the opposing team's attacking frame.

    Rounded to one decimal because that is the grid the source data uses; the
    round makes the transform an exact involution on real StatsBomb values.
    """
    return (round(EVENT_MIRROR_X - x, 1), round(EVENT_MIRROR_Y - y, 1))


def mirror_frame(x: float, y: float) -> tuple[float, float]:
    """Mirror a 360 freeze-frame location (full-precision, not on the 0.1 grid)."""
    return (FRAME_MIRROR_X - x, FRAME_MIRROR_Y - y)


def canon_event(
    loc: list | tuple | None, flip: bool
) -> tuple[float | None, float | None, float | None]:
    """Return (x, y, z) for an event location, mirrored when ``flip`` is set.

    Handles the length-2 / length-3 split on ``shot.end_location``
    (docs/statsbomb-notes.md §3.3): z is a height above the goal line and is
    never mirrored.
    """
    if not loc:
        return (None, None, None)
    x, y = float(loc[0]), float(loc[1])
    z = float(loc[2]) if len(loc) > 2 else None
    if flip:
        x, y = mirror_event(x, y)
    return (x, y, z)


def zone(x: float, y: float) -> str:
    """Pitch third x channel, in the attacking team's frame.

    Thirds split at x=40 and x=80; channels split at y=80/3 and y=160/3.
    Boundaries belong to the *upfield* / *higher-y* cell (x=40 is middle third,
    x=80 is final third), so the three thirds partition [0,120] cleanly.
    y=0 is the top touchline, which is the attacking team's LEFT.
    """
    if x < MIDDLE_THIRD_X:
        third = "def_third"
    elif x < FINAL_THIRD_X:
        third = "mid_third"
    else:
        third = "final_third"

    if y < CHANNEL_1:
        channel = "left"
    elif y < CHANNEL_2:
        channel = "centre"
    else:
        channel = "right"
    return f"{third}_{channel}"


def in_box(x: float, y: float) -> bool:
    """Inside the penalty area being attacked (x 102-120, y 18-62, spec Appendix 2)."""
    return x >= BOX_X_MIN and BOX_Y_MIN <= y <= BOX_Y_MAX


def resample_path(points: list[tuple[float, float]], n: int) -> list[float]:
    """Resample a polyline to exactly ``n`` points, evenly spaced by arc length.

    Returns a flat ``[x0, y0, x1, y1, ...]`` list of length ``2n``.

    Arc-length (rather than time) spacing is what a thumbnail animation wants:
    the marker moves at constant speed along the path, so a 40-second build-up
    and a 6-second counter both read as one clean sweep. Real timings live in
    ``phase_events`` for the full player.
    """
    if n < 1:
        raise ValueError("n must be >= 1")
    if not points:
        return [0.0] * (2 * n)
    if len(points) == 1:
        return list(points[0]) * n

    cum = [0.0]
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        cum.append(cum[-1] + math.hypot(x1 - x0, y1 - y0))
    total = cum[-1]
    if total <= 0.0:  # the ball never moved (e.g. a single-touch phase)
        return list(points[0]) * n

    out: list[float] = []
    seg = 0
    for i in range(n):
        # With a single sample there is no spacing to be even about; take the
        # point the ball finished at.
        target = total if n == 1 else total * i / (n - 1)
        while seg < len(cum) - 2 and cum[seg + 1] < target:
            seg += 1
        span = cum[seg + 1] - cum[seg]
        t = 0.0 if span <= 0 else (target - cum[seg]) / span
        x0, y0 = points[seg]
        x1, y1 = points[seg + 1]
        out.append(x0 + t * (x1 - x0))
        out.append(y0 + t * (y1 - y0))
    return out
