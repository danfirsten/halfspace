"""Two views of the same passage of play.

Contrastive training needs a pair of inputs that a *football* person would call
the same move. Each augmentation below is defended on that ground, not on
"it worked for images". Anything that changes what the move *is* — the direction
of play, the side of the pitch, the order of events — is not in here.

Every draw comes from a caller-supplied ``numpy.random.Generator`` so a run is
reproducible from its seed alone (EVAL.md §5).
"""

from __future__ import annotations

import numpy as np

from .config import TrainConfig
from .data import Segment


class View(dict):
    """A per-event feature bundle, ready for ``featurize``."""


#: The keys an augmented view carries — the raw per-event columns, not features,
#: so jitter is applied in yards and seconds where it is interpretable.
COLS = (
    "t", "type_idx", "side", "x", "y", "end_x", "end_y",
    "under_pressure", "counterpress", "out", "xg",
)


def to_view(seg: Segment) -> View:
    return View({c: seg.col(c).copy() for c in COLS})


def crop(view: View, rng: np.random.Generator, keep_min: float) -> View:
    """Keep a contiguous window of 60-100% of the events.

    A passage of play is still that passage whether you catch it from the
    goalkeeper's throw or from the second pass out of the back. This is the
    augmentation that teaches the encoder that a phase and a piece of it belong
    in the same place — and it is the one that gives the encoder an edge on the
    split-half metric, which EVAL.md §2 states up front.
    """
    n = len(view["t"])
    if n < 4:
        return view
    frac = rng.uniform(keep_min, 1.0)
    k = max(3, int(round(n * frac)))
    lo = int(rng.integers(0, n - k + 1))
    return View({c: v[lo : lo + k] for c, v in view.items()})


def event_dropout(view: View, rng: np.random.Generator, p: float) -> View:
    """Drop up to ``p`` of the interior events.

    StatsBomb's annotation is dense but not exhaustive, and a Pressure or a Ball
    Receipt that a different annotator would not have logged does not change
    what the move was. The first and last events are never dropped: they are the
    move's start and its ending, which *are* part of its identity.
    """
    n = len(view["t"])
    if n < 5 or p <= 0:
        return view
    keep = np.ones(n, dtype=bool)
    interior = np.arange(1, n - 1)
    drop = interior[rng.random(len(interior)) < p]
    keep[drop] = False
    if keep.sum() < 3:
        return view
    return View({c: v[keep] for c, v in view.items()})


def spatial_jitter(view: View, rng: np.random.Generator, sigma: float) -> View:
    """Gaussian noise, sigma yards, on every location and end location.

    StatsBomb coordinates are eyeballed off video onto a 0.1-yard grid; the real
    precision is about a yard. A move is not defined to sub-yard accuracy, and a
    representation that thinks it is has memorised the annotator.
    """
    if sigma <= 0:
        return view
    out = View(dict(view))
    for cx, cy in (("x", "y"), ("end_x", "end_y")):
        vx, vy = out[cx].copy(), out[cy].copy()
        ok = np.isfinite(vx)
        vx[ok] += rng.normal(0.0, sigma, ok.sum()).astype(vx.dtype)
        vy[ok] += rng.normal(0.0, sigma, ok.sum()).astype(vy.dtype)
        out[cx], out[cy] = vx, vy
    return out


def tempo_jitter(view: View, rng: np.random.Generator, sigma: float) -> View:
    """Stretch the clock by a lognormal factor around 1.

    The same move played 10% quicker is the same move. Gaps are scaled, not
    shifted, so the *rhythm* (one-touch vs. dwell) survives while the absolute
    tempo does not become an identity cue.
    """
    if sigma <= 0:
        return view
    t = view["t"]
    if len(t) < 2:
        return view
    factor = float(rng.lognormal(0.0, sigma))
    gaps = np.diff(t) * factor
    new = np.empty_like(t)
    new[0] = t[0]
    new[1:] = t[0] + np.cumsum(gaps)
    out = View(dict(view))
    out["t"] = new
    return out


def augment(seg: Segment, rng: np.random.Generator, cfg: TrainConfig) -> View:
    """One augmented view of a phase: crop -> dropout -> spatial -> tempo."""
    v = to_view(seg)
    v = crop(v, rng, cfg.crop_min)
    v = event_dropout(v, rng, cfg.drop_p)
    v = spatial_jitter(v, rng, cfg.jitter_xy)
    v = tempo_jitter(v, rng, cfg.tempo_sigma)
    return v
