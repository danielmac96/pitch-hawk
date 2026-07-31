"""The manifest: the warehouse's index and its integrity record.

Two jobs:

1. Index. Readers resolve which Parquet files exist through this file rather
   than listing the bucket.
2. Gate. Once the Supabase hot-window prune ships, it refuses to delete a day
   that has no verified manifest entry. That makes this the only thing standing
   between a failed export and permanent data loss, so `is_verified` is
   deliberately strict: a falsy checksum or timestamp is not verified.
"""

from __future__ import annotations

import json
from typing import Any

from warehouse.config import MANIFEST_KEY


def empty() -> dict[str, Any]:
    return {"version": 1, "datasets": {}}


def load(store) -> dict[str, Any]:  # noqa: ANN001
    if not store.exists(MANIFEST_KEY):
        return empty()
    return json.loads(store.get(MANIFEST_KEY).decode("utf-8"))


def save(store, m: dict[str, Any]) -> None:  # noqa: ANN001
    store.put(MANIFEST_KEY,
              json.dumps(m, indent=2, sort_keys=True).encode("utf-8"))


def record(m: dict[str, Any], dataset: str, day: str, *, rows: int,
           size_bytes: int, checksum: str, verified_at: str,
           games: int = 0) -> dict[str, Any]:
    """Insert or replace one dataset-day entry. Mutates and returns `m`."""
    m.setdefault("datasets", {}).setdefault(dataset, {})[day] = {
        "rows": rows,
        "bytes": size_bytes,
        "games": games,
        "checksum": checksum,
        "verified_at": verified_at,
    }
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
    e = entry(m, dataset, day)
    return bool(e and e.get("checksum") and e.get("verified_at"))


def summary(m: dict[str, Any]) -> str:
    lines = []
    for ds in sorted(m.get("datasets", {})):
        d = days(m, ds)
        span = f"{d[0]} .. {d[-1]}" if d else "-"
        lines.append(
            f"  {ds:<10} {len(d):>5} days  {total_rows(m, ds):>12,} rows  "
            f"{total_bytes(m, ds) / 1e6:>9.1f} MB   {span}")
    return "\n".join(lines)
