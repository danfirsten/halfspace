"""Paths, the frozen splits, and the one hyper-parameter object.

Every number the training run depends on lives in ``TrainConfig`` so that a
checkpoint can carry a complete, replayable description of how it was made.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

from halfspace_ingest.config import OUT_DIR

ENCODER_DIR = Path(__file__).resolve().parent
SPLITS_PATH = ENCODER_DIR / "splits.json"
CKPT_DIR = ENCODER_DIR / "checkpoints"
RESULTS_DIR = ENCODER_DIR / "results"

DATA_DIR = OUT_DIR
EVENTS_DIR = DATA_DIR / "phase_events"

#: The default seed. Fixes split generation, init, batch order and every
#: augmentation draw. Recorded in each checkpoint.
SEED = 20240714


def load_splits() -> dict[str, list[int]]:
    """Match ids per split. Frozen before training — see EVAL.md §4."""
    raw = json.loads(SPLITS_PATH.read_text())
    return {k: raw[k] for k in ("train", "validation", "test")}


@dataclass(frozen=True)
class TrainConfig:
    """Everything the training run is a function of.

    Defaults are the pre-registered starting point (EVAL.md §5); anything tuned
    was tuned on the validation split only and the final values are recorded in
    RESULTS.md.
    """

    seed: int = SEED
    # --- model -----------------------------------------------------------
    d_model: int = 96
    n_layers: int = 2
    n_heads: int = 4
    d_ff: int = 192
    dropout: float = 0.1
    out_dim: int = 64  # contract budget is <= 96 dims
    max_len: int = 64  # 99th percentile phase is 99 events; longer ones stride-subsample
    # --- objective -------------------------------------------------------
    temperature: float = 0.07
    # --- optimisation ----------------------------------------------------
    epochs: int = 40
    batch_size: int = 256
    lr: float = 3e-4
    weight_decay: float = 0.01
    warmup_frac: float = 0.1
    # --- augmentation (see augment.py for the football reasoning) ---------
    crop_min: float = 0.6
    drop_p: float = 0.10
    jitter_xy: float = 0.8
    tempo_sigma: float = 0.10

    def to_json(self) -> dict:
        return asdict(self)


@dataclass
class RunPaths:
    """Where a named run keeps its checkpoints."""

    name: str = "v1"
    ckpt_dir: Path = field(default_factory=lambda: CKPT_DIR)

    @property
    def last(self) -> Path:
        return self.ckpt_dir / f"{self.name}-last.pt"

    @property
    def best(self) -> Path:
        return self.ckpt_dir / f"{self.name}-best.pt"
