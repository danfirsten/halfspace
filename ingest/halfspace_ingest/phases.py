"""Possession chains -> phases, and phases -> football features.

A **phase** is one StatsBomb possession chain: all events sharing a
``(match_id, period, possession)`` key. Period is part of the key because raw
possession numbers run straight through a half-time break
(docs/statsbomb-notes.md §5.2) -- without it a "phase" would contain a
15-minute gap. Period 5 (penalty shootouts) is dropped entirely.

Consecutive possessions belonging to the *same* team are **not** merged: one in
three possession increments is a restart to the same team rather than a
turnover (§5.3), and merging them would blur a throw-in restart into the move
that preceded it. Keeping them separate means ``possession`` stays a single
integer per phase and "a phase" always means "a passage of play between
restarts". The plain-English consequences are written up in
docs/phase-definitions.md.

Every coordinate produced here is in the **possession team's** attacking frame.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from . import taxonomy as T
from .config import PATH_POINTS, PERIOD_OFFSET_S, YARD_M
from .frames import (
    ORIENT_UNKNOWN,
    canonical_frame,
    canonical_visible_area,
    frame_flip,
    frame_orientation,
    is_paired_frame,
)
from .geometry import canon_event, in_box, resample_path, zone


@dataclass(frozen=True)
class Thresholds:
    """Every tunable number in the feature layer, in one auditable place.

    Values are set from measured distributions -- see
    ``scripts/calibrate.py`` and docs/phase-definitions.md.
    """

    #: Minimum canonical x for a ball regain to count as "high".
    high_press_x: float = 80.0
    #: How long before the regain we look for a pressing action by the same team.
    high_press_window_s: float = 5.0
    #: Lateral distance (yards) a pass must cover to count as a switch of play.
    #: 40 yards reproduces StatsBomb's own `pass.switch` flag exactly: across
    #: 20,469 passes in 20 matches, every one of the 646 flagged switches
    #: travelled >= 40.0 yards and no unflagged pass reached 39.9.
    switch_dy: float = 40.0
    #: A counter-attack must win the ball back in its own half.
    counter_regain_x_max: float = 60.0
    #: ...and advance upfield at least this fast (yards per second). 4.3 is the
    #: 10th percentile of the possessions StatsBomb itself tags `From Counter`
    #: (p10 4.31, p50 6.91, against p50 2.15 for everything else).
    counter_speed: float = 4.3
    #: ...having progressed at least this far upfield. 18 yards is StatsBomb's
    #: own published number in the From Counter definition.
    counter_progression: float = 18.0


DEFAULT_THRESHOLDS = Thresholds()


def parse_ts(ts: str) -> float:
    """'HH:MM:SS.mmm' -> seconds elapsed within the period."""
    h, m, s = ts.split(":")
    return int(h) * 3600 + int(m) * 60 + float(s)


def _sub(ev: dict) -> dict:
    return ev.get(T.SUBKEY.get(ev["type"]["id"], ""), {}) or {}


def _outcome_id(ev: dict) -> int | None:
    oc = _sub(ev).get("outcome")
    return oc["id"] if oc else None


def _outcome_name(ev: dict) -> str | None:
    oc = _sub(ev).get("outcome")
    return oc["name"] if oc else None


def _end_location(ev: dict) -> list | None:
    """The ball's end point for the event types that record one."""
    tid = ev["type"]["id"]
    if tid in (T.PASS, T.CARRY, T.SHOT, T.GOALKEEPER):
        return _sub(ev).get("end_location")
    return None


@dataclass
class RawPhase:
    """A possession chain plus the context needed to derive its features."""

    match_id: int
    period: int
    possession: int
    team_id: int
    team_name: str
    events: list[dict] = field(default_factory=list)

    @property
    def play_pattern_id(self) -> int:
        # play_pattern is a possession-level attribute; the 4-in-480 mixed case
        # is always the From Counter tag applied part-way through, so take the
        # last event's value (§5.5).
        return self.events[-1]["play_pattern"]["id"]

    def has_ball_content(self) -> bool:
        """Does this group contain any real passage of play?

        Possession 1 holds only Starting XI + Half Start, and every period
        boundary produces a group holding only the next half's Half Start
        events (§5.2). Both have no located, non-administrative event.
        """
        return any(
            e["type"]["id"] not in T.ADMIN_TYPES and e.get("location") for e in self.events
        )


