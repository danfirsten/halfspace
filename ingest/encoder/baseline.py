"""The P0 baseline vector, recomputed for an arbitrary slice of a phase.

The shipped `similarity.parquet` is built from `phases.parquet`, which only has
whole-phase features. The primary evaluation (EVAL.md §2) needs the same 74-dim
vector for *half* a phase, so the feature derivations of
docs/phase-definitions.md are reproduced here against `phase_events` rows.

Two honest notes about the reproduction:

* **`duration_s` is (last - first) event offset.** The published definition ends
  the clock at ``timestamp + duration`` of the last ball event, and
  `phase_events` does not store per-event durations. The difference is the last
  event's own duration, typically well under a second. It is applied identically
  to every segment on both sides of the comparison.
* **`high_press_regain` and `counterattack` are inherited from the parent
  phase.** Both are defined by what happened *before* the chain started (who had
  the ball, who was pressing) and cannot be derived from a slice of it. See
  ``BaselineMode`` for how the two evaluation variants treat them.

Everything else — the ball path, the numerics on top of it, both zones, the
switch flag, the box and final-third flags, the 20-point trajectory — is
recomputed from the slice's own events under the published definitions.

``check_reproduction`` verifies the whole thing by rebuilding whole-phase
vectors and comparing them to the artifact the app actually ships.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

import numpy as np
import polars as pl

from halfspace_ingest import taxonomy as T
from halfspace_ingest.config import PATH_POINTS, YARD_M
from halfspace_ingest.geometry import ZONE_INDEX, in_box, resample_path, zone
from halfspace_ingest.similarity import (
    BOOL_FEATURES,
    NUMERIC_FEATURES,
    build_vectors,
    moments,
)

from .config import DATA_DIR
from .data import PhaseStore, Segment, is_admin


class BaselineMode(str, Enum):
    """How the baseline treats labels a half-phase does not own (EVAL.md §2)."""

    #: `start_type` / `outcome` / `high_press_regain` / `counterattack` are
    #: inherited from the parent phase, so both halves of a phase share them.
    #: This leaks phase identity *into the baseline* and is the variant the
    #: decision rule uses — the harder bar for the encoder.
    GENEROUS = "generous"
    #: Those four are withheld (one-hots all-zero, flags 0): the baseline gets
    #: only what a half of a phase genuinely determines.
    STRICT = "strict"


@dataclass
class PhaseLabels:
    """The parent-phase categoricals, from `phases.parquet`."""

    start_type: dict[str, int]
    outcome: dict[str, int]
    high_press_regain: dict[str, bool]
    counterattack: dict[str, bool]


def load_phase_labels() -> PhaseLabels:
    df = pl.read_parquet(
        DATA_DIR / "phases.parquet",
        columns=["phase_id", "start_type", "outcome", "high_press_regain", "counterattack"],
    )
    ids = df["phase_id"].to_list()
    return PhaseLabels(
        start_type=dict(zip(ids, [T.START_TYPES.index(s) for s in df["start_type"].to_list()])),
        outcome=dict(zip(ids, [T.OUTCOMES.index(s) for s in df["outcome"].to_list()])),
        high_press_regain=dict(zip(ids, df["high_press_regain"].to_list())),
        counterattack=dict(zip(ids, df["counterattack"].to_list())),
    )


def dataset_moments() -> tuple[np.ndarray, np.ndarray]:
    """The z-scoring statistics the shipped vectors were built with.

    Whole-dataset, exactly as `halfspace_ingest.build.build_similarity` uses
    them. EVAL.md §4 records this as a small leak in the baseline's favour: it
    is the shipped artifact, and refitting the moments per split would measure a
    representation nobody has.
    """
    df = pl.read_parquet(DATA_DIR / "phases.parquet", columns=list(NUMERIC_FEATURES))
    return moments(df.to_numpy().astype(np.float64))


def segment_path(seg: Segment) -> np.ndarray:
    """The ball path of a slice, per docs/phase-definitions.md §4.

    In-possession events only, Pressure and administrative events excluded, each
    event's location followed by its end location where it has one, consecutive
    duplicates removed.
    """
    ours = seg.col("side") == 1
    tid = seg.col("type_id")
    keep = ours & ~is_admin(tid) & (tid != T.PRESSURE)
    x, y = seg.col("x"), seg.col("y")
    ex, ey = seg.col("end_x"), seg.col("end_y")
    pts: list[tuple[float, float]] = []
    for i in np.flatnonzero(keep):
        if not np.isfinite(x[i]):
            continue
        pts.append((float(x[i]), float(y[i])))
        if np.isfinite(ex[i]):
            pts.append((float(ex[i]), float(ey[i])))
    out: list[tuple[float, float]] = []
    for p in pts:
        if not out or abs(p[0] - out[-1][0]) > 0.01 or abs(p[1] - out[-1][1]) > 0.01:
            out.append(p)
    return np.array(out, dtype=np.float64).reshape(-1, 2)


def segment_features(seg: Segment) -> dict | None:
    """Recompute every phase feature the baseline vector needs, for a slice.

    Returns None when the slice has no ball path — a segment of pure opponent
    pressure, say. The eligibility rule in EVAL.md §2 excludes those.
    """
    path = segment_path(seg)
    if len(path) == 0:
        return None

    tid = seg.col("type_id")
    side = seg.col("side")
    ours = side == 1
    admin = is_admin(tid)
    t = seg.col("t")

    ball = ~admin
    dur = float(t[ball].max() - t[ball].min()) if ball.any() else 0.0

    shots = ours & (tid == T.SHOT)
    xg = float(np.nan_to_num(seg.col("xg")[shots]).max()) if shots.any() else 0.0

    players = seg.col("player")[ours]
    n_players = int(len(np.unique(players[players >= 0])))

    # A switch is a pass by us that moved the ball >= 40 yards across the pitch.
    passes = ours & (tid == T.PASS)
    py, pey = seg.col("y")[passes], seg.col("end_y")[passes]
    both = np.isfinite(py) & np.isfinite(pey)
    switch = bool(np.any(np.abs(pey[both] - py[both]) >= 40.0))

    progression = float(path[-1, 0] - path[0, 0]) * YARD_M
    return {
        "duration_s": dur,
        "n_passes": int(passes.sum()),
        "n_events": int(len(seg)),
        "n_players": n_players,
        "progression_m": progression,
        "direct_speed_m_s": progression / dur if dur >= 0.05 else 0.0,
        "pressure_events": int(np.sum((side == 0) & (tid == T.PRESSURE))),
        "xg": xg,
        "start_x": float(path[0, 0]),
        "start_y": float(path[0, 1]),
        "end_x": float(path[-1, 0]),
        "end_y": float(path[-1, 1]),
        "max_x": float(path[:, 0].max()),
        "switch_of_play": switch,
        "reached_final_third": bool(np.any(path[:, 0] >= 80.0)),
        "reached_box": bool(any(in_box(px, py_) for px, py_ in path)),
        "start_zone": zone(path[0, 0], path[0, 1]),
        "end_zone": zone(path[-1, 0], path[-1, 1]),
        "path_xy": np.array(
            resample_path([(float(a), float(b)) for a, b in path], PATH_POINTS), dtype=np.float64
        ).reshape(-1),
    }


def vectors_for_segments(
    segments: list[Segment],
    phase_ids: list[str],
    labels: PhaseLabels,
    stats: tuple[np.ndarray, np.ndarray],
    mode: BaselineMode = BaselineMode.GENEROUS,
) -> tuple[np.ndarray, np.ndarray]:
    """Baseline vectors for a list of slices.

    Returns ``(vectors (m, 74) float32, ok mask (n,) bool)`` — ``ok`` is False
    for segments with no ball path, which are dropped from the output.
    """
    feats, keep = [], []
    for seg, pid in zip(segments, phase_ids):
        f = segment_features(seg)
        keep.append(f is not None)
        if f is not None:
            f["phase_id"] = pid
            feats.append(f)
    ok = np.array(keep, dtype=bool)
    if not feats:
        return np.zeros((0, 74), dtype=np.float32), ok

    numeric = np.array([[f[c] for c in NUMERIC_FEATURES] for f in feats], dtype=np.float64)
    generous = mode is BaselineMode.GENEROUS
    booleans = np.array(
        [
            [
                labels.high_press_regain[f["phase_id"]] if generous else False,
                labels.counterattack[f["phase_id"]] if generous else False,
                f["switch_of_play"],
                f["reached_final_third"],
                f["reached_box"],
            ]
            for f in feats
        ],
        dtype=np.float64,
    )
    assert BOOL_FEATURES == (
        "high_press_regain",
        "counterattack",
        "switch_of_play",
        "reached_final_third",
        "reached_box",
    ), "boolean block order changed; update baseline.vectors_for_segments"

    st = np.array(
        [labels.start_type[f["phase_id"]] if generous else -1 for f in feats], dtype=np.int64
    )
    oc = np.array(
        [labels.outcome[f["phase_id"]] if generous else -1 for f in feats], dtype=np.int64
    )
    sz = np.array([ZONE_INDEX[f["start_zone"]] for f in feats], dtype=np.int64)
    ez = np.array([ZONE_INDEX[f["end_zone"]] for f in feats], dtype=np.int64)
    path = np.array([f["path_xy"] for f in feats], dtype=np.float64)

    return build_vectors(numeric, booleans, st, oc, sz, ez, path, stats=stats), ok


def check_reproduction(store: PhaseStore, n: int = 400, seed: int = 0) -> dict:
    """Sanity: rebuild WHOLE-phase baseline vectors and compare to the artifact.

    The recomputation above is a second implementation of the feature layer; if
    it disagrees with the shipped one on whole phases, every half-phase number
    it produces is suspect. Reported in RESULTS.md.
    """
    shipped = pl.read_parquet(DATA_DIR / "similarity.parquet")
    vec_by_id = dict(zip(shipped["phase_id"].to_list(), shipped["vec"].to_list()))
    labels = load_phase_labels()
    stats = dataset_moments()

    rng = np.random.default_rng(seed)
    idx = rng.choice(len(store), size=min(n, len(store)), replace=False)
    segs = [store.slice(int(i)) for i in idx]
    pids = [store.phase_ids[int(i)] for i in idx]
    mine, ok = vectors_for_segments(segs, pids, labels, stats, BaselineMode.GENEROUS)

    cos, worst = [], None
    for v, pid in zip(mine, [p for p, k in zip(pids, ok) if k]):
        ref = np.array(vec_by_id[pid], dtype=np.float64)
        c = float(np.dot(ref, v) / (np.linalg.norm(ref) * np.linalg.norm(v)))
        cos.append(c)
        if worst is None or c < worst[1]:
            worst = (pid, c)
    cos = np.array(cos)
    return {
        "n": int(len(cos)),
        "cosine_mean": float(cos.mean()),
        "cosine_p05": float(np.percentile(cos, 5)),
        "cosine_min": float(cos.min()),
        "worst_phase": worst[0] if worst else None,
    }
