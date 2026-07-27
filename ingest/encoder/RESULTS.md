# P2 — learned phase encoder: results

**Outcome: the learned encoder LOST. `web/public/data/similarity.parquet` is
untouched and still holds the 74-dimensional P0 baseline.**

The evaluation and the decision rule in `EVAL.md` were written and committed
(`c6b6e71`) before the first training step. Every number below was produced by
`python -m encoder.evaluate` running both representations through identical
code. Nothing was re-run after seeing a result, and no metric was swapped for a
kinder one.

---

## 1. The decision

Pre-registered rule (EVAL.md §6), evaluated on the untouched **test** split with
the configuration selected on validation:

| # | Condition | Required | Measured | Pass |
|---|---|---|---|:--:|
| 1 | split-half **MRR** | ≥ 1.10 × baseline | **0.906 ×** | ✗ |
| 2 | split-half **Recall@1** | ≥ baseline | 0.0131 vs **0.0193** | ✗ |
| 3 | transfer probe **macro-AUC** | ≥ baseline − 0.010 | 0.750 vs 0.754 (−0.004) | ✓ |

Two of three conditions fail, and the primary metric fails in the wrong
direction — the encoder is not marginally short of a 10% gain, it is 9% *worse*.
**Decision: keep the baseline.** `similarity.parquet` was never rewritten; the
build still defaults to `--similarity baseline`.

## 2. The numbers

### Test split — 16 matches, 2,651 phases, 1,915 eligible for split-half

| representation | MRR | R@1 | R@10 | median rank |
|---|---:|---:|---:|---:|
| baseline (generous) | **0.0398** | **0.0193** | **0.0789** | 322 |
| baseline (strict) | 0.0205 | 0.0057 | 0.0376 | 421 |
| learned (v3) | 0.0360 | 0.0131 | 0.0752 | **269** |

| transfer probe (k=25) | cross | through_ball | high_pass | head_pass | aerial_won | **macro** |
|---|---:|---:|---:|---:|---:|---:|
| baseline | **0.896** | **0.798** | **0.772** | 0.628 | 0.678 | **0.754** |
| learned (v3) | 0.851 | 0.677 | 0.745 | **0.694** | **0.784** | 0.750 |
| prevalence | 11.4% | 2.7% | 62.3% | 13.1% | 8.6% | |

### Validation split — 16 matches, 2,587 phases, 1,882 eligible

| representation | MRR | R@1 | R@10 | median rank |
|---|---:|---:|---:|---:|
| baseline (generous) | **0.0457** | **0.0234** | 0.0802 | 314 |
| baseline (strict) | 0.0229 | 0.0085 | 0.0457 | 408 |
| learned (v1) | 0.0427 | 0.0186 | 0.0813 | 266 |
| learned (v3, selected) | 0.0448 | 0.0191 | **0.0866** | 286 |

| transfer probe (k=25) | cross | through_ball | high_pass | head_pass | aerial_won | **macro** |
|---|---:|---:|---:|---:|---:|---:|
| baseline | **0.894** | **0.738** | **0.763** | 0.614 | 0.601 | 0.722 |
| learned (v1) | 0.875 | 0.640 | 0.746 | 0.658 | 0.752 | 0.734 |
| learned (v3) | 0.863 | 0.629 | 0.744 | **0.691** | **0.746** | **0.735** |

For scale: against the 1,915-candidate test pool, a random ranking scores
MRR = H₍ₙ₎/n ≈ **0.0042** and R@1 = 1/n ≈ **0.052%**. **Both representations are
doing real work** — the baseline puts the true continuation first 37× more often
than chance and the encoder 25× — the encoder just does less of it.

## 3. What actually happened, and what it means

**The encoder is not broken; it is differently shaped.** Three things in the
table above are worth more than the verdict:

* **The encoder has a better *median* rank on every split** (269 vs 322 on test)
  while having a worse MRR and R@1. It moves the true continuation up out of the
  tail reliably, and almost never nails it. That is the signature of a
  representation that has learned *region and rhythm* — "a slow build-up down
  the left, under moderate pressure" — but not the sharp identifying details.
  For "find similar phases" the head of the ranking is what a user sees, and
  that is exactly where the baseline wins.
* **The transfer probe splits along a football line.** The baseline is much
  better at `cross` (0.896 vs 0.851) and `through_ball` (0.798 vs 0.677) — both
  are *geometric* events, a ball into the box from wide or a pass split between
  lines, and the baseline is handed the trajectory, the end zone and the box
  flag. The encoder is much better at `aerial_won` (0.784 vs 0.678) and
  `head_pass` (0.694 vs 0.628) — both are *event-sequence* facts, a duel and a
  restart pattern the baseline sees only as a count. Each representation is
  strong exactly where its inputs are. That is the most useful thing this
  experiment produced, and it is what the two would have to be combined on.
* **More training made it worse.** Validation MRR peaked early on every run —
  epoch 20 of 40 (v1), 15 of 20 (v2), **5 of 20** (v3) — and declined while the
  contrastive loss kept falling (v1: 2.19 → 1.05). The model gets better at the
  pretext task and worse at the thing we care about. With 10,461 training phases
  and 175k parameters that is a straightforward instance-discrimination
  shortcut: it finds cheap identifiers (length, absolute pitch region) that
  separate 10k phases and do not survive being cut in half.

## 4. Runs

