# Halfspace — phase definitions

What every column in `phases.parquet` means, in plain English, and why it was
defined that way. If you disagree with a choice here, this is the file to argue
with: each definition is stated precisely enough to be wrong.

Every number quoted below was measured on the built dataset (102 matches,
**16,782 phases**) or by `ingest/scripts/calibrate.py`. Nothing is estimated.

Schema facts about the source data come from `docs/statsbomb-notes.md`; section
references like "§5.3" point there.

---

## 1. What a phase is

> **A phase is one StatsBomb possession chain: every event sharing a
> `(match_id, period, possession)` key.**

Three decisions are baked into that sentence.

**Period is part of the key.** StatsBomb's `possession` counter runs straight
through half-time — the last possession of the first half and the first
bookkeeping events of the second share a possession number (§5.2). Grouping on
`possession` alone would produce "phases" containing a fifteen-minute interval.

**Penalty shootouts are excluded.** Period 5 possessions are one shot each, all
taken from exactly `[108.1, 40.1]`, with `minute` pinned at 120 (§5.6). They
have no spatial content and would pollute every distribution. A shootout still
decides the tie; it just is not a passage of play.

**Consecutive possessions by the same team are NOT merged.** One in three
possession increments is a restart to the same team rather than a turnover
(§5.3) — you win a free kick, and the restart opens a new possession with the
ball still yours. Two readings are defensible:

| Reading | What one phase means |
|---|---|
| Merge same-team chains | "a spell of one team having the ball" |
| **Keep them separate (chosen)** | **"a passage of play between restarts"** |

Halfspace takes the second. A throw-in is a new attacking problem with a new
defensive shape; blurring it into the move that preceded it would make "how
often does Spain score from a throw-in in the final third" unanswerable. It also
keeps `possession` a single integer per phase, so any phase can be traced back
to exactly one chain in the raw data.

**Empty groups are dropped.** Possession 1 contains only the two `Starting XI`
and two `Half Start` events, and every period boundary leaves behind a group of
`Half Start` events carrying the previous chain's possession number. A group is
kept only if it contains at least one event that is both located and
non-administrative. This removed 1,088 stub groups; 16,782 phases survive, a
median of 164 per match (min 110, max 233 — the maximum is a match that went to
extra time).

## 2. Coordinates

Everything in every artifact is in **one frame**: the phase's possession team
attacks from x=0 toward x=120, on a 120 × 80 pitch, with y=0 the touchline on
that team's **left**. The web app never flips anything.

Opponent events inside a chain are common (§5.4) — a pressure, a block, a
tackle — and each of those is recorded in the *opponent's* own attacking frame.
They are mirrored with **`(120.1 − x, 80.1 − y)`**, not 120/80: event locations
sit on a 0.1-offset grid and the larger constant is exact on every cross-team
event pair tested (§3.2). It matters, because an off-by-0.1 mirror breaks the
exact join between an event and its own 360 actor dot.

360 freeze-frame coordinates are full-precision floats *off* that grid, so those
mirror about the true `(120 − x, 80 − y)`.

Sanity check on the built data, which is the real proof the normalization works:

| | mean canonical x |
|---|---:|
| Goalkeeper events by the team in possession | **6.0** |
| Shots by the team in possession | **104.2** |
| Goalkeeper events by the opponent | **117.3** |
| Shots by the opponent | **24.4** |

Both teams' geometry lands where it should, and the two rows mirror each other.

## 3. Zones

The pitch is cut 3 × 3 in the attacking team's frame.

* Thirds: `def_third` x < 40, `mid_third` 40 ≤ x < 80, `final_third` x ≥ 80.
* Channels: `left` y < 26.67, `centre` 26.67 ≤ y < 53.33, `right` y ≥ 53.33.

Boundaries belong to the **upfield** third and the **higher-y** channel, so the
nine zones partition the pitch with no gaps and no overlaps. Enum values are
`def_third_left` … `final_third_right`.

`start_zone` is the zone of the first point of the phase's ball path;
`end_zone` the zone of the last. **Box detection does not use zones** — it uses
the real penalty area from the spec, x ≥ 102 and 18 ≤ y ≤ 62.

