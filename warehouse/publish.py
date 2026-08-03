"""Push the DuckDB-built aggregates into Supabase.

Publishing is **all-or-nothing per table**. PostgREST cannot hold a
transaction across requests, so the sequence is:

    1. build the whole Arrow table in DuckDB          (nothing published yet)
    2. clear the table's `_staging` twin
    3. insert into staging in batches                 (nobody reads staging)
    4. call publish_aggregate('<table>')              (one plpgsql transaction)

Step 4 does `delete` + `insert from staging` inside a single function body, so
a crash at any earlier point leaves the live table exactly as it was. It also
refuses a zero-row publish: blanking a frontend panel is worse than serving
yesterday's numbers.

Requires the service-role key (`SUPABASE_KEY`), which bypasses RLS — the
staging tables have RLS enabled and no policy, so nothing else can touch them.
"""

from __future__ import annotations

import math
import os
import time
from datetime import date, datetime

from warehouse import aggregates as agg
from warehouse import duck, manifest

# PostgREST rejects very large request bodies and Supabase's pooler is happier
# with modest batches. A 65k-row publish is ~33 requests at this size.
BATCH = 2000

# A nightly job over a long-lived TLS connection will hit transient network
# faults; the first real publish died on `SSLV3_ALERT_BAD_RECORD_MAC` partway
# through situational_splits. That is retryable, and retrying is safe: staging
# is cleared before each table and nothing is live until the swap.
RETRIES = 4


def _retry(fn, what: str, *, retries: int = RETRIES):
    """Run `fn`, retrying transient transport failures with backoff.

    Deliberately does NOT retry APIError: a 4xx from PostgREST means the
    payload or the schema is wrong, and hammering it will not fix that.
    """
    from postgrest.exceptions import APIError

    last = None
    for attempt in range(retries):
        try:
            return fn()
        except APIError:
            raise
        except Exception as exc:  # noqa: BLE001 - transport layer, many types
            last = exc
            if attempt == retries - 1:
                break
            time.sleep(min(20, 2 ** attempt))
    raise RuntimeError(f"{what} failed after {retries} attempts: {last}")


def _client():
    """Service-role Supabase client. Imported lazily so `warehouse.duck` and
    the aggregate builders stay usable with no Supabase dependency at all."""
    from supabase import create_client

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_KEY")
    if not url or not key:
        raise RuntimeError(
            "SUPABASE_URL and SUPABASE_KEY (service-role) are required to "
            "publish; set them in .env locally or as Actions secrets.")
    return create_client(url, key)


def _jsonable(v):
    """Arrow -> JSON. PostgREST needs ISO strings for dates and rejects the
    NaN/Infinity that a division by an empty group can produce."""
    if isinstance(v, (date, datetime)):
        return v.isoformat()
    if isinstance(v, float):
        return None if (math.isnan(v) or math.isinf(v)) else v
    from decimal import Decimal
    if isinstance(v, Decimal):
        f = float(v)
        return None if (math.isnan(f) or math.isinf(f)) else f
    return v


def rows_of(table) -> list[dict]:  # noqa: ANN001
    return [{k: _jsonable(v) for k, v in r.items()} for r in table.to_pylist()]


def build(store, *, min_pa: int = 3, only=None, m: dict | None = None,
          on_progress=None) -> dict:  # noqa: ANN001
    """Build every aggregate. Returns {name: pyarrow.Table}.

    Two DuckDB connections: one windowed to the recent seasons, one over all
    history for `game_context`. Registering views is cheap; the scan is not,
    so the full-history connection is created only if something needs it.
    """
    if m is None:
        m = manifest.load(store)
    names = list(only) if only else list(agg.BUILDERS)
    unknown = [n for n in names if n not in agg.BUILDERS]
    if unknown:
        raise ValueError(f"unknown aggregate(s): {unknown}; "
                         f"expected {sorted(agg.BUILDERS)}")

    window = duck.recent_seasons(store, agg.WINDOW_SEASONS, m=m)
    if not window:
        raise RuntimeError("manifest holds no seasons; nothing to publish")

    con_w = con_f = None
    out: dict = {}
    try:
        for name in names:
            fn, full_history = agg.BUILDERS[name]
            if full_history:
                if con_f is None:
                    con_f = duck.connect(store)
                    duck.register(con_f, store, m=m)
                con, floor = con_f, min(duck.seasons_available(store, m=m))
            else:
                if con_w is None:
                    con_w = duck.connect(store)
                    duck.register(con_w, store, seasons=window, m=m)
                con, floor = con_w, window[0]
            if name in agg.STATCAST_TABLES:
                floor = max(floor, agg.STATCAST_FLOOR)

            t0 = time.time()
            tbl = (fn(con, floor, min_pa=min_pa) if name == "matchup_history"
                   else fn(con, floor))
            out[name] = tbl
            if on_progress:
                on_progress(name, tbl.num_rows, time.time() - t0)
    finally:
        for c in (con_w, con_f):
            if c is not None:
                c.close()
    return out


def publish_table(client, name: str, table, *,  # noqa: ANN001
                  batch: int = BATCH) -> int:
    """Stage then swap one aggregate. Returns rows live after the swap."""
    staging = f"{name}_staging"
    rows = rows_of(table)
    if not rows:
        # publish_aggregate would reject this anyway; fail here with a message
        # that names the builder rather than the RPC.
        raise RuntimeError(
            f"{name}: builder produced 0 rows; refusing to publish. "
            f"Check `python -m warehouse status` — an empty or short manifest "
            f"is the usual cause.")

    # Clear staging first: a previous crashed run may have left rows, and the
    # swap copies staging wholesale.
    _retry(lambda: client.rpc("clear_aggregate_staging",
                              {"p_table": name}).execute(),
           f"{name}: clear staging")

    for i in range(0, len(rows), batch):
        chunk = rows[i:i + batch]
        _retry(lambda c=chunk: client.table(staging).insert(c).execute(),
               f"{name}: staging rows {i}-{i + len(chunk)}")

    return _retry(lambda: client.rpc("publish_aggregate",
                                     {"p_table": name}).execute().data,
                  f"{name}: swap")


def publish(store, *, min_pa: int = 3, only=None, dry_run: bool = False,
            on_progress=None, on_publish=None) -> dict:  # noqa: ANN001
    """Build, then (unless dry_run) stage and swap each table."""
    built = build(store, min_pa=min_pa, only=only, on_progress=on_progress)
    summary = {n: {"rows": t.num_rows, "bytes": t.nbytes, "published": 0}
               for n, t in built.items()}
    if dry_run:
        return summary

    client = _client()
    for name, tbl in built.items():
        n = publish_table(client, name, tbl)
        summary[name]["published"] = n
        if on_publish:
            on_publish(name, n)
    return summary
