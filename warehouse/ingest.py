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

from warehouse.store import ObjectStore
from warehouse import manifest
from warehouse.config import (
    DATASETS, KEY_COLUMNS, SCHEMAS, object_key, snapshot_key,
)
from warehouse.weather import fetch_hourly, rows_for_games
from warehouse.mlb import (
    MlbApiError, _date, fetch_game, fetch_players, fetch_venues, flatten_game,
    schedule,
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


def ingest_day(store: ObjectStore, day: str, *, with_boxscore: bool = True,
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


def ingest_range(store: ObjectStore, start: str, end: str, *, with_boxscore: bool = True,
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


def _read_dataset_day(store: ObjectStore, dataset: str, day: str) -> list[dict]:
    key = object_key(dataset, day)
    if not store.exists(key):
        return []
    return pq.read_table(io.BytesIO(store.get(key))).to_pylist()


def _venues_by_id(store: ObjectStore, season: int) -> dict[int, dict]:
    """Venue rows for `season`, falling back to the nearest season present.

    The fallback matters for a weather backfill that runs before the venue
    snapshot covers every season: a missing season would otherwise silently
    drop every game that day for want of an azimuth, and the gap would look
    like missing weather rather than a missing dimension.
    """
    key = snapshot_key("venues")
    if not store.exists(key):
        return {}
    rows = pq.read_table(io.BytesIO(store.get(key))).to_pylist()
    if not rows:
        return {}
    seasons = {r["season"] for r in rows if r.get("season") is not None}
    if not seasons:
        return {}
    use = season if season in seasons else min(
        seasons, key=lambda x: (abs(x - season), x))
    return {r["venue_id"]: r for r in rows
            if r.get("season") == use and r.get("venue_id") is not None}


def refresh_contact_quality(store: ObjectStore, *,
                            season_floor: int | None = None,
                            m: dict | None = None) -> int:
    """Rebuild the contact-quality lookup from the whole Statcast-era corpus.

    Scans every `pitches` and `at_bats` day at or after the floor, so this is
    the one build here that genuinely wants all of history rather than a
    window: the table is a physics lookup, not a form measurement, and a 2018
    ball hit at 104 mph and 26 degrees tells you the same thing a 2025 one
    does. R2 egress is free, so the scan costs time and nothing else.

    Rewritten whole each run, like the other snapshots.
    """
    from warehouse import contact, duck

    floor = contact.STATCAST_FLOOR if season_floor is None else season_floor
    m = manifest.load(store) if m is None else m
    seasons = [s for s in duck.seasons_available(store, "pitches", m=m)
               if s >= floor]
    if not seasons:
        return 0
    con = duck.connect(store)
    try:
        duck.register(con, store, names=("pitches", "at_bats"),
                      seasons=seasons, m=m)
        rows = contact.build(con, floor).to_pylist()
    finally:
        con.close()
    if not rows:
        return 0
    store.put(snapshot_key("contact_quality"),
              to_parquet(rows, "contact_quality"))
    return len(rows)


def ingest_weather_range(store: ObjectStore, start: str, end: str, *,
                         archive: bool = True,
                         m: dict | None = None) -> dict:
    """Fetch gametime weather for every game between `start` and `end`.

    One Open-Meteo request covers every venue across the WHOLE range, so a
    season costs one call rather than one per day or one per game. Rows are
    then written day-partitioned to match `games`.

    Days with no `games` file are skipped, not written empty: the weather
    dataset should never claim a day the warehouse does not hold games for.
    """
    days = daterange(start, end)
    by_day = {d: _read_dataset_day(store, "games", d) for d in days}
    by_day = {d: g for d, g in by_day.items() if g}
    if not by_day:
        return {"days": 0, "games": 0, "rows": 0, "bytes": 0,
                "reason": "no stored `games` file in range"}

    venues = _venues_by_id(store, int(start[:4]))
    if not venues:
        # Distinguished from "no games" on purpose. Weather joins to a venue's
        # latitude and longitude, so an absent venues snapshot means EVERY day
        # writes nothing -- and reporting that as "no games in range" sends
        # whoever is debugging it to look at the schedule instead of at the
        # one command that fixes it.
        return {"days": 0, "games": 0, "rows": 0, "bytes": 0,
                "reason": "no venues snapshot -- run `warehouse ingest` for "
                          "any day, or refresh_venues, before weather"}

    needed = sorted({g["venue_id"] for games in by_day.values()
                     for g in games
                     if g.get("venue_id") in venues})
    if not needed:
        return {"days": 0, "games": 0, "rows": 0, "bytes": 0,
                "reason": "no game in range plays at a venue the snapshot "
                          "knows -- check the venues season coverage"}

    points = [(venues[v]["latitude"], venues[v]["longitude"]) for v in needed]
    # Fetch ONE DAY PAST `end`. MLB keys a game to its Eastern "official date",
    # and Eastern is UTC-4/-5, so a West Coast night game on official date D
    # starts on D+1 in UTC: a 6:10pm PT first pitch is 01:10Z. Stopping the
    # window at `end` silently dropped every late game -- measured at 4 of 15
    # on 2025-07-04 (Coors, Dodger Stadium, Chase Field, Sutter Health Park),
    # which is ~27% of a slate, every slate.
    #
    # The window is NOT extended backwards, and does not need to be: the
    # earliest a game on official date D can start is midnight Eastern, which
    # is already D at 04:00Z.
    fetch_end = (date.fromisoformat(end) + timedelta(days=1)).isoformat()
    series = fetch_hourly(points, start, fetch_end, archive=archive)
    series_by_venue = dict(zip(needed, series))
    source = "open_meteo_archive" if archive else "open_meteo_forecast"

    own = m is None
    m = manifest.load(store) if own else m
    totals = {"days": 0, "games": 0, "rows": 0, "bytes": 0}
    now = datetime.now(timezone.utc).isoformat()
    for day, games in by_day.items():
        rows = rows_for_games(games, venues, series_by_venue, source=source)
        totals["games"] += len(games)
        if not rows:
            continue
        blob = to_parquet(rows, "game_weather")
        store.put(object_key("game_weather", day), blob)
        manifest.record(m, "game_weather", day, rows=len(rows),
                        size_bytes=len(blob),
                        checksum=checksum(rows, "game_weather"),
                        ingested_at=now, games=len(rows))
        totals["days"] += 1
        totals["rows"] += len(rows)
        totals["bytes"] += len(blob)
    if own:
        manifest.save(store, m)
    return totals


def refresh_venues(store: ObjectStore, seasons: list[int]) -> int:
    """Rebuild the venue snapshot for `seasons`, leaving other seasons intact.

    Deliberately NOT merge-only, which is the one way this differs from
    refresh_players. Player attributes are immutable, so a player already in
    the snapshot is never re-fetched. Venue dimensions are not: fences move,
    and a season already in the snapshot may be the season that moved them.
    Rows for the named seasons are replaced wholesale.

    A season that has ended is immutable in practice, so the nightly passes the
    current season only -- one API call. A backfill passes the full range.

    Returns the number of rows written for `seasons`.
    """
    key = snapshot_key("venues")
    existing: list[dict] = []
    if store.exists(key):
        existing = pq.read_table(io.BytesIO(store.get(key))).to_pylist()

    targets = {int(s) for s in seasons}
    kept = [r for r in existing if r.get("season") not in targets]

    fetched: list[dict] = []
    for season in sorted(targets):
        try:
            fetched.extend(fetch_venues(season))
        except MlbApiError:
            # Keep the season we already had rather than dropping it: a
            # transient failure must not silently delete history.
            kept.extend(r for r in existing if r.get("season") == season)

    if not fetched:
        return 0
    rows = sorted(kept + fetched,
                  key=lambda r: (r.get("season") or 0, r.get("venue_id") or 0))
    store.put(key, to_parquet(rows, "venues"))
    return len(fetched)


def refresh_players(store: ObjectStore, ids: list[int]) -> int:
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