def segment(match_id: int, events: list[dict]) -> list[RawPhase]:
    """Split a match's events into possession chains.

    Events must be in ``index`` order -- that is the authoritative sequence
    (§6.1); timestamps reset every period and many events share one.
    """
    phases: list[RawPhase] = []
    current: RawPhase | None = None
    for ev in events:
        if ev["period"] == 5:  # penalty shootout: degenerate one-shot possessions
            continue
        key = (ev["period"], ev["possession"])
        if current is None or (current.period, current.possession) != key:
            current = RawPhase(
                match_id=match_id,
                period=ev["period"],
                possession=ev["possession"],
                team_id=ev["possession_team"]["id"],
                team_name=ev["possession_team"]["name"],
            )
            phases.append(current)
        current.events.append(ev)
    return [p for p in phases if p.has_ball_content()]


# --- feature derivation ----------------------------------------------------


def ball_path(phase: RawPhase) -> list[tuple[float, float]]:
    """The ball's route through the phase, in the possession team's frame.

    Built from the *in-possession* team's own events only. Opponent events
    inside the chain (a pressure, a block, a clearance that rebounds straight
    back) describe the defender's position, not the attack's shape, and
    including them makes a build-up look like it teleports across the pitch.

    Where an event records an ``end_location`` -- a pass, a carry, a shot, a
    keeper distribution -- that point is appended too, because the ball
    genuinely travelled there. That is true even for an incomplete pass: the
    ball still arrived at the end point, it just arrived at nobody.
    """
    pts: list[tuple[float, float]] = []
    for ev in phase.events:
        if ev["team"]["id"] != phase.team_id:
            continue
        if ev["type"]["id"] == T.PRESSURE or ev["type"]["id"] in T.ADMIN_TYPES:
            continue
        x, y, _ = canon_event(ev.get("location"), flip=False)
        if x is None:
            continue
        pts.append((x, y))
        ex, ey, _ = canon_event(_end_location(ev), flip=False)
        if ex is not None:
            pts.append((ex, ey))
    # Consecutive duplicates are structural (a carry starts where the pass that
    # fed it ended); they add nothing and skew arc-length resampling.
    out: list[tuple[float, float]] = []
    for p in pts:
        if not out or abs(p[0] - out[-1][0]) > 0.01 or abs(p[1] - out[-1][1]) > 0.01:
            out.append(p)
    return out


def derive_start_type(
    phase: RawPhase, prev_phase: RawPhase | None
) -> tuple[str, bool]:
    """Classify how the phase began. Returns (start_type, pattern_disagreed).

    Set pieces come from ``play_pattern``, which is a possession-level label and
    agrees essentially perfectly with the delivery's ``pass.type`` (§7.5). For
    everything else -- Regular Play, From Counter, From Keeper, Other -- there
    is no label, so we ask a question the increment itself cannot answer: did
    the ball actually change hands? A third of possession increments are
    restarts to the *same* team (§5.3), so the increment alone is not a
    turnover signal. If the previous chain in the same period belonged to the
    other team, this phase started with an open-play turnover; otherwise the
    same team simply kept going and we call it ``regular``.
    """
    pattern = T.PLAY_PATTERN_START_TYPE.get(phase.play_pattern_id)

    first_pass_type = None
    for ev in phase.events:
        if ev["type"]["id"] == T.PASS and ev["team"]["id"] == phase.team_id:
            pt = _sub(ev).get("type")
            first_pass_type = T.PASS_TYPE_START_TYPE.get(pt["id"]) if pt else None
            break

    disagreed = bool(pattern and first_pass_type and pattern != first_pass_type)
    if pattern:
        return pattern, disagreed
    if first_pass_type:
        # play_pattern said Regular/Other but the phase opens on a real restart.
        return first_pass_type, disagreed

    if prev_phase is not None and prev_phase.period == phase.period:
        if prev_phase.team_id != phase.team_id:
            return "turnover_open_play", disagreed
    return "regular", disagreed


