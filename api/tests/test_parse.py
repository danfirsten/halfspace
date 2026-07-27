"""End-to-end /parse tests with a fake Anthropic client. No network, no API key."""

from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import parser as parser_module
from dsl import LIMIT_MAX
from main import app, get_parser
from parser import PhaseQueryParser
from prompt import TOOL_NAME

VALID_PAYLOAD = {
    "version": 1,
    "filters": [
        {"field": "high_press_regain", "op": "eq", "value": True},
        {"field": "outcome", "op": "in", "value": ["goal", "shot_on_target"]},
    ],
    "limit": 48,
    "explanation": "Phases starting with a high regain that ended in a shot.",
}


class FakeMessages:
    def __init__(self, blocks, stop_reason="tool_use"):
        self._blocks = blocks
        self._stop_reason = stop_reason
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(content=self._blocks, stop_reason=self._stop_reason)


class FakeClient:
    """Mimics the shape of `anthropic.Anthropic` that the parser actually touches."""

    def __init__(self, tool_input=None, blocks=None, stop_reason="tool_use", name=TOOL_NAME):
        if blocks is None:
            blocks = [SimpleNamespace(type="tool_use", name=name, id="toolu_1", input=tool_input)]
        self.messages = FakeMessages(blocks, stop_reason=stop_reason)


def client_with(fake) -> TestClient:
    app.dependency_overrides[get_parser] = lambda: PhaseQueryParser(
        client=fake, model="claude-opus-5"
    )
    return TestClient(app)


@pytest.fixture(autouse=True)
def _clear_overrides():
    yield
    app.dependency_overrides.clear()


# --- health -----------------------------------------------------------------


def test_health(monkeypatch):
    monkeypatch.setenv("HALFSPACE_MODEL", "claude-opus-5")
    body = TestClient(app).get("/health").json()
    assert body == {"status": "ok", "model": "claude-opus-5", "dsl_version": 1}


def test_health_reports_configured_model(monkeypatch):
    monkeypatch.setenv("HALFSPACE_MODEL", "claude-sonnet-5")
    assert TestClient(app).get("/health").json()["model"] == "claude-sonnet-5"


# --- happy path -------------------------------------------------------------


def test_parse_returns_validated_query_and_explanation():
    fake = FakeClient(tool_input=dict(VALID_PAYLOAD))
    response = client_with(fake).post("/parse", json={"text": "high turnovers leading to a shot"})

    assert response.status_code == 200
    body = response.json()
    assert body["query"]["version"] == 1
    assert body["query"]["filters"][0] == {
        "field": "high_press_regain",
        "op": "eq",
        "value": True,
    }
    assert body["query"]["limit"] == 48
    assert body["explanation"].startswith("Phases starting")
    # `explanation` is stripped out of the query object, not smuggled into it.
    assert "explanation" not in body["query"]


def test_parse_forces_the_tool_and_sends_the_dsl_prompt():
    fake = FakeClient(tool_input=dict(VALID_PAYLOAD))
    client_with(fake).post(
        "/parse",
        json={"text": "counterattacks by England", "context": {"teams": ["England", "Spain"]}},
    )

    kwargs = fake.messages.calls[0]
    assert kwargs["tool_choice"] == {"type": "tool", "name": TOOL_NAME}
    assert kwargs["tools"][0]["name"] == TOOL_NAME
    assert "PhaseQuery" in kwargs["system"]
    assert "high_press_regain" in kwargs["system"]
    assert "England" in kwargs["system"]
    assert kwargs["messages"] == [{"role": "user", "content": "counterattacks by England"}]
    # Opus 5 rejects `temperature`; determinism comes from effort + forced tool use.
    assert "temperature" not in kwargs
    assert kwargs["output_config"] == {"effort": "low"}


def test_legacy_model_still_gets_temperature_zero():
    fake = FakeClient(tool_input=dict(VALID_PAYLOAD))
    app.dependency_overrides[get_parser] = lambda: PhaseQueryParser(
        client=fake, model="claude-haiku-4-5"
    )
    TestClient(app).post("/parse", json={"text": "goals from corners"})

    kwargs = fake.messages.calls[0]
    assert kwargs["temperature"] == 0
    assert "output_config" not in kwargs


