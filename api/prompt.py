"""System prompt and tool schema for the natural-language → PhaseQuery path.

The model is given exactly one way to answer: call `emit_phase_query` with DSL
JSON. It never writes SQL, and it never sees the database. The prompt below is
where the football semantics live — each field is explained in the vocabulary an
analyst would use, so the model maps "high turnover" to the right column instead
of inventing one.
"""

from __future__ import annotations

from typing import Any

from dsl import (
    DSL_VERSION,
    FIELDS,
    LIMIT_DEFAULT,
    LIMIT_MAX,
    LIMIT_MIN,
    OPS_BY_KIND,
    OUTCOMES,
    START_TYPES,
    ZONES,
    Op,
    PhaseField,
    sortable_fields,
)

TOOL_NAME = "emit_phase_query"

_SCALAR_SCHEMA: dict[str, Any] = {
    "anyOf": [
        {"type": "string"},
        {"type": "number"},
        {"type": "boolean"},
    ]
}

TOOL_SCHEMA: dict[str, Any] = {
    "name": TOOL_NAME,
    "description": (
        "Return the analyst's request as a PhaseQuery. This is the only way to "
        "answer. Never write SQL and never invent field names."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "version": {"type": "integer", "enum": [DSL_VERSION]},
            "filters": {
                "type": "array",
                "description": "Conjunctive (AND) list of predicates. May be empty.",
                "items": {
                    "type": "object",
                    "properties": {
                        "field": {
                            "type": "string",
                            "enum": [f.value for f in PhaseField],
                        },
                        "op": {"type": "string", "enum": [o.value for o in Op]},
                        "value": {
                            "description": (
                                "Scalar for eq/neq/gte/lte; a non-empty array for "
                                "'in'; exactly [low, high] for 'between'."
                            ),
                            "anyOf": [
                                *_SCALAR_SCHEMA["anyOf"],
                                {"type": "array", "items": _SCALAR_SCHEMA},
                            ],
                        },
                    },
                    "required": ["field", "op", "value"],
                    "additionalProperties": False,
                },
            },
            "order_by": {
                "type": "object",
                "description": "Optional. Omit for default relevance ordering.",
                "properties": {
                    "field": {
                        "type": "string",
                        "enum": [f.value for f in sortable_fields()],
                    },
                    "dir": {"type": "string", "enum": ["asc", "desc"]},
                },
                "required": ["field", "dir"],
                "additionalProperties": False,
            },
            "limit": {
                "type": "integer",
                "minimum": LIMIT_MIN,
                "maximum": LIMIT_MAX,
                "description": f"How many phases to return. Default {LIMIT_DEFAULT}.",
            },
            "explanation": {
                "type": "string",
                "description": (
                    "One short sentence, in football language, saying how you read "
                    "the request. If you dropped part of the request because the "
                    "data cannot express it, say so here."
                ),
            },
        },
        "required": ["version", "filters", "limit", "explanation"],
        "additionalProperties": False,
    },
}


def _field_reference() -> str:
    lines = []
    for field, spec in FIELDS.items():
        ops = ", ".join(o.value for o in OPS_BY_KIND[spec.kind])
        line = f"- {field.value} ({spec.kind}) — {spec.doc} ops: {ops}."
        if spec.values:
            line += f" values: {', '.join(spec.values)}."
        lines.append(line)
    return "\n".join(lines)


# Worked examples. These double as the specification for the web app's offline
# heuristic parser (web/src/dsl/heuristic.ts) — keep the two in step.
EXAMPLES: list[tuple[str, str]] = [
    (
        "high turnovers leading to a shot",
        """{"version": 1,
 "filters": [{"field": "high_press_regain", "op": "eq", "value": true},
             {"field": "outcome", "op": "in", "value": ["goal", "shot_on_target", "shot_off_target"]}],
 "limit": 48,
 "explanation": "Phases that began with a high regain and finished with a shot."}""",
    ),
    (
        "long possessions ending in the box",
        """{"version": 1,
 "filters": [{"field": "duration_s", "op": "gte", "value": 20},
             {"field": "n_passes", "op": "gte", "value": 8},
             {"field": "reached_box", "op": "eq", "value": true}],
 "order_by": {"field": "duration_s", "dir": "desc"},
 "limit": 48,
 "explanation": "Long, pass-heavy possessions that got the ball into the penalty area."}""",
    ),
    (
        "counterattacks by England",
        """{"version": 1,
 "filters": [{"field": "counterattack", "op": "eq", "value": true},
             {"field": "team_name", "op": "eq", "value": "England"}],
 "limit": 48,
 "explanation": "England phases flagged as counterattacks."}""",
    ),
    (
        "phases from goal kicks reaching the final third under 20 seconds",
        """{"version": 1,
 "filters": [{"field": "start_type", "op": "eq", "value": "goal_kick"},
             {"field": "reached_final_third", "op": "eq", "value": true},
             {"field": "duration_s", "op": "lte", "value": 20}],
 "limit": 48,
 "explanation": "Goal-kick build-ups that reached the final third inside 20 seconds."}""",
    ),
    (
        "quick switches of play starting in the defensive third",
        """{"version": 1,
 "filters": [{"field": "switch_of_play", "op": "eq", "value": true},
             {"field": "start_zone", "op": "in",
              "value": ["def_third_left", "def_third_centre", "def_third_right"]},
             {"field": "direct_speed_m_s", "op": "gte", "value": 3}],
 "order_by": {"field": "direct_speed_m_s", "dir": "desc"},
 "limit": 48,
 "explanation": "Fast phases starting in the defensive third that contained a switch of play."}""",
    ),
    (
        "goals from corners",
        """{"version": 1,
 "filters": [{"field": "start_type", "op": "eq", "value": "corner"},
             {"field": "outcome", "op": "eq", "value": "goal"}],
 "order_by": {"field": "xg", "dir": "desc"},
 "limit": 48,
 "explanation": "Corner routines that ended in a goal, best chances first."}""",
    ),
    (
        "the 20 best chances Spain created, with 360 data",
        """{"version": 1,
 "filters": [{"field": "team_name", "op": "eq", "value": "Spain"},
             {"field": "xg", "op": "gte", "value": 0.1},
             {"field": "has_360", "op": "eq", "value": true}],
 "order_by": {"field": "xg", "dir": "desc"},
 "limit": 20,
 "explanation": "Spain's highest-xG phases that carry 360 freeze frames, top 20."}""",
    ),
    (
        "Spain phases against Germany where Yamal beat two defenders",
        """{"version": 1,
 "filters": [{"field": "team_name", "op": "eq", "value": "Spain"}],
 "limit": 48,
 "explanation": "Spain's phases — the index has no opponent or player columns, so \\"against Germany\\" and the Yamal dribble were dropped."}""",
    ),
]


