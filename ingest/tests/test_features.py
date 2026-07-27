"""Feature derivation: start types, outcomes, progression, flags, ball path."""

from __future__ import annotations

import pytest
from conftest import carry_ev, ev, pass_ev, shot_ev

from halfspace_ingest import taxonomy as T
from halfspace_ingest.config import YARD_M
from halfspace_ingest.phases import (
    DEFAULT_THRESHOLDS,
    ball_path,
    build_phase_features,
    derive_outcome,
    derive_start_type,
    goal_conceded,
    is_regain_event,
    segment,
)


def phase_of(events, match_id=1):
    phases = segment(match_id, events)
    assert len(phases) == 1, f"expected one phase, got {len(phases)}"
    return phases[0]


def features(events, prev=None, pre_press=()):
    return build_phase_features(phase_of(events), prev, list(pre_press), DEFAULT_THRESHOLDS)


# --- start_type -----------------------------------------------------------


@pytest.mark.parametrize(
    "pattern,expected",
    [
        (T.PP_KICK_OFF, "kick_off"),
        (T.PP_GOAL_KICK, "goal_kick"),
        (T.PP_CORNER, "corner"),
        (T.PP_FREE_KICK, "free_kick"),
        (T.PP_THROW_IN, "throw_in"),
    ],
)
def test_set_piece_start_types_come_from_play_pattern(pattern, expected):
    ph = phase_of([pass_ev(1, [30.0, 40.0], [50.0, 40.0], play_pattern=pattern)])
    assert derive_start_type(ph, None)[0] == expected


def test_open_play_turnover_needs_the_previous_chain_to_be_the_other_team():
    prev = phase_of([pass_ev(1, [30.0, 40.0], [50.0, 40.0], possession=5, poss_team=2)])
    ours = phase_of([pass_ev(2, [30.0, 40.0], [50.0, 40.0], possession=6, poss_team=1)])
    assert derive_start_type(ours, prev)[0] == "turnover_open_play"


def test_same_team_restart_is_regular_not_a_turnover():
    """The increment alone is not a turnover signal (notes §5.3)."""
    prev = phase_of([pass_ev(1, [30.0, 40.0], [50.0, 40.0], possession=5, poss_team=1)])
    ours = phase_of([pass_ev(2, [30.0, 40.0], [50.0, 40.0], possession=6, poss_team=1)])
    assert derive_start_type(ours, prev)[0] == "regular"


def test_first_phase_of_a_period_has_no_previous_chain_to_compare():
    ours = phase_of([pass_ev(1, [30.0, 40.0], [50.0, 40.0], possession=6, poss_team=1)])
    assert derive_start_type(ours, None)[0] == "regular"


def test_previous_chain_in_a_different_period_does_not_count():
    prev = phase_of([pass_ev(1, [30.0, 40.0], [50.0, 40.0], period=1, possession=66, poss_team=2)])
    ours = phase_of([pass_ev(2, [30.0, 40.0], [50.0, 40.0], period=2, possession=67, poss_team=1)])
    assert derive_start_type(ours, prev)[0] == "regular"


def test_pass_type_rescues_a_restart_that_play_pattern_missed():
    ph = phase_of(
        [pass_ev(1, [1.0, 40.0], [40.0, 40.0], play_pattern=T.PP_REGULAR,
                 pass_sub={"type": {"id": 63, "name": "Goal Kick"}})]
    )
    assert derive_start_type(ph, None)[0] == "goal_kick"


# --- outcome --------------------------------------------------------------


def test_goal_beats_everything():
    ph = phase_of(
        [
            pass_ev(1, [80.0, 40.0], [100.0, 40.0]),
            shot_ev(2, [104.0, 40.0], T.SHOT_GOAL, xg=0.3),
        ]
    )
    assert derive_outcome(ph) == "goal"