| run | changed from default | epochs | wall | threads | best val MRR (epoch) |
|---|---|---:|---:|---:|---|
| v1 | — (pre-registered defaults) | 40 | **29.2 min** | 4 | 0.0427 (20) |
| v2 | temp 0.10, crop_min 0.35, drop 0.15, jitter 1.2 | 20 | 15.2 min | 2 | 0.0417 (15) |
| **v3** | **temp 0.20** | 20 | 15.6 min | 2 | **0.0448 (5)** |

v2 and v3 ran concurrently on the same 4-core box, so their wall times include
contention. Total training time for the whole experiment: **~60 minutes of CPU
wall clock**.

* **Parameters: 175,088** (budget ≤ 1M). 2-layer Transformer, d_model 96, 4
  heads, FF 192, 24-dim type embedding, 64-dim L2-normalized output.
* **Seed 20240714** everywhere — split generation, init, batch order, every
  augmentation draw. Each checkpoint stores its full config, epoch, optimiser
  state and validation history.
* Hyper-parameters were tuned **only** on validation. The test split was read
  exactly once, after v3 was selected, and produced the table in §2.

## 5. Deviations from EVAL.md, and other honest notes

**One clarification, resolved before any model was evaluated.** EVAL.md §2 says
which blocks the two baseline variants recompute for a half-phase, but does not
say what happens to `high_press_regain` and `counterattack`. Neither is derivable
from a slice — both depend on what happened *before* the chain started (who had
the ball previously, who was pressing). They are therefore treated exactly like
`start_type` and `outcome`: **inherited from the parent phase in the `generous`
variant, zeroed in `strict`**. This resolves the gap in the direction that
*favours the baseline* (it hands the baseline two more dimensions that are
identical across a phase's two halves), which is the conservative choice for a
rule the encoder has to beat.

**`duration_s` for a half-phase is approximate.** `phase_events.parquet` stores
each event's offset but not its duration, so a segment's duration is
(last − first) offset rather than the published "last ball event's
`timestamp + duration`". A second implementation of the whole feature layer
(`baseline.check_reproduction`) rebuilds **whole-phase** baseline vectors from
`phase_events` and compares them to the shipped artifact:

| split | n | mean cosine | p05 | min |
|---|---:|---:|---:|---:|
| validation | 600 | **0.9966** | 0.9987 | 0.582 |
| test | 600 | **0.9974** | 0.9993 | 0.637 |

The reproduction is essentially exact for 95% of phases. The tail is phases
whose events all share one timestamp — a goal kick hit long, three events, zero
elapsed — where the missing event duration turns `direct_speed_m_s` from 17.8
into 0. Those are short phases, mostly ineligible for split-half anyway, and the
approximation is applied identically to both halves of every phase. It is a
small handicap to the *baseline*, and the baseline won anyway.

**The evaluation was, by construction, tilted toward the encoder on the primary
metric** (EVAL.md §2): the contiguous-crop augmentation trains the encoder for
something structurally like "half a phase", while the baseline was designed for
whole-phase similarity. The encoder lost that metric anyway.

**But it beat the `strict` baseline comfortably** (test MRR 0.0360 vs 0.0205;
R@1 0.0131 vs 0.0057). Almost the whole of the baseline's winning margin comes
from the four phase-level labels the `generous` variant hands to both halves.
That is a real caveat, and it is exactly why both variants were pre-registered:
against a baseline that knows only what a half-phase determines, the encoder
wins by 75%. The `generous` variant decides because the shipped baseline *does*
know those labels for a whole phase, and whole phases are what the app compares
— but an interviewer is entitled to read the `strict` row as the fairer
representation-vs-representation contest, and it says the encoder learned
something the hand-built numerics and trajectory do not contain.

**No post-hoc metrics were added.** The median-rank and per-label observations in
§3 are read off the pre-registered metric set, not new measurements invented to
find a win.

## 6. What ships

Nothing changes for the web app. `similarity.parquet` still holds the baseline
vectors, byte-identical to before this experiment (2.66 MB, 74 dims,
L2-normalized). `docs/phase-definitions.md` §14 remains the description of what
is in the file, with a pointer to this document.

The encoder stays committed — package, tests, evaluation harness, this record —
because the next person to propose a learned representation should start from
the measurement rather than from the idea.

## 7. What I would try next

Ordered by what the numbers above actually argue for:

1. **Concatenate, do not replace.** The transfer probe says the two
   representations are strong on disjoint football content (geometry vs. event
   sequence). A 74 + 22 dim concatenation is inside the 96-dim contract budget,
   and it is the only option here with direct evidence behind it.
2. **Fix the shortcut, not the hyper-parameters.** Validation peaked at epoch 5
   in the best run. Instance discrimination over 10k phases is too easy. Harder
   positives (two crops with *no overlap*), a length-matched negative sampler, or
   a masked-event-prediction objective would all attack that directly.
3. **More data.** 70 training matches is small for a sequence model. The same
   pipeline over StatsBomb's full open-data set (thousands of matches) changes
   the regime this experiment was run in, and is the single change most likely
   to flip the result.
4. **Evaluate what users do.** The honest limit of this whole exercise is that
   split-half retrieval is a proxy. A small set of analyst-labelled "these five
   phases are the same idea" triplets would measure the actual product question,
   and would be worth more than another week of contrastive tuning.
