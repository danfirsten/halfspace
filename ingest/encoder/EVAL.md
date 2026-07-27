# P2 — learned phase encoder: pre-registered evaluation

**Written and committed before a single training step was run.** Nothing below
was chosen after seeing a result. Where the implementation later had to deviate
from this document, the deviation is recorded in `RESULTS.md` with its reason,
and any number produced by a deviating protocol is reported as secondary.

The question this evaluation has to answer is narrow:

> Does a small self-supervised sequence encoder over a phase's event stream
> produce a **better** 96-or-fewer-dimensional cosine-comparable phase
> representation than the 74-dimensional hand-built baseline that already ships
> in `web/public/data/similarity.parquet`?

If the answer is no, the baseline stays and this file plus `RESULTS.md` are the
record of why.

---

## 1. Why the obvious evaluation would be rigged

The tempting evaluation is label retrieval: pick a phase, retrieve its nearest
neighbours, and ask how often they share its `outcome`, `start_type`,
`start_zone` or `end_zone`.

**That evaluation is rigged for the baseline and must not be used as evidence.**
The baseline vector (docs/phase-definitions.md §14) *literally contains those
labels*: 7 one-hot dims of `start_type`, 7 of `outcome`, 9 each of `start_zone`
and `end_zone` — 32 of its 74 dimensions are the answer key. Scoring the two
representations on how well they recover labels that one of them was handed is
not a measurement, it is a tautology. The same objection applies, more weakly,
to any numeric feature in the baseline's 13-dim block: retrieval by "similar
duration" or "similar xG" is retrieval of an input.

So the evaluation is built out of two things the baseline was **not** handed.

---

## 2. Primary metric — split-half retrieval

**Protocol.** For every eligible held-out phase, cut its event sequence in two
at the midpoint (`first ceil(n/2)` events vs. the rest). Embed each half with
the representation under test, exactly as if it were a phase in its own right.
Query with every **first** half; the candidate pool is **every second half in
the same split**. Score the rank of the query's own second half.

Football reading of the task: *given the opening of a passage of play, find the
continuation of that same passage among two thousand others.* A representation
that has understood "what kind of move is this, where, at what tempo, under what
pressure" ranks its own other half high. One that has memorised nothing useful
ranks it at chance (~1/N).

**Neither representation is handed the answer.** Both halves are re-derived from
the raw event sequence; the phase id is never an input; the two halves share no
event.

**Eligibility.** A phase is eligible iff it has **≥ 8 events** in its
`phase_events` shard *and* each half contains **≥ 2 located events by the team
in possession** (the baseline needs two path points to have a trajectory at
all). The eligible count for each split is reported in `RESULTS.md`. All
eligible phases in a split are both queries and distractors — the pool is not
sub-sampled, so the numbers are not tuneable by choosing a pool size.

**Metrics.**

| | |
|---|---|
| **MRR** (primary) | mean of `1 / rank` of the true second half. Uses the whole ranking, so it is far less noisy than a top-1 count. |
| **Recall@1** (guard) | fraction ranked first. |
| Recall@10, median rank | descriptive only. |

**The two baseline variants.** A half of a phase does not have a `start_type` of
its own (only the first half begins at a restart) and does not have an `outcome`
of its own (only the second half ends the move). Two readings, both
pre-registered, both reported:

* **`generous`** (the variant the decision rule uses): each half inherits the
  parent phase's `start_type` and `outcome` one-hots. This deliberately **leaks
  phase identity into the baseline** — two halves of the same phase are given
  identical values in 14 of the baseline's 74 dims. It is the harder bar for the
  encoder, and it is the bar that decides.
* **`strict`**: those two blocks are zeroed for both halves, so the baseline
  gets only what a half genuinely determines. Reported alongside, never used to
  decide.

`start_zone`, `end_zone`, all 13 numerics and the trajectory block are always
recomputed from the half's own events under the definitions in
docs/phase-definitions.md §4–§14 — no parent-phase values.

**Known advantage to the encoder, stated up front.** One of the training
augmentations is a random contiguous temporal crop (§5), which is structurally
related to "half a phase". The encoder is therefore trained toward a property
the primary metric rewards, while the baseline was designed for a different
purpose entirely. This is the strongest single reason to distrust a primary-only
win, and it is exactly why the decision rule also requires a second, unrelated
metric not to regress.

## 3. Secondary metric — transfer probe on labels neither representation has

Five binary phase labels are extracted from the **raw StatsBomb JSON**. Every
one lives in a `pass.*` or `duel.*` sub-object that is **absent from
`phase_events.parquet` entirely** — so the encoder cannot see it — and absent
from the baseline's 74 dims — so the baseline cannot see it either.

| Label | Definition (team in possession only) | ~prevalence (measured on 20 train matches) |
|---|---|---:|
| `cross` | any pass with `pass.cross` | 12.0% |
| `through_ball` | any pass with `pass.through_ball` | 2.7% |
| `high_pass` | any pass with `pass.height = High Pass` | 60.5% |
| `head_pass` | any pass with `pass.body_part = Head` | 12.9% |
| `aerial_won` | any pass with `pass.aerial_won` | 8.7% |

**Protocol.** Embed every **full** phase in the split (this is the production
use — "find similar" runs over whole phases). Leave-one-out k-NN with **k = 25**
by cosine: each phase's score for a label is the mean label value of its 25
nearest neighbours, itself excluded. Metric: **ROC-AUC per label, macro-averaged
over the five**. Chance = 0.5.

