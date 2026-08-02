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
from datetime import datetime, timezone

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


VERIFIER = "verify_day/v2"


def verify_day(store, day: str, *, with_boxscore: bool = True,
               workers: int = 6, record: bool = False,
               m: dict | None = None) -> DayVerdict:
    """Re-fetch `day` from the API and reconcile against the warehouse.

    `record=True` writes verified_at/verified_by on success — this is the only
    place in the codebase permitted to do that, because it is the only place
    that re-derives the day from the upstream API rather than from the rows
    that produced the Parquet.

    Pass `m` to verify into a caller-owned manifest that the caller flushes.
    The manifest is 1.47 MB; N read-modify-write round trips against it over a
    340-day range is the same mistake `ingest_range` exists to avoid.
    """
    from concurrent.futures import ThreadPoolExecutor

    reasons: list[str] = []
    owns_manifest = m is None
    if owns_manifest:
        m = manifest.load(store)

    games = schedule(day)
    if not games:
        # A day with no final games should have no manifest entry claiming
        # rows. Legitimately empty days are common: the All-Star break is 3-4
        # of them every July, and the warehouse filters game_type="R" so the
        # All-Star Game itself is correctly absent.
        entry = manifest.entry(m, "pitches", day)
        if entry and entry["rows"]:
            reasons.append(
                f"API reports no final games but manifest claims "
                f"{entry['rows']} pitch rows")
        # Nothing to stamp: there is no entry to verify. Flagged so the CLI can
        # report "empty" rather than counting it as verified coverage.
        return DayVerdict(day, not reasons, reasons,
                          {"games": 0, "empty": True})

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

    if record and not reasons:
        _mark_verified(m, day)
        if owns_manifest:
            manifest.save(store, m)

    return DayVerdict(day, not reasons, reasons, detail)


def _mark_verified(m: dict, day: str) -> None:
    """Stamp all three datasets for a day. Verification is per-day, not
    per-dataset: verify_day passes or fails as a unit, and the prune deletes a
    day's pitches and at_bats together."""
    now = datetime.now(timezone.utc).isoformat()
    for dataset in ("pitches", "at_bats", "games"):
        manifest.record_verified(m, dataset, day,
                                 verified_at=now, verified_by=VERIFIER)


def verify_sample(store, days: list[str], *, record: bool = False,
                  fail_fast: bool = False, flush_every: int = 25,
                  on_day=None, **kw) -> dict:
    """Verify a list of days. Returns a summary; prints as it goes.

    The manifest write is batched: one load, N record_verified, periodic save.
    Read-modify-writing a 1.47 MB object once per day over a 340-day range
    would be ~500 MB of needless round trips and would leave the manifest
    rewritten 340 times, each one a chance to lose the file.
    """
    out = {"checked": 0, "ok": 0, "empty": 0, "verified": 0, "failed": []}
    m = manifest.load(store) if record else None
    dirty = False

    try:
        for i, day in enumerate(days, 1):
            v = verify_day(store, day, record=False, m=m, **kw)
            out["checked"] += 1
            if not v.ok:
                out["failed"].append({"day": day, "reasons": v.reasons})
                print(f"  FAIL {day}: {'; '.join(v.reasons)}", flush=True)
                if on_day:
                    on_day(day, v)
                if fail_fast:
                    break
                continue

            out["ok"] += 1
            if v.detail.get("empty"):
                out["empty"] += 1
                print(f"  --   {day}  no final games", flush=True)
            else:
                if record:
                    _mark_verified(m, day)
                    out["verified"] += 1
                    dirty = True
                n = v.detail.get("pitches", {}).get("rows", 0)
                print(f"  ok   {day}  {n:,} pitches", flush=True)
            if on_day:
                on_day(day, v)

            if record and dirty and i % flush_every == 0:
                manifest.save(store, m)
                dirty = False
    finally:
        # Persist what was earned even if the run is interrupted: re-verifying
        # 300 already-good days because of a Ctrl-C at day 320 is 15 wasted
        # minutes of MLB API traffic.
        if record and dirty:
            manifest.save(store, m)

    return out
