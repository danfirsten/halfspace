"""Is `teammate` in a MIRRORED 360 frame relative to the event's actor, or to
the team the picture was drawn for?

docs/statsbomb-notes.md §3.5 says ~5% of frames are drawn in the opponent's
attacking frame, and suggests flipping the `teammate` flags along with the
coordinates. That would only be right if StatsBomb recomputed `teammate`
against the *other* event of the pair. This script settles it from the data.

Method: goalkeepers are an unambiguous ground truth. A team's own keeper stands
near x=0 in that team's attacking frame; the opponent keeper stands near x=120.
For every frame containing exactly one keeper dot, we ask which hypothesis puts
that keeper on the correct side of the pitch.

Run:  python -m scripts.check_frame_teammate   (from ingest/)
"""

from __future__ import annotations

import json
from collections import Counter

from halfspace_ingest.config import RAW_DIR
from halfspace_ingest.frames import ORIENT_MIRRORED, frame_orientation

MATCHES = [3930158, 3943043, 3941017, 3788741, 3942349]


def main() -> None:
    tally: dict[str, Counter] = {"event": Counter(), "mirrored": Counter(), "unknown": Counter()}
    for match_id in MATCHES:
        events = json.loads((RAW_DIR / "events" / f"{match_id}.json").read_text())
        by_id = {e["id"]: e for e in events}
        frames = json.loads((RAW_DIR / "three-sixty" / f"{match_id}.json").read_text())

        for fr in frames:
            ev = by_id.get(fr["event_uuid"])
            if ev is None:
                continue
            ff = fr["freeze_frame"]
            orient = frame_orientation(ev.get("location"), ff)
            keepers = [p for p in ff if p.get("keeper")]
            if len(keepers) != 1:
                continue
            k = keepers[0]
            kx = k["location"][0]
            # Hypothesis A: `teammate` is relative to the event's actor, i.e.
            # a teammate keeper is the event team's keeper. In a MIRRORED frame
            # the picture is drawn for the opponent, so the event team's keeper
            # appears near x=120 in raw frame coordinates.
            #
            # Hypothesis B: `teammate` was recomputed for the team the picture
            # is drawn for, so a teammate keeper is near x=0 in raw coordinates
            # whatever the orientation.
            side = "near_0" if kx < 60 else "near_120"
            tally[orient][f"teammate={bool(k.get('teammate'))} {side}"] += 1

    for orient in ("event", "mirrored", "unknown"):
        print(f"\n{orient} frames with exactly one keeper dot:")
        total = sum(tally[orient].values())
        for key, n in sorted(tally[orient].items()):
            print(f"  {key:28s} {n:6d}  {100 * n / max(total, 1):5.1f}%")
        print(f"  {'total':28s} {total:6d}")

    print(
        "\nReading: in 'event' frames, teammate=True keepers sit near x=0 (own goal).\n"
        "If MIRRORED frames show teammate=True keepers near x=120, `teammate` is still\n"
        "relative to the event's actor and must NOT be flipped -- only the coordinates.",
    )
    print(f"(orientation label used: {ORIENT_MIRRORED!r})")


if __name__ == "__main__":
    main()
