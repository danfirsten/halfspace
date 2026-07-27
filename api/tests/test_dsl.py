"""DSL validation unit tests — the guarantee that model output cannot become a
query we did not intend."""

import pytest
from pydantic import ValidationError

from dsl import (
    FIELDS,
    LIMIT_DEFAULT,
    LIMIT_MAX,
    LIMIT_MIN,
    Filter,
    OrderBy,
    PhaseField,
    PhaseQuery,
)


def test_registry_covers_every_field():
    # Guards drift between the enum and the semantics the prompt is built from.
    assert set(FIELDS) == set(PhaseField)


def test_valid_query_round_trips():
    query = PhaseQuery.model_validate(
        {
            "version": 1,
            "filters": [
                {"field": "outcome", "op": "in", "value": ["goal", "shot_on_target"]},
                {"field": "duration_s", "op": "between", "value": [0, 15]},
                {"field": "start_zone", "op": "in", "value": ["def_third_left"]},
                {"field": "high_press_regain", "op": "eq", "value": True},
                {"field": "team_name", "op": "eq", "value": "Spain"},
            ],
            "order_by": {"field": "xg", "dir": "desc"},
            "limit": 48,
        }
    )
    assert len(query.filters) == 5
    assert query.order_by.field is PhaseField.xg
    assert query.model_dump(mode="json")["filters"][0]["field"] == "outcome"


def test_defaults():
    query = PhaseQuery()
    assert query.version == 1
    assert query.filters == []
    assert query.order_by is None
    assert query.limit == LIMIT_DEFAULT


# --- fields -----------------------------------------------------------------


def test_unknown_field_rejected():
    with pytest.raises(ValidationError):
        Filter(field="pass_completion_pct", op="gte", value=0.8)


def test_unknown_op_rejected():
    with pytest.raises(ValidationError):
        Filter(field="xg", op="contains", value=0.5)


def test_unknown_enum_value_rejected():
    with pytest.raises(ValidationError) as exc:
        Filter(field="start_zone", op="eq", value="midfield")
    assert "not a valid value for start_zone" in str(exc.value)


def test_known_enum_value_accepted():
    assert Filter(field="outcome", op="eq", value="goal").value == "goal"


# --- value typing -----------------------------------------------------------


def test_string_for_numeric_field_rejected():
    with pytest.raises(ValidationError) as exc:
        Filter(field="n_passes", op="gte", value="five")
    assert "n_passes" in str(exc.value)


def test_numeric_string_is_not_coerced():
    # Strict types: "10" must not quietly become 10.
    with pytest.raises(ValidationError):
        Filter(field="duration_s", op="gte", value="10")


def test_bool_for_numeric_field_rejected():
    with pytest.raises(ValidationError) as exc:
        Filter(field="xg", op="gte", value=True)
    assert "does not accept booleans" in str(exc.value)


def test_float_for_integer_field_rejected():
    with pytest.raises(ValidationError):
        Filter(field="n_passes", op="eq", value=8.5)


def test_int_for_float_field_accepted():
    assert Filter(field="xg", op="gte", value=1).value == 1


def test_string_for_boolean_field_rejected():
    with pytest.raises(ValidationError) as exc:
        Filter(field="counterattack", op="eq", value="true")
    assert "boolean field" in str(exc.value)


def test_number_for_text_field_rejected():
    with pytest.raises(ValidationError):
        Filter(field="team_name", op="eq", value=7)


# --- operator / field-kind compatibility ------------------------------------


def test_gte_on_boolean_field_rejected():
    with pytest.raises(ValidationError) as exc:
        Filter(field="reached_box", op="gte", value=True)
    assert "not supported for reached_box" in str(exc.value)


def test_between_on_enum_field_rejected():
    with pytest.raises(ValidationError):
        Filter(field="outcome", op="between", value=["goal", "lost_ball"])


def test_in_on_enum_field_accepted():
    f = Filter(field="start_type", op="in", value=["corner", "free_kick"])
    assert f.value == ["corner", "free_kick"]


# --- op arity ---------------------------------------------------------------


@pytest.mark.parametrize("value", [[5], [1, 2, 3], 5, []])
def test_between_requires_exactly_two_values(value):
    with pytest.raises(ValidationError) as exc:
        Filter(field="duration_s", op="between", value=value)
    assert "between" in str(exc.value)


def test_between_requires_ordered_bounds():
    with pytest.raises(ValidationError) as exc:
        Filter(field="duration_s", op="between", value=[30, 10])
    assert "value[0] <= value[1]" in str(exc.value)


def test_between_accepts_ordered_bounds():
    assert Filter(field="duration_s", op="between", value=[0, 15]).value == [0, 15]


def test_in_requires_non_empty_list():
    with pytest.raises(ValidationError) as exc:
        Filter(field="outcome", op="in", value=[])
    assert "non-empty list" in str(exc.value)


def test_in_rejects_scalar():
    with pytest.raises(ValidationError):
        Filter(field="outcome", op="in", value="goal")


def test_eq_rejects_list():
    with pytest.raises(ValidationError) as exc:
        Filter(field="team_name", op="eq", value=["Spain", "England"])
    assert "single value" in str(exc.value)


# --- order_by ---------------------------------------------------------------


def test_order_by_numeric_field_accepted():
    assert OrderBy(field="progression_m", dir="asc").dir == "asc"


@pytest.mark.parametrize("field", ["counterattack", "outcome", "team_name"])
def test_order_by_non_numeric_field_rejected(field):
    with pytest.raises(ValidationError) as exc:
        OrderBy(field=field, dir="desc")
    assert "order_by must name a numeric field" in str(exc.value)


def test_order_by_direction_is_closed():
    with pytest.raises(ValidationError):
        OrderBy(field="xg", dir="descending")


# --- limit ------------------------------------------------------------------


@pytest.mark.parametrize(
    "given,expected",
    [(0, LIMIT_MIN), (-10, LIMIT_MIN), (1, 1), (20, 20), (96, 96), (500, LIMIT_MAX)],
)
def test_limit_is_clamped(given, expected):
    assert PhaseQuery(limit=given).limit == expected


def test_non_integer_limit_rejected():
    with pytest.raises(ValidationError):
        PhaseQuery(limit="lots")


# --- structural strictness --------------------------------------------------


def test_extra_keys_rejected():
    with pytest.raises(ValidationError):
        PhaseQuery.model_validate({"version": 1, "filters": [], "limit": 10, "sql": "SELECT 1"})


def test_filter_extra_keys_rejected():
    with pytest.raises(ValidationError):
        Filter.model_validate({"field": "xg", "op": "gte", "value": 0.1, "negate": True})


def test_version_is_pinned():
    with pytest.raises(ValidationError):
        PhaseQuery.model_validate({"version": 2, "filters": [], "limit": 10})
