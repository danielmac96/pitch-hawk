"""Round-trip tests for the warehouse ingest, manifest and Parquet layer.

Everything here runs against `LocalStore(tmp_path)` with `warehouse.mlb.schedule`
and `fetch_game` stubbed from `tests/fixtures/playbyplay_sample.json` — no
credentials, no network, no MLB API traffic. That is what LocalStore exists for.

Two of these are regression tests for the defect Phase 1 fixed, and are the
reason `requirements-warehouse.txt` had to exist before they could be written:

    test_is_verified_requires_independent_write
    test_reingest_clears_verification

Until 2026-08-02 `manifest.record()` wrote `verified_at` itself, so
`is_verified()` returned True for all 2,011 stored days while genuine
independent coverage was five. The hot-window prune gates deletion on exactly
that field. Do not delete these.
"""

from __future__ import annotations

import io
import json
import random
from datetime import date
from pathlib import Path

import pyarrow.parquet as pq
import pytest

from warehouse import ingest, manifest
from warehouse.config import PITCH_SCHEMA, object_key
from warehouse.mlb import MlbApiError, flatten_play_by_play
from warehouse.store import LocalStore

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "playbyplay_sample.json"

DAY = "2026-07-04"
GAME_PKS = (778001, 778002)


@pytest.fixture(scope="module")
def pbp() -> dict:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


@pytest.fixture
def store(tmp_path) -> LocalStore:
    return LocalStore(tmp_path)


@pytest.fixture
def stub_api(monkeypatch, pbp):
    """Stub the MLB API at the names `warehouse.ingest` actually calls.

    ingest.py does `from warehouse.mlb import fetch_game, schedule`, so those
    names are bound in the ingest module — patching `warehouse.mlb.fetch_game`
    would have no effect on it.

    Returns a dict the test can mutate: `fail` marks game_pks that should raise,
    and `calls` records every fetch so idempotency can be asserted on API
    traffic rather than only on the manifest.
    """
    state = {"fail": set(), "calls": []}

    def fake_schedule(day, game_type="R"):
        # Days outside the fixture's window are legitimately empty, which is
        # what the All-Star break and every off-day look like.
        if day != DAY:
            return []
        return [
            {"gamePk": pk, "officialDate": day, "gameType": "R",
             "season": "2026",
             "status": {"detailedState": "Final"},
             "venue": {"id": 3313, "name": "Fenway Park"},
             "teams": {
                 "home": {"score": 4, "team": {"id": 111, "name": "Boston Red Sox",
                                               "abbreviation": "BOS"}},
                 "away": {"score": 2, "team": {"id": 147, "name": "New York Yankees",
                                               "abbreviation": "NYY"}},
             }}
            for pk in GAME_PKS
        ]

    def fake_fetch_game(game_pk, game_date, *, with_boxscore=True):
        state["calls"].append(game_pk)
        if game_pk in state["fail"]:
            raise MlbApiError(f"{game_pk}: simulated upstream 503")
        pitches, at_bats = flatten_play_by_play(game_pk, game_date, pbp)
        return {"pitches": pitches, "at_bats": at_bats, "boxscore": None}

    monkeypatch.setattr(ingest, "schedule", fake_schedule)
    monkeypatch.setattr(ingest, "fetch_game", fake_fetch_game)
    return state


@pytest.fixture
def pitch_rows(pbp) -> list[dict]:
    rows, _ = flatten_play_by_play(GAME_PKS[0], date.fromisoformat(DAY), pbp)
    return rows


# ── Parquet round trip ──────────────────────────────────────────────────────

def test_parquet_roundtrip_preserves_schema(store, stub_api):
    """The declared schema must survive the write, all-NULL columns included.

    This is the invariant the whole warehouse rests on: an inferred schema
    types an all-NULL column as `null`, and DuckDB then refuses to read that
    day alongside days where the column has values. One bad day poisons a
    multi-season query.
    """
    ingest.ingest_day(store, DAY)
    table = pq.read_table(io.BytesIO(store.get(object_key("pitches", DAY))))

    assert table.schema.equals(PITCH_SCHEMA)

    # The fixture carries no hitData, so the batted-ball block is entirely
    # NULL — exactly the case inference gets wrong.
    for col in ("launch_speed", "launch_angle", "total_distance",
                "hit_coord_x", "hit_coord_y"):
        assert table.column(col).null_count == table.num_rows
        assert table.schema.field(col).type == PITCH_SCHEMA.field(col).type
    assert table.column("trajectory").null_count == table.num_rows
    assert table.schema.field("trajectory").type == PITCH_SCHEMA.field(
        "trajectory").type

    # And the populated columns still carry their values, both games' worth.
    assert table.num_rows == 12
    assert set(table.column("game_pk").to_pylist()) == set(GAME_PKS)
    assert table.column("start_speed").to_pylist()[0] == 97.4


# ── checksum ────────────────────────────────────────────────────────────────

