"""One-time historical Statcast backfill in weekly chunks.

Usage:
    python scripts/backfill.py                 # full default range
    python scripts/backfill.py 2026-04-01 2026-04-07   # explicit window
"""

from __future__ import annotations

import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.db.client import get_client  # noqa: E402
from backend.ingestion.savant_loader import (  # noqa: E402
    build_at_bats,
    fetch_statcast_range,
    load_at_bats_to_supabase,
    load_to_supabase,
)

# 2025 Opening Day; default window captures 2025 + 2026 in-season pitches.
SEASON_START = "2025-03-27"
CHUNK_DAYS = 7
PAUSE_SECONDS = 3


def _weekly_chunks(start_iso: str, end: date):
    cur = datetime.strptime(start_iso, "%Y-%m-%d").date()
    while cur <= end:
        chunk_end = min(cur + timedelta(days=CHUNK_DAYS - 1), end)
        yield cur.isoformat(), chunk_end.isoformat()
        cur = chunk_end + timedelta(days=1)


def _table_count(table: str) -> int | None:
    try:
        return get_client().table(table).select("id", count="exact", head=True).execute().count
    except Exception as exc:
        print(f"  [warn] failed to count {table}: {exc}")
        return None


def main(argv: list[str]) -> int:
    if len(argv) == 3:
        start = argv[1]
        end = datetime.strptime(argv[2], "%Y-%m-%d").date()
    else:
        start = SEASON_START
        end = date.today() - timedelta(days=1)
    print(f"=== backfill: {start} -> {end.isoformat()} ===")

    chunks = list(_weekly_chunks(start, end))
    print(f"{len(chunks)} weekly chunks total")

    pitch_total = 0
    ab_total = 0
    for chunk_start, chunk_end in chunks:
        print(f"[FETCH] {chunk_start} - {chunk_end}")
        try:
            df = fetch_statcast_range(chunk_start, chunk_end)
        except Exception as exc:
            print(f"  # TODO: retry or find alternate source for {chunk_start}: {exc}")
            time.sleep(PAUSE_SECONDS)
            continue
        if df.empty:
            print(f"  [SKIP] no data for {chunk_start} - {chunk_end}")
            time.sleep(PAUSE_SECONDS)
            continue

        n_pitches = load_to_supabase(df, batch_size=500)
        ab_df = build_at_bats(df)
        n_ab = load_at_bats_to_supabase(ab_df, batch_size=500)
        pitch_total += n_pitches
        ab_total += n_ab
        print(f"  [DONE] {chunk_start} - {chunk_end}: "
              f"{n_pitches} pitches, {n_ab} at-bats")
        time.sleep(PAUSE_SECONDS)

    pcount = _table_count("pitches")
    abcount = _table_count("at_bats")
    print(f"=== totals: pitches={pcount} at_bats={abcount} ===")
    print(f"=== inserted this run: {pitch_total} pitches, {ab_total} at-bats ===")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