def test_a_saved_shot_is_on_target_and_a_blocked_one_is_not():
    saved = phase_of([shot_ev(1, [104.0, 40.0], T.SHOT_SAVED)])
    blocked = phase_of([shot_ev(1, [104.0, 40.0], T.SHOT_BLOCKED)])
    post = phase_of([shot_ev(1, [104.0, 40.0], T.SHOT_POST)])
    assert derive_outcome(saved) == "shot_on_target"
    assert derive_outcome(blocked) == "shot_off_target"
    assert derive_outcome(post) == "shot_off_target"


def test_goal_takes_precedence_over_a_later_lost_ball():
    ph = phase_of(
        [
            shot_ev(1, [104.0, 40.0], T.SHOT_GOAL),
            ev(2, T.MISCONTROL, location=[60.0, 40.0]),
        ]
    )
    assert derive_outcome(ph) == "goal"


def test_shot_takes_precedence_over_a_foul_won():
    ph = phase_of(
        [
            shot_ev(1, [104.0, 40.0], T.SHOT_SAVED),
            ev(2, T.FOUL_WON, location=[100.0, 40.0]),
        ]
    )
    assert derive_outcome(ph) == "shot_on_target"


def test_lost_ball_from_a_miscontrol():
    ph = phase_of([pass_ev(1, [30.0, 40.0], [50.0, 40.0]), ev(2, T.MISCONTROL, location=[50.0, 40.0])])
    assert derive_outcome(ph) == "lost_ball"


def test_lost_ball_from_an_opponent_interception():
    ph = phase_of(
        [
            pass_ev(1, [30.0, 40.0], [50.0, 40.0]),
            ev(2, T.INTERCEPTION, team=2, location=[70.0, 40.0],
               interception={"outcome": {"id": 16, "name": "Success In Play"}}),
        ]
    )
    assert derive_outcome(ph) == "lost_ball"


def test_lost_ball_beats_out_of_play_per_contract_precedence():
    """CONTRACT §2 lists lost_ball ahead of out_of_play."""
    ph = phase_of(
        [
            pass_ev(1, [30.0, 40.0], [50.0, 40.0]),
            ev(2, T.MISCONTROL, location=[50.0, 40.0], out=True),
        ]
    )
    assert derive_outcome(ph) == "lost_ball"


def test_out_of_play_from_a_pass_out():
    ph = phase_of(
        [pass_ev(1, [30.0, 40.0], [50.0, 90.0],
                 pass_sub={"outcome": {"id": T.PASS_OUTCOME_OUT, "name": "Out"}})]
    )
    assert derive_outcome(ph) == "out_of_play"


def test_foul_won_when_the_chain_ends_on_a_free_kick():
    ph = phase_of([pass_ev(1, [30.0, 40.0], [50.0, 40.0]), ev(2, T.FOUL_WON, location=[50.0, 40.0])])
    assert derive_outcome(ph) == "foul_won"


def test_foul_committed_by_the_opponent_is_also_a_foul_won():
    ph = phase_of(
        [pass_ev(1, [30.0, 40.0], [50.0, 40.0]), ev(2, T.FOUL_COMMITTED, team=2, location=[50.0, 40.0])]
    )
    assert derive_outcome(ph) == "foul_won"


def test_end_of_period():
    ph = phase_of(
        [
            carry_ev(1, [30.0, 40.0], [40.0, 40.0]),
            ev(2, T.HALF_END, location=None, player=None),
        ]
    )
    assert derive_outcome(ph) == "end_of_period"


def test_own_goal_by_the_opponent_is_a_goal_for_us():
    ph = phase_of(
        [
            pass_ev(1, [90.0, 40.0], [110.0, 30.0]),
            ev(2, T.OWN_GOAL_AGAINST, team=2, location=[5.0, 40.0]),
        ]
    )
    assert derive_outcome(ph) == "goal"
    assert goal_conceded(ph) is False


