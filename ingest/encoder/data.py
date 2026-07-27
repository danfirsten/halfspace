"""Phase event sequences as tensors.

The encoder's whole input is `web/public/data/phase_events/{match_id}.parquet`
— the same per-event rows the phase player animates. Nothing is read from the
raw StatsBomb JSON here (the transfer-probe labels in ``labels.py`` are the one
exception, deliberately, because those labels must be invisible to the model).

A phase is stored as a ragged run of events inside flat arrays plus an offset
table: 380k events across 16.8k phases fits comfortably in memory that way, and
slicing a half-phase becomes a slice rather than a copy.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import polars as pl

from halfspace_ingest import taxonomy as T

from .config import EVENTS_DIR

#: The event-type vocabulary. Index 0 is reserved for padding / an unseen type,
#: so a type id absent from Euro 2020-24 cannot silently collide with a real one.
TYPE_IDS: tuple[int, ...] = (
    T.BALL_RECOVERY, T.DISPOSSESSED, T.DUEL, T.BLOCK, T.OFFSIDE, T.CLEARANCE,
    T.INTERCEPTION, T.DRIBBLE, T.SHOT, T.PRESSURE, T.HALF_START, T.SUBSTITUTION,
    T.OWN_GOAL_AGAINST, T.FOUL_WON, T.FOUL_COMMITTED, T.GOALKEEPER,
    T.BAD_BEHAVIOUR, T.OWN_GOAL_FOR, T.PLAYER_ON, T.PLAYER_OFF, T.SHIELD,
    T.PASS, T.FIFTY_FIFTY, T.HALF_END, T.TACTICAL_SHIFT, T.ERROR, T.MISCONTROL,
    T.DRIBBLED_PAST, T.INJURY_STOPPAGE, T.REFEREE_BALL_DROP, T.BALL_RECEIPT,
    T.CARRY, T.STARTING_XI,
)
TYPE_INDEX = {tid: i + 1 for i, tid in enumerate(TYPE_IDS)}
N_TYPES = len(TYPE_IDS) + 1

#: Numeric per-event channels handed to the model, in order. Kept explicit so
#: the feature tensor is readable in a debugger and testable by name.
NUMERIC_CHANNELS: tuple[str, ...] = (
    "x", "y", "has_loc", "end_x", "end_y", "has_end", "dx", "dy",
    "t_rel", "dt", "under_pressure", "counterpress", "out", "xg", "side",
)
N_CHANNELS = len(NUMERIC_CHANNELS)

_ADMIN = np.array(sorted(T.ADMIN_TYPES), dtype=np.int16)


@dataclass
class PhaseStore:
    """Flat event arrays for a set of matches, plus per-phase offsets.

    ``events[start[i]:stop[i]]`` is phase ``phase_ids[i]``, in event order.
    """

    phase_ids: list[str]
    match_ids: np.ndarray  # (n_phases,) int64
    start: np.ndarray  # (n_phases,) int64
    stop: np.ndarray  # (n_phases,) int64
    # per-event columns, all length n_events
    t: np.ndarray  # float32, seconds from the phase's first event
    type_id: np.ndarray  # int16, raw StatsBomb type id
    type_idx: np.ndarray  # int16, index into TYPE_IDS (+1)
    side: np.ndarray  # int8, 1 = team in possession, 0 = opponent
    x: np.ndarray  # float32, NaN where the event has no location
    y: np.ndarray
    end_x: np.ndarray  # float32, NaN where the event records no end point
    end_y: np.ndarray
    under_pressure: np.ndarray  # int8
    counterpress: np.ndarray  # int8
    out: np.ndarray  # int8
    xg: np.ndarray  # float32, 0 where the event is not a shot
    player: np.ndarray  # int32 player code, -1 when the event has no player

    def __len__(self) -> int:
        return len(self.phase_ids)

    def index_of(self, phase_id: str) -> int:
        return self.phase_ids.index(phase_id)

    def n_events(self, i: int) -> int:
        return int(self.stop[i] - self.start[i])

    def slice(self, i: int, lo: int = 0, hi: int | None = None) -> "Segment":
        """A (sub-)sequence of phase ``i``, indices relative to the phase."""
        s = int(self.start[i])
        e = int(self.stop[i])
        a = s + lo
        b = e if hi is None else s + hi
        return Segment(self, a, min(b, e))


@dataclass
class Segment:
    """A contiguous run of events — a whole phase or half of one."""

    store: PhaseStore
    a: int
    b: int

    def __len__(self) -> int:
        return self.b - self.a

    def col(self, name: str) -> np.ndarray:
        return getattr(self.store, name)[self.a : self.b]


def _read_events(match_ids: list[int]) -> pl.DataFrame:
    cols = [
        "phase_id", "idx", "t_offset_s", "type_id", "team_side", "player_name",
        "x", "y", "end_x", "end_y", "under_pressure", "counterpress", "out", "xg",
    ]
    frames = []
    for mid in sorted(match_ids):
        path = EVENTS_DIR / f"{mid}.parquet"
        df = pl.read_parquet(path, columns=cols).with_columns(
            pl.lit(mid, dtype=pl.Int64).alias("match_id"),
            pl.col("team_side").cast(pl.Utf8),
        )
        frames.append(df)
    return pl.concat(frames).sort(["match_id", "phase_id", "idx"])


def load_store(match_ids: list[int]) -> PhaseStore:
    """Read the given matches' shards into one :class:`PhaseStore`."""
    df = _read_events(match_ids)

    counts = df.group_by("phase_id", maintain_order=True).len()
    phase_ids = counts["phase_id"].to_list()
    n = counts["len"].to_numpy().astype(np.int64)
    stop = np.cumsum(n)
    start = stop - n

    type_id = df["type_id"].to_numpy().astype(np.int16)
    type_idx = np.zeros(len(type_id), dtype=np.int16)
    for tid, i in TYPE_INDEX.items():
        type_idx[type_id == tid] = i

    names = df["player_name"].fill_null("").to_numpy()
    uniq, codes = np.unique(names, return_inverse=True)
    player = codes.astype(np.int32)
    blank = np.where(uniq == "")[0]
    if len(blank):
        player[codes == blank[0]] = -1

    t = df["t_offset_s"].to_numpy().astype(np.float32)

    return PhaseStore(
        phase_ids=phase_ids,
        match_ids=np.array([int(p.split("-")[0]) for p in phase_ids], dtype=np.int64),
        start=start,
        stop=stop,
        t=t,
        type_id=type_id,
        type_idx=type_idx,
        side=(df["team_side"].to_numpy() == "in_possession").astype(np.int8),
        x=df["x"].to_numpy().astype(np.float32),
        y=df["y"].to_numpy().astype(np.float32),
        end_x=df["end_x"].to_numpy().astype(np.float32),
        end_y=df["end_y"].to_numpy().astype(np.float32),
        under_pressure=df["under_pressure"].fill_null(False).to_numpy().astype(np.int8),
        counterpress=df["counterpress"].fill_null(False).to_numpy().astype(np.int8),
        out=df["out"].fill_null(False).to_numpy().astype(np.int8),
        xg=np.nan_to_num(df["xg"].to_numpy().astype(np.float32)),
        player=player,
    )


