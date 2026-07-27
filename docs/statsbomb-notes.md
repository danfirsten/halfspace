# StatsBomb Open Data — Reference Notes for Halfspace Ingest

Reference for building the Halfspace ingest pipeline against
[statsbomb/open-data](https://github.com/statsbomb/open-data) (`master` branch).

**Everything below is either (a) quoted from an official StatsBomb spec PDF in the repo's
`doc/` directory, or (b) measured empirically from downloaded data files.** Each section
marks which. Where spec and data disagree, that is called out explicitly under
[§8 Spec vs. reality](#8-spec-vs-reality-discrepancy-log).

**Verification date:** 2026-07-27. Data fetched from
`https://raw.githubusercontent.com/statsbomb/open-data/master/...`.

**Spec documents used** (all downloaded from `doc/` and text-extracted):

| File | Version / date |
|---|---|
| `LICENSE.pdf` (repo root) | "StatsBomb Data: User Agreement Standard Terms — last updated 8 September 2023" |
| `doc/StatsBomb Open Data Specification v1.1.pdf` | v1.1, last updated 13 May 2019, 45 pages |
| `doc/Open Data Events v4.0.0.pdf` | v4.0.0, last updated 08 May 2019 |
| `doc/Open Data 360 Frames v1.0.0 (1).pdf` | v1.0.0, last updated 17 November 2021 |
| `doc/Open Data Matches v3.0.0.pdf` | v3.0.0 |
| `doc/Open Data Lineups v2.0.0.pdf` | v2.0.0 |
| `doc/Open Data Competitions v2.0.0.pdf` | v2.0.0 |

Note the filename `Open Data 360 Frames v1.0.0 (1).pdf` really does contain ` (1)` — URL-encode
the space and parentheses when fetching.

---

## 1. Licence and attribution

### 1.1 What the documents say

There are two governing texts: `README.md` (the practical ask) and `LICENSE.pdf` (the binding
agreement). They are not identical and both matter.

**`README.md`, section "Terms & Conditions" — verbatim:**

> If you publish, share or distribute any research, analysis or insights based on this data,
> please state the data source as StatsBomb and use our logo, available in our
> [Media Pack](https://statsbomb.com/media-pack/).

**`LICENSE.pdf` — the operative clauses, quoted verbatim:**

> **1.2. The User may not:**
> **1.2.1.** edit, distort, distribute, reproduce, sell or in any way provide the data to any
> external or third party;
> **1.2.2.** commercially exploit the data or any analysis derived from the use of the Service;
> **1.2.3.** use the Service for any activity of an illegal or fraudulent nature, to violate any laws;
> **1.2.4.** use the Service to produce, transfer, distribute or publish any material that might be
> defamatory or damaging to any individual or organisation
> **1.2.5.** decompile, reverse engineer, or otherwise attempt to obtain the source code of the Services;

> **1.4.** The User is required to accredit any publication of analysis formed from StatsBomb Data
> with the StatsBomb brand logo.

> **2.2.** StatsBomb asks that all Users provide details of their personal information (name and
> email address only) before they access the Service, www.statsbomb.com/resource-centre.

> **3.2.** The Service is provided on an "as is" basis
> **3.3.** StatsBomb has no liability to the User

> **7. Intellectual Property Rights**
> The User acknowledges and agrees that all data provided through the Service, is the property of
> StatsBomb.

> **9. Governing Law** — laws of England and Wales. StatsBomb Services Ltd, company number
> 10377735, University of Bath Innovation Centre, Carpenter House, Broad Quay, Bath, BA1 1UD.

### 1.2 What this means for Halfspace — actionable rules

1. **Attribution is mandatory, and the logo is specifically required** (clause 1.4 — "with the
   StatsBomb brand logo", not merely a text credit). Text alone technically under-complies with
   1.4; the README softens this to "state the data source as StatsBomb **and** use our logo".
   Ship both.
2. **Clause 1.2.1 prohibits redistributing the data.** Halfspace must **not** commit raw
   StatsBomb JSON to the repo, and must not expose a bulk-download/export endpoint that hands
   the underlying event or 360 JSON back out. Rendering derived animations and search results in
   the app is fine; a "download the raw events" button is not.
3. **Clause 1.2.2 prohibits commercial exploitation.** Portfolio/demo use is fine; do not put
   the app behind a paywall, run ads on it, or use it as a paid product demo.
4. Register at <https://statsbomb.com/resource-centre> (clause 2.2) before using the data.
5. Logo assets come from the Media Pack: <https://statsbomb.com/media-pack/>. Do not
   re-host a scraped logo file in a public repo without checking the media pack terms; link or
   bundle per the media pack's own instructions.

### 1.3 Exact attribution text to ship

Use this wording verbatim in **both** the app footer and the repo `README.md`, alongside the
StatsBomb logo image from the Media Pack:

> **Data provided by StatsBomb.**
>
> Halfspace is built on [StatsBomb Open Data](https://github.com/statsbomb/open-data). Data
> source: StatsBomb. Used under the StatsBomb Public Data User Agreement for research and
> non-commercial analysis. StatsBomb is not affiliated with this project and does not endorse
> any analysis presented here.

The logo must be visible next to that credit (clause 1.4). Minimum viable footer markup:

```html
<footer>
  <a href="https://statsbomb.com/"><img src="/assets/statsbomb-logo.svg" alt="StatsBomb" height="28"></a>
  <span>Data provided by StatsBomb — <a href="https://github.com/statsbomb/open-data">StatsBomb Open Data</a>.
  Used under the StatsBomb Public Data User Agreement for research and non-commercial analysis.</span>
</footer>
```

---

## 2. 360 coverage and recommended dataset

### 2.1 Every competition/season with non-null `match_available_360`

*Empirical.* From `data/competitions.json` (80 rows total, 12 with non-null
`match_available_360`). The "360 files present" column was verified by issuing an HTTP HEAD to
`data/three-sixty/{match_id}.json` for **every match in every one of these 12 seasons** (313 +
164 = 477 probes).

| comp_id | season_id | Competition | Season | Gender | Intl | Matches | 360 files present | Events MB | 360 MB | Total MB |
|---:|---:|---|---|---|---|---:|---:|---:|---:|---:|
| 55 | 282 | UEFA Euro | 2024 | male | yes | 51 | **51 / 51** | 160.1 | 399.2 | 559.3 |
| 55 | 43 | UEFA Euro | 2020 | male | yes | 51 | **51 / 51** | 163.3 | 377.6 | 540.9 |
| 43 | 106 | FIFA World Cup | 2022 | male | yes | 64 | **64 / 64** | 199.6 | 459.7 | 659.3 |
| 72 | 107 | Women's World Cup | 2023 | female | yes | 64 | **64 / 64** | 197.5 | 422.8 | 620.2 |
| 53 | 106 | UEFA Women's Euro | 2022 | female | yes | 31 | **31 / 31** | 91.7 | 197.0 | 288.7 |
| 53 | 315 | UEFA Women's Euro | 2025 | female | yes | 31 | **31 / 31** | 92.0 | 199.5 | 291.5 |
| 11 | 90 | La Liga | 2020/2021 | male | no | 35 | **35 / 35** | 119.3 | 321.6 | 440.9 |
| 9 | 281 | 1. Bundesliga | 2023/2024 | male | no | 34 | **34 / 34** | 119.2 | 289.1 | 408.3 |
| 7 | 235 | Ligue 1 | 2022/2023 | male | no | 32 | **32 / 32** | 112.0 | 286.8 | 398.8 |
| 7 | 108 | Ligue 1 | 2021/2022 | male | no | 26 | **26 / 26** | 88.0 | 217.4 | 305.4 |
| 44 | 107 | Major League Soccer | 2023 | male | no | 6 | **6 / 6** | 18.8 | 41.2 | 60.0 |
| 1267 | 107 | African Cup of Nations | 2023 | male | yes | 52 | **1 / 52** ⚠ | 139.7 | 0.002 | 139.7 |

⚠ **AFCON 2023 is a trap.** `competitions.json` reports
`match_available_360: "2025-…"` for it, but only one match (`3923880`) has a
`three-sixty/*.json` file at all, and that file is **1,962 bytes** — an empty/stub frame list,
not real 360 data. **Do not trust `match_available_360` in `competitions.json` as a signal that
360 files exist.** Probe `data/three-sixty/{match_id}.json` per match, and also reject files
below a size floor (~50 KB) as stubs. Every other competition in the table passed both checks.

Per-match `match_status_360` in the matches file is a better (though still not sufficient)
signal — see [§3.4](#34-match-level-metadata).

### 2.2 Per-match file size profile

*Empirical*, from the HEAD probe above:

| Competition | Median events JSON | Median 360 JSON | Ratio |
|---|---:|---:|---:|
| UEFA Euro 2024 | 3.13 MB | 7.76 MB | 2.5× |
| UEFA Euro 2020 | 3.11 MB | 7.15 MB | 2.3× |
| FIFA World Cup 2022 | 3.04 MB | 6.83 MB | 2.2× |
| Women's World Cup 2023 | 3.03 MB | 6.31 MB | 2.1× |

**The 360 file is consistently ~2.2–2.5× the size of the events file.** Budget accordingly:
360 data dominates the download and the disk footprint.

`matches/*.json` and `lineups/*.json` are negligible (tens of KB each; ~2 MB total for a
100-match dataset).

### 2.3 Recommended dataset

> **UEFA Euro 2024 + UEFA Euro 2020 — 102 matches, ~1.10 GB raw.**

| Competition | comp_id | season_id | Matches source file | Matches | Events MB | 360 MB | Total MB |
|---|---:|---:|---|---:|---:|---:|---:|
| UEFA Euro 2024 | 55 | 282 | `data/matches/55/282.json` | 51 | 160.1 | 399.2 | 559.3 |
| UEFA Euro 2020 | 55 | 43 | `data/matches/55/43.json` | 51 | 163.3 | 377.6 | 540.9 |
| **Total** | | | | **102** | **323.4** | **776.8** | **1100.2** |

Comfortably under the 3 GB budget, with ~1.9 GB of headroom.

**Why this pair:**

- **Coherent.** Same competition (`competition_id: 55`), same format (24 teams, group stage +
  knockouts), same gender, same confederation. Phase-search results are comparable across the
  two tournaments without cross-league style confounds, and "Spain 2024 vs Italy 2020" is a
  genuinely interesting query.
- **Complete 360.** 102/102 matches have real, full-size 360 files (verified individually).
- **Right size.** 102 matches ≈ 390k events, of which ~340k carry a 360 frame. Enough to make
  search interesting; small enough to ingest in one pass and keep in Postgres/DuckDB without
  sharding.
- **Highest 360 density measured** — see §2.4.

**Alternatives if you want a different flavour:**

- **Single tournament, fastest to bootstrap:** Euro 2024 alone — 51 matches, 559 MB.
- **Bigger and still coherent:** FIFA World Cup 2022 alone — 64 matches, 659 MB. Or
  Euro 2024 + World Cup 2022 = 115 matches, 1219 MB.
- **Women's game:** Women's World Cup 2023 (64) + UEFA Women's Euro 2022 (31) = 95 matches,
  909 MB. Also fully covered.
- **Avoid** AFCON 2023 entirely (no usable 360), and avoid the club leagues
  (La Liga / Bundesliga / Ligue 1 / MLS) — each is a partial season of scattered matches, not a
  coherent competition, and MLS 2023 is only 6 matches.

**Concrete match list source:** the two files
`data/matches/55/282.json` and `data/matches/55/43.json`. Each is a JSON array of match objects;
take `match_id` from each element. No other enumeration source is needed — do **not** try to
list `data/events/` via the GitHub API (see [§9](#9-fetching-notes)).

### 2.4 Measured 360 coverage per match

*Empirical.* 14 matches downloaded in full and cross-referenced event-by-event:

| Competition | Match | Events | 360 frames | Coverage | Median players/frame | Max players/frame |
|---|---:|---:|---:|---:|---:|---:|
| Euro 2024 | 3930158 (GER–SCO) | 3372 | 3090 | 91.6% | 15 | 20 |
| Euro 2024 | 3930159 | 3370 | 3034 | 90.0% | 17 | 21 |
| Euro 2024 | 3930166 | 3610 | 2974 | 82.4% | 18 | 21 |
| Euro 2024 | 3938637 | 3409 | 2952 | 86.6% | 18 | 21 |
| Euro 2024 | 3941017 (ENG–SVK, a.e.t.) | 4764 | 4113 | 86.3% | 18 | 21 |
| Euro 2024 | 3942349 (POR–FRA, pens) | 5195 | 4509 | 86.8% | 17 | 21 |
| Euro 2024 | 3942819 (NED–ENG SF) | 3503 | 2967 | 84.7% | 18 | 22 |
| Euro 2024 | 3943043 (ESP–ENG Final) | 3304 | 2882 | 87.2% | 17 | 22 |
| Euro 2020 | 3788741 | 3803 | 3370 | 88.6% | 14 | 20 |
| Euro 2020 | 3788746 | 3969 | 3600 | 90.7% | 16 | 21 |
| Euro 2020 | 3794687 | 3793 | 3324 | 87.6% | 16 | 22 |
| Euro 2020 | 3795107 | 3616 | 2965 | 82.0% | 16 | 22 |
| Euro 2020 | 3795506 | 4796 | 4303 | 89.7% | 14 | 21 |
| WC 2022 | 3869118 | 3505 | 3102 | 88.5% | 15 | 21 |

**Summary: 82–92% of all events carry a 360 frame; mean ≈ 87%.** For on-ball events only
(Pass / Carry / Shot / Ball Receipt / Dribble / Clearance / Interception / Ball Recovery)
coverage is slightly higher, 84–93%.

Coverage by event type (match 3930158, representative):

| Event type | With 360 | Total | Coverage |
|---|---:|---:|---:|
| Shot | 21 | 21 | 100.0% |
| Ball Recovery | 59 | 62 | 95.2% |
| Carry | 735 | 774 | 95.0% |
| Foul Committed | 23 | 24 | 95.8% |
| Pressure | 242 | 260 | 93.1% |
| Clearance | 27 | 29 | 93.1% |
| Ball Receipt* | 883 | 956 | 92.4% |
| Pass | 907 | 998 | 90.9% |
| Duel | 42 | 47 | 89.4% |
| Block | 30 | 35 | 85.7% |
| Dribble | 17 | 20 | 85.0% |
| Goal Keeper | 13 | 25 | 52.0% |

Shots are effectively always covered — good news for replaying attacking phases. Goal Keeper
events are the weak spot.

The spec's caveats are **not** borne out in this dataset — see §8.

---

## 3. Coordinate system

### 3.1 Pitch coordinates

*From spec.* `Open Data Events v4.0.0.pdf` Appendix 2 and
`StatsBomb Open Data Specification v1.1.pdf` Appendix 2 ("Locations — Pitch Coordinates,
coordinates specified as (x, y)"). Both appendices are **diagram images**, not text; the values
below were read directly off the extracted images.

```
   (0,0) ────────────────────────────────────────────── (120,0)
     │                          │                          │
     │  ┌──────────┐(18,18)     │           (102,18)┌──────┐│(120,18)
     │  │ ┌───┐(6,30)           │              (114,30)┌───┐│
   (0,36)│ │   │     ● (12,40)  ● (60,40)   (108,40) ● │   ││(120,36)
   ─GOAL─┤ │   │                │                      │   ├─GOAL─
   (0,44)│ │   │                │                      │   ││(120,44)
     │  │ └───┘(6,50)           │              (114,50)└───┘│
     │  └──────────┘(18,62)     │           (102,62)└──────┘│(120,62)
     │                          │                          │
   (0,80) ───────────────────── (60,80) ───────────────── (120,80)
```

| Property | Value | Source |
|---|---|---|
| Pitch length (x) | **0 → 120** | Spec Appendix 2 diagram |
| Pitch width (y) | **0 → 80** | Spec Appendix 2 diagram |
| Units | yards | Spec (pass `length` "in yards") |
| Origin `(0,0)` | **top-left** corner | Spec diagram: `0,0` top-left; `0,80` bottom-left |
| x axis | increases **left → right** (toward the attacking goal) | Spec diagram |
| y axis | **top-down** — y increases *downward*, `y=0` is the top touchline | Spec diagram: `0,0` top-left, `0,80` bottom-left |
| Centre spot | `(60, 40)` | Spec diagram |
| Penalty spots | `(12, 40)` and `(108, 40)` | Spec diagram |
| Penalty areas | x 0–18 / 102–120, y 18–62 | Spec diagram |
| Six-yard boxes | x 0–6 / 114–120, y 30–50 | Spec diagram |
| Goal mouth | y **36 → 44** at x=0 and x=120 | Spec diagram |

**Rendering note:** because y is top-down, an SVG/canvas renderer with y-down origin-top-left
can plot `(x, y)` directly with no flip. A matplotlib-style y-up renderer must invert y.

### 3.2 Direction of play — the single most important rule

> ***Every event's `location` is expressed in the acting team's own attacking frame. Both teams
> attack from x=0 toward x=120, in every period. Ends never swap.***

*Empirical, verified three ways on match 3930158 (Germany 5–1 Scotland) and 3941017:*

**(a) Paired opposing-team events mirror exactly.** For events linked by `related_events` that
occur at the same `timestamp` but belong to opposing teams, the two locations satisfy
`x_a + x_b = 120.1` and `y_a + y_b = 80.1` — **exactly**, on every single pair tested:

| Related pair type | n | median \|x_a+x_b−120\| | median \|y_a+y_b−80\| |
|---|---:|---:|---:|
| Foul Committed ↔ Foul Won | 46 | 0.10 | 0.10 |
| Duel ↔ Pass | 30 | 0.10 | 0.10 |
| Dispossessed ↔ Duel | 28 | 0.10 | 0.10 |
| Dribble ↔ Dribbled Past | 22 | 0.10 | 0.10 |
| Carry ↔ Dribbled Past | 20 | 0.10 | 0.10 |
| Dribble ↔ Duel | 18 | 0.10 | 0.10 |
| Clearance ↔ Duel | 8 | 0.10 | 0.10 |
| 50/50 ↔ 50/50 | 8 | 0.10 | 0.10 |
| Own Goal Against ↔ Own Goal For | 2 | 0.10 | 0.10 |

Raw examples: `[35.5, 5.6] + [84.6, 74.5] = (120.1, 80.1)`,
`[48.7, 12.7] + [71.4, 67.4] = (120.1, 80.1)`,
`[101.3, 44.6] + [18.8, 35.5] = (120.1, 80.1)`.

> ### ⚠ The mirror constant is **120.1 / 80.1**, not 120 / 80
>
> Event `location` values are quantised onto a 0.1-offset grid — observed x range across a
> full match is **0.5 → 120.0** and y range **0.1 → 80.0**, i.e. cell *edges* at 0.1 spacing
> starting from 0.1, not cell centres at 0. The correct transform to put an opponent's event
> into the possession team's frame is therefore:
>
> ```python
> def mirror(loc):          # event locations only
>     x, y = loc
>     return [round(120.1 - x, 1), round(80.1 - y, 1)]
> ```
>
> Using `120 - x` introduces a systematic 0.1-yard bias and, worse, breaks exact equality
> checks when you join an event to its 360 freeze-frame actor. **360 freeze-frame
> coordinates are full-precision floats and are *not* on that grid** — mirror those with
> `120 - x, 80 - y` if you ever need to (you normally don't; see §3.5).

**(b) Own goalkeeper always sits near x≈0.** Mean x of `Goal Keeper` events, match 3941017
(England v Slovakia, went to extra time — 4 periods):

| Team | P1 | P2 | P3 (ET1) | P4 (ET2) |
|---|---:|---:|---:|---:|
| England | 3.0 | 14.3 | 2.8 | 1.7 |
| Slovakia | 2.6 | 4.2 | 5.3 | 3.7 |

**(c) Shots always trend toward x=120.** Mean x of `Shot` events in the same match:
England 102.1 / 105.5 / 106.3 / 99.9; Slovakia 107.2 / 76.1 / 114.9 / 104.8. No half-time flip.

**Consequence for Halfspace:** you never need to know which physical end a team is attacking.
To render a possession, pick the possession team's frame and mirror every event whose
`team.id != possession_team.id` using the 120.1/80.1 transform. To render "as broadcast" you
would need real end-of-pitch information, which the open data does not contain.

### 3.3 Shot `end_location` and the z axis

*From spec* (`Open Data Events v4.0.0.pdf`, Shot → `end_location`,
"array [x,y] or [x,y,z]"; Appendix 2 "Goal Coordinates — Coordinates specified as (x, y, z)")
and the goal diagram image:

| Goal corner | Coordinate |
|---|---|
| Top-left of goal frame | `120, 36, 2.67` |
| Top-right of goal frame | `120, 44, 2.67` |
| Bottom-left (post base) | `120, 36, 0` |
| Bottom-right (post base) | `120, 44, 0` |

So: goal line at **x = 120**, posts at **y = 36 and y = 44**, crossbar at **z = 2.67**, ground at
**z = 0**. Units are yards (8 yards wide × 2.67 yards ≈ 8 ft high — correct).

*Empirical* (match 3930158): of 21 shots, **15 had a 3-element `end_location` and 6 had only 2
elements**. z is only present when the ball reached/passed the goal plane in a way worth
recording; blocked and wayward shots often carry only `[x, y]`.

> **Gotcha: `shot.end_location` may be length 2 OR length 3.** Always branch on `len()`.

Observed z range in that match: 0.1 → 6.8 (well above the 2.67 crossbar — a shot ballooned over
the bar still gets a z). Observed shot `end_location` x range: 102.2 → 120.0.

All five goals in the match had `end_location[0] == 120.0` exactly, with y in 36.9–43.6 (inside
the 36–44 posts) and z in 0.2–2.3 (below the 2.67 bar) — the spec checks out perfectly:

| Min | Scorer | `location` | `end_location` | xG | type |
|---:|---|---|---|---:|---|
| 9:55 | Florian Wirtz | `[101.1, 42.0]` | `[120.0, 36.9, 0.2]` | 0.0642 | Open Play |
| 18:43 | Jamal Musiala | `[106.4, 35.4]` | `[120.0, 38.8, 2.3]` | 0.0935 | Open Play |
| 45:35 | Kai Havertz | `[108.1, 40.1]` | `[120.0, 38.3, 0.9]` | 0.7835 | Penalty |
| 67:42 | Niclas Füllkrug | `[104.1, 39.3]` | `[120.0, 43.6, 2.1]` | 0.1140 | Open Play |
| 92:32 | Emre Can | `[98.5, 39.4]` | `[120.0, 43.5, 0.3]` | 0.0500 | Open Play |

Note the penalty at `location [108.1, 40.1]` — that is exactly the penalty-spot convention
StatsBomb uses (the diagram says 108,40; the 0.1 grid offset makes it 108.1, 40.1). Every
penalty and every shootout kick in the data sits at `[108.1, 40.1]`.

**Kick-off sanity check** (match 3930158, index 5): Kai Havertz's kick-off pass has
`location: [61.0, 40.1]` — the centre spot is `(60, 40)`, so this is a step off the spot in the
centre circle. `play_pattern` is `9 / From Kick Off`, `pass.type` is `65 / Kick Off`. ✅

### 3.4 Match-level metadata

*Empirical*, `data/matches/55/282.json`:

```json
"metadata": { "data_version": "1.1.0", "shot_fidelity_version": "2", "xy_fidelity_version": "2" },
"match_status": "available",
"match_status_360": "available",
"competition_stage": { "id": 10, "name": "Group Stage" }
```

`shot_fidelity_version: 2` / `xy_fidelity_version: 2` mean **high-fidelity coordinates**
throughout (spec Appendix 10: "Shots, freeze frames and events paired to shots use high fidelity
x,y coordinates"). All Euro 2024 matches sampled are version 2. Also present:
`match_date`, `kick_off`, `home_team`/`away_team` (with `managers[]` and `country`),
`home_score`/`away_score`, `match_week`, `stadium`, `referee`, `last_updated`,
`last_updated_360`.

Competition stage IDs relevant to a Euro (spec Appendix 8): `10 Group Stage`,
`33 8th Finals` (Round of 16), `11 Quarter-finals`, `15 Semi-finals`, `26 Final`.

### 3.5 360 freeze-frame coordinates

*From spec* (`Open Data 360 Frames v1.0.0.pdf`), file structure — an array of frame objects:

| Field | Type | Spec description |
|---|---|---|
| `event_uuid` | UUID | "The unique identifier for the event matching this freeze frame." |
| `visible_area` | Array | "An array of coordinates describing the polygon visible to the camera… The format of the array is: `X1 Y1 X2 Y2… Xn Yn X1 Y1`, describing a closed loop around the visible area of the pitch." |
| `freeze_frame` | Array | Player records — "these freeze frames will not contain player identification, beyond their team (except for the player performing the current event who will be marked as the actor)." |

Player record:

| Field | Type | Spec description |
|---|---|---|
| `location` | array [x,y] | **"The position of the player on the field, with coordinates oriented in the same direction as the linked event (i.e. the actor's team attacking 0 to 120 on the X axis."** |
| `teammate` | boolean | "Indicates the player plays on the same team as the 'actor' in this event." |
| `actor` | boolean | "Indicates the current player is the same as the one performing the associated event." |
| `keeper` | boolean | "Indicates this player is a keeper." |

*Empirical* — real frame from match 3930158, linked to the kick-off pass
`0d775a2f-9444-4897-88d8-16a36547b74f`:

```json
{
  "event_uuid": "0d775a2f-9444-4897-88d8-16a36547b74f",
  "visible_area": [120.0, 80.0, 0.0, 80.0, 0.0, 78.66, 43.79, 0.0,
                   80.02, 0.0, 120.0, 72.93, 120.0, 80.0],
  "freeze_frame": [
    { "teammate": true, "actor": false, "keeper": false,
      "location": [41.29842580722467, 44.700408154511074] },
    { "teammate": true, "actor": false, "keeper": false,
      "location": [42.69337667350762, 35.53530103759538] }
  ]
}
```

Note the key order is `teammate, actor, keeper, location` (not the spec's order) — irrelevant
for JSON parsing but worth knowing if you eyeball the files.

**Verified orientation.** In match 3930158, comparing every frame's `actor` location to the
linked event's `location`:

- **95.5% of frames: `actor.location == event.location` to float precision**
  (median \|Δx\| = 1.5e-06, median \|Δy\| = 7.6e-07). The 360 frame is in the *event's own team's*
  attacking frame, exactly as the spec says.
- The opponent goalkeeper (`teammate: false, keeper: true`) sits at **median x = 115.7**
  (p5 109.1, p95 119.6), i.e. defending the goal at x=120.
- Own goalkeeper (`teammate: true, keeper: true`) sits at **median x = 4.5**.

That triple-confirms: **360 freeze frames use the same 120×80 frame as events, oriented so the
*actor's* team attacks toward x = 120.** No transform needed to overlay a frame on its event.

> ### ⚠ …except for ~5% of frames, where the orientation is the *opponent's*
>
> Measured across 4 full matches by classifying each actor-bearing frame as MATCH
> (actor ≈ event location), MIRROR (actor ≈ `120.1−x, 80.1−y`) or OTHER:
>
> | Match | n frames | MATCH | MIRROR | OTHER |
> |---|---:|---:|---:|---:|
> | 3930158 | 3090 | 95.47% | 66 | 74 |
> | 3943043 | 2882 | 94.14% | 88 | 81 |
> | 3941017 | 4113 | 94.53% | 98 | 127 |
> | 3788741 | 3370 | 94.07% | 71 | 129 |
>
> The non-MATCH cases are overwhelmingly **paired duel-type events**: `Duel`, `Dispossessed`,
> `Dribbled Past`, `Foul Won`, `Dribble`, `50/50`, and incomplete `Ball Receipt*` — i.e. events
> that share a moment with an opposing-team event. About half of them have an opposing-team
> event at the identical timestamp in `related_events`. In those cases StatsBomb appears to have
> oriented the frame to the *other* event of the pair.
>
> Concrete example (match 3930158, index 63/64):
> ```
> idx63  Ball Receipt* Scotland  loc=[97.1, 68.4]   frame actor=[24.2, 13.3]
> idx64  Pass          Germany   loc=[24.2, 13.3]   frame actor=[24.2, 13.3]
> ```
> The Scotland event's frame is drawn in Germany's frame.
>
> **Robust ingest rule — do not assume, check:**
> ```python
> def frame_orientation(event, frame):
>     """Return 'event' | 'mirrored' | 'unknown' for a 360 frame."""
>     actors = [p for p in frame["freeze_frame"] if p["actor"]]
>     if len(actors) != 1 or not event.get("location"):
>         return "unknown"
>     ax, ay = actors[0]["location"]; ex, ey = event["location"]
>     if abs(ax - ex) <= 1.5 and abs(ay - ey) <= 1.5:
>         return "event"
>     if abs(ax - (120.1 - ex)) <= 1.5 and abs(ay - (80.1 - ey)) <= 1.5:
>         return "mirrored"
>     return "unknown"
> ```
> Store the resolved orientation per frame at ingest time. For `mirrored`, flip both the
> freeze-frame locations *and* the `teammate` flags before storing in your canonical frame; for
> `unknown` (~2–3% of frames), either drop the frame from animation or fall back to the
> event-team assumption and flag it.

**Other empirical 360 facts** (from 14 fully-downloaded matches):

- **Freeze-frame coordinates can fall outside the pitch.** Observed range in one match:
  x ∈ [−2.50, 123.45], y ∈ [−6.58, 89.50]. Players tracked behind the goal line or off the
  touchline. **Your renderer must handle out-of-bounds coordinates** — clamp for display or
  extend the viewport; do not assert 0≤x≤120.
- Freeze-frame `location` values are **full-precision floats**, unlike event `location` values
  which are quantised to one decimal on the 0.1 grid.
- **Players per frame: median 15–18, max 22, minimum 1.** Never 0 in any sampled match.
- **`visible_area` was present and non-empty on 100% of the 47,185 frames sampled** (14 matches),
  always an even-length flat array. Length distribution in match 3930158: 10 values (1533 frames),
  12 (956), 14 (596), 8 (5) — i.e. 4–7 vertices per closed polygon.
- **Every sampled frame had exactly one `actor`** — across all 47,185 frames in 14 matches:
  **0 frames with no actor, 0 frames with more than one actor.** (The spec warns both can happen;
  neither occurs in this dataset.)
- Keepers per frame: 0 in ~70% of frames, 1 in ~30%. Both keepers in the same frame is rare.
- `event_uuid` values are unique within a file and always resolve to an event in the
  corresponding `events/{match_id}.json`. Verified: no orphans, no duplicates.

### 3.6 Shot freeze frames — a different, richer structure

**`shot.freeze_frame` is NOT the same thing as a 360 frame.** *From spec* (Events v4.0.0
Appendix 3) and *verified empirically*:

```json
{
  "location": [105.3, 40.9],
  "player":   { "id": 12555, "name": "Okay Yokuşlu" },
  "position": { "id": 10, "name": "Center Defensive Midfield" },
  "teammate": false
}
```

| | 360 `freeze_frame` | `shot.freeze_frame` |
|---|---|---|
| Lives in | `data/three-sixty/{id}.json` | inline on the Shot event |
| Player identity | ❌ anonymous | ✅ `player` + `position` |
| `actor` flag | ✅ | ❌ (the shooter is the event's `player`) |
| `keeper` flag | ✅ | ❌ (infer from `position.id == 1`) |
| Coverage | ~87% of all events | 99% of shots (a penalty had none) |
| Precision | full float | one decimal (0.1 grid) |

Both use the same 120×80 frame oriented to the shooting team. **For animation you generally want
the 360 frame** (it exists for ~87% of *all* events, so you can animate a whole possession);
`shot.freeze_frame` is only useful at the shot instant but gives you names.

---

## 4. Event taxonomy

### 4.1 Event types observed in the recommended dataset

*Empirical.* Counts across **9 fully-downloaded matches** (8 Euro 2024 + 1 WC 2022;
33,640 events total). IDs and names are the literal `type.id` / `type.name` from the data.

| id | `type.name` (exact) | Count | Per match |
|---:|---|---:|---:|
| 30 | `Pass` | 9411 | ~1046 |
| 42 | `Ball Receipt*` | 8970 | ~997 |
| 43 | `Carry` | 7634 | ~848 |
| 17 | `Pressure` | 2565 | ~285 |
| 2 | `Ball Recovery` | 727 | ~81 |
| 4 | `Duel` | 554 | ~62 |
| 6 | `Block` | 350 | ~39 |
| 9 | `Clearance` | 325 | ~36 |
| 23 | `Goal Keeper` | 265 | ~29 |
| 14 | `Dribble` | 215 | ~24 |
| 16 | `Shot` | 214 | ~24 |
| 22 | `Foul Committed` | 211 | ~23 |
| 21 | `Foul Won` | 206 | ~23 |
| 10 | `Interception` | 185 | ~21 |
| 38 | `Miscontrol` | 174 | ~19 |
| 3 | `Dispossessed` | 165 | ~18 |
| 39 | `Dribbled Past` | 120 | ~13 |
| 19 | `Substitution` | 85 | ~9 |
| 33 | `50/50` | 46 | ~5 |
| 18 | `Half Start` | 40 | 4–5 |
| 34 | `Half End` | 40 | 4–5 |
| 36 | `Tactical Shift` | 32 | ~4 |
| 40 | `Injury Stoppage` | 30 | ~3 |
| 35 | `Starting XI` | 18 | 2 |
| 28 | `Shield` | 10 | ~1 |
| 41 | `Referee Ball-Drop` | 10 | ~1 |
| 27 | `Player Off` | 9 | ~1 |
| 26 | `Player On` | 9 | ~1 |
| 37 | `Error` | 7 | <1 |
| 24 | `Bad Behaviour` | 6 | <1 |
| 20 | `Own Goal Against` | 3 | <1 |
| 25 | `Own Goal For` | 3 | <1 |
| 8 | `Offside` | 1 | <1 |

> **Gotcha: `Ball Receipt*` has a literal trailing asterisk in `type.name`.** So does the spec's
> `50/50` contain a slash. Do not sanitise these into identifiers naively; key your enums on
> `type.id`, not `type.name`.

Types documented in the spec but **not observed** in this dataset: `5 Camera On`,
`31/32` (unused), `29` (unused). Also note the spec lists `41 / "Referee Ball-Drop"` and
`5 / "Camera On*"` with asterisks in the PDF — the data has no asterisk on `Referee Ball-Drop`.

### 4.2 Common fields (every event)

*From spec* (Events v4.0.0, "Format" table), *field presence verified empirically*:

| Field | Type | Always present? | Notes |
|---|---|---|---|
| `id` | uuid | ✅ always | Primary key. Also the join key for 360 (`event_uuid`). |
| `index` | integer | ✅ always | "Sequence notation for the ordering of events within each match." **Verified: contiguous 1..N, and file order == index order.** |
| `period` | integer | ✅ always | 1=1st Half, 2=2nd Half, 3=3rd Period (ET1), 4=4th Period (ET2), 5=Penalty Shootout |
| `timestamp` | `HH:MM:SS.mmm` | ✅ always | **Resets to `00:00:00.000` at the start of every period.** |
| `minute` | integer | ✅ always | Match clock. "Resets to 45 at half-time, 90 at the start of extra time etc." |
| `second` | integer | ✅ always | |
| `type` | object id/name | ✅ always | |
| `possession` | integer | ✅ always | See §5. |
| `possession_team` | object id/name | ✅ always | Team in control for this possession. |
| `play_pattern` | object id/name | ✅ always | See §7. |
| `team` | object id/name | ✅ always (in practice) | **The team of the acting player — may differ from `possession_team`.** |
| `duration` | decimal (seconds) | ⚠ **absent on `Ball Receipt*`** | Present on every other type sampled. |
| `player` | object id/name | ❌ | Absent on `Starting XI`, `Half Start`, `Half End`, `Tactical Shift`, `Referee Ball-Drop`, `Own Goal For` |
| `position` | object id/name | ❌ | Same absences as `player` |
| `location` | array [x,y] | ❌ | Absent on `Starting XI`, `Half Start`, `Half End`, `Substitution`, `Tactical Shift`, `Injury Stoppage`, `Bad Behaviour` |
| `related_events` | array[uuid] | ❌ | See per-type rates below |
| `under_pressure` | boolean (only `true`) | ❌ | See §7.2 |
| `counterpress` | boolean (only `true`) | ❌ | **TOP-LEVEL, not nested — see §8** |
| `off_camera` | boolean (only `true`) | ❌ | ~0–2% of events |
| `out` | boolean (only `true`) | ❌ | Ball went out of bounds |
| `tactics` | object | ❌ | Only on `Starting XI` / `Tactical Shift` |

> **Gotcha: boolean flags are "present-if-true".** `under_pressure`, `counterpress`,
> `off_camera`, `out`, `pass.cross`, `pass.switch`, etc. are **absent** when false — they are
> never serialised as `false`. Always use `event.get("under_pressure", False)`, never
> `event["under_pressure"]`.

### 4.3 Field presence by event type

*Empirical*, 3 matches (11,440 events). "optional" percentages are of that event type.

| Type | n | Always has | Optional (rate) |
|---|---:|---|---|
| `Pass` | 3299 | id, index, period, timestamp, minute, second, type, possession, possession_team, play_pattern, team, player, position, location, duration, `pass` | related_events (99%), under_pressure (14%), off_camera (2%), counterpress (<1%), out (<1%) |
| `Ball Receipt*` | 3137 | …core…, location, related_events | `ball_receipt` (11%), under_pressure (6%) — **no `duration`** |
| `Carry` | 2655 | …core…, location, duration, related_events, `carry` | under_pressure (27%) |
| `Pressure` | 927 | …core…, location, duration | related_events (93%), counterpress (18%), under_pressure (<1%) |
| `Ball Recovery` | 254 | …core…, location, duration | related_events (42%), under_pressure (13%), `ball_recovery` (9%), out, off_camera |
| `Duel` | 205 | …core…, location, duration, related_events, `duel`, **under_pressure (100%)** | counterpress (26%) |
| `Block` | 129 | …core…, location, duration | related_events (79%), out (24%), counterpress (15%), `block` (5%) |
| `Clearance` | 121 | …core…, location, duration, `clearance`, **under_pressure (100%)** | related_events (76%), out (19%) |
| `Goal Keeper` | 98 | …core…, location, duration, `goalkeeper` | related_events (98%), out (2%) |
| `Foul Committed` | 75 | …core…, location, duration, related_events | `foul_committed` (28%), counterpress (13%), under_pressure (1%) |
| `Shot` | 75 | …core…, location, duration, related_events, `shot` | under_pressure (28%), out (1%), off_camera (1%) |
| `Foul Won` | 74 | …core…, location, duration, related_events | under_pressure (97%), `foul_won` (40%) |
| `Dribble` | 70 | …core…, location, duration, related_events, `dribble`, **under_pressure (100%)** | — |
| `Dispossessed` | 59 | …core…, location, duration, related_events, **under_pressure (100%)** | — |
| `Miscontrol` | 56 | …core…, location, duration | under_pressure (46%), related_events (46%), out (12%), `miscontrol` (7%) |
| `Interception` | 37 | …core…, location, duration, related_events, `interception` | counterpress (27%), under_pressure (2%) |
| `Dribbled Past` | 35 | …core…, location, duration, related_events | counterpress (37%) |
| `Substitution` | 28 | …core…, duration, `substitution` (**no location**) | — |
| `50/50` | 20 | …core…, location, duration, related_events, `50_50`, **under_pressure (100%)** | counterpress (10%), out (5%) |
| `Half Start` / `Half End` | 16/16 | …core…, duration, related_events (**no player, no location**) | — |
| `Tactical Shift` | 14 | …core…, duration, `tactics` (**no player, no location**) | — |
| `Injury Stoppage` | 13 | …core…, duration (**no location**) | `injury_stoppage` (15%) |
| `Starting XI` | 6 | …core…, duration, `tactics` (**no player, no location**) | — |

> **Gotcha: `Duel`, `Clearance`, `Dribble`, `Dispossessed` and `50/50` carry
> `under_pressure: true` 100% of the time.** Per spec v4.0.0 change #3, "events which are
> naturally performed under pressure like duels, dribbles etc, all pick up the attribute, even in
> the absence of an actual pressure event." So `under_pressure` is **not** a usable pressure
> feature on those types — it's a constant. Use it only on `Pass`, `Carry`, `Ball Receipt*`,
> `Shot`, `Ball Recovery`, `Miscontrol`, where it varies (14%, 27%, 6%, 28%, 13%, 46%).

The JSON key for the type-specific sub-object is the snake-cased type name, with these
exceptions:

| `type.name` | Sub-object key |
|---|---|
| `Ball Receipt*` | `ball_receipt` |
| `Goal Keeper` | **`goalkeeper`** (one word) |
| `50/50` | **`50_50`** |
| everything else | lowercase, spaces → underscores |

### 4.4 Sub-object structures (empirical value domains)

Measured across 5 full matches. "%" is the share of that event type carrying the field.

#### `pass` (5392 events)

| Field | % | Observed values |
|---|---:|---|
| `length` | 100 | decimal, yards |
| `angle` | 100 | radians; spec: "0 pointing straight ahead, positive values between 0 and π indicating an angle clockwise, and negative values between 0 and −π representing an angle anti-clockwise" |
| `height` | 100 | `1/Ground Pass`, `2/Low Pass`, `3/High Pass` |
| `end_location` | 100 | `[x, y]` — **always 2 elements, never 3** (unlike shots) |
| `recipient` | 95 | player id/name; absent on incomplete/out passes |
| `body_part` | 95 | `37/Head`, `38/Left Foot`, `40/Right Foot`, `68/Drop Kick`, `69/Keeper Arm`, `70/Other`, `106/No Touch` |
| `outcome` | 16 | `9/Incomplete`, `74/Injury Clearance`, `75/Out`, `76/Pass Offside`, `77/Unknown` — **absent ⇒ the pass was completed** |
| `type` | 15 | `61/Corner`, `62/Free Kick`, `63/Goal Kick`, `64/Interception`, `65/Kick Off`, `66/Recovery`, `67/Throw-in` — **absent ⇒ open-play pass** |
| `switch` | 2 | `true` |
| `cross` | 1 | `true` |
| `aerial_won` | 1 | `true` |
| `assisted_shot_id` | 1 | uuid of the shot this pass assisted |
| `shot_assist` | 1 | `true` |
| `technique` | 1 | `104/Inswinging`, `105/Outswinging`, `108/Through Ball` (`107/Straight` documented, not observed) |
| `through_ball` | <1 | `true` — **still emitted despite spec saying deprecated; co-occurs with `technique: 108/Through Ball`** |
| `inswinging` / `outswinging` | <1 | `true` — legacy duplicates of `technique` 104/105 |
| `goal_assist` | <1 | `true` |
| `no_touch` | <1 | `true` (dummy) |
| `cut_back` | <1 | `true` — **note the underscore**; the spec table renders it `cut-back` |
| `deflected` | <1 | `true` |
| `miscommunication` | <1 | `true` |

Spec definitions worth quoting for phase features:
- **cross** — "A pass is marked as a cross if it originates from any of the following attacking
  zones (on either side of the pitch) and intersects the following zone" (Appendix 6, diagram only).
- **cut_back** — "Cutbacks are low or ground passes that originate in zone A (on either side of
  the pitch) and end in zone B" (Appendix 5, diagram only).
- **switch** — "Added if the pass was a switch (ball transitioned at least 50% of the pitch
  vertically)… A switch is any pass that travels more than 40 yards of the width of the pitch."
- **through_ball** (technique 108) — "Pass cuts last line of defence".

> **Recommendation:** detect through balls with
> `pass.get("technique", {}).get("id") == 108 or pass.get("through_ball")`. Both appear; the
> `technique` form is the modern one and was present on every through ball sampled.

#### `shot` (120 events)

| Field | % | Observed values |
|---|---:|---|
| `statsbomb_xg` | 100 | float 0–1 |
| `end_location` | 100 | `[x,y]` **or** `[x,y,z]` — branch on length |
| `technique` | 100 | `91/Half Volley`, `92/Lob`, `93/Normal`, `94/Overhead Kick`, `95/Volley` (spec also: `89/Backheel`, `90/Diving Header`) |
| `body_part` | 100 | `37/Head`, `38/Left Foot`, `40/Right Foot`, `70/Other` |
| `type` | 100 | `62/Free Kick`, `87/Open Play`, `88/Penalty` (spec also: `61/Corner`, `65/Kick Off`) |
| `outcome` | 100 | `96/Blocked`, `97/Goal`, `98/Off T`, `99/Post`, `100/Saved`, `101/Wayward` (spec also: `115/Saved Off T`, `116/Saved To Post`) |
| `freeze_frame` | 99 | See §3.6. The one miss was a penalty. |
| `key_pass_id` | 72 | uuid of the assisting pass. **Reciprocal of `pass.assisted_shot_id`.** |
| `first_time` | 34 | `true` |
| `aerial_won` | 8 | `true` |
| `deflected` | 3 | `true` |
| `one_on_one` | 2 | `true` — **not in the Events v4.0.0 spec** |
| `open_goal` | <1 | `true` |

#### `carry` (4349 events)

| Field | % | Notes |
|---|---:|---|
| `end_location` | 100 | `[x, y]`. Combined with the event's `location` and `duration`, this is your interpolation segment for animating ball movement. |

#### `duel` (317)

| Field | % | Observed values |
|---|---:|---|
| `type` | 100 | `10/Aerial Lost`, `11/Tackle` |
| `outcome` | 47 | `4/Won`, `13/Lost In Play`, `14/Lost Out`, `16/Success In Play`, `17/Success Out` |

Absent `outcome` ⇒ `type` is `10/Aerial Lost` (the loss *is* the outcome).

#### `interception` (108)

| Field | % | Observed values |
|---|---:|---|
| `outcome` | 100 | `4/Won`, `13/Lost In Play`, `14/Lost Out`, `16/Success In Play` (spec also `1/Lost`, `15/Success`, `17/Success Out`) |

#### `clearance` (192)

| Field | % | Observed values |
|---|---:|---|
| `body_part` | 100 | `37/Head`, `38/Left Foot`, `40/Right Foot` |
| `head` / `right_foot` / `left_foot` | 59 / 22 / 17 | `true` — **legacy duplicates of `body_part`; undocumented.** Ignore; use `body_part`. |
| `aerial_won` | 28 | `true` |

#### `dribble` (122)

| Field | % | Observed values |
|---|---:|---|
| `outcome` | 100 | `8/Complete`, `9/Incomplete` |
| `nutmeg` | 10 | `true` |
| `overrun` | 5 | `true` |

#### `goalkeeper` (154)

| Field | % | Observed values |
|---|---:|---|
| `type` | 100 | `25/Collected`, `26/Goal Conceded`, `27/Keeper Sweeper`, `28/Penalty Conceded`, `30/Punch`, `32/Shot Faced`, `33/Shot Saved` |
| `position` | 77 | `42/Moving`, `43/Prone`, `44/Set` |
| `end_location` | 53 | `[x,y]` — **not documented in the Events spec** |
| `outcome` | 46 | `15/Success`, `47/Claim`, `48/Clear`, `49/Collected Twice`, `52/In Play Danger`, `53/In Play Safe`, `55/No Touch`, `56/Saved Twice`, `58/Touched In`, `59/Touched Out`, `117/Punched out` |
| `technique` | 24 | `45/Diving`, `46/Standing` |
| `body_part` | 18 | `35/Both Hands`, `37/Head`, `39/Left Hand`, `40/Right Foot`, `41/Right Hand` |

Spec: "Every shot will have a related goalkeeper event. If a goal is not conceded or a save is
not made, the goalkeeper type will be 'Shot Faced'."

#### Smaller sub-objects

| Event | Field | % of that type | Observed values |
|---|---|---:|---|
| `Ball Receipt*` | `ball_receipt.outcome` | 12 | `9/Incomplete` — **absent ⇒ the receipt was completed** |
| `Ball Recovery` | `ball_recovery.recovery_failure` | 8 | `true` |
| | `ball_recovery.offensive` | <1 | `true` |
| `Foul Committed` | `foul_committed.card` | 24 | `7/Yellow Card`, `5/Red Card` ⚠ (see §8) |
| | `foul_committed.advantage` | 8 | `true` |
| | `foul_committed.offensive` | 1 | `true` |
| | `foul_committed.type` | <1 | `24/Handball` |
| | `foul_committed.penalty` | <1 | `true` |
| `Foul Won` | `foul_won.defensive` | 30 | `true` |
| | `foul_won.advantage` | 8 | `true` |
| | `foul_won.penalty` | <1 | `true` |
| `Block` | `block.deflection` | 5 | `true` |
| | `block.offensive` / `save_block` | <1 | `true` |
| `50/50` | `50_50.outcome` | 100 | `1/Lost`, `2/Success To Opposition`, `3/Success To Team`, `4/Won` ⚠ (see §8) |
| `Miscontrol` | `miscontrol.aerial_won` | 6 | `true` |
| `Substitution` | `substitution.outcome` | 100 | `102/Injury`, `103/Tactical` |
| | `substitution.replacement` | 100 | player id/name **coming ON**; the event's own `player` is coming OFF |
| `Bad Behaviour` | `bad_behaviour.card` | 100 | `7/Yellow Card` |
| `Injury Stoppage` | `injury_stoppage.in_chain` | 12 | `true` |
| `Starting XI` / `Tactical Shift` | `tactics.formation` | 100 | integer-as-string, e.g. `4231`, `442`, `343` |
| | `tactics.lineup[]` | 100 | `{player:{id,name}, position:{id,name}, jersey_number:int}` |

#### Positions

*Empirical* — every `position.id` observed in the sample:

| id | name | id | name |
|---:|---|---:|---|
| 1 | Goalkeeper | 13 | Right Center Midfield |
| 2 | Right Back | 15 | Left Center Midfield |
| 3 | Right Center Back | 16 | Left Midfield |
| 4 | Center Back | 17 | Right Wing |
| 5 | Left Center Back | 18 | Right Attacking Midfield |
| 6 | Left Back | 19 | Center Attacking Midfield |
| 7 | Right Wing Back | 20 | Left Attacking Midfield |
| 8 | Left Wing Back | 21 | Left Wing |
| 9 | Right Defensive Midfield | 22 | Right Center Forward |
| 10 | Center Defensive Midfield | 23 | **Center Forward** ⚠ |
| 11 | Left Defensive Midfield | 24 | Left Center Forward |
| 12 | Right Midfield | 25 | Secondary Striker (spec; not observed) |

⚠ Spec Appendix 1 names id 23 **"Striker" (ST)**; the actual data says **"Center Forward"**.
Id 14 ("Center Midfield") exists in the spec but was not observed in the sample.

### 4.5 Lineups file

*Empirical*, `data/lineups/3930158.json` — array of 2 team objects
(`team_id`, `team_name`, `lineup[]`):

```json
{
  "player_id": 3053, "player_name": "Leroy Sané", "player_nickname": null,
  "jersey_number": 19, "country": { "id": 85, "name": "Germany" }, "cards": [],
  "positions": [
    { "position_id": 21, "position": "Left Wing", "from": "62:02", "to": "62:22",
      "from_period": 2, "to_period": 2,
      "start_reason": "Substitution - On (Tactical)", "end_reason": "Tactical Shift" },
    { "position_id": 17, "position": "Right Wing", "from": "62:22", "to": null,
      "from_period": 2, "to_period": null,
      "start_reason": "Tactical Shift", "end_reason": "Final Whistle" }
  ]
}
```

`positions[]` gives a full time-sliced position history per player, with `from`/`to` as
`MM:SS` match-clock strings and explicit `from_period`/`to_period`. **This is the cleanest source
for "who was on the pitch, in which role, at time T"** — much easier than replaying
`Substitution` / `Tactical Shift` events. Useful for labelling anonymous 360 dots by likely role.

---

## 5. Possession chains — observed behaviour

*From spec* (Events v4.0.0):

> `possession` — "Indicates the current unique possession in the game. A single possession denotes
> a period of play in which the ball is in play and a single team is in control of the ball."
>
> `possession_team` — "The ID of the team that started this possession in control of the ball.
> **Note that this will appear even on opposition events like tackles attempted during the
> possession.**"
>
> "New possession are triggered after a team demonstrate they've established control of the ball.
> A new possession can begin even if the same team has possession of the ball for example, a
> blocked pass goes out for a throw in for the same team, this would be a new possession for the
> same attacking team."

### 5.1 Verified invariants

*Empirical*, checked on matches **3930158**, **3943043**, **3941017** (and spot-checked on
3788741, 3942349):

| Property | Result |
|---|---|
| `index` contiguous 1..N and file order == index order | ✅ **true in every match** |
| `possession` monotonically non-decreasing in index order | ✅ **true in every match** |
| `possession` values contiguous 1..max, no gaps | ✅ **true in every match** |
| `possession_team` constant within a `possession` value | ✅ **0 violations** across 480 possessions |
| `possession == 0` ever occurs | ❌ never (numbering starts at 1) |
| Possessions per match | 138 / 147 / 195 (the 195 is a 4-period ET match) |

**So: `possession` is a safe, dense, monotonic grouping key.** You can `GROUP BY (match_id,
possession)` without further cleaning.

### 5.2 ⚠ Possessions span half boundaries — you must break on `period`

*Empirical.* **5 of 480 possessions sampled contained events from more than one period.** This is
not a data error; it is how the numbering works. Match 3930158:

```
idx1725  P1  48:33.941  poss=66  pt=Scotland  pp=From Free Kick  Half End    (Scotland)
idx1726  P1  48:33.941  poss=66  pt=Scotland  pp=From Free Kick  Half End    (Germany)
idx1727  P2  00:00.000  poss=66  pt=Scotland  pp=From Free Kick  Half Start  (Germany)
idx1728  P2  00:00.000  poss=66  pt=Scotland  pp=From Free Kick  Half Start  (Scotland)
```

The `Half End` of period 1 and the `Half Start` of period 2 **share possession number 66**, and
inherit the `play_pattern` (`From Free Kick`) and `possession_team` of the last live possession
of the first half. The same happens at every period boundary including into extra time and into
the shootout.

> **Ingest rule: segment phases on `(match_id, period, possession)`, not `(match_id,
> possession)`.** Otherwise your "phases" will contain a 15-minute half-time gap and a bogus
> `play_pattern`.

Similarly, **possession 1 is not a real possession**: it contains only the two `Starting XI`
events and the two `Half Start` events, all at `00:00:00.000`, with `possession_team` arbitrarily
set to the kick-off team. The first real passage of play is possession 2 with
`play_pattern: 9 / From Kick Off`.

### 5.3 What happens at a possession boundary

*Empirical*, 3 matches, 477 boundaries:

| | Count | Share |
|---|---:|---:|
| `possession_team` **changes** (a genuine turnover) | 318 | 66.7% |
| `possession_team` **stays the same** (restart to the same team) | 159 | 33.3% |

**So one in three possession increments is NOT a turnover.** If your "phase" concept means
"a spell of one team having the ball", you must merge consecutive possessions with the same
`possession_team`. If it means "a passage of play between restarts", the raw `possession` is
already what you want. Halfspace should probably support both and expose the choice.

The most common **last** event of a possession, split by whether the team changed:

| Last event type | Team changes | Team stays |
|---|---:|---:|
| `Ball Receipt*` | 111 | 0 |
| `Foul Won` | 10 | **49** |
| `Pass` | 39 | 0 |
| `Goal Keeper` | 27 | 17 |
| `Block` | 21 | **21** |
| `Clearance` | 7 | **20** |
| `Miscontrol` | 18 | 0 |
| `Duel` | 15 | 16 |
| `Dispossessed` | 14 | 0 |
| `Pressure` | 8 | 0 |
| `Shot` | 7 | 0 |
| `Dribble` | 7 | 0 |
| `Substitution` | 0 | 8 |

The `Foul Won` → same-team pattern is the classic "won a free kick, restart is a new possession
for the same team". `Block`/`Clearance` split evenly because the ball may rebound either way.

The most common **first** event of a new possession, with its `play_pattern`:

| play_pattern | First event | `pass.type` | n |
|---|---|---|---:|
| From Throw In | Pass | Throw-in | 313 |
| From Free Kick | Pass | Free Kick | 210 |
| Regular Play | Ball Recovery | — | 179 |
| Regular Play | Pass | Recovery | 169 |
| From Goal Kick | Pass | Goal Kick | 139 |
| From Corner | Pass | Corner | 76 |
| Regular Play | Duel | — | 63 |
| From Kick Off | Pass | Kick Off | 49 |
| Regular Play | Interception | — | 31 |
| From Keeper | Goal Keeper | — | 30 |
| Regular Play | Pass | Interception | 25 |
| From Keeper | Pass | — | 18 |
| From Counter | Ball Recovery | — | 14 |
| Other | Referee Ball-Drop | — | 10 |
| From Counter | Pass | Recovery | 10 |
| Regular Play | Starting XI | — | 9 |
| From Free Kick | Shot | — | 5 |

### 5.4 ⚠ `team != possession_team` inside a possession

Both teams' events appear inside a single possession chain. Example from match 3930158,
possession 4 (Germany in possession):

```
Pressure      Germany   [104.5, 27.1]
Pass          Scotland  [13.6, 58.2]     <-- Scotland event, inside Germany's possession
Block         Germany   [103.8, 21.7]
```

**Implications:**
- `possession_team` tells you whose chain it is; `team` tells you who did the action.
- To compute "the attacking team's passes in this phase", filter
  `team.id == possession_team.id`, not just the possession.
- To render a phase, mirror every event where `team.id != possession_team.id` (§3.2) so the whole
  phase is in one frame.

### 5.5 `play_pattern` is (almost) constant within a possession

*Empirical:* of 480 possessions across 3 matches, **476 had a single `play_pattern` value** and
only **4 had two** — and in every one of those the pair was `('From Counter', 'Regular Play')`,
i.e. the counter-attack tag being applied part-way through a chain. This makes sense given the
spec's note that From Counter "is not part of collection and is derived from the logic above".

> Treat `play_pattern` as a possession-level attribute. For the 4-in-480 mixed case, take the
> value of the **last** event (the counter tag), or store both.

### 5.6 Penalty shootouts (period 5) — exclude from phase search

*Empirical*, match 3942349 (Portugal 0–0 France, won on penalties):

```
periods: {1: 1958, 2: 1881, 3: 731, 4: 603, 5: 22}

period 5 event types: {Shot: 9, Goal Keeper: 9, Half Start: 2, Half End: 2}

idx5174  ts=00:00:00.000  min=120  poss=178  pt=France    Half Start  Portugal  pp=From Keeper
idx5176  ts=00:00:03.794  min=120  poss=179  pt=France    Shot        France    loc=[108.1,40.1]  pp=Other
idx5177  ts=00:00:04.480  min=120  poss=179  pt=France    Goal Keeper Portugal  loc=[1.0, 40.0]   pp=Other
idx5178  ts=00:00:59.455  min=120  poss=180  pt=Portugal  Shot        Portugal  loc=[108.1,40.1]  pp=Other
```

Each penalty is its **own possession**, `play_pattern` is always `5 / Other`, `minute` stays
pinned at 120, every shot is at exactly `[108.1, 40.1]` and every keeper at `[1.0, 40.0]`.
Only 9 of 22 period-5 events had a 360 frame.

> **Ingest rule: filter out `period == 5`.** Shootout "possessions" are degenerate one-shot
> phases with no spatial content and will pollute every phase feature you compute.

---

## 6. Timestamps, ordering and 360 linkage

### 6.1 Correct event ordering

> **Order by `index` ascending. Full stop.**

*Empirical:* in every match sampled, `index` is contiguous `1..N`, and the array order in the
JSON file already matches it. `index` is the authoritative sequence — StatsBomb's own
"sequence notation for the ordering of events within each match" (spec).

**Do not order by `timestamp` alone.** `timestamp` resets to `00:00:00.000` at the start of every
period, so a global timestamp sort interleaves the halves. If you must sort by time, use
`(period, timestamp)`. Within a period, `timestamp` is monotonically non-decreasing in index
order — verified on all sampled matches.

**Many events share an identical timestamp**, e.g.:

```
idx9   00:00:07.397  Ball Receipt*  Germany
idx10  00:00:07.397  Duel           Scotland
idx11  00:00:07.397  Miscontrol     Germany
```

`index` is the only tiebreaker. Store it and use it as your ORDER BY.

### 6.2 Period and clock behaviour

*Empirical*, from three matches:

| period | Meaning | `timestamp` starts at | `minute` starts at | Observed max timestamp |
|---:|---|---|---:|---|
| 1 | 1st half | `00:00:00.000` | 0 | ~`00:48:58` (with stoppages) |
| 2 | 2nd half | `00:00:00.000` | 45 | ~`00:52:01` |
| 3 | ET first half | `00:00:00.000` | 90 | ~`00:16:10` |
| 4 | ET second half | `00:00:00.000` | 105 | ~`00:16:14` |
| 5 | Penalty shootout | `00:00:00.000` | 120 (pinned) | ~`00:10:00` |

So `timestamp` is **time elapsed within the current period**, and `minute`/`second` are the
**match clock**. The relation is roughly
`minute*60 + second ≈ period_offset + timestamp_seconds` where `period_offset` ∈
{0, 2700, 5400, 6300, 7200}. For animation timing use `timestamp` (millisecond precision);
for display use `minute:second`.

### 6.3 Event counts per match

*Empirical*, 14 full matches:

| Scenario | Events per match |
|---|---|
| 90-minute match | **3,300 – 4,000** (median ≈ 3,500) |
| Match going to extra time | **4,700 – 4,800** |
| Match going to a shootout | **~5,200** |

For the recommended 102-match dataset expect **≈ 380,000 – 400,000 events** total, of which
**≈ 330,000 – 350,000 carry a 360 frame**, containing **≈ 5.5 million player position records**
(median 16 players/frame).

### 6.4 360 linkage — verified

| Question | Answer |
|---|---|
| Join key? | **`three_sixty.event_uuid` → `event.id`.** Confirmed by spec ("The unique identifier for the event matching this freeze frame") and empirically. |
| Any orphan `event_uuid`s? | **No.** In every sampled match, `{event_uuid} ⊆ {event.id}`. |
| Duplicate `event_uuid`s within a file? | **No.** One frame per event, maximum. |
| Is the 360 file ordered? | It follows the events' order but **do not rely on it** — build a dict keyed on `event_uuid`. |
| Fraction of events with a frame? | **82–92%, mean ≈ 87%** (see §2.4). |

The 360 file has **no `match_id` field** — the match identity is carried only by the filename.
Thread it through from the file path at ingest time.

---

## 7. Play patterns and phase-relevant semantics

### 7.1 `play_pattern` values

*From spec* (Events v4.0.0), with *empirical* counts from 9 full matches (33,640 events):

| id | Name | Spec meaning (verbatim) | Observed count | Share |
|---:|---|---|---:|---:|
| 1 | Regular Play | "The event was not part of any of the following play_patterns" | 12,415 | 36.9% |
| 2 | From Corner | "The event was part of the passage of play following a corner." | 1,496 | 4.4% |
| 3 | From Free Kick | "The event was part of the passage of play following a free-kick." | 4,933 | 14.7% |
| 4 | From Throw In | "The event was part of the passage of play following a throw-in." | 8,023 | 23.8% |
| 5 | Other | (used for referee ball-drops and shootouts) | 209 | 0.6% |
| 6 | From Counter | See below | 262 | 0.8% |
| 7 | From Goal Kick | "The event was part of the passage of play following a goal kick." | 2,656 | 7.9% |
| 8 | From Keeper | "The event was part of the passage of play following a keeper distribution." | 1,280 | 3.8% |
| 9 | From Kick Off | "The event was part of the passage of play following the kick off." | 1,366 | 4.1% |

**`6 / From Counter`** — the spec gives a precise derived definition worth reproducing:

> The event was part of a counter attack:
> - The possession started with an open play turnover outside the counter-attacking team's final third.
> - The possession was at least 75% direct towards goal (as measured by our possession chain metrics)
> - The counterattack travelled at least 18 yards towards goal.
> - **This definition is not part of collection and is derived from the logic above.**

Only 0.8% of events — a genuinely rare, high-value tag for phase search.

### 7.2 Pressure semantics

*From spec* (Events v4.0.0 Appendix 7, verbatim):

> Calculated as every on-the-ball event that overlaps the duration of a pressure event. For
> example, if a pressure event appears before a pass, and the pressure's timestamp plus its
> duration encompasses the pass's timestamp, that pass is said to have been made under pressure.
> If a pressure event occurs after a pass, but before the end of the pass (as calculated by using
> its duration), that pass is said to have been received under pressure.

*Empirical verification*, match 3941017 — for each `Pressure` event, the time delta to each of
its `related_events`:

| Measure | Value |
|---|---|
| `Pressure` events | 340 (927 across 3 matches) |
| Have `duration` | 100% |
| `duration`: min / median / p90 / max | 0.054 / **0.60** / 1.50 / 5.45 s |
| Have `related_events` | 93% (median 2 related events) |
| Δt to related event: p10 / median / p90 | −1.45 / **+0.19** / +0.75 s |
| Related event falls *within* the pressure's duration window | **335 / 534 (63%)** |
| Related event occurs *before* the pressure | 196 / 534 (37%) |
| Related event occurs *after* the window closes | 3 / 534 (<1%) |

**So: a `Pressure` event typically fires ~0.2 s before the action it pressures, and its
`duration` (median 0.6 s) is the window during which any on-ball event is "under pressure".**
The 37% that precede the pressure are the "received under pressure" case from the spec.

Related event types of a Pressure (match 3941017): `Carry` 279, `Pass` 129, `Ball Receipt*` 78,
`Ball Recovery` 16, `Dribble` 7, `Foul Won` 7, `Dispossessed` 6, `Miscontrol` 5, `Shot` 3,
`Pressure` 2, `Interception` 1, `Clearance` 1.

**`Pressure.team` is the *defending* team.** Verified: in 307 of 340 Pressure events the
pressuring team is **not** the `possession_team`. (The 33 exceptions are pressures around
possession boundaries where the numbering has already flipped.)

> **Do not derive pressure yourself.** StatsBomb already sets `under_pressure` on the pressured
> event. Use that — but only on the event types where it varies (§4.3).

### 7.3 Counterpress

*From spec* (Events v4.0.0, Summary of Changes v4.0.0 item 2, verbatim):

> "counterpress": an attribute on various defensive events, including: pressure, dribbled past,
> 50 50, duel, block, interception, and foul committed (not offensive). **These are pressing
> actions within 5 seconds of an open play turnover.**

*Empirical*, 3 matches — counterpress placement and rates:

| Event type | With counterpress | Total | Rate |
|---|---:|---:|---:|
| `Pressure` | 174 | 927 | 18.8% |
| `Duel` | 54 | 205 | 26.3% |
| `Block` | 20 | 129 | 15.5% |
| `Dribbled Past` | 13 | 35 | 37.1% |
| `Interception` | 10 | 37 | 27.0% |
| `Foul Committed` | 10 | 75 | 13.3% |
| `Pass` | 6 | 3299 | 0.2% |
| `50/50` | 2 | 20 | 10.0% |

> ### ⚠ `counterpress` is a **TOP-LEVEL** field, not nested
>
> The spec's tables list `counterpress` inside each type's nested object (e.g. under `duel`,
> under `pressure`). **In the actual data it is always at the top level of the event.**
> Verified: 289 events across 3 matches carry `counterpress`, **all of them top-level**;
> **zero** occurrences nested inside any sub-object.
>
> ```python
> is_counterpress = event.get("counterpress", False)     # ✅ correct
> is_counterpress = event["duel"].get("counterpress")    # ❌ always None
> ```
>
> Note `Pass` also carries `counterpress` (6 cases) even though the spec's list omits passes.

Counterpress is an excellent phase-search primitive: "possession regained within 5 s of losing
it" is exactly a gegenpress signature. Query it as: a phase where the possession-winning event
or any event in the first seconds carries `counterpress: true`.

### 7.4 Detecting turnovers and regains

There is no single "turnover" event type. Derive it. Two complementary approaches:

**(a) Possession-level (coarse, robust).** A turnover is a possession boundary where
`possession_team` changes:

```sql
-- a turnover into possession p
SELECT p.match_id, p.period, p.possession
FROM possessions p JOIN possessions prev
  ON prev.match_id = p.match_id AND prev.period = p.period
 AND prev.possession = p.possession - 1
WHERE prev.possession_team_id <> p.possession_team_id;
```

66.7% of boundaries qualify (§5.3). Combine with the previous possession's **last event type** to
classify the turnover:

| Previous-possession last event | Turnover flavour |
|---|---|
| `Ball Receipt*` (incomplete) / `Pass` (incomplete) | **misplaced pass** |
| `Miscontrol` | **bad touch** |
| `Dispossessed` | **tackled off the ball** |
| `Dribble` (incomplete) | **failed take-on** |
| `Shot` | **possession ended in a shot** (not really a turnover) |
| `Foul Won` (team unchanged) | **restart, not a turnover** |
| `Block` / `Clearance` | **defensive intervention** — may or may not change team |

**(b) Event-level (fine, for the exact regain moment).** These types constitute a defensive
*regain* by `team` against `possession_team`:

| Event type | Condition for a genuine regain |
|---|---|
| `Interception` | `interception.outcome.id ∈ {4 Won, 15 Success, 16 Success In Play, 17 Success Out}` |
| `Duel` | `duel.type.id == 11 (Tackle)` **and** `outcome.id ∈ {4, 15, 16, 17}` |
| `Ball Recovery` | **no** `ball_recovery.recovery_failure` |
| `50/50` | `50_50.outcome.id ∈ {3 Success To Team, 4 Won}` |
| `Block` | `block.save_block` absent and the next possession flips |
| `Clearance` | a clearance is a *relief*, not a regain — usually the possession stays with the attacker |
| `Goal Keeper` | `goalkeeper.type.id ∈ {25 Collected, 27 Keeper Sweeper, 34 Smother}` |

The clean composite: **a regain is an event of one of those types whose `team.id` differs from
its own `possession_team.id`, immediately followed by a possession increment where the new
`possession_team.id` equals that event's `team.id`.**

### 7.5 Detecting set-piece starts

Three independent signals; use them together.

**(1) `play_pattern` on the possession** — the possession-level label:

| Set piece | `play_pattern` |
|---|---|
| Corner | `2 / From Corner` |
| Free kick | `3 / From Free Kick` |
| Throw-in | `4 / From Throw In` |
| Goal kick | `7 / From Goal Kick` |
| Keeper distribution | `8 / From Keeper` |
| Kick off | `9 / From Kick Off` |
| Referee ball-drop | `5 / Other` |

**(2) `pass.type` on the first event** — the delivery itself:

| `pass.type` | id |
|---|---:|
| Corner | 61 |
| Free Kick | 62 |
| Goal Kick | 63 |
| Kick Off | 65 |
| Throw-in | 67 |
| *(Interception / Recovery — not set pieces, these mark one-touch passes off a regain)* | 64 / 66 |

**(3) `shot.type`** for shots taken directly from a set piece:
`61/Corner`, `62/Free Kick`, `88/Penalty`, `65/Kick Off`.

*Empirical, verified*: the two signals agree essentially perfectly. Every possession with
`play_pattern: From Throw In` opened with a `Pass` whose `pass.type` was `Throw-in` (313/313);
`From Free Kick` → `Free Kick` (210 of 215, with 5 opening on a direct `Shot` instead);
`From Corner` → `Corner` (76/76); `From Goal Kick` → `Goal Kick` (139/139);
`From Kick Off` → `Kick Off` (49/49).

> **Recommended detector:** a phase is a set piece iff its `play_pattern.id ∈ {2,3,4,7,9}`.
> Refine the *sub*-type from the first event's `pass.type` (which distinguishes an attacking free
> kick delivered into the box from a defensive restart, once you also look at the location).
>
> **Note `8 / From Keeper` is not really a set piece** — it's open-play keeper distribution
> (throws, drop kicks). Decide deliberately whether it belongs in your set-piece bucket.
> Similarly `From Goal Kick` is a dead-ball restart but tactically closer to a build-up phase.

### 7.6 `related_events`

*Empirical.* An array of event `id`s. Not symmetric in practice — always build a bidirectional
index. Presence rates vary widely by type (§4.3): 99% on `Pass`, 100% on `Ball Receipt*` /
`Duel` / `Dribble` / `Shot`, but only 42% on `Ball Recovery` and 46% on `Miscontrol`.

Useful patterns observed:

| Pattern | Meaning |
|---|---|
| `Pass` ↔ `Ball Receipt*` | pass and its receipt (the receipt has the *end* location) |
| `Pass` ↔ `Carry` | receiving player carries on |
| `Carry` ↔ `Dribbled Past` | opponent beaten during the carry |
| `Dribble` ↔ `Dribbled Past` | take-on, both sides |
| `Dribble` ↔ `Duel` | take-on contested |
| `Dispossessed` ↔ `Duel` | tackle from both perspectives |
| `Foul Won` ↔ `Foul Committed` | foul from both perspectives |
| `Shot` ↔ `Goal Keeper` | every shot has a keeper event (spec) |
| `Shot` ↔ `Block` | blocked shot |
| `50/50` ↔ `50/50` | "50/50s are usually recorded for each competitor in the 50/50 event and these two events are paired by a related_event" (spec v1.1) |
| `Own Goal For` ↔ `Own Goal Against` | both teams' records of the same own goal |
| `Pressure` → on-ball event | the pressured action (median 2 related events) |
| `Pass.assisted_shot_id` ↔ `Shot.key_pass_id` | assist link (separate fields, not `related_events`) |

---

## 8. Spec vs. reality — discrepancy log

Every item below was verified in the actual data files. **Trust the data, not the PDF.**

| # | Spec claim | Actual data | Impact |
|---:|---|---|---|
| 1 | `counterpress` is nested inside the type object (e.g. `duel.counterpress`) — Events v4.0.0 tables | **Always top-level** on the event. 289/289 occurrences top-level, 0 nested. | **High.** Reading it from the nested object silently yields `None` everywhere. |
| 2 | `50/50` outcomes are `108/Won`, `109/Lost`, `147/Success To Team`, `148/Success To Opposition` — Events v4.0.0 & Spec v1.1 | **`1/Lost`, `2/Success To Opposition`, `3/Success To Team`, `4/Won`** | **High** if you hard-code IDs. Match on `name`, or use the observed IDs. |
| 3 | Cards are `5/Yellow`, `6/Second Yellow`, `7/Red` — Events v4.0.0 & Spec v1.1 | **`7 = "Yellow Card"`, `5 = "Red Card"`** (27 yellows and 1 red observed in `foul_committed.card`; 6 yellows in `bad_behaviour.card` also id 7) | **High** if you hard-code IDs. The `name` is correct; the numeric mapping in the spec is wrong. |
| 4 | Position id `23` is "Striker" (ST) — Appendix 1 | **`23 = "Center Forward"`** | Low — cosmetic. |
| 5 | `pass.through_ball` is "deprecated" (v1.1.0 change log) | **Still emitted**, alongside `technique: 108/Through Ball` | Low — accept both. |
| 6 | Field named `cut-back` / `shot-assist` / `goal-assist` — Events v4.0.0 table | JSON keys are **`cut_back`, `shot_assist`, `goal_assist`** (underscores) | Medium — the PDF's hyphens are a typesetting artefact. |
| 7 | `clearance` has only `aerial_won` + `body_part` | Also emits redundant **`head` / `left_foot` / `right_foot`** booleans | Low — ignore, use `body_part`. |
| 8 | `shot` fields enumerated in Appendix | **`one_on_one`** observed, not documented | Low. |
| 9 | `goalkeeper` fields enumerated | **`end_location`** observed (53% of GK events), not documented | Low. |
| 10 | GK outcome `117 / "Punched Out"` | Data says **`117 / "Punched out"`** (lowercase o) | Low — don't match on exact case. |
| 11 | 360 spec: "Not all 22 players will be visible", "`visible_area` will not be available for every frame", "Some events will lack a player marked with the 'actor' attribute" | In the Euro 2020/2024/WC2022 data: **`visible_area` present on 100% of 47,185 frames; every frame had exactly one actor; median 15–18 players.** | Positive surprise — but keep the defensive checks; other competitions may differ. |
| 12 | 360 spec: freeze-frame coordinates "oriented in the same direction as the linked event" | True for **~95%**; ~5% (duel-type paired events) are in the **opponent's** frame | **High.** See §3.5 for the detection rule. |
| 13 | `competitions.json` `match_available_360` marks a season as having 360 | **AFCON 2023 is flagged but has only 1 of 52 files, and that one is a 1,962-byte stub** | **High.** Probe files per match; reject sub-50 KB stubs. |
| 14 | Spec Appendix 2 gives pitch mirror as 120 × 80 (implied) | Opposing-team event locations mirror at exactly **120.1 / 80.1** | **High** for exact joins. See §3.2. |
| 15 | Spec lists `type` `5 / "Camera On*"`, `41 / "Referee Ball-Drop"` with asterisks | Only `Ball Receipt*` carries an asterisk in real `type.name`; `Referee Ball-Drop` does not | Low. |

---

## 9. Fetching notes

- **Base URL:** `https://raw.githubusercontent.com/statsbomb/open-data/master/`
- **The GitHub REST API (`api.github.com`) is not usable** from this environment (returns
  "GitHub access to this repository is not enabled for this session"). `raw.githubusercontent.com`
  works fine, both `GET` and `HEAD`. **Enumerate matches from
  `data/matches/{competition_id}/{season_id}.json`, never by listing the events directory.**
- `HEAD` returns a correct `Content-Length`, so you can size the whole download before fetching a
  byte. Use it to (a) budget disk, (b) detect missing/stub 360 files cheaply.
- Parallelism of ~24 concurrent requests was stable across 477 HEAD probes and ~20 full file
  downloads. Be polite; this is a free public repo.
- URL-encode the spec filenames — `Open Data 360 Frames v1.0.0 (1).pdf` contains spaces and
  parentheses.
- **Do not commit raw StatsBomb JSON to this repository** (licence clause 1.2.1). Fetch into a
  gitignored cache directory; commit only derived, aggregated artefacts.

### Suggested ingest order

1. `data/competitions.json` → pick `(competition_id, season_id)` pairs.
2. `data/matches/{comp}/{season}.json` → match list, `match_status_360 == "available"` filter.
3. `HEAD data/three-sixty/{match_id}.json` → confirm existence **and** size > 50 KB.
4. For each surviving match, fetch `events/{id}.json`, `three-sixty/{id}.json`,
   `lineups/{id}.json`.
5. Parse events ordered by `index`; drop `period == 5`; segment on `(period, possession)`.
6. Index 360 frames by `event_uuid`; resolve per-frame orientation (§3.5) at ingest time and
   store the canonical (possession-team-frame) coordinates.

---

## 10. Quick reference for the phase-search schema

Minimum fields to persist per event for phase building and replay:

```
match_id, id, index, period, timestamp, minute, second, duration,
type_id, type_name,
possession, possession_team_id, team_id, player_id, position_id,
play_pattern_id,
location_x, location_y,                    -- raw, in the acting team's frame
canon_x, canon_y,                          -- mirrored into possession_team's frame
end_x, end_y, end_z,                       -- pass.end_location / carry.end_location / shot.end_location
under_pressure, counterpress, out, off_camera,
outcome_id,                                -- the sub-object's outcome, normalised
pass_type_id, pass_height_id, pass_length, pass_angle,
pass_cross, pass_cut_back, pass_switch, pass_through_ball, pass_body_part_id,
shot_xg, shot_type_id, shot_body_part_id, shot_technique_id, shot_key_pass_id,
related_event_ids[]
```

Per phase (`match_id, period, possession`):

```
possession_team_id, play_pattern_id,
start_index, end_index, start_ts, end_ts, duration_s,
n_events, n_passes, n_team_passes,
start_x, end_x, max_x, x_progression,      -- all in canonical frame
ended_in_shot, ended_in_goal, sum_xg,
is_set_piece, set_piece_type,
is_turnover_start, turnover_flavour, had_counterpress,
n_events_with_360
```

Per 360 frame:

```
match_id, event_id, orientation ('event'|'mirrored'|'unknown'),
visible_area[],                            -- flat [x1,y1,...,x1,y1] closed polygon
players[] of { canon_x, canon_y, is_possession_team, is_actor, is_keeper }
```

Note `is_possession_team` rather than `teammate`: after canonicalising the frame, "teammate of
the actor" is ambiguous, so resolve it once at ingest against the phase's possession team.
