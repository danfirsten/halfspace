"""Write learned vectors into `similarity.parquet`, in the baseline's schema.

Only ever run on a win (EVAL.md §6). The web app does not know or care which
method produced the file: same schema, same L2 normalization, same
``list_dot_product`` in DuckDB.

    ./.venv/bin/python -m encoder.export --ckpt encoder/checkpoints/v1-best.pt
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import polars as pl

from halfspace_ingest.config import OUT_DIR

from .config import load_splits
from .data import load_store
from .infer import embed_segments, load_checkpoint

ZSTD = {"compression": "zstd", "compression_level": 12}

#: docs/CONTRACT.md §2 budget for similarity.parquet.
MAX_BYTES = 8 * 1024 * 1024


def encode_all(ckpt: str | Path) -> pl.DataFrame:
    """Every phase in the dataset, in `phases.parquet` order."""
    model, cfg = load_checkpoint(ckpt)
    splits = load_splits()
    match_ids = sorted(splits["train"] + splits["validation"] + splits["test"])
    store = load_store(match_ids)
    vecs = embed_segments(model, cfg, [store.slice(i) for i in range(len(store))])

    norms = np.linalg.norm(vecs, axis=1)
    assert np.allclose(norms, 1.0, atol=1e-4), "exported vectors must be L2-normalized"

    order = pl.read_parquet(OUT_DIR / "phases.parquet", columns=["phase_id"])["phase_id"].to_list()
    by_id = dict(zip(store.phase_ids, vecs))
    missing = [p for p in order if p not in by_id]
    assert not missing, f"{len(missing)} phases have no embedding, e.g. {missing[:3]}"

    return pl.DataFrame(
        {"phase_id": order, "vec": [by_id[p].tolist() for p in order]},
        schema={"phase_id": pl.Utf8, "vec": pl.List(pl.Float32)},
    )


def export(ckpt: str | Path, out: Path | None = None) -> dict:
    path = Path(out) if out else OUT_DIR / "similarity.parquet"
    df = encode_all(ckpt)
    df.write_parquet(path, **ZSTD)
    size = path.stat().st_size
    assert size <= MAX_BYTES, f"{path} is {size} bytes, over the 8 MB contract budget"
    info = {
        "path": str(path),
        "rows": df.height,
        "dims": len(df["vec"][0]),
        "bytes": size,
        "checkpoint": str(ckpt),
    }
    print(json.dumps(info, indent=2))
    return info


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Export learned phase vectors")
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--out", default=None, help="defaults to web/public/data/similarity.parquet")
    args = ap.parse_args(argv)
    export(args.ckpt, Path(args.out) if args.out else None)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
