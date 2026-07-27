"""Build the Parquet artifacts the web app reads.

    raw StatsBomb JSON  ->  possession chains  ->  phases  ->  web/public/data/

Outputs (docs/CONTRACT.md §2):
    phases.parquet              one row per phase, loaded eagerly
    matches.parquet             match metadata + display labels
    similarity.parquet          L2-normalized feature vector per phase
    phase_events/{match}.parquet   per-event detail, lazy
    phase_frames/{match}.parquet   360 player dots, lazy
    manifest.json               versions, row counts, byte sizes, attribution
"""

from __future__ import annotations

import argparse
import bisect
import json
import multiprocessing as mp
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import polars as pl

from . import taxonomy as T
from .config import (
    ATTRIBUTION,
    COMPETITIONS,
    DATASET_VERSION,
    OUT_DIR,
    PATH_POINTS,
    PERIOD_OFFSET_S,
    RAW_DIR,
)
from .geometry import ZONE_INDEX
from .phases import (
    DEFAULT_THRESHOLDS,
    Thresholds,
    annotate_frames,
    build_phase_features,
    parse_ts,
    phase_event_rows,
    phase_frame_rows,
    segment,
)
from .similarity import (
    BOOL_FEATURES,
    DIM,
    NUMERIC_FEATURES,
    build_vectors,
)

ZSTD = {"compression": "zstd", "compression_level": 12}

STAGE_LABEL = {
    10: "Group Stage",
    33: "Round of 16",
    11: "Quarter-final",
    15: "Semi-final",
    26: "Final",
    25: "3rd Place Final",
}


def match_label(m: dict, comp_label: str) -> str:
    """e.g. 'Spain 2-1 England - Euro 2024 Final' (with en dash / middle dot)."""
    stage = STAGE_LABEL.get(m["competition_stage"]["id"], m["competition_stage"]["name"])
    return (
        f"{m['home_team']['home_team_name']} {m['home_score']}–{m['away_score']} "
        f"{m['away_team']['away_team_name']} · {comp_label} {stage}"
    )


def load_matches() -> list[dict]:
    rows = []
    for comp_id, season_id, comp_label in COMPETITIONS:
        raw = json.loads((RAW_DIR / "matches" / str(comp_id) / f"{season_id}.json").read_text())
        for m in raw:
            rows.append(
                {
                    "match_id": m["match_id"],
                    "competition_id": comp_id,
                    "season_id": season_id,
                    "competition": comp_label,
                    "match_date": m["match_date"],
                    "kick_off": m.get("kick_off"),
                    "stage": STAGE_LABEL.get(
                        m["competition_stage"]["id"], m["competition_stage"]["name"]
                    ),
                    "match_week": m.get("match_week"),
                    "home_team_id": m["home_team"]["home_team_id"],
                    "home_team_name": m["home_team"]["home_team_name"],
                    "away_team_id": m["away_team"]["away_team_id"],
                    "away_team_name": m["away_team"]["away_team_name"],
                    "home_score": m["home_score"],
                    "away_score": m["away_score"],
                    "stadium": (m.get("stadium") or {}).get("name"),
                    "referee": (m.get("referee") or {}).get("name"),
                    "label": match_label(m, comp_label),
                }
            )
    return sorted(rows, key=lambda r: (r["match_date"], r["match_id"]))


