"""Validation suite: invariants asserted against the REAL built artifacts.

These tests read `web/public/data/` with DuckDB, exactly as the browser will.
They are the ones that catch a bad build; the other test modules only prove the
functions behave on fixtures. Run a build first -- they skip if there isn't one.
"""

from __future__ import annotations

import json
import os

import duckdb
import pytest

from halfspace_ingest import taxonomy as T
from halfspace_ingest.config import MIN_360_BYTES, OUT_DIR, PATH_POINTS, RAW_DIR, YARD_M
from halfspace_ingest.geometry import ZONES
from halfspace_ingest.similarity import DIM

PHASES = str(OUT_DIR / "phases.parquet")
MATCHES = str(OUT_DIR / "matches.parquet")
SIM = str(OUT_DIR / "similarity.parquet")
EVENTS_GLOB = str(OUT_DIR / "phase_events" / "*.parquet")
FRAMES_GLOB = str(OUT_DIR / "phase_frames" / "*.parquet")

pytestmark = pytest.mark.skipif(
    not (OUT_DIR / "phases.parquet").exists(),
    reason="no build present; run `python -m halfspace_ingest.build` first",
)


@pytest.fixture(scope="module")
def con():
    c = duckdb.connect()
    yield c
    c.close()


def scalar(con, sql: str):
    return con.execute(sql).fetchone()[0]


@pytest.fixture(scope="module")
def manifest():
    return json.loads((OUT_DIR / "manifest.json").read_text())


# --- budgets --------------------------------------------------------------


def test_eager_files_are_within_the_contract_budgets():
    assert (OUT_DIR / "phases.parquet").stat().st_size < 6 * 1024 * 1024
    assert (OUT_DIR / "similarity.parquet").stat().st_size < 8 * 1024 * 1024


# --- identity and referential integrity -----------------------------------


def test_phase_ids_are_unique(con):
    assert scalar(con, f"select count(*) - count(distinct phase_id) from '{PHASES}'") == 0


def test_phase_id_encodes_match_and_sequence(con):
    bad = scalar(
        con,
        f"select count(*) from '{PHASES}' "
        f"where phase_id <> match_id || '-' || lpad(seq::varchar, 4, '0')",
    )
    assert bad == 0


def test_every_phase_belongs_to_a_known_match(con):
    orphans = scalar(
        con,
        f"select count(*) from '{PHASES}' p "
        f"left join '{MATCHES}' m using (match_id) where m.match_id is null",
    )
    assert orphans == 0


def test_every_match_produced_phases(con):
    empty = scalar(
        con,
        f"select count(*) from '{MATCHES}' m "
        f"where not exists (select 1 from '{PHASES}' p where p.match_id = m.match_id)",
    )
    assert empty == 0


def test_phase_team_is_one_of_the_two_teams_in_the_match(con):
    bad = scalar(
        con,
        f"""select count(*) from '{PHASES}' p join '{MATCHES}' m using (match_id)
            where p.team_id not in (m.home_team_id, m.away_team_id)
               or p.opponent_id not in (m.home_team_id, m.away_team_id)
               or p.team_id = p.opponent_id""",
    )
    assert bad == 0


def test_every_phase_event_row_resolves_to_a_phase(con):
    orphans = scalar(
        con,
        f"select count(*) from '{EVENTS_GLOB}' e "
        f"anti join '{PHASES}' p on e.phase_id = p.phase_id",
    )
    assert orphans == 0


def test_every_frame_row_resolves_to_a_phase_event(con):
    orphans = scalar(
        con,
        f"""select count(*) from '{FRAMES_GLOB}' f
            anti join '{EVENTS_GLOB}' e
              on f.phase_id = e.phase_id and f.idx = e.idx and f.event_uuid = e.event_uuid""",
    )
    assert orphans == 0


def test_frame_rows_only_exist_where_the_event_claims_a_frame(con):
    mismatch = scalar(
        con,
        f"""select count(*) from '{EVENTS_GLOB}' e
            join '{FRAMES_GLOB}' f on e.phase_id = f.phase_id and e.idx = f.idx
            where not e.has_frame""",
    )
    assert mismatch == 0


def test_similarity_covers_every_phase_exactly_once(con):
    assert scalar(con, f"select count(*) from '{SIM}'") == scalar(
        con, f"select count(*) from '{PHASES}'"
    )
    assert (
        scalar(
            con,
            f"select count(*) from '{PHASES}' p anti join '{SIM}' s on p.phase_id = s.phase_id",
        )
        == 0
    )