## 4. The ball path

Several features and the whole `path_xy` column depend on one construction:

> **The ball path is the ordered sequence of canonical locations recorded for
> the team in possession** — each event's `location`, plus its `end_location`
> where one exists (pass, carry, shot, keeper distribution) — with `Pressure`
> and administrative events excluded and consecutive duplicate points removed.

Two judgements are in there.

*Only the possession team's events.* Opponent events inside the chain describe
where a **defender** was, not where the ball went. Including them makes a
patient build-up look like it teleports between penalty areas.

*Incomplete passes still count.* An intercepted pass's `end_location` is where
the ball actually arrived — it just arrived at nobody. Dropping those would make
"this move reached the box" quietly false for every attack that ended with a
cross cut out on the six-yard line.

## 5. Timing

`start_ts` is the first event's timestamp (seconds into the period).
`end_ts` is the largest `timestamp + duration` over the phase's **ball** events.
`duration_s` is the difference. `minute`/`second` are the match clock at the
phase's start; `abs_start_s` is seconds from kick-off, already offset per period.

The clock deliberately stops at the last ball event. Scotland v Hungary 2024 has
a possession whose final three events are Barnabás Varga's six-minute medical
stoppage, two substitutions and a booking: measured naively it is a 393-second
possession with 7 events. Excluding trailing administrative events makes it the
~2-second possession it actually was, and stops one injury from producing a
nonsense `direct_speed_m_s`.

Measured: mean phase duration **21.2 s**, median **13.6 s**, mean 22.6 events,
mean 6.2 passes by the team in possession.

## 6. `start_type` — how the phase began

Enum: `kick_off | goal_kick | corner | free_kick | throw_in |
turnover_open_play | regular`.

1. If `play_pattern` is one of From Kick Off / From Goal Kick / From Corner /
   From Free Kick / From Throw In, use it. This is a possession-level label and
   it agrees with the delivery's own `pass.type` essentially perfectly (§7.5).
2. Otherwise, if the chain's first pass by the team in possession carries a
   set-piece `pass.type` anyway, use that. (A safety net for the handful of
   restarts `play_pattern` labels Regular Play.)
3. Otherwise — Regular Play, From Counter, From Keeper, Other — ask whether the
   ball **actually changed hands**: if the previous chain *in the same period*
   belonged to the other team, this is `turnover_open_play`; if it belonged to
   the same team, it is `regular`.

Step 3 is the important one. The possession increment on its own is not a
turnover signal, because a third of increments are same-team restarts (§5.3).
Asking who owned the previous chain is the only way to tell "we won it back"
from "we kept it and restarted".

`From Keeper` (open-play keeper distribution) has no slot in the contract's
enum. It falls through to step 3 and lands correctly: a keeper claiming a cross
becomes `turnover_open_play`, a keeper restarting his own team's move becomes
`regular`. `regular` is therefore a small residual (3.5%).

| start_type | phases | share |
|---|---:|---:|
| turnover_open_play | 6,921 | 41.2% |
| throw_in | 3,631 | 21.6% |
| free_kick | 2,621 | 15.6% |
| goal_kick | 1,567 | 9.3% |
| corner | 973 | 5.8% |
| regular | 582 | 3.5% |
| kick_off | 487 | 2.9% |

## 7. `outcome` — how the phase ended

Enum and precedence, in the order given by `docs/CONTRACT.md` §2:

**1. `goal`** — the team in possession scored. That means either a shot of
theirs with outcome `Goal`, **or an `Own Goal Against` event by the opponent**
(see §8 below).

**2. `shot_on_target`** — a shot by the team in possession with outcome `Saved`
or `Saved To Post`. "On target" here means *the ball was going in and only the
keeper or the frame of the goal stopped it*.

**3. `shot_off_target`** — any other shot by the team in possession. This
bucket contains `Blocked`, `Off T`, `Post`, `Wayward` and `Saved Off T`. Two of
those deserve a note: a **blocked** shot was stopped by an outfield defender
before the goal was tested, and a shot **off the post** was never on target.
Neither is a save. The contract offers only two shot buckets, so both sit here;
if you want them separated, `phase_events.outcome_name` has the exact value.