def _terminal_event(phase: RawPhase) -> dict | None:
    for ev in reversed(phase.events):
        if ev["type"]["id"] in T.ADMIN_TYPES:
            continue
        if ev["type"]["id"] == T.PRESSURE:
            continue
        return ev
    return None


def _is_open_play_loss(ev: dict, team_id: int) -> bool:
    """Does this terminal event mean the ball was conceded in open play?"""
    tid = ev["type"]["id"]
    ours = ev["team"]["id"] == team_id
    if ours:
        if tid in (T.MISCONTROL, T.DISPOSSESSED, T.ERROR):
            return True
        if tid == T.PASS and _outcome_id(ev) in (
            T.PASS_OUTCOME_INCOMPLETE,
            T.PASS_OUTCOME_UNKNOWN,
        ):
            return True
        if tid == T.BALL_RECEIPT and _outcome_id(ev) == T.PASS_OUTCOME_INCOMPLETE:
            return True
        if tid == T.DRIBBLE and _outcome_id(ev) == T.PASS_OUTCOME_INCOMPLETE:
            return True
        if tid == T.FOUL_COMMITTED:  # we gave away the free kick
            return True
    else:
        # The opponent took the ball off us.
        if tid in (T.INTERCEPTION, T.BALL_RECOVERY, T.DUEL, T.BLOCK, T.CLEARANCE, T.DRIBBLED_PAST):
            return True
        if tid == T.GOALKEEPER and (_sub(ev).get("type") or {}).get("id") in T.GK_REGAIN_TYPES:
            return True
    return False


def goal_conceded(phase: RawPhase) -> bool:
    """Did this chain end with a goal for the team that did NOT own it?

    Six such phases exist in the dataset and they are all real football: the
    ball changed hands and went in so fast that StatsBomb never opened a new
    possession. Nedim Bajrami's 23-second goal for Albania against Italy sits
    inside *Italy's* throw-in possession; Unai Simon's own goal against Croatia
    sits inside *Spain's* build-up.

    They cannot be ``outcome = 'goal'`` -- that would credit Italy with
    Albania's goal -- so they get their own flag. With it, every goal in the
    data is accounted for exactly once:

        goals in raw events = count(outcome = 'goal') + count(goal_conceded)
    """
    for e in phase.events:
        tid = e["type"]["id"]
        if tid == T.SHOT and e["team"]["id"] != phase.team_id and _outcome_id(e) == T.SHOT_GOAL:
            return True
        if tid == T.OWN_GOAL_AGAINST and e["team"]["id"] == phase.team_id:
            return True
    return False


def derive_outcome(phase: RawPhase) -> str:
    """How the phase ended, by the precedence order in docs/CONTRACT.md §2.

    goal > shot_on_target > shot_off_target > lost_ball > out_of_play >
    foul_won > end_of_period, with ``lost_ball`` also serving as the residual
    if nothing else matches.

    The shot tests look at the whole phase; the rest look at the phase's last
    meaningful event, so in practice they are disjoint and the precedence
    ordering only decides "the move ended in a shot AND then the ball went
    out", which is the right call anyway.

    **Own goals count as a goal for the phase.** An ``Own Goal Against`` event
    belongs to the team that put it in its own net, and it sits inside the
    *attacking* team's possession chain, so a phase containing an opponent's
    Own Goal Against is a phase that ended in a goal for the phase's team.
    Excluding them would mean a search for "phases that ended in a goal"
    silently missed real goals.
    """
    shots = [
        e for e in phase.events if e["type"]["id"] == T.SHOT and e["team"]["id"] == phase.team_id
    ]
    own_goals_for_us = [
        e
        for e in phase.events
        if e["type"]["id"] == T.OWN_GOAL_AGAINST and e["team"]["id"] != phase.team_id
    ]
    if own_goals_for_us or any(_outcome_id(s) == T.SHOT_GOAL for s in shots):
        return "goal"
    if any(_outcome_id(s) in T.SHOT_ON_TARGET for s in shots):
        return "shot_on_target"
    if shots:
        return "shot_off_target"

    term = _terminal_event(phase)
    if term is not None and _is_open_play_loss(term, phase.team_id):
        return "lost_ball"

    if term is not None:
        if term.get("out"):
            return "out_of_play"
        if term["type"]["id"] == T.PASS and _outcome_id(term) in (
            T.PASS_OUTCOME_OUT,
            T.PASS_OUTCOME_OFFSIDE,
        ):
            return "out_of_play"
        if term["type"]["id"] == T.OFFSIDE:
            return "out_of_play"
        won_foul = term["type"]["id"] == T.FOUL_WON and term["team"]["id"] == phase.team_id
        conceded_foul = term["type"]["id"] == T.FOUL_COMMITTED and term["team"]["id"] != phase.team_id
        if won_foul or conceded_foul:
            return "foul_won"

    if any(e["type"]["id"] == T.HALF_END for e in phase.events):
        return "end_of_period"
    return "lost_ball"