# --- numeric sanity -------------------------------------------------------


def test_no_nulls_in_required_columns(con):
    cols = [
        "phase_id", "match_id", "team_id", "opponent_id", "period", "possession",
        "duration_s", "n_events", "n_passes", "start_zone", "end_zone",
        "start_type", "outcome", "progression_m", "direct_speed_m_s", "xg",
        "frame_coverage", "path_xy", "match_label", "competition",
    ]
    checks = " + ".join(f"count(*) filter (where {c} is null)" for c in cols)
    assert scalar(con, f"select {checks} from '{PHASES}'") == 0


def test_no_nan_or_negative_durations(con):
    assert scalar(con, f"select count(*) from '{PHASES}' where duration_s < 0") == 0
    assert scalar(con, f"select count(*) from '{PHASES}' where isnan(duration_s)") == 0
    assert scalar(con, f"select count(*) from '{PHASES}' where end_ts < start_ts") == 0


def test_no_nan_anywhere_in_the_float_columns(con):
    floats = [
        "start_ts", "end_ts", "abs_start_s", "duration_s", "start_x", "start_y",
        "end_x", "end_y", "max_x", "progression_m", "direct_speed_m_s", "xg",
        "frame_coverage",
    ]
    checks = " + ".join(f"count(*) filter (where isnan({c}))" for c in floats)
    assert scalar(con, f"select {checks} from '{PHASES}'") == 0


def test_counts_are_non_negative_and_consistent(con):
    assert scalar(
        con,
        f"""select count(*) from '{PHASES}'
            where n_events < 1 or n_passes < 0 or n_players < 0
               or n_passes > n_events or pressure_events > n_events""",
    ) == 0


def test_frame_coverage_is_a_fraction(con):
    assert scalar(
        con, f"select count(*) from '{PHASES}' where frame_coverage < 0 or frame_coverage > 1"
    ) == 0


def test_has_360_agrees_with_frame_coverage(con):
    assert scalar(
        con,
        f"select count(*) from '{PHASES}' where has_360 <> (frame_coverage > 0)",
    ) == 0


def test_frame_coverage_matches_the_event_shards(con):
    """Recompute coverage from phase_events and compare with the stored value."""
    worst = scalar(
        con,
        f"""with c as (
              select phase_id, avg(has_frame::int) cov from '{EVENTS_GLOB}' group by 1
            )
            select max(abs(c.cov - p.frame_coverage))
            from c join '{PHASES}' p using (phase_id)""",
    )
    assert worst < 1e-6


def test_xg_is_a_probability(con):
    assert scalar(con, f"select count(*) from '{PHASES}' where xg < 0 or xg > 1") == 0


def test_xg_is_zero_exactly_when_there_are_no_shots(con):
    assert scalar(
        con, f"select count(*) from '{PHASES}' where (n_shots = 0) <> (xg = 0)"
    ) == 0


def test_period_5_never_appears(con):
    assert scalar(con, f"select count(*) from '{PHASES}' where period = 5") == 0
    assert scalar(con, f"select count(*) from '{PHASES}' where period not between 1 and 4") == 0


# --- enums ----------------------------------------------------------------


def test_zones_are_within_the_declared_enum(con):
    zones = set(ZONES)
    for col in ("start_zone", "end_zone"):
        found = {r[0] for r in con.execute(f"select distinct {col} from '{PHASES}'").fetchall()}
        assert found <= zones, f"{col} has values outside the enum: {found - zones}"


def test_start_types_are_within_the_declared_enum(con):
    found = {r[0] for r in con.execute(f"select distinct start_type from '{PHASES}'").fetchall()}
    assert found <= set(T.START_TYPES)


def test_outcomes_are_within_the_declared_enum(con):
    found = {r[0] for r in con.execute(f"select distinct outcome from '{PHASES}'").fetchall()}
    assert found <= set(T.OUTCOMES)


def test_team_sides_are_within_the_declared_enum(con):
    found = {r[0] for r in con.execute(f"select distinct team_side from '{EVENTS_GLOB}'").fetchall()}
    assert found == {"in_possession", "opponent"}


def test_frame_orientations_are_within_the_declared_enum(con):
    found = {
        r[0] for r in con.execute(f"select distinct orientation from '{FRAMES_GLOB}'").fetchall()
    }
    assert found <= {"event", "mirrored", "unknown"}


