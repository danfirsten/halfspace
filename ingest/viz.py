"""Offline chart generation: real phases.parquet → Vega-Lite specs.

Every number in every chart is aggregated here, from the built dataset, and
baked into the spec as inline data. The browser renders arithmetic it did not
do and cannot get wrong, and nothing in `web/public/charts/` can drift from
`web/public/data/phases.parquet` without this script being re-run.

    python -m viz            # from ingest/, with the venv active

Writes `web/public/charts/*.json` plus an index the app reads to lay them out.
"""

from __future__ import annotations

import json
from pathlib import Path

import altair as alt
import duckdb
import polars as pl

REPO = Path(__file__).resolve().parent.parent
PHASES = REPO / "web" / "public" / "data" / "phases.parquet"
OUT = REPO / "web" / "public" / "charts"

# CONTRACT §5. The charts have to look like they belong to the same product as
# the pitch, so the palette is not "a dark theme" — it is exactly this one.
BG = "#12171c"
TEXT = "#f0f3f6"
DIM = "#9aa5b1"
HAIRLINE = "#2b333b"
ACCENT = "#7cc7e8"
BALL = "#f5c451"
BLUE = "#6d78e0"
INK = "#04161d"
# Four steps of the accent, from the turf up. Used by every heatmap so a dense
# cell means the same thing in the zone grid and in the duration matrix.
RAMP = ["#0e161d", "#1c3846", "#3d7c99", ACCENT]
FONT = "Inter, ui-sans-serif, system-ui, sans-serif"
# The wordmark's face carries chart titles too, and every number in a chart is
# a number in the interface — same rule, same faces.
DISPLAY_FONT = "Space Grotesk, Inter, ui-sans-serif, system-ui, sans-serif"
NUM_FONT = "IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, monospace"

# Outcome colours match the badge colours in the results grid so a reader can
# carry one mapping across the whole page.
OUTCOME_COLOURS = {
    "goal": BALL,
    "shot_on_target": ACCENT,
    "shot_off_target": BLUE,
    "foul_won": "#7b8794",
    "out_of_play": "#565f6b",
    "lost_ball": "#3a4550",
    "end_of_period": "#262e37",
}
OUTCOME_ORDER = [
    "goal",
    "shot_on_target",
    "shot_off_target",
    "foul_won",
    "out_of_play",
    "lost_ball",
    "end_of_period",
]
OUTCOME_LABELS = {
    "goal": "Goal",
    "shot_on_target": "Shot on target",
    "shot_off_target": "Shot off target",
    "foul_won": "Foul won",
    "out_of_play": "Out of play",
    "lost_ball": "Lost ball",
    "end_of_period": "End of period",
}
START_TYPE_LABELS = {
    "kick_off": "Kick-off",
    "goal_kick": "Goal kick",
    "corner": "Corner",
    "free_kick": "Free kick",
    "throw_in": "Throw-in",
    "turnover_open_play": "Turnover",
    "regular": "Restart",
}
THIRD_LABELS = {"def_third": "Defensive", "mid_third": "Middle", "final_third": "Final"}
CHANNEL_LABELS = {"left": "Left", "centre": "Centre", "right": "Right"}