def is_admin(type_id: np.ndarray) -> np.ndarray:
    """Substitutions, half starts, tactical shifts — no ball, no location."""
    return np.isin(type_id, _ADMIN)


def stride_subsample(n: int, max_len: int) -> np.ndarray:
    """Indices keeping order when a phase is longer than the model's window.

    A uniform stride rather than a head truncation: the tail of a possession is
    where it ends — the shot, the tackle, the ball going out — and a model that
    never sees the end of a long build-up has been handed a different dataset.
    """
    if n <= max_len:
        return np.arange(n)
    return np.unique(np.linspace(0, n - 1, max_len).round().astype(np.int64))


def featurize(
    t: np.ndarray,
    type_idx: np.ndarray,
    side: np.ndarray,
    x: np.ndarray,
    y: np.ndarray,
    end_x: np.ndarray,
    end_y: np.ndarray,
    under_pressure: np.ndarray,
    counterpress: np.ndarray,
    out: np.ndarray,
    xg: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """Per-event arrays -> ``(numeric (L, N_CHANNELS) float32, types (L,) int64)``.

    Scaling choices, all fixed (no fitted statistics — the encoder must give the
    same vector for the same phase forever):

    * ``x``/``y`` to roughly [-1, 1] over the 120x80 pitch, as the baseline's
      trajectory block does;
    * ``dx``/``dy`` are the event's own displacement (a pass's length and
      direction) at a 30/20-yard scale, so a long switch reads ~1;
    * ``t_rel`` is seconds since **this segment's** first event, /30. Relative,
      not absolute, so a crop of a phase is not told where it was cut from;
    * ``dt`` is the gap to the previous event, log1p'd — the difference between
      a one-touch pass and a two-second dwell matters, the difference between 40
      and 45 seconds of a stoppage does not.
    """
    lo = np.isfinite(x)
    he = np.isfinite(end_x)
    xf = np.where(lo, x, 0.0)
    yf = np.where(lo, y, 0.0)
    exf = np.where(he, end_x, 0.0)
    eyf = np.where(he, end_y, 0.0)

    t_rel = t - (t[0] if len(t) else 0.0)
    dt = np.diff(t_rel, prepend=t_rel[:1] if len(t_rel) else np.zeros(1, np.float32))

    feats = np.stack(
        [
            np.where(lo, xf / 60.0 - 1.0, 0.0),
            np.where(lo, yf / 40.0 - 1.0, 0.0),
            lo.astype(np.float32),
            np.where(he, exf / 60.0 - 1.0, 0.0),
            np.where(he, eyf / 40.0 - 1.0, 0.0),
            he.astype(np.float32),
            np.where(lo & he, (exf - xf) / 30.0, 0.0),
            np.where(lo & he, (eyf - yf) / 20.0, 0.0),
            np.clip(t_rel / 30.0, 0.0, 4.0),
            np.clip(np.log1p(np.maximum(dt, 0.0)) / 2.0, 0.0, 2.0),
            under_pressure.astype(np.float32),
            counterpress.astype(np.float32),
            out.astype(np.float32),
            np.clip(xg, 0.0, 1.0),
            side.astype(np.float32),
        ],
        axis=1,
    ).astype(np.float32)
    return feats, type_idx.astype(np.int64)


def featurize_segment(seg: Segment) -> tuple[np.ndarray, np.ndarray]:
    return featurize(
        seg.col("t"), seg.col("type_idx"), seg.col("side"), seg.col("x"), seg.col("y"),
        seg.col("end_x"), seg.col("end_y"), seg.col("under_pressure"),
        seg.col("counterpress"), seg.col("out"), seg.col("xg"),
    )


def pad_batch(items: list[tuple[np.ndarray, np.ndarray]], max_len: int):
    """Right-pad a list of (numeric, types) to one batch + boolean mask."""
    b = len(items)
    lengths = [min(len(f), max_len) for f, _ in items]
    lmax = max(lengths) if lengths else 1
    num = np.zeros((b, lmax, N_CHANNELS), dtype=np.float32)
    typ = np.zeros((b, lmax), dtype=np.int64)
    mask = np.zeros((b, lmax), dtype=bool)
    for i, (f, ty) in enumerate(items):
        keep = stride_subsample(len(f), max_len)
        k = len(keep)
        num[i, :k] = f[keep]
        typ[i, :k] = ty[keep]
        mask[i, :k] = True
    return num, typ, mask
