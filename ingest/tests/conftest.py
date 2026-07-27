"""Shared fixtures: hand-built StatsBomb-shaped events.

The builders below produce the minimum an event needs to travel through the
pipeline, so a test can say what it means ("a Scotland pass at [30, 20] inside
Germany's possession 4") without 40 lines of JSON.
"""

from __future__ import annotations

import pytest

from halfspace_ingest import taxonomy as T


def ev(
    index: int,
    type_id: int,
    *,
    period: int = 1,
    possession: int = 2,
    poss_team: int = 1,
    team: int | None = None,
    ts: str = "00:00:10.000",
    minute: int = 0,
    second: int = 10,
    location: list | None = None,
    duration: float | None = 0.5,
    play_pattern: int = T.PP_REGULAR,
    player: int | None = 100,
    type_name: str | None = None,
    **extra,
) -> dict:
    """One StatsBomb event, with only the fields the pipeline reads."""
    e = {
        "id": f"uuid-{index}",
        "index": index,
        "period": period,
        "timestamp": ts,
        "minute": minute,
        "second": second,
        "type": {"id": type_id, "name": type_name or f"Type{type_id}"},
        "possession": possession,
        "possession_team": {"id": poss_team, "name": f"Team{poss_team}"},
        "play_pattern": {"id": play_pattern, "name": f"PP{play_pattern}"},
        "team": {"id": team if team is not None else poss_team, "name": f"Team{team if team is not None else poss_team}"},
    }
    if location is not None:
        e["location"] = location
    if duration is not None:
        e["duration"] = duration
    if player is not None:
        e["player"] = {"id": player, "name": f"Player{player}"}
    e.update(extra)
    return e


def pass_ev(index: int, start: list, end: list, **kw) -> dict:
    sub = kw.pop("pass_sub", {})
    return ev(index, T.PASS, location=start, type_name="Pass", **{"pass": {"end_location": end, **sub}}, **kw)


def carry_ev(index: int, start: list, end: list, **kw) -> dict:
    return ev(index, T.CARRY, location=start, type_name="Carry", carry={"end_location": end}, **kw)


def shot_ev(index: int, start: list, outcome_id: int, xg: float = 0.1, **kw) -> dict:
    return ev(
        index,
        T.SHOT,
        location=start,
        type_name="Shot",
        shot={
            "statsbomb_xg": xg,
            "end_location": [120.0, 40.0, 1.0],
            "outcome": {"id": outcome_id, "name": "x"},
        },
        **kw,
    )


@pytest.fixture
def dot():
    """A 360 freeze-frame player record."""

    def _dot(x: float, y: float, teammate: bool = True, actor: bool = False, keeper: bool = False):
        return {"location": [x, y], "teammate": teammate, "actor": actor, "keeper": keeper}

    return _dot