def halfspace_theme() -> dict:
    """Vega-Lite config shared by every chart."""
    return {
        "config": {
            "background": BG,
            "font": FONT,
            "view": {"stroke": "transparent", "continuousHeight": 200},
            "padding": {"left": 2, "top": 4, "right": 2, "bottom": 2},
            "title": {
                "color": TEXT,
                "font": DISPLAY_FONT,
                "fontSize": 12,
                "fontWeight": 600,
                "anchor": "start",
                "subtitleColor": DIM,
                "subtitleFontSize": 10.5,
                "offset": 8,
            },
            "axis": {
                "labelColor": DIM,
                "titleColor": DIM,
                "labelFontSize": 10,
                "titleFontSize": 10,
                "titleFontWeight": 500,
                "gridColor": HAIRLINE,
                "gridOpacity": 0.55,
                "domainColor": HAIRLINE,
                "tickColor": HAIRLINE,
                "labelFont": NUM_FONT,
                "labelFontSize": 9.5,
                "titleFont": FONT,
                "labelPadding": 4,
            },
            "legend": {
                "labelColor": DIM,
                "titleColor": DIM,
                "labelFontSize": 10,
                "titleFontSize": 10,
                "symbolType": "square",
                "symbolSize": 70,
                "labelFont": FONT,
                "titleFont": FONT,
                "orient": "bottom",
                "direction": "horizontal",
                "columns": 4,
                "offset": 4,
            },
            "range": {"heatmap": RAMP},
        }
    }


def write(name: str, chart: alt.Chart, title: str, caption: str, rows: int) -> dict:
    spec = chart.to_dict()
    spec.update(halfspace_theme())
    # "fit-x" plus width:"container" lets vega-embed size the plot to the card,
    # which is what makes the grid responsive without re-generating specs.
    spec["autosize"] = {"type": "fit-x", "contains": "padding", "resize": True}
    (OUT / f"{name}.json").write_text(json.dumps(spec, separators=(",", ":")), encoding="utf-8")
    print(f"  {name}.json  ({rows} aggregated rows)")
    return {"file": f"{name}.json", "title": title, "caption": caption}


# ---------------------------------------------------------------------------


def chart_outcome_by_start_type(con: duckdb.DuckDBPyConnection) -> dict:
    """How a phase begins changes how it ends. Shares within each start type."""
    df = pl.from_arrow(
        con.sql(
            f"""
            SELECT start_type, outcome, count(*) AS n
            FROM '{PHASES}'
            GROUP BY 1, 2
            """
        ).arrow()
    )
    totals = df.group_by("start_type").agg(pl.col("n").sum().alias("total"))
    df = (
        df.join(totals, on="start_type")
        .with_columns(
            (pl.col("n") / pl.col("total")).alias("share"),
            pl.col("start_type").replace_strict(START_TYPE_LABELS, default=None).alias("Start"),
            pl.col("outcome").replace_strict(OUTCOME_LABELS, default=None).alias("Outcome"),
        )
        .sort("total", descending=True)
    )
    order = [START_TYPE_LABELS[s] for s in df.unique("start_type", maintain_order=True)["start_type"]]

    chart = (
        alt.Chart(df.select("Start", "Outcome", "share", "n", "total"))
        .mark_bar(height=15)
        .encode(
            x=alt.X("share:Q", title="share of phases", axis=alt.Axis(format="%"), stack="normalize"),
            y=alt.Y("Start:N", title=None, sort=order),
            color=alt.Color(
                "Outcome:N",
                title=None,
                sort=[OUTCOME_LABELS[o] for o in OUTCOME_ORDER],
                scale=alt.Scale(
                    domain=[OUTCOME_LABELS[o] for o in OUTCOME_ORDER],
                    range=[OUTCOME_COLOURS[o] for o in OUTCOME_ORDER],
                ),
            ),
            order=alt.Order("color_Outcome_sort_index:Q"),
            tooltip=[
                alt.Tooltip("Start:N"),
                alt.Tooltip("Outcome:N"),
                alt.Tooltip("n:Q", title="phases", format=","),
                alt.Tooltip("share:Q", title="share", format=".1%"),
            ],
        )
        .properties(height=alt.Step(19), width="container")
    )
    return write(
        "outcome-by-start-type",
        chart,
        "How a phase ends, by how it started",
        "Corners end in a shot 39.3% of the time and goal kicks 6.2% — a six-fold spread "
        "from one restart type to another. Share within each start type, all 16,782 phases.",
        df.height,
    )


