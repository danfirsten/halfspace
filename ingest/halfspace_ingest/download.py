"""Fetch the raw StatsBomb Open Data files for the configured competitions.

Standard library only (urllib + threads) so it can run before anything is
pip-installed. Idempotent: a local file whose size already matches the remote
`Content-Length` is left alone, so re-running costs one HEAD per file.

The raw JSON lands in `config.RAW_DIR`, which is outside the repository.
StatsBomb licence clause 1.2.1 forbids redistributing the data.
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .config import COMPETITIONS, MIN_360_BYTES, RAW_DIR, STATSBOMB_BASE

_print_lock = threading.Lock()


def _log(msg: str) -> None:
    with _print_lock:
        print(msg, flush=True)


def _open(url: str, method: str = "GET", timeout: int = 120):
    req = urllib.request.Request(url, method=method, headers={"User-Agent": "halfspace-ingest/1.0"})
    return urllib.request.urlopen(req, timeout=timeout)


def remote_size(url: str) -> int | None:
    """Content-Length of `url`, or None if the file does not exist."""
    try:
        with _open(url, method="HEAD", timeout=60) as resp:
            return int(resp.headers.get("Content-Length", 0))
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise


def fetch(url: str, dest: Path, attempts: int = 4) -> tuple[str, int]:
    """Download `url` to `dest` unless the local copy is already complete.

    Returns (status, bytes) where status is 'skip' | 'get' | 'missing'.
    """
    for attempt in range(attempts):
        try:
            size = remote_size(url)
            if size is None:
                return ("missing", 0)
            if dest.exists() and dest.stat().st_size == size:
                return ("skip", size)
            dest.parent.mkdir(parents=True, exist_ok=True)
            tmp = dest.with_suffix(dest.suffix + ".part")
            with _open(url) as resp, tmp.open("wb") as fh:
                while chunk := resp.read(1 << 20):
                    fh.write(chunk)
            if tmp.stat().st_size != size:
                tmp.unlink(missing_ok=True)
                raise OSError(f"short read for {url}")
            tmp.replace(dest)
            return ("get", size)
        except Exception as exc:  # noqa: BLE001 - retry any transport error
            if attempt == attempts - 1:
                raise
            _log(f"  retry {attempt + 1}/{attempts - 1} {url}: {exc}")
            time.sleep(1.5 * (attempt + 1))
    raise AssertionError("unreachable")


def load_match_list(competition_id: int, season_id: int) -> list[dict]:
    """Download (if needed) and parse `data/matches/{comp}/{season}.json`."""
    dest = RAW_DIR / "matches" / str(competition_id) / f"{season_id}.json"
    fetch(f"{STATSBOMB_BASE}/matches/{competition_id}/{season_id}.json", dest)
    return json.loads(dest.read_text())


def download_all(workers: int = 8) -> dict:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    jobs: list[tuple[str, Path]] = []
    match_ids: list[int] = []

    for comp_id, season_id, label in COMPETITIONS:
        matches = load_match_list(comp_id, season_id)
        _log(f"{label}: {len(matches)} matches")
        for m in matches:
            mid = m["match_id"]
            match_ids.append(mid)
            for kind in ("events", "three-sixty", "lineups"):
                jobs.append((f"{STATSBOMB_BASE}/{kind}/{mid}.json", RAW_DIR / kind / f"{mid}.json"))

    total = len(jobs)
    done = 0
    got = skipped = 0
    missing: list[str] = []
    t0 = time.time()

    def run(job: tuple[str, Path]) -> tuple[str, int, Path]:
        url, dest = job
        status, size = fetch(url, dest)
        return status, size, dest

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for status, _size, dest in pool.map(run, jobs):
            done += 1
            if status == "get":
                got += 1
            elif status == "skip":
                skipped += 1
            else:
                missing.append(str(dest))
            if done % 25 == 0 or done == total:
                _log(f"  {done}/{total} files ({got} fetched, {skipped} already complete)")

    # docs/statsbomb-notes.md §2.1: reject sub-50 KB three-sixty files as stubs.
    stubs = [
        mid
        for mid in match_ids
        if (p := RAW_DIR / "three-sixty" / f"{mid}.json").exists() and p.stat().st_size < MIN_360_BYTES
    ]

    report = {
        "matches": len(match_ids),
        "files": total,
        "fetched": got,
        "already_complete": skipped,
        "missing": missing,
        "stub_360_matches": stubs,
        "seconds": round(time.time() - t0, 1),
        "bytes_on_disk": sum(p.stat().st_size for p in RAW_DIR.rglob("*.json")),
    }
    _log(json.dumps(report, indent=2))
    if missing:
        _log(f"WARNING: {len(missing)} files missing upstream")
    if stubs:
        _log(f"WARNING: {len(stubs)} stub 360 files (<{MIN_360_BYTES} bytes): {stubs}")
    return report


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Download StatsBomb Open Data for Halfspace")
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args(argv)
    download_all(workers=args.workers)
    return 0


if __name__ == "__main__":
    sys.exit(main())