def test_competition_filter_survives_validation():
    payload = {
        "version": 1,
        "filters": [
            {"field": "counterattack", "op": "eq", "value": True},
            {"field": "competition", "op": "eq", "value": "Euro 2024"},
        ],
        "limit": 48,
        "explanation": "Counterattacks from the Euro 2024 tournament.",
    }
    fake = FakeClient(tool_input=payload)
    response = client_with(fake).post(
        "/parse",
        json={"text": "counterattacks at Euro 2024", "context": {"competitions": ["Euro 2024"]}},
    )

    assert response.status_code == 200
    assert response.json()["query"]["filters"][1] == {
        "field": "competition",
        "op": "eq",
        "value": "Euro 2024",
    }
    assert "`competition` column" in fake.messages.calls[0]["system"]


def test_parse_repairs_an_out_of_range_limit():
    payload = dict(VALID_PAYLOAD, limit=500)
    response = client_with(FakeClient(tool_input=payload)).post(
        "/parse", json={"text": "every counterattack ever"}
    )
    assert response.status_code == 200
    assert response.json()["query"]["limit"] == LIMIT_MAX


# --- rejecting bad model output ---------------------------------------------


def test_hallucinated_field_is_rejected_not_passed_through():
    payload = {
        "version": 1,
        "filters": [{"field": "pass_completion_pct", "op": "gte", "value": 0.9}],
        "limit": 48,
        "explanation": "made up a column",
    }
    response = client_with(FakeClient(tool_input=payload)).post(
        "/parse", json={"text": "high pass completion phases"}
    )

    assert response.status_code == 422
    body = response.json()
    assert body["error"] == "invalid_query"
    assert body["issues"]
    assert "filters.0" in body["issues"][0]["path"]


def test_bad_value_type_from_model_is_rejected():
    payload = {
        "version": 1,
        "filters": [{"field": "duration_s", "op": "gte", "value": "twenty"}],
        "limit": 48,
        "explanation": "",
    }
    response = client_with(FakeClient(tool_input=payload)).post(
        "/parse", json={"text": "possessions over twenty seconds"}
    )
    assert response.status_code == 422
    assert response.json()["error"] == "invalid_query"


def test_model_answering_with_prose_instead_of_the_tool():
    blocks = [SimpleNamespace(type="text", text="I would run: SELECT * FROM phases")]
    response = client_with(FakeClient(blocks=blocks, stop_reason="end_turn")).post(
        "/parse", json={"text": "show me everything"}
    )
    assert response.status_code == 422
    assert response.json()["error"] == "model_did_not_emit_query"


def test_model_refusal_is_reported():
    response = client_with(FakeClient(blocks=[], stop_reason="refusal")).post(
        "/parse", json={"text": "anything"}
    )
    assert response.status_code == 422
    assert response.json()["error"] == "model_refused"


def test_upstream_error_becomes_502_with_fallback_hint():
    class Boom:
        class messages:
            @staticmethod
            def create(**kwargs):
                raise RuntimeError("connection reset")

    response = client_with(Boom()).post("/parse", json={"text": "counterattacks"})
    assert response.status_code == 502
    assert response.json()["fallback"] == "heuristic"


def test_empty_text_rejected():
    response = client_with(FakeClient(tool_input=dict(VALID_PAYLOAD))).post(
        "/parse", json={"text": "   "}
    )
    assert response.status_code == 422
    assert response.json()["error"] == "empty_request"


# --- degraded mode ----------------------------------------------------------


def test_parse_returns_503_without_an_api_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setattr(parser_module, "_shared", None)

    response = TestClient(app).post("/parse", json={"text": "counterattacks by England"})

    assert response.status_code == 503
    body = response.json()
    assert body["error"] == "llm_unavailable"
    assert body["fallback"] == "heuristic"


def test_health_still_ok_without_an_api_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert TestClient(app).get("/health").json()["status"] == "ok"