Football reading: *does the neighbourhood structure of this space know that
crosses go with crosses and through-balls with through-balls, without ever
having been told what a cross is?*

Caveats stated in advance, not after:

* `aerial_won` is partly shadowed for the encoder by the opponent `Duel` events
  it can see in the sequence. `high_pass` correlates with long trajectories,
  which the baseline's 24-dim trajectory block sees. Neither label is *given* to
  either side, but neither is perfectly blind either. This is why the probe is
  five labels macro-averaged and a **no-harm guard**, not a win condition.
* The encoder sees the ordered event-type sequence; the baseline collapses it to
  counts. That asymmetry is not a flaw in the evaluation — it is the entire
  hypothesis P2 is testing.

## 4. Splits — by match, frozen before training

`splits.json`, generated by `numpy.random.default_rng(20240714).permutation`
over the sorted 102 match ids: **70 train / 16 validation / 16 test**, committed
alongside this file.

Splitting by **match**, not by phase, is what keeps the eval honest: two phases
from the same game share teams, tactical setup, referee, pitch and scoreline, so
a phase-level split would let the encoder recognise the match rather than the
move. Phase counts: **11,544 train / 2,587 validation / 2,651 test**.

* **Validation** carries every decision: architecture, dimension, temperature,
  learning rate, epochs, augmentation strength, checkpoint selection.
* **Test is evaluated once**, with the final configuration, at the end. If it is
  re-run after any change, `RESULTS.md` says so explicitly.

The baseline's z-scoring statistics (mean/σ per numeric feature) are the ones
already used to build the shipped `similarity.parquet`, i.e. computed over the
whole dataset. That is a small leak in the baseline's favour — it is the shipped
artifact and re-fitting it would measure a different thing. Noted, not fixed.

## 5. The model and the objective (pre-committed)

* **Input**: the phase's `phase_events` rows, both teams' events, in order —
  event type, side (in possession / opponent), location, end location, time
  offset, inter-event gap, `under_pressure`, `counterpress`, `out`, shot xG.
  Sequences longer than 64 events are subsampled to 64 by uniform stride,
  preserving order.
* **Architecture**: learned type embedding + linear projection → 2-layer
  Transformer encoder (d_model 96, 4 heads, FF 192, pre-norm) → masked mean pool
  → linear → **L2-normalized 64-dim output** (contract budget ≤ 96).
  Target: **≤ 1M parameters**, CPU-trainable in under an hour.
* **Objective**: NT-Xent (InfoNCE) contrastive loss between two augmented views
  of the same phase, in-batch negatives, temperature tuned on validation only.
  Chosen over masked-step prediction because the artifact we need is a *whole-
  sequence* vector compared by cosine — training the geometry directly is the
  shortest path from objective to product, and masked-step reconstruction
  optimises a per-token decoder we would then throw away.
* **Augmentations** (football reasoning, each documented in `augment.py`):
  1. **Contiguous temporal crop**, keep 60–100% — a passage of play is still
     that passage whether you catch it from the goalkeeper's throw or from the
     second pass.
  2. **Event dropout**, p ≤ 0.10 — annotation is not exhaustive; a missed
     Pressure or Ball Receipt does not change what the move was.
  3. **Spatial jitter**, σ = 0.8 yards — StatsBomb locations are eyeballed to
     roughly a yard, so a move is not defined to sub-yard precision.
  4. **Tempo jitter**, inter-event gaps × lognormal(σ = 0.10) — the same move
     played 10% quicker is the same move.
  * **Deliberately excluded: left-right mirroring.** It is the standard
    augmentation for pitch data and it is wrong here. Halfspace users search for
    attacks down the *left*; the baseline's zone one-hots distinguish
    `final_third_left` from `final_third_right`, and an encoder trained to be
    blind to the difference would be a worse product even if it scored better.
* **Determinism**: one seed (default 20240714) fixes split generation,
  augmentation RNG, init and batch order. The seed, full config and parameter
  count are written into every checkpoint and into `RESULTS.md`.

## 6. The decision rule

Computed on the **test** split, with the final configuration selected on
validation, baseline and learned run through *identical* code paths:

> **The learned encoder ships if and only if all three hold:**
> 1. `MRR_learned ≥ 1.10 × MRR_baseline` on primary split-half retrieval,
>    `generous` baseline variant — a **10% relative** improvement, not a
>    rounding error;
> 2. `Recall@1_learned ≥ Recall@1_baseline` — no regression on the metric a user
>    actually feels ("is the top hit right");
> 3. `macroAUC_learned ≥ macroAUC_baseline − 0.010` on the transfer probe — the
>    encoder may not buy its retrieval win by throwing away football content.

**Ship** → export learned vectors to `web/public/data/similarity.parquet` (same
schema, L2-normalized, ≤ 8 MB), keep the baseline reproducible behind a build
flag, update docs/phase-definitions.md §14.

**Do not ship** (any condition fails, including "close but under") → the file is
left untouched, the encoder code and this evaluation stay committed, and
`RESULTS.md` reports the loss plainly with the numbers that produced it.

There is no third outcome, no "promising, ship anyway", and no swapping the
primary metric for one that came out better.
