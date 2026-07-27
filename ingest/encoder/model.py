"""The encoder: a small Transformer over a phase's event sequence.

Deliberately small. The dataset is 11.5k training phases of ~22 events; a
2-layer, 96-wide encoder is already at the edge of what that supports, and the
contract's output budget is 96 dimensions. Parameter count is asserted in the
tests and printed by ``train.py``.
"""

from __future__ import annotations

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

from .config import TrainConfig
from .data import N_CHANNELS, N_TYPES


class PhaseEncoder(nn.Module):
    """(numeric, type, mask) -> one L2-normalized vector per phase."""

    def __init__(self, cfg: TrainConfig):
        super().__init__()
        self.cfg = cfg
        d = cfg.d_model
        self.type_emb = nn.Embedding(N_TYPES, 24, padding_idx=0)
        self.proj = nn.Linear(N_CHANNELS + 24, d)
        # Learned positions: "third event of the move" is a real football
        # feature (the first two touches of a counter are not the last two),
        # and sequences are short enough that learned beats sinusoidal here.
        self.pos = nn.Embedding(cfg.max_len, d)
        layer = nn.TransformerEncoderLayer(
            d_model=d,
            nhead=cfg.n_heads,
            dim_feedforward=cfg.d_ff,
            dropout=cfg.dropout,
            batch_first=True,
            norm_first=True,
            activation="gelu",
        )
        self.encoder = nn.TransformerEncoder(
            layer, num_layers=cfg.n_layers, enable_nested_tensor=False
        )
        self.norm = nn.LayerNorm(d)
        self.head = nn.Linear(d, cfg.out_dim)
        # Projection head, used only by the contrastive loss and thrown away at
        # export time (SimCLR's finding, and it holds here: the vector we ship
        # should not be the one the loss is fitted on).
        self.proj_head = nn.Sequential(
            nn.Linear(cfg.out_dim, cfg.out_dim), nn.GELU(), nn.Linear(cfg.out_dim, cfg.out_dim)
        )

    def forward(self, num: torch.Tensor, typ: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
        b, ln, _ = num.shape
        h = torch.cat([num, self.type_emb(typ)], dim=-1)
        h = self.proj(h)
        pos = torch.arange(ln, device=num.device).clamp_max(self.cfg.max_len - 1)
        h = h + self.pos(pos)[None]
        h = self.encoder(h, src_key_padding_mask=~mask)
        h = self.norm(h)
        # Masked mean pool: a phase is its events, and no event is the summary.
        m = mask.unsqueeze(-1).to(h.dtype)
        pooled = (h * m).sum(1) / m.sum(1).clamp_min(1.0)
        return F.normalize(self.head(pooled), dim=-1)

    def project(self, z: torch.Tensor) -> torch.Tensor:
        return F.normalize(self.proj_head(z), dim=-1)

    def n_params(self, trainable_only: bool = True) -> int:
        ps = self.parameters()
        return sum(p.numel() for p in ps if p.requires_grad or not trainable_only)


def nt_xent(z1: torch.Tensor, z2: torch.Tensor, temperature: float) -> torch.Tensor:
    """NT-Xent / InfoNCE over 2N views with in-batch negatives.

    Both views of a phase are positives for each other; every other view in the
    batch — including the other phase's *other* view — is a negative. With a 256
    batch that is 510 negatives per anchor, which is what makes the loss sharpen
    the geometry rather than just collapse it.
    """
    n = z1.shape[0]
    z = torch.cat([z1, z2], dim=0)
    sim = (z @ z.T) / temperature
    sim.fill_diagonal_(float("-inf"))
    target = torch.cat([torch.arange(n, 2 * n), torch.arange(0, n)]).to(z.device)
    return F.cross_entropy(sim, target)


def set_determinism(seed: int) -> None:
    """One seed for numpy, torch and the CPU kernels."""
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.use_deterministic_algorithms(True, warn_only=True)
