"""The pre-registered evaluation, run identically over both representations.

Primary   split-half retrieval  (EVAL.md §2)
Secondary transfer probe        (EVAL.md §3)

Both representations go through the same ranking and the same metric code; the
only thing that differs is the function that turns a slice of events into a
unit vector. Run:

    ./.venv/bin/python -m encoder.evaluate --split validation --ckpt encoder/checkpoints/v1-best.pt
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass

import numpy as np
import polars as pl

from halfspace_ingest import taxonomy as T

from . import baseline as B
from .config import DATA_DIR, RESULTS_DIR, load_splits
from .data import PhaseStore, is_admin, load_store
from .labels import LABELS, label_matrix

#: EVAL.md §2: a phase is eligible for split-half retrieval iff it has at least
#: this many events and each half has at least two located, in-possession,
#: non-administrative events (the baseline needs two points to have a path).
MIN_EVENTS = 8
MIN_HALF_PATH_EVENTS = 2


# --------------------------------------------------------------------------
# metrics
# --------------------------------------------------------------------------
def rank_of_gold(queries: np.ndarray, candidates: np.ndarray, gold: np.ndarray) -> np.ndarray:
    """1-based rank of each query's gold candidate under cosine similarity.

    Ties count as half, so a representation that maps everything to one point
    scores the chance rate rather than a spurious 1.0.
    """
    sims = queries @ candidates.T
    gold_sim = sims[np.arange(len(gold)), gold]
    greater = (sims > gold_sim[:, None]).sum(axis=1)
    equal = (sims == gold_sim[:, None]).sum(axis=1) - 1  # exclude the gold itself
    return 1 + greater + equal / 2.0


def retrieval_metrics(ranks: np.ndarray) -> dict:
    return {
        "n": int(len(ranks)),
        "mrr": float(np.mean(1.0 / ranks)),
        "recall@1": float(np.mean(ranks <= 1)),
        "recall@10": float(np.mean(ranks <= 10)),
        "median_rank": float(np.median(ranks)),
    }


def roc_auc(scores: np.ndarray, labels: np.ndarray) -> float:
    """Mann-Whitney U / rank formulation, ties handled by average ranks."""
    pos = labels > 0.5
    n_pos, n_neg = int(pos.sum()), int((~pos).sum())
    if n_pos == 0 or n_neg == 0:
        return float("nan")
    order = np.argsort(scores, kind="mergesort")
    ranks = np.empty(len(scores), dtype=np.float64)
    sorted_scores = scores[order]
    i = 0
    while i < len(scores):
        j = i
        while j + 1 < len(scores) and sorted_scores[j + 1] == sorted_scores[i]:
            j += 1
        ranks[order[i : j + 1]] = (i + j) / 2.0 + 1.0
        i = j + 1
    return float((ranks[pos].sum() - n_pos * (n_pos + 1) / 2.0) / (n_pos * n_neg))


def knn_label_scores(vectors: np.ndarray, labels: np.ndarray, k: int = 25) -> np.ndarray:
    """Leave-one-out k-NN label scores: mean label over the k nearest others."""
    sims = vectors @ vectors.T
    np.fill_diagonal(sims, -np.inf)
    nn = np.argpartition(-sims, kth=k, axis=1)[:, :k]
    return labels[nn].mean(axis=1)


def transfer_probe(vectors: np.ndarray, labels: np.ndarray, k: int = 25) -> dict:
    scores = knn_label_scores(vectors, labels, k)
    per = {lab: roc_auc(scores[:, i], labels[:, i]) for i, lab in enumerate(LABELS)}
    return {"k": k, "per_label_auc": per, "macro_auc": float(np.nanmean(list(per.values())))}


# --------------------------------------------------------------------------
# eligibility and halves
# --------------------------------------------------------------------------
def _path_event_count(store: PhaseStore, a: int, b: int) -> int:
    tid = store.type_id[a:b]
    ok = (store.side[a:b] == 1) & np.isfinite(store.x[a:b]) & ~is_admin(tid) & (tid != T.PRESSURE)
    return int(ok.sum())


@dataclass
class Halves:
    """Eligible phases and the index at which each is cut."""

    index: np.ndarray  # phase indices into the store
    cut: np.ndarray  # events in the first half


def eligible_halves(store: PhaseStore) -> Halves:
    idx, cuts = [], []
    for i in range(len(store)):
        a, b = int(store.start[i]), int(store.stop[i])
        n = b - a
        if n < MIN_EVENTS:
            continue
        c = (n + 1) // 2
        if (
            _path_event_count(store, a, a + c) >= MIN_HALF_PATH_EVENTS
            and _path_event_count(store, a + c, b) >= MIN_HALF_PATH_EVENTS
        ):
            idx.append(i)
            cuts.append(c)
    return Halves(np.array(idx, dtype=np.int64), np.array(cuts, dtype=np.int64))


# --------------------------------------------------------------------------
# representations
# --------------------------------------------------------------------------
def baseline_half_vectors(
    store: PhaseStore, halves: Halves, mode: B.BaselineMode
) -> tuple[np.ndarray, np.ndarray]:
    labels = B.load_phase_labels()
    stats = B.dataset_moments()
    pids = [store.phase_ids[i] for i in halves.index]
    first = [store.slice(int(i), 0, int(c)) for i, c in zip(halves.index, halves.cut)]
    second = [store.slice(int(i), int(c)) for i, c in zip(halves.index, halves.cut)]
    q, ok_q = B.vectors_for_segments(first, pids, labels, stats, mode)
    c, ok_c = B.vectors_for_segments(second, pids, labels, stats, mode)
    assert ok_q.all() and ok_c.all(), "eligibility should guarantee a path in both halves"
    return q.astype(np.float64), c.astype(np.float64)


def baseline_full_vectors(store: PhaseStore) -> np.ndarray:
    """The shipped whole-phase vectors, straight out of the artifact."""
    df = pl.read_parquet(DATA_DIR / "similarity.parquet")
    by_id = dict(zip(df["phase_id"].to_list(), df["vec"].to_list()))
    return np.array([by_id[p] for p in store.phase_ids], dtype=np.float64)


def learned_vectors(store: PhaseStore, ckpt_path: str, segments=None) -> np.ndarray:
    """Encode segments (default: every whole phase) with a trained checkpoint."""
    from .infer import embed_segments, load_checkpoint

    model, cfg = load_checkpoint(ckpt_path)
    segs = segments if segments is not None else [store.slice(i) for i in range(len(store))]
    return embed_segments(model, cfg, segs).astype(np.float64)


def learned_half_vectors(
    store: PhaseStore, halves: Halves, ckpt_path: str
) -> tuple[np.ndarray, np.ndarray]:
    first = [store.slice(int(i), 0, int(c)) for i, c in zip(halves.index, halves.cut)]
    second = [store.slice(int(i), int(c)) for i, c in zip(halves.index, halves.cut)]
    return (
        learned_vectors(store, ckpt_path, first),
        learned_vectors(store, ckpt_path, second),
    )


# --------------------------------------------------------------------------
# the whole thing
# --------------------------------------------------------------------------
def evaluate_split(split: str, ckpt: str | None = None, k: int = 25) -> dict:
    match_ids = load_splits()[split]
    store = load_store(match_ids)
    halves = eligible_halves(store)
    gold = np.arange(len(halves.index))

    out: dict = {
        "split": split,
        "matches": len(match_ids),
        "phases": len(store),
        "eligible_phases": int(len(halves.index)),
        "checkpoint": ckpt,
        "primary": {},
        "secondary": {},
    }

    for mode in (B.BaselineMode.GENEROUS, B.BaselineMode.STRICT):
        q, c = baseline_half_vectors(store, halves, mode)
        out["primary"][f"baseline_{mode.value}"] = retrieval_metrics(rank_of_gold(q, c, gold))

    y = label_matrix(store.phase_ids, [int(m) for m in store.match_ids])
    out["secondary"]["label_prevalence"] = {
        lab: float(y[:, i].mean()) for i, lab in enumerate(LABELS)
    }
    out["secondary"]["baseline"] = transfer_probe(baseline_full_vectors(store), y, k)

    if ckpt:
        q, c = learned_half_vectors(store, halves, ckpt)
        out["primary"]["learned"] = retrieval_metrics(rank_of_gold(q, c, gold))
        out["secondary"]["learned"] = transfer_probe(learned_vectors(store, ckpt), y, k)
        out["decision"] = decision(out)
    return out


def decision(res: dict) -> dict:
    """The pre-registered rule, EVAL.md §6. Three conditions, all required."""
    b = res["primary"]["baseline_generous"]
    lrn = res["primary"]["learned"]
    c1 = lrn["mrr"] >= 1.10 * b["mrr"]
    c2 = lrn["recall@1"] >= b["recall@1"]
    c3 = res["secondary"]["learned"]["macro_auc"] >= res["secondary"]["baseline"]["macro_auc"] - 0.010
    return {
        "mrr_ratio": float(lrn["mrr"] / b["mrr"]) if b["mrr"] else float("nan"),
        "condition_1_mrr_x1.10": bool(c1),
        "condition_2_recall1_no_regression": bool(c2),
        "condition_3_transfer_no_harm": bool(c3),
        "ship_learned": bool(c1 and c2 and c3),
    }


def to_markdown(res: dict) -> str:
    lines = [
        f"### {res['split']} — {res['matches']} matches, {res['phases']} phases, "
        f"{res['eligible_phases']} eligible for split-half",
        "",
        "| representation | MRR | R@1 | R@10 | median rank |",
        "|---|---:|---:|---:|---:|",
    ]
    for name, m in res["primary"].items():
        lines.append(
            f"| {name} | {m['mrr']:.4f} | {m['recall@1']:.4f} | "
            f"{m['recall@10']:.4f} | {m['median_rank']:.0f} |"
        )
    header = "| transfer probe | " + " | ".join(LABELS) + " | macro |"
    lines += ["", header, "|---" * (len(LABELS) + 2) + "|"]
    for name in ("baseline", "learned"):
        if name in res["secondary"]:
            p = res["secondary"][name]
            cells = " | ".join(f"{p['per_label_auc'][lab]:.3f}" for lab in LABELS)
            lines.append(f"| {name} | {cells} | **{p['macro_auc']:.3f}** |")
    if "decision" in res:
        d = res["decision"]
        verdict = (
            f"decision: `ship_learned = {d['ship_learned']}` "
            f"(MRR ratio {d['mrr_ratio']:.3f}, need >= 1.10)"
        )
        lines += ["", verdict]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Run the pre-registered P2 evaluation")
    ap.add_argument("--split", choices=("train", "validation", "test"), default="validation")
    ap.add_argument("--ckpt", default=None, help="checkpoint to evaluate; omit for baseline only")
    ap.add_argument("--k", type=int, default=25, help="k for the transfer probe (pre-registered 25)")
    ap.add_argument("--tag", default=None, help="name for the results file")
    args = ap.parse_args(argv)

    res = evaluate_split(args.split, args.ckpt, args.k)
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    tag = args.tag or args.split
    (RESULTS_DIR / f"{tag}.json").write_text(json.dumps(res, indent=2) + "\n")
    print(to_markdown(res))
    print(f"\nwrote {RESULTS_DIR / f'{tag}.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