def is_regain_event(ev: dict, team_id: int) -> bool:
    """Did this event win the ball for ``team_id``? (§7.4)"""
    if ev["team"]["id"] != team_id:
        return False
    tid = ev["type"]["id"]
    sub = _sub(ev)
    oid = _outcome_id(ev)
    if tid == T.INTERCEPTION:
        return oid in T.WON_OUTCOMES
    if tid == T.DUEL:
        return (sub.get("type") or {}).get("id") == T.DUEL_TACKLE and oid in T.WON_OUTCOMES
    if tid == T.BALL_RECOVERY:
        return not sub.get("recovery_failure")
    if tid == T.FIFTY_FIFTY:
        return oid in T.FIFTY_FIFTY_WON
    if tid == T.BLOCK:
        return not sub.get("save_block")
    if tid == T.GOALKEEPER:
        return (sub.get("type") or {}).get("id") in T.GK_REGAIN_TYPES
    return False


def build_phase_features(
    phase: RawPhase,
    prev_phase: RawPhase | None,
    pre_phase_pressures: list[tuple[float, int]],
    thr: Thresholds,
) -> dict:
    """Everything in phases.parquet for one phase.

    ``pre_phase_pressures`` is ``(absolute_seconds, team_id)`` for Pressure
    events in the seconds immediately before this phase started; it is what
    lets ``high_press_regain`` require an actual press rather than just a
    convenient turnover.
    """
    ev = phase.events
    team_id = phase.team_id
    ours = [e for e in ev if e["team"]["id"] == team_id]

    # The clock stops at the last event that involves the ball. Administrative
    # events can trail a chain by minutes -- Scotland v Hungary 2024 has a
    # possession whose last three events are a six-minute medical stoppage, two
    # substitutions and a booking. Counting that as a six-minute possession
    # would be nonsense, and it would poison direct_speed for the phase.
    ball_ev = [e for e in ev if e["type"]["id"] not in T.ADMIN_TYPES] or ev
    start_ts = parse_ts(ev[0]["timestamp"])
    end_ts = max(parse_ts(e["timestamp"]) + (e.get("duration") or 0.0) for e in ball_ev)
    duration_s = max(end_ts - start_ts, 0.0)

    path = ball_path(phase)
    if not path:  # defensive: has_ball_content() should prevent this
        path = [(60.0, 40.0)]
    start_x, start_y = path[0]
    end_x, end_y = path[-1]
    max_x = max(p[0] for p in path)

    # Thresholds below are expressed in yards, matching the spec and the
    # measured distributions; only the published columns are converted.
    progression_yd = end_x - start_x
    speed_yd = progression_yd / duration_s if duration_s > 0.05 else 0.0
    progression_m = progression_yd * YARD_M
    direct_speed_m_s = speed_yd * YARD_M

    start_type, pattern_disagreed = derive_start_type(phase, prev_phase)
    outcome = derive_outcome(phase)

    shots = [e for e in ours if e["type"]["id"] == T.SHOT]
    xg = max((_sub(s).get("statsbomb_xg") or 0.0 for s in shots), default=0.0)

    # --- switch of play ---------------------------------------------------
    # StatsBomb's own `pass.switch` flag is authoritative but conservative (it
    # fires on ~2% of passes). We accept it, and additionally accept any
    # completed pass by the team in possession that moves the ball at least
    # `switch_dy` yards across the pitch -- that is the spec's own wording for
    # a switch ("travels more than 40 yards of the width of the pitch").
    switch = False
    for e in ours:
        if e["type"]["id"] != T.PASS:
            continue
        p = _sub(e)
        if p.get("switch"):
            switch = True
            break
        el = p.get("end_location")
        if el and abs(float(el[1]) - float(e["location"][1])) >= thr.switch_dy:
            switch = True
            break

    # --- high press regain ------------------------------------------------
    # A phase counts as a high-press regain when the team wins the ball back
    # high up the pitch AND was demonstrably pressing when it did so. The
    # second clause is what separates a press from a lucky ricochet: either the
    # winning action is flagged `counterpress` (StatsBomb: a pressing action
    # within 5s of an open-play turnover), or the same team put in at least one
    # Pressure event in the seconds leading up to the regain.
    regain_ev = ev[0] if ev else None
    for e in ev:
        if is_regain_event(e, team_id) and e.get("location"):
            regain_ev = e
            break
    regain_x = regain_y = None
    if regain_ev is not None and regain_ev.get("location"):
        rx, ry, _ = canon_event(
            regain_ev["location"], flip=regain_ev["team"]["id"] != team_id
        )
        regain_x, regain_y = rx, ry

    press_before = any(t_id == team_id for _t, t_id in pre_phase_pressures)
    counterpress_regain = bool(regain_ev is not None and regain_ev.get("counterpress"))
    high_press_regain = bool(
        start_type == "turnover_open_play"
        and regain_x is not None
        and regain_x >= thr.high_press_x
        and (counterpress_regain or press_before)
    )

    reached_final_third = max_x >= 80.0
    reached_box = any(in_box(x, y) for x, y in path)

    # --- counter-attack ---------------------------------------------------
    # StatsBomb's own `From Counter` play pattern is a derived label with a
    # published definition (open-play turnover outside the counter-attacking
    # team's final third, >=75% direct, >=18 yards gained), so we honour it.
    # It is also very rare, so we add an explicit geometric test with the same
    # shape: win the ball in your own half, break at least 18 yards upfield at
    # speed, and get into the final third.
    counterattack = phase.play_pattern_id == T.PP_COUNTER or bool(
        start_type == "turnover_open_play"
        and regain_x is not None
        and regain_x <= thr.counter_regain_x_max
        and progression_yd >= thr.counter_progression
        and speed_yd >= thr.counter_speed
        and reached_final_third
    )

    n_with_frame = sum(1 for e in ev if e.get("_has_frame"))
    frame_coverage = n_with_frame / len(ev) if ev else 0.0

    return {
        "period": phase.period,
        "possession": phase.possession,
        "team_id": team_id,
        "team_name": phase.team_name,
        "start_ts": start_ts,
        "end_ts": end_ts,
        "minute": ev[0]["minute"],
        "second": ev[0]["second"],
        "abs_start_s": PERIOD_OFFSET_S[phase.period] + start_ts,
        "duration_s": duration_s,
        "n_events": len(ev),
        "n_passes": sum(1 for e in ours if e["type"]["id"] == T.PASS),
        "n_players": len({e["player"]["id"] for e in ours if e.get("player")}),
        "start_zone": zone(start_x, start_y),
        "end_zone": zone(end_x, end_y),
        "start_x": start_x,
        "start_y": start_y,
        "end_x": end_x,
        "end_y": end_y,
        "max_x": max_x,
        "start_type": start_type,
        "outcome": outcome,
        "progression_m": progression_m,
        "direct_speed_m_s": direct_speed_m_s,
        "pressure_events": sum(
            1 for e in ev if e["type"]["id"] == T.PRESSURE and e["team"]["id"] != team_id
        ),
        "high_press_regain": high_press_regain,
        "counterattack": counterattack,
        "switch_of_play": switch,
        "reached_final_third": reached_final_third,
        "reached_box": reached_box,
        "xg": xg,
        "n_shots": len(shots),
        "goal_conceded": goal_conceded(phase),
        "has_360": n_with_frame > 0,
        "frame_coverage": frame_coverage,
        "path_xy": resample_path(path, PATH_POINTS),
        # diagnostics, not published:
        "_regain_x": regain_x,
        "_pattern_disagreed": pattern_disagreed,
        "_counterpress_regain": counterpress_regain,
        "_press_before": press_before,
        "_play_pattern_id": phase.play_pattern_id,
    }


