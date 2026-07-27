"""Load a checkpoint and turn segments into vectors.

Kept separate from ``train.py`` so that evaluating or exporting never imports
the training loop, and separate from ``model.py`` so that ``model.py`` stays a
pure description of the network.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import torch

from .config import TrainConfig
from .data import Segment, featurize_segment, pad_batch
from .model import PhaseEncoder


def load_checkpoint(path: str | Path) -> tuple[PhaseEncoder, TrainConfig]:
    ckpt = torch.load(path, map_location="cpu", weights_only=False)
    cfg = TrainConfig(**ckpt["config"])
    model = PhaseEncoder(cfg)
    model.load_state_dict(ckpt["model"])
    model.eval()
    return model, cfg


@torch.no_grad()
def embed_segments(
    model: PhaseEncoder, cfg: TrainConfig, segments: list[Segment], batch_size: int = 512
) -> np.ndarray:
    """(n, out_dim) float32, L2-normalized. Deterministic: eval mode, no augmentation."""
    out = np.zeros((len(segments), cfg.out_dim), dtype=np.float32)
    for i in range(0, len(segments), batch_size):
        chunk = segments[i : i + batch_size]
        items = [featurize_segment(s) for s in chunk]
        num, typ, mask = pad_batch(items, cfg.max_len)
        z = model(torch.from_numpy(num), torch.from_numpy(typ), torch.from_numpy(mask))
        out[i : i + len(chunk)] = z.numpy()
    return out
