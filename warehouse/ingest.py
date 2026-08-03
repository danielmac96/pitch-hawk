"""Ingest MLB history from the Stats API into Parquet in the object store.

One Parquet file per dataset per day, partitioned season/month. Days are
independent and idempotent: re-running a day overwrites its files and its
manifest entry, so an interrupted backfill is resumed by re-running the window.

Concurrency is per-game inside a day. The MLB API is public and unauthenticated;
WORKERS is deliberately modest and warehouse.mlb.get() backs off on failure. A
26,000-game backfill that gets rate-limited and silently drops games is far
worse than one that takes an extra hour.
"""

from __future__ import annotations

import hashlib
import io
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone

import pyarrow as pa
import pyarrow.parquet as pq

from warehouse import manifest
from warehouse.config import (
    DATASETS, KEY_COLUMNS, SCHEMAS, object_key, snapshot_key,
)
from warehouse.mlb import (
    MlbApiError, _date, fetch_game, fetch_players, flatten_game, schedule,
)

WORKERS = 6


def to_parquet(rows: list[dict], dataset: str) -> bytes:
    """Serialise with the declared schema.

    The explicit schema is load-bearing: an inferred one types an all-NULL
    column as `null`, and DuckDB then refuses to read that file alongside days
    where the column has values.
    """
    schema = SCHEMAS[dataset]
    shaped = [{f.name: r.get(f.name) for f in schema} for r in rows]
    table = pa.Table.from_pylist(shaped, schema=schema)
    buf = io.BytesIO()
    pq.write_table(table, buf, compression="zstd")
    return buf.getvalue()


def checksum(rows: list[dict], dataset: str) -> str:
    """SHA-256 over sorted natural keys. Order-independent by design, so it
    catches substituted or renumbered rows that a count comparison cannot."""
    cols = KEY_COLUMNS[dataset]
    keys = sorted("|".join(str(r.get(c)) for c in cols) for r in rows)
    h = hashlib.sha256()
    for k in keys:
        h.update(k.encode("utf-8"))
        h.update(b"\n")
    return h.hexdigest()


def daterange(start: str, end: str) -> list[str]:
    first = date.fromisoformat(start)
    last = date.fromisoformat(end)
    if last < first:
        raise ValueError(f"end {end} is before start {start}")
    out, cur = [], first
    while cur <= last:
        out.append(cur.isoformat())
        cur += timedelta(days=1)
    return out


def ingest_day(store, day: str, *, with_boxscore: bool = True,
               workers: int = WORKERS, m: dict | None = None) -> dict:
    """Fetch, flatten and write one day. Returns manifest facts per dataset.

    Pass `m` to record into an in-memory manifest that the caller flushes.
    Over a multi-season backfill that turns ~2,800 read-modify-write round
    trips against a growing JSON blob into a handful.
    """
    games = schedule(day)
    if not games:
        return {"day": day, "games": 0, "pitches": 0, "at_bats": 0,
                "bytes": 0, "written": False, "player_ids": set()}

    game_dates = {g["gamePk"]: g.get("officialDate") for g in games}
    results: dict[int, dict] = {}
    errors: list[str] = []

    def work(g):
        pk = g["gamePk"]
        try:
            return pk, fetch_game(pk, _date(game_dates.get(pk)),
                                  with_boxscore=with_boxscore)
        except MlbApiError as exc:
            return pk, {"__error__": str(exc)}

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for pk, res in pool.map(work, games):
            if "__error__" in res:
                errors.append(f"{pk}: {res['__error__'][:120]}")
                continue
            results[pk] = res

    if errors:
        # A partial day would be silently wrong forever. Refuse to write it.
        raise MlbApiError(
            f"{day}: {len(errors)} of {len(games)} games failed; "
            f"day not written. First: {errors[0]}")

    pitches = [r for pk in results for r in results[pk]["pitches"]]
    at_bats = [r for pk in results for r in results[pk]["at_bats"]]
    game_rows = [flatten_game(g, results[g["gamePk"]]["boxscore"])
                 for g in games if g["gamePk"] in results]

    player_ids = {r["pitcher_id"] for r in at_bats if r["pitcher_id"]}
    player_ids |= {r["batter_id"] for r in at_bats if r["batter_id"]}

    owns_manifest = m is None
    if owns_manifest:
        m = manifest.load(store)
    now = datetime.now(timezone.utc).isoformat()
    total_bytes = 0
    for dataset, rows in (("pitches", pitches), ("at_bats", at_bats),
                          ("games", game_rows)):
        blob = to_parquet(rows, dataset)
        store.put(object_key(dataset, day), blob)
        total_bytes += len(blob)
        manifest.record(m, dataset, day, rows=len(rows), size_bytes=len(blob),
                        checksum=checksum(rows, dataset), ingested_at=now,
                        games=len(game_rows))
    if owns_manifest:
        manifest.save(store, m)

    return {"day": day, "games": len(game_rows), "pitches": len(pitches),
            "at_bats": len(at_bats), "bytes": total_bytes, "written": True,
            "player_ids": player_ids}


