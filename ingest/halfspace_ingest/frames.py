"""360 freeze-frame handling: orientation detection and canonicalization.

The 360 spec promises every frame is drawn in the linked event's team's
attacking frame. That is true for ~95% of frames; the other ~5% -- almost all
paired duel-type events -- are drawn in the *opponent's* frame
(docs/statsbomb-notes.md §3.5, discrepancy #12). So we check every frame rather
than assuming, then rotate it into the possession team's frame.
"""

from __future__ import annotations

from .config import EVENT_MIRROR_X, EVENT_MIRROR_Y
from .geometry import mirror_frame

#: Tolerance for matching a frame's actor dot to its event's location, in yards.
#: The actor normally matches to float precision (median |dx| 1.5e-06); 1.5 yd
#: is loose enough to absorb the 0.1 grid quantisation of event locations and
#: the occasional near-miss, tight enough that MATCH and MIRROR never overlap
#: (they are 120 yards apart except right on the halfway line).
ACTOR_TOLERANCE = 1.5

ORIENT_EVENT = "event"
ORIENT_MIRRORED = "mirrored"
ORIENT_UNKNOWN = "unknown"


def frame_orientation(event_location: list | tuple | None, freeze_frame: list[dict]) -> str:
    """Classify a 360 frame as 'event' | 'mirrored' | 'unknown'.

    'event'    -> frame coordinates are in the event team's attacking frame.
    'mirrored' -> they are in the opponent-of-the-event-team's frame.
    'unknown'  -> no single actor, no event location, or the actor matches
                  neither hypothesis. Callers fall back to the event-team
                  assumption and keep the flag so the UI can be honest.
    """
    if not event_location:
        return ORIENT_UNKNOWN
    actors = [p for p in freeze_frame if p.get("actor")]
    if len(actors) != 1:
        return ORIENT_UNKNOWN
    ax, ay = actors[0]["location"][0], actors[0]["location"][1]
    ex, ey = float(event_location[0]), float(event_location[1])
    if abs(ax - ex) <= ACTOR_TOLERANCE and abs(ay - ey) <= ACTOR_TOLERANCE:
        return ORIENT_EVENT
    if (
        abs(ax - (EVENT_MIRROR_X - ex)) <= ACTOR_TOLERANCE
        and abs(ay - (EVENT_MIRROR_Y - ey)) <= ACTOR_TOLERANCE
    ):
        return ORIENT_MIRRORED
    return ORIENT_UNKNOWN


#: A 'mirrored' frame whose actor dot is bit-identical to the mirrored event
#: location was copied wholesale from the paired opposing event. Real frames
#: match their own event to ~1e-06, so exactness against the *mirror* is the
#: signature of a borrowed frame rather than a re-oriented one.
PAIRED_EPS = 1e-4


def is_paired_frame(event_location: list | tuple | None, freeze_frame: list[dict]) -> bool:
    """True if a mirrored frame is the *paired opponent event's* frame.

    Only meaningful for frames already classified ORIENT_MIRRORED. See
    ``canonical_frame`` for why the distinction matters.
    """
    if not event_location:
        return False
    actors = [p for p in freeze_frame if p.get("actor")]
    if len(actors) != 1:
        return False
    ax, ay = actors[0]["location"][0], actors[0]["location"][1]
    ex, ey = float(event_location[0]), float(event_location[1])
    return abs(ax - (EVENT_MIRROR_X - ex)) < PAIRED_EPS and abs(ay - (EVENT_MIRROR_Y - ey)) < PAIRED_EPS


def teammate_reference_is_event_team(orientation: str, paired: bool) -> bool:
    """Which team is a dot's ``teammate`` flag relative to?

    ``teammate`` means "same team as the actor". The subtlety is *which* actor,
    because a mirrored frame can arise two ways, and the data says they behave
    differently:

    * **Borrowed frame** (mirrored, actor bit-identical to the mirrored event
      location): StatsBomb attached the paired *opponent* event's frame to this
      event. The actor in the picture is the opponent's player, so ``teammate``
      is relative to the opponent. Measured over 20 matches: of mirrored frames
      with a goalkeeper deep in a penalty area, 146/149 (98%) were consistent
      with this reading; an independent nearest-neighbour continuity check
      against adjacent well-oriented frames agreed 308 dots to 103.
    * **Re-oriented frame** (mirrored, actor merely near the mirrored location):
      the frame is this event's own, drawn the wrong way round. The actor is
      still this event's player, so ``teammate`` is relative to the event team.
      Same tests: 347/442 (79%) of keeper checks and 2043 dots to 1261 on the
      continuity check.

    Both tests are noisy -- these are contested duels where players sit on top
    of each other -- but they agree on direction, and the affected population is
    ~2.7% of frames. See docs/phase-definitions.md for the honest caveat.
    """
    if orientation == ORIENT_MIRRORED and paired:
        return False
    return True


def frame_flip(orientation: str, event_team_is_possession: bool) -> bool:
    """Do this frame's coordinates need mirroring into the possession frame?

    'event' and 'unknown' frames are drawn for the event's team; 'mirrored'
    ones for the opponent. Flip when that is not the possession team.
    """
    frame_is_event_team = orientation != ORIENT_MIRRORED
    return frame_is_event_team != event_team_is_possession


def canonical_frame(
    freeze_frame: list[dict],
    orientation: str,
    event_team_is_possession: bool,
    paired: bool = False,
) -> tuple[list[float], list[float], list[int]]:
    """Rotate a freeze frame into the possession team's attacking frame.

    Returns parallel lists ``(xs, ys, flags)`` where ``flags`` is a bitmask per
    player: bit 0 = plays for the phase's possession team, bit 1 = is the actor
    of this event, bit 2 = is a goalkeeper.

    Coordinates and team membership are resolved independently:

    * **Coordinates.** 'event' orientation means the picture is drawn in the
      event team's attacking frame; 'mirrored' means the opponent's. Combined
      with whether the event team *is* the possession team, that decides the
      flip. 'unknown' (~3.7% of frames) falls back to the event-team assumption
      and is flagged so the UI can be honest about it.
    * **Team membership.** ``teammate`` is resolved against whichever actor it
      refers to -- see ``teammate_reference_is_event_team``.
    """
    flip = frame_flip(orientation, event_team_is_possession)

    tm_ref_is_event_team = teammate_reference_is_event_team(orientation, paired)
    # "teammate == True means the dot is on the possession team" iff the team
    # that `teammate` refers to is itself the possession team.
    tm_true_means_possession = (
        event_team_is_possession if tm_ref_is_event_team else not event_team_is_possession
    )

    xs: list[float] = []
    ys: list[float] = []
    flags: list[int] = []
    for p in freeze_frame:
        loc = p.get("location")
        if not loc:
            continue
        x, y = float(loc[0]), float(loc[1])
        if flip:
            x, y = mirror_frame(x, y)
        is_poss = bool(p.get("teammate")) == tm_true_means_possession
        bits = (1 if is_poss else 0) | (2 if p.get("actor") else 0) | (4 if p.get("keeper") else 0)
        xs.append(x)
        ys.append(y)
        flags.append(bits)
    return xs, ys, flags


def canonical_visible_area(area: list[float] | None, flip: bool) -> list[float]:
    """Mirror a flat ``[x1,y1,...,x1,y1]`` visible-area polygon if needed."""
    if not area:
        return []
    out: list[float] = []
    for i in range(0, len(area) - 1, 2):
        x, y = float(area[i]), float(area[i + 1])
        if flip:
            x, y = mirror_frame(x, y)
        out.extend((x, y))
    return out