def annotate_frames(events: list[dict], frames_by_uuid: dict) -> None:
    """Mark which events have a 360 frame, so coverage can be counted."""
    for e in events:
        if e["id"] in frames_by_uuid:
            e["_has_frame"] = True


def phase_event_rows(phase: RawPhase, phase_id: str, frames_by_uuid: dict) -> list[dict]:
    """Per-event rows for animation and tooltips (lazy-loaded per match)."""
    start_ts = parse_ts(phase.events[0]["timestamp"])
    rows = []
    for i, e in enumerate(phase.events):
        flip = e["team"]["id"] != phase.team_id
        x, y, _ = canon_event(e.get("location"), flip)
        ex, ey, ez = canon_event(_end_location(e), flip)
        rows.append(
            {
                "phase_id": phase_id,
                "idx": i,
                "event_uuid": e["id"],
                "event_index": e["index"],
                "t_offset_s": parse_ts(e["timestamp"]) - start_ts,
                "type_id": e["type"]["id"],
                "type_name": e["type"]["name"],
                "player_name": (e.get("player") or {}).get("name"),
                "position_name": (e.get("position") or {}).get("name"),
                "team_side": "opponent" if flip else "in_possession",
                "team_name": e["team"]["name"],
                "x": x,
                "y": y,
                "end_x": ex,
                "end_y": ey,
                "end_z": ez,
                "outcome_name": _outcome_name(e),
                "under_pressure": bool(e.get("under_pressure")),
                "counterpress": bool(e.get("counterpress")),
                "out": bool(e.get("out")),
                "xg": (_sub(e).get("statsbomb_xg") if e["type"]["id"] == T.SHOT else None),
                "has_frame": e["id"] in frames_by_uuid,
            }
        )
    return rows


