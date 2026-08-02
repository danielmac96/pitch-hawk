"""Command line for the warehouse: `python -m warehouse <command>`.

Before this existed, verify and backfill were reachable only from a Python
REPL. That is the blocker the hot-window prune was waiting on - deletion gated
on an integrity check nobody can invoke is deletion gated on nothing.

    python -m warehouse status
    python -m warehouse verify --range 2025-03-27..2026-06-28 --record
    python -m warehouse ingest --day 2026-08-01
    python -m warehouse backfill --seasons 2026

Exit codes are load-bearing - the nightly workflow and the prune gate both
branch on them:

    0   every day passed
    1   a day failed verification (data problem: re-ingest and re-verify)
    2   operational error (credentials, network, unreadable manifest)

The distinction matters. 1 means the warehouse disagrees with the MLB API and
the prune must not run. 2 means we could not tell, which is not the same thing
and must never be treated as a pass.
"""

from __future__ import annotations

import argparse
import sys
import time
from datetime import date, timedelta

from warehouse import manifest
from warehouse.config import HOT_WINDOW_DAYS, r2_config
from warehouse.ingest import daterange, ingest_day
from warehouse.mlb import MlbApiError
from warehouse.store import LocalStore, R2Store

EXIT_OK, EXIT_FAILED, EXIT_ERROR = 0, 1, 2


def _store(args):
    return LocalStore(args.local) if getattr(args, "local", None) \
        else R2Store(r2_config())


def _yesterday() -> str:
    return (date.today() - timedelta(days=1)).isoformat()


def _resolve_days(args) -> list[str]:
    """--day / --range A..B / --sample N -> a concrete list of days."""
    if args.day:
        return [args.day]
    if args.range:
        if ".." not in args.range:
            raise ValueError(f"--range wants A..B, got {args.range!r}")
        a, b = args.range.split("..", 1)
        return daterange(a.strip(), b.strip())
    if args.sample:
        import random
        store = _store(args)
        pool = manifest.days(manifest.load(store), "pitches")
        if not pool:
            raise ValueError("manifest holds no days to sample")
        return sorted(random.sample(pool, min(args.sample, len(pool))))
    raise ValueError("one of --day, --range or --sample is required")


# ── status ──────────────────────────────────────────────────────────────────

def cmd_status(args) -> int:
    store = _store(args)
    m = manifest.load(store)
    print(f"manifest version {m.get('version')}")
    print(manifest.summary(m))

    yday = _yesterday()
    stale = False
    for ds in sorted(m.get("datasets", {})):
        days = manifest.days(m, ds)
        if not days:
            continue
        lag = (date.fromisoformat(yday) - date.fromisoformat(days[-1])).days
        flag = "" if lag <= 0 else f"   <-- {lag} day(s) behind yesterday"
        if lag > 0:
            stale = True
        print(f"  {ds:<10} max(day) {days[-1]}{flag}")

    unver = manifest.unverified_days(m, "pitches")
    if unver:
        print(f"\n  {len(unver)} pitch-days are ingested but NOT independently "
              f"verified.")
        print(f"  earliest {unver[0]}, latest {unver[-1]}")
        print(f"  The prune must not delete these. Earn them with:")
        print(f"    python -m warehouse verify --range {unver[0]}..{unver[-1]} "
              f"--record")
    else:
        print("\n  all days independently verified")

    print(f"\n  hot window is {HOT_WINDOW_DAYS} days; Postgres keeps "
          f"pitch_ts >= {(date.today() - timedelta(days=HOT_WINDOW_DAYS)).isoformat()}")
    if stale:
        print("  NOTE: warehouse is behind yesterday. Run "
              "`python -m warehouse ingest --day <D>` or the nightly workflow.")
    return EXIT_OK


# ── verify ──────────────────────────────────────────────────────────────────

def cmd_verify(args) -> int:
    from warehouse.verify import verify_sample

    store = _store(args)
    days = _resolve_days(args)
    print(f"verifying {len(days)} day(s), workers={args.workers}, "
          f"record={args.record}")
    t0 = time.time()
    res = verify_sample(store, days, record=args.record,
                        fail_fast=args.fail_fast, workers=args.workers,
                        with_boxscore=not args.no_boxscore)
    el = time.time() - t0

    print(f"\nchecked {res['checked']}  ok {res['ok']}  "
          f"empty {res['empty']}  newly-recorded {res['verified']}  "
          f"failed {len(res['failed'])}   [{el/60:.1f} min]")
    if res["failed"]:
        print("\nFAILED DAYS - re-ingest then re-verify each before the prune:")
        for f in res["failed"]:
            print(f"  {f['day']}: {'; '.join(f['reasons'])}")
            print(f"    python -m warehouse ingest --day {f['day']} --force")
        return EXIT_FAILED
    return EXIT_OK


