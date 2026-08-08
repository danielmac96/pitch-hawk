"""Tests for the Supabase -> R2 export of model output.

Everything here runs against `LocalStore(tmp_path)` with a fake Supabase
client — no credentials, no network.

The load-bearing test in this file is
`test_export_datasets_are_never_verifiable`. `warehouse.verify` earns a day its
manifest verification by re-fetching it from the MLB API and re-deriving it
from scratch, and the hot-window prune gates deletion on that field. Model
output has no upstream to re-fetch, so it must never be able to satisfy the
gate however complete its manifest entry looks. That is the same class of
defect as the v1 manifest's self-certification.
"""

from __future__ import annotations

import json
from datetime import date, datetime, timezone

import pyarrow.parquet as pq
import pytest

from warehouse import export, manifest
from warehouse.config import (
    DATASETS, DAY_PARTITIONED, EXPORT_DATASETS, KEY_COLUMNS, SCHEMAS,
    object_key,
)
from warehouse.store import LocalStore

DAY = "2026-08-06"


class FakeQuery:
    """Just enough of the PostgREST builder for export.fetch_day."""

    def __init__(self, rows):
        self._rows = rows

    def select(self, *_a, **_k):
        return self

    def eq(self, *_a, **_k):
        return self

    def in_(self, *_a, **_k):
        return self

    def order(self, *_a, **_k):
        return self

    def range(self, start, end):
        self._slice = (start, end)
        return self

    def execute(self):
        start, end = getattr(self, "_slice", (0, len(self._rows)))
        return type("Res", (), {"data": self._rows[start:end + 1]})()


class FakeClient:
    def __init__(self, tables):
        self.tables = tables

    def table(self, name):
        return FakeQuery(self.tables.get(name, []))


def _rows():
    """One of each, shaped the way PostgREST actually hands them back:
    dates and timestamps as strings, jsonb as parsed dicts."""
    return {
        "games": [{"game_pk": 1}, {"game_pk": 2}],
        "predictions": [{
            "id": 10, "game_pk": 1, "at_bat_index": 3, "pitch_number": 2,
            "market": "pitch_result", "predicted_value": 1.5,
            "confidence": 0.61, "probs": {"ball": 0.4, "strike": 0.6},
            "recommendation": "strike", "line": None, "price": -110,
            "edge": 0.02, "units": 1, "result": "win", "profit_units": 0.91,
            "graded_at": "2026-08-06T23:10:00+00:00",
            "model_version": "v1_20260707",
            "created_at": "2026-08-06T23:05:00+00:00", "book": None,
        }],
        "picks": [{
            "id": 5, "pick_date": DAY, "game_pk": 1, "at_bat_index": 3,
            "market": "ab_result", "recommendation": "hit", "label": "Hit",
            "line": None, "price": None, "confidence": 0.55, "edge": None,
            "units": 1, "book": None, "source": "model",
            "model_version": "v1_20260707", "status": "win",
            "profit_units": 1.0, "payload": {"bullets": []},
            "created_at": "2026-08-06T18:00:00+00:00",
            "graded_at": "2026-08-06T21:00:00+00:00",
        }],
        "game_predictions": [{
            "game_pk": 1, "official_date": DAY, "market": "game_total",
            "phase": "pregame", "predicted_value": 8.5, "probs": None,
            "recommendation": "over", "confidence": 0.53, "line": 8.5,
            "price": -105, "edge": 0.01, "book": None,
            "model_version": "total_v1", "home_team_id": 111,
            "away_team_id": 147, "home_abbr": "BOS", "away_abbr": "NYY",
            "home_pitcher_id": 600, "away_pitcher_id": 601,
            "actual_value": 9.0, "result": "win", "profit_units": 0.95,
            "graded_at": "2026-08-07T02:00:00+00:00",
            "n_pitch_predictions": 40,
            "scored_at": "2026-08-06T14:00:00+00:00",
            "updated_at": "2026-08-07T02:00:00+00:00",
        }],
    }


def test_export_writes_one_file_per_dataset(tmp_path):
    store = LocalStore(tmp_path)
    res = export.export_day(store, DAY, client=FakeClient(_rows()))

    assert res["written"] is True
    for ds in EXPORT_DATASETS:
        assert res[ds] == 1
        assert store.exists(object_key(ds, DAY)), f"{ds} not written"


def test_parquet_matches_the_declared_schema(tmp_path):
    """An inferred schema types an all-NULL column as `null`, and DuckDB then
    refuses to read that day alongside days where the column has values."""
    store = LocalStore(tmp_path)
    export.export_day(store, DAY, client=FakeClient(_rows()))

    for ds in EXPORT_DATASETS:
        # ParquetFile.schema_arrow, not read_table().schema: reading through
        # the dataset API discovers the season=/month= Hive partitioning from
        # the parent directories and appends both as dictionary columns. That
        # is correct and desirable at read time -- it is how the MLB datasets
        # behave too -- but it is not what was written to the file.
        written = pq.ParquetFile(tmp_path / object_key(ds, DAY)).schema_arrow
        assert written.equals(SCHEMAS[ds], check_metadata=False), ds


