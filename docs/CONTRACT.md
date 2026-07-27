# Halfspace — build contract

This document is the single source of truth that every component is built against.
If a component needs to deviate, this file gets updated first, then the component.

Status: FINAL — grounded in `docs/statsbomb-notes.md` (verified against spec PDFs + real data).

## 0. Dataset (decided)

**UEFA Euro 2024 (comp 55, season 282) + UEFA Euro 2020 (comp 55, season 43).**
102 matches, 102/102 with real 360 files (measured 82–92% of events carry a frame,
shots 100%). Raw download ≈ 1.1 GB — stays in the scratchpad, never in the repo
(licence clause 1.2.1 forbids redistribution; no raw-data export features either).
Penalty shootouts (`period == 5`) are excluded — degenerate one-shot possessions.

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

Identity: `phase_id` (string, stable, sortable: `{match_id}-{seq}`, seq
zero-padded to 4), `match_id`, `possession` (StatsBomb possession number),
`team_id`, `team_name`, `opponent_id`, `opponent_name`, `period`,
`start_ts` / `end_ts` (seconds into period, float), `abs_start_s` (seconds from
kick-off), `minute`, `second`.

Match labels live in **`matches.parquet.label`** (e.g.
`Spain 2–1 England · Euro 2024 Final`) and are also denormalized onto every
phase as **`match_label`** plus **`competition`** (§3b), so the results grid can
render a card without a join. Dictionary encoding makes the duplication free.

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
- `n_shots` (int), `start_x`/`start_y`/`end_x`/`end_y`/`max_x` — the ball path's
  endpoints and high-water mark, in the canonical frame
- `goal_conceded` (bool) — the chain ended in a goal for the team that did NOT
  own it. Six phases in the dataset: the ball changed hands and went in without
  StatsBomb opening a new possession (Bajrami's 23-second goal against Italy is
  one). They cannot be `outcome = 'goal'` without crediting the wrong team, and
  with this flag every goal in the source data is accounted for exactly once:
  `raw goals = count(outcome='goal') + count(goal_conceded)`.
- `path_xy` — **list<float32> of 40 values** `[x0,y0,x1,y1,…,x19,y19]`: the
  phase's ball trajectory resampled to 20 points **evenly spaced by arc length**,
  in the canonical frame, endpoints pinned exactly to `start_x/y` and `end_x/y`.
  It lets the results grid animate up to 96 thumbnails from the eager index with
  no per-phase fetch. Stored as plain float32 in StatsBomb x/y units — no
  quantization was needed: `phases.parquet` including `path_xy` measures
  2.90 MB against the 6 MB budget.

> **Unit note (see §3b).** `progression_m` / `direct_speed_m_s` are true metres
> and metres per second, converted from StatsBomb's nominal yards at 0.9144
> m/yard on x-axis deltas. Everything else — `start_x`, `end_x`, `max_x`,
> `path_xy`, and all coordinates in `phase_events` / `phase_frames` — stays in
> StatsBomb 120 × 80 units, because that is the frame the pitch is drawn in.

### Coordinates

Everything downstream of ingest uses ONE frame: StatsBomb event coordinates,
120 × 80, attacking left → right for the **phase's team** (possession_team).
Ingest normalizes all geometry into that frame. The web app never flips
coordinates. Binding facts from docs/statsbomb-notes.md:

- Every raw event location is in the *acting team's* attacking frame; mirroring
  a location into the other team's frame is `(120.1 − x, 80.1 − y)` — NOT 120/80
  (locations sit on a 0.1-offset grid; verified exact on cross-team event pairs).
- ~5% of 360 freeze frames are oriented to the opponent of the event's team
  (paired duel-type events). Ingest must run the actor-position orientation
  detector from statsbomb-notes.md before normalizing, per frame.
- Freeze-frame coordinates legitimately fall outside the pitch (observed
  x ∈ [−2.5, 123.5], y ∈ [−6.6, 89.5]); clamp only at render time, never assert.
- Possession chains are segmented on `(match_id, period, possession)` — raw
  possession numbers span half boundaries. Possession 1 stubs (Starting XI /
  Half Start only) are dropped. ~1 in 3 possession increments is a restart to
  the same team, not a turnover — `start_type` derivation must use the first
  meaningful event + play_pattern, not the increment itself.
- `counterpress` is a top-level event field (spec wrongly says nested).

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

## 3b. Pinned cross-component decisions (added after api/ build)

- Zone enum, all nine values, exactly: `def_third_left`, `def_third_centre`,
  `def_third_right`, `mid_third_left`, `mid_third_centre`, `mid_third_right`,
  `final_third_left`, `final_third_centre`, `final_third_right`.
- `match_id` is int64 everywhere; `phase_id` is string `{match_id}-{seq}`.
- phases.parquet additionally carries a denormalized `competition` column
  (values: `"Euro 2020"`, `"Euro 2024"`) so it is DSL-filterable; the DSL field
  enum includes it (op: eq/in).
- `order_by: null` means the compiler applies the composite default ordering
  (xg desc, progression_m desc); the DSL itself stays single-key.