def test_zone_agrees_with_the_stored_coordinates(con):
    """The stored zone must be recomputable from the stored start/end point."""
    bad = scalar(
        con,
        f"""select count(*) from '{PHASES}'
            where start_zone <>
              (case when start_x < 40 then 'def_third' when start_x < 80 then 'mid_third'
                    else 'final_third' end) || '_' ||
              (case when start_y < 80.0/3 then 'left' when start_y < 160.0/3 then 'centre'
                    else 'right' end)""",
    )
    assert bad == 0


# --- geometry -------------------------------------------------------------


def test_path_xy_has_the_declared_length(con):
    assert scalar(
        con, f"select count(*) from '{PHASES}' where len(path_xy) <> {2 * PATH_POINTS}"
    ) == 0


def test_path_xy_endpoints_match_the_stored_start_and_end(con):
    worst = scalar(
        con,
        f"""select max(greatest(
                abs(path_xy[1] - start_x), abs(path_xy[2] - start_y),
                abs(path_xy[{2 * PATH_POINTS - 1}] - end_x),
                abs(path_xy[{2 * PATH_POINTS}] - end_y)))
            from '{PHASES}'""",
    )
    assert worst < 1e-3


def test_path_xy_stays_on_the_pitch(con):
    """Event locations are on-pitch by construction, so the path must be too."""
    bad = scalar(
        con,
        f"""select count(*) from (
              select unnest(path_xy[1:{2 * PATH_POINTS}:2]) x,
                     unnest(path_xy[2:{2 * PATH_POINTS}:2]) y from '{PHASES}')
            where x < 0 or x > 120.1 or y < 0 or y > 80.1""",
    )
    assert bad == 0


def test_event_coordinates_stay_on_the_pitch(con):
    bad = scalar(
        con,
        f"""select count(*) from '{EVENTS_GLOB}'
            where (x is not null and (x < 0 or x > 120.1 or y < 0 or y > 80.1))""",
    )
    assert bad == 0


def test_progression_is_the_endpoint_difference_converted_to_metres(con):
    """CONTRACT §3b pins progression_m as metres, converted at 0.9144 m/yard."""
    worst = scalar(
        con,
        f"select max(abs(progression_m - (end_x - start_x) * {YARD_M})) from '{PHASES}'",
    )
    assert worst < 1e-3


def test_direct_speed_is_progression_over_duration(con):
    worst = scalar(
        con,
        f"""select max(abs(direct_speed_m_s - progression_m / duration_s))
            from '{PHASES}' where duration_s > 0.05""",
    )
    assert worst < 1e-3


def test_max_x_dominates_both_endpoints(con):
    assert scalar(
        con, f"select count(*) from '{PHASES}' where max_x < start_x - 1e-3 or max_x < end_x - 1e-3"
    ) == 0


def test_reached_flags_agree_with_the_geometry(con):
    assert scalar(
        con, f"select count(*) from '{PHASES}' where reached_final_third <> (max_x >= 80)"
    ) == 0
    # reached_box implies the ball got into the final third
    assert scalar(
        con, f"select count(*) from '{PHASES}' where reached_box and not reached_final_third"
    ) == 0


def test_frame_dot_lists_are_parallel_and_non_empty(con):
    assert scalar(
        con,
        f"""select count(*) from '{FRAMES_GLOB}'
            where len(px) <> len(py) or len(px) <> len(flags)
               or len(px) <> n_players or n_players < 1""",
    ) == 0


def test_frames_with_a_resolved_orientation_have_exactly_one_actor(con):
    """The spec warns a frame may have zero or several actors, and it happens.

    docs/statsbomb-notes.md §3.5 measured zero such frames over 14 matches. Over
    all 102 there are 6 (0.002%), every one of them carrying *two* actor dots.
    The orientation detector cannot resolve those -- it needs a single actor to
    compare against the event location -- so they must all come out 'unknown'
    and fall back to the event-team assumption. That is the invariant worth
    holding: a frame we claim to have oriented was orientable.
    """
    unresolvable = scalar(
        con,
        f"""select count(*) from (
              select orientation,
                     list_sum(list_transform(flags, f -> ((f >> 1) & 1)::int)) actors
              from '{FRAMES_GLOB}')
            where actors <> 1 and orientation <> 'unknown'""",
    )
    assert unresolvable == 0

    total = scalar(con, f"select count(*) from '{FRAMES_GLOB}'")
    odd = scalar(
        con,
        f"""select count(*) from (
              select list_sum(list_transform(flags, f -> ((f >> 1) & 1)::int)) actors
              from '{FRAMES_GLOB}')
            where actors <> 1""",
    )
    assert odd / total < 1e-4, f"{odd}/{total} frames have an unusable actor count"


# --- football correctness -------------------------------------------------


