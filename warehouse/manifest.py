"""The manifest: the warehouse's index and its integrity record.

Two jobs:

1. Index. Readers resolve which Parquet files exist through this file rather
   than listing the bucket.
2. Gate. The Supabase hot-window prune refuses to delete a day that has no
   verified manifest entry. That makes this the only thing standing between a
   failed export and permanent data loss.

**Attestation and verification are different claims and are stored
separately.** This is the whole point of the v2 layout:

    ingested_at  written by warehouse.ingest. Says only "the ingest ran and
                 wrote these rows". It is derived from the same in-memory rows
                 that produced the Parquet, so it cannot attest to anything an
                 independent re-derivation would catch — a flattener bug
                 corrupts the rows and the checksum identically.

    verified_at  written ONLY by warehouse.verify, after re-fetching the day
    verified_by  from the MLB API and re-deriving it from scratch.

Until 2026-08-02 `record()` wrote `verified_at` itself at ingest time, so
`is_verified()` returned True for all 2,011 days while real independent
coverage was five. The prune would have been gated on nothing. `is_verified`
is now deliberately strict: it requires a checksum, a timestamp, AND a
`verified_by`, the last of which only verify.py can produce.

A re-ingest invalidates any prior verification, because the bytes changed.
"""

from __future__ import annotations

import json
from typing import Any

from warehouse.config import MANIFEST_KEY


VERSION = 2


def empty() -> dict[str, Any]:
    return {"version": VERSION, "datasets": {}}


def load(store) -> dict[str, Any]:  # noqa: ANN001
    if not store.exists(MANIFEST_KEY):
        return empty()
    m = json.loads(store.get(MANIFEST_KEY).decode("utf-8"))
    v = m.get("version")
    if v != VERSION:
        # Refuse rather than coerce. In v1, `verified_at` was written by the
        # ingest, so a v1 entry that looks verified is not: reading it with v2
        # semantics would report independent verification that never happened,
        # and the prune gates on exactly that field.
        raise ValueError(
            f"manifest is version {v!r}, this code expects {VERSION}. "
            f"Run `py scripts/migrate_manifest_v2.py` to migrate it "
            f"(--dry-run first)."
        )
    return m


def save(store, m: dict[str, Any]) -> None:  # noqa: ANN001
    store.put(MANIFEST_KEY,
              json.dumps(m, indent=2, sort_keys=True).encode("utf-8"))


def record(m: dict[str, Any], dataset: str, day: str, *, rows: int,
           size_bytes: int, checksum: str, ingested_at: str,
           games: int = 0) -> dict[str, Any]:
    """Ingest attestation. Insert or replace one dataset-day entry.

    Deliberately does NOT set the verification fields. This data comes from the
    same in-memory rows as the Parquet, so it cannot attest to anything an
    independent re-derivation would catch. Only warehouse.verify may set them.

    Clearing them is not incidental: a re-ingest rewrites the bytes, so any
    prior verification no longer describes what is stored.
    """
    m.setdefault("datasets", {}).setdefault(dataset, {})[day] = {
        "rows": rows,
        "bytes": size_bytes,
        "games": games,
        "checksum": checksum,
        "ingested_at": ingested_at,
        "verified_at": None,
        "verified_by": None,
    }
    return m


def record_verified(m: dict[str, Any], dataset: str, day: str, *,
                    verified_at: str, verified_by: str) -> dict[str, Any]:
    """Written only by warehouse.verify, after an independent re-derivation.

    Raises if there is no entry to verify: verifying a day the warehouse does
    not claim to hold is a bug in the caller, not a day to quietly vouch for.
    """
    e = entry(m, dataset, day)
    if e is None:
        raise KeyError(f"{dataset}/{day} has no manifest entry to verify")
    e["verified_at"] = verified_at
    e["verified_by"] = verified_by
    return m


def entry(m: dict[str, Any], dataset: str, day: str) -> dict[str, Any] | None:
    return m.get("datasets", {}).get(dataset, {}).get(day)


def days(m: dict[str, Any], dataset: str) -> list[str]:
    return sorted(m.get("datasets", {}).get(dataset, {}))


def total_rows(m: dict[str, Any], dataset: str) -> int:
    return sum(e["rows"]
               for e in m.get("datasets", {}).get(dataset, {}).values())


def total_bytes(m: dict[str, Any], dataset: str) -> int:
    return sum(e["bytes"]
               for e in m.get("datasets", {}).get(dataset, {}).values())


def is_verified(m: dict[str, Any], dataset: str, day: str) -> bool:
    """The prune's delete gate.

    `verified_by` is the load-bearing term: only warehouse.verify writes it,
    so an ingest-only entry cannot satisfy this no matter how complete it
    looks. A falsy checksum, timestamp or writer is not verified.
    """
    e = entry(m, dataset, day)
    return bool(e and e.get("checksum") and e.get("verified_at")
                and e.get("verified_by"))


def is_ingested(m: dict[str, Any], dataset: str, day: str) -> bool:
    """Written and indexed, but making no claim about independent correctness."""
    e = entry(m, dataset, day)
    return bool(e and e.get("checksum"))


def verified_days(m: dict[str, Any], dataset: str) -> list[str]:
    return [d for d in days(m, dataset) if is_verified(m, dataset, d)]


def unverified_days(m: dict[str, Any], dataset: str) -> list[str]:
    """Ingested but never independently re-derived. The prune must skip these."""
    return [d for d in days(m, dataset) if not is_verified(m, dataset, d)]


def summary(m: dict[str, Any]) -> str:
    lines = []
    for ds in sorted(m.get("datasets", {})):
        d = days(m, ds)
        span = f"{d[0]} .. {d[-1]}" if d else "-"
        ver = len(verified_days(m, ds))
        lines.append(
            f"  {ds:<10} {len(d):>5} days  {total_rows(m, ds):>12,} rows  "
            f"{total_bytes(m, ds) / 1e6:>9.1f} MB   {span}\n"
            f"  {'':<10} {ver:>5} verified, {len(d) - ver} ingested-only")
    return "\n".join(lines)
