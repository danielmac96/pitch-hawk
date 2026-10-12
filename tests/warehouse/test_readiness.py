"""Tests for the per-season readiness report (warehouse/readiness.py).

The report is the exit gate for a backfill, so what matters is that each way
a season can be incomplete produces its own reason, and that column fill is
read correctly from files that predate a column entirely.
"""

from __future__ import annotations

from datetime import date

import pytest

from warehouse import manifest, readiness
from warehouse.config import PITCH_SCHEMA, object_key
from warehouse.ingest import checksum, to_parquet
from warehouse.store import LocalStore


def _pitch(i: int, **over) -> dict:
    row = {f.name: None for f in PITCH_SCHEMA}
    row.update({"game_pk": 1, "at_bat_index": i, "pitch_number": 1,
                "game_date": date(2025, 7, 1), "start_speed": 95.0,
                "release_pos_x": -1.9, "pfx_x": -5.0, "outs": i % 3})
    row.update(over)
    return row


def _write(store, m, day, rows, *, verified=False, drop=()):
    import io

    import pyarrow.parquet as pq

    blob = to_parquet(rows, "pitches")
    if drop:  # a file written before these columns existed
        t = pq.read_table(io.BytesIO(blob)).drop_columns(list(drop))
        buf = io.BytesIO()
        pq.write_table(t, buf)
        blob = buf.getvalue()
    store.put(object_key("pitches", day), blob)
    manifest.record(m, "pitches", day, rows=len(rows), size_bytes=len(blob),
                    checksum=checksum(rows, "pitches"),
                    ingested_at="2026-10-12T00:00:00+00:00", games=1)
    if verified:
        manifest.record_verified(
            m, "pitches", day, verified_by="test",
            verified_at="2026-10-12T00:00:00+00:00")


@pytest.fixture
def store(tmp_path) -> LocalStore:
    return LocalStore(tmp_path)


def test_fill_counts_a_column_the_file_predates_as_empty(store):
    m = manifest.empty()
    _write(store, m, "2025-07-01", [_pitch(i) for i in range(10)])
    _write(store, m, "2025-07-02", [_pitch(i) for i in range(10)],
           drop=("release_pos_x", "pfx_x"))
    f = readiness.pitch_fill(store, m, 2025)
    assert f["rows"] == 20 and f["start_speed"] == 1.0
    assert f["release_pos_x"] == 0.5 and f["pfx_x"] == 0.5
    assert f["launch_speed"] == 0.0 and f["max_outs"] == 2


def test_each_gap_gets_its_own_reason(store):
    m = manifest.empty()
    _write(store, m, "2025-07-01", [_pitch(i) for i in range(10)], verified=True)
    _write(store, m, "2025-07-02", [_pitch(i, outs=3, release_pos_x=None)
                                    for i in range(10)])
    rep = readiness.build(store, m=m)
    (v,) = rep["verdict"]
    assert not v["ready"]
    assert v["why"] == ("1 pitch-days unverified; pitch physics not filled; "
                        "outs out of range; player_box days missing")


def test_a_complete_season_is_ready(store):
    m = manifest.empty()
    _write(store, m, "2025-07-01", [_pitch(i) for i in range(10)], verified=True)
    manifest.record(m, "player_box", "2025-07-01", rows=5, size_bytes=1,
                    checksum="x", ingested_at="2026-10-12T00:00:00+00:00",
                    games=1)
    rep = readiness.build(store, m=m)
    assert rep["verdict"] == [{"season": 2025, "ready": True, "why": ""}]
    md = readiness.to_markdown(rep)
    assert "| 2025 | 1 | 1 | 10 |" in md and md.rstrip().count("yes") == 1
    assert "`player_box` | 2025-2025 | 1 | 5 | 0 |" in md


def test_seasons_filter_limits_the_scan(store):
    m = manifest.empty()
    _write(store, m, "2024-07-01", [_pitch(i) for i in range(4)])
    _write(store, m, "2025-07-01", [_pitch(i) for i in range(4)])
    rep = readiness.build(store, seasons=[2024], m=m)
    assert [f["season"] for f in rep["pitch_fill"]] == [2024]
