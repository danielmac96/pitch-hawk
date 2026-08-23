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

import inspect
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
    """Just enough of the PostgREST builder for export.fetch_day.

    `eq` and `gt` really filter and `order`/`limit`/`range` really slice, so a
    test can observe HOW the export asks for its rows and not just what it gets
    back. That is the point: the nightly died on a query shape that returned
    perfectly correct rows.
    """

    def __init__(self, rows, log=None, table=None):
        self._rows = list(rows)
        self._log = log if log is not None else []
        self._table = table
        self._order = None
        self._limit = None
        self._slice = None
        self._filters: list[tuple] = []

    def select(self, *_a, **_k):
        return self

    def eq(self, col, val):
        self._filters.append(("eq", col, val))
        self._rows = [r for r in self._rows if r.get(col) == val]
        return self

    def in_(self, col, vals):
        self._filters.append(("in", col, list(vals)))
        self._rows = [r for r in self._rows if r.get(col) in set(vals)]
        return self

    def gt(self, col, val):
        self._filters.append(("gt", col, val))
        self._rows = [r for r in self._rows if r.get(col) > val]
        return self

    def order(self, col, *_a, **_k):
        self._order = col
        return self

    def limit(self, n):
        self._limit = n
        return self

    def range(self, start, end):
        self._slice = (start, end)
        return self

    def execute(self):
        rows = self._rows
        if self._order is not None:
            rows = sorted(rows, key=lambda r: r[self._order])
        if self._slice is not None:
            start, end = self._slice
            rows = rows[start:end + 1]
        if self._limit is not None:
            rows = rows[:self._limit]
        self._log.append({"table": self._table, "filters": self._filters,
                          "order": self._order, "limit": self._limit,
                          "range": self._slice, "returned": len(rows)})
        return type("Res", (), {"data": rows})()


class FakeClient:
    def __init__(self, tables):
        self.tables = tables
        self.log: list[dict] = []

    def table(self, name):
        return FakeQuery(self.tables.get(name, []), log=self.log, table=name)

    def queries(self, table):
        return [q for q in self.log if q["table"] == table]


