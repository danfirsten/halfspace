"""Transfer-probe labels: football facts neither representation is given.

Every label below is read from a ``pass.*`` sub-object in the raw StatsBomb
JSON. None of these fields survives into `phase_events.parquet` — so the encoder
has never seen one — and none of them is in the baseline's 74 dimensions — so
the baseline has never seen one either. That is the entire point: EVAL.md §3
uses them to ask whether either space has learned football structure it was
never handed.

Labels are phase-level booleans over the **team in possession**, because that is
whose move the phase is.
"""

from __future__ import annotations

import json

import numpy as np

from halfspace_ingest.config import RAW_DIR
from halfspace_ingest.phases import segment

#: Label name -> plain-English meaning. Prevalences are in EVAL.md §3.
LABELS: tuple[str, ...] = ("cross", "through_ball", "high_pass", "head_pass", "aerial_won")

LABEL_DOC = {
    "cross": "the move contained a cross (pass.cross)",
    "through_ball": "the move contained a through ball (pass.through_ball)",
    "high_pass": "the move put the ball in the air (pass.height = High Pass)",
    "head_pass": "the move contained a headed pass (pass.body_part = Head)",
    "aerial_won": "a pass of ours was won in the air (pass.aerial_won)",
}


def _phase_labels(events: list[dict], team_id: int) -> dict[str, bool]:
    out = dict.fromkeys(LABELS, False)
    for e in events:
        if e["team"]["id"] != team_id:
            continue
        p = e.get("pass") or {}
        if not p:
            continue
        if p.get("cross"):
            out["cross"] = True
        if p.get("through_ball"):
            out["through_ball"] = True
        if (p.get("height") or {}).get("name") == "High Pass":
            out["high_pass"] = True
        if (p.get("body_part") or {}).get("name") == "Head":
            out["head_pass"] = True
        if p.get("aerial_won"):
            out["aerial_won"] = True
    return out


def match_labels(match_id: int) -> dict[str, dict[str, bool]]:
    """phase_id -> label dict, for one match.

    Phases are re-segmented with the pipeline's own ``segment`` so the
    ``{match_id}-{seq:04d}`` ids line up exactly with the built artifacts rather
    than approximately.
    """
    events = json.loads((RAW_DIR / "events" / f"{match_id}.json").read_text())
    events.sort(key=lambda e: e["index"])
    out = {}
    for seq, ph in enumerate(segment(match_id, events), start=1):
        out[f"{match_id}-{seq:04d}"] = _phase_labels(ph.events, ph.team_id)
    return out


def label_matrix(phase_ids: list[str], match_ids: list[int]) -> np.ndarray:
    """(n_phases, n_labels) float array aligned to ``phase_ids``."""
    table: dict[str, dict[str, bool]] = {}
    for mid in sorted(set(match_ids)):
        table.update(match_labels(mid))
    return np.array(
        [[float(table[pid][lab]) for lab in LABELS] for pid in phase_ids], dtype=np.float64
    )
