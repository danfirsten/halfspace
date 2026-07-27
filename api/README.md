# Halfspace API

Optional natural-language front door to the Halfspace phase-search engine. Two
endpoints, no database, no state. The web app is fully functional without this
service — presets and the visual filter builder produce the same DSL, and a 503
here is the web app's signal to fall back to its offline keyword parser.

## Run

```bash
cd api
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

export ANTHROPIC_API_KEY=sk-ant-...          # optional; without it /parse returns 503
.venv/bin/uvicorn main:app --reload --port 8000
```

Tests (offline, no API key needed):

```bash
cd api && .venv/bin/python -m pytest -q
```

## Environment

| Variable                 | Default          | Meaning |
|--------------------------|------------------|---------|
| `ANTHROPIC_API_KEY`      | —                | Unset ⇒ `/parse` returns **503** with `{"fallback": "heuristic"}`. `/health` still returns 200. |
| `HALFSPACE_MODEL`        | `claude-opus-5`  | Model used for parsing; echoed by `/health`. |
| `HALFSPACE_CORS_ORIGINS` | `*`              | Comma-separated allowed origins. Read-only, unauthenticated API, credentials off. |

## Endpoints

### `GET /health`

```json
{ "status": "ok", "model": "claude-opus-5", "dsl_version": 1 }
```

### `POST /parse`

```bash
curl -s localhost:8000/parse -H 'content-type: application/json' -d '{
  "text": "high turnovers by England that led to a shot",
  "context": {"teams": ["England", "Spain"], "competitions": ["UEFA Euro 2024"]}
}'
```

```json
{
  "query": {
    "version": 1,
    "filters": [
      {"field": "high_press_regain", "op": "eq", "value": true},
      {"field": "team_name", "op": "eq", "value": "England"},
      {"field": "outcome", "op": "in", "value": ["goal", "shot_on_target", "shot_off_target"]}
    ],
    "order_by": null,
    "limit": 48
  },
  "explanation": "England phases that began with a high regain and ended in a shot."
}
```

`context` is optional. It carries vocabulary hints only — team names so the model
spells `team_name` exactly as the data does, and competition names so it can
*recognise* a competition and tell the user it dropped that clause (there is no
competition column in the phase index).

Failure shapes:

| Status | `error`                              | When |
|--------|--------------------------------------|------|
| 422    | `empty_request`                      | Blank `text`. |
| 422    | `invalid_query`                      | The model emitted DSL that failed validation. `issues[]` names the offending path. |
| 422    | `model_did_not_emit_query`           | The model answered with prose instead of calling the tool. |
| 422    | `model_refused`                      | `stop_reason: "refusal"`. |
| 502    | `upstream_error`                     | Anthropic API unreachable or errored. Body carries `"fallback": "heuristic"`. |
| 503    | `llm_unavailable`                    | No API key configured. Body carries `"fallback": "heuristic"`. |

## Why the model emits a DSL and never SQL

The obvious design is to hand the model the table schema and let it write SQL.
It is also the design that cannot be made safe or debuggable. SQL is an
unbounded language: any string the model produces is a candidate program, so
"was this query correct?" becomes a question you can only answer by reading it,
and "could this query do something I did not intend?" has no cheap answer at
all. PhaseQuery is deliberately tiny — a closed enum of columns drawn from
`phases.parquet`, six operators, typed values, one optional sort, a limit
clamped to 1..96. That smallness buys three things. **It is checkable**: the
model's output goes back through the same Pydantic models the visual filter
builder is validated against (`api/dsl.py`, mirrored by `web/src/dsl/schema.ts`),
so a hallucinated column or a `gte` on a boolean is a 422 with a named path, not
a runtime error or, worse, a plausible wrong answer. **It is explainable**: the
DSL renders back to the analyst as human-readable chips before they see results,
so "what did it understand?" is always on screen — you cannot show a non-expert
a SQL string and call that transparency. **It is substitutable**: because the
query language is not the model's output format but the app's own, the browser's
deterministic keyword parser emits exactly the same object, which is what makes
the API genuinely optional rather than nominally optional.

Compilation to SQL happens once, deterministically, in
`web/src/dsl/compile.ts` — code that is tested, reviewed, and identical for
every query regardless of where the query came from. The LLM's job is narrowed
to the thing it is actually good at: mapping "high turnover leading to a shot"
onto the right two columns.

## Limitations (honest)

- `phases.parquet` has no player, opponent, competition, date, scoreline or
  body-part columns. Requests naming those are partially dropped, and the
  `explanation` says so — the API never silently approximates them.
- Filters are conjunctive only. There is no OR across different columns; the
  `in` operator covers alternatives within a single column.
- No caching, no rate limiting, no auth. This is a demo service in front of a
  static site.