# ── ingest ──────────────────────────────────────────────────────────────────

def cmd_ingest(args) -> int:
    store = _store(args)
    day = args.day or _yesterday()
    m = manifest.load(store)

    if not args.force and manifest.entry(m, "pitches", day):
        print(f"{day} already in the manifest; --force to re-ingest")
        return EXIT_OK

    print(f"ingesting {day} (workers={args.workers})")
    res = ingest_day(store, day, workers=args.workers,
                     with_boxscore=not args.no_boxscore, m=m)
    manifest.save(store, m)

    if not res["written"]:
        # Not an error: only final games are ingested, so a day whose games are
        # still in progress (or a genuinely empty day) writes nothing and is
        # picked up by a later run.
        print(f"{day}: no final games; nothing written")
        return EXIT_OK

    print(f"{day}: {res['games']} games, {res['pitches']:,} pitches, "
          f"{res['at_bats']:,} at_bats, {res['bytes']/1e6:.1f} MB")
    if args.force:
        print("  re-ingest cleared any prior verification for this day; "
              "re-verify it before the prune relies on it")
    return EXIT_OK


# ── backfill ────────────────────────────────────────────────────────────────

def cmd_backfill(args) -> int:
    """Thin wrapper over scripts/warehouse_backfill.py, which stays the
    reference implementation because the docs point at it."""
    import scripts.warehouse_backfill as bf

    argv = []
    if args.seasons:
        argv += ["--seasons"] + [str(s) for s in args.seasons]
    if args.local:
        argv += ["--local", args.local]
    if args.workers:
        argv += ["--workers", str(args.workers)]
    if args.no_boxscore:
        argv += ["--no-boxscore"]
    old, sys.argv = sys.argv, ["warehouse_backfill.py"] + argv
    try:
        return bf.main()
    finally:
        sys.argv = old


# ── entry point ─────────────────────────────────────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="python -m warehouse",
                                 description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--local", default=None,
                    help="Use a local directory instead of R2 (no credentials).")
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("status", help="manifest summary + verified vs ingested-only")
    s.set_defaults(fn=cmd_status)

    v = sub.add_parser("verify", help="independent re-derivation against the MLB API")
    g = v.add_mutually_exclusive_group(required=True)
    g.add_argument("--day")
    g.add_argument("--range", help="A..B inclusive, e.g. 2025-03-27..2026-06-28")
    g.add_argument("--sample", type=int, help="N random days from the manifest")
    v.add_argument("--record", action="store_true",
                   help="Write verified_at/verified_by on success. This is the "
                        "only thing that opens the prune's delete gate.")
    v.add_argument("--fail-fast", action="store_true")
    v.add_argument("--workers", type=int, default=6)
    v.add_argument("--no-boxscore", action="store_true")
    v.set_defaults(fn=cmd_verify)

    i = sub.add_parser("ingest", help="fetch and write one day")
    i.add_argument("--day", help="YYYY-MM-DD (default: yesterday)")
    i.add_argument("--force", action="store_true",
                   help="Re-ingest a day already in the manifest.")
    i.add_argument("--workers", type=int, default=6)
    i.add_argument("--no-boxscore", action="store_true")
    i.set_defaults(fn=cmd_ingest)

    b = sub.add_parser("backfill", help="ingest whole seasons (resumable)")
    b.add_argument("--seasons", nargs="*", type=int, default=None)
    b.add_argument("--workers", type=int, default=6)
    b.add_argument("--no-boxscore", action="store_true")
    b.set_defaults(fn=cmd_backfill)

    return ap


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.fn(args)
    except MlbApiError as exc:
        # Upstream refused. We could not determine correctness, which is not
        # the same as determining incorrectness -- hence 2, not 1.
        print(f"MLB API error: {exc}", file=sys.stderr)
        return EXIT_ERROR
    except (RuntimeError, ValueError, KeyError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_ERROR
    except KeyboardInterrupt:
        print("\ninterrupted", file=sys.stderr)
        return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