def test_our_own_goal_is_a_conceded_goal_not_our_goal():
    ph = phase_of(
        [
            pass_ev(1, [20.0, 40.0], [5.0, 40.0]),
            ev(2, T.OWN_GOAL_AGAINST, team=1, location=[5.0, 40.0]),
        ]
    )
    assert goal_conceded(ph) is True
    assert derive_outcome(ph) != "goal"


def test_opponent_goal_inside_our_chain_is_a_conceded_goal():
    """Bajrami-vs-Italy shape: they score without the possession number moving."""
    ph = phase_of(
        [
            pass_ev(1, [30.0, 40.0], [50.0, 40.0]),
            shot_ev(2, [104.0, 40.0], T.SHOT_GOAL, team=2),
        ]
    )
    assert goal_conceded(ph) is True
    assert derive_outcome(ph) != "goal"


# --- ball path and progression -------------------------------------------


def test_ball_path_uses_only_the_possession_team():
    ph = phase_of(
        [
            pass_ev(1, [30.0, 40.0], [50.0, 40.0]),
            ev(2, T.PRESSURE, team=2, location=[104.5, 27.1]),
            carry_ev(3, [50.0, 40.0], [60.0, 40.0]),
        ]
    )
    assert ball_path(ph) == [(30.0, 40.0), (50.0, 40.0), (60.0, 40.0)]


def test_ball_path_drops_consecutive_duplicates():
    ph = phase_of(
        [pass_ev(1, [30.0, 40.0], [50.0, 40.0]), carry_ev(2, [50.0, 40.0], [55.0, 40.0])]
    )
    assert ball_path(ph) == [(30.0, 40.0), (50.0, 40.0), (55.0, 40.0)]


def test_progression_is_signed_and_published_in_metres():
    """CONTRACT §3b: x-axis deltas are converted from nominal yards to metres."""
    forward = features([pass_ev(1, [30.0, 40.0], [70.0, 40.0], ts="00:00:00.000")])
    backward = features([pass_ev(1, [70.0, 40.0], [30.0, 40.0], ts="00:00:00.000")])
    assert forward["progression_m"] == pytest.approx(40.0 * YARD_M)
    assert backward["progression_m"] == pytest.approx(-40.0 * YARD_M)


def test_direct_speed_is_progression_over_duration():
    f = features(
        [
            pass_ev(1, [20.0, 40.0], [40.0, 40.0], ts="00:00:00.000", duration=1.0),
            carry_ev(2, [40.0, 40.0], [60.0, 40.0], ts="00:00:03.000", duration=1.0),
        ]
    )
    assert f["duration_s"] == pytest.approx(4.0)
    assert f["progression_m"] == pytest.approx(40.0 * YARD_M)
    assert f["direct_speed_m_s"] == pytest.approx(10.0 * YARD_M)
    assert f["direct_speed_m_s"] == pytest.approx(f["progression_m"] / f["duration_s"])


def test_zero_duration_phase_does_not_divide_by_zero():
    f = features([ev(1, T.BALL_RECOVERY, location=[50.0, 40.0], duration=0.0)])
    assert f["duration_s"] == 0.0
    assert f["direct_speed_m_s"] == 0.0


def test_trailing_admin_events_do_not_extend_the_clock():
    """The Varga-stoppage case: a six-minute gap must not become the duration."""
    f = features(
        [
            pass_ev(1, [30.0, 40.0], [50.0, 40.0], ts="00:00:00.000", duration=1.0),
            ev(2, T.INJURY_STOPPAGE, ts="00:00:18.000", location=None, duration=0.0),
            ev(3, T.SUBSTITUTION, ts="00:06:11.000", location=None, duration=0.0),
        ]
    )
    assert f["duration_s"] == pytest.approx(1.0)


def test_zones_and_reach_flags():
    f = features([pass_ev(1, [10.0, 10.0], [110.0, 40.0], ts="00:00:00.000")])
    assert f["start_zone"] == "def_third_left"
    assert f["end_zone"] == "final_third_centre"
    assert f["reached_final_third"] is True
    assert f["reached_box"] is True


