"""Migrate `_manifest.json` from v1 to v2.

The v1 layout had one timestamp field, `verified_at`, and **the ingest wrote
it** (`warehouse/ingest.py`, pre-2026-08-02). So every one of the 2,011 stored
days claimed verification it had never received: `is_verified()` returned True
across the board while real independent coverage was five days.

v2 separates the two claims:

    v1                          v2
    verified_at: <ingest time>  ingested_at: <same value, honestly labelled>
                                verified_at: null
                                verified_by: null

Nulling the verification is the *correct* outcome, not data loss. It reports
the true state. `python -m warehouse verify --range ... --record` re-earns it
for the days that matter, which for the hot-window prune is the delete set.

This rewrites one object. It is idempotent: a manifest already at v2 is left
alone.

Usage:
    py scripts/migrate_manifest_v2.py --dry-run     # print the diff, write nothing
    py scripts/migrate_manifest_v2.py
"""

from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from warehouse.config import MANIFEST_KEY, r2_config  # noqa: E402
from warehouse.store import R2Store  # noqa: E402


def migrate(m: dict) -> tuple[dict, dict]:
    """Return (migrated manifest, stats). Pure — does no I/O."""
    stats = {"datasets": 0, "entries": 0, "carried": 0, "no_timestamp": 0}
    out = {"version": 2, "datasets": {}}
    for dataset, entries in sorted(m.get("datasets", {}).items()):
        stats["datasets"] += 1
        out["datasets"][dataset] = {}
        for day, e in sorted(entries.items()):
            stats["entries"] += 1
            # In v1 this field held the ingest timestamp despite its name.
            ts = e.get("verified_at")
            if ts:
                stats["carried"] += 1
            else:
                stats["no_timestamp"] += 1
            out["datasets"][dataset][day] = {
                "rows": e.get("rows"),
                "bytes": e.get("bytes"),
                "games": e.get("games", 0),
                "checksum": e.get("checksum"),
                "ingested_at": ts,
                # Never carried forward: no v1 entry was ever independently
                # verified, so claiming otherwise would re-create the defect
                # this migration exists to remove.
                "verified_at": None,
                "verified_by": None,
            }
    return out, stats


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true",
                    help="Print what would change and write nothing.")
    ap.add_argument("--backup", default="_manifest.v1.json",
                    help="Key to copy the v1 manifest to before overwriting.")
    args = ap.parse_args()

    store = R2Store(r2_config())
    if not store.exists(MANIFEST_KEY):
        print("no manifest at bucket root; nothing to migrate", file=sys.stderr)
        return 2

    raw = store.get(MANIFEST_KEY)
    m = json.loads(raw.decode("utf-8"))
    version = m.get("version")
    if version == 2:
        print("manifest is already version 2; nothing to do")
        return 0
    if version != 1:
        print(f"unexpected manifest version {version!r}; refusing to guess",
              file=sys.stderr)
        return 2

    out, stats = migrate(m)

    print(f"v1 -> v2")
    print(f"  datasets            {stats['datasets']}")
    print(f"  entries             {stats['entries']:,}")
    print(f"  verified_at -> ingested_at   {stats['carried']:,}")
    print(f"  entries with no timestamp    {stats['no_timestamp']:,}")
    print(f"  entries left verified        0  (by design)")

    for ds in sorted(out["datasets"]):
        days = sorted(out["datasets"][ds])
        if not days:
            continue
        before = m["datasets"][ds][days[0]]
        after = out["datasets"][ds][days[0]]
        print(f"\n  sample {ds}/{days[0]}")
        print(f"    before: {json.dumps(before, sort_keys=True)}")
        print(f"    after:  {json.dumps(after, sort_keys=True)}")
        break

    if args.dry_run:
        print("\n--dry-run: nothing written")
        return 0

    # Keep the v1 object. It is 1.47 MB and it is the only record of when each
    # day was ingested if anything here is wrong.
    store.put(args.backup, raw)
    print(f"\nbacked up v1 to {args.backup} ({len(raw):,} bytes)")

    blob = json.dumps(out, indent=2, sort_keys=True).encode("utf-8")
    store.put(MANIFEST_KEY, blob)
    print(f"wrote v2 manifest ({len(blob):,} bytes)")

    # Read back through the real loader, which now rejects v1 outright.
    from warehouse import manifest
    check = manifest.load(store)
    ds = sorted(check.get("datasets", {}))
    print(f"read back: version {check['version']}, datasets {ds}")
    for d in ds:
        n = len(manifest.days(check, d))
        v = len(manifest.verified_days(check, d))
        print(f"  {d:<10} {n:>5} days, {v} verified, {n - v} ingested-only")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
