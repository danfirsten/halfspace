"""Paths, dataset selection and shared constants for the Halfspace ingest pipeline.

Everything here is deliberately boring: one place to change the dataset, one
place to change where raw JSON is cached, one place for the pitch geometry
constants that the rest of the pipeline trusts.
"""

from __future__ import annotations

import os
from pathlib import Path

# --- Dataset (see docs/CONTRACT.md §0) ------------------------------------

#: (competition_id, season_id, human label) for every competition we ingest.
COMPETITIONS: list[tuple[int, int, str]] = [
    (55, 282, "Euro 2024"),
    (55, 43, "Euro 2020"),
]

STATSBOMB_BASE = "https://raw.githubusercontent.com/statsbomb/open-data/master/data"

#: A three-sixty file smaller than this is a stub, not real tracking data.
#: docs/statsbomb-notes.md §2.1 documents the AFCON 2023 case: a 1,962-byte file
#: that `competitions.json` claims is 360 coverage.
MIN_360_BYTES = 50_000

# --- Paths ----------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parents[2]

#: Raw StatsBomb JSON cache. NEVER inside the repository: licence clause 1.2.1
#: forbids redistributing the data, so it lives in a scratch directory.
RAW_DIR = Path(
    os.environ.get(
        "HALFSPACE_RAW_DIR",
        "/tmp/claude-0/-home-user-halfspace/"
        "a694d7b9-aa9e-541f-bd07-c557653c0680/scratchpad/statsbomb-raw",
    )
)

#: Where the derived, publishable Parquet artifacts go.
OUT_DIR = Path(os.environ.get("HALFSPACE_OUT_DIR", REPO_ROOT / "web" / "public" / "data"))

DATASET_VERSION = "1.0.0"

ATTRIBUTION = (
    "Data provided by StatsBomb. Halfspace is built on StatsBomb Open Data. "
    "Used under the StatsBomb Public Data User Agreement for research and "
    "non-commercial analysis. StatsBomb is not affiliated with this project and "
    "does not endorse any analysis presented here."
)

# --- Pitch geometry (docs/statsbomb-notes.md §3.1) ------------------------

PITCH_X = 120.0
PITCH_Y = 80.0

#: Event locations sit on a 0.1-offset grid, so the exact mirror for an event
#: location is 120.1 - x / 80.1 - y, NOT 120 - x / 80 - y. Verified exact on
#: every cross-team related-event pair sampled (notes §3.2).
EVENT_MIRROR_X = 120.1
EVENT_MIRROR_Y = 80.1

#: 360 freeze-frame coordinates are full-precision floats and are *not* on the
#: 0.1 grid, so they mirror about the true pitch dimensions.
FRAME_MIRROR_X = 120.0
FRAME_MIRROR_Y = 80.0

#: Penalty area of the goal being attacked (x toward 120).
BOX_X_MIN = 102.0
BOX_Y_MIN = 18.0
BOX_Y_MAX = 62.0

FINAL_THIRD_X = 80.0
MIDDLE_THIRD_X = 40.0

#: y increases downward (y=0 is the top touchline). "Left" from the attacking
#: team's point of view is the low-y side.
CHANNEL_1 = 80.0 / 3.0   # 26.667
CHANNEL_2 = 160.0 / 3.0  # 53.333

#: Seconds of match clock at the start of each period, used to turn the
#: per-period `timestamp` into an absolute match clock.
PERIOD_OFFSET_S = {1: 0.0, 2: 2700.0, 3: 5400.0, 4: 6300.0, 5: 7200.0}

#: StatsBomb's axes are nominal yards (spec Appendix 2). CONTRACT §3b pins the
#: published `progression_m` / `direct_speed_m_s` columns as true metres, so
#: x-axis deltas are converted on the way out. Internal thresholds stay in
#: yards, because the football definitions they encode are stated in yards.
YARD_M = 0.9144

#: Number of (x, y) samples in the phase's stored trajectory summary.
PATH_POINTS = 20