def _examples_block() -> str:
    return "\n\n".join(f'Request: "{text}"\nemit_phase_query input:\n{json_}' for text, json_ in EXAMPLES)


def build_system_prompt(
    teams: list[str] | None = None, competitions: list[str] | None = None
) -> str:
    """Assemble the system prompt. `teams` / `competitions` are vocabulary hints
    from the caller so the model spells `team_name` exactly as the data does."""
    vocab = ""
    if teams:
        vocab += (
            "\nTeam names present in the dataset — use these spellings verbatim for "
            "team_name:\n" + ", ".join(teams) + "\n"
        )
    if competitions:
        # phases.parquet has no competition column; the hint exists so the model
        # can recognise a competition mention and say it dropped it.
        vocab += (
            "\nCompetitions in the dataset: "
            + ", ".join(competitions)
            + ". There is NO competition column in the phase index — if the analyst "
            "names a competition, drop that part of the request and say so.\n"
        )

    return f"""You translate a football analyst's English into a PhaseQuery — the
one query language of Halfspace, a phase-search engine over StatsBomb event data.

A *phase* is one possession chain: the ball belonging to one team, from the moment
they get it to the moment they lose it, the ball goes out, or the half ends. Every
row of the search index is one phase, described entirely by the columns below.
Everything is in the attacking team's frame: the phase's team always attacks left
to right, so "final third" always means the third they are attacking.

## The shape you must emit

{{"version": {DSL_VERSION},
 "filters": [ {{"field": <column>, "op": <op>, "value": <value>}}, ... ],
 "order_by": {{"field": <numeric column>, "dir": "asc"|"desc"}},   // optional
 "limit": <{LIMIT_MIN}..{LIMIT_MAX}>,
 "explanation": "<one short sentence>"}}

Filters are ANDed. There is no OR — express alternatives with `in` over one column
({{"field": "outcome", "op": "in", "value": ["goal", "shot_on_target"]}}).

Operators: eq, neq, in, gte, lte, between.
- `in` takes a non-empty array; `between` takes exactly [low, high] with low <= high.
- gte/lte/between are numeric only. Booleans take eq/neq only. Enum and text
  columns take eq/neq/in.
- Omit `order_by` unless the analyst asked for a ranking ("best", "fastest",
  "longest", "most direct"); the default ordering is already xG then progression.
- `limit` defaults to {LIMIT_DEFAULT}; only set it when a count is asked for.

## Columns (this list is closed — never invent one)

{_field_reference()}

Pitch zones are thirds x channels in the attacking team's frame:
{', '.join(ZONES)}. Left/centre/right are from the attacking team's point of view.
A "wide" area means the left and right channels; "central" means the centre channel.

start_type values: {', '.join(START_TYPES)}.
outcome values: {', '.join(OUTCOMES)} — ordered by precedence, so a phase that ends
in a goal has outcome "goal", not "shot_on_target".

## Football vocabulary → columns

- "high turnover", "high press regain", "winning it high up" → high_press_regain.
- "counter", "counterattack", "on the break", "transition" → counterattack.
- "switch", "changed the point of attack" → switch_of_play.
- "led to a shot", "ended in a shot" → outcome in goal/shot_on_target/shot_off_target.
- "got into the box", "penalty area" → reached_box. "into the final third" →
  reached_final_third.
- "long possession", "sustained", "patient build-up" → duration_s and/or n_passes high.
- "quick", "fast", "direct", "vertical" → direct_speed_m_s high, or a low duration_s.
- "big chance", "good chance" → xg gte roughly 0.1; "shot" alone is about outcome.
- "under pressure", "pressed" → pressure_events.
- "from a corner / free kick / throw-in / goal kick / kick-off" → start_type.
- "build-up from the back" → start_type goal_kick, or start_zone in the def_third zones.

## What you cannot express

The index has no player, opponent, competition, date, scoreline or body-part
columns, and no free-text search. If part of the request needs one of those, keep
the part you *can* express, drop the rest, and say plainly in `explanation` what
you dropped. Never approximate a dropped condition with an unrelated filter, and
never return an empty filter list just because one clause was impossible.
{vocab}
## Worked examples

{_examples_block()}

Answer only by calling {TOOL_NAME}."""