def ingest_range(store, start: str, end: str, *, with_boxscore: bool = True,
                 workers: int = WORKERS, skip_existing: bool = True,
                 on_day=None, flush_every: int = 25) -> dict:
    """Ingest a date window, skipping days already in the manifest.

    The manifest is flushed every `flush_every` days and on exit. A crash
    therefore loses at most that many days of index, and re-running the window
    picks them up because the Parquet writes themselves are idempotent.
    """
    m = manifest.load(store)
    done = set(manifest.days(m, "pitches"))
    days = daterange(start, end)
    todo = [d for d in days if not (skip_existing and d in done)]

    totals = {"days": 0, "skipped": len(days) - len(todo), "games": 0,
              "pitches": 0, "at_bats": 0, "bytes": 0, "empty_days": 0,
              "failed": []}
    players: set[int] = set()

    for i, day in enumerate(todo, 1):
        try:
            res = ingest_day(store, day, with_boxscore=with_boxscore,
                             workers=workers, m=m)
        except MlbApiError as exc:
            totals["failed"].append(str(exc)[:200])
            if on_day:
                on_day(day, None, str(exc)[:120])
            continue
        if i % flush_every == 0:
            manifest.save(store, m)
        if not res["written"]:
            totals["empty_days"] += 1
        else:
            totals["days"] += 1
            totals["games"] += res["games"]
            totals["pitches"] += res["pitches"]
            totals["at_bats"] += res["at_bats"]
            totals["bytes"] += res["bytes"]
            players |= res["player_ids"]
        if on_day:
            on_day(day, res, None)

    manifest.save(store, m)
    totals["player_ids"] = players
    return totals


def refresh_players(store, ids: list[int]) -> int:
    """Merge any unseen player ids into the players snapshot.

    Merge-only: a player already in the snapshot is never re-fetched. The
    stored fields (name, handedness, position, debut, birth date) are
    effectively immutable, so the cost of a nightly call is one API request
    per 100 genuinely new players -- usually zero, occasionally a callup.

    Returns the number of players added. Writes nothing when nothing was
    added: the snapshot is rewritten whole, so an unconditional write meant
    ~90 KB of pointless upload on every ingest of every day of a 2,000-day
    backfill.
    """
    existing: list[dict] = []
    key = snapshot_key("players")
    exists = store.exists(key)
    if exists:
        existing = pq.read_table(io.BytesIO(store.get(key))).to_pylist()
    have = {r["player_id"] for r in existing}
    missing = [i for i in ids if i and i not in have]
    fetched = fetch_players(missing) if missing else []
    if not fetched and exists:
        return 0
    store.put(key, to_parquet(existing + fetched, "players"))
    return len(fetched)
