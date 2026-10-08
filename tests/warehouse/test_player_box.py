"""player_box: per-player boxscore lines, flattened and backfilled.

No network: `fetch_boxscore` is stubbed at the name warehouse.ingest binds.
"""

from __future__ import annotations

import io

import pyarrow.parquet as pq
import pytest

from warehouse import ingest, manifest
from warehouse.config import object_key
from warehouse.mlb import MlbApiError, flatten_player_box, starter_slot
from warehouse.store import LocalStore

DAY = "2026-07-04"

BOX = {
    "teams": {
        "home": {
            "team": {"id": 147},
            "players": {
                "ID1": {"person": {"id": 1}, "battingOrder": "300",
                        "stats": {"batting": {
                            "plateAppearances": 4, "atBats": 3, "hits": 2,
                            "doubles": 1, "triples": 0, "homeRuns": 1,
                            "runs": 2, "rbi": 3, "totalBases": 7,
                            "baseOnBalls": 1, "strikeOuts": 0,
                            "hitByPitch": 0},
                            "pitching": {}}},
                # On the roster, never played: no row.
                "ID2": {"person": {"id": 2},
                        "stats": {"batting": {}, "pitching": {}}},
            },
        },
        "away": {
            "team": {"id": 111},
            "players": {
                "ID9": {"person": {"id": 9},
                        "stats": {"batting": {}, "pitching": {
                            "gamesStarted": 1, "battersFaced": 25,
                            "outs": 18, "hits": 5, "baseOnBalls": 2,
                            "strikeOuts": 8, "homeRuns": 1, "runs": 3,
                            "earnedRuns": 2, "numberOfPitches": 97}}},
            },
        },
    },
}


def test_starter_slot():
    assert starter_slot("100") == 1
    assert starter_slot("900") == 9
    assert starter_slot("301") is None
    assert starter_slot(None) is None
    assert starter_slot("000") is None


def test_flatten_player_box_rows_and_nulls():
    rows = {r["player_id"]: r for r in flatten_player_box(5, None, BOX)}
    assert set(rows) == {1, 9}          # the bench player is not a row
    bat = rows[1]
    assert (bat["slot"], bat["h"], bat["r"], bat["rbi"], bat["tb"]) == (3, 2, 2, 3, 7)
    assert bat["team_id"] == 147 and bat["is_home"] is True
    # Did not pitch: the pitching block is absent, not zero.
    assert "p_bf" not in bat
    pit = rows[9]
    assert (pit["p_outs"], pit["p_er"], pit["p_started"]) == (18, 2, True)
    assert "pa" not in pit


def test_flatten_player_box_none():
    assert flatten_player_box(5, None, None) == []


@pytest.fixture
def store(tmp_path) -> LocalStore:
    s = LocalStore(tmp_path)
    blob = ingest.to_parquet([{"game_pk": 5, "game_date": None}], "games")
    s.put(object_key("games", DAY), blob)
    m = manifest.load(s)
    manifest.record(m, "games", DAY, rows=1, size_bytes=len(blob),
                    checksum="x", ingested_at="t", games=1)
    manifest.save(s, m)
    return s


def test_backfill_writes_and_records(store, monkeypatch):
    monkeypatch.setattr(ingest, "fetch_boxscore", lambda pk: BOX)
    t = ingest.ingest_player_box_range(store, [DAY])
    assert (t["days"], t["rows"], t["failed"]) == (1, 2, [])
    tbl = pq.read_table(io.BytesIO(store.get(object_key("player_box", DAY))))
    assert sorted(tbl.column("player_id").to_pylist()) == [1, 9]
    assert DAY in manifest.days(manifest.load(store), "player_box")


def test_backfill_refuses_partial_day(store, monkeypatch):
    def boom(pk):
        raise MlbApiError("503")
    monkeypatch.setattr(ingest, "fetch_boxscore", boom)
    t = ingest.ingest_player_box_range(store, [DAY])
    assert t["days"] == 0 and t["failed"]
    assert not store.exists(object_key("player_box", DAY))


def test_backfill_skips_days_without_games(store, monkeypatch):
    monkeypatch.setattr(ingest, "fetch_boxscore", lambda pk: BOX)
    t = ingest.ingest_player_box_range(store, ["2026-07-05"])
    assert t["days"] == 0 and t["failed"] == []