- `progression_m` IS metres: StatsBomb x units are nominal yards; ingest
  converts with 0.9144 m/yard (x-axis deltas only). `direct_speed_m_s`
  = progression_m / duration_s. Documented in phase-definitions.md.
- LLM calls: modern Claude models reject `temperature`; api/ uses low-effort
  output config instead. §8's "temperature 0" is amended to "deterministic
  config appropriate to the model".

## 4. Zones

Pitch split 3 × 3: thirds (defensive / middle / final) × channels (left /
centre / right), in the attacking team's frame. y < 26.67 is LEFT from the
attacking team's perspective (verify against spec orientation in research notes).
Enum values: `def_third_left`, `def_third_centre`, ... `final_third_right`.
Box detection uses the real penalty-area geometry from the spec, not zones.

## 5. Design system (web) — "Ice & Ink"

Restrained, dark, broadcast-analysis-desk. The pitch is the hero. Every grey
carries a few points of blue, because the pitch is the coldest thing on the
page and the chrome belongs to it rather than sitting beside it.

- Surfaces: background `#0a0d11`, surface `#12171c`, raised surface `#1a2027`,
  hairline `#2b333b`, lit hairline `#465360`. Floating things (popovers,
  tooltips) sit on `#0d1319`; the footer on `#070a0d`.
- Text, three tiers and one non-text tier: `#f0f3f6` primary, `#9aa5b1`
  secondary, `#8e99a5` muted, `#525d68` for marks only (separators, dashes,
  disabled glyphs — never a word). Every text tier clears **4.5:1 on every
  surface it can land on**, screen and print, verified programmatically.
- One accent, ice blue `#7cc7e8`, with `#2c6f8d` as its solid-fill step and
  four fixed washes (0.06 / 0.09 / 0.12 / 0.30 alpha). Nothing may invent a
  fifth. The accent also has to survive being set as text: 8.7:1 at worst.
- Ball highlight: gold `#f5c451` — the only warm colour on the page, and it
  belongs to the ball. Ice and gold are 45 ΔE00 apart, 51 under deuteranopia,
  so "the accent" and "the ball" can never be read as the same thing.
- Team A/B on the pitch: `#eef2f6` vs indigo `#6d78e0` (never red-vs-green).
  The away shirt moved off cornflower when the accent became a blue — indigo
  holds ≥ 19.7 ΔE00 from the accent and ≥ 38 from team A under protanopia and
  deuteranopia. **Every pair of pitch marks stays above 15 ΔE00 under protan,
  deutan and tritan simulation**; this is a build-time check, not a judgement.
- Print inverts the whole token surface, not a subset of it: ink blue `#1d7396`
  for the accent, `#8f5308` for the ball, violet-indigo `#3d2f9e` for team B
  (the darker print accent converges with the screen indigo under deuteranopia,
  so it moves too). Same 4.5:1 and 15 ΔE00 bars on white.
- NO club branding of any kind. No red/white Arsenal palette.
- Typography — three families, three jobs, no overlap, all self-hosted woff2
  subset to latin:
  - **Inter** 400/500 is the interface: controls, paragraphs, labels that are
    sentences. The one you stop noticing.
  - **Space Grotesk** 500/600/700 is the voice: wordmark (700, tracked
    -0.035em), section and dialog titles (600, -0.025em), card titles (600,
    -0.02em), uppercase eyebrow keys (500). Set tighter than Inter would be,
    because its counters are wider.
  - **IBM Plex Mono** 400/500/600 carries every number — `.num` on the span,
    at 1.04em to correct for its shorter x-height. Stats belong in columns, and
    a phase id read off the screen and typed into a terminal should look the
    same in both places; `font-variant-numeric` on a proportional face only
    ever got half of that.
- Pitch: correct 120×80 proportions, full markings (boxes, six-yard, D, arcs,
  spots, centre circle), attacking direction always shown with an explicit arrow
  + label. Line colour `#44515c` on `#0c141b` turf. No gradient turf.
- Animation: requestAnimationFrame, linear ball interpolation between event
  locations with slight ease; player dots from 360 frames shown at frame times
  with short cross-fades — never fabricate positions between frames beyond a
  short tween; if coverage is sparse, dots hold-and-fade honestly.
- Charts: Altair-generated Vega-Lite specs rendered client-side (vega-embed)
  with the same palette and the same three faces — titles in Space Grotesk,
  axis labels in Plex Mono, everything else Inter. The heatmap ramp is four
  steps of the accent, shared by every heatmap so a dense cell means the same
  thing in the zone grid and in the duration matrix. `ingest/viz.py` holds the
  palette; the specs are regenerated from the parquet, never hand-edited. Used
  for real summaries (zone distributions, outcome mixes), not decoration.
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
- StatsBomb attribution (licence clause 1.4 requires the **logo**, not just
  text). App footer + README must carry the StatsBomb logo (from their media
  pack) plus: "Data provided by StatsBomb. Halfspace is built on StatsBomb Open
  Data. Used under the StatsBomb Public Data User Agreement for research and
  non-commercial analysis. StatsBomb is not affiliated with this project and
  does not endorse any analysis presented here."
- Cut rather than fake; note honest limitations in README.
