# Halfspace ingest

Offline pipeline. Turns StatsBomb Open Data JSON into the Parquet artifacts the
web app reads.

```
raw StatsBomb JSON  →  possession chains  →  phases  →  web/public/data/
```

It never runs in production. Everything the browser sees is produced here.

---

## Running it

Python 3.11+.

```bash
cd ingest
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt

./.venv/bin/python -m halfspace_ingest.download      # ~1.1 GB, ~40 s
./.venv/bin/python -m halfspace_ingest.build         # ~15 s on 4 cores
./.venv/bin/python -m pytest                         # 184 tests, ~8 s
```

Optional:

```bash
./.venv/bin/python -m scripts.calibrate              # the distributions behind every threshold
./.venv/bin/python -m scripts.check_frame_teammate   # the 360 teammate-flag investigation
```

The download step is idempotent — it issues one HEAD per file and skips anything
whose local size already matches — so re-running it costs a few seconds.

### P2 — the learned phase encoder

`encoder/` is a self-contained experiment: a small self-supervised Transformer
over each phase's event sequence, proposed as a replacement for the hand-built
`similarity.parquet` vectors. It ships **only** if it beats the baseline on an
evaluation that was written and committed before the first training step
(`encoder/EVAL.md`).

**It did not.** On the untouched test split it scored MRR 0.0360 against the
baseline's 0.0398 on split-half retrieval, and Recall@1 0.0131 against 0.0193.
`similarity.parquet` is unchanged and still holds the 74-dim baseline. The code,
the pre-registration and the full numbers stay committed as the record —
`encoder/RESULTS.md` also documents the two places the encoder is *better*,
which is where a future attempt should start.

It needs PyTorch, which is deliberately *not* in `requirements.txt`:

```bash
./.venv/bin/pip install -r requirements-encoder.txt

# baseline-only numbers on a split (no model needed)
./.venv/bin/python -m encoder.evaluate --split validation

# train; re-running the same command resumes from the last checkpoint
./.venv/bin/python -m encoder.train --name v1

# evaluate a checkpoint under the pre-registered protocol
./.venv/bin/python -m encoder.evaluate --split validation --ckpt encoder/checkpoints/v1-best.pt

# export learned vectors into web/public/data/similarity.parquet
./.venv/bin/python -m encoder.export --ckpt encoder/checkpoints/v1-best.pt
```

Every flag on `TrainConfig` is a CLI flag (`--temperature`, `--crop-min`,
`--epochs`, …). Checkpoints land in `encoder/checkpoints/` and are gitignored;
each one carries its full config, seed, epoch, optimiser state and validation
history, so a run is reproducible or resumable from the file alone.

Which representation the build writes is a flag:

```bash
./.venv/bin/python -m halfspace_ingest.build --similarity baseline
./.venv/bin/python -m halfspace_ingest.build --similarity learned --encoder-ckpt encoder/checkpoints/v1-best.pt
```

`manifest.json`'s `similarity` block records which one produced the file. The
web app reads `similarity.parquet` either way — nothing in `web/` changes.

### Where things go

| | Path |
|---|---|
| Raw JSON cache | `$HALFSPACE_RAW_DIR`, default a scratch dir **outside the repo** |
| Built artifacts | `$HALFSPACE_OUT_DIR`, default `web/public/data/` |

**Raw StatsBomb JSON must never enter the repository.** Licence clause 1.2.1
forbids redistributing the data. The cache path is gitignored and outside the
working tree, and a test asserts git tracks no raw JSON.

---

## What it produces

102 matches (UEFA Euro 2024 + Euro 2020), 380,588 raw events → **16,782 phases**.

| File | Size | Rows | Loading |
|---|---:|---:|---|
| `phases.parquet` | 2.90 MB | 16,782 | eager |
| `matches.parquet` | 10.7 KB | 102 | eager |
| `similarity.parquet` | 2.66 MB | 16,782 | on demand |
| `phase_events/{match_id}.parquet` | 131 KB median (13.8 MB total) | 379,664 | lazy, per match |
| `phase_frames/{match_id}.parquet` | 395 KB median (41.9 MB total) | 331,383 | lazy, per match |
| `manifest.json` | — | — | eager |

Measured query times, DuckDB 1.1.3 on this machine (in-browser DuckDB-WASM will
be slower, but the shape holds):

