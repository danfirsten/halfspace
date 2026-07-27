"""Fixed-length phase vectors for "find similar phases".

The client computes cosine similarity in DuckDB (``list_dot_product``), so the
vectors are L2-normalized here and a dot product is all the browser has to do.

Composition (74 dims), grouped and weighted so that no single block can drown
out the others. Every block is described in plain English in
docs/phase-definitions.md; if you change the layout, change that file too.
"""

from __future__ import annotations

import numpy as np

from .geometry import ZONES
from .taxonomy import OUTCOMES, START_TYPES

#: Numeric features, z-scored across the whole dataset then clipped to +/-3 so
#: that one 9-minute possession cannot dominate the geometry of the space.
NUMERIC_FEATURES = (
    "duration_s",
    "n_passes",
    "n_events",
    "n_players",
    "progression_m",
    "direct_speed_m_s",
    "pressure_events",
    "xg",
    "start_x",
    "start_y",
    "end_x",
    "end_y",
    "max_x",
)

BOOL_FEATURES = (
    "high_press_regain",
    "counterattack",
    "switch_of_play",
    "reached_final_third",
    "reached_box",
)

#: A 12-step trajectory is enough to tell a switch from a straight break while
#: staying inside the 96-dimension budget in docs/CONTRACT.md §7.
TRAJ_POINTS = 12

CLIP = 3.0

#: Relative weight per block. Numerics carry the most information about "what
#: kind of move was this"; the trajectory block has 24 dims, so it is damped to
#: stop pure shape dominating tactical content.
W_NUMERIC = 1.0
W_BOOL = 0.8
W_START_TYPE = 0.7
W_OUTCOME = 0.7
W_ZONE = 0.6
W_TRAJ = 0.5

DIM = (
    len(NUMERIC_FEATURES)
    + len(BOOL_FEATURES)
    + len(START_TYPES)
    + len(OUTCOMES)
    + 2 * len(ZONES)
    + 2 * TRAJ_POINTS
)


def _resample_flat(path: np.ndarray, k: int) -> np.ndarray:
    """Sub-sample an already-even flat [x0,y0,...] path down to k points."""
    n = path.shape[1] // 2
    idx = np.linspace(0, n - 1, k).round().astype(int)
    return np.stack([path[:, 2 * idx], path[:, 2 * idx + 1]], axis=2).reshape(path.shape[0], 2 * k)


def moments(numeric: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Per-feature mean and standard deviation, with zero-variance guarded."""
    mu = numeric.mean(axis=0)
    sd = numeric.std(axis=0)
    sd[sd < 1e-9] = 1.0
    return mu, sd


def build_vectors(
    numeric: np.ndarray,
    booleans: np.ndarray,
    start_type_idx: np.ndarray,
    outcome_idx: np.ndarray,
    start_zone_idx: np.ndarray,
    end_zone_idx: np.ndarray,
    path_xy: np.ndarray,
    stats: tuple[np.ndarray, np.ndarray] | None = None,
) -> np.ndarray:
    """Assemble and L2-normalize the phase vectors. Returns (n, DIM) float32.

    ``stats`` supplies the (mean, sd) used to standardize the numeric block.
    The build leaves it None — the moments are the dataset's own. The P2
    evaluation (``ingest/encoder/``) passes the dataset moments explicitly so a
    *half* of a phase is scored on the same scale as a whole one.

    A categorical index of ``-1`` means "this label is not defined for this
    row" and produces an all-zero one-hot block; the build never uses it.
    """
    n = numeric.shape[0]

    mu, sd = moments(numeric) if stats is None else stats
    num = np.clip((numeric - mu) / sd, -CLIP, CLIP) * W_NUMERIC

    bools = booleans.astype(np.float64) * W_BOOL

    def one_hot(idx: np.ndarray, size: int, weight: float) -> np.ndarray:
        m = np.zeros((n, size))
        on = np.asarray(idx) >= 0
        m[np.arange(n)[on], np.asarray(idx)[on]] = weight
        return m

    st = one_hot(start_type_idx, len(START_TYPES), W_START_TYPE)
    oc = one_hot(outcome_idx, len(OUTCOMES), W_OUTCOME)
    sz = one_hot(start_zone_idx, len(ZONES), W_ZONE)
    ez = one_hot(end_zone_idx, len(ZONES), W_ZONE)

    # Trajectory: pitch coordinates scaled to roughly [-1, 1] so shape is
    # comparable in magnitude to the standardized numerics.
    traj = _resample_flat(path_xy, TRAJ_POINTS)
    traj[:, 0::2] = (traj[:, 0::2] - 60.0) / 60.0
    traj[:, 1::2] = (traj[:, 1::2] - 40.0) / 40.0
    traj = traj * W_TRAJ

    vec = np.hstack([num, bools, st, oc, sz, ez, traj])
    norms = np.linalg.norm(vec, axis=1, keepdims=True)
    norms[norms < 1e-9] = 1.0
    return (vec / norms).astype(np.float32)
