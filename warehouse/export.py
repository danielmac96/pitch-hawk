"""Export a day of model output from Supabase into R2.

This is the other direction from `warehouse.ingest`. Ingest pulls MLB's facts
in; this pushes OUR claims out, before Supabase's retention timers delete them:
`predictions` survives 21 days, `game_predictions` 35, and until now that was
the whole lifetime of every graded prediction this project has ever made. No
holdout evaluation set exists anywhere because the rows kept being thrown away.

Three tables, one Parquet file each per day, same Hive layout as the MLB
datasets so DuckDB can join a prediction straight onto the pitch it was made
against.

**These days are never verified, and that is correct.** `warehouse.verify`
earns a verification by re-fetching from the MLB API and re-deriving from
scratch. There is no upstream to re-fetch model output from, so any "check"
could only compare the export against itself — the exact self-certification
that made the v1 manifest worthless. Entries here carry `ingested_at` and
nothing else, and the prune's delete gate only ever asks about `pitches`.

**The day is the Eastern game date, not a UTC timestamp date.** A prediction
written at 23:30 ET belongs to that night's slate but carries the next day's
UTC date, so `predictions` is selected by joining `games.official_date` rather
than by slicing `created_at`.

    python -m warehouse export --day 2026-08-07
    python -m warehouse export --range 2026-07-20..2026-08-07 --skip-existing
"""

from __future__ import annotations

import json as _json
import os
from datetime import date, datetime, timezone

import pyarrow as pa

from warehouse import manifest
from warehouse.config import EXPORT_DATASETS, SCHEMAS, object_key
from warehouse.ingest import checksum, to_parquet

# PostgREST caps a single response (Supabase defaults to 1000 rows). A busy
# slate is ~8,000 predictions, so paging is not optional.
PAGE = 1000


def _client():
    """Service-role Supabase client. Imported lazily so the rest of the
    warehouse stays usable with no Supabase dependency installed."""
    from supabase import create_client

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_KEY")
    if not url or not key:
        raise RuntimeError(
            "SUPABASE_URL and SUPABASE_KEY (service-role) are required to "
            "export; set them in .env locally or as Actions secrets.")
    return create_client(url, key)


def _page_all(make_query) -> list[dict]:
    """Drain a PostgREST query in PAGE-sized windows.

    `make_query` is called per page because the builder is single-use.
    """
    out: list[dict] = []
    start = 0
    while True:
        rows = make_query().range(start, start + PAGE - 1).execute().data or []
        out.extend(rows)
        if len(rows) < PAGE:
            return out
        start += PAGE


# ── coercion ────────────────────────────────────────────────────────────────
#
# PostgREST hands back JSON: dates and timestamps as strings, jsonb as parsed
# dicts. PyArrow wants real date/datetime objects for its temporal types and a
# string for the json columns. Coercing explicitly (rather than letting
# from_pylist infer) is the same discipline as the declared schemas: an
# inferred column silently changes type the first day it is all-NULL.

def _as_date(v):
    if v in (None, ""):
        return None
    return date.fromisoformat(v) if isinstance(v, str) else v


def _as_ts(v):
    if v in (None, ""):
        return None
    if isinstance(v, datetime):
        dt = v
    else:
        # Postgres emits +00:00; some clients emit Z. fromisoformat handles the
        # former natively and the latter only from 3.11, so normalise.
        dt = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _as_num(v, cast):
    if v in (None, ""):
        return None
    try:
        return cast(v)
    except (TypeError, ValueError):
        return None


def _as_json(v):
    if v is None:
        return None
    # Already a string means it was stored as text, not jsonb; pass it through
    # rather than double-encoding it into a quoted string.
    return v if isinstance(v, str) else _json.dumps(v, separators=(",", ":"))