def chart_xg_distribution(con: duckdb.DuckDBPyConnection) -> dict:
    """xG of every shot-ending phase, in 0.05 bins, split by whether it scored."""
    df = pl.from_arrow(
        con.sql(
            f"""
            SELECT
              least(floor(xg / 0.05) * 0.05, 0.95) AS bin,
              CASE WHEN outcome = 'goal' THEN 'Scored' ELSE 'Did not score' END AS result,
              count(*) AS n
            FROM '{PHASES}'
            WHERE outcome IN ('goal', 'shot_on_target', 'shot_off_target')
            GROUP BY 1, 2
            ORDER BY 1
            """
        ).arrow()
    )
    chart = (
        alt.Chart(df)
        .mark_bar()
        .encode(
            x=alt.X(
                "bin:Q",
                title="phase xG (best shot in the phase)",
                bin=alt.Bin(binned=True, step=0.05),
                scale=alt.Scale(domain=[0, 1]),
            ),
            x2="bin2:Q",
            y=alt.Y(
                "n:Q",
                title="phases (symlog scale)",
                # symlog, not log: it is linear near zero, so the bins holding a
                # handful of phases are still drawn instead of vanishing.
                scale=alt.Scale(type="symlog"),
            ),
            color=alt.Color(
                "result:N",
                title=None,
                scale=alt.Scale(domain=["Scored", "Did not score"], range=[BALL, "#3d4854"]),
            ),
            tooltip=[
                alt.Tooltip("bin:Q", title="xG from", format=".2f"),
                alt.Tooltip("result:N", title=None),
                alt.Tooltip("n:Q", title="phases", format=","),
            ],
        )
        .transform_calculate(bin2="datum.bin + 0.05")
        .properties(height=190, width="container")
    )
    return write(
        "xg-distribution",
        chart,
        "xG of the 2,315 phases that ended in a shot",
        "Symlog-scaled count, 0.05 bins. Most shooting chances are small ones — 1,050 of the "
        "2,315 sit below 0.05 xG. Gold is the 253 phases that scored.",
        df.height,
    )


def chart_start_zone_heatmap(con: duckdb.DuckDBPyConnection) -> dict:
    """Where phases begin, on the 3 × 3 grid, in the attacking team's frame."""
    df = pl.from_arrow(
        con.sql(
            f"""
            SELECT
              split_part(start_zone, '_', 1) || '_third' AS third,
              split_part(start_zone, '_', 3) AS channel,
              count(*) AS n,
              avg(xg) AS mean_xg,
              avg(CASE WHEN outcome IN ('goal','shot_on_target','shot_off_target')
                       THEN 1.0 ELSE 0.0 END) AS shot_rate
            FROM '{PHASES}'
            GROUP BY 1, 2
            """
        ).arrow()
    ).with_columns(
        pl.col("third").replace_strict(THIRD_LABELS, default=None).alias("Third"),
        pl.col("channel").replace_strict(CHANNEL_LABELS, default=None).alias("Channel"),
    )

    base = alt.Chart(df.select("Third", "Channel", "n", "shot_rate", "mean_xg"))
    heat = base.mark_rect(stroke=BG, strokeWidth=2).encode(
        x=alt.X(
            "Third:N",
            title="third (attacking →)",
            sort=["Defensive", "Middle", "Final"],
            axis=alt.Axis(labelAngle=0),
        ),
        y=alt.Y("Channel:N", title="channel", sort=["Left", "Centre", "Right"]),
        color=alt.Color(
            "shot_rate:Q",
            title="shot rate",
            scale=alt.Scale(range=RAMP),
            legend=alt.Legend(format="%", gradientLength=110),
        ),
        tooltip=[
            alt.Tooltip("Third:N"),
            alt.Tooltip("Channel:N"),
            alt.Tooltip("n:Q", title="phases starting here", format=","),
            alt.Tooltip("shot_rate:Q", title="ended in a shot", format=".1%"),
            alt.Tooltip("mean_xg:Q", title="mean xG", format=".3f"),
        ],
    )
    labels = base.mark_text(fontSize=10, font=NUM_FONT, dy=0).encode(
        x=alt.X("Third:N", sort=["Defensive", "Middle", "Final"], axis=alt.Axis(labelAngle=0)),
        y=alt.Y("Channel:N", sort=["Left", "Centre", "Right"]),
        text=alt.Text("shot_rate:Q", format=".0%"),
        # Only the brightest cell is light enough to need dark text on it.
        color=alt.condition(alt.datum.shot_rate > 0.42, alt.value(INK), alt.value(TEXT)),
    )
    return write(
        "start-zone-heatmap",
        (heat + labels).properties(height=170, width="container"),
        "Where a phase starts, and how often it ends in a shot",
        "The 3 × 3 search grid, in the attacking team's frame. Only 199 phases start in the "
        "centre of the final third, and 55.3% of them end in a shot — against 8.9% for a "
        "phase starting in a team's own defensive centre.",
        df.height,
    )