def test_reached_box_is_false_just_outside_it():
    f = features([pass_ev(1, [90.0, 40.0], [101.0, 40.0], ts="00:00:00.000")])
    assert f["reached_final_third"] is True
    assert f["reached_box"] is False


def test_path_xy_is_forty_floats():
    f = features([pass_ev(1, [10.0, 10.0], [110.0, 40.0], ts="00:00:00.000")])
    assert len(f["path_xy"]) == 40


# --- flags ----------------------------------------------------------------


def test_switch_of_play_from_the_statsbomb_flag():
    f = features(
        [pass_ev(1, [60.0, 20.0], [60.0, 30.0], ts="00:00:00.000", pass_sub={"switch": True})]
    )
    assert f["switch_of_play"] is True


def test_switch_of_play_from_forty_yards_of_width():
    yes = features([pass_ev(1, [60.0, 15.0], [60.0, 55.0], ts="00:00:00.000")])
    no = features([pass_ev(1, [60.0, 15.0], [60.0, 54.9], ts="00:00:00.000")])
    assert yes["switch_of_play"] is True
    assert no["switch_of_play"] is False


def test_switch_ignores_the_opponents_passes():
    f = features(
        [
            carry_ev(1, [60.0, 40.0], [61.0, 40.0], ts="00:00:00.000"),
            pass_ev(2, [60.0, 15.0], [60.0, 60.0], ts="00:00:01.000", team=2),
        ]
    )
    assert f["switch_of_play"] is False


def _high_turnover_events():
    """A regain at x=95 followed by a shot -- the geometry of a high press."""
    return [
        ev(1, T.INTERCEPTION, possession=6, poss_team=1, location=[95.0, 40.0],
           ts="00:10:00.000", interception={"outcome": {"id": 16, "name": "Success In Play"}}),
        shot_ev(2, [108.0, 40.0], T.SHOT_SAVED, possession=6, poss_team=1, ts="00:10:02.000"),
    ]


def _prev_opponent_phase():
    return phase_of(
        [pass_ev(1, [30.0, 40.0], [50.0, 40.0], possession=5, poss_team=2)], match_id=1
    )


def test_high_press_regain_needs_a_high_regain_and_evidence_of_pressing():
    prev = _prev_opponent_phase()
    with_press = features(_high_turnover_events(), prev=prev, pre_press=[(597.0, 1)])
    assert with_press["high_press_regain"] is True


def test_high_press_regain_rejects_a_high_regain_with_no_press():
    prev = _prev_opponent_phase()
    f = features(_high_turnover_events(), prev=prev, pre_press=[])
    assert f["high_press_regain"] is False


def test_high_press_regain_accepts_a_counterpress_flagged_regain():
    prev = _prev_opponent_phase()
    events = _high_turnover_events()
    events[0]["counterpress"] = True
    f = features(events, prev=prev, pre_press=[])
    assert f["high_press_regain"] is True


def test_high_press_regain_rejects_a_press_by_the_other_team():
    prev = _prev_opponent_phase()
    f = features(_high_turnover_events(), prev=prev, pre_press=[(597.0, 2)])
    assert f["high_press_regain"] is False


def test_high_press_regain_rejects_a_regain_below_the_final_third():
    prev = _prev_opponent_phase()
    events = _high_turnover_events()
    events[0]["location"] = [79.9, 40.0]
    f = features(events, prev=prev, pre_press=[(597.0, 1)])
    assert f["high_press_regain"] is False


def test_high_press_regain_rejects_a_set_piece_start():
    prev = _prev_opponent_phase()
    events = _high_turnover_events()
    for e in events:
        e["play_pattern"] = {"id": T.PP_CORNER, "name": "From Corner"}
    f = features(events, prev=prev, pre_press=[(597.0, 1)])
    assert f["high_press_regain"] is False


