"""One-time cold dump of Supabase `predictions` to R2 Parquet.

SUPERSEDED 2026-08-08 by `python -m warehouse export`
-----------------------------------------------------
Do not run this. The nightly now exports `predictions`, `picks` AND
`game_predictions` on a schedule, with manifest entries, under the normal
`<dataset>/season=/month=/day=` keys.

This script's output is still in the bucket under `holdout/predictions/`
(verified present for 2026-07-07 onward). It is NOT migrated and NOT in the
manifest, because its locally-declared schema differs from
`warehouse.config.PREDICTION_SCHEMA` — it has no `official_date`, and it dated
rows by `created_at`, which files a 23:58 ET prediction under the next day.
Anyone building a holdout set across that boundary has to reconcile the two;
the alternative was silently unioning two different column lists.

Kept, not deleted, because it is the only record of how those early days were
written.

Why this existed
----------------
`prune_predictions(21)` has never actually run: the deployed `daily-ingest`
build predates the migration that created it. Its first successful pass
permanently deletes every prediction older than 21 days -- measured on
2026-08-02, that is roughly 2026-07-07 through 2026-07-11.

Graded, row-level predictions are the only possible input to genuine
out-of-sample validation, and this project has none. This script exists so that
a holdout system is *possible to build later* rather than impossible. It is a
raw dump: no consumer, no schema design, no model work.

What this is NOT
----------------
This is not a warehouse dataset.

  * The schema is declared here, locally, and deliberately NOT added to
    `warehouse.config.SCHEMAS`, which is reserved for the frozen warehouse
    datasets whose column lists historical files must keep matching.
  * It writes NO manifest entries. The manifest is the hot-window prune's
    delete gate; a non-warehouse dataset must never become a gate input.

It borrows only `warehouse.store.R2Store` for object access and mirrors
`warehouse.ingest.to_parquet`'s serialisation (explicit schema + zstd).

Usage
-----
    export R2_BUCKET=pitch-hawk-warehouse      # the .env value is mistyped
    py scripts/export_predictions.py
    py scripts/export_predictions.py --dry-run
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone

# Resolve the bucket BEFORE importing warehouse.config, which calls
# load_dotenv(".env") at import time. load_dotenv does not override variables
# already present in the environment, so setting it here wins over the .env
# typo (pitch-hawk-wa3rehouse) without editing .env -- that fix is Task 1.5.
_DEFAULT_BUCKET = "pitch-hawk-warehouse"

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pyarrow as pa  # noqa: E402
import pyarrow.parquet as pq  # noqa: E402
from dotenv import load_dotenv  # noqa: E402

load_dotenv(".env")

PREFIX = "holdout/predictions"

# Verified against information_schema on 2026-08-02. `probs` is jsonb and is
# stored as a JSON string: an Arrow struct would freeze today's market-specific
# key sets into the file layout, and these are a raw dump, not a modelled table.
SCHEMA = pa.schema([
    ("id", pa.int64()),
    ("game_pk", pa.int64()),
    ("at_bat_index", pa.int32()),
    ("pitch_number", pa.int32()),
    ("market", pa.string()),
    ("predicted_value", pa.float64()),
    ("confidence", pa.float64()),
    ("probs", pa.string()),
    ("recommendation", pa.string()),
    ("line", pa.float64()),
    ("price", pa.int32()),
    ("edge", pa.float64()),
    ("units", pa.float64()),
    ("result", pa.string()),
    ("profit_units", pa.float64()),
    ("graded_at", pa.timestamp("us", tz="UTC")),
    ("model_version", pa.string()),
    ("created_at", pa.timestamp("us", tz="UTC")),
    ("book", pa.string()),
])

COLUMNS = [f.name for f in SCHEMA]
_TS_COLS = ("graded_at", "created_at")
_INT_COLS = ("id", "game_pk", "at_bat_index", "pitch_number", "price")
_FLOAT_COLS = ("predicted_value", "confidence", "line", "edge", "units",
               "profit_units")


def _ts(v):
    """PostgREST ISO-8601 -> tz-aware datetime. Naive values are read as UTC."""
    if v in (None, ""):
        return None
    if isinstance(v, datetime):
        dt = v
    else:
        dt = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


def _shape(row: dict) -> dict:
    """Coerce one PostgREST row into the declared schema's types."""
    out: dict = {}
    for col in COLUMNS:
        v = row.get(col)
        if col in _TS_COLS:
            out[col] = _ts(v)
        elif col == "probs":
            # Already a dict/list from JSON decoding; re-serialise stably so a
            # re-export of the same row is byte-identical.
            out[col] = None if v is None else json.dumps(v, sort_keys=True)
        elif col in _INT_COLS:
            out[col] = None if v is None else int(v)
        elif col in _FLOAT_COLS:
            out[col] = None if v is None else float(v)
        else:
            out[col] = None if v is None else str(v)
    return out