| | |
|---|---:|
| Count over `phases.parquet` | 0.9 ms |
| Typical DSL query (4 predicates + order + limit 48) | 3.3 ms |
| Similarity top-48 over all 16,782 vectors | 36.2 ms |

`manifest.json` is the map: dataset version, build timestamp, row counts,
per-file byte sizes, the shard naming pattern, the full match id list, and the
StatsBomb attribution string.

---

## Design notes

**One coordinate frame, resolved here.** Every stored coordinate — events from
either team, 360 dots, camera polygons — is in the phase's possession team's
attacking frame (that team attacks x=0 → x=120). The web app never flips
anything. Opponent events mirror at `(120.1 − x, 80.1 − y)`, not 120/80: event
locations sit on a 0.1-offset grid and the wrong constant breaks the exact join
to a 360 actor dot. Freeze-frame floats are off that grid and mirror at 120/80.

**360 orientation is detected, not assumed.** The spec says a freeze frame is
drawn in the linked event's team's frame. 94.28% of frames are; 2.50% are drawn
in the opponent's, and 3.22% cannot be classified. Every frame is checked
against its actor dot, and the resolved `orientation` is stored so the UI can be
honest about the uncertain ones. `frames.py` documents the two-way split in the
mirrored case and the evidence behind it.

**Thresholds are measured, not chosen.** Every tunable lives in
`phases.Thresholds` with the measurement in its comment, and
`scripts/calibrate.py` reproduces the distributions. The switch-of-play cut-off
(40 yards) reproduces StatsBomb's own `pass.switch` flag exactly across 20,469
passes; the counter-attack speed floor (4.3 yd/s) is the 10th percentile of the
possessions StatsBomb itself tags `From Counter`. `docs/phase-definitions.md`
carries the tables.

**Per-match sharding for the lazy files.** A phase player needs one match's
events and frames, never all of them, so those are written one Parquet per
match — a 130 KB and a 395 KB fetch instead of a 56 MB one. `phase_frames` is
one row per freeze frame with parallel `px` / `py` / `flags` lists rather than
one row per dot: 5.4 million dot-rows is a poor thing to hand a browser, and an
animation wants a whole frame at once. `flags` is a bitmask — bit 0 on the
possession team, bit 1 actor, bit 2 goalkeeper.

**Parallelism.** `multiprocessing` over matches, `spawn` context (polars keeps a
thread pool, and fork plus threads is how you get a build that hangs once a
fortnight). Each worker writes its own two shards and returns only the phase
rows, so nothing large crosses a pipe.

---

## Layout

```
halfspace_ingest/
  config.py      paths, dataset selection, pitch constants
  download.py    stdlib-only parallel fetch, idempotent, stub-file rejection
  taxonomy.py    StatsBomb enum ids (keyed on id — several spec names are wrong)
  geometry.py    the two mirrors, zones, box, arc-length path resampling
  frames.py      360 orientation detection and canonicalization
  phases.py      possession segmentation and every derived feature
  similarity.py  the 74-dim phase vector
  build.py       orchestration and Parquet writing
scripts/
  calibrate.py             distributions behind every threshold
  check_frame_teammate.py  the 360 teammate-flag investigation
tests/
  test_geometry.py     property-based mirror round-trips, zone boundaries
  test_frames.py       orientation detector on constructed frames
  test_segmentation.py half boundaries, possession-1 stubs, same-team restarts
  test_features.py     start types, outcome precedence, progression, flags
  test_validation.py   invariants asserted against the REAL built Parquet, in DuckDB
```

`test_validation.py` is the one that catches a bad build. It reads
`web/public/data/` with DuckDB exactly as the browser will, and asserts things
like: no NaN or negative durations, zones inside their enum, `path_xy` lengths
and pinned endpoints, every phase's match exists, similarity norms ≈ 1,
`frame_coverage` recomputed from the shards matching the stored value, and the
per-competition goal reconciliation. It skips if there is no build present.

---

## Data

Data provided by StatsBomb. Halfspace is built on
[StatsBomb Open Data](https://github.com/statsbomb/open-data). Used under the
StatsBomb Public Data User Agreement for research and non-commercial analysis.
StatsBomb is not affiliated with this project and does not endorse any analysis
presented here.
