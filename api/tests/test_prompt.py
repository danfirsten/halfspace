"""The few-shot examples are part of the contract: if one of them is not itself a
valid PhaseQuery we are teaching the model to fail validation."""

import json

from dsl import (
    COMPETITIONS,
    FIELDS,
    START_TYPES,
    ZONES,
    Op,
    PhaseField,
    PhaseQuery,
    sortable_fields,
)
from prompt import EXAMPLES, TOOL_NAME, TOOL_SCHEMA, build_system_prompt


def test_every_example_is_a_valid_phase_query():
    for text, raw in EXAMPLES:
        payload = json.loads(raw)
        explanation = payload.pop("explanation")
        assert explanation, f"example {text!r} has no explanation"
        PhaseQuery.model_validate(payload)


def test_examples_cover_the_documented_cases():
    prompts = [text for text, _ in EXAMPLES]
    assert len(prompts) >= 6
    joined = " ".join(prompts).lower()
    for phrase in ("high turnover", "long possession", "counterattack", "goal kick", "euro 2024"):
        assert phrase in joined


def test_a_competition_ask_maps_to_the_competition_filter():
    example = next(
        json.loads(raw) for text, raw in EXAMPLES if "Euro 2024" in text
    )
    competition = next(f for f in example["filters"] if f["field"] == "competition")
    assert competition == {"field": "competition", "op": "eq", "value": "Euro 2024"}


def test_unsupported_ask_example_drops_the_impossible_part():
    text, raw = EXAMPLES[-1]
    payload = json.loads(raw)
    fields = {f["field"] for f in payload["filters"]}
    assert fields == {"team_name"}  # no opponent or player columns exist
    assert "dropped" in payload["explanation"]


def test_tool_schema_field_enum_matches_the_dsl():
    props = TOOL_SCHEMA["input_schema"]["properties"]
    assert TOOL_SCHEMA["name"] == TOOL_NAME
    assert props["filters"]["items"]["properties"]["field"]["enum"] == [
        f.value for f in PhaseField
    ]
    assert props["filters"]["items"]["properties"]["op"]["enum"] == [o.value for o in Op]
    assert props["order_by"]["properties"]["field"]["enum"] == [
        f.value for f in sortable_fields()
    ]


def test_prompt_documents_every_field_and_enum_value():
    system = build_system_prompt()
    for field in FIELDS:
        assert field.value in system
    for zone in ZONES:
        assert zone in system
    for start_type in START_TYPES:
        assert start_type in system
    for competition in COMPETITIONS:
        assert competition in system


def test_competition_hint_points_at_the_column():
    system = build_system_prompt(competitions=list(COMPETITIONS))
    assert "`competition` column" in system
    # Player and opponent asks are still dropped; competition no longer is.
    assert "no player, opponent, date, scoreline" in system