def build_match(args: tuple[dict, dict, bool]) -> tuple[list[dict], dict]:
    """Worker: build one match's phases and write its two lazy shards."""
    meta, thr_kwargs, write_shards = args
    thr = Thresholds(**thr_kwargs)
    match_id = meta["match_id"]

    events = json.loads((RAW_DIR / "events" / f"{match_id}.json").read_text())
    events.sort(key=lambda e: e["index"])  # index is the authoritative order (§6.1)
    frames_raw = json.loads((RAW_DIR / "three-sixty" / f"{match_id}.json").read_text())
    frames_by_uuid = {f["event_uuid"]: f for f in frames_raw}
    annotate_frames(events, frames_by_uuid)

    # Pressure timeline, used by high_press_regain to require a real press
    # rather than a lucky bounce. Absolute seconds so the lookup ignores the
    # per-period timestamp reset.
    press_t: list[float] = []
    press_team: list[int] = []
    for e in events:
        if e["type"]["id"] == T.PRESSURE and e["period"] != 5:
            press_t.append(PERIOD_OFFSET_S[e["period"]] + parse_ts(e["timestamp"]))
            press_team.append(e["team"]["id"])

    phases = segment(match_id, events)

    home, away = meta["home_team_id"], meta["away_team_id"]
    team_names = {home: meta["home_team_name"], away: meta["away_team_name"]}

    phase_rows: list[dict] = []
    ev_rows: list[dict] = []
    fr_rows: list[dict] = []
    for seq, ph in enumerate(phases, start=1):
        phase_id = f"{match_id}-{seq:04d}"
        prev = phases[seq - 2] if seq >= 2 else None

        abs_start = PERIOD_OFFSET_S[ph.period] + parse_ts(ph.events[0]["timestamp"])
        lo = bisect.bisect_left(press_t, abs_start - thr.high_press_window_s)
        hi = bisect.bisect_right(press_t, abs_start)
        pre_press = [(press_t[i], press_team[i]) for i in range(lo, hi)]

        feats = build_phase_features(ph, prev, pre_press, thr)
        opp_id = away if ph.team_id == home else home
        feats.update(
            {
                "phase_id": phase_id,
                "match_id": match_id,
                "seq": seq,
                "opponent_id": opp_id,
                "opponent_name": team_names.get(opp_id, ""),
                "competition": meta["competition"],
                "match_label": meta["label"],
            }
        )
        phase_rows.append(feats)
        ev_rows.extend(phase_event_rows(ph, phase_id, frames_by_uuid))
        fr_rows.extend(phase_frame_rows(ph, phase_id, frames_by_uuid))

    if write_shards:
        _write_shard(OUT_DIR / "phase_events" / f"{match_id}.parquet", ev_rows, EVENT_SCHEMA)
        _write_shard(OUT_DIR / "phase_frames" / f"{match_id}.parquet", fr_rows, FRAME_SCHEMA)

    stats = {
        "match_id": match_id,
        "n_events_raw": len(events),
        "n_frames_raw": len(frames_raw),
        "n_phases": len(phase_rows),
        "n_phase_events": len(ev_rows),
        "n_phase_frames": len(fr_rows),
        "n_goal_shots": sum(
            1
            for e in events
            if e["type"]["id"] == T.SHOT
            and e["period"] != 5
            and ((e.get("shot") or {}).get("outcome") or {}).get("id") == T.SHOT_GOAL
        ),
        "n_own_goals": sum(
            1 for e in events if e["type"]["id"] == T.OWN_GOAL_AGAINST and e["period"] != 5
        ),
        "orientation_counts": _orientation_counts(fr_rows),
    }
    return phase_rows, stats


def _orientation_counts(fr_rows: list[dict]) -> dict:
    out: dict[str, int] = {}
    for r in fr_rows:
        out[r["orientation"]] = out.get(r["orientation"], 0) + 1
    return out


EVENT_SCHEMA = {
    "phase_id": pl.Utf8,
    "idx": pl.Int16,
    "event_uuid": pl.Utf8,
    "event_index": pl.Int32,
    "t_offset_s": pl.Float32,
    "type_id": pl.Int16,
    "type_name": pl.Categorical,
    "player_name": pl.Utf8,
    "position_name": pl.Categorical,
    "team_side": pl.Categorical,
    "team_name": pl.Categorical,
    "x": pl.Float32,
    "y": pl.Float32,
    "end_x": pl.Float32,
    "end_y": pl.Float32,
    "end_z": pl.Float32,
    "outcome_name": pl.Categorical,
    "under_pressure": pl.Boolean,
    "counterpress": pl.Boolean,
    "out": pl.Boolean,
    "xg": pl.Float32,
    "has_frame": pl.Boolean,
}