def test_goal_phases_reconcile_with_the_raw_goal_events(con, manifest):
    """Every goal in the raw data is accounted for exactly once.

    goals in raw events (non-shootout) = phases with outcome 'goal'
                                       + phases flagged goal_conceded

    The second term is the six phases where the ball changed hands and went in
    without StatsBomb opening a new possession -- see docs/phase-definitions.md.
    """
    raw = manifest["counts"]["goal_shots_non_shootout"] + manifest["counts"][
        "own_goals_non_shootout"
    ]
    scored = scalar(con, f"select count(*) from '{PHASES}' where outcome = 'goal'")
    conceded = scalar(con, f"select count(*) from '{PHASES}' where goal_conceded")
    assert scored + conceded == raw


def test_goal_phases_reconcile_per_competition(con):
    """The same reconciliation, split by tournament, computed from the shards."""
    rows = con.execute(
        f"""with goals as (
              select p.competition,
                     count(*) filter (where p.outcome = 'goal') scored,
                     count(*) filter (where p.goal_conceded) conceded
              from '{PHASES}' p group by 1),
            shots as (
              select p.competition,
                     count(*) filter (where e.type_id = {T.SHOT}
                                        and e.outcome_name = 'Goal') goal_shots,
                     count(*) filter (where e.type_id = {T.OWN_GOAL_AGAINST}) own_goals
              from '{EVENTS_GLOB}' e join '{PHASES}' p using (phase_id) group by 1)
            select g.competition, g.scored + g.conceded, s.goal_shots + s.own_goals
            from goals g join shots s using (competition)"""
    ).fetchall()
    assert len(rows) == 2
    for label, from_phases, from_events in rows:
        assert from_phases == from_events, label


def test_goal_phases_match_the_final_scores(con):
    """Total goals in the phase model equal total goals in the match results."""
    from_results = scalar(con, f"select sum(home_score + away_score) from '{MATCHES}'")
    from_phases = scalar(
        con,
        f"select count(*) filter (where outcome='goal') + count(*) filter (where goal_conceded) "
        f"from '{PHASES}'",
    )
    # match `home_score`/`away_score` include penalty shootout results only for
    # the tournament bookkeeping, never as goals, so these must agree exactly.
    assert from_phases == from_results


def test_a_goal_phase_always_contains_a_goal_event(con):
    bad = scalar(
        con,
        f"""select count(*) from '{PHASES}' p where p.outcome = 'goal' and not exists (
              select 1 from '{EVENTS_GLOB}' e where e.phase_id = p.phase_id
              and ((e.type_id = {T.SHOT} and e.outcome_name = 'Goal'
                    and e.team_side = 'in_possession')
                or (e.type_id = {T.OWN_GOAL_AGAINST} and e.team_side = 'opponent')))""",
    )
    assert bad == 0


def test_shot_outcome_phases_contain_a_shot(con):
    bad = scalar(
        con,
        f"""select count(*) from '{PHASES}'
            where outcome in ('shot_on_target','shot_off_target') and n_shots = 0""",
    )
    assert bad == 0


def test_set_piece_phases_are_not_labelled_open_play_turnovers(con):
    """A corner cannot also be a high press regain -- the criteria exclude it."""
    assert scalar(
        con,
        f"""select count(*) from '{PHASES}'
            where high_press_regain and start_type <> 'turnover_open_play'""",
    ) == 0


def test_high_press_regains_start_in_the_final_third(con):
    assert scalar(
        con, f"select count(*) from '{PHASES}' where high_press_regain and max_x < 80"
    ) == 0


def test_kick_off_phases_start_near_the_centre_spot(con):
    """Sanity check on the whole start_type chain, using known geometry."""
    off_centre = scalar(
        con,
        f"""select count(*) from '{PHASES}'
            where start_type = 'kick_off' and (abs(start_x - 60) > 6 or abs(start_y - 40) > 12)""",
    )
    total = scalar(con, f"select count(*) from '{PHASES}' where start_type = 'kick_off'")
    assert total > 0
    assert off_centre / total < 0.05


def test_corner_phases_start_in_a_corner(con):
    bad = scalar(
        con,
        f"""select count(*) from '{PHASES}'
            where start_type = 'corner' and (start_x < 110 or (start_y > 12 and start_y < 68))""",
    )
    total = scalar(con, f"select count(*) from '{PHASES}' where start_type = 'corner'")
    assert total > 0
    assert bad / total < 0.05