**4. `lost_ball`** — the chain's last meaningful event says the ball was
conceded in open play: our miscontrol, dispossession or error; our incomplete
pass, receipt or take-on; our foul conceded; or the opponent's interception,
recovery, duel, block, clearance, dribbled-past or keeper collection.
This is also the residual when nothing else matches.

**5. `out_of_play`** — the last meaningful event carries `out`, or is a pass
with outcome `Out` / `Pass Offside`, or is an `Offside`.

**6. `foul_won`** — the last meaningful event is our `Foul Won`, or the
opponent's `Foul Committed` (the same moment from the other side).

**7. `end_of_period`** — the chain contains a `Half End` and nothing above fired.

The shot tests scan the whole phase; tests 4–7 look only at the last meaningful
event (administrative events and `Pressure` skipped), so in practice they are
mutually exclusive and the precedence order only ever decides "the move produced
a shot **and then** the ball went out" — which should be labelled by the shot,
and is.

| outcome | phases | share | mean xG |
|---|---:|---:|---:|
| lost_ball | 11,910 | 71.0% | — |
| foul_won | 1,754 | 10.5% | — |
| shot_off_target | 1,505 | 9.0% | 0.0724 |
| out_of_play | 693 | 4.1% | — |
| shot_on_target | 557 | 3.3% | 0.1048 |
| goal | 253 | 1.5% | 0.2746 |
| end_of_period | 110 | 0.7% | — |

## 8. Own goals, and the six goals that belong to nobody's chain

There are **238 goal-scoring shots and 21 `Own Goal Against` events** in the
102 matches outside penalty shootouts: **259 goals**. Only 253 phases carry
`outcome = 'goal'`. The missing six are real, and they are interesting.

**Own goals count as a goal for the team that benefits.** An `Own Goal Against`
event belongs to the team that put the ball in its own net, and normally sits
inside the *attacking* team's possession chain — so a chain containing the
opponent's own goal is a chain that ended in a goal for us. Excluding own goals
would mean a search for "phases that ended in a goal" silently missed real ones,
including three of Euro 2020's record eleven.

**Six goals were scored by the team that did not own the chain.** The ball
changed hands and went in so quickly that StatsBomb never opened a new
possession. These cannot be `outcome = 'goal'` — that would credit Italy with
Albania's goal — so they get a separate boolean column, **`goal_conceded`**:

| Match | Minute | Chain owner | Scorer |
|---|---:|---|---|
| Italy 2–1 Albania (2024) | 0 | Italy | Nedim Bajrami |
| Scotland 1–1 Switzerland (2024) | 25 | Scotland | Xherdan Shaqiri |
| Turkey 3–1 Georgia (2024) | 96 | Georgia | Kerem Aktürkoğlu |
| Croatia 3–5 Spain (2020) | 19 | Spain | Pedri / Unai Simón (own goal) |
| Scotland 0–2 Czech Republic (2020) | 51 | Scotland | Patrik Schick |
| Russia 1–4 Denmark (2020) | 58 | Russia | Yussuf Poulsen |

Bajrami's is the fastest goal in European Championship history — scored 23
seconds in, off a stolen Italy throw-in that StatsBomb still counts as Italy's
possession. That the model surfaces it as an anomaly rather than swallowing it
is the point.

So the accounting closes exactly, and the validation suite asserts it per
competition:

```
goals in raw events  =  phases with outcome 'goal'  +  phases with goal_conceded
        259          =            253               +            6
```

which also equals the sum of `home_score + away_score` over all 102 matches.

## 9. Progression and speed

StatsBomb's axes are nominal **yards** (spec Appendix 2), but `CONTRACT.md` §3b
pins the published columns as true **metres**, converted at **0.9144 m/yard**
on x-axis deltas only.

* **`progression_m`** = (last ball-path x − first ball-path x) × 0.9144, in
  metres. Signed: a move that goes backwards gets a negative number. Dataset
  mean **31.8 m**.
* **`direct_speed_m_s`** = `progression_m / duration_s` (m/s), or 0 when the
  phase is shorter than 0.05 s. Dataset mean **2.93 m/s**.

