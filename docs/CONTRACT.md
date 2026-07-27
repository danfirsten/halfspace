# Halfspace — build contract

This document is the single source of truth that every component is built against.
If a component needs to deviate, this file gets updated first, then the component.

Status: DRAFT — schema sections marked TBC are finalized after `docs/statsbomb-notes.md` lands.

---

## 1. Repository layout

```
ingest/          Python 3.11+. Polars + DuckDB. Offline pipeline:
                 raw StatsBomb JSON → possession chains → phases → Parquet.
                 Never runs in production. `uv` or plain pip + requirements.txt.
                 Tests in ingest/tests/ (pytest, hypothesis where it fits).

web/             TypeScript + React + Vite. DuckDB-WASM queries Parquet in the
                 browser. No backend required for any core feature.
                 Data artifacts live in web/public/data/ (committed).

api/             FastAPI. Optional. Two endpoints only:
                   POST /parse  — natural language → PhaseQuery DSL JSON
                   GET  /health
                 The web app must be fully functional when this is absent.

docs/            statsbomb-notes.md (data reference), CONTRACT.md (this file),
                 phase-definitions.md (plain-English football definitions).

.github/workflows/  deploy.yml — build web/ + publish to GitHub Pages.
```

## 2. Data artifacts (produced by ingest, consumed by web)

All Parquet, zstd-compressed, written to `web/public/data/`.

| File | Purpose | Budget |
|---|---|---|
| `phases.parquet` | One row per phase. The search index. Loaded eagerly at startup. | < 6 MB |
| `phase_events.parquet` | Per-phase event sequences for animation (ball path, event markers). | lazy-loaded |
| `phase_frames.parquet` | 360 freeze-frame player positions keyed by phase + event. | lazy-loaded |
| `matches.parquet` | Match metadata (teams, score, date, competition, stadium). | tiny |
| `similarity.parquet` | Phase feature vectors (fixed-length float list) for cosine similarity. | < 8 MB |
| `manifest.json` | Dataset version, row counts, build timestamp, attribution string. | tiny |

Lazy files may be sharded per match (`phase_events/{match_id}.parquet`) if needed to
keep single-fetch sizes sensible; the web data layer treats the manifest as the map.

### phases.parquet — schema (TBC exact columns after research; contract shape below)

Identity: `phase_id` (string, stable, sortable: `{match_id}-{seq}`), `match_id`,
`possession` (StatsBomb possession number), `team_id`, `team_name`, `period`,
`start_ts` / `end_ts` (seconds into period, float), `minute`.

Features (every one must be documented in plain English in docs/phase-definitions.md):
- `start_zone`, `end_zone` — pitch thirds × channels (see §4 zones)
- `duration_s`, `n_passes`, `n_events`, `n_players`
- `start_type` — enum: kick_off | goal_kick | corner | free_kick | throw_in |
  turnover_open_play | regular (derived from play_pattern + first event)
- `outcome` — enum: goal | shot_on_target | shot_off_target | lost_ball |
  out_of_play | foul_won | end_of_period (ordered by precedence)
- `progression_m` — net upfield ball progression in metres (StatsBomb x units)
- `direct_speed_m_s` — upfield progression / duration
- `pressure_events` — count of opponent Pressure events during the phase
- `high_press_regain` (bool), `counterattack` (bool), `switch_of_play` (bool),
  `reached_final_third` (bool), `reached_box` (bool) — each per docs/phase-definitions.md
- `xg` — max shot xG in phase (0 if none)
- `has_360` (bool), `frame_coverage` (float 0-1: fraction of events with a 360 frame)

### Coordinates

Everything downstream of ingest uses ONE frame: StatsBomb event coordinates,
120 × 80, attacking left → right for the phase's team. Ingest normalizes all
geometry (including 360 frames and the opposition) into the acting team's
attacking-right frame. The web app never flips coordinates.

## 3. PhaseQuery DSL

The one query language. The visual filter builder produces it, the NL path
produces it, presets are instances of it. JSON, validated by a Zod schema in
`web/src/dsl/schema.ts` (mirrored by a Pydantic model in `api/`). Compiled to
SQL deterministically by `web/src/dsl/compile.ts` — the LLM never writes SQL.

