"""PhaseQuery DSL — Pydantic mirror of docs/CONTRACT.md §3.

This module is the server-side twin of `web/src/dsl/schema.ts`. It is the only
thing in the service that decides whether a query is legal: the LLM emits DSL
JSON, and every byte of it comes back through here before it reaches a client.
Nothing here knows about SQL — compilation to SQL happens in the browser, so a
model that hallucinates a field name produces a validation error, never a query.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    StrictBool,
    StrictFloat,
    StrictInt,
    StrictStr,
    field_validator,
    model_validator,
)

DSL_VERSION = 1

LIMIT_MIN = 1
LIMIT_MAX = 96
LIMIT_DEFAULT = 48


class PhaseField(str, Enum):
    """Closed enum of `phases.parquet` columns (CONTRACT §2). Unknown → error."""

    # identity
    phase_id = "phase_id"
    match_id = "match_id"
    possession = "possession"
    team_id = "team_id"
    team_name = "team_name"
    period = "period"
    start_ts = "start_ts"
    end_ts = "end_ts"
    minute = "minute"
    competition = "competition"
    # features
    start_zone = "start_zone"
    end_zone = "end_zone"
    duration_s = "duration_s"
    n_passes = "n_passes"
    n_events = "n_events"
    n_players = "n_players"
    start_type = "start_type"
    outcome = "outcome"
    progression_m = "progression_m"
    direct_speed_m_s = "direct_speed_m_s"
    pressure_events = "pressure_events"
    high_press_regain = "high_press_regain"
    counterattack = "counterattack"
    switch_of_play = "switch_of_play"
    reached_final_third = "reached_final_third"
    reached_box = "reached_box"
    xg = "xg"
    has_360 = "has_360"
    frame_coverage = "frame_coverage"


class Op(str, Enum):
    eq = "eq"
    neq = "neq"
    in_ = "in"
    gte = "gte"
    lte = "lte"
    between = "between"


Kind = Literal["int", "float", "bool", "enum", "text"]

# Zones: pitch thirds x channels in the attacking team's frame (CONTRACT §4).
ZONES = tuple(
    f"{third}_{channel}"
    for third in ("def_third", "mid_third", "final_third")
    for channel in ("left", "centre", "right")
)

START_TYPES = (
    "kick_off",
    "goal_kick",
    "corner",
    "free_kick",
    "throw_in",
    "turnover_open_play",
    "regular",
)

# Denormalized onto phases.parquet so the index is self-sufficient (CONTRACT §3b).
COMPETITIONS = ("Euro 2020", "Euro 2024")

OUTCOMES = (
    "goal",
    "shot_on_target",
    "shot_off_target",
    "lost_ball",
    "out_of_play",
    "foul_won",
    "end_of_period",
)


@dataclass(frozen=True)
class FieldSpec:
    kind: Kind
    doc: str
    values: tuple[str, ...] = ()
    # Narrows the operators allowed for this specific column, where the kind's
    # default set is wider than the contract permits.
    ops: tuple["Op", ...] | None = None


# The football meaning of each column, in the words we want the model to reason
# in. This registry is the single source of truth for validation *and* for the
# field reference embedded in the system prompt.
FIELDS: dict[PhaseField, FieldSpec] = {
    PhaseField.phase_id: FieldSpec("text", "Stable phase key, '{match_id}-{seq}'."),
    PhaseField.match_id: FieldSpec("int", "StatsBomb match id."),
    PhaseField.possession: FieldSpec("int", "StatsBomb possession number within the match."),
    PhaseField.team_id: FieldSpec("int", "Id of the team in possession for this phase."),
    PhaseField.team_name: FieldSpec(
        "text", "Name of the team in possession, e.g. 'England', 'Spain'."
    ),
    PhaseField.period: FieldSpec("int", "1 first half, 2 second half, 3/4 extra time."),
    PhaseField.start_ts: FieldSpec("float", "Seconds into the period when the phase starts."),
    PhaseField.end_ts: FieldSpec("float", "Seconds into the period when the phase ends."),
    PhaseField.minute: FieldSpec("int", "Match minute the phase starts in."),
    PhaseField.competition: FieldSpec(
        "enum",
        "Tournament the phase was played in.",
        COMPETITIONS,
        ops=(Op.eq, Op.in_),
    ),
    PhaseField.start_zone: FieldSpec(
        "enum",
        "Pitch zone where the phase started, in the attacking team's frame.",
        ZONES,
    ),
    PhaseField.end_zone: FieldSpec(
        "enum", "Pitch zone where the phase ended, same frame.", ZONES
    ),
    PhaseField.duration_s: FieldSpec("float", "Phase length in seconds."),
    PhaseField.n_passes: FieldSpec("int", "Passes played by the possession team in the phase."),
    PhaseField.n_events: FieldSpec("int", "All events in the phase."),
    PhaseField.n_players: FieldSpec("int", "Distinct players of the possession team involved."),
    PhaseField.start_type: FieldSpec(
        "enum", "How the phase began (restart type or open-play turnover).", START_TYPES
    ),
    PhaseField.outcome: FieldSpec(
        "enum", "How the phase ended, by precedence.", OUTCOMES
    ),
    PhaseField.progression_m: FieldSpec(
        "float", "Net upfield ball progression in metres (StatsBomb x units)."
    ),
    PhaseField.direct_speed_m_s: FieldSpec(
        "float", "Upfield progression divided by duration — how direct the phase was."
    ),
    PhaseField.pressure_events: FieldSpec(
        "int", "Count of opponent Pressure events during the phase."
    ),
    PhaseField.high_press_regain: FieldSpec(
        "bool", "Phase began with a regain high up the pitch (a high turnover)."
    ),
    PhaseField.counterattack: FieldSpec(
        "bool", "Phase is a counterattack: turnover start, direct, fast, upfield."
    ),
    PhaseField.switch_of_play: FieldSpec(
        "bool", "Phase contains a switch — a long lateral pass changing the channel."
    ),
    PhaseField.reached_final_third: FieldSpec("bool", "Ball entered the attacking third."),
    PhaseField.reached_box: FieldSpec("bool", "Ball entered the penalty area."),
    PhaseField.xg: FieldSpec("float", "Max shot xG in the phase; 0 when there was no shot."),
    PhaseField.has_360: FieldSpec("bool", "Phase has at least one 360 freeze frame."),
    PhaseField.frame_coverage: FieldSpec(
        "float", "Fraction 0-1 of the phase's events that carry a 360 frame."
    ),
}

NUMERIC_KINDS: tuple[Kind, ...] = ("int", "float")

# Which operators make sense for which kind of column. Ordering a boolean or
# asking for `gte` on a team name is a modelling error, not a query.
OPS_BY_KIND: dict[Kind, tuple[Op, ...]] = {
    "int": (Op.eq, Op.neq, Op.in_, Op.gte, Op.lte, Op.between),
    "float": (Op.eq, Op.neq, Op.in_, Op.gte, Op.lte, Op.between),
    "bool": (Op.eq, Op.neq),
    "enum": (Op.eq, Op.neq, Op.in_),
    "text": (Op.eq, Op.neq, Op.in_),
}


def allowed_ops(field: PhaseField) -> tuple[Op, ...]:
    spec = FIELDS[field]
    return spec.ops if spec.ops is not None else OPS_BY_KIND[spec.kind]


Scalar = StrictBool | StrictInt | StrictFloat | StrictStr
# Strict* on purpose: "48" must not silently become 48, and True must not
# satisfy an integer column. Loose coercion is how a wrong query looks right.
FilterValue = Scalar | list[Scalar]


def sortable_fields() -> tuple[PhaseField, ...]:
    return tuple(f for f, spec in FIELDS.items() if spec.kind in NUMERIC_KINDS)


def _scalar_error(field: PhaseField, spec: FieldSpec, value: Any) -> str | None:
    """Return a human-readable reason `value` is not legal for `field`."""
    if spec.kind == "bool":
        if not isinstance(value, bool):
            return f"{field.value} is a boolean field; got {type(value).__name__}"
        return None
    if isinstance(value, bool):
        # bool is a subclass of int in Python — reject it everywhere else.
        return f"{field.value} does not accept booleans"
    if spec.kind == "int":
        if not isinstance(value, int):
            return f"{field.value} is an integer field; got {type(value).__name__}"
        return None
    if spec.kind == "float":
        if not isinstance(value, (int, float)):
            return f"{field.value} is a numeric field; got {type(value).__name__}"
        return None
    if not isinstance(value, str):
        return f"{field.value} is a string field; got {type(value).__name__}"
    if spec.kind == "enum" and value not in spec.values:
        return (
            f"{value!r} is not a valid value for {field.value}; "
            f"allowed: {', '.join(spec.values)}"
        )
    return None


class Filter(BaseModel):
    """One conjunctive predicate. `filters` is ANDed together by the compiler."""

    model_config = ConfigDict(extra="forbid", use_enum_values=False)

    field: PhaseField
    op: Op
    value: FilterValue

    @model_validator(mode="after")
    def _check(self) -> "Filter":
        spec = FIELDS[self.field]
        allowed = allowed_ops(self.field)
        if self.op not in allowed:
            raise ValueError(
                f"op '{self.op.value}' is not supported for {self.field.value} "
                f"({spec.kind}); allowed: {', '.join(o.value for o in allowed)}"
            )

        if self.op is Op.in_:
            if not isinstance(self.value, list) or not self.value:
                raise ValueError("op 'in' requires a non-empty list of values")
            items = self.value
        elif self.op is Op.between:
            if not isinstance(self.value, list) or len(self.value) != 2:
                raise ValueError("op 'between' requires exactly two values [low, high]")
            items = self.value
        else:
            if isinstance(self.value, list):
                raise ValueError(f"op '{self.op.value}' requires a single value, not a list")
            items = [self.value]

        for item in items:
            err = _scalar_error(self.field, spec, item)
            if err:
                raise ValueError(err)

        if self.op is Op.between:
            low, high = self.value  # type: ignore[misc]
            if low > high:  # type: ignore[operator]
                raise ValueError("op 'between' requires value[0] <= value[1]")
        return self


class OrderBy(BaseModel):
    model_config = ConfigDict(extra="forbid")

    field: PhaseField
    dir: Literal["asc", "desc"] = "desc"

    @field_validator("field")
    @classmethod
    def _sortable(cls, value: PhaseField) -> PhaseField:
        if FIELDS[value].kind not in NUMERIC_KINDS:
            raise ValueError(
                f"cannot order by {value.value}; order_by must name a numeric field"
            )
        return value


class PhaseQuery(BaseModel):
    """The whole query language. Presets, the filter builder and the NL path all
    produce exactly this object."""

    model_config = ConfigDict(extra="forbid")

    version: Literal[1] = DSL_VERSION
    filters: list[Filter] = []
    order_by: OrderBy | None = None
    limit: int = LIMIT_DEFAULT

    @field_validator("limit", mode="before")
    @classmethod
    def _clamp_limit(cls, value: Any) -> Any:
        # Out-of-range limits are repaired, not rejected: a model asking for 500
        # results wants "lots", and 96 is the most the UI will ever render.
        if isinstance(value, bool) or not isinstance(value, int):
            return value
        return min(max(value, LIMIT_MIN), LIMIT_MAX)
