"""Backfill MLB history from the Stats API into Parquet in Cloudflare R2.

    python scripts/warehouse_backfill.py                 # 2015 -> current season
    python scripts/warehouse_backfill.py --seasons 2015 2016
    python scripts/warehouse_backfill.py --local ./dir   # no R2, for a dry run

    python scripts/warehouse_backfill.py --seasons 2017 --force   # re-ingest

Resumable: days already recorded in the manifest are skipped, so re-running
after an interruption continues where it stopped. Season windows are Mar 1 to
Nov 15, which avoids ~100 pointless schedule calls per year in the off-season.

`--force` re-ingests days the manifest already holds. Needed when the SCHEMA
widens rather than when the data is wrong: 9275cd0 added the pitch-physics
columns (release_pos/vel_*, accel_*, pfx_*, break_vertical, type_confidence),
which no day written before it carries. Two things to know before using it:

  * It CLEARS VERIFICATION for every day it rewrites. manifest.record sets
    verified_at back to None on purpose -- a re-ingest rewrites the bytes, so
    an older attestation no longer describes what is stored. Re-earn it with
    `python -m warehouse verify --range A..B --record`, which costs another
    pass over the MLB API.
  * It is not needed to make mixed schemas readable. duck.dataset reads with
    union_by_name, so an absent column comes back NULL rather than failing the
    scan. Re-ingest is for filling the columns in, not for making them safe.

DO NOT LET THIS OVERLAP THE NIGHTLY. ingest_range loads the manifest ONCE and
flushes its in-memory copy every 25 days, so anything written to R2 by another
process in between is silently overwritten on the next flush -- a lost update,
with no error on either side. Measured 2026-09-24: a local `--force` run that
started at 23:35 erased the nightly's `pitches/2026-09-23` entry outright. The
Parquet object was still in the bucket; the manifest simply stopped mentioning
it, and `status` reported the warehouse a day behind.

`concurrency: warehouse-nightly` in .github/workflows/warehouse.yml guards the
workflow against ITSELF, not against a laptop. Before a long run, check the
nightly's schedule (04:00 ET, via 08:00/09:00 UTC cron lines) and either finish
well clear of it or expect to repair the overlap with
`python -m warehouse ingest --day <D> --force` plus a re-verify.

A long backfill is also a poor fit for a machine that sleeps: the process
suspends with the host and resumes hours later still holding its stale
manifest, which widens the window above from minutes to a whole day. Prefer a
runner that stays awake.

Progress is written to stdout and to warehouse-backfill.log so a long run can
be followed with `tail -f`.
"""

from __future__ import annotations

import argparse
import sys
import time
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from warehouse import manifest  # noqa: E402
from warehouse.config import FIRST_SEASON, r2_config  # noqa: E402
from warehouse.ingest import ingest_range, refresh_players  # noqa: E402
from warehouse.store import LocalStore, R2Store  # noqa: E402

LOG = Path("warehouse-backfill.log")


def log(msg: str) -> None:
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    with LOG.open("a", encoding="utf-8") as fh:
        fh.write(line + "\n")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", nargs="*", type=int, default=None)
    ap.add_argument("--local", default=None)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--no-boxscore", action="store_true")
    ap.add_argument("--force", action="store_true",
                    help="re-ingest days the manifest already holds; clears "
                         "their verification (see the module docstring)")
    args = ap.parse_args()

    store = LocalStore(args.local) if args.local else R2Store(r2_config())
    seasons = args.seasons or list(range(FIRST_SEASON, date.today().year + 1))

    log(f"backfill start: seasons {seasons[0]}-{seasons[-1]}, "
        f"workers={args.workers}, store={'local' if args.local else 'R2'}")

    grand = {"days": 0, "games": 0, "pitches": 0, "at_bats": 0, "bytes": 0}
    players: set[int] = set()
    t_all = time.time()

    for season in seasons:
        start, end = f"{season}-03-01", f"{season}-11-15"
        if season == date.today().year:
            end = min(end, date.today().isoformat())
        t0 = time.time()
        seen = {"n": 0}

        def on_day(day, res, err):
            seen["n"] += 1
            if err:
                log(f"  {day}  FAILED: {err}")
            elif res and res["written"] and seen["n"] % 10 == 0:
                log(f"  {day}  {res['games']:>2}g {res['pitches']:>5}p "
                    f"({seen['n']} days done this season)")

        totals = ingest_range(store, start, end, workers=args.workers,
                              with_boxscore=not args.no_boxscore,
                              skip_existing=not args.force,
                              on_day=on_day)
        el = time.time() - t0
        players |= totals.pop("player_ids", set())
        for k in grand:
            grand[k] += totals.get(k, 0)
        log(f"SEASON {season}: {totals['days']} days, {totals['games']} games, "
            f"{totals['pitches']:,} pitches, {totals['bytes']/1e6:.0f} MB, "
            f"{el/60:.1f} min, skipped={totals['skipped']}, "
            f"failed={len(totals['failed'])}")
        for f in totals["failed"][:5]:
            log(f"    ! {f}")

    log(f"\nfetching player metadata for {len(players)} ids")
    try:
        n = refresh_players(store, sorted(players))
        log(f"  players snapshot: +{n} new")
    except Exception as exc:  # noqa: BLE001
        log(f"  players snapshot FAILED: {exc}")

    el = time.time() - t_all
    log(f"\nDONE in {el/60:.1f} min — {grand['days']} days, "
        f"{grand['games']:,} games, {grand['pitches']:,} pitches, "
        f"{grand['bytes']/1e6:.0f} MB")
    log("\nmanifest:\n" + manifest.summary(manifest.load(store)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