def _rows():
    """One of each, shaped the way PostgREST actually hands them back:
    dates and timestamps as strings, jsonb as parsed dicts."""
    return {
        "games": [{"game_pk": 1, "official_date": DAY},
                  {"game_pk": 2, "official_date": DAY}],
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
    """A full slate is ~19,000 predictions against a 1,000-row PostgREST cap."""
    monkeypatch.setattr(export, "PAGE", 2)
    rows = _rows()
    base = rows["predictions"][0]
    rows["predictions"] = [{**base, "id": i} for i in range(5)]

    store = LocalStore(tmp_path)
    res = export.export_day(store, DAY, client=FakeClient(rows))
    assert res["predictions"] == 5


def test_predictions_page_by_keyset_not_offset(monkeypatch):
    """Under LIMIT/OFFSET, Postgres re-scans and re-sorts the whole day for
    every page and discards all but the window. Draining ~19 pages that way is
    what blew the 8-second statement timeout the nightly runs under.

    Keyset paging carries the last id forward instead, so page N costs what
    page 1 costs.
    """
    monkeypatch.setattr(export, "PAGE", 2)
    rows = _rows()
    base = rows["predictions"][0]
    rows["predictions"] = [{**base, "id": i, "game_pk": 1} for i in range(5)]

    client = FakeClient(rows)
    export.fetch_day(client, DAY)

    pages = client.queries("predictions")
    assert len(pages) > 1, "the fixture should need more than one page"
    assert all(p["range"] is None for p in pages), \
        "range() is LIMIT/OFFSET -- the shape that timed out"
    assert all(p["limit"] == 2 for p in pages)
    # Every page after the first advances past the previous page's last id.
    assert [f for p in pages[1:] for f in p["filters"] if f[0] == "gt"] == \
        [("gt", "id", 1), ("gt", "id", 3)]


def test_predictions_are_fetched_one_game_at_a_time():
    """A slate-wide `.in_(game_pk, pks)` makes every page scan and sort all
    ~19,000 of the day's predictions. Per game it is ~1,300 rows off an index.

    The bound matters more than the constant: a game holds only so many plate
    appearances, while the slate total has already doubled once and broke this
    job when it did.
    """
    rows = _rows()
    base = rows["predictions"][0]
    rows["predictions"] = [{**base, "id": 10, "game_pk": 1},
                           {**base, "id": 11, "game_pk": 2}]

    client = FakeClient(rows)
    out = export.fetch_day(client, DAY)

    pages = client.queries("predictions")
    assert len(pages) == 2, "one query per game_pk on the slate"
    assert [f for p in pages for f in p["filters"] if f[0] == "in"] == [], \
        "the slate-wide IN filter is the shape that timed out"
    assert sorted(f[2] for p in pages for f in p["filters"]
                  if f[0] == "eq" and f[1] == "game_pk") == [1, 2]
    # Scoping per game must not change the rows, nor their global id order.
    assert [r["id"] for r in out["predictions"]] == [10, 11]


def test_no_games_means_no_predictions_query_at_all():
    """An empty `.in_()` fetches the whole table unfiltered on some client
    versions. The per-game loop simply does not run."""
    rows = _rows()
    rows["games"] = []

    client = FakeClient(rows)
    out = export.fetch_day(client, DAY)

    assert out["predictions"] == []
    assert client.queries("predictions") == []


def test_game_predictions_do_not_use_keyset_paging():
    """Its PK is (game_pk, market, phase), so `game_pk` repeats. Keyset paging
    on a non-unique column silently drops every row after the first of each
    group -- offset paging is correct here, and 165 rows a day is one page."""
    rows = _rows()
    base = rows["game_predictions"][0]
    rows["game_predictions"] = [
        {**base, "market": "game_total"},
        {**base, "market": "run_line"},
        {**base, "market": "moneyline"},
    ]

    client = FakeClient(rows)
    out = export.fetch_day(client, DAY)

    assert len(out["game_predictions"]) == 3
    assert all(f[0] != "gt" for q in client.queries("game_predictions")
               for f in q["filters"])


class StubAPIError(Exception):
    """Stands in for `postgrest.exceptions.APIError`, which CI does not install.

    The retry matches on `.code` rather than on the exception class precisely so
    that `warehouse.export` needs no Supabase dependency;
    `test_a_real_postgrest_api_error_carries_a_code` pins that the real class
    does carry the attribute this relies on.
    """

    def __init__(self, code, message=""):
        super().__init__(message)
        self.code = code
        self.message = message


def test_a_page_is_retried_on_a_statement_timeout(monkeypatch):
    """The export shares its instance with the nightly publish job and a
    15-second pg_cron, so a page can lose a cache race it would win on a
    retry."""
    monkeypatch.setattr(export.time, "sleep", lambda _s: None)
    calls = []

    def flaky():
        calls.append(1)
        if len(calls) == 1:
            raise StubAPIError(export.TIMEOUT_CODE,
                               "canceling statement due to statement timeout")
        return "ok"

    assert export._retry_timeout(flaky) == "ok"
    assert len(calls) == 2


def test_a_non_timeout_api_error_is_not_retried(monkeypatch):
    """A 4xx means the payload or the schema is wrong; hammering it will not
    fix that, and a retry loop would only delay the real error."""
    monkeypatch.setattr(export.time, "sleep", lambda _s: None)
    calls = []

    def broken():
        calls.append(1)
        raise StubAPIError("42703", "column does not exist")

    with pytest.raises(StubAPIError):
        export._retry_timeout(broken)
    assert len(calls) == 1


def test_an_error_with_no_code_at_all_is_not_retried(monkeypatch):
    """Matching on an attribute rather than a class means anything without one
    must still fail on the first raise -- a transport error or a bug in the
    fake client is not a statement timeout."""
    monkeypatch.setattr(export.time, "sleep", lambda _s: None)
    calls = []

    def broken():
        calls.append(1)
        raise KeyError("id")

    with pytest.raises(KeyError):
        export._retry_timeout(broken)
    assert len(calls) == 1


def test_a_real_postgrest_api_error_carries_a_code():
    """`_retry_timeout` duck-types on `.code`, which is only correct while the
    real APIError actually exposes it. Skipped in CI, which installs only
    requirements-warehouse.txt; it runs wherever the export really runs."""
    APIError = pytest.importorskip("postgrest.exceptions").APIError

    exc = APIError({"code": "57014", "message": "canceling statement due to "
                                                "statement timeout"})
    assert exc.code == export.TIMEOUT_CODE


def test_the_retry_needs_no_supabase_dep(tmp_path):
    """The whole fetch path must import cleanly with no Supabase package
    installed -- CI installs requirements-warehouse.txt only, and this module's
    R2/Parquet side is meant to stand on its own (see `config.supabase_client`).

    An `from postgrest... import` inside the paging helpers broke every test in
    this file on CI while passing locally, where the dependency happened to be
    installed. Blocking the import here means this fails on that mistake in
    BOTH environments.
    """
    import sys

    class Blocked:
        def find_module(self, name, path=None):
            return self.find_spec(name, path)

        def find_spec(self, name, path=None, target=None):
            root = name.split(".")[0]
            if root in ("postgrest", "supabase", "gotrue", "storage3"):
                raise ImportError(f"{name} is not installed in this environment")
            return None

    blocker = Blocked()
    saved = {k: v for k, v in sys.modules.items()
             if k.split(".")[0] in ("postgrest", "supabase", "gotrue",
                                    "storage3")}
    for k in saved:
        del sys.modules[k]
    sys.meta_path.insert(0, blocker)
    try:
        store = LocalStore(tmp_path)
        res = export.export_day(store, DAY, client=FakeClient(_rows()))
        assert res["written"] is True
    finally:
        sys.meta_path.remove(blocker)
        sys.modules.update(saved)


def test_cmd_export_imports_resolve():
    """`cmd_export` went on importing `warehouse.export._client` after that
    helper was consolidated into `warehouse.config.supabase_client`. Nothing
    here exercised the CLI layer, so `python -m warehouse export` was dead on
    master while every other test in this file passed.
    """
    import re

    import warehouse.cli as cli

    src = inspect.getsource(cli.cmd_export)
    assert not re.search(r"\b_client\b", src), \
        "cmd_export references a helper that no longer exists"

    # The names it imports must actually resolve.
    for line in src.splitlines():
        line = line.strip()
        if line.startswith("from warehouse."):
            exec(line, {})  # noqa: S102 - the assertion IS that this imports