def test_goal_kick_phases_start_deep(con):
    total = scalar(con, f"select count(*) from '{PHASES}' where start_type = 'goal_kick'")
    deep = scalar(
        con, f"select count(*) from '{PHASES}' where start_type = 'goal_kick' and start_x < 20"
    )
    assert total > 0
    assert deep / total > 0.95


# --- similarity -----------------------------------------------------------


def test_similarity_vectors_have_the_declared_dimension(con):
    assert scalar(con, f"select count(*) from '{SIM}' where len(vec) <> {DIM}") == 0
    assert DIM <= 96, "CONTRACT §7 caps the vector at 96 dimensions"


def test_similarity_vectors_are_l2_normalized(con):
    worst = scalar(
        con,
        f"select max(abs(sqrt(list_dot_product(vec, vec)) - 1.0)) from '{SIM}'",
    )
    assert worst < 1e-5


def test_similarity_vectors_contain_no_nan(con):
    assert scalar(
        con,
        f"select count(*) from '{SIM}' where len(list_filter(vec, v -> isnan(v))) > 0",
    ) == 0


def test_a_phase_is_its_own_nearest_neighbour(con):
    probe = scalar(con, f"select phase_id from '{SIM}' order by phase_id limit 1")
    best = con.execute(
        f"""select s.phase_id, list_dot_product(s.vec, (select vec from '{SIM}'
              where phase_id = '{probe}')) sim
            from '{SIM}' s order by sim desc limit 1"""
    ).fetchone()
    assert best[0] == probe
    assert best[1] == pytest.approx(1.0, abs=1e-5)


# --- manifest and inputs --------------------------------------------------


def test_manifest_reports_the_real_row_counts(con, manifest):
    assert manifest["counts"]["phases"] == scalar(con, f"select count(*) from '{PHASES}'")
    assert manifest["counts"]["matches"] == scalar(con, f"select count(*) from '{MATCHES}'")
    assert manifest["counts"]["phase_events"] == scalar(
        con, f"select count(*) from '{EVENTS_GLOB}'"
    )
    assert manifest["counts"]["phase_frames"] == scalar(
        con, f"select count(*) from '{FRAMES_GLOB}'"
    )


def test_manifest_reports_the_real_file_sizes(manifest):
    for name in ("phases.parquet", "matches.parquet", "similarity.parquet"):
        assert manifest["files"][name] == (OUT_DIR / name).stat().st_size


def test_manifest_lists_a_shard_for_every_match(manifest):
    for match_id in manifest["shards"]["match_ids"]:
        assert (OUT_DIR / "phase_events" / f"{match_id}.parquet").exists()
        assert (OUT_DIR / "phase_frames" / f"{match_id}.parquet").exists()


def test_manifest_carries_the_required_attribution(manifest):
    assert "StatsBomb" in manifest["attribution"]
    assert "non-commercial" in manifest["attribution"]


def test_no_raw_statsbomb_json_is_tracked_by_git():
    """Licence clause 1.2.1: the raw data must never be redistributed.

    Checked against the git index rather than the working tree, because that is
    what would actually be published.
    """
    import subprocess

    repo = OUT_DIR.parents[2]
    tracked = subprocess.run(
        ["git", "-C", str(repo), "ls-files", "*.json"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.split()
    # What the licence forbids is the *raw* cache: `events/{match}.json`,
    # `three-sixty/{match}.json`, `lineups/{match}.json`,
    # `matches/{comp}/{season}.json`. Those are the shapes to look for. A
    # tracked `package.json` or a hand-written config is not StatsBomb data,
    # and an allowlist of legitimate filenames would need editing every time
    # the app grows one.
    raw_dirs = ("events/", "three-sixty/", "lineups/", "matches/")
    leaked = [
        p
        for p in tracked
        if any(f"/{d}" in f"/{p}" for d in raw_dirs)
        or os.path.basename(p).removesuffix(".json").isdigit()
    ]
    assert leaked == [], f"raw StatsBomb JSON is tracked by git: {leaked}"


def test_the_raw_cache_lives_outside_the_repository():
    repo = OUT_DIR.parents[2]
    assert repo not in RAW_DIR.parents, "raw data must not sit inside the repo"


@pytest.mark.skipif(not (RAW_DIR / "three-sixty").exists(), reason="raw cache not present")
def test_every_downloaded_360_file_is_real_not_a_stub():
    small = [
        p
        for p in (RAW_DIR / "three-sixty").glob("*.json")
        if p.stat().st_size < MIN_360_BYTES
    ]
    assert small == []
    assert len(os.listdir(RAW_DIR / "three-sixty")) == 102