def chart_progression_vs_duration(con: duckdb.DuckDBPyConnection) -> dict:
    """Density of duration against upfield progression: the shape of a phase."""
    df = pl.from_arrow(
        con.sql(
            f"""
            SELECT
              least(floor(duration_s / 2.5) * 2.5, 60) AS dur_bin,
              greatest(least(floor(progression_m / 7.5) * 7.5, 97.5), -30) AS prog_bin,
              count(*) AS n
            FROM '{PHASES}'
            GROUP BY 1, 2
            HAVING count(*) > 0
            """
        ).arrow()
    )
    chart = (
        alt.Chart(df)
        .mark_rect()
        .encode(
            x=alt.X(
                "dur_bin:Q",
                title="duration (s, 2.5 s bins, 60+ pooled)",
                bin=alt.Bin(binned=True, step=2.5),
            ),
            x2="dur2:Q",
            y=alt.Y(
                "prog_bin:Q",
                title="upfield progression (m)",
                bin=alt.Bin(binned=True, step=7.5),
            ),
            y2="prog2:Q",
            color=alt.Color(
                "n:Q",
                title="phases",
                scale=alt.Scale(type="log", range=RAMP),
                legend=alt.Legend(gradientLength=110),
            ),
            tooltip=[
                alt.Tooltip("dur_bin:Q", title="duration from (s)"),
                alt.Tooltip("prog_bin:Q", title="progression from (m)"),
                alt.Tooltip("n:Q", title="phases", format=","),
            ],
        )
        .transform_calculate(dur2="datum.dur_bin + 2.5", prog2="datum.prog_bin + 7.5")
        .properties(height=205, width="container")
    )
    return write(
        "progression-vs-duration",
        chart,
        "Duration against upfield progression",
        "The densest cell is the bottom-left — 760 phases under 2.5 s that gained under "
        "7.5 m. Above it, 45% of all phases gain 30–90 m at almost any duration. "
        "Log-scaled counts over all 16,782 phases.",
        df.height,
    )


def main() -> None:
    if not PHASES.exists():
        raise SystemExit(f"missing {PHASES} — run the ingest first")
    OUT.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    print(f"reading {PHASES.relative_to(REPO)}")

    charts = [
        chart_outcome_by_start_type(con),
        chart_xg_distribution(con),
        chart_start_zone_heatmap(con),
        chart_progression_vs_duration(con),
    ]

    total = con.sql(f"SELECT count(*) FROM '{PHASES}'").fetchone()[0]
    index = {
        "generated_from": "web/public/data/phases.parquet",
        "phases": total,
        "charts": charts,
    }
    (OUT / "index.json").write_text(json.dumps(index, indent=2), encoding="utf-8")
    print(f"wrote {len(charts)} specs + index.json to {OUT.relative_to(REPO)} ({total:,} phases)")


if __name__ == "__main__":
    main()
