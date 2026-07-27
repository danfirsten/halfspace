"""Measure the distributions the feature thresholds are chosen from.

Nothing here is used at build time. It exists so that every number in
docs/phase-definitions.md can be reproduced, and so that a reader who disagrees
with a cut-off can see exactly what the data looked like when it was picked.

Run:  python -m scripts.calibrate        (from ingest/, after a build)
"""

from __future__ import annotations

import json
import os
import statistics

import duckdb

from halfspace_ingest import taxonomy as T
from halfspace_ingest.config import OUT_DIR, RAW_DIR
from halfspace_ingest.phases import segment

PH = str(OUT_DIR / "phases.parquet")


def pct(xs: list[float], p: float) -> float:
    if not xs:
        return float("nan")
    xs = sorted(xs)
    k = min(int(round(p / 100 * (len(xs) - 1))), len(xs) - 1)
    return xs[k]


def show(title: str, sql: str) -> None:
    print(f"\n--- {title} ---")
    r = duckdb.execute(sql)
    print(" | ".join(d[0] for d in r.description))
    for row in r.fetchall():
        print(" | ".join(str(v) for v in row))


def switch_calibration() -> None:
    """How far across the pitch does a StatsBomb-flagged switch actually travel?"""
    flagged: list[float] = []
    unflagged: list[float] = []
    mids = sorted(int(p.split(".")[0]) for p in os.listdir(RAW_DIR / "events"))[:20]
    for mid in mids:
        for e in json.loads((RAW_DIR / "events" / f"{mid}.json").read_text()):
            if e["type"]["id"] != T.PASS or e["period"] == 5:
                continue
            p = e.get("pass") or {}
            el = p.get("end_location")
            if not el or not e.get("location"):
                continue
            dy = abs(float(el[1]) - float(e["location"][1]))
            (flagged if p.get("switch") else unflagged).append(dy)

    print("\n--- pass.switch: lateral distance |dy| in yards (20 matches) ---")
    print(f"passes flagged switch   n={len(flagged):6d}  "
          f"min={min(flagged):.1f} p5={pct(flagged,5):.1f} p50={pct(flagged,50):.1f} "
          f"p95={pct(flagged,95):.1f} max={max(flagged):.1f}")
    print(f"passes not flagged      n={len(unflagged):6d}  "
          f"p50={pct(unflagged,50):.1f} p95={pct(unflagged,95):.1f} "
          f"p99={pct(unflagged,99):.1f} max={max(unflagged):.1f}")
    for thr in (30, 35, 40, 45):
        extra = sum(1 for d in unflagged if d >= thr)
        missed = sum(1 for d in flagged if d < thr)
        print(f"  threshold {thr} yd: {extra:5d} unflagged passes would qualify, "
              f"{missed:4d}/{len(flagged)} flagged switches fall below it")


def counter_calibration() -> None:
    """What do StatsBomb's own `From Counter` possessions look like?"""
    counters: dict[str, list[float]] = {"speed": [], "prog": [], "dur": []}
    others: dict[str, list[float]] = {"speed": [], "prog": [], "dur": []}
    # play_pattern is not published, so re-derive From Counter from raw events.
    mids = sorted(int(p.split(".")[0]) for p in os.listdir(RAW_DIR / "events"))[:30]
    for mid in mids:
        ev = json.loads((RAW_DIR / "events" / f"{mid}.json").read_text())
        ev.sort(key=lambda e: e["index"])
        for ph in segment(mid, ev):
            from halfspace_ingest.phases import ball_path, parse_ts

            path = ball_path(ph)
            if len(path) < 2:
                continue
            ball = [e for e in ph.events if e["type"]["id"] not in T.ADMIN_TYPES] or ph.events
            dur = max(
                parse_ts(e["timestamp"]) + (e.get("duration") or 0.0) for e in ball
            ) - parse_ts(ph.events[0]["timestamp"])
            prog = path[-1][0] - path[0][0]
            speed = prog / dur if dur > 0.05 else 0.0
            bucket = counters if ph.play_pattern_id == T.PP_COUNTER else others
            bucket["speed"].append(speed)
            bucket["prog"].append(prog)
            bucket["dur"].append(dur)

    print("\n--- StatsBomb 'From Counter' possessions (30 matches) ---")
    for name in ("speed", "prog", "dur"):
        c, o = counters[name], others[name]
        print(f"{name:6s} counter: n={len(c):5d} p10={pct(c,10):6.2f} p25={pct(c,25):6.2f} "
              f"p50={pct(c,50):6.2f} p75={pct(c,75):6.2f}")
        print(f"{'':6s} other  : n={len(o):5d} p50={pct(o,50):6.2f} p90={pct(o,90):6.2f} "
              f"p99={pct(o,99):6.2f}")
    print(f"share of all possessions tagged From Counter: "
          f"{100*len(counters['speed'])/(len(counters['speed'])+len(others['speed'])):.2f}%")
    print(f"mean upfield speed, counters {statistics.mean(counters['speed']):.2f} vs "
          f"others {statistics.mean(others['speed']):.2f} yd/s")


def high_press_calibration() -> None:
    show(
        "regain x for open-play turnover phases (deciles)",
        f"""select round(quantile_cont(start_x,0.10),1) p10, round(quantile_cont(start_x,0.25),1) p25,
                   round(quantile_cont(start_x,0.50),1) p50, round(quantile_cont(start_x,0.75),1) p75,
                   round(quantile_cont(start_x,0.90),1) p90, round(quantile_cont(start_x,0.95),1) p95,
                   count(*) n
            from '{PH}' where start_type='turnover_open_play'""",
    )
    show(
        "how many turnover phases start in each third",
        f"""select case when start_x >= 80 then 'final third (x>=80)'
                        when start_x >= 40 then 'middle third'
                        else 'own third' end band,
                   count(*) n,
                   round(100.0*count(*)/sum(count(*)) over (), 1) pct
            from '{PH}' where start_type='turnover_open_play' group by 1 order by n desc""",
    )
    show(
        "value of a high regain: outcome mix by regain band",
        f"""select case when start_x >= 80 then 'final third' else 'rest' end band,
                   count(*) n,
                   round(100.0*count(*) filter (where outcome in ('goal','shot_on_target','shot_off_target'))/count(*),1) shot_pct,
                   round(avg(xg),4) mean_xg
            from '{PH}' where start_type='turnover_open_play' group by 1""",
    )


def main() -> None:
    switch_calibration()
    counter_calibration()
    high_press_calibration()
    show("phase count / flags", f"""
        select count(*) phases,
               sum(high_press_regain::int) high_press_regain,
               sum(counterattack::int) counterattack,
               sum(switch_of_play::int) switch_of_play,
               sum(reached_box::int) reached_box
        from '{PH}'""")


if __name__ == "__main__":
    main()