FRAME_SCHEMA = {
    "phase_id": pl.Utf8,
    "idx": pl.Int16,
    "event_uuid": pl.Utf8,
    "orientation": pl.Categorical,
    "n_players": pl.Int16,
    "px": pl.List(pl.Float32),
    "py": pl.List(pl.Float32),
    "flags": pl.List(pl.UInt8),
    "visible_area": pl.List(pl.Float32),
}


def _write_shard(path: Path, rows: list[dict], schema: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    df = pl.DataFrame(rows, schema=schema) if rows else pl.DataFrame(schema=schema)
    df.write_parquet(path, **ZSTD)


PHASE_SCHEMA = {
    "phase_id": pl.Utf8,
    "match_id": pl.Int64,
    "seq": pl.Int16,
    "competition": pl.Categorical,
    "match_label": pl.Categorical,
    "team_id": pl.Int32,
    "team_name": pl.Categorical,
    "opponent_id": pl.Int32,
    "opponent_name": pl.Categorical,
    "period": pl.Int8,
    "possession": pl.Int16,
    "minute": pl.Int16,
    "second": pl.Int8,
    "start_ts": pl.Float32,
    "end_ts": pl.Float32,
    "abs_start_s": pl.Float32,
    "duration_s": pl.Float32,
    "n_events": pl.Int16,
    "n_passes": pl.Int16,
    "n_players": pl.Int8,
    "n_shots": pl.Int8,
    "start_zone": pl.Categorical,
    "end_zone": pl.Categorical,
    "start_x": pl.Float32,
    "start_y": pl.Float32,
    "end_x": pl.Float32,
    "end_y": pl.Float32,
    "max_x": pl.Float32,
    "start_type": pl.Categorical,
    "outcome": pl.Categorical,
    "progression_m": pl.Float32,
    "direct_speed_m_s": pl.Float32,
    "pressure_events": pl.Int16,
    "high_press_regain": pl.Boolean,
    "counterattack": pl.Boolean,
    "switch_of_play": pl.Boolean,
    "reached_final_third": pl.Boolean,
    "reached_box": pl.Boolean,
    "xg": pl.Float32,
    "goal_conceded": pl.Boolean,
    "has_360": pl.Boolean,
    "frame_coverage": pl.Float32,
    "path_xy": pl.List(pl.Float32),
}


def build_phases_frame(rows: list[dict]) -> pl.DataFrame:
    keep = {k: v for k, v in PHASE_SCHEMA.items()}
    trimmed = [{k: r[k] for k in keep} for r in rows]
    return pl.DataFrame(trimmed, schema=keep).sort(["match_id", "seq"])


def build_similarity(df: pl.DataFrame) -> pl.DataFrame:
    numeric = df.select(list(NUMERIC_FEATURES)).to_numpy().astype(np.float64)
    booleans = df.select(list(BOOL_FEATURES)).to_numpy()
    st_idx = np.array([T.START_TYPES.index(s) for s in df["start_type"].to_list()])
    oc_idx = np.array([T.OUTCOMES.index(s) for s in df["outcome"].to_list()])
    sz_idx = np.array([ZONE_INDEX[s] for s in df["start_zone"].to_list()])
    ez_idx = np.array([ZONE_INDEX[s] for s in df["end_zone"].to_list()])
    path = np.array(df["path_xy"].to_list(), dtype=np.float64)

    vecs = build_vectors(numeric, booleans, st_idx, oc_idx, sz_idx, ez_idx, path)
    return pl.DataFrame(
        {"phase_id": df["phase_id"], "vec": vecs.tolist()},
        schema={"phase_id": pl.Utf8, "vec": pl.List(pl.Float32)},
    )


def _dir_bytes(path: Path) -> int:
    return sum(p.stat().st_size for p in path.rglob("*.parquet"))


def run(workers: int = 4, thresholds: Thresholds = DEFAULT_THRESHOLDS, limit: int | None = None):
    t0 = time.time()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for sub in ("phase_events", "phase_frames"):
        shutil.rmtree(OUT_DIR / sub, ignore_errors=True)

    matches = load_matches()
    if limit:
        matches = matches[:limit]
    print(f"building {len(matches)} matches with {workers} workers", flush=True)

    thr_kwargs = thresholds.__dict__
    jobs = [(m, thr_kwargs, True) for m in matches]
    all_rows: list[dict] = []
    stats: list[dict] = []
    # "spawn": polars holds a thread pool, and fork() plus threads is how you
    # get a build that hangs once a fortnight.
    with mp.get_context("spawn").Pool(workers) as pool:
        for i, (rows, st) in enumerate(pool.imap_unordered(build_match, jobs), start=1):
            all_rows.extend(rows)
            stats.append(st)
            if i % 20 == 0 or i == len(matches):
                print(f"  {i}/{len(matches)} matches, {len(all_rows)} phases", flush=True)

    df = build_phases_frame(all_rows)
    df.write_parquet(OUT_DIR / "phases.parquet", **ZSTD)

    mdf = pl.DataFrame(matches)
    mdf.write_parquet(OUT_DIR / "matches.parquet", **ZSTD)

    sim = build_similarity(df)
    sim.write_parquet(OUT_DIR / "similarity.parquet", **ZSTD)

    elapsed = round(time.time() - t0, 1)
    orient: dict[str, int] = {}
    for s in stats:
        for k, v in s["orientation_counts"].items():
            orient[k] = orient.get(k, 0) + v

    manifest = {
        "dataset_version": DATASET_VERSION,
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "build_seconds": elapsed,
        "attribution": ATTRIBUTION,
        "competitions": [
            {"competition_id": c, "season_id": s, "label": lab} for c, s, lab in COMPETITIONS
        ],
        "coordinate_frame": {
            "pitch": [120, 80],
            "note": "All coordinates are in the phase's possession team's attacking frame "
            "(that team attacks x=0 -> x=120). The web app never flips coordinates.",
        },
        "path_xy": {
            "points": PATH_POINTS,
            "layout": "flat [x0,y0,x1,y1,...] of 2*points float32, arc-length resampled",
        },
        "similarity": {"dims": DIM, "normalized": "l2"},
        "counts": {
            "matches": len(matches),
            "phases": df.height,
            "phase_events": sum(s["n_phase_events"] for s in stats),
            "phase_frames": sum(s["n_phase_frames"] for s in stats),
            "raw_events": sum(s["n_events_raw"] for s in stats),
            "raw_360_frames": sum(s["n_frames_raw"] for s in stats),
            "goal_shots_non_shootout": sum(s["n_goal_shots"] for s in stats),
            "own_goals_non_shootout": sum(s["n_own_goals"] for s in stats),
        },
        "frame_orientation": orient,
        "files": {},
        "shards": {
            "phase_events": "phase_events/{match_id}.parquet",
            "phase_frames": "phase_frames/{match_id}.parquet",
            "match_ids": [m["match_id"] for m in matches],
        },
    }
    for name in ("phases.parquet", "matches.parquet", "similarity.parquet"):
        manifest["files"][name] = (OUT_DIR / name).stat().st_size
    manifest["files"]["phase_events/"] = _dir_bytes(OUT_DIR / "phase_events")
    manifest["files"]["phase_frames/"] = _dir_bytes(OUT_DIR / "phase_frames")

    (OUT_DIR / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest["counts"], indent=2))
    print(json.dumps(manifest["files"], indent=2))
    print(f"orientation: {orient}")
    print(f"built in {elapsed}s -> {OUT_DIR}")
    return manifest


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Build Halfspace phase artifacts")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--limit", type=int, default=None, help="only build the first N matches")
    args = ap.parse_args(argv)
    run(workers=args.workers, limit=args.limit)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