def test_predictions_carry_the_eastern_game_date_not_the_utc_created_date(tmp_path):
    """A prediction written at 23:05 ET is stored at 03:05 UTC the NEXT day.

    Dating the export off `created_at` would file it under the wrong slate.
    `official_date` comes from the game, so it does not.
    """
    rows = _rows()
    rows["predictions"][0]["created_at"] = "2026-08-07T03:05:00+00:00"
    store = LocalStore(tmp_path)
    export.export_day(store, DAY, client=FakeClient(rows))

    table = pq.read_table(tmp_path / object_key("predictions", DAY))
    assert table.column("official_date").to_pylist() == [date(2026, 8, 6)]
    assert table.column("created_at").to_pylist()[0] == \
        datetime(2026, 8, 7, 3, 5, tzinfo=timezone.utc)


def test_jsonb_columns_round_trip_as_json_text(tmp_path):
    store = LocalStore(tmp_path)
    export.export_day(store, DAY, client=FakeClient(_rows()))

    probs = pq.read_table(tmp_path / object_key("predictions", DAY)) \
        .column("probs").to_pylist()[0]
    assert json.loads(probs) == {"ball": 0.4, "strike": 0.6}

    payload = pq.read_table(tmp_path / object_key("picks", DAY)) \
        .column("payload").to_pylist()[0]
    assert json.loads(payload) == {"bullets": []}


def test_a_string_jsonb_value_is_not_double_encoded(tmp_path):
    """Some columns are text, not jsonb. Re-encoding those would wrap them in
    quotes and change the value."""
    assert export._as_json('{"a":1}') == '{"a":1}'
    assert export._as_json(None) is None


def test_empty_day_writes_nothing_and_records_nothing(tmp_path):
    """A 0-row file would put an entry in the manifest claiming the day is
    captured, and the next run would skip it."""
    store = LocalStore(tmp_path)
    empty = {"games": [], "predictions": [], "picks": [], "game_predictions": []}
    res = export.export_day(store, DAY, client=FakeClient(empty))

    assert res["written"] is False
    m = manifest.load(store)
    for ds in EXPORT_DATASETS:
        assert manifest.entry(m, ds, DAY) is None
        assert not store.exists(object_key(ds, DAY))


def test_export_datasets_are_never_verifiable(tmp_path):
    """The prune's delete gate must be unreachable for model output.

    There is no upstream to re-derive these from, so a verification could only
    ever compare them against themselves.
    """
    store = LocalStore(tmp_path)
    export.export_day(store, DAY, client=FakeClient(_rows()))
    m = manifest.load(store)

    for ds in EXPORT_DATASETS:
        entry = manifest.entry(m, ds, DAY)
        assert entry is not None, f"{ds} should be recorded as ingested"
        assert entry["verified_at"] is None
        assert entry["verified_by"] is None
        assert manifest.is_ingested(m, ds, DAY) is True
        assert manifest.is_verified(m, ds, DAY) is False


def test_exports_are_disjoint_from_the_mlb_datasets():
    """verify.py and the prune gate iterate DATASETS. If an export leaked into
    that tuple, verify would try to re-fetch our own model output from the MLB
    API."""
    assert set(DATASETS).isdisjoint(EXPORT_DATASETS)
    assert set(DAY_PARTITIONED) == set(DATASETS) | set(EXPORT_DATASETS)
    for ds in EXPORT_DATASETS:
        assert ds in SCHEMAS
        assert ds in KEY_COLUMNS


def test_object_keys_share_the_hive_layout():
    """DuckDB joins a prediction to the pitch it was made against, so both
    sides need the same partitioning."""
    assert object_key("predictions", DAY) == \
        "predictions/season=2026/month=08/day=2026-08-06.parquet"
    with pytest.raises(ValueError, match="unknown dataset"):
        object_key("not_a_dataset", DAY)


def test_skip_existing_only_skips_when_every_dataset_is_present(tmp_path):
    store = LocalStore(tmp_path)
    export.export_day(store, DAY, client=FakeClient(_rows()))

    res = export.export_day(store, DAY, client=FakeClient(_rows()),
                            skip_existing=True)
    assert res["skipped"] is True

    # Default is overwrite: a suspended game grades the next afternoon, and
    # re-exporting is how that reaches R2.
    res = export.export_day(store, DAY, client=FakeClient(_rows()))
    assert res["skipped"] is False
    assert res["written"] is True


def test_paging_drains_more_than_one_page(tmp_path, monkeypatch):
    """A busy slate is ~8,000 predictions against a 1,000-row PostgREST cap."""
    monkeypatch.setattr(export, "PAGE", 2)
    rows = _rows()
    base = rows["predictions"][0]
    rows["predictions"] = [{**base, "id": i} for i in range(5)]

    store = LocalStore(tmp_path)
    res = export.export_day(store, DAY, client=FakeClient(rows))
    assert res["predictions"] == 5
