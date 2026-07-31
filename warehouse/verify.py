"""Independently re-derive a stored day and reconcile it against the manifest.

The ingest writes a checksum at the same moment it writes the Parquet, from the
same in-memory rows. That catches nothing: a flattener bug corrupts both
identically. This module re-fetches the day from the MLB API, re-flattens it,
and compares against what is stored — so it can catch a bad write, a truncated
upload, or a flattener change that silently altered historical semantics.

Three comparisons per dataset:

    row count   — a truncated or partial write
    checksum    — substituted or renumbered rows at equal count
    parquet     — what is actually readable back out of the object store,
                  not merely what the manifest claims

This is the gate the hot-window prune depends on. Nothing may delete from
Postgres for a day this refuses.
"""

from __future__ import annotations

import io
from dataclasses import dataclass, field

import pyarrow.parquet as pq

from warehouse import manifest
from warehouse.config import object_key
from warehouse.ingest import checksum
from warehouse.mlb import MlbApiError, _date, fetch_game, schedule
from warehouse.mlb import flatten_game


@dataclass
class DayVerdict:
    day: str
    ok: bool
    reasons: list[str] = field(default_factory=list)
    detail: dict = field(default_factory=dict)


def verify_day(store, day: str, *, with_boxscore: bool = True,
               workers: int = 6) -> DayVerdict:
    """Re-fetch `day` from the API and reconcile against the warehouse."""
    from concurrent.futures import ThreadPoolExecutor

    reasons: list[str] = []
    m = manifest.load(store)

    games = schedule(day)
    if not games:
        # A day with no final games should have no manifest entry claiming rows.
        entry = manifest.entry(m, "pitches", day)
        if entry and entry["rows"]:
            reasons.append(
                f"API reports no final games but manifest claims "
                f"{entry['rows']} pitch rows")
        return DayVerdict(day, not reasons, reasons, {"games": 0})

    dates = {g["gamePk"]: g.get("officialDate") for g in games}

    def work(g):
        pk = g["gamePk"]
        try:
            return pk, fetch_game(pk, _date(dates.get(pk)),
                                  with_boxscore=with_boxscore)
        except MlbApiError as exc:
            return pk, {"__error__": str(exc)}

    fetched: dict[int, dict] = {}
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for pk, res in pool.map(work, games):
            if "__error__" in res:
                return DayVerdict(
                    day, False,
                    [f"re-fetch failed for game {pk}: {res['__error__'][:120]}"])
            fetched[pk] = res

    expected = {
        "pitches": [r for pk in fetched for r in fetched[pk]["pitches"]],
        "at_bats": [r for pk in fetched for r in fetched[pk]["at_bats"]],
        "games": [flatten_game(g, fetched[g["gamePk"]]["boxscore"])
                  for g in games if g["gamePk"] in fetched],
    }

    detail: dict = {}
    for dataset, rows in expected.items():
        key = object_key(dataset, day)
        entry = manifest.entry(m, dataset, day)
        want_sum = checksum(rows, dataset)

        if entry is None:
            reasons.append(f"{dataset}: no manifest entry")
            continue
        if not store.exists(key):
            reasons.append(f"{dataset}: object missing at {key}")
            continue
        if entry["rows"] != len(rows):
            reasons.append(
                f"{dataset}: manifest rows {entry['rows']} != re-derived "
                f"{len(rows)}")
        if entry.get("checksum") != want_sum:
            reasons.append(f"{dataset}: manifest checksum mismatch")

        # Read the Parquet back — the manifest can be right about bytes that
        # never made it into the object.
        try:
            stored = pq.read_table(io.BytesIO(store.get(key)))
        except Exception as exc:  # noqa: BLE001
            reasons.append(f"{dataset}: unreadable parquet ({exc})")
            continue
        if stored.num_rows != len(rows):
            reasons.append(
                f"{dataset}: parquet rows {stored.num_rows} != re-derived "
                f"{len(rows)}")
        else:
            stored_sum = checksum(stored.to_pylist(), dataset)
            if stored_sum != want_sum:
                reasons.append(f"{dataset}: parquet checksum mismatch")

        detail[dataset] = {"rows": len(rows), "parquet_rows": stored.num_rows}

    return DayVerdict(day, not reasons, reasons, detail)


def verify_sample(store, days: list[str], **kw) -> dict:
    """Verify a list of days. Returns a summary; prints as it goes."""
    out = {"checked": 0, "ok": 0, "failed": []}
    for day in days:
        v = verify_day(store, day, **kw)
        out["checked"] += 1
        if v.ok:
            out["ok"] += 1
            print(f"  ok   {day}  {v.detail.get('pitches', {}).get('rows', 0)} pitches")
        else:
            out["failed"].append({"day": day, "reasons": v.reasons})
            print(f"  FAIL {day}: {'; '.join(v.reasons)}")
    return out