def phase_frame_rows(phase: RawPhase, phase_id: str, frames_by_uuid: dict) -> list[dict]:
    """Per-360-frame rows: player dots, canonicalized, one row per frame.

    Parallel lists rather than one row per dot: an animation fetches a frame
    and wants all its dots at once, and 5.4 million dot-rows would be a poor
    thing to hand a browser.
    """
    rows = []
    for i, e in enumerate(phase.events):
        fr = frames_by_uuid.get(e["id"])
        if fr is None:
            continue
        ff = fr.get("freeze_frame") or []
        if not ff:
            continue
        orient = frame_orientation(e.get("location"), ff)
        paired = is_paired_frame(e.get("location"), ff) if orient == "mirrored" else False
        xs, ys, flags = canonical_frame(
            ff, orient, e["team"]["id"] == phase.team_id, paired=paired
        )
        if not xs:
            continue
        rows.append(
            {
                "phase_id": phase_id,
                "idx": i,
                "event_uuid": e["id"],
                "orientation": ORIENT_UNKNOWN if orient == ORIENT_UNKNOWN else orient,
                "n_players": len(xs),
                "px": xs,
                "py": ys,
                "flags": flags,
                # The camera polygon, in the same canonical frame. It lets the
                # renderer shade what the camera could not see instead of
                # implying the missing players were not there.
                "visible_area": canonical_visible_area(
                    fr.get("visible_area"),
                    frame_flip(orient, e["team"]["id"] == phase.team_id),
                ),
            }
        )
    return rows
