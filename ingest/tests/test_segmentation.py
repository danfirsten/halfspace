"""Possession segmentation on hand-built fixtures."""

from __future__ import annotations

from conftest import carry_ev, ev, pass_ev

from halfspace_ingest import taxonomy as T
from halfspace_ingest.phases import segment


def test_splits_on_possession_number():
    events = [
        pass_ev(1, [30.0, 40.0], [50.0, 40.0], possession=2, poss_team=1),
        pass_ev(2, [50.0, 40.0], [70.0, 40.0], possession=2, poss_team=1),
        pass_ev(3, [40.0, 40.0], [60.0, 40.0], possession=3, poss_team=2),
    ]
    phases = segment(1, events)
    assert [p.possession for p in phases] == [2, 3]
    assert [p.team_id for p in phases] == [1, 2]
    assert [len(p.events) for p in phases] == [2, 1]


def test_possession_1_stub_is_dropped():
    """Possession 1 is Starting XI + Half Start only -- never a real phase."""
    events = [
        ev(1, T.STARTING_XI, possession=1, location=None, player=None, ts="00:00:00.000"),
        ev(2, T.STARTING_XI, possession=1, location=None, player=None, ts="00:00:00.000", team=2),
        ev(3, T.HALF_START, possession=1, location=None, player=None, ts="00:00:00.000"),
        ev(4, T.HALF_START, possession=1, location=None, player=None, ts="00:00:00.000", team=2),
        pass_ev(5, [61.0, 40.1], [50.0, 40.0], possession=2, play_pattern=T.PP_KICK_OFF),
    ]
    phases = segment(1, events)
    assert len(phases) == 1
    assert phases[0].possession == 2


def test_half_boundary_splits_a_shared_possession_number():
    """A possession number runs straight through half-time (notes §5.2).

    The first half's tail is a real phase; the second half's Half-Start-only
    group carries the same possession number and must not be one.
    """
    events = [
        pass_ev(1, [30.0, 40.0], [50.0, 40.0], period=1, possession=66, poss_team=2),
        ev(2, T.HALF_END, period=1, possession=66, poss_team=2, location=None, player=None,
           ts="00:48:33.941"),
        ev(3, T.HALF_END, period=1, possession=66, poss_team=2, team=1, location=None, player=None,
           ts="00:48:33.941"),
        ev(4, T.HALF_START, period=2, possession=66, poss_team=2, location=None, player=None,
           ts="00:00:00.000"),
        ev(5, T.HALF_START, period=2, possession=66, poss_team=2, team=1, location=None,
           player=None, ts="00:00:00.000"),
        pass_ev(6, [61.0, 40.1], [50.0, 40.0], period=2, possession=67, poss_team=1),
    ]
    phases = segment(1, events)
    assert [(p.period, p.possession) for p in phases] == [(1, 66), (2, 67)]
    # the first-half phase keeps its Half End events
    assert len(phases[0].events) == 3


def test_same_team_restart_stays_a_separate_phase():
    """One in three possession increments is a restart to the same team.

    Halfspace does not merge them: a throw-in is a new passage of play.
    """
    events = [
        pass_ev(1, [30.0, 40.0], [50.0, 40.0], possession=10, poss_team=1),
        ev(2, T.FOUL_WON, possession=10, poss_team=1, location=[52.0, 40.0]),
        pass_ev(3, [52.0, 40.0], [70.0, 40.0], possession=11, poss_team=1,
                play_pattern=T.PP_FREE_KICK),
    ]
    phases = segment(1, events)
    assert len(phases) == 2
    assert phases[0].team_id == phases[1].team_id == 1


def test_period_5_shootout_is_excluded():
    events = [
        pass_ev(1, [30.0, 40.0], [50.0, 40.0], period=4, possession=170),
        ev(2, T.SHOT, period=5, possession=171, location=[108.1, 40.1],
           shot={"statsbomb_xg": 0.78, "outcome": {"id": 97, "name": "Goal"},
                 "end_location": [120.0, 40.0, 1.0]}),
    ]
    phases = segment(1, events)
    assert len(phases) == 1
    assert phases[0].period == 4


def test_group_with_no_located_event_is_dropped():
    events = [
        ev(1, T.SUBSTITUTION, possession=40, location=None),
        ev(2, T.TACTICAL_SHIFT, possession=40, location=None, player=None),
        carry_ev(3, [30.0, 40.0], [40.0, 40.0], possession=41),
    ]
    phases = segment(1, events)
    assert [p.possession for p in phases] == [41]


def test_opponent_events_stay_inside_the_chain():
    """Both teams' events live in one possession (notes §5.4)."""
    events = [
        pass_ev(1, [30.0, 40.0], [50.0, 40.0], possession=4, poss_team=1),
        ev(2, T.PRESSURE, possession=4, poss_team=1, team=2, location=[104.5, 27.1]),
        pass_ev(3, [50.0, 40.0], [70.0, 40.0], possession=4, poss_team=1),
    ]
    phases = segment(1, events)
    assert len(phases) == 1
    assert len(phases[0].events) == 3
    assert phases[0].team_id == 1


def test_play_pattern_takes_the_last_value_when_mixed():
    """The From Counter tag is applied part-way through a chain (notes §5.5)."""
    events = [
        pass_ev(1, [30.0, 40.0], [50.0, 40.0], possession=7, play_pattern=T.PP_REGULAR),
        pass_ev(2, [50.0, 40.0], [90.0, 40.0], possession=7, play_pattern=T.PP_COUNTER),
    ]
    phases = segment(1, events)
    assert phases[0].play_pattern_id == T.PP_COUNTER
