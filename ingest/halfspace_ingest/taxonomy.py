"""StatsBomb enum ids, keyed on id rather than name.

`type.name` contains characters that make bad identifiers (``Ball Receipt*``
keeps its asterisk, ``50/50`` keeps its slash), and several spec-documented id
mappings are simply wrong in the data (docs/statsbomb-notes.md §8: cards, 50/50
outcomes). Every id below was read off the real files.
"""

from __future__ import annotations

# --- event type ids (§4.1) -------------------------------------------------
BALL_RECOVERY = 2
DISPOSSESSED = 3
DUEL = 4
BLOCK = 6
OFFSIDE = 8
CLEARANCE = 9
INTERCEPTION = 10
DRIBBLE = 14
SHOT = 16
PRESSURE = 17
HALF_START = 18
SUBSTITUTION = 19
OWN_GOAL_AGAINST = 20
FOUL_WON = 21
FOUL_COMMITTED = 22
GOALKEEPER = 23
BAD_BEHAVIOUR = 24
OWN_GOAL_FOR = 25
PLAYER_ON = 26
PLAYER_OFF = 27
SHIELD = 28
PASS = 30
FIFTY_FIFTY = 33
HALF_END = 34
STARTING_XI = 35
TACTICAL_SHIFT = 36
ERROR = 37
MISCONTROL = 38
DRIBBLED_PAST = 39
INJURY_STOPPAGE = 40
REFEREE_BALL_DROP = 41
BALL_RECEIPT = 42
CARRY = 43

#: Events that carry no ball location and never form part of a passage of play.
#: A possession group made only of these is a bookkeeping stub, not a phase.
ADMIN_TYPES = frozenset(
    {
        STARTING_XI,
        HALF_START,
        HALF_END,
        TACTICAL_SHIFT,
        SUBSTITUTION,
        INJURY_STOPPAGE,
        PLAYER_ON,
        PLAYER_OFF,
        BAD_BEHAVIOUR,
    }
)

#: The sub-object key is the snake-cased type name, with three exceptions (§4.3).
SUBKEY = {
    BALL_RECOVERY: "ball_recovery",
    DUEL: "duel",
    BLOCK: "block",
    CLEARANCE: "clearance",
    INTERCEPTION: "interception",
    DRIBBLE: "dribble",
    SHOT: "shot",
    FOUL_WON: "foul_won",
    FOUL_COMMITTED: "foul_committed",
    GOALKEEPER: "goalkeeper",  # one word, not "goal_keeper"
    PASS: "pass",
    FIFTY_FIFTY: "50_50",  # the slash does not survive
    MISCONTROL: "miscontrol",
    BALL_RECEIPT: "ball_receipt",  # the asterisk does not survive
    CARRY: "carry",
    SUBSTITUTION: "substitution",
    BAD_BEHAVIOUR: "bad_behaviour",
    INJURY_STOPPAGE: "injury_stoppage",
}

# --- play_pattern ids (§7.1) ----------------------------------------------
PP_REGULAR = 1
PP_CORNER = 2
PP_FREE_KICK = 3
PP_THROW_IN = 4
PP_OTHER = 5
PP_COUNTER = 6
PP_GOAL_KICK = 7
PP_KEEPER = 8
PP_KICK_OFF = 9

PLAY_PATTERN_START_TYPE = {
    PP_CORNER: "corner",
    PP_FREE_KICK: "free_kick",
    PP_THROW_IN: "throw_in",
    PP_GOAL_KICK: "goal_kick",
    PP_KICK_OFF: "kick_off",
}

# --- pass.type ids (§7.5) --------------------------------------------------
PASS_TYPE_START_TYPE = {
    61: "corner",
    62: "free_kick",
    63: "goal_kick",
    65: "kick_off",
    67: "throw_in",
}
PASS_OUTCOME_INCOMPLETE = 9
PASS_OUTCOME_INJURY_CLEARANCE = 74
PASS_OUTCOME_OUT = 75
PASS_OUTCOME_OFFSIDE = 76
PASS_OUTCOME_UNKNOWN = 77

# --- shot.outcome ids (§4.4) ----------------------------------------------
SHOT_BLOCKED = 96
SHOT_GOAL = 97
SHOT_OFF_T = 98
SHOT_POST = 99
SHOT_SAVED = 100
SHOT_WAYWARD = 101
SHOT_SAVED_OFF_T = 115
SHOT_SAVED_TO_POST = 116

#: "On target" = the ball was going in and only the keeper or the frame of the
#: goal stopped it. A blocked shot is stopped by an outfield defender before it
#: is tested, and a shot off the post was never on target -- both sit in the
#: off-target bucket. `Saved Off T` is a save on a shot that was missing anyway.
SHOT_ON_TARGET = frozenset({SHOT_SAVED, SHOT_SAVED_TO_POST})

#: Regain-type outcomes that mean the defending player actually won the ball
#: (§7.4). Ids differ from the spec for 50/50 -- these are the observed ones.
WON_OUTCOMES = frozenset({4, 15, 16, 17})
DUEL_TACKLE = 11
FIFTY_FIFTY_WON = frozenset({3, 4})
GK_REGAIN_TYPES = frozenset({25, 27, 34})  # Collected, Keeper Sweeper, Smother

START_TYPES = (
    "kick_off",
    "goal_kick",
    "corner",
    "free_kick",
    "throw_in",
    "turnover_open_play",
    "regular",
)

OUTCOMES = (
    "goal",
    "shot_on_target",
    "shot_off_target",
    "lost_ball",
    "out_of_play",
    "foul_won",
    "end_of_period",
)