def test_counterattack_from_the_statsbomb_play_pattern():
    f = features(
        [pass_ev(1, [30.0, 40.0], [50.0, 40.0], ts="00:00:00.000", play_pattern=T.PP_COUNTER)]
    )
    assert f["counterattack"] is True


def test_counterattack_from_geometry():
    prev = _prev_opponent_phase()
    f = features(
        [
            ev(1, T.BALL_RECOVERY, possession=6, poss_team=1, location=[40.0, 40.0],
               ts="00:00:00.000", duration=0.5),
            pass_ev(2, [40.0, 40.0], [100.0, 40.0], possession=6, poss_team=1,
                    ts="00:00:03.000", duration=1.0),
        ],
        prev=prev,
    )
    assert f["progression_m"] == pytest.approx(60.0 * YARD_M)
    assert f["direct_speed_m_s"] == pytest.approx(15.0 * YARD_M)
    assert f["counterattack"] is True


def test_slow_build_up_from_deep_is_not_a_counterattack():
    prev = _prev_opponent_phase()
    f = features(
        [
            ev(1, T.BALL_RECOVERY, possession=6, poss_team=1, location=[40.0, 40.0],
               ts="00:00:00.000", duration=0.5),
            pass_ev(2, [40.0, 40.0], [100.0, 40.0], possession=6, poss_team=1,
                    ts="00:01:00.000", duration=1.0),
        ],
        prev=prev,
    )
    # thresholds are in yards; the published column is metres
    assert f["direct_speed_m_s"] / YARD_M < DEFAULT_THRESHOLDS.counter_speed
    assert f["counterattack"] is False


# --- regain detection -----------------------------------------------------


def test_regain_requires_a_winning_outcome():
    won = ev(1, T.INTERCEPTION, location=[50.0, 40.0],
             interception={"outcome": {"id": 4, "name": "Won"}})
    lost = ev(1, T.INTERCEPTION, location=[50.0, 40.0],
              interception={"outcome": {"id": 13, "name": "Lost In Play"}})
    assert is_regain_event(won, 1) is True
    assert is_regain_event(lost, 1) is False


def test_a_failed_ball_recovery_is_not_a_regain():
    good = ev(1, T.BALL_RECOVERY, location=[50.0, 40.0])
    bad = ev(1, T.BALL_RECOVERY, location=[50.0, 40.0],
             ball_recovery={"recovery_failure": True})
    assert is_regain_event(good, 1) is True
    assert is_regain_event(bad, 1) is False


def test_an_aerial_duel_loss_is_not_a_regain():
    tackle = ev(1, T.DUEL, location=[50.0, 40.0],
                duel={"type": {"id": 11, "name": "Tackle"}, "outcome": {"id": 16, "name": "Success In Play"}})
    aerial = ev(1, T.DUEL, location=[50.0, 40.0], duel={"type": {"id": 10, "name": "Aerial Lost"}})
    assert is_regain_event(tackle, 1) is True
    assert is_regain_event(aerial, 1) is False


def test_regain_must_belong_to_the_asking_team():
    e = ev(1, T.BALL_RECOVERY, location=[50.0, 40.0], team=2)
    assert is_regain_event(e, 1) is False


def test_fifty_fifty_uses_the_observed_outcome_ids_not_the_spec_ones():
    """Spec says 108/109/147/148; the data says 1/2/3/4 (notes §8 item 2)."""
    won = ev(1, T.FIFTY_FIFTY, location=[50.0, 40.0],
             **{"50_50": {"outcome": {"id": 4, "name": "Won"}}})
    lost = ev(1, T.FIFTY_FIFTY, location=[50.0, 40.0],
              **{"50_50": {"outcome": {"id": 1, "name": "Lost"}}})
    assert is_regain_event(won, 1) is True
    assert is_regain_event(lost, 1) is False