def test_checksum_is_order_independent(pitch_rows):
    """Sorted natural keys, so a reordered fetch is not a false alarm. Games
    within a day arrive from a thread pool in nondeterministic order."""
    shuffled = list(pitch_rows)
    rng = random.Random(20260802)
    rng.shuffle(shuffled)

    assert shuffled != pitch_rows  # the shuffle actually did something
    assert ingest.checksum(shuffled, "pitches") == ingest.checksum(
        pitch_rows, "pitches")


def test_checksum_catches_renumbered_rows(pitch_rows):
    """The reason a row count is not enough: substituted or renumbered rows
    keep the count identical and change nothing the manifest otherwise sees."""
    before = ingest.checksum(pitch_rows, "pitches")

    tampered = [dict(r) for r in pitch_rows]
    tampered[1]["pitch_number"] = 99

    assert len(tampered) == len(pitch_rows)
    assert ingest.checksum(tampered, "pitches") != before


# ── all-or-nothing days ─────────────────────────────────────────────────────

def test_partial_day_is_not_written(store, stub_api):
    """A partial day is silently wrong forever and its manifest entry claims
    completeness. One failed game must abort the whole day."""
    stub_api["fail"].add(GAME_PKS[1])

    with pytest.raises(MlbApiError, match="1 of 2 games failed"):
        ingest.ingest_day(store, DAY)

    assert not store.exists(object_key("pitches", DAY))
    assert not store.exists(object_key("at_bats", DAY))
    assert not store.exists(object_key("games", DAY))
    # No manifest at all: nothing was written, so nothing was indexed.
    m = manifest.load(store)
    assert manifest.days(m, "pitches") == []


# ── the Phase 1 regression tests ────────────────────────────────────────────

def test_is_verified_requires_independent_write(store, stub_api):
    """An ingest-only entry is NOT verified, however complete it looks.

    `record()` derives its checksum from the same in-memory rows that produced
    the Parquet, so a flattener bug corrupts both identically. Only
    warehouse.verify, which re-fetches from the MLB API, may open the gate.
    """
    ingest.ingest_day(store, DAY)
    m = manifest.load(store)

    entry = manifest.entry(m, "pitches", DAY)
    assert entry["checksum"]                      # it has one
    assert entry["ingested_at"]                   # and a timestamp
    assert entry["verified_at"] is None           # but neither is verification
    assert entry["verified_by"] is None

    assert manifest.is_ingested(m, "pitches", DAY) is True
    assert manifest.is_verified(m, "pitches", DAY) is False
    assert DAY in manifest.unverified_days(m, "pitches")
    assert DAY not in manifest.verified_days(m, "pitches")


def test_reingest_clears_verification(store, stub_api):
    """A re-ingest rewrites the bytes, so any prior verification no longer
    describes what is stored. It must not survive into the new entry."""
    ingest.ingest_day(store, DAY)
    m = manifest.load(store)
    manifest.record_verified(m, "pitches", DAY,
                             verified_at="2026-08-02T00:00:00+00:00",
                             verified_by="verify_day/v2")
    manifest.save(store, m)
    assert manifest.is_verified(manifest.load(store), "pitches", DAY)

    ingest.ingest_day(store, DAY)  # re-ingest the same day

    m = manifest.load(store)
    entry = manifest.entry(m, "pitches", DAY)
    assert entry["verified_at"] is None
    assert entry["verified_by"] is None
    assert manifest.is_verified(m, "pitches", DAY) is False


def test_record_verified_refuses_a_day_with_no_entry(store):
    """Verifying a day the warehouse does not claim to hold is a caller bug,
    not a day to quietly vouch for."""
    m = manifest.empty()
    with pytest.raises(KeyError):
        manifest.record_verified(m, "pitches", DAY,
                                 verified_at="2026-08-02T00:00:00+00:00",
                                 verified_by="verify_day/v2")


# ── idempotency ─────────────────────────────────────────────────────────────

def test_ingest_range_is_idempotent(store, stub_api):
    """Re-running a window must skip days already in the manifest — that is
    what makes an interrupted 2,000-day backfill resumable rather than a
    restart."""
    first = ingest.ingest_range(store, "2026-07-03", "2026-07-05")
    assert first["days"] == 1          # only DAY has games
    assert first["empty_days"] == 2
    assert first["skipped"] == 0
    assert first["failed"] == []
    calls_after_first = len(stub_api["calls"])
    assert calls_after_first == len(GAME_PKS)

    second = ingest.ingest_range(store, "2026-07-03", "2026-07-05")
    assert second["days"] == 0
    assert second["skipped"] == 1      # the one day with a manifest entry
    # Empty days have no manifest entry, so they are re-checked against the
    # schedule — but the day with games costs no further API traffic.
    assert len(stub_api["calls"]) == calls_after_first


def test_ingest_range_reports_a_failed_day_without_aborting_the_window(
        store, stub_api):
    """A day the API refuses is recorded and the window continues. The day is
    simply absent from the manifest, so a later run picks it up."""
    stub_api["fail"].add(GAME_PKS[0])

    res = ingest.ingest_range(store, "2026-07-03", "2026-07-05")

    assert res["days"] == 0
    assert len(res["failed"]) == 1
    assert DAY in res["failed"][0]
    assert manifest.days(manifest.load(store), "pitches") == []