Note the pitch coordinates themselves (`start_x`, `end_x`, `max_x`, `path_xy`,
and everything in `phase_events` / `phase_frames`) stay in **StatsBomb x/y
units** on the 120 × 80 grid, because that is the frame the pitch is drawn in.
Only the two `_m` columns are converted.

The thresholds in the feature definitions below are stated and evaluated in
**yards**, because that is the unit the football definitions and the StatsBomb
spec use; the conversion happens only on the way out.

## 10. `switch_of_play`

> The team in possession played at least one pass that moved the ball **40 or
> more yards across** the pitch (|Δy| ≥ 40), or that StatsBomb flagged
> `pass.switch`.

StatsBomb's spec defines a switch as "any pass that travels more than 40 yards
of the width of the pitch", and the data backs that literally. Over 20,469
passes in 20 matches:

| | n | min \|Δy\| | p50 | p95 | max |
|---|---:|---:|---:|---:|---:|
| flagged `pass.switch` | 646 | **40.0** | 46.2 | 65.3 | 79.9 |
| not flagged | 19,823 | — | 10.6 | 31.4 | **39.9** |

A 40-yard cut-off reproduces the flag **exactly**: no unflagged pass reaches 40,
no flagged pass falls below it. Lower cut-offs would not — 35 yards would add
489 unflagged passes, 30 yards would add 1,246. So the flag and the geometric
rule are the same rule, and keeping both is only belt-and-braces.

Result: **2,637 phases (15.7%)** contain a switch.

## 11. `high_press_regain`

> The phase started with an **open-play turnover**, the ball was won **in the
> final third** (x ≥ 80), **and** the winning team was demonstrably pressing —
> either the ball-winning event carries `counterpress`, or that team registered
> at least one `Pressure` event in the **5 seconds** before the phase began.

Three clauses, each earning its place.

*Open-play turnover.* A corner is not a press. Set-piece starts are excluded by
construction.

*x ≥ 80.* The final third is 40 yards from the opponent's goal, which is the
usual analytical line for a "high" turnover. The data says it is the right place
to draw it — of 6,921 open-play turnover phases:

| Where the ball was won | phases | share | led to a shot | mean xG |
|---|---:|---:|---:|---:|
| Own third | 4,002 | 57.8% | | |
| Middle third | 2,590 | 37.4% | | |
| **Final third (x ≥ 80)** | **329** | **4.8%** | **23.4%** | **0.0214** |
| everything else | 6,592 | 95.2% | 12.5% | 0.0122 |

Winning it in the final third nearly doubles both the shot rate and the expected
goals of the possession that follows.

*Evidence of a press.* Without this clause the tag would include every lucky
ricochet in the final third. `counterpress` is StatsBomb's own "pressing action
within 5 seconds of an open-play turnover" (§7.3), and the 5-second Pressure
window borrows the same horizon. It removes 66 of the 329 high turnovers — 20%
of them were regains with no pressing action behind them.

Result: **263 phases (1.57%)**, which produce a shot **30.4%** of the time
against a 13.8% baseline, at mean xG 0.0247 against 0.0141.

## 12. `counterattack`

> Either StatsBomb tagged the possession `From Counter`, **or** the phase began
> with an open-play turnover **in the team's own half** (x ≤ 60), advanced at
> least **18 yards** upfield at **4.3 yards per second or more** (3.93 m/s), and **reached
> the final third**.

StatsBomb's own `From Counter` label is derived, published, and honoured here:
"open-play turnover outside the counter-attacking team's final third, at least
75% direct towards goal, travelled at least 18 yards towards goal" (§7.1). But
it is applied to only **0.69%** of possessions, which is too sparse to search.

So the second branch reproduces its shape with an explicit, measurable test, and
its speed threshold is taken from StatsBomb's own tag rather than invented.
Measured over 30 matches, comparing possessions StatsBomb tags `From Counter`
against everything else:

