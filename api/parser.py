"""Calls Claude and turns its answer into a validated PhaseQuery.

The contract with the model is deliberately narrow: forced tool use, one tool,
JSON in, JSON out. Whatever comes back is re-validated against the Pydantic
models before anyone sees it — model output is untrusted input.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any

from pydantic import ValidationError

from dsl import PhaseQuery
from prompt import TOOL_NAME, TOOL_SCHEMA, build_system_prompt

DEFAULT_MODEL = "claude-opus-5"
MAX_TOKENS = 2048

# Newer models reject `temperature` outright and accept `output_config.effort`
# instead. Determinism on those comes from effort=low plus forced tool use.
_NO_SAMPLING_PARAMS = ("opus-5", "opus-4-7", "opus-4-8", "sonnet-5", "fable-5", "mythos-5")


def model_name() -> str:
    return os.environ.get("HALFSPACE_MODEL") or DEFAULT_MODEL


@dataclass
class ParseFailure(Exception):
    """The model answered, but the answer is not a legal PhaseQuery."""

    reason: str
    issues: list[dict[str, Any]] = field(default_factory=list)
    raw: Any = None


class UpstreamError(Exception):
    """The Anthropic API could not be reached or errored."""


@dataclass
class ParseResult:
    query: PhaseQuery
    explanation: str


def _validation_issues(exc: ValidationError) -> list[dict[str, Any]]:
    issues = []
    for err in exc.errors():
        loc = ".".join(str(p) for p in err["loc"]) or "query"
        issues.append({"path": loc, "message": err["msg"], "type": err["type"]})
    return issues


class PhaseQueryParser:
    """Thin wrapper over the Anthropic SDK. `client` is injectable so the whole
    parse flow can be tested offline."""

    def __init__(self, client: Any | None = None, model: str | None = None) -> None:
        self.client = client
        self.model = model or model_name()

    @property
    def available(self) -> bool:
        return self.client is not None

    def _request_kwargs(self) -> dict[str, Any]:
        if any(tag in self.model for tag in _NO_SAMPLING_PARAMS):
            return {"output_config": {"effort": "low"}}
        return {"temperature": 0}

    def parse(
        self,
        text: str,
        teams: list[str] | None = None,
        competitions: list[str] | None = None,
    ) -> ParseResult:
        system = build_system_prompt(teams=teams, competitions=competitions)
        try:
            message = self.client.messages.create(
                model=self.model,
                max_tokens=MAX_TOKENS,
                system=system,
                tools=[TOOL_SCHEMA],
                tool_choice={"type": "tool", "name": TOOL_NAME},
                messages=[{"role": "user", "content": text}],
                **self._request_kwargs(),
            )
        except Exception as exc:  # network, auth, rate limit, refusal-shaped errors
            raise UpstreamError(str(exc)) from exc

        if getattr(message, "stop_reason", None) == "refusal":
            raise ParseFailure(reason="model_refused")

        payload = _extract_tool_input(message)
        if payload is None:
            raise ParseFailure(
                reason="model_did_not_emit_query",
                issues=[{"path": "query", "message": f"no {TOOL_NAME} tool call in response"}],
            )
        if not isinstance(payload, dict):
            raise ParseFailure(reason="model_did_not_emit_query", raw=payload)

        explanation = payload.pop("explanation", "") or ""
        try:
            query = PhaseQuery.model_validate(payload)
        except ValidationError as exc:
            raise ParseFailure(
                reason="invalid_query",
                issues=_validation_issues(exc),
                raw=payload,
            ) from exc

        return ParseResult(query=query, explanation=str(explanation).strip())


def _extract_tool_input(message: Any) -> Any:
    for block in getattr(message, "content", []) or []:
        if getattr(block, "type", None) == "tool_use" and getattr(block, "name", None) == TOOL_NAME:
            return getattr(block, "input", None)
    return None


_shared: Any | None = None


def anthropic_client() -> Any | None:
    """Return a cached Anthropic client, or None when no key is configured.

    A missing key is not an error here — /parse turns it into a 503 so the web
    app can degrade to its offline heuristic parser.
    """
    global _shared
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return None
    if _shared is None:
        import anthropic

        _shared = anthropic.Anthropic()
    return _shared