```jsonc
{
  "version": 1,
  "filters": [
    // conjunctive list; each filter is one of:
    { "field": "outcome", "op": "in", "value": ["goal", "shot_on_target"] },
    { "field": "duration_s", "op": "between", "value": [0, 15] },
    { "field": "start_zone", "op": "in", "value": ["def_third_left", "def_third_centre"] },
    { "field": "high_press_regain", "op": "eq", "value": true },
    { "field": "team_name", "op": "eq", "value": "Spain" }
  ],
  "order_by": { "field": "xg", "dir": "desc" },   // optional; default relevance = xg desc, then progression
  "limit": 48                                       // clamped 1..96
}
```

Ops: `eq`, `neq`, `in`, `gte`, `lte`, `between`. Fields are a closed enum drawn
from phases.parquet columns. Unknown field/op/value → validation error shown in
UI, never silently dropped. The UI always renders the active query back to the
user as human-readable chips ("what it understood").

## 4. Zones

Pitch split 3 × 3: thirds (defensive / middle / final) × channels (left /
centre / right), in the attacking team's frame. y < 26.67 is LEFT from the
attacking team's perspective (verify against spec orientation in research notes).
Enum values: `def_third_left`, `def_third_centre`, ... `final_third_right`.
Box detection uses the real penalty-area geometry from the spec, not zones.

## 5. Design system (web)

Restrained, dark, broadcast-analysis-desk. The pitch is the hero.

- Background `#0e1114`, surface `#161a1e`, hairlines `#262c31`.
- Text: `#e8eaec` primary, `#8b949e` secondary. One accent for interactive
  elements: desaturated teal `#3fb6a8`. Ball highlight: `#f5c451`. Team A/B on
  pitch: `#e8eaec` vs `#5b8dd9` (never red-vs-green; colourblind-safe).
- NO club branding of any kind. No red/white Arsenal palette.
- Typography: Inter (UI) via self-hosted woff2, tabular numerals for stats.
- Pitch: correct 120×80 proportions, full markings (boxes, six-yard, D, arcs,
  spots, centre circle), attacking direction always shown with an explicit arrow
  + label. Line colour `#3a444c` on `#101820`-family turf. No gradient turf.
- Animation: requestAnimationFrame, linear ball interpolation between event
  locations with slight ease; player dots from 360 frames shown at frame times
  with short cross-fades — never fabricate positions between frames beyond a
  short tween; if coverage is sparse, dots hold-and-fade honestly.
- Charts: Altair-generated Vega-Lite specs rendered client-side (vega-embed)
  with the same palette. Used for real summaries (zone distributions, outcome
  mixes), not decoration.
- Responsive: grid collapses 4 → 2 → 1 columns; player works portrait.

## 6. Performance budgets (hard requirements, measured and reported in README)

- First meaningful paint < 2s cold on GitHub Pages (throttled "Fast 3G" not
  required; standard broadband assumption, but measure and state conditions).
- Any DSL query over phases.parquet < 300 ms in-browser.
- Eager payload: app JS + phases.parquet + matches.parquet only. DuckDB-WASM
  loaded async; a skeleton UI with the pitch renders before WASM is ready.

## 7. Similarity ("find similar")

Offline: ingest writes an L2-normalized feature vector per phase
(standardized numeric features + one-hot enums + a coarse 12-step resampled
ball-trajectory encoding). Client computes cosine similarity via DuckDB SQL
(list_dot_product over `similarity.parquet`) — no server. P2 learned encoder
only if it beats this on a held-out eval.

## 8. Natural language path

`api/` uses the Claude API (model `claude-opus-5`) with the DSL JSON schema as
a tool/structured-output contract; temperature 0. The web app also ships a
small deterministic keyword parser (`web/src/dsl/heuristic.ts`) used when the
API is unreachable — presets and filter builder guarantee full functionality
regardless. The parsed DSL is ALWAYS shown to the user before/with results.

## 9. Rules that bind every agent

- Verify football definitions against docs/statsbomb-notes.md; never guess schema.
- Every derived feature documented in plain English in docs/phase-definitions.md.
- No fabricated numbers anywhere (README included) — only measured/queried values.
- Tests for: coordinate transforms, possession segmentation, feature derivation,
  DSL validation + compilation. Not exhaustive UI tests.
- Commit messages: real, descriptive, present tense. NO AI attribution,
  NO Co-Authored-By trailers, NO "Generated with" footers.
- StatsBomb attribution exactly as the licence requires: app footer + README.
- Cut rather than fake; note honest limitations in README.