| | counters p10 | p25 | p50 | others p50 | others p90 |
|---|---:|---:|---:|---:|---:|
| upfield speed (yd/s) | **4.31** | 5.55 | 6.91 | 2.15 | 8.50 |
| progression (yd) | 25.2 | 28.2 | 41.3 | 33.0 | 80.4 |
| duration (s) | 3.1 | 4.3 | 6.8 | 13.1 | 47.4 |

**4.3 yd/s is the 10th percentile of StatsBomb's own counter-attacks** — the
threshold says "at least as direct as the slowest tenth of the moves StatsBomb
itself calls a counter". The 18-yard progression floor is StatsBomb's published
number. "Own half" (x ≤ 60) is stricter and clearer than the spec's "outside
their own final third".

The speed threshold is what does the work; progression barely binds, because
winning the ball in your own half and reaching the final third already implies a
long carry. Sweeping it:

| speed ≥ | phases | share | led to a shot | mean xG |
|---:|---:|---:|---:|---:|
| 3.0 | 1,175 | 7.0% | 28.5% | 0.0303 |
| **4.3** | **700** | **4.2%** | **30.9%** | **0.0370** |
| 5.5 | 440 | 2.6% | 31.8% | 0.0385 |
| 6.9 | 226 | 1.3% | 37.2% | 0.0491 |

Result with both branches: **753 phases (4.5%)**, shot rate **27.1%**, mean xG
0.0324 — roughly twice the baseline on both.

This is deliberately more inclusive than StatsBomb's 0.69%. If you want only
their tag, filter on `counterattack AND duration_s < 10`.

## 13. The remaining columns

| Column | Definition |
|---|---|
| `phase_id` | `{match_id}-{seq}`, seq zero-padded to 4 and 1-based within the match. Sorts chronologically as a string. |
| `possession` | The raw StatsBomb possession number, so any phase traces back to its chain. |
| `team_id` / `team_name` | The chain's `possession_team`. |
| `opponent_id` / `opponent_name` | The other team in the match. |
| `competition` | `Euro 2020` (8,792 phases) or `Euro 2024` (7,990). Denormalized so it is DSL-filterable (contract §3b). |
| `match_label` | Denormalized from `matches.parquet.label`, e.g. `Spain 2–1 England · Euro 2024 Final`. |
| `n_events` | Every event in the chain, **both teams** — this is the chain's density, not our activity. |
| `n_passes` | Passes attempted **by the team in possession** (§5.4: not every event in a chain is theirs). |
| `n_players` | Distinct players of the team in possession who touched the phase. Median 4. |
| `n_shots` | Shots by the team in possession. |
| `pressure_events` | `Pressure` events by the **opponent** during the chain. `Pressure.team` is the defending team (§7.2). |
| `reached_final_third` | Any ball-path point with x ≥ 80. True for 65.0% of phases. |
| `reached_box` | Any ball-path point inside x ≥ 102, 18 ≤ y ≤ 62. True for 36.4%. |
| `xg` | The **maximum** `statsbomb_xg` among shots by the team in possession, 0 if none. Max, not sum, so a phase is ranked by its best chance rather than by shot count. |
| `has_360` | At least one event in the chain has a 360 frame. True for 96.6% of phases. |
| `frame_coverage` | Fraction of the chain's events carrying a 360 frame. Dataset mean **0.824**. |
| `start_x/y`, `end_x/y`, `max_x` | First, last and furthest-upfield points of the ball path. |
| `path_xy` | See below. |

### `path_xy`

40 `float32` values, `[x0, y0, x1, y1, …, x19, y19]`: the ball path resampled to
**20 points evenly spaced by arc length**, in the canonical frame.

It exists so the results grid can animate up to 96 thumbnails straight from the
eagerly-loaded index, with no per-phase fetch. Arc length rather than time is
deliberate: the marker then travels at constant speed, so a 40-second build-up
and a 6-second break both read as one clean sweep at thumbnail size. Real
timings live in `phase_events` for the full player.

Endpoints are pinned exactly to `start_x/y` and `end_x/y` (asserted in the
validation suite). A phase whose ball never moved gets its single point repeated
20 times.

Cost: 160 bytes per phase before compression. The whole of `phases.parquet` with
`path_xy` included is **2.90 MB** against a 6 MB budget, so no quantization was
needed — the values are stored as plain float32 yards.

