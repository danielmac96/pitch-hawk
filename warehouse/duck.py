"""DuckDB over the R2 warehouse.

R2 egress is free, so scanning the full 7.9M-row corpus costs nothing but
time. This module is the thin seam between `warehouse.store` and the
aggregate SQL in `warehouse.aggregates`.

**File lists come from the manifest, never from a bucket listing.** DuckDB's
`read_parquet('s3://.../*.parquet')` resolves globs with an S3 LIST, and the
scoped R2 token is documented as having no LIST permission. As of 2026-08-03
globbing does in fact work against this bucket — the token is more permissive
than the docs claim — but the manifest is still the right source:

  * it survives the token being tightened back to its documented scope;
  * it reads exactly the days the warehouse *claims* to hold, so a stray or
    half-written object cannot silently join a query;
  * it can be filtered to verified days, which a glob cannot.

Every helper takes an optional pre-loaded manifest `m`, because the manifest
is 1.47 MB and a seven-table publish would otherwise fetch it seven times.
"""

from __future__ import annotations

from warehouse import manifest
from warehouse.config import DATASETS, DAY_PARTITIONED, object_key


def connect(store):  # noqa: ANN001
    """A DuckDB connection wired up to read this store's Parquet."""
    import duckdb

    con = duckdb.connect()
    # The progress bar writes thousands of carriage returns into CI logs.
    con.execute("set enable_progress_bar = false")
    store.configure_duckdb(con)
    return con


def days(store, dataset: str, seasons=None, *, m: dict | None = None,
         verified_only: bool = False) -> list[str]:
    """Days the manifest holds for `dataset`, optionally limited to seasons."""
    # DAY_PARTITIONED, not DATASETS: the Supabase exports are readable here
    # too, which is the entire point of storing them. `register` still defaults
    # to the MLB datasets, so no aggregate picks them up by accident.
    if dataset not in DAY_PARTITIONED:
        raise ValueError(
            f"unknown dataset {dataset!r}; "
            f"expected one of {sorted(DAY_PARTITIONED)}")
    if m is None:
        m = manifest.load(store)
    out = (manifest.verified_days(m, dataset) if verified_only
           else manifest.days(m, dataset))
    if seasons:
        want = {str(s) for s in seasons}
        out = [d for d in out if d[:4] in want]
    return out


def uris(store, dataset: str, seasons=None, *, m: dict | None = None,
         verified_only: bool = False) -> list[str]:
    return [store.uri(object_key(dataset, d))
            for d in days(store, dataset, seasons, m=m,
                          verified_only=verified_only)]


def dataset(store, name: str, seasons=None, *, m: dict | None = None,
            verified_only: bool = False) -> str:
    """A `read_parquet([...])` expression usable anywhere a table is.

    Returns a SQL fragment rather than a connection-bound object so the
    aggregate queries stay plain, readable SQL strings.
    """
    paths = uris(store, name, seasons, m=m, verified_only=verified_only)
    if not paths:
        raise ValueError(
            f"manifest holds no days for {name!r}"
            + (f" in seasons {sorted(seasons)}" if seasons else "")
            + ". Run `python -m warehouse status`.")
    # Paths are built from our own manifest keys, but quote defensively: a
    # single stray apostrophe would otherwise produce a syntax error at best.
    quoted = ", ".join("'" + p.replace("'", "''") + "'" for p in paths)
    return f"read_parquet([{quoted}])"


def register(con, store, names=DATASETS, seasons=None, *,  # noqa: ANN001
             m: dict | None = None, verified_only: bool = False) -> dict:
    """Create one view per dataset so the aggregate SQL can say `from pitches`.

    Returns {name: day count} so callers can log what they actually scanned —
    an aggregate built from an unexpectedly short window is otherwise
    indistinguishable from one built correctly.
    """
    if m is None:
        m = manifest.load(store)
    scanned = {}
    for name in names:
        src = dataset(store, name, seasons, m=m, verified_only=verified_only)
        con.execute(f"create or replace view {name} as select * from {src}")
        scanned[name] = len(days(store, name, seasons, m=m,
                                 verified_only=verified_only))
    return scanned


def seasons_available(store, dataset_name: str = "pitches", *,
                      m: dict | None = None) -> list[int]:
    return sorted({int(d[:4]) for d in days(store, dataset_name, m=m)})


def recent_seasons(store, n: int = 3, *, m: dict | None = None) -> list[int]:
    """The n most recent seasons present. `matchup_history` v2 and the
    season-scoped profiles are defined as windows, not as all of history."""
    avail = seasons_available(store, m=m)
    return avail[-n:] if avail else []
