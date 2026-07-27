"""Train the phase encoder. One CLI, resumable, seeded.

    ./.venv/bin/python -m encoder.train --name v1 --epochs 40

Re-running the same command resumes from the last checkpoint if one exists
(``--fresh`` to start over). Checkpoints carry the full config, the seed, the
epoch, the optimiser state and the validation history, so a run can be
reproduced or continued from nothing but the file.

Validation MRR on the primary metric is computed every ``--eval-every`` epochs
and drives checkpoint selection. That is a decision made on the validation
split, which EVAL.md §4 permits; the test split is never read here.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
import torch

from .augment import augment
from .config import CKPT_DIR, RESULTS_DIR, TrainConfig, load_splits
from .data import PhaseStore, featurize, load_store, pad_batch
from .evaluate import eligible_halves, rank_of_gold, retrieval_metrics
from .infer import embed_segments
from .model import PhaseEncoder, nt_xent, set_determinism

#: Phases with fewer events than this are dropped from *training* only: a
#: two-event chain (a goal kick straight out of play) has no sequence to model
#: and only teaches the encoder to match on length.
MIN_TRAIN_EVENTS = 4


def _views(store: PhaseStore, idx: np.ndarray, rng: np.random.Generator, cfg: TrainConfig):
    items = []
    for i in idx:
        v = augment(store.slice(int(i)), rng, cfg)
        items.append(
            featurize(
                v["t"], v["type_idx"], v["side"], v["x"], v["y"], v["end_x"], v["end_y"],
                v["under_pressure"], v["counterpress"], v["out"], v["xg"],
            )
        )
    return pad_batch(items, cfg.max_len)


def _to_torch(batch):
    num, typ, mask = batch
    return torch.from_numpy(num), torch.from_numpy(typ), torch.from_numpy(mask)


def validation_mrr(model: PhaseEncoder, cfg: TrainConfig, store: PhaseStore, halves) -> dict:
    """Primary metric on the validation split — the number checkpoints are picked on."""
    model.eval()
    first = [store.slice(int(i), 0, int(c)) for i, c in zip(halves.index, halves.cut)]
    second = [store.slice(int(i), int(c)) for i, c in zip(halves.index, halves.cut)]
    q = embed_segments(model, cfg, first).astype(np.float64)
    c = embed_segments(model, cfg, second).astype(np.float64)
    model.train()
    return retrieval_metrics(rank_of_gold(q, c, np.arange(len(q))))


def train(
    cfg: TrainConfig,
    name: str = "v1",
    fresh: bool = False,
    eval_every: int = 5,
    workers_note: str = "cpu",
) -> dict:
    set_determinism(cfg.seed)
    torch.set_num_threads(4)

    splits = load_splits()
    train_store = load_store(splits["train"])
    val_store = load_store(splits["validation"])
    val_halves = eligible_halves(val_store)

    lengths = train_store.stop - train_store.start
    train_idx = np.flatnonzero(lengths >= MIN_TRAIN_EVENTS)
    print(
        f"train: {len(train_idx)} of {len(train_store)} phases (>= {MIN_TRAIN_EVENTS} events), "
        f"val: {len(val_halves.index)} eligible of {len(val_store)}",
        flush=True,
    )

    model = PhaseEncoder(cfg)
    n_params = model.n_params()
    print(f"parameters: {n_params:,}", flush=True)
    opt = torch.optim.AdamW(model.parameters(), lr=cfg.lr, weight_decay=cfg.weight_decay)

    steps_per_epoch = max(1, len(train_idx) // cfg.batch_size)
    total_steps = steps_per_epoch * cfg.epochs
    warmup = max(1, int(total_steps * cfg.warmup_frac))

    def lr_at(step: int) -> float:
        if step < warmup:
            return step / warmup
        p = (step - warmup) / max(1, total_steps - warmup)
        return 0.5 * (1 + np.cos(np.pi * p))

    sched = torch.optim.lr_scheduler.LambdaLR(opt, lr_at)

    CKPT_DIR.mkdir(parents=True, exist_ok=True)
    last_path = CKPT_DIR / f"{name}-last.pt"
    best_path = CKPT_DIR / f"{name}-best.pt"

    start_epoch, best_mrr, history = 0, -1.0, []
    if last_path.exists() and not fresh:
        ck = torch.load(last_path, map_location="cpu", weights_only=False)
        if ck["config"] != cfg.to_json():
            raise SystemExit(
                f"{last_path} was trained with a different config; pass --fresh or a new --name"
            )
        model.load_state_dict(ck["model"])
        opt.load_state_dict(ck["optimizer"])
        sched.load_state_dict(ck["scheduler"])
        start_epoch, best_mrr, history = ck["epoch"], ck["best_mrr"], ck["history"]
        print(f"resumed {last_path} at epoch {start_epoch}", flush=True)

    rng = np.random.default_rng(cfg.seed + 1000 + start_epoch)
    t0 = time.time()
    model.train()
    for epoch in range(start_epoch, cfg.epochs):
        order = rng.permutation(train_idx)
        losses = []
        for s in range(steps_per_epoch):
            idx = order[s * cfg.batch_size : (s + 1) * cfg.batch_size]
            if len(idx) < 8:
                continue
            z1 = model(*_to_torch(_views(train_store, idx, rng, cfg)))
            z2 = model(*_to_torch(_views(train_store, idx, rng, cfg)))
            loss = nt_xent(model.project(z1), model.project(z2), cfg.temperature)
            opt.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            sched.step()
            losses.append(loss.detach().item())

        rec = {"epoch": epoch + 1, "loss": float(np.mean(losses)), "seconds": round(time.time() - t0, 1)}
        if (epoch + 1) % eval_every == 0 or epoch + 1 == cfg.epochs:
            m = validation_mrr(model, cfg, val_store, val_halves)
            rec.update({"val_mrr": m["mrr"], "val_recall@1": m["recall@1"]})
            if m["mrr"] > best_mrr:
                best_mrr = m["mrr"]
                _save(best_path, model, opt, sched, cfg, epoch + 1, best_mrr, history + [rec], n_params)
        history.append(rec)
        print(json.dumps(rec), flush=True)
        _save(last_path, model, opt, sched, cfg, epoch + 1, best_mrr, history, n_params)

    wall = round(time.time() - t0, 1)
    summary = {
        "name": name,
        "seed": cfg.seed,
        "parameters": n_params,
        "device": workers_note,
        "wall_seconds": wall,
        "best_val_mrr": best_mrr,
        "config": cfg.to_json(),
        "history": history,
    }
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    (RESULTS_DIR / f"train-{name}.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(f"done in {wall}s; best val MRR {best_mrr:.4f}; best checkpoint {best_path}", flush=True)
    return summary


def _save(path: Path, model, opt, sched, cfg: TrainConfig, epoch, best_mrr, history, n_params):
    torch.save(
        {
            "model": model.state_dict(),
            "optimizer": opt.state_dict(),
            "scheduler": sched.state_dict(),
            "config": cfg.to_json(),
            "epoch": epoch,
            "best_mrr": best_mrr,
            "history": history,
            "parameters": n_params,
        },
        path,
    )


def main(argv: list[str] | None = None) -> int:
    cfg_fields = TrainConfig()
    ap = argparse.ArgumentParser(description="Train the Halfspace phase encoder")
    ap.add_argument("--name", default="v1")
    ap.add_argument("--fresh", action="store_true", help="ignore any existing checkpoint")
    ap.add_argument("--eval-every", type=int, default=5)
    for field, value in cfg_fields.to_json().items():
        ap.add_argument(f"--{field.replace('_', '-')}", type=type(value), default=value)
    args = ap.parse_args(argv)

    cfg = TrainConfig(
        **{f: getattr(args, f) for f in cfg_fields.to_json()}
    )
    train(cfg, name=args.name, fresh=args.fresh, eval_every=args.eval_every)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
