"""360 orientation detection and canonicalization, on constructed frames."""

from __future__ import annotations

import pytest

from halfspace_ingest.frames import (
    ORIENT_EVENT,
    ORIENT_MIRRORED,
    ORIENT_UNKNOWN,
    canonical_frame,
    canonical_visible_area,
    frame_orientation,
    is_paired_frame,
    teammate_reference_is_event_team,
)


def test_orientation_event_when_actor_sits_on_the_event(dot):
    ff = [dot(30.0, 20.0, actor=True), dot(40.0, 30.0)]
    assert frame_orientation([30.0, 20.0], ff) == ORIENT_EVENT


def test_orientation_event_tolerates_the_grid_quantisation(dot):
    ff = [dot(30.04, 19.96, actor=True)]
    assert frame_orientation([30.0, 20.0], ff) == ORIENT_EVENT


def test_orientation_mirrored_when_actor_sits_on_the_mirror(dot):
    # 120.1 - 30.0 = 90.1, 80.1 - 20.0 = 60.1
    ff = [dot(90.1, 60.1, actor=True), dot(80.0, 50.0)]
    assert frame_orientation([30.0, 20.0], ff) == ORIENT_MIRRORED


def test_orientation_unknown_without_an_actor(dot):
    assert frame_orientation([30.0, 20.0], [dot(30.0, 20.0)]) == ORIENT_UNKNOWN


def test_orientation_unknown_with_two_actors(dot):
    ff = [dot(30.0, 20.0, actor=True), dot(31.0, 21.0, actor=True)]
    assert frame_orientation([30.0, 20.0], ff) == ORIENT_UNKNOWN


def test_orientation_unknown_without_an_event_location(dot):
    assert frame_orientation(None, [dot(30.0, 20.0, actor=True)]) == ORIENT_UNKNOWN


def test_orientation_unknown_when_the_actor_matches_neither(dot):
    ff = [dot(5.0, 70.0, actor=True)]
    assert frame_orientation([30.0, 20.0], ff) == ORIENT_UNKNOWN


def test_paired_frame_detection(dot):
    """A borrowed frame sits *exactly* on the mirror; a re-oriented one does not."""
    exact = [dot(120.1 - 30.0, 80.1 - 20.0, actor=True)]
    loose = [dot(120.1 - 30.0 + 0.8, 80.1 - 20.0 - 0.4, actor=True)]
    assert is_paired_frame([30.0, 20.0], exact)
    assert not is_paired_frame([30.0, 20.0], loose)


@pytest.mark.parametrize(
    "orientation,paired,expected",
    [
        (ORIENT_EVENT, False, True),
        (ORIENT_UNKNOWN, False, True),
        (ORIENT_MIRRORED, False, True),  # re-oriented: actor is still our player
        (ORIENT_MIRRORED, True, False),  # borrowed: actor is the opponent's player
    ],
)
def test_teammate_reference_team(orientation, paired, expected):
    assert teammate_reference_is_event_team(orientation, paired) is expected


# --- canonicalization ------------------------------------------------------


def flags_of(flags: list[int]) -> list[tuple[bool, bool, bool]]:
    return [(bool(f & 1), bool(f & 2), bool(f & 4)) for f in flags]


def test_event_frame_by_the_possession_team_is_untouched(dot):
    ff = [dot(30.0, 20.0, actor=True), dot(10.0, 40.0, teammate=False, keeper=True)]
    xs, ys, flags = canonical_frame(ff, ORIENT_EVENT, event_team_is_possession=True)
    assert xs == [30.0, 10.0]
    assert ys == [20.0, 40.0]
    assert flags_of(flags) == [(True, True, False), (False, False, True)]


def test_event_frame_by_the_opponent_is_flipped_and_relabelled(dot):
    """A defender's event inside our chain: their picture, our frame."""
    ff = [dot(30.0, 20.0, actor=True), dot(100.0, 60.0, teammate=False)]
    xs, ys, flags = canonical_frame(ff, ORIENT_EVENT, event_team_is_possession=False)
    assert xs == [90.0, 20.0]
    assert ys == [60.0, 20.0]
    # actor is the opponent's player -> NOT on the possession team;
    # the actor's opponent (teammate=False) IS on the possession team.
    assert flags_of(flags) == [(False, True, False), (True, False, False)]


def test_reoriented_mirror_flips_coordinates_but_keeps_team_labels(dot):
    """orientation='mirrored', not a borrowed frame: our event, drawn backwards."""
    ff = [dot(90.0, 60.0, actor=True), dot(80.0, 50.0, teammate=False)]
    xs, ys, flags = canonical_frame(
        ff, ORIENT_MIRRORED, event_team_is_possession=True, paired=False
    )
    assert xs == [30.0, 40.0]
    assert ys == [20.0, 30.0]
    assert flags_of(flags) == [(True, True, False), (False, False, False)]


def test_borrowed_mirror_flips_coordinates_and_team_labels(dot):
    """orientation='mirrored' AND borrowed: the actor is the opponent's player."""
    ff = [dot(90.0, 60.0, actor=True), dot(80.0, 50.0, teammate=False)]
    xs, ys, flags = canonical_frame(
        ff, ORIENT_MIRRORED, event_team_is_possession=True, paired=True
    )
    assert xs == [30.0, 40.0]
    assert ys == [20.0, 30.0]
    assert flags_of(flags) == [(False, True, False), (True, False, False)]


def test_unknown_orientation_falls_back_to_the_event_assumption(dot):
    ff = [dot(30.0, 20.0, actor=True)]
    xs, ys, _ = canonical_frame(ff, ORIENT_UNKNOWN, event_team_is_possession=True)
    assert (xs, ys) == ([30.0], [20.0])


def test_dots_without_a_location_are_dropped(dot):
    ff = [dot(30.0, 20.0, actor=True), {"teammate": True, "actor": False, "keeper": False}]
    xs, _, _ = canonical_frame(ff, ORIENT_EVENT, event_team_is_possession=True)
    assert len(xs) == 1


def test_out_of_pitch_dots_survive_untouched(dot):
    """Freeze frames legitimately record players off the pitch (notes §3.5)."""
    ff = [dot(-2.5, 89.5, actor=True)]
    xs, ys, _ = canonical_frame(ff, ORIENT_EVENT, event_team_is_possession=True)
    assert (xs, ys) == ([-2.5], [89.5])


def test_visible_area_mirror():
    area = [120.0, 80.0, 0.0, 80.0, 120.0, 80.0]
    assert canonical_visible_area(area, flip=False) == area
    assert canonical_visible_area(area, flip=True) == [0.0, 0.0, 120.0, 0.0, 0.0, 0.0]
    assert canonical_visible_area(None, flip=True) == []