def fetch_all(client, page_size: int):
    """Keyset-paginate `predictions` by ascending id.

    Keyset, not OFFSET: `live-poll` inserts every 30 seconds, and an offset
    window shifts under concurrent inserts, which silently skips or duplicates
    rows. Paging on `id > last` is stable under append.
    """
    last_id = -1
    total = 0
    while True:
        res = (client.table("predictions")
               .select(",".join(COLUMNS))
               .gt("id", last_id)
               .order("id")
               .limit(page_size)
               .execute())
        rows = res.data or []
        if not rows:
            return
        last_id = rows[-1]["id"]
        total += len(rows)
        print(f"  fetched {total:,} rows (through id {last_id})", flush=True)
        yield rows


def to_parquet(rows: list[dict]) -> bytes:
    """Serialise with the declared schema, zstd -- as warehouse.ingest does.

    The explicit schema is load-bearing for the same reason it is in the
    warehouse: an inferred schema types an all-NULL column (e.g. `book`, which
    is null for every non-odds prediction) as `null`, and DuckDB then refuses
    to read that day alongside days where the column has values.
    """
    table = pa.Table.from_pylist(rows, schema=SCHEMA)
    buf = io.BytesIO()
    pq.write_table(table, buf, compression="zstd")
    return buf.getvalue()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--bucket", default=os.environ.get("R2_BUCKET"),
                    help="R2 bucket (default: $R2_BUCKET)")
    ap.add_argument("--page-size", type=int, default=50_000)
    ap.add_argument("--prefix", default=PREFIX)
    ap.add_argument("--dry-run", action="store_true",
                    help="Fetch and group, but write nothing to R2.")
    args = ap.parse_args()

    bucket = args.bucket or _DEFAULT_BUCKET
    if bucket != _DEFAULT_BUCKET:
        print(f"warning: bucket is {bucket!r}, expected {_DEFAULT_BUCKET!r}",
              file=sys.stderr)
    os.environ["R2_BUCKET"] = bucket

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_KEY")
    if not url or not key:
        print("SUPABASE_URL and SUPABASE_KEY must be set (see .env)",
              file=sys.stderr)
        return 2

    from supabase import create_client

    from warehouse.config import r2_config
    from warehouse.store import R2Store

    store = R2Store(r2_config())
    # Fail loudly on a wrong bucket. Without this, every head_object returns
    # 403 and the run looks empty rather than misconfigured.
    from botocore.exceptions import ClientError
    try:
        store._s3.head_bucket(Bucket=bucket)
    except ClientError as exc:
        print(f"R2 bucket {bucket!r} is not reachable ({exc}). Check R2_BUCKET "
              f"-- a wrong name returns 403 on every object, not an error.",
              file=sys.stderr)
        return 2

    client = create_client(url, key)

    by_day: dict[str, list[dict]] = defaultdict(list)
    fetched = 0
    print("Paging predictions...", flush=True)
    for page in fetch_all(client, args.page_size):
        for row in page:
            shaped = _shape(row)
            created = shaped["created_at"]
            if created is None:
                # Cannot be placed in a day partition; surfaced, not dropped
                # silently.
                by_day["unknown"].append(shaped)
            else:
                by_day[created.astimezone(timezone.utc).date().isoformat()] \
                    .append(shaped)
            fetched += 1

    if not fetched:
        print("no rows returned -- refusing to report success", file=sys.stderr)
        return 1

    days = sorted(d for d in by_day if d != "unknown")
    print(f"\n{fetched:,} rows across {len(days)} days "
          f"({days[0]} .. {days[-1]})")
    if "unknown" in by_day:
        print(f"  WARNING: {len(by_day['unknown']):,} rows have a null "
              f"created_at and were not written")

    written = 0
    total_bytes = 0
    for day in days:
        rows = sorted(by_day[day], key=lambda r: r["id"])
        blob = to_parquet(rows)
        key_ = f"{args.prefix}/season={day[:4]}/month={day[5:7]}/day={day}.parquet"
        if args.dry_run:
            print(f"  [dry-run] {key_}  {len(rows):,} rows  {len(blob):,} B")
        else:
            store.put(key_, blob)
            # Read back immediately: the object store can accept bytes the
            # manifest-less caller would otherwise never confirm landed.
            back = pq.read_table(io.BytesIO(store.get(key_)))
            if back.num_rows != len(rows):
                print(f"  FAIL {key_}: wrote {len(rows)} rows, read back "
                      f"{back.num_rows}", file=sys.stderr)
                return 1
            print(f"  ok {key_}  {len(rows):,} rows  {len(blob):,} B")
        written += len(rows)
        total_bytes += len(blob)

    print(f"\n{'would write' if args.dry_run else 'wrote'} {written:,} rows, "
          f"{total_bytes / 1e6:.1f} MB across {len(days)} files")
    if written != fetched - len(by_day.get("unknown", [])):
        print("row-count mismatch between fetch and write", file=sys.stderr)
        return 1
    print("NOTE: no manifest entries written -- this is not a warehouse "
          "dataset and must not become a prune-gate input.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())