def coerce(rows: list[dict], dataset: str) -> list[dict]:
    """Shape PostgREST JSON into something `to_parquet` can type."""
    schema = SCHEMAS[dataset]
    out = []
    for r in rows:
        shaped = {}
        for f in schema:
            v = r.get(f.name)
            t = f.type
            if pa.types.is_date(t):
                shaped[f.name] = _as_date(v)
            elif pa.types.is_timestamp(t):
                shaped[f.name] = _as_ts(v)
            elif pa.types.is_floating(t):
                shaped[f.name] = _as_num(v, float)
            elif pa.types.is_integer(t):
                shaped[f.name] = _as_num(v, int)
            elif f.name in ("probs", "payload"):
                shaped[f.name] = _as_json(v)
            else:
                shaped[f.name] = None if v is None else str(v)
        out.append(shaped)
    return out


# ── fetch ───────────────────────────────────────────────────────────────────

def fetch_day(client, day: str) -> dict[str, list[dict]]:  # noqa: ANN001
    """Pull one Eastern game-day of model output. Returns {dataset: rows}."""
    games = (client.table("games").select("game_pk")
             .eq("official_date", day).execute().data or [])
    pks = [g["game_pk"] for g in games if g.get("game_pk") is not None]

    # `predictions` carries no date column at all, so the slate's game_pks are
    # the only correct way to scope it to a day. No games means no predictions
    # -- skip the query rather than fetching the whole table unfiltered, which
    # is what an empty `.in_()` would do on some client versions.
    preds = _page_all(
        lambda: client.table("predictions").select("*")
        .in_("game_pk", pks).order("id")
    ) if pks else []

    picks = _page_all(
        lambda: client.table("picks").select("*")
        .eq("pick_date", day).order("id")
    )
    gpreds = _page_all(
        lambda: client.table("game_predictions").select("*")
        .eq("official_date", day).order("game_pk")
    )

    # official_date is denormalised onto the prediction rows so the file stands
    # on its own; the join that produced it is not repeatable once Supabase has
    # pruned `games`.
    for r in preds:
        r["official_date"] = day

    return {"predictions": preds, "picks": picks, "game_predictions": gpreds}


# ── export ──────────────────────────────────────────────────────────────────

def export_day(store, day: str, *, client=None,  # noqa: ANN001
               m: dict | None = None, skip_existing: bool = False) -> dict:
    """Export one day. Returns per-dataset facts.

    Overwrites by default, deliberately. Unlike an MLB day — which is immutable
    once its games are final — an exported day legitimately changes: a
    suspended game finishes the next afternoon and its rows grade then. Re-
    running is how those late grades reach R2. `skip_existing` exists for bulk
    backfills, where re-reading days already captured is pure cost.
    """
    owns_manifest = m is None
    if m is None:
        m = manifest.load(store)

    if skip_existing and all(
        manifest.entry(m, ds, day) for ds in EXPORT_DATASETS
    ):
        return {"day": day, "written": False, "skipped": True,
                **{ds: 0 for ds in EXPORT_DATASETS}}

    if client is None:
        client = _client()
    by_dataset = fetch_day(client, day)

    now = datetime.now(timezone.utc).isoformat()
    facts: dict = {"day": day, "written": False, "skipped": False, "bytes": 0}
    for dataset in EXPORT_DATASETS:
        rows = coerce(by_dataset.get(dataset, []), dataset)
        facts[dataset] = len(rows)
        if not rows:
            # An off day, or a slate whose predictions have already aged out.
            # Writing a 0-row file would put an entry in the manifest claiming
            # the day is captured, which is worse than no entry: the next run
            # would skip it.
            continue
        blob = to_parquet(rows, dataset)
        store.put(object_key(dataset, day), blob)
        facts["bytes"] += len(blob)
        facts["written"] = True
        manifest.record(m, dataset, day, rows=len(rows), size_bytes=len(blob),
                        checksum=checksum(rows, dataset), ingested_at=now)

    if owns_manifest and facts["written"]:
        manifest.save(store, m)
    return facts
