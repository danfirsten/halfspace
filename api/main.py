"""Halfspace API — two endpoints, no state, no database.

GET  /health  liveness + which model and DSL version this deployment speaks.
POST /parse   English → validated PhaseQuery JSON.

The web app is fully functional without this service: presets and the filter
builder produce the same DSL, and a 503 from /parse is the signal to fall back to
the browser's deterministic keyword parser.
"""

from __future__ import annotations

import os

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from dsl import DSL_VERSION, PhaseQuery
from parser import (
    ParseFailure,
    PhaseQueryParser,
    UpstreamError,
    anthropic_client,
    model_name,
)

app = FastAPI(
    title="Halfspace API",
    version="0.1.0",
    description="Natural language to PhaseQuery DSL for the Halfspace phase-search engine.",
)

# The demo front end is a static GitHub Pages site on a different origin, so CORS
# has to be permissive; it is also read-only and unauthenticated, so there is
# nothing to protect. Credentials stay off, which is what lets '*' be legal.
_origins = [o.strip() for o in os.environ.get("HALFSPACE_CORS_ORIGINS", "*").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins or ["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


class ParseContext(BaseModel):
    """Optional vocabulary hints so the model spells names the way the data does."""

    model_config = ConfigDict(extra="ignore")

    teams: list[str] = Field(default_factory=list)
    competitions: list[str] = Field(default_factory=list)


class ParseRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    text: str
    context: ParseContext | None = None


class ParseResponse(BaseModel):
    query: PhaseQuery
    explanation: str


class HealthResponse(BaseModel):
    status: str
    model: str
    dsl_version: int


def get_parser() -> PhaseQueryParser:
    return PhaseQueryParser(client=anthropic_client())


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok", model=model_name(), dsl_version=DSL_VERSION)


@app.post("/parse", response_model=ParseResponse)
def parse(
    request: ParseRequest, parser: PhaseQueryParser = Depends(get_parser)
) -> ParseResponse | JSONResponse:
    text = request.text.strip()
    if not text:
        return JSONResponse(
            status_code=422,
            content={
                "error": "empty_request",
                "message": "text must be a non-empty query",
                "issues": [{"path": "text", "message": "must not be empty"}],
            },
        )

    if not parser.available:
        return JSONResponse(
            status_code=503,
            content={
                "error": "llm_unavailable",
                "message": (
                    "ANTHROPIC_API_KEY is not configured; natural-language parsing "
                    "is disabled on this deployment."
                ),
                "fallback": "heuristic",
            },
        )

    ctx = request.context or ParseContext()
    try:
        result = parser.parse(text, teams=ctx.teams, competitions=ctx.competitions)
    except ParseFailure as failure:
        return JSONResponse(
            status_code=422,
            content={
                "error": failure.reason,
                "message": "the request could not be turned into a valid PhaseQuery",
                "issues": failure.issues,
                "raw": failure.raw,
            },
        )
    except UpstreamError as exc:
        return JSONResponse(
            status_code=502,
            content={
                "error": "upstream_error",
                "message": str(exc),
                "fallback": "heuristic",
            },
        )

    return ParseResponse(query=result.query, explanation=result.explanation)
