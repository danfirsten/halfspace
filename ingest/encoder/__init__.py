"""P2: a learned sequence encoder over phase event streams.

This package is an experiment with a pre-registered decision rule. Read
``EVAL.md`` before ``RESULTS.md``, and both before assuming anything about
which representation `web/public/data/similarity.parquet` currently holds.

Nothing here runs during a normal ingest build. `halfspace_ingest.build` writes
the baseline vectors; this package only replaces them if it wins its own
evaluation.
"""