## 14. The similarity vector

`similarity.parquet` holds one **74-dimensional, L2-normalized float32** vector
per phase (contract budget: ≤ 96 dims). Cosine similarity is therefore a plain
dot product, which the browser does in DuckDB with `list_dot_product`.

| Block | Dims | Encoding | Weight |
|---|---:|---|---:|
| Numeric features | 13 | z-scored over the whole dataset, clipped to ±3 | 1.0 |
| Boolean flags | 5 | 0 / 1 | 0.8 |
| `start_type` | 7 | one-hot | 0.7 |
| `outcome` | 7 | one-hot | 0.7 |
| `start_zone` | 9 | one-hot | 0.6 |
| `end_zone` | 9 | one-hot | 0.6 |
| Trajectory | 24 | `path_xy` sub-sampled to 12 points, x scaled `(x−60)/60`, y `(y−40)/40` | 0.5 |

Numeric block: `duration_s`, `n_passes`, `n_events`, `n_players`,
`progression_m`, `direct_speed_m_s`, `pressure_events`, `xg`, `start_x`,
`start_y`, `end_x`, `end_y`, `max_x`.
Boolean block: `high_press_regain`, `counterattack`, `switch_of_play`,
`reached_final_third`, `reached_box`.

Clipping at ±3 stops one nine-minute possession from bending the space around
itself. The trajectory block is damped to 0.5 because it is the widest block
(24 of 74 dims) and pure shape should not outrank tactical content — two moves
that trace the same arc but one ends in a goal and one in a throw-in are not the
same phase.

The whole file is **2.66 MB** against an 8 MB budget.

## 15. Known limitations

**Team colours on ~1.6% of 360 frames are uncertain.** Of 331,383 stored frames,
94.28% are drawn in the event team's frame, 2.50% in the opponent's, and 3.22%
cannot be classified (the actor dot matches neither hypothesis). For the
mirrored ones the *coordinates* are unambiguous, but which team a dot plays for
is not, because `teammate` is defined relative to "the actor" and a mirrored
frame can arise two ways:

* the frame was **borrowed** from the paired opponent event (actor dot sits
  bit-exactly on the mirrored event location) — `teammate` refers to the
  opponent, so the labels flip;
* the frame is **this event's, drawn backwards** — `teammate` still refers to
  our player, so the labels do not flip.

Two independent tests were run on 20 matches to tell them apart: which side of
the pitch a goalkeeper dot deep in a penalty area sits on, and nearest-neighbour
continuity against adjacent well-oriented frames. They agree on the direction —
borrowed frames flip (98% of keeper checks, 308 dots to 103 on continuity),
re-oriented ones do not (79%, 2043 to 1261) — but the second case is noisy,
because these are contested duels where players stand on top of each other. The
implemented rule follows the evidence; the residual doubt covers roughly 1.6% of
frames, for a fraction of a second each. `orientation` is stored per frame so
the UI can be honest about it.

**Six 360 frames have two `actor` dots.** `docs/statsbomb-notes.md` §3.5 reported
zero such frames over 14 matches; over all 102 there are six (0.002%), all in
Euro 2020, all in second halves. The orientation detector needs exactly one
actor, so these come out `unknown` and fall back to the event-team assumption.
Worth noting as an amendment to that section's "0 frames with more than one
actor".

**`unknown` orientation is 3.22% of frames**, higher than the ~2–3% the notes
projected from four matches.

**360 dots have no identity.** The source data carries no player names in
freeze frames — only teammate / opponent / keeper / actor. Halfspace does not
invent them. Names appear in `phase_events` (from the event records) and nowhere
else.

**`n_players` counts touches, not the team on the pitch.** It is the number of
distinct players of the team in possession who appear in the chain — a proxy for
how many people were involved in the move, not a lineup count.

**A "phase" is a possession chain, not a tactical unit.** A team that keeps the
ball for two minutes through three throw-ins produces four phases. That is the
deliberate consequence of the choice in §1; it is right for searching passages
of play and wrong for measuring sustained territorial control.
