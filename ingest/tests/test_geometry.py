"""Coordinate mirror, zones and path resampling."""

from __future__ import annotations

import math

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from halfspace_ingest.geometry import (
    ZONES,
    canon_event,
    in_box,
    mirror_event,
    mirror_frame,
    resample_path,
    zone,
)

# Event locations live on a 0.1 grid running 0.1 .. 120.0 / 0.1 .. 80.0.
grid_x = st.integers(min_value=1, max_value=1200).map(lambda i: round(i / 10, 1))
grid_y = st.integers(min_value=1, max_value=800).map(lambda i: round(i / 10, 1))
free_x = st.floats(min_value=-10, max_value=130, allow_nan=False, allow_infinity=False)
free_y = st.floats(min_value=-10, max_value=90, allow_nan=False, allow_infinity=False)


@given(grid_x, grid_y)
def test_event_mirror_is_an_involution(x, y):
    """Mirroring twice must land exactly back on the original grid point.

    This is the property that matters in practice: an opponent event mirrored
    into our frame and back must join to its own 360 actor position, which only
    works if the transform is exact. 120/80 would fail this.
    """
    mx, my = mirror_event(x, y)
    assert mirror_event(mx, my) == (x, y)


@given(grid_x, grid_y)
def test_event_mirror_sums_to_the_measured_constants(x, y):
    mx, my = mirror_event(x, y)
    assert math.isclose(x + mx, 120.1, abs_tol=1e-9)
    assert math.isclose(y + my, 80.1, abs_tol=1e-9)


@given(free_x, free_y)
def test_frame_mirror_is_an_involution(x, y):
    mx, my = mirror_frame(x, y)
    rx, ry = mirror_frame(mx, my)
    assert math.isclose(rx, x, abs_tol=1e-9)
    assert math.isclose(ry, y, abs_tol=1e-9)


def test_frame_and_event_mirrors_are_different():
    """Regression guard: the two constants are not interchangeable."""
    assert mirror_event(30.0, 20.0) != mirror_frame(30.0, 20.0)


def test_mirror_matches_a_real_observed_pair():
    """Verbatim from docs/statsbomb-notes.md §3.2."""
    assert mirror_event(35.5, 5.6) == (84.6, 74.5)
    assert mirror_event(101.3, 44.6) == (18.8, 35.5)


def test_canon_event_handles_two_and_three_element_locations():
    assert canon_event([10.0, 20.0], flip=False) == (10.0, 20.0, None)
    x, y, z = canon_event([10.0, 20.0, 2.5], flip=False)
    assert (x, y, z) == (10.0, 20.0, 2.5)
    # z is a height above the goal line and must survive a mirror untouched.
    x, y, z = canon_event([10.0, 20.0, 2.5], flip=True)
    assert (x, y, z) == (110.1, 60.1, 2.5)


def test_canon_event_of_missing_location():
    assert canon_event(None, flip=False) == (None, None, None)
    assert canon_event([], flip=True) == (None, None, None)


# --- zones ----------------------------------------------------------------


@pytest.mark.parametrize(
    "x,y,expected",
    [
        (0.1, 0.1, "def_third_left"),
        (39.9, 40.0, "def_third_centre"),
        (40.0, 40.0, "mid_third_centre"),  # boundary belongs upfield
        (79.9, 40.0, "mid_third_centre"),
        (80.0, 40.0, "final_third_centre"),  # boundary belongs upfield
        (120.0, 79.9, "final_third_right"),
        (60.0, 26.66, "mid_third_left"),  # just inside the left channel
        (60.0, 26.67, "mid_third_centre"),  # boundary belongs to higher y
        (60.0, 53.33, "mid_third_centre"),
        (60.0, 53.34, "mid_third_right"),
    ],
)
def test_zone_boundaries(x, y, expected):
    assert zone(x, y) == expected


@given(free_x.filter(lambda v: 0 <= v <= 120), free_y.filter(lambda v: 0 <= v <= 80))
def test_zone_always_returns_a_declared_enum_value(x, y):
    assert zone(x, y) in ZONES


def test_box_geometry_matches_the_spec():
    assert in_box(102.0, 18.0)
    assert in_box(120.0, 62.0)
    assert in_box(108.1, 40.1)  # the penalty spot
    assert not in_box(101.9, 40.0)
    assert not in_box(110.0, 17.9)
    assert not in_box(110.0, 62.1)


# --- path resampling ------------------------------------------------------


def test_resample_gives_the_requested_length():
    for n in (1, 2, 12, 20):
        assert len(resample_path([(0, 0), (10, 0), (10, 10)], n)) == 2 * n


def test_resample_pins_the_endpoints():
    out = resample_path([(0.0, 0.0), (60.0, 40.0), (120.0, 0.0)], 20)
    assert out[0] == pytest.approx(0.0)
    assert out[1] == pytest.approx(0.0)
    assert out[-2] == pytest.approx(120.0)
    assert out[-1] == pytest.approx(0.0)


def test_resample_of_a_straight_line_is_evenly_spaced():
    out = resample_path([(0.0, 0.0), (100.0, 0.0)], 11)
    xs = out[0::2]
    assert xs == pytest.approx([10.0 * i for i in range(11)])


def test_resample_of_a_single_point_repeats_it():
    assert resample_path([(5.0, 6.0)], 3) == [5.0, 6.0, 5.0, 6.0, 5.0, 6.0]


def test_resample_of_a_stationary_path_repeats_the_point():
    assert resample_path([(5.0, 6.0), (5.0, 6.0)], 2) == [5.0, 6.0, 5.0, 6.0]


def test_resample_of_an_empty_path_is_zeros():
    assert resample_path([], 2) == [0.0, 0.0, 0.0, 0.0]


@given(
    st.lists(st.tuples(free_x, free_y), min_size=1, max_size=40),
    st.integers(min_value=1, max_value=32),
)
@settings(max_examples=200)
def test_resample_never_leaves_the_bounding_box(points, n):
    out = resample_path(points, n)
    assert len(out) == 2 * n
    xs, ys = out[0::2], out[1::2]
    assert min(xs) >= min(p[0] for p in points) - 1e-6
    assert max(xs) <= max(p[0] for p in points) + 1e-6
    assert min(ys) >= min(p[1] for p in points) - 1e-6
    assert max(ys) <= max(p[1] for p in points) + 1e-6
