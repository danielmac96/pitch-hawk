# Warehouse & Capacity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `pitches`/`at_bats` history to Cloudflare R2 as Parquet, migrate the four full-history batch jobs to DuckDB, and reclaim ~307 MB of the 500 MB Supabase cap without changing a single API response.

**Architecture:** A new `warehouse/` Python package exports finalized days from Supabase to partitioned Parquet in R2, records every write in a manifest that doubles as the integrity gate, then runs DuckDB over the full Parquet dataset to produce training cells and display aggregates which are published back into Supabase as small tables. Supabase keeps a 35-day hot window. Nothing user-facing changes.

**Tech Stack:** Python 3.13, DuckDB, PyArrow, boto3, supabase-py, pytest, GitHub Actions, Supabase Postgres 17.

## Global Constraints

- **Python 3.13** for the warehouse package and its CI job (matches `ci.yml`). `train-models.yml` currently pins 3.11 and is bumped to 3.13 in Task 11.
- **Supabase project ref:** `gfxpchtyncgsczqdvohr`, region `us-east-2`.
- **R2 bucket:** `pitch-hawk-warehouse`. Credentials come from env only: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`. Already present as GitHub Actions repository secrets.
- **Never list the bucket.** All readers resolve keys through `_manifest.json`. Scoped R2 `Object Read & Write` tokens are ambiguous about `LIST`.
- **Never delete before verify.** No task may add a deletion path that is not gated on a manifest entry whose `checksum` matched.
- **Hot window is exactly 35 days**, expressed as `now() - interval '35 days'`.
- **Parquet compression:** `zstd`. **Explicit PyArrow schemas always** — inferred schemas produce `null`-typed columns on all-NULL days and break multi-day DuckDB reads.
- Existing conventions to follow: `from __future__ import annotations` at the top of every module; `load_dotenv()` via `backend.db.client`; new Supabase tables get `alter table … enable row level security` plus a `"public read"` policy for `anon, authenticated` with `using (true)`.
- Migration filenames: `supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql`. Latest applied is `20260728000003`.
- `pytest.ini` excludes `-m network` by default. Warehouse tests must run offline against local Parquet fixtures — **no test may require R2 or Supabase**.

## Phase ordering — deliberately different from the spec

The spec numbers the capacity reclaim as Phase 1 and training as Phase 2. **This plan inverts them.** The reclaim migration drops the training RPCs and breaks `refresh_matchup_history()`, both of which need full history. Reclaiming first would leave the project unable to train or refresh matchups until later phases landed. Everything that depends on full history moves to the warehouse *first*; the reclaim is last, when nothing needs Postgres to hold two seasons.

Capacity has ~7 weeks of headroom, which this ordering comfortably fits.

| Plan phase | Spec phase | Deliverable |
|---|---|---|
| A (Tasks 1–7) | 0 | History in R2, verified, nothing deleted |
| B (Tasks 8–11) | 2 | Training reads the warehouse, metrics reproduced |
| C (Tasks 12–15) | 3 | Aggregates published nightly |
| D (Tasks 16–17) | 1 | ~307 MB reclaimed |

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `warehouse/__init__.py` | package marker |
| `warehouse/config.py` | env config, dataset column lists, PyArrow schemas, key layout |
| `warehouse/store.py` | `ObjectStore` protocol; `R2Store` (prod) and `LocalStore` (tests) |
| `warehouse/manifest.py` | read/write/query `_manifest.json` |
| `warehouse/export.py` | fetch a day from Supabase, coerce, write Parquet, checksum |
| `warehouse/verify.py` | reconcile Supabase counts against the manifest |
| `warehouse/duck.py` | DuckDB connection factory; resolves manifest → readable URIs |
| `warehouse/cells.py` | DuckDB translations of the 4 `train_*_cells` RPCs |
| `warehouse/aggregates.py` | matchup history, pitcher/batter profiles, fatigue, baselines |
| `warehouse/publish.py` | upsert aggregates into Supabase |
| `warehouse/cli.py` | `python -m warehouse <export\|verify\|backfill\|aggregate\|publish\|prune>` |
| `requirements-warehouse.txt` | duckdb, pyarrow, boto3 |
| `tests/warehouse/conftest.py` | synthetic Parquet fixtures + `LocalStore` |
| `tests/warehouse/test_config.py` | schema/key-layout invariants |
| `tests/warehouse/test_manifest.py` | manifest round-trip and queries |
| `tests/warehouse/test_export.py` | coercion, checksum, Parquet round-trip |
| `tests/warehouse/test_verify.py` | reconciliation pass/fail |
| `tests/warehouse/test_cells.py` | cell queries vs hand-computed expectations |
| `tests/warehouse/test_aggregates.py` | aggregate correctness |
| `.github/workflows/warehouse.yml` | nightly export → verify → aggregate → publish → prune |
| `supabase/migrations/20260730000001_warehouse_tables.sql` | 4 new aggregate tables |
| `supabase/migrations/20260731000001_hot_window_swap.sql` | table swap, drop moved RPCs, prune fn |

**Modified**

| File | Change |
|---|---|
| `scripts/train_models.py` | `rpc()` → warehouse cells; `train_moneyline` keeps its RPC |
| `.github/workflows/train-models.yml` | Python 3.13, R2 secrets, warehouse deps |
| `.github/workflows/ci.yml` | run `tests/warehouse` |
| `supabase/functions/daily-ingest/index.ts` | drop `refresh_matchup_history` call |
| `supabase/functions/api/index.ts` | warehouse staleness in `/health` |
| `requirements-dev.txt` | include warehouse deps |
| `.env.example` | document the four R2 vars |

---

# Phase A — History in R2 (spec Phase 0)

## Task 1: Package skeleton, config, and schemas

**Files:**
- Create: `warehouse/__init__.py`, `warehouse/config.py`, `requirements-warehouse.txt`
- Create: `tests/warehouse/__init__.py`, `tests/warehouse/test_config.py`
- Modify: `requirements-dev.txt`

**Interfaces:**
- Consumes: nothing
- Produces: `DATASETS: dict[str, list[str]]`, `SCHEMAS: dict[str, pa.Schema]`, `KEY_COLUMNS: dict[str, tuple[str, ...]]`, `JSON_COLUMNS: dict[str, tuple[str, ...]]`, `MANIFEST_KEY: str`, `HOT_WINDOW_DAYS: int`, `R2Config` dataclass with `.endpoint_url`, `r2_config() -> R2Config`, `object_key(dataset: str, day: str) -> str`, `snapshot_key(dataset: str) -> str`

- [ ] **Step 1: Write the failing test**

Create `tests/warehouse/__init__.py` (empty) and `tests/warehouse/test_config.py`:

```python
from __future__ import annotations

import pyarrow as pa
import pytest

from warehouse import config


def test_every_dataset_has_a_schema_and_key():
    for name, columns in config.DATASETS.items():
        assert name in config.SCHEMAS, f"{name} missing schema"
        assert name in config.KEY_COLUMNS, f"{name} missing key columns"
        schema_names = [f.name for f in config.SCHEMAS[name]]
        assert schema_names == columns, f"{name} schema/column order mismatch"


def test_key_columns_are_present_in_their_schema():
    for name, keys in config.KEY_COLUMNS.items():
        schema_names = {f.name for f in config.SCHEMAS[name]}
        assert set(keys) <= schema_names


def test_no_schema_field_is_null_typed():
    # An inferred null column breaks multi-day DuckDB reads; every field must
    # be explicitly typed.
    for name, schema in config.SCHEMAS.items():
        for field in schema:
            assert not pa.types.is_null(field.type), f"{name}.{field.name} is null-typed"


def test_object_key_partitions_by_season_and_month():
    assert config.object_key("pitches", "2026-07-28") == \
        "pitches/season=2026/month=07/day=2026-07-28.parquet"


def test_object_key_rejects_unknown_dataset():
    with pytest.raises(ValueError):
        config.object_key("nope", "2026-07-28")


def test_snapshot_key_has_no_date_partition():
    assert config.snapshot_key("player_info") == "player_info/snapshot.parquet"


def test_hot_window_is_35_days():
    assert config.HOT_WINDOW_DAYS == 35


def test_r2_config_lists_every_missing_var(monkeypatch):
    for var in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID",
                "R2_SECRET_ACCESS_KEY", "R2_BUCKET"):
        monkeypatch.delenv(var, raising=False)
    with pytest.raises(RuntimeError) as exc:
        config.r2_config()
    for var in ("R2_ACCOUNT_ID", "R2_BUCKET"):
        assert var in str(exc.value)


def test_r2_config_builds_endpoint_url(monkeypatch):
    monkeypatch.setenv("R2_ACCOUNT_ID", "abc123")
    monkeypatch.setenv("R2_ACCESS_KEY_ID", "k")
    monkeypatch.setenv("R2_SECRET_ACCESS_KEY", "s")
    monkeypatch.setenv("R2_BUCKET", "b")
    cfg = config.r2_config()
    assert cfg.endpoint_url == "https://abc123.r2.cloudflarestorage.com"
    assert cfg.bucket == "b"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest tests/warehouse/test_config.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'warehouse'`

- [ ] **Step 3: Create the dependency files**

Create `requirements-warehouse.txt`:

```
-r requirements.txt
duckdb
pyarrow
boto3
```

Modify `requirements-dev.txt` to read:

```
-r requirements.txt
-r requirements-warehouse.txt
pytest
pytest-asyncio
```

Install: `python -m pip install -r requirements-dev.txt`

- [ ] **Step 4: Write the implementation**

Create `warehouse/__init__.py` (empty file).

Create `warehouse/config.py`:

```python
"""Warehouse configuration: credentials, dataset layout, and Parquet schemas.

Everything is read from the environment so identical code runs in GitHub
Actions (repository secrets) and locally (.env, gitignored).

Column lists are frozen here rather than discovered from Postgres. A schema
change in the database should be a deliberate edit to this file, never a
silent change to the Parquet layout that historical files no longer match.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

import pyarrow as pa
from dotenv import load_dotenv

load_dotenv()

# Days of pitch/at-bat history retained in Postgres. Both
# refresh_pitcher_rolling_stats and refresh_batter_rolling_stats look back 30
# days; 35 leaves five days of margin for a late-finishing game or a missed
# nightly run.
HOT_WINDOW_DAYS = 35

MANIFEST_KEY = "_manifest.json"

# ── date-partitioned datasets ────────────────────────────────────────────────
PITCH_COLUMNS = [
    "id", "game_pk", "at_bat_index", "pitch_number", "pitcher_id", "batter_id",
    "pitch_type", "start_speed", "zone", "description", "result_category",
    "balls", "strikes", "outs", "inning", "top_inning", "pitch_ts",
]
AT_BAT_COLUMNS = [
    "id", "game_pk", "at_bat_index", "pitcher_id", "batter_id", "pitch_count",
    "result", "result_detail", "start_ts", "end_ts",
]
PREDICTION_COLUMNS = [
    "id", "game_pk", "at_bat_index", "pitch_number", "market",
    "predicted_value", "confidence", "probs", "recommendation", "line",
    "price", "edge", "units", "result", "profit_units", "graded_at",
    "model_version", "created_at", "book",
]

# ── snapshot datasets ───────────────────────────────────────────────────────
# Small, slowly-changing tables overwritten in full each run. They stay in
# Postgres too (nothing prunes them); the warehouse copy exists so DuckDB can
# join without a round trip to Supabase mid-query.
PLAYER_INFO_COLUMNS = [
    "player_id", "full_name", "pitch_hand", "bat_side", "primary_position",
]
GAME_COLUMNS = [
    "game_pk", "official_date", "status", "home_team", "away_team",
    "home_abbr", "away_abbr", "home_score", "away_score", "start_ts",
]

DATASETS: dict[str, list[str]] = {
    "pitches": PITCH_COLUMNS,
    "at_bats": AT_BAT_COLUMNS,
    "predictions": PREDICTION_COLUMNS,
}

SNAPSHOTS: dict[str, list[str]] = {
    "player_info": PLAYER_INFO_COLUMNS,
    "games": GAME_COLUMNS,
}

# Columns used to build the export checksum. Chosen to be the natural key, so
# a checksum mismatch means rows were added, dropped, or renumbered.
KEY_COLUMNS: dict[str, tuple[str, ...]] = {
    "pitches": ("game_pk", "at_bat_index", "pitch_number"),
    "at_bats": ("game_pk", "at_bat_index"),
    "predictions": ("id",),
    "player_info": ("player_id",),
    "games": ("game_pk",),
}

# jsonb columns arrive from PostgREST as dicts; Parquet stores them as JSON text.
JSON_COLUMNS: dict[str, tuple[str, ...]] = {
    "predictions": ("probs",),
}

_TS = pa.timestamp("us", tz="UTC")

SCHEMAS: dict[str, pa.Schema] = {
    "pitches": pa.schema([
        ("id", pa.int64()), ("game_pk", pa.int64()),
        ("at_bat_index", pa.int32()), ("pitch_number", pa.int32()),
        ("pitcher_id", pa.int32()), ("batter_id", pa.int32()),
        ("pitch_type", pa.string()), ("start_speed", pa.float64()),
        ("zone", pa.int32()), ("description", pa.string()),
        ("result_category", pa.string()), ("balls", pa.int32()),
        ("strikes", pa.int32()), ("outs", pa.int32()), ("inning", pa.int32()),
        ("top_inning", pa.bool_()), ("pitch_ts", _TS),
    ]),
    "at_bats": pa.schema([
        ("id", pa.int64()), ("game_pk", pa.int64()),
        ("at_bat_index", pa.int32()), ("pitcher_id", pa.int32()),
        ("batter_id", pa.int32()), ("pitch_count", pa.int32()),
        ("result", pa.string()), ("result_detail", pa.string()),
        ("start_ts", _TS), ("end_ts", _TS),
    ]),
    "predictions": pa.schema([
        ("id", pa.int64()), ("game_pk", pa.int64()),
        ("at_bat_index", pa.int32()), ("pitch_number", pa.int32()),
        ("market", pa.string()), ("predicted_value", pa.float64()),
        ("confidence", pa.float64()), ("probs", pa.string()),
        ("recommendation", pa.string()), ("line", pa.float64()),
        ("price", pa.int32()), ("edge", pa.float64()),
        ("units", pa.float64()), ("result", pa.string()),
        ("profit_units", pa.float64()), ("graded_at", _TS),
        ("model_version", pa.string()), ("created_at", _TS),
        ("book", pa.string()),
    ]),
    "player_info": pa.schema([
        ("player_id", pa.int32()), ("full_name", pa.string()),
        ("pitch_hand", pa.string()), ("bat_side", pa.string()),
        ("primary_position", pa.string()),
    ]),
    "games": pa.schema([
        ("game_pk", pa.int64()), ("official_date", pa.date32()),
        ("status", pa.string()), ("home_team", pa.string()),
        ("away_team", pa.string()), ("home_abbr", pa.string()),
        ("away_abbr", pa.string()), ("home_score", pa.int32()),
        ("away_score", pa.int32()), ("start_ts", _TS),
    ]),
}


@dataclass(frozen=True)
class R2Config:
    account_id: str
    access_key_id: str
    secret_access_key: str
    bucket: str

    @property
    def endpoint_url(self) -> str:
        return f"https://{self.account_id}.r2.cloudflarestorage.com"


_R2_VARS = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID",
            "R2_SECRET_ACCESS_KEY", "R2_BUCKET")


def r2_config() -> R2Config:
    missing = [n for n in _R2_VARS if not os.environ.get(n)]
    if missing:
        raise RuntimeError(
            "missing R2 environment variables: " + ", ".join(missing)
            + " — set them in .env locally or as GitHub Actions secrets"
        )
    return R2Config(
        account_id=os.environ["R2_ACCOUNT_ID"],
        access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        bucket=os.environ["R2_BUCKET"],
    )


def object_key(dataset: str, day: str) -> str:
    """Key for one date-partitioned dataset-day. `day` is YYYY-MM-DD."""
    if dataset not in DATASETS:
        raise ValueError(
            f"unknown dataset {dataset!r}; expected one of {sorted(DATASETS)}"
        )
    return f"{dataset}/season={day[:4]}/month={day[5:7]}/day={day}.parquet"


def snapshot_key(dataset: str) -> str:
    if dataset not in SNAPSHOTS:
        raise ValueError(
            f"unknown snapshot {dataset!r}; expected one of {sorted(SNAPSHOTS)}"
        )
    return f"{dataset}/snapshot.parquet"
```

Note the test asserts `SCHEMAS` covers `DATASETS`; `SNAPSHOTS` entries also have schemas and key columns, which the next test extends.

- [ ] **Step 5: Extend the test to cover snapshots**

Append to `tests/warehouse/test_config.py`:

```python
def test_every_snapshot_has_a_schema_and_key():
    for name, columns in config.SNAPSHOTS.items():
        assert name in config.SCHEMAS
        assert name in config.KEY_COLUMNS
        assert [f.name for f in config.SCHEMAS[name]] == columns


def test_datasets_and_snapshots_do_not_overlap():
    assert not (set(config.DATASETS) & set(config.SNAPSHOTS))
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `python -m pytest tests/warehouse/test_config.py -v`
Expected: PASS, 11 tests

- [ ] **Step 7: Commit**

```bash
git add warehouse/ tests/warehouse/ requirements-warehouse.txt requirements-dev.txt
git commit -m "feat(warehouse): dataset config, Parquet schemas, R2 credentials"
```

---

## Task 2: Object store abstraction

**Files:**
- Create: `warehouse/store.py`, `tests/warehouse/test_store.py`

**Interfaces:**
- Consumes: `warehouse.config.R2Config`
- Produces: `ObjectStore` protocol with `put(key, data) -> None`, `get(key) -> bytes`, `exists(key) -> bool`, `uri(key) -> str`; `LocalStore(root: Path)`; `R2Store(cfg: R2Config)`; `R2Store.configure_duckdb(con) -> None`

`uri()` is what `warehouse/duck.py` feeds to DuckDB's `read_parquet`. `LocalStore` returns a filesystem path and `R2Store` returns `s3://bucket/key`, which is why every downstream module is testable offline.

- [ ] **Step 1: Write the failing test**

Create `tests/warehouse/test_store.py`:

```python
from __future__ import annotations

import pytest

from warehouse.config import R2Config
from warehouse.store import LocalStore, R2Store


def test_local_store_round_trips(tmp_path):
    store = LocalStore(tmp_path)
    store.put("pitches/season=2026/day=2026-07-28.parquet", b"hello")
    assert store.get("pitches/season=2026/day=2026-07-28.parquet") == b"hello"


def test_local_store_creates_parent_directories(tmp_path):
    store = LocalStore(tmp_path)
    store.put("a/b/c/d.parquet", b"x")
    assert (tmp_path / "a" / "b" / "c" / "d.parquet").exists()


def test_local_store_exists_is_false_for_missing_key(tmp_path):
    assert LocalStore(tmp_path).exists("nope.parquet") is False


def test_local_store_get_missing_key_raises(tmp_path):
    with pytest.raises(FileNotFoundError):
        LocalStore(tmp_path).get("nope.parquet")


def test_local_store_uri_is_a_filesystem_path(tmp_path):
    uri = LocalStore(tmp_path).uri("x/y.parquet")
    assert uri.endswith("y.parquet")
    assert "s3://" not in uri


def test_r2_store_uri_is_an_s3_url():
    cfg = R2Config(account_id="acct", access_key_id="k",
                   secret_access_key="s", bucket="mybucket")
    # Constructing R2Store creates a boto3 client but performs no network I/O.
    store = R2Store(cfg)
    assert store.uri("pitches/x.parquet") == "s3://mybucket/pitches/x.parquet"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest tests/warehouse/test_store.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'warehouse.store'`

- [ ] **Step 3: Write the implementation**

Create `warehouse/store.py`:

```python
"""Object storage with two interchangeable backends.

R2Store talks to Cloudflare R2 over the S3 API. LocalStore is a filesystem
implementation of the same protocol, which is what lets the export, cell, and
aggregate modules be tested with no credentials and no network access.

Neither backend ever lists the bucket — callers resolve keys through
warehouse.manifest. Scoped R2 "Object Read & Write" tokens are ambiguous about
LIST permission, and an explicit index is what the prune step gates on anyway.
"""

from __future__ import annotations

from pathlib import Path
from typing import Protocol, runtime_checkable

from warehouse.config import R2Config


@runtime_checkable
class ObjectStore(Protocol):
    def put(self, key: str, data: bytes) -> None: ...
    def get(self, key: str) -> bytes: ...
    def exists(self, key: str) -> bool: ...
    def uri(self, key: str) -> str: ...


class LocalStore:
    """Filesystem-backed store. Used by the test suite and for dry runs."""

    def __init__(self, root: Path | str) -> None:
        self.root = Path(root)

    def _path(self, key: str) -> Path:
        return self.root / key

    def put(self, key: str, data: bytes) -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def get(self, key: str) -> bytes:
        return self._path(key).read_bytes()

    def exists(self, key: str) -> bool:
        return self._path(key).is_file()

    def uri(self, key: str) -> str:
        return str(self._path(key))

    def configure_duckdb(self, con) -> None:  # noqa: ANN001
        """No-op: DuckDB reads local paths without configuration."""
        return None


class R2Store:
    """Cloudflare R2 over the S3 API."""

    def __init__(self, cfg: R2Config) -> None:
        import boto3

        self._cfg = cfg
        self.bucket = cfg.bucket
        self._s3 = boto3.client(
            "s3",
            endpoint_url=cfg.endpoint_url,
            aws_access_key_id=cfg.access_key_id,
            aws_secret_access_key=cfg.secret_access_key,
            # R2 ignores region but boto3 requires one.
            region_name="auto",
        )

    def put(self, key: str, data: bytes) -> None:
        self._s3.put_object(Bucket=self.bucket, Key=key, Body=data)

    def get(self, key: str) -> bytes:
        return self._s3.get_object(Bucket=self.bucket, Key=key)["Body"].read()

    def exists(self, key: str) -> bool:
        from botocore.exceptions import ClientError

        try:
            self._s3.head_object(Bucket=self.bucket, Key=key)
        except ClientError:
            return False
        return True

    def uri(self, key: str) -> str:
        return f"s3://{self.bucket}/{key}"

    def configure_duckdb(self, con) -> None:  # noqa: ANN001
        """Point a DuckDB connection at R2 so read_parquet('s3://…') works."""
        con.execute("install httpfs; load httpfs;")
        con.execute(f"set s3_endpoint = '{self._cfg.account_id}.r2.cloudflarestorage.com'")
        con.execute("set s3_region = 'auto'")
        con.execute("set s3_url_style = 'path'")
        con.execute(f"set s3_access_key_id = '{self._cfg.access_key_id}'")
        con.execute(f"set s3_secret_access_key = '{self._cfg.secret_access_key}'")
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python -m pytest tests/warehouse/test_store.py -v`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add warehouse/store.py tests/warehouse/test_store.py
git commit -m "feat(warehouse): object store with R2 and local backends"
```

---

## Task 3: Manifest

**Files:**
- Create: `warehouse/manifest.py`, `tests/warehouse/test_manifest.py`

**Interfaces:**
- Consumes: `warehouse.config.MANIFEST_KEY`, `warehouse.store.ObjectStore`
- Produces: `empty() -> dict`, `load(store) -> dict`, `save(store, manifest) -> None`, `record(manifest, dataset, day, *, rows, size_bytes, checksum, verified_at) -> dict`, `entry(manifest, dataset, day) -> dict | None`, `days(manifest, dataset) -> list[str]`, `total_rows(manifest, dataset) -> int`, `is_verified(manifest, dataset, day) -> bool`

- [ ] **Step 1: Write the failing test**

Create `tests/warehouse/test_manifest.py`:

```python
from __future__ import annotations

from warehouse import manifest
from warehouse.store import LocalStore


def _store(tmp_path):
    return LocalStore(tmp_path)


def test_load_returns_empty_manifest_when_absent(tmp_path):
    assert manifest.load(_store(tmp_path)) == {"version": 1, "datasets": {}}


def test_save_then_load_round_trips(tmp_path):
    store = _store(tmp_path)
    m = manifest.empty()
    manifest.record(m, "pitches", "2026-07-28", rows=3781,
                    size_bytes=41230, checksum="abc",
                    verified_at="2026-07-29T14:00:00+00:00")
    manifest.save(store, m)
    assert manifest.load(store) == m


def test_record_stores_all_fields(tmp_path):
    m = manifest.record(manifest.empty(), "pitches", "2026-07-28",
                        rows=10, size_bytes=99, checksum="deadbeef",
                        verified_at="2026-07-29T00:00:00+00:00")
    e = manifest.entry(m, "pitches", "2026-07-28")
    assert e == {"rows": 10, "bytes": 99, "checksum": "deadbeef",
                 "verified_at": "2026-07-29T00:00:00+00:00"}


def test_entry_is_none_for_unknown_day():
    assert manifest.entry(manifest.empty(), "pitches", "1999-01-01") is None


def test_days_are_sorted():
    m = manifest.empty()
    for day in ("2026-07-28", "2026-07-26", "2026-07-27"):
        manifest.record(m, "pitches", day, rows=1, size_bytes=1,
                        checksum="c", verified_at="t")
    assert manifest.days(m, "pitches") == \
        ["2026-07-26", "2026-07-27", "2026-07-28"]


def test_days_is_empty_for_unknown_dataset():
    assert manifest.days(manifest.empty(), "pitches") == []


def test_total_rows_sums_every_day():
    m = manifest.empty()
    manifest.record(m, "pitches", "2026-07-27", rows=100, size_bytes=1,
                    checksum="c", verified_at="t")
    manifest.record(m, "pitches", "2026-07-28", rows=250, size_bytes=1,
                    checksum="c", verified_at="t")
    assert manifest.total_rows(m, "pitches") == 350


def test_is_verified_requires_a_checksum_and_timestamp():
    m = manifest.empty()
    manifest.record(m, "pitches", "2026-07-28", rows=1, size_bytes=1,
                    checksum="c", verified_at="t")
    assert manifest.is_verified(m, "pitches", "2026-07-28") is True
    manifest.record(m, "pitches", "2026-07-29", rows=1, size_bytes=1,
                    checksum="", verified_at="t")
    assert manifest.is_verified(m, "pitches", "2026-07-29") is False
    assert manifest.is_verified(m, "pitches", "2026-07-30") is False


def test_record_overwrites_an_existing_day():
    m = manifest.empty()
    manifest.record(m, "pitches", "2026-07-28", rows=1, size_bytes=1,
                    checksum="old", verified_at="t1")
    manifest.record(m, "pitches", "2026-07-28", rows=2, size_bytes=2,
                    checksum="new", verified_at="t2")
    assert manifest.entry(m, "pitches", "2026-07-28")["checksum"] == "new"
    assert manifest.total_rows(m, "pitches") == 2
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest tests/warehouse/test_manifest.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'warehouse.manifest'`

- [ ] **Step 3: Write the implementation**

Create `warehouse/manifest.py`:

```python
"""The manifest: the warehouse's index and its integrity record.

Two jobs:

1. Index. Readers resolve which Parquet files exist through this file rather
   than listing the bucket.
2. Gate. The prune step refuses to delete a day from Postgres unless that day
   has a verified manifest entry. This is the only thing standing between a
   failed export and permanent data loss, so `is_verified` is deliberately
   strict: a falsy checksum or timestamp is not verified.
"""

from __future__ import annotations

import json
from typing import Any

from warehouse.config import MANIFEST_KEY


def empty() -> dict[str, Any]:
    return {"version": 1, "datasets": {}}


def load(store) -> dict[str, Any]:  # noqa: ANN001
    if not store.exists(MANIFEST_KEY):
        return empty()
    return json.loads(store.get(MANIFEST_KEY).decode("utf-8"))


def save(store, m: dict[str, Any]) -> None:  # noqa: ANN001
    body = json.dumps(m, indent=2, sort_keys=True).encode("utf-8")
    store.put(MANIFEST_KEY, body)


def record(
    m: dict[str, Any],
    dataset: str,
    day: str,
    *,
    rows: int,
    size_bytes: int,
    checksum: str,
    verified_at: str,
) -> dict[str, Any]:
    """Insert or replace one dataset-day entry. Mutates and returns `m`."""
    m.setdefault("datasets", {}).setdefault(dataset, {})[day] = {
        "rows": rows,
        "bytes": size_bytes,
        "checksum": checksum,
        "verified_at": verified_at,
    }
    return m


def entry(m: dict[str, Any], dataset: str, day: str) -> dict[str, Any] | None:
    return m.get("datasets", {}).get(dataset, {}).get(day)


def days(m: dict[str, Any], dataset: str) -> list[str]:
    return sorted(m.get("datasets", {}).get(dataset, {}))


def total_rows(m: dict[str, Any], dataset: str) -> int:
    return sum(e["rows"] for e in m.get("datasets", {}).get(dataset, {}).values())


def is_verified(m: dict[str, Any], dataset: str, day: str) -> bool:
    e = entry(m, dataset, day)
    return bool(e and e.get("checksum") and e.get("verified_at"))
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python -m pytest tests/warehouse/test_manifest.py -v`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add warehouse/manifest.py tests/warehouse/test_manifest.py
git commit -m "feat(warehouse): manifest as index and prune gate"
```

---

## Task 4: Export — coercion, checksum, Parquet

**Files:**
- Create: `warehouse/export.py`, `tests/warehouse/test_export.py`

**Interfaces:**
- Consumes: `warehouse.config` (`DATASETS`, `SNAPSHOTS`, `SCHEMAS`, `JSON_COLUMNS`, `KEY_COLUMNS`, `object_key`, `snapshot_key`), `warehouse.store.ObjectStore`, `backend.db.client.get_client`
- Produces: `is_final(status: str | None) -> bool`, `parse_ts(value) -> datetime | None`, `coerce_rows(rows: list[dict], dataset: str) -> list[dict]`, `checksum(rows: list[dict], dataset: str) -> str`, `to_parquet(rows: list[dict], dataset: str) -> bytes`, `final_game_pks(client, day: str) -> list[int]`, `fetch_by_game(client, dataset: str, game_pks: list[int]) -> list[dict]`, `fetch_all(client, dataset: str) -> list[dict]`, `export_day(client, store, dataset: str, day: str) -> dict`, `export_snapshot(client, store, dataset: str) -> dict`

`export_day` returns `{"dataset", "day", "rows", "bytes", "checksum", "game_pks"}`.

- [ ] **Step 1: Write the failing test**

Create `tests/warehouse/test_export.py`:

```python
from __future__ import annotations

import io
from datetime import datetime, timezone

import pyarrow.parquet as pq
import pytest

from warehouse import export
from warehouse.config import SCHEMAS


def test_is_final_matches_the_edge_function_rules():
    # Mirrors isFinal() in supabase/functions/_shared/mlb.ts
    for status in ("Final", "Final: Tied", "Game Over", "Completed Early"):
        assert export.is_final(status) is True
    for status in ("In Progress", "Pre-Game", "Suspended", "", None):
        assert export.is_final(status) is False


def test_parse_ts_handles_z_and_offset_forms():
    expected = datetime(2026, 7, 28, 19, 5, 11, tzinfo=timezone.utc)
    assert export.parse_ts("2026-07-28T19:05:11Z") == expected
    assert export.parse_ts("2026-07-28T19:05:11+00:00") == expected


def test_parse_ts_assumes_utc_when_naive():
    got = export.parse_ts("2026-07-28T19:05:11")
    assert got.tzinfo is timezone.utc


def test_parse_ts_passes_none_through():
    assert export.parse_ts(None) is None


def test_coerce_rows_fills_missing_columns_with_none():
    rows = [{"game_pk": 1, "at_bat_index": 0, "pitch_number": 1}]
    out = export.coerce_rows(rows, "pitches")
    assert set(out[0]) == {f.name for f in SCHEMAS["pitches"]}
    assert out[0]["pitch_type"] is None


def test_coerce_rows_serializes_jsonb_to_text():
    rows = [{"id": 1, "probs": {"ball": 0.4, "strike_foul": 0.6}}]
    out = export.coerce_rows(rows, "predictions")
    assert isinstance(out[0]["probs"], str)
    assert '"ball"' in out[0]["probs"]


def test_coerce_rows_leaves_json_text_alone():
    rows = [{"id": 1, "probs": '{"ball": 0.4}'}]
    assert export.coerce_rows(rows, "predictions")[0]["probs"] == '{"ball": 0.4}'


def test_checksum_is_stable_regardless_of_row_order():
    a = [{"game_pk": 1, "at_bat_index": 0, "pitch_number": 1},
         {"game_pk": 1, "at_bat_index": 0, "pitch_number": 2}]
    assert export.checksum(a, "pitches") == export.checksum(list(reversed(a)), "pitches")


def test_checksum_changes_when_a_row_is_dropped():
    a = [{"game_pk": 1, "at_bat_index": 0, "pitch_number": 1},
         {"game_pk": 1, "at_bat_index": 0, "pitch_number": 2}]
    assert export.checksum(a, "pitches") != export.checksum(a[:1], "pitches")


def test_to_parquet_round_trips_with_the_declared_schema():
    rows = [{
        "id": 1, "game_pk": 746285, "at_bat_index": 3, "pitch_number": 1,
        "pitcher_id": 543037, "batter_id": 646240, "pitch_type": "FF",
        "start_speed": 97.2, "zone": 5, "description": "called_strike",
        "result_category": "strike_foul", "balls": 0, "strikes": 0, "outs": 1,
        "inning": 6, "top_inning": True, "pitch_ts": "2026-07-28T19:05:11Z",
    }]
    blob = export.to_parquet(export.coerce_rows(rows, "pitches"), "pitches")
    table = pq.read_table(io.BytesIO(blob))
    assert table.schema.equals(SCHEMAS["pitches"])
    assert table.num_rows == 1
    assert table.column("start_speed")[0].as_py() == pytest.approx(97.2)


def test_to_parquet_keeps_the_schema_when_a_column_is_entirely_null():
    # The failure this guards: an inferred schema would type pitch_type as
    # null, and DuckDB then refuses to read that file alongside others.
    rows = [{"id": 1, "game_pk": 1, "at_bat_index": 0, "pitch_number": 1}]
    blob = export.to_parquet(export.coerce_rows(rows, "pitches"), "pitches")
    assert pq.read_table(io.BytesIO(blob)).schema.equals(SCHEMAS["pitches"])


def test_to_parquet_accepts_zero_rows():
    blob = export.to_parquet([], "pitches")
    table = pq.read_table(io.BytesIO(blob))
    assert table.num_rows == 0
    assert table.schema.equals(SCHEMAS["pitches"])
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest tests/warehouse/test_export.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'warehouse.export'`

- [ ] **Step 3: Write the implementation**

Create `warehouse/export.py`:

```python
"""Export finalized days from Supabase to Parquet in the object store.

Only games in a terminal state are exported. A suspended or in-progress game
is skipped and picked up by a later run, so a partial game is never frozen
into the warehouse.

Rows are fetched per game_pk rather than by timestamp range. `at_bats` has no
index on end_ts (see pg_indexes: only id, game_pk+at_bat_index, pitcher_id,
batter_id), so a date-range scan there is a sequential scan; game_pk leads the
unique index on both tables.
"""

from __future__ import annotations

import hashlib
import io
import json
from datetime import date, datetime, timezone

import pyarrow as pa
import pyarrow.parquet as pq

from warehouse.config import (
    DATASETS, JSON_COLUMNS, KEY_COLUMNS, SCHEMAS, SNAPSHOTS,
    object_key, snapshot_key,
)

# PostgREST caps a response at 1000 rows by default.
PAGE = 1000


def is_final(status: str | None) -> bool:
    """Terminal game status. Mirrors isFinal() in _shared/mlb.ts exactly."""
    if not status:
        return False
    return (status.startswith("Final")
            or status in ("Game Over", "Completed Early"))


def parse_ts(value) -> datetime | None:  # noqa: ANN001
    """PostgREST timestamptz -> aware datetime. Naive input is assumed UTC."""
    if value is None or isinstance(value, datetime):
        return value
    text = str(value).strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    parsed = datetime.fromisoformat(text)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _parse_date(value):  # noqa: ANN001, ANN201
    if value is None or isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.date()
    return date.fromisoformat(str(value)[:10])


def _schema_for(dataset: str) -> pa.Schema:
    if dataset not in SCHEMAS:
        raise ValueError(f"no schema for dataset {dataset!r}")
    return SCHEMAS[dataset]


def coerce_rows(rows: list[dict], dataset: str) -> list[dict]:
    """Project rows onto the declared schema and convert Python types.

    Missing keys become None so a sparse PostgREST response still produces a
    full-width table.
    """
    schema = _schema_for(dataset)
    ts_cols = {f.name for f in schema if pa.types.is_timestamp(f.type)}
    date_cols = {f.name for f in schema if pa.types.is_date(f.type)}
    json_cols = set(JSON_COLUMNS.get(dataset, ()))
    float_cols = {f.name for f in schema if pa.types.is_floating(f.type)}

    out: list[dict] = []
    for row in rows:
        shaped: dict = {}
        for field in schema:
            name = field.name
            value = row.get(name)
            if name in ts_cols:
                value = parse_ts(value)
            elif name in date_cols:
                value = _parse_date(value)
            elif name in json_cols and value is not None and not isinstance(value, str):
                value = json.dumps(value, sort_keys=True)
            elif name in float_cols and value is not None:
                # Postgres numeric arrives as str via PostgREST.
                value = float(value)
            shaped[name] = value
        out.append(shaped)
    return out


def checksum(rows: list[dict], dataset: str) -> str:
    """SHA-256 over the sorted natural keys. Order-independent by design."""
    cols = KEY_COLUMNS[dataset]
    keys = sorted("|".join(str(row.get(c)) for c in cols) for row in rows)
    digest = hashlib.sha256()
    for key in keys:
        digest.update(key.encode("utf-8"))
        digest.update(b"\n")
    return digest.hexdigest()


def to_parquet(rows: list[dict], dataset: str) -> bytes:
    schema = _schema_for(dataset)
    table = pa.Table.from_pylist(coerce_rows(rows, dataset), schema=schema)
    buf = io.BytesIO()
    pq.write_table(table, buf, compression="zstd")
    return buf.getvalue()


def final_game_pks(client, day: str) -> list[int]:  # noqa: ANN001
    rows = (client.table("games").select("game_pk,status")
            .eq("official_date", day).execute().data or [])
    return sorted(r["game_pk"] for r in rows if is_final(r.get("status")))


def fetch_by_game(client, dataset: str, game_pks: list[int]) -> list[dict]:  # noqa: ANN001
    cols = ",".join(DATASETS[dataset])
    out: list[dict] = []
    for game_pk in game_pks:
        start = 0
        while True:
            batch = (client.table(dataset).select(cols)
                     .eq("game_pk", game_pk).order("id")
                     .range(start, start + PAGE - 1).execute().data or [])
            out.extend(batch)
            if len(batch) < PAGE:
                break
            start += PAGE
    return out


def fetch_all(client, dataset: str) -> list[dict]:  # noqa: ANN001
    """Full-table page-through, for the small snapshot datasets."""
    cols = ",".join(SNAPSHOTS[dataset])
    key = KEY_COLUMNS[dataset][0]
    out: list[dict] = []
    start = 0
    while True:
        batch = (client.table(dataset).select(cols).order(key)
                 .range(start, start + PAGE - 1).execute().data or [])
        out.extend(batch)
        if len(batch) < PAGE:
            break
        start += PAGE
    return out


def export_day(client, store, dataset: str, day: str) -> dict:  # noqa: ANN001
    """Write one dataset-day to the store. Returns its manifest facts."""
    game_pks = final_game_pks(client, day)
    rows = fetch_by_game(client, dataset, game_pks) if game_pks else []
    shaped = coerce_rows(rows, dataset)
    blob = to_parquet(shaped, dataset)
    store.put(object_key(dataset, day), blob)
    return {
        "dataset": dataset, "day": day, "rows": len(shaped),
        "bytes": len(blob), "checksum": checksum(shaped, dataset),
        "game_pks": game_pks,
    }


def export_snapshot(client, store, dataset: str) -> dict:  # noqa: ANN001
    rows = fetch_all(client, dataset)
    shaped = coerce_rows(rows, dataset)
    blob = to_parquet(shaped, dataset)
    store.put(snapshot_key(dataset), blob)
    return {"dataset": dataset, "rows": len(shaped), "bytes": len(blob),
            "checksum": checksum(shaped, dataset)}
```

Note: `predictions` is keyed on `id` and is not game-scoped in the same way, but every prediction row carries `game_pk`, so `fetch_by_game` works for it unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python -m pytest tests/warehouse/test_export.py -v`
Expected: PASS, 12 tests

- [ ] **Step 5: Add a fake-client test for `export_day`**

Append to `tests/warehouse/test_export.py`:

```python
class _FakeQuery:
    def __init__(self, rows):
        self._rows = rows

    def select(self, *_a, **_k):
        return self

    def eq(self, col, val):
        self._rows = [r for r in self._rows if r.get(col) == val]
        return self

    def order(self, *_a, **_k):
        return self

    def range(self, start, end):
        self._slice = (start, end)
        return self

    def execute(self):
        start, end = getattr(self, "_slice", (0, len(self._rows) - 1))
        return type("Res", (), {"data": self._rows[start:end + 1]})()


class _FakeClient:
    def __init__(self, tables):
        self._tables = tables

    def table(self, name):
        return _FakeQuery(list(self._tables.get(name, [])))


def test_export_day_skips_games_that_are_not_final(tmp_path):
    from warehouse.store import LocalStore

    client = _FakeClient({
        "games": [
            {"game_pk": 1, "status": "Final"},
            {"game_pk": 2, "status": "In Progress"},
        ],
        "pitches": [
            {"id": 1, "game_pk": 1, "at_bat_index": 0, "pitch_number": 1},
            {"id": 2, "game_pk": 2, "at_bat_index": 0, "pitch_number": 1},
        ],
    })
    store = LocalStore(tmp_path)
    result = export.export_day(client, store, "pitches", "2026-07-28")
    assert result["game_pks"] == [1]
    assert result["rows"] == 1
    assert store.exists("pitches/season=2026/month=07/day=2026-07-28.parquet")


def test_export_day_writes_an_empty_file_for_a_day_with_no_final_games(tmp_path):
    from warehouse.store import LocalStore

    client = _FakeClient({"games": [{"game_pk": 9, "status": "Postponed"}]})
    result = export.export_day(client, LocalStore(tmp_path), "pitches", "2026-07-28")
    assert result["rows"] == 0
    assert result["game_pks"] == []
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `python -m pytest tests/warehouse/test_export.py -v`
Expected: PASS, 14 tests

- [ ] **Step 7: Commit**

```bash
git add warehouse/export.py tests/warehouse/test_export.py
git commit -m "feat(warehouse): export finalized days to Parquet with checksums"
```

---

## Task 5: Verify — reconcile Postgres against the warehouse

**Files:**
- Create: `warehouse/verify.py`, `tests/warehouse/test_verify.py`

**Interfaces:**
- Consumes: `warehouse.export` (`checksum`, `final_game_pks`, `fetch_by_game`, `coerce_rows`), `warehouse.manifest`, `warehouse.config.object_key`
- Produces: `VerifyResult` dataclass with fields `dataset: str`, `day: str`, `ok: bool`, `pg_rows: int`, `parquet_rows: int`, `pg_checksum: str`, `parquet_checksum: str`, `reason: str`; and `verify_day(client, store, dataset, day) -> VerifyResult`, `read_parquet_rows(store, dataset, day) -> list[dict]`

- [ ] **Step 1: Write the failing test**

Create `tests/warehouse/test_verify.py`:

```python
from __future__ import annotations

from warehouse import export, verify
from warehouse.store import LocalStore
from tests.warehouse.test_export import _FakeClient


def _rows():
    return [
        {"id": 1, "game_pk": 1, "at_bat_index": 0, "pitch_number": 1},
        {"id": 2, "game_pk": 1, "at_bat_index": 0, "pitch_number": 2},
    ]


def _client():
    return _FakeClient({"games": [{"game_pk": 1, "status": "Final"}],
                        "pitches": _rows()})


def test_verify_passes_when_parquet_matches_postgres(tmp_path):
    store = LocalStore(tmp_path)
    client = _client()
    export.export_day(client, store, "pitches", "2026-07-28")
    result = verify.verify_day(_client(), store, "pitches", "2026-07-28")
    assert result.ok is True
    assert result.pg_rows == result.parquet_rows == 2
    assert result.pg_checksum == result.parquet_checksum


def test_verify_fails_on_a_row_count_mismatch(tmp_path):
    store = LocalStore(tmp_path)
    export.export_day(_client(), store, "pitches", "2026-07-28")
    # Postgres now has a third row that the export never saw.
    grown = _FakeClient({
        "games": [{"game_pk": 1, "status": "Final"}],
        "pitches": _rows() + [
            {"id": 3, "game_pk": 1, "at_bat_index": 0, "pitch_number": 3}],
    })
    result = verify.verify_day(grown, store, "pitches", "2026-07-28")
    assert result.ok is False
    assert "row count" in result.reason


def test_verify_fails_when_the_object_is_missing(tmp_path):
    result = verify.verify_day(_client(), LocalStore(tmp_path),
                               "pitches", "2026-07-28")
    assert result.ok is False
    assert "missing" in result.reason


def test_verify_fails_on_a_checksum_mismatch_at_equal_counts(tmp_path):
    store = LocalStore(tmp_path)
    export.export_day(_client(), store, "pitches", "2026-07-28")
    # Same count, different keys — a renumbering the count check cannot see.
    swapped = _FakeClient({
        "games": [{"game_pk": 1, "status": "Final"}],
        "pitches": [
            {"id": 1, "game_pk": 1, "at_bat_index": 0, "pitch_number": 1},
            {"id": 2, "game_pk": 1, "at_bat_index": 0, "pitch_number": 9},
        ],
    })
    result = verify.verify_day(swapped, store, "pitches", "2026-07-28")
    assert result.ok is False
    assert "checksum" in result.reason


def test_read_parquet_rows_returns_dicts(tmp_path):
    store = LocalStore(tmp_path)
    export.export_day(_client(), store, "pitches", "2026-07-28")
    rows = verify.read_parquet_rows(store, "pitches", "2026-07-28")
    assert len(rows) == 2
    assert rows[0]["game_pk"] == 1
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest tests/warehouse/test_verify.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'warehouse.verify'`

- [ ] **Step 3: Write the implementation**

Create `warehouse/verify.py`:

```python
"""Reconcile what Postgres holds against what the warehouse stored.

This is the gate the prune step depends on. It compares two things:

  row count   — catches a truncated or failed write
  checksum    — catches equal-count corruption: renumbered, swapped, or
                substituted rows that a count comparison cannot see

Both must match for a day to be considered verified.
"""

from __future__ import annotations

import io
from dataclasses import dataclass

import pyarrow.parquet as pq

from warehouse.config import object_key
from warehouse.export import checksum, coerce_rows, fetch_by_game, final_game_pks


@dataclass(frozen=True)
class VerifyResult:
    dataset: str
    day: str
    ok: bool
    pg_rows: int
    parquet_rows: int
    pg_checksum: str
    parquet_checksum: str
    reason: str = ""


def read_parquet_rows(store, dataset: str, day: str) -> list[dict]:  # noqa: ANN001
    blob = store.get(object_key(dataset, day))
    return pq.read_table(io.BytesIO(blob)).to_pylist()


def verify_day(client, store, dataset: str, day: str) -> VerifyResult:  # noqa: ANN001
    key = object_key(dataset, day)
    if not store.exists(key):
        return VerifyResult(dataset, day, False, 0, 0, "", "",
                            f"missing object {key}")

    game_pks = final_game_pks(client, day)
    pg_rows = coerce_rows(
        fetch_by_game(client, dataset, game_pks) if game_pks else [], dataset)
    parquet_rows = read_parquet_rows(store, dataset, day)

    pg_sum = checksum(pg_rows, dataset)
    pq_sum = checksum(parquet_rows, dataset)

    if len(pg_rows) != len(parquet_rows):
        reason = (f"row count mismatch: postgres={len(pg_rows)} "
                  f"parquet={len(parquet_rows)}")
        return VerifyResult(dataset, day, False, len(pg_rows),
                            len(parquet_rows), pg_sum, pq_sum, reason)

    if pg_sum != pq_sum:
        return VerifyResult(dataset, day, False, len(pg_rows),
                            len(parquet_rows), pg_sum, pq_sum,
                            "checksum mismatch at equal row counts")

    return VerifyResult(dataset, day, True, len(pg_rows), len(parquet_rows),
                        pg_sum, pq_sum)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python -m pytest tests/warehouse/test_verify.py -v`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add warehouse/verify.py tests/warehouse/test_verify.py
git commit -m "feat(warehouse): verify step reconciling counts and checksums"
```

---

## Task 6: CLI — export, verify, backfill

**Files:**
- Create: `warehouse/cli.py`, `tests/warehouse/test_cli.py`
- Modify: `.env.example`

**Interfaces:**
- Consumes: everything from Tasks 1–5
- Produces: `main(argv: list[str] | None = None) -> int`; `resolve_store(args) -> ObjectStore`; `run_export(client, store, days: list[str], datasets: list[str]) -> dict`; `daterange(start: str, end: str) -> list[str]`

CLI surface, used by the workflow in Task 7:

```
python -m warehouse export  [--date YYYY-MM-DD] [--datasets pitches,at_bats,predictions]
python -m warehouse verify  [--date YYYY-MM-DD]
python -m warehouse backfill --start YYYY-MM-DD --end YYYY-MM-DD
python -m warehouse snapshot
```

`--local <dir>` on any subcommand swaps `R2Store` for `LocalStore`, which is how the pipeline is exercised without credentials.

- [ ] **Step 1: Write the failing test**

Create `tests/warehouse/test_cli.py`:

```python
from __future__ import annotations

from warehouse import cli


def test_daterange_is_inclusive_of_both_ends():
    assert cli.daterange("2026-07-26", "2026-07-28") == \
        ["2026-07-26", "2026-07-27", "2026-07-28"]


def test_daterange_single_day():
    assert cli.daterange("2026-07-28", "2026-07-28") == ["2026-07-28"]


def test_daterange_rejects_a_reversed_window():
    import pytest
    with pytest.raises(ValueError):
        cli.daterange("2026-07-28", "2026-07-26")


def test_default_date_is_yesterday_in_eastern_time():
    # The MLB "official date" is US/Eastern; exports run at 14:00 UTC, so
    # yesterday-Eastern is the last complete slate.
    day = cli.default_date()
    assert len(day) == 10 and day[4] == "-" and day[7] == "-"


def test_resolve_store_returns_local_store_when_local_is_given(tmp_path):
    from warehouse.store import LocalStore
    args = cli.build_parser().parse_args(
        ["export", "--local", str(tmp_path)])
    assert isinstance(cli.resolve_store(args), LocalStore)


def test_parser_accepts_a_dataset_list():
    args = cli.build_parser().parse_args(
        ["export", "--datasets", "pitches,at_bats"])
    assert args.datasets == "pitches,at_bats"


def test_run_export_records_every_day_in_the_manifest(tmp_path):
    from warehouse import manifest
    from warehouse.store import LocalStore
    from tests.warehouse.test_export import _FakeClient

    client = _FakeClient({
        "games": [{"game_pk": 1, "status": "Final"}],
        "pitches": [{"id": 1, "game_pk": 1, "at_bat_index": 0,
                     "pitch_number": 1}],
    })
    store = LocalStore(tmp_path)
    cli.run_export(client, store, ["2026-07-27", "2026-07-28"], ["pitches"])
    m = manifest.load(store)
    assert manifest.days(m, "pitches") == ["2026-07-27", "2026-07-28"]
    # Both days see the same fake game, so both record one row.
    assert manifest.total_rows(m, "pitches") == 2
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest tests/warehouse/test_cli.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'warehouse.cli'`

- [ ] **Step 3: Write the implementation**

Create `warehouse/cli.py`:

```python
"""Warehouse entrypoint.

    python -m warehouse export   [--date D] [--datasets a,b]
    python -m warehouse verify   [--date D]
    python -m warehouse backfill --start D --end D
    python -m warehouse snapshot

--local <dir> swaps R2 for a local directory, so the whole pipeline can be
exercised end to end without credentials before it is ever scheduled.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.db.client import get_client  # noqa: E402
from warehouse import manifest  # noqa: E402
from warehouse.config import DATASETS, SNAPSHOTS, r2_config  # noqa: E402
from warehouse.export import export_day, export_snapshot  # noqa: E402
from warehouse.store import LocalStore, R2Store  # noqa: E402
from warehouse.verify import verify_day  # noqa: E402

EASTERN = ZoneInfo("America/New_York")


def default_date() -> str:
    """Yesterday, US/Eastern — MLB's official-date timezone."""
    now_eastern = datetime.now(timezone.utc).astimezone(EASTERN)
    return (now_eastern.date() - timedelta(days=1)).isoformat()


def daterange(start: str, end: str) -> list[str]:
    first = datetime.strptime(start, "%Y-%m-%d").date()
    last = datetime.strptime(end, "%Y-%m-%d").date()
    if last < first:
        raise ValueError(f"end {end} is before start {start}")
    days, cursor = [], first
    while cursor <= last:
        days.append(cursor.isoformat())
        cursor += timedelta(days=1)
    return days


def resolve_store(args):  # noqa: ANN001, ANN201
    if getattr(args, "local", None):
        return LocalStore(args.local)
    return R2Store(r2_config())


def _datasets(args) -> list[str]:  # noqa: ANN001
    raw = getattr(args, "datasets", None)
    if not raw:
        return list(DATASETS)
    names = [n.strip() for n in raw.split(",") if n.strip()]
    unknown = [n for n in names if n not in DATASETS]
    if unknown:
        raise ValueError(f"unknown datasets: {', '.join(unknown)}")
    return names


def run_export(client, store, days: list[str], datasets: list[str]) -> dict:  # noqa: ANN001
    """Export then verify each dataset-day; record verified days only."""
    m = manifest.load(store)
    summary: dict = {"exported": [], "failed": []}
    for day in days:
        for dataset in datasets:
            written = export_day(client, store, dataset, day)
            result = verify_day(client, store, dataset, day)
            if not result.ok:
                summary["failed"].append(
                    {"dataset": dataset, "day": day, "reason": result.reason})
                print(f"[warehouse] FAIL {dataset} {day}: {result.reason}")
                continue
            manifest.record(
                m, dataset, day,
                rows=written["rows"], size_bytes=written["bytes"],
                checksum=written["checksum"],
                verified_at=datetime.now(timezone.utc).isoformat(),
            )
            summary["exported"].append(
                {"dataset": dataset, "day": day,
                 "rows": written["rows"], "bytes": written["bytes"]})
            print(f"[warehouse] ok {dataset} {day}: "
                  f"{written['rows']} rows, {written['bytes']} bytes")
    manifest.save(store, m)
    return summary


def run_verify(client, store, days: list[str], datasets: list[str]) -> dict:  # noqa: ANN001
    summary: dict = {"ok": [], "failed": []}
    for day in days:
        for dataset in datasets:
            result = verify_day(client, store, dataset, day)
            bucket = "ok" if result.ok else "failed"
            summary[bucket].append({"dataset": dataset, "day": day,
                                    "reason": result.reason})
            print(f"[warehouse] {bucket} {dataset} {day} "
                  f"pg={result.pg_rows} parquet={result.parquet_rows} "
                  f"{result.reason}")
    return summary


def run_snapshot(client, store) -> dict:  # noqa: ANN001
    out = {}
    for dataset in SNAPSHOTS:
        result = export_snapshot(client, store, dataset)
        out[dataset] = result
        print(f"[warehouse] snapshot {dataset}: {result['rows']} rows")
    return out


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m warehouse")
    sub = parser.add_subparsers(dest="command", required=True)

    def common(p):  # noqa: ANN001, ANN202
        p.add_argument("--local", help="use a local directory instead of R2")
        return p

    p_export = common(sub.add_parser("export"))
    p_export.add_argument("--date", default=None)
    p_export.add_argument("--datasets", default=None)

    p_verify = common(sub.add_parser("verify"))
    p_verify.add_argument("--date", default=None)
    p_verify.add_argument("--datasets", default=None)

    p_backfill = common(sub.add_parser("backfill"))
    p_backfill.add_argument("--start", required=True)
    p_backfill.add_argument("--end", required=True)
    p_backfill.add_argument("--datasets", default=None)

    common(sub.add_parser("snapshot"))
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    store = resolve_store(args)
    client = get_client()

    if args.command == "snapshot":
        print(json.dumps(run_snapshot(client, store), default=str))
        return 0

    if args.command == "backfill":
        days = daterange(args.start, args.end)
    else:
        days = [args.date or default_date()]

    datasets = _datasets(args)

    if args.command == "verify":
        summary = run_verify(client, store, days, datasets)
    else:
        summary = run_export(client, store, days, datasets)

    print(json.dumps({k: len(v) for k, v in summary.items()}))
    return 1 if summary.get("failed") else 0


if __name__ == "__main__":
    sys.exit(main())
```

Create `warehouse/__main__.py`:

```python
from __future__ import annotations

import sys

from warehouse.cli import main

sys.exit(main())
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python -m pytest tests/warehouse/test_cli.py -v`
Expected: PASS, 7 tests

- [ ] **Step 5: Document the R2 variables**

In `.env.example`, insert after the `SUPABASE_FUNCTIONS_URL` block:

```
# ── Cloudflare R2 warehouse (warehouse/, scripts/train_models.py) ──────────
# Historic pitches/at_bats/predictions live in R2 as Parquet; Supabase keeps a
# 35-day hot window. Token: R2 → Manage R2 API Tokens → Object Read & Write,
# scoped to the single bucket. Same four values are GitHub Actions secrets.
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=pitch-hawk-warehouse
```

- [ ] **Step 6: Exercise the CLI against a local store, no credentials**

Run: `python -m warehouse export --date 2026-07-28 --local ./.warehouse-local`
Expected: real Supabase reads, Parquet written under `./.warehouse-local/`, a line per dataset reading `ok pitches 2026-07-28: <n> rows`, exit code 0.

Then confirm the manifest: `python -c "import json;print(json.load(open('.warehouse-local/_manifest.json'))['datasets'].keys())"`
Expected: `dict_keys(['at_bats', 'pitches', 'predictions'])`

Add `.warehouse-local/` to `.gitignore`.

- [ ] **Step 7: Commit**

```bash
git add warehouse/cli.py warehouse/__main__.py tests/warehouse/test_cli.py .env.example .gitignore
git commit -m "feat(warehouse): CLI for export, verify, backfill, snapshot"
```

---

## Task 7: Nightly workflow and the full historical backfill

**Files:**
- Create: `.github/workflows/warehouse.yml`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `warehouse.cli.main`
- Produces: a scheduled job; R2 populated with all history from 2025-03-27 forward

This task closes Phase A. **No deletion path exists yet** — that is the point of stopping here.

- [ ] **Step 1: Add warehouse tests to CI**

In `.github/workflows/ci.yml`, the `backend` job's test step currently reads
`run: pytest tests/ -q`. `testpaths = tests` in `pytest.ini` already collects
`tests/warehouse`, so the only change needed is installing the warehouse deps.
Change the `backend` job's install step to:

```yaml
      - name: Install deps
        run: |
          python -m pip install --upgrade pip
          pip install -r requirements-dev.txt
```

- [ ] **Step 2: Verify CI collects the new tests locally**

Run: `python -m pytest tests/ -q`
Expected: PASS — the existing suite plus 52 new warehouse tests (config 11,
store 6, manifest 9, export 14, verify 5, cli 7), no failures.

- [ ] **Step 3: Create the nightly workflow**

Create `.github/workflows/warehouse.yml`:

```yaml
name: Warehouse

# Exports finalized days to Cloudflare R2 as Parquet and verifies them against
# Postgres. Runs at 14:00 UTC, an hour after np-daily-ingest (13:00 UTC) has
# re-ingested the previous day's finals.
#
# Setup (once): repository secrets
#   SUPABASE_URL, SUPABASE_KEY  (service_role)
#   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
#
# This workflow NEVER deletes from Postgres. The prune lives in a separate job
# added in Task 17, gated on the manifest this one writes.

on:
  workflow_dispatch:
    inputs:
      date:
        description: "Single day to export (YYYY-MM-DD). Blank = yesterday."
        required: false
      backfill_start:
        description: "Backfill window start. Set both to run a backfill."
        required: false
      backfill_end:
        description: "Backfill window end."
        required: false
  schedule:
    - cron: "0 14 * * *"

concurrency:
  group: warehouse
  cancel-in-progress: false

jobs:
  export:
    runs-on: ubuntu-latest
    timeout-minutes: 120
    env:
      SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
      SUPABASE_KEY: ${{ secrets.SUPABASE_KEY }}
      R2_ACCOUNT_ID: ${{ secrets.R2_ACCOUNT_ID }}
      R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
      R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
      R2_BUCKET: ${{ secrets.R2_BUCKET }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.13"
      - name: Install deps
        run: |
          python -m pip install --upgrade pip
          pip install -r requirements-warehouse.txt

      - name: Refresh snapshots (player_info, games)
        run: python -m warehouse snapshot

      - name: Export
        run: |
          if [ -n "${{ inputs.backfill_start }}" ]; then
            python -m warehouse backfill \
              --start "${{ inputs.backfill_start }}" \
              --end "${{ inputs.backfill_end }}"
          elif [ -n "${{ inputs.date }}" ]; then
            python -m warehouse export --date "${{ inputs.date }}"
          else
            python -m warehouse export
          fi
```

- [ ] **Step 4: Commit and push so the workflow is registered**

```bash
git add .github/workflows/warehouse.yml .github/workflows/ci.yml
git commit -m "ci(warehouse): nightly export and verify to R2"
git push
```

- [ ] **Step 5: Smoke-test one day against real R2**

Run from the Actions tab: **Warehouse → Run workflow**, `date = 2026-07-28`.
Expected: green run; log shows `ok pitches 2026-07-28: ~3800 rows`, plus
`at_bats` and `predictions` lines; final JSON `{"exported": 3, "failed": 0}`.

- [ ] **Step 6: Backfill 2025**

Run: **Warehouse → Run workflow**, `backfill_start = 2025-03-27`,
`backfill_end = 2025-12-31`.
Expected: green; ~270 day-partitions per dataset. This is the long run —
allow up to two hours. If it times out, re-run with a narrower window; the
export is idempotent, so overlapping windows are safe.

- [ ] **Step 7: Backfill 2026 to date**

Run: **Warehouse → Run workflow**, `backfill_start = 2026-01-01`,
`backfill_end = 2026-07-27`.

- [ ] **Step 8: Record the measured Parquet size — the Phase A acceptance gate**

Run locally with credentials in `.env`:

```bash
python - <<'PY'
from warehouse import manifest
from warehouse.config import r2_config
from warehouse.store import R2Store

store = R2Store(r2_config())
m = manifest.load(store)
for ds in ("pitches", "at_bats", "predictions"):
    days = manifest.days(m, ds)
    total = sum(e["bytes"] for e in m["datasets"][ds].values())
    print(f"{ds:12} {len(days):4} days  {manifest.total_rows(m, ds):9,} rows  "
          f"{total / 1e6:8.1f} MB")
PY
```

**Acceptance criteria for Phase A:**
- `pitches` row total is within 1% of the 1,200,095 rows in Postgres
- `at_bats` row total is within 1% of 309,742
- zero entries in the `failed` list on the final run
- measured Parquet total is recorded in the commit message below

- [ ] **Step 9: Commit the measurement**

```bash
git commit --allow-empty -m "chore(warehouse): backfill complete

Measured Parquet footprint in R2 (replace with actual figures):
  pitches     <n> days  <n> rows  <n> MB
  at_bats     <n> days  <n> rows  <n> MB
  predictions <n> days  <n> rows  <n> MB

Postgres unchanged at 453 MB; no deletion path exists yet."
```

---

# Phase B — Training reads the warehouse (spec Phase 2)

## Task 8: DuckDB connection factory

**Files:**
- Create: `warehouse/duck.py`, `tests/warehouse/conftest.py`, `tests/warehouse/test_duck.py`

**Interfaces:**
- Consumes: `warehouse.manifest`, `warehouse.config.object_key`, `warehouse.config.snapshot_key`, `warehouse.store.ObjectStore`
- Produces: `connect(store) -> duckdb.DuckDBPyConnection`, `dataset_uris(store, manifest_obj, dataset, days=None) -> list[str]`, `register_views(con, store, manifest_obj) -> None`

`register_views` creates one DuckDB view per dataset (`pitches`, `at_bats`, `predictions`, `player_info`, `games`) over the manifest-listed Parquet files, so every query in Tasks 9 and 12 reads table names identical to the Postgres originals. **That is what makes the RPC translations near-verbatim.**

- [ ] **Step 1: Write the shared fixture**

Create `tests/warehouse/conftest.py`:

```python
"""Synthetic warehouse fixtures.

A tiny hand-built dataset written as real Parquet through the real export
path, so cell and aggregate queries are exercised against genuine files with
no R2 and no Supabase.

The numbers are chosen so expectations can be computed by hand in the tests.
"""

from __future__ import annotations

import pytest

from warehouse import manifest
from warehouse.config import object_key, snapshot_key
from warehouse.export import checksum, coerce_rows, to_parquet
from warehouse.store import LocalStore

DAY = "2026-07-28"


def _pitch(game_pk, abi, pn, *, balls, strikes, cat, speed=95.0,
           zone=5, desc="called_strike", pitcher=100, batter=200,
           pitch_type="FF"):
    return {
        "id": game_pk * 10000 + abi * 100 + pn,
        "game_pk": game_pk, "at_bat_index": abi, "pitch_number": pn,
        "pitcher_id": pitcher, "batter_id": batter,
        "pitch_type": pitch_type, "start_speed": speed, "zone": zone,
        "description": desc, "result_category": cat,
        "balls": balls, "strikes": strikes, "outs": 0, "inning": 1,
        "top_inning": True, "pitch_ts": f"{DAY}T19:0{pn}:00Z",
    }


@pytest.fixture
def synth_pitches():
    """Two at-bats. Counts are POST-pitch, as Postgres stores them.

    Game 1, AB 0 — 3 pitches:
      pn=1 post 0-1 strike_foul   (pre-count 0-0)
      pn=2 post 1-1 ball          (pre-count 0-1)
      pn=3 post 1-1 in_play       (pre-count 1-1)
    Game 1, AB 1 — 2 pitches:
      pn=1 post 1-0 ball          (pre-count 0-0)
      pn=2 post 1-1 strike_foul   (pre-count 1-0)
    """
    return [
        _pitch(1, 0, 1, balls=0, strikes=1, cat="strike_foul", speed=96.0),
        _pitch(1, 0, 2, balls=1, strikes=1, cat="ball", speed=94.0),
        _pitch(1, 0, 3, balls=1, strikes=1, cat="in_play", speed=95.0),
        _pitch(1, 1, 1, balls=1, strikes=0, cat="ball", speed=93.0),
        _pitch(1, 1, 2, balls=1, strikes=1, cat="strike_foul", speed=97.0),
    ]


@pytest.fixture
def synth_at_bats():
    return [
        {"id": 1, "game_pk": 1, "at_bat_index": 0, "pitcher_id": 100,
         "batter_id": 200, "pitch_count": 3, "result": "hit",
         "result_detail": "single", "start_ts": f"{DAY}T19:00:00Z",
         "end_ts": f"{DAY}T19:04:00Z"},
        {"id": 2, "game_pk": 1, "at_bat_index": 1, "pitcher_id": 100,
         "batter_id": 201, "pitch_count": 2, "result": "strikeout",
         "result_detail": "strikeout", "start_ts": f"{DAY}T19:05:00Z",
         "end_ts": f"{DAY}T19:08:00Z"},
    ]


@pytest.fixture
def synth_player_info():
    return [
        {"player_id": 100, "full_name": "Test Pitcher", "pitch_hand": "R",
         "bat_side": "R", "primary_position": "P"},
        {"player_id": 200, "full_name": "Test Batter A", "pitch_hand": "R",
         "bat_side": "R", "primary_position": "3B"},
        {"player_id": 201, "full_name": "Test Batter B", "pitch_hand": "L",
         "bat_side": "L", "primary_position": "CF"},
    ]


@pytest.fixture
def synth_games():
    return [{"game_pk": 1, "official_date": DAY, "status": "Final",
             "home_team": "Home", "away_team": "Away", "home_abbr": "HOM",
             "away_abbr": "AWY", "home_score": 4, "away_score": 2,
             "start_ts": f"{DAY}T18:40:00Z"}]


@pytest.fixture
def warehouse_store(tmp_path, synth_pitches, synth_at_bats,
                    synth_player_info, synth_games):
    """A LocalStore populated with the synthetic dataset and its manifest."""
    store = LocalStore(tmp_path / "warehouse")
    m = manifest.empty()
    for dataset, rows in (("pitches", synth_pitches),
                          ("at_bats", synth_at_bats)):
        shaped = coerce_rows(rows, dataset)
        blob = to_parquet(shaped, dataset)
        store.put(object_key(dataset, DAY), blob)
        manifest.record(m, dataset, DAY, rows=len(shaped),
                        size_bytes=len(blob),
                        checksum=checksum(shaped, dataset),
                        verified_at=f"{DAY}T20:00:00+00:00")
    store.put(snapshot_key("player_info"),
              to_parquet(coerce_rows(synth_player_info, "player_info"),
                         "player_info"))
    store.put(snapshot_key("games"),
              to_parquet(coerce_rows(synth_games, "games"), "games"))
    manifest.save(store, m)
    return store
```

- [ ] **Step 2: Write the failing test**

Create `tests/warehouse/test_duck.py`:

```python
from __future__ import annotations

import pytest

from warehouse import duck, manifest


def test_dataset_uris_lists_manifest_days_only(warehouse_store):
    m = manifest.load(warehouse_store)
    uris = duck.dataset_uris(warehouse_store, m, "pitches")
    assert len(uris) == 1
    assert uris[0].endswith("day=2026-07-28.parquet")


def test_dataset_uris_is_empty_for_a_dataset_with_no_days(warehouse_store):
    m = manifest.load(warehouse_store)
    assert duck.dataset_uris(warehouse_store, m, "predictions") == []


def test_register_views_exposes_postgres_table_names(warehouse_store):
    m = manifest.load(warehouse_store)
    con = duck.connect(warehouse_store)
    duck.register_views(con, warehouse_store, m)
    names = {r[0] for r in con.execute("show tables").fetchall()}
    assert {"pitches", "at_bats", "player_info", "games"} <= names


def test_registered_pitches_view_has_every_row(warehouse_store):
    m = manifest.load(warehouse_store)
    con = duck.connect(warehouse_store)
    duck.register_views(con, warehouse_store, m)
    assert con.execute("select count(*) from pitches").fetchone()[0] == 5


def test_registered_views_preserve_column_types(warehouse_store):
    m = manifest.load(warehouse_store)
    con = duck.connect(warehouse_store)
    duck.register_views(con, warehouse_store, m)
    speed = con.execute(
        "select start_speed from pitches where game_pk=1 and at_bat_index=0"
        " and pitch_number=1").fetchone()[0]
    assert speed == pytest.approx(96.0)


def test_empty_dataset_registers_as_an_empty_view(warehouse_store):
    # predictions has no partitions; the view must still exist and be queryable
    # so downstream SQL does not need to branch on presence.
    m = manifest.load(warehouse_store)
    con = duck.connect(warehouse_store)
    duck.register_views(con, warehouse_store, m)
    assert con.execute("select count(*) from predictions").fetchone()[0] == 0
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `python -m pytest tests/warehouse/test_duck.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'warehouse.duck'`

- [ ] **Step 4: Write the implementation**

Create `warehouse/duck.py`:

```python
"""DuckDB access to the warehouse.

register_views() creates one view per dataset named exactly as its Postgres
original. That is deliberate: it lets the translated training queries in
warehouse/cells.py stay near-verbatim copies of the SQL that ran as
train_*_cells() RPCs, which is what makes the metric-reproduction gate a
meaningful check rather than a coincidence.

Empty datasets register as typed empty views so downstream SQL never has to
branch on whether a partition exists.
"""

from __future__ import annotations

from warehouse.config import DATASETS, SCHEMAS, SNAPSHOTS, object_key, snapshot_key
from warehouse.manifest import days as manifest_days

# PyArrow type -> DuckDB type, for building empty typed views.
_DUCK_TYPES = {
    "int64": "BIGINT", "int32": "INTEGER", "double": "DOUBLE",
    "string": "VARCHAR", "bool": "BOOLEAN", "date32[day]": "DATE",
    "timestamp[us, tz=UTC]": "TIMESTAMP WITH TIME ZONE",
}


def connect(store):  # noqa: ANN001, ANN201
    import duckdb

    con = duckdb.connect(database=":memory:")
    configure = getattr(store, "configure_duckdb", None)
    if configure is not None:
        configure(con)
    return con


def dataset_uris(store, manifest_obj, dataset: str,  # noqa: ANN001
                 days: list[str] | None = None) -> list[str]:
    """Readable URIs for a dataset, resolved through the manifest.

    Never lists the bucket — the manifest is the index.
    """
    available = manifest_days(manifest_obj, dataset)
    wanted = available if days is None else [d for d in days if d in available]
    return [store.uri(object_key(dataset, day)) for day in wanted]


def _empty_view_sql(dataset: str) -> str:
    cols = ", ".join(
        f"cast(null as {_DUCK_TYPES[str(f.type)]}) as {f.name}"
        for f in SCHEMAS[dataset]
    )
    return f"create or replace view {dataset} as select {cols} where false"


def register_views(con, store, manifest_obj) -> None:  # noqa: ANN001
    """Register every dataset and snapshot as a DuckDB view."""
    for dataset in DATASETS:
        uris = dataset_uris(store, manifest_obj, dataset)
        if not uris:
            con.execute(_empty_view_sql(dataset))
            continue
        listed = ", ".join(f"'{u}'" for u in uris)
        con.execute(
            f"create or replace view {dataset} as "
            f"select * from read_parquet([{listed}], union_by_name = true)"
        )
    for dataset in SNAPSHOTS:
        key = snapshot_key(dataset)
        if not store.exists(key):
            con.execute(_empty_view_sql(dataset))
            continue
        con.execute(
            f"create or replace view {dataset} as "
            f"select * from read_parquet('{store.uri(key)}')"
        )
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `python -m pytest tests/warehouse/test_duck.py -v`
Expected: PASS, 6 tests

- [ ] **Step 6: Commit**

```bash
git add warehouse/duck.py tests/warehouse/conftest.py tests/warehouse/test_duck.py
git commit -m "feat(warehouse): DuckDB views mirroring Postgres table names"
```

---

## Task 9: Translate the four training cell queries

**Files:**
- Create: `warehouse/cells.py`, `tests/warehouse/test_cells.py`

**Interfaces:**
- Consumes: `warehouse.duck.connect`, `warehouse.duck.register_views`, `warehouse.manifest.load`
- Produces: `pitch_result_cells(con) -> list[dict]`, `ab_result_cells(con) -> list[dict]`, `pitch_speed_cells(con) -> list[dict]`, `ab_pitches_cells(con) -> list[dict]`, `all_cells(store) -> dict[str, list[dict]]`

Return shapes match the RPCs they replace exactly, because `scripts/train_models.py` consumes them unchanged:

| Function | Keys per row |
|---|---|
| `pitch_result_cells` | `balls`, `strikes`, `zone_bucket`, `chase_bucket`, `outcome`, `n` |
| `ab_result_cells` | `balls`, `strikes`, `pk_bucket`, `bk_bucket`, `platoon_same`, `outcome`, `n` |
| `pitch_speed_cells` | `velo_bucket`, `balls`, `strikes`, `pitch_of_pa`, `n`, `mean_speed`, `var_speed` |
| `ab_pitches_cells` | `balls`, `strikes`, `remaining`, `n` |

**`train_home_advantage` is NOT translated.** It reads only `games`, which the
prune never touches, so it stays a Postgres RPC.

### The rounding hazard — read before writing the SQL

Three of these queries bucket a rate with `round((x - c) / step)`. In Postgres
`x` is `numeric` and `round(numeric)` rounds half **away from zero**. In DuckDB
the same expression on a `DOUBLE` rounds half away from zero as well, but the
division is binary floating point, so a value landing exactly on `.5` can fall
either side of the boundary and shift a row into a neighbouring bucket.

**Mitigation, applied in every translated query:** cast the rate to
`DECIMAL(18,9)` before the arithmetic, matching Postgres `numeric` semantics.
This is the single most likely cause of a metric-reproduction failure in
Task 10; if metrics come out close but not equal, look here first.

- [ ] **Step 1: Write the failing test**

Create `tests/warehouse/test_cells.py`:

```python
from __future__ import annotations

import pytest

from warehouse import cells, duck, manifest


@pytest.fixture
def con(warehouse_store):
    m = manifest.load(warehouse_store)
    c = duck.connect(warehouse_store)
    duck.register_views(c, warehouse_store, m)
    return c


def _by(rows, **match):
    out = [r for r in rows if all(r[k] == v for k, v in match.items())]
    assert len(out) == 1, f"expected exactly one row for {match}, got {out}"
    return out[0]


def test_pitch_result_cells_uses_the_pre_pitch_count(con):
    """The RPC lags balls/strikes so a cell describes the count BEFORE the
    pitch. Fixture AB 0 pitch 1 is stored post-count 0-1; its cell is 0-0."""
    rows = cells.pitch_result_cells(con)
    cell = _by(rows, balls=0, strikes=0, outcome="strike_foul")
    assert cell["n"] == 1


def test_pitch_result_cells_counts_the_second_pitch_at_its_pre_count(con):
    # AB 0 pitch 2 is a ball stored post 1-1, pre-count 0-1.
    rows = cells.pitch_result_cells(con)
    assert _by(rows, balls=0, strikes=1, outcome="ball")["n"] == 1


def test_pitch_result_cells_aggregates_across_at_bats(con):
    # AB 0 pitch 1 (strike_foul) and AB 1 pitch 1 (ball) both sit at pre 0-0.
    rows = cells.pitch_result_cells(con)
    assert _by(rows, balls=0, strikes=0, outcome="ball")["n"] == 1


def test_pitch_result_cells_total_equals_pitch_count(con):
    # Every fixture pitch has a result_category and an in-range pre-count.
    assert sum(r["n"] for r in cells.pitch_result_cells(con)) == 5


def test_pitch_result_buckets_default_to_zero_below_the_sample_floor(con):
    # The RPC requires >=100 pitches per pitcher/batter before it computes a
    # zone or chase rate; the fixture has 5, so every bucket coalesces to 0.
    for row in cells.pitch_result_cells(con):
        assert row["zone_bucket"] == 0
        assert row["chase_bucket"] == 0


def test_pitch_speed_cells_are_empty_below_the_sample_floors(con):
    # Two floors, and the fixture's 5 pitches clear neither: pitcher_velo
    # requires >=50 fastballs per pitcher (the binding one here, since the
    # inner join then matches nothing), and the outer query requires >=20 rows
    # per cell.
    assert cells.pitch_speed_cells(con) == []


def test_ab_pitches_cells_include_the_pre_at_bat_state(con):
    """The RPC unions a 0-0 row per at-bat whose `remaining` is the full pitch
    count: AB 0 has 3, AB 1 has 2."""
    rows = cells.ab_pitches_cells(con)
    assert _by(rows, balls=0, strikes=0, remaining=3)["n"] == 1
    assert _by(rows, balls=0, strikes=0, remaining=2)["n"] == 1


def test_ab_pitches_cells_use_post_pitch_counts_for_mid_at_bat_states(con):
    # AB 0 pitch 1 is post 0-1 with pitch_count 3 -> remaining 2.
    rows = cells.ab_pitches_cells(con)
    assert _by(rows, balls=0, strikes=1, remaining=2)["n"] == 1


def test_ab_pitches_cells_exclude_the_final_pitch_of_an_at_bat(con):
    # `p.pitch_number < a.pitch_count` drops the last pitch, so no row has
    # remaining = 0.
    assert all(r["remaining"] >= 1 for r in cells.ab_pitches_cells(con))


def test_ab_result_cells_include_the_pre_at_bat_state(con):
    rows = cells.ab_result_cells(con)
    assert _by(rows, balls=0, strikes=0, outcome="hit")["n"] == 1
    assert _by(rows, balls=0, strikes=0, outcome="strikeout")["n"] == 1


def test_ab_result_cells_flag_a_same_handed_matchup(con):
    # Pitcher 100 is R; batter 200 is R (same, 1); batter 201 is L (0).
    rows = cells.ab_result_cells(con)
    assert _by(rows, balls=0, strikes=0, outcome="hit")["platoon_same"] == 1
    assert _by(rows, balls=0, strikes=0, outcome="strikeout")["platoon_same"] == 0


def test_ab_result_buckets_default_to_zero_below_the_sample_floor(con):
    for row in cells.ab_result_cells(con):
        assert row["pk_bucket"] == 0
        assert row["bk_bucket"] == 0


def test_all_cells_returns_one_entry_per_translated_market(warehouse_store):
    got = cells.all_cells(warehouse_store)
    assert set(got) == {"pitch_result", "ab_result",
                        "pitch_speed_ou", "ab_pitches_ou"}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest tests/warehouse/test_cells.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'warehouse.cells'`

- [ ] **Step 3: Write the implementation**

Create `warehouse/cells.py`:

```python
"""Training cells, computed in DuckDB over the R2 Parquet warehouse.

These are line-by-line translations of the train_*_cells() Postgres functions
they replace. The output shape is identical so scripts/train_models.py keeps
every fit_* function unchanged — only its data source moves.

Two deliberate choices:

1. Rates are cast to DECIMAL(18,9) before bucket arithmetic. Postgres computes
   these on `numeric`; leaving them as DOUBLE lets a value sitting exactly on a
   bucket boundary land on the other side and shifts rows between cells. This
   is the first thing to check if Task 10's metric reproduction comes close but
   not equal.

2. train_home_advantage is not here. It reads only `games`, which the hot-window
   prune never touches, so it stays a Postgres RPC.

Source of truth for the originals:
    select pg_get_functiondef(oid) from pg_proc where proname like 'train_%';
"""

from __future__ import annotations

from warehouse import duck, manifest

# ── pitch_result ────────────────────────────────────────────────────────────
# Postgres original: train_pitch_result_cells()
PITCH_RESULT_SQL = """
with pitcher_zone as (
    select pitcher_id,
        avg(case when zone between 1 and 9 then 1.0 else 0.0 end) as zr
    from pitches
    where pitcher_id is not null and zone is not null
    group by pitcher_id having count(*) >= 100
),
batter_chase as (
    select batter_id,
        cast(count(*) filter (
              where (description in ('swinging_strike','foul')
                     or result_category = 'in_play') and zone > 9
            ) as double)
          / nullif(count(*) filter (where zone > 9), 0) as cr
    from pitches
    where batter_id is not null and zone is not null
    group by batter_id having count(*) >= 100
),
seq as (
    select p.game_pk, p.at_bat_index, p.pitch_number, p.pitcher_id,
        p.batter_id, p.result_category,
        coalesce(lag(p.balls) over w, 0) as pre_balls,
        coalesce(lag(p.strikes) over w, 0) as pre_strikes
    from pitches p
    window w as (partition by p.game_pk, p.at_bat_index order by p.pitch_number)
)
select
    s.pre_balls as balls,
    s.pre_strikes as strikes,
    cast(least(2, greatest(-2, coalesce(
        round((cast(pz.zr as decimal(18,9)) - 0.48) / 0.03), 0))) as integer)
        as zone_bucket,
    cast(least(2, greatest(-2, coalesce(
        round((cast(bc.cr as decimal(18,9)) - 0.28) / 0.04), 0))) as integer)
        as chase_bucket,
    s.result_category as outcome,
    count(*) as n
from seq s
left join pitcher_zone pz on pz.pitcher_id = s.pitcher_id
left join batter_chase bc on bc.batter_id = s.batter_id
where s.result_category is not null
  and s.pre_balls between 0 and 3
  and s.pre_strikes between 0 and 2
group by 1, 2, 3, 4, 5
"""

# ── ab_result ───────────────────────────────────────────────────────────────
# Postgres original: train_ab_result_cells()
AB_RESULT_SQL = """
with pitcher_k as (
    select pitcher_id,
        avg(case when result = 'strikeout' then 1.0 else 0.0 end) as kr,
        avg(case when result = 'walk' then 1.0 else 0.0 end) as br
    from at_bats where pitcher_id is not null
    group by pitcher_id having count(*) >= 50
),
batter_k as (
    select batter_id,
        avg(case when result = 'strikeout' then 1.0 else 0.0 end) as kr
    from at_bats where batter_id is not null
    group by batter_id having count(*) >= 50
),
states as (
    select a.game_pk, a.at_bat_index, a.pitcher_id, a.batter_id, a.result,
           0 as balls, 0 as strikes
    from at_bats a where a.result is not null
    union all
    select a.game_pk, a.at_bat_index, a.pitcher_id, a.batter_id, a.result,
           p.balls, p.strikes
    from at_bats a
    join pitches p
      on p.game_pk = a.game_pk and p.at_bat_index = a.at_bat_index
    where a.result is not null and p.pitch_number < a.pitch_count
      and p.balls between 0 and 3 and p.strikes between 0 and 2
)
select
    st.balls as balls,
    st.strikes as strikes,
    cast(least(2, greatest(-2, coalesce(
        round((cast(pk.kr as decimal(18,9)) - 0.221) / 0.035), 0))) as integer)
        as pk_bucket,
    cast(least(2, greatest(-2, coalesce(
        round((cast(bk.kr as decimal(18,9)) - 0.221) / 0.035), 0))) as integer)
        as bk_bucket,
    case when pi.pitch_hand is not null and bi.bat_side in ('L','R')
              and pi.pitch_hand = bi.bat_side then 1 else 0 end as platoon_same,
    st.result as outcome,
    count(*) as n
from states st
left join pitcher_k pk on pk.pitcher_id = st.pitcher_id
left join batter_k bk on bk.batter_id = st.batter_id
left join player_info pi on pi.player_id = st.pitcher_id
left join player_info bi on bi.player_id = st.batter_id
group by 1, 2, 3, 4, 5, 6
"""

# ── pitch_speed_ou ──────────────────────────────────────────────────────────
# Postgres original: train_pitch_speed_cells()
PITCH_SPEED_SQL = """
with pitcher_velo as (
    select pitcher_id,
        avg(start_speed) filter (
            where pitch_type in ('FF','FT','SI','FC')) as fb
    from pitches
    where pitcher_id is not null and start_speed is not null
    group by pitcher_id
    having count(*) filter (where pitch_type in ('FF','FT','SI','FC')) >= 50
),
seq as (
    select p.pitcher_id, p.start_speed, p.pitch_number,
        coalesce(lag(p.balls) over w, 0) as pre_balls,
        coalesce(lag(p.strikes) over w, 0) as pre_strikes
    from pitches p
    where p.start_speed is not null
    window w as (partition by p.game_pk, p.at_bat_index order by p.pitch_number)
)
select
    cast(round(cast(pv.fb as decimal(18,9))) as double) as velo_bucket,
    s.pre_balls as balls,
    s.pre_strikes as strikes,
    least(s.pitch_number, 8) as pitch_of_pa,
    count(*) as n,
    avg(s.start_speed) as mean_speed,
    var_samp(s.start_speed) as var_speed
from seq s
join pitcher_velo pv on pv.pitcher_id = s.pitcher_id
where s.pre_balls between 0 and 3 and s.pre_strikes between 0 and 2
group by 1, 2, 3, 4
having count(*) >= 20
"""

# ── ab_pitches_ou ───────────────────────────────────────────────────────────
# Postgres original: train_ab_pitches_cells()
AB_PITCHES_SQL = """
with states as (
    select 0 as balls, 0 as strikes, a.pitch_count as remaining
    from at_bats a
    where a.pitch_count is not null and a.pitch_count > 0
    union all
    select p.balls, p.strikes, a.pitch_count - p.pitch_number
    from at_bats a
    join pitches p
      on p.game_pk = a.game_pk and p.at_bat_index = a.at_bat_index
    where a.pitch_count is not null and p.pitch_number < a.pitch_count
      and p.balls between 0 and 3 and p.strikes between 0 and 2
)
select balls, strikes, least(remaining, 12) as remaining, count(*) as n
from states where remaining >= 1
group by 1, 2, 3
"""


def _rows(con, sql: str) -> list[dict]:  # noqa: ANN001
    cur = con.execute(sql)
    names = [d[0] for d in cur.description]
    return [dict(zip(names, row)) for row in cur.fetchall()]


def pitch_result_cells(con) -> list[dict]:  # noqa: ANN001
    return _rows(con, PITCH_RESULT_SQL)


def ab_result_cells(con) -> list[dict]:  # noqa: ANN001
    return _rows(con, AB_RESULT_SQL)


def pitch_speed_cells(con) -> list[dict]:  # noqa: ANN001
    return _rows(con, PITCH_SPEED_SQL)


def ab_pitches_cells(con) -> list[dict]:  # noqa: ANN001
    return _rows(con, AB_PITCHES_SQL)


def all_cells(store) -> dict[str, list[dict]]:  # noqa: ANN001
    """Every translated market's cells, keyed by market name."""
    m = manifest.load(store)
    con = duck.connect(store)
    duck.register_views(con, store, m)
    return {
        "pitch_result": pitch_result_cells(con),
        "ab_result": ab_result_cells(con),
        "pitch_speed_ou": pitch_speed_cells(con),
        "ab_pitches_ou": ab_pitches_cells(con),
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python -m pytest tests/warehouse/test_cells.py -v`
Expected: PASS, 13 tests

- [ ] **Step 5: Commit**

```bash
git add warehouse/cells.py tests/warehouse/test_cells.py
git commit -m "feat(warehouse): DuckDB translations of the four training cell queries"
```

---

## Task 10: Point `train_models.py` at the warehouse and prove the metrics

**Files:**
- Modify: `scripts/train_models.py`
- Create: `tests/warehouse/test_train_source.py`

**Interfaces:**
- Consumes: `warehouse.cells.all_cells`
- Produces: `cells_for(market: str) -> list[dict]` inside `train_models.py`, replacing `rpc(name)` for the four translated markets

**This task carries the acceptance gate for Phase B. Do not proceed past it on close-but-unequal numbers.**

- [ ] **Step 1: Write the failing test**

Create `tests/warehouse/test_train_source.py`:

```python
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import scripts.train_models as tm


def test_cell_sources_cover_the_four_translated_markets():
    assert set(tm.CELL_SOURCES) == {
        "train_pitch_result_cells", "train_ab_result_cells",
        "train_pitch_speed_cells", "train_ab_pitches_cells",
    }


def test_home_advantage_is_not_a_warehouse_source():
    # It reads `games`, which the hot-window prune never touches, so it stays
    # a Postgres RPC.
    assert "train_home_advantage" not in tm.CELL_SOURCES


def test_cells_for_reads_the_warehouse(monkeypatch):
    captured = {}

    def fake_all_cells(store):
        captured["called"] = True
        return {"pitch_result": [{"balls": 0, "strikes": 0, "n": 7}]}

    monkeypatch.setattr(tm, "_warehouse_cells", fake_all_cells)
    monkeypatch.setattr(tm, "_warehouse_store", lambda: object())
    tm._CELL_CACHE.clear()
    rows = tm.cells_for("train_pitch_result_cells")
    assert captured["called"] is True
    assert rows == [{"balls": 0, "strikes": 0, "n": 7}]


def test_cells_for_caches_across_markets(monkeypatch):
    calls = []

    def fake_all_cells(store):
        calls.append(1)
        return {"pitch_result": [], "ab_result": []}

    monkeypatch.setattr(tm, "_warehouse_cells", fake_all_cells)
    monkeypatch.setattr(tm, "_warehouse_store", lambda: object())
    tm._CELL_CACHE.clear()
    tm.cells_for("train_pitch_result_cells")
    tm.cells_for("train_ab_result_cells")
    assert len(calls) == 1, "warehouse should be read once per process"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest tests/warehouse/test_train_source.py -v`
Expected: FAIL — `AttributeError: module 'scripts.train_models' has no attribute 'CELL_SOURCES'`

- [ ] **Step 3: Modify `scripts/train_models.py`**

Replace the `rpc()` function (currently lines 49–52) with:

```python
# Cell queries that moved to the DuckDB/R2 warehouse when pitches and at_bats
# stopped holding full history in Postgres. train_home_advantage is absent on
# purpose: it reads only `games`, which the hot-window prune never touches, so
# it is still a Postgres RPC.
CELL_SOURCES = {
    "train_pitch_result_cells": "pitch_result",
    "train_ab_result_cells": "ab_result",
    "train_pitch_speed_cells": "pitch_speed_ou",
    "train_ab_pitches_cells": "ab_pitches_ou",
}

_CELL_CACHE: dict[str, list[dict]] = {}


def _warehouse_store():
    from warehouse.config import r2_config
    from warehouse.store import R2Store

    return R2Store(r2_config())


def _warehouse_cells(store):
    from warehouse.cells import all_cells

    return all_cells(store)


def cells_for(name: str) -> list[dict]:
    """Training cells for one market, read from the warehouse.

    Every market's cells come from a single DuckDB session, so the warehouse is
    scanned once per process rather than once per market.
    """
    if not _CELL_CACHE:
        _CELL_CACHE.update(_warehouse_cells(_warehouse_store()))
    market = CELL_SOURCES[name]
    rows = _CELL_CACHE.get(market, [])
    print(f"[train] {name}: {len(rows)} cells (warehouse)")
    return rows


def rpc(name: str) -> list[dict]:
    """Postgres RPC. Only train_home_advantage still uses this path."""
    rows = get_client().rpc(name, {}).execute().data or []
    print(f"[train] {name}: {len(rows)} cells (postgres)")
    return rows
```

Then change the four call sites from `rpc(...)` to `cells_for(...)`:

- in `train_pitch_result`: `cells = cells_for("train_pitch_result_cells")`
- in `train_ab_result`: `cells = cells_for("train_ab_result_cells")`
- in `train_pitch_speed`: `cells = cells_for("train_pitch_speed_cells")`
- in `train_ab_pitches`: `cells = cells_for("train_ab_pitches_cells")`

Leave `train_moneyline` calling `rpc("train_home_advantage")` unchanged.

Update the module docstring's second paragraph to read:

```
Data comes from the DuckDB/R2 warehouse (warehouse/cells.py) as weighted
aggregate cells, so this works over millions of pitches with tiny transfers.
The moneyline's home-advantage rate still comes from a Postgres RPC because it
reads `games`, which is never pruned. Fitted parameters are written to the
model_params table with is_active=true; the live-poll edge function
(supabase/functions/_shared/model.ts) scores with them directly.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python -m pytest tests/warehouse/test_train_source.py -v`
Expected: PASS, 4 tests

- [ ] **Step 5: Diagnose the pre-existing workflow failure**

Before trusting any comparison, find out why the Monday schedule has produced
nothing since 2026-07-07.

Run: `gh run list --workflow=train-models.yml --limit 10`
Then: `gh run view <most-recent-failed-id> --log-failed`

Record the cause in the commit message in Step 8. A migrated job that was
already broken would confound the gate below.

- [ ] **Step 6: Run the acceptance gate**

With R2 and Supabase credentials in `.env`:

Run: `python scripts/train_models.py --dry-run`

Expected output — metrics matching the active `v1_20260707` rows within 1%:

```
[train] train_pitch_result_cells: 899 cells (warehouse)
[train] pitch_result v1_<today> inactive (dry-run) metrics={"weighted_logloss": 1.01565, "cells": 899, "rows": 1122199}
[train] train_ab_result_cells: 2400 cells (warehouse)
[train] ab_result v1_<today> inactive (dry-run) metrics={"weighted_logloss": 1.23678, "cells": 2400, "rows": 1122381}
[train] pitch_speed_ou … metrics={"r2_cells": 0.9686, "sigma": 5.374, "rows": 1111519}
[train] ab_pitches_ou … metrics={"states": 12, "rows": 1121660}
[train] train_home_advantage: 1 cells (postgres)
[train] game_moneyline … metrics={"games": 3784, "home_win_rate": 0.5359}
```

**Gate:** all four of `weighted_logloss` 1.01565, `weighted_logloss` 1.23678,
`sigma` 5.374, `r2_cells` 0.9686 reproduce within 1%.

**If cell counts match but metrics differ slightly:** the `DECIMAL(18,9)` casts
in `warehouse/cells.py` are the prime suspect (see the rounding note in Task 9).
Compare cell-by-cell:

```bash
python - <<'PY'
from warehouse.cells import all_cells
from warehouse.config import r2_config
from warehouse.store import R2Store
from backend.db.client import get_client

wh = all_cells(R2Store(r2_config()))["pitch_result"]
pg = get_client().rpc("train_pitch_result_cells", {}).execute().data
key = lambda r: (r["balls"], r["strikes"], r["zone_bucket"],
                 r["chase_bucket"], r["outcome"])
a, b = {key(r): r["n"] for r in wh}, {key(r): r["n"] for r in pg}
for k in sorted(set(a) | set(b)):
    if a.get(k) != b.get(k):
        print("DIFF", k, "warehouse:", a.get(k), "postgres:", b.get(k))
PY
```

**Do not proceed to Task 11 until the gate passes.**

- [ ] **Step 7: Update the training workflow**

In `.github/workflows/train-models.yml`:

- change `python-version: "3.11"` to `"3.13"`
- change the install step to `pip install -r requirements-train.txt -r requirements-warehouse.txt`
- add the four R2 secrets to the `Train` step's `env` block alongside the two Supabase ones:

```yaml
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_KEY: ${{ secrets.SUPABASE_KEY }}
          R2_ACCOUNT_ID: ${{ secrets.R2_ACCOUNT_ID }}
          R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
          R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
          R2_BUCKET: ${{ secrets.R2_BUCKET }}
```

- [ ] **Step 8: Commit**

```bash
git add scripts/train_models.py .github/workflows/train-models.yml tests/warehouse/test_train_source.py
git commit -m "feat(train): read training cells from the R2 warehouse

Metric reproduction against v1_20260707 (fill in actuals):
  pitch_result   weighted_logloss <n> vs 1.01565
  ab_result      weighted_logloss <n> vs 1.23678
  pitch_speed_ou sigma <n> vs 5.374, r2_cells <n> vs 0.9686
  game_moneyline unchanged (still a Postgres RPC over games)

Pre-existing train-models.yml failure since 2026-07-07: <cause from Step 5>"
```

- [ ] **Step 9: Confirm a real run in Actions**

Run: **Train models → Run workflow**
Expected: green, and a new `v1_<today>` row per market. Verify:

```bash
python scripts/models.py list
```

---

## Task 11: Verify live scoring is unaffected

**Files:** none modified — this is a verification gate.

- [ ] **Step 1: Confirm the newly trained versions are live**

Run: `python scripts/models.py status --days 3`
Expected: active version matches `predictions.model_version` for each market —
no mismatch warning.

- [ ] **Step 2: Confirm the API still reports healthy**

Run: `curl -s https://gfxpchtyncgsczqdvohr.functions.supabase.co/api/health | python -m json.tool`
Expected: `"status": "ok"`, `data_fresh: true`, `active_models` listing five
markets at the new version.

- [ ] **Step 3: Commit the verification note**

```bash
git commit --allow-empty -m "chore: confirm live scoring unaffected by warehouse training

models.py status shows no version mismatch; /api/health reports five active
models at v1_<today>."
```

---

# Phase C — Aggregates published nightly (spec Phase 3)

## Task 12: Aggregate computations

**Files:**
- Create: `warehouse/aggregates.py`, `tests/warehouse/test_aggregates.py`

**Interfaces:**
- Consumes: `warehouse.duck`, `warehouse.manifest`
- Produces: `matchup_history(con) -> list[dict]`, `pitcher_profiles(con) -> list[dict]`, `batter_profiles(con) -> list[dict]`, `pitcher_fatigue_profile(con) -> list[dict]`, `market_baselines(con) -> list[dict]`, `all_aggregates(store) -> dict[str, list[dict]]`

Row shapes, which Task 13's migration and publisher must match exactly:

| Aggregate | Columns |
|---|---|
| `matchup_history` | `pitcher_id`, `batter_id`, `pa_count`, `so_count`, `bb_count`, `h_count` |
| `pitcher_profiles` | `pitcher_id`, `scope`, `pitches`, `zone_rate`, `whiff_rate`, `chase_rate`, `fb_velo`, `os_velo` |
| `batter_profiles` | `batter_id`, `scope`, `pitches`, `chase_rate`, `contact_rate`, `k_rate`, `bb_rate` |
| `pitcher_fatigue_profile` | `pitcher_id`, `bucket`, `pitches`, `mean_velo`, `velo_delta` |
| `market_baselines` | `market`, `baseline_outcome`, `baseline_rate`, `n` |

`scope` is `'career'` or `'d30'`. `bucket` is the in-game pitch-count bucket
(`0` = pitches 1–15, `1` = 16–30, …), and `velo_delta` is that bucket's mean
velocity minus bucket 0's.

- [ ] **Step 1: Write the failing test**

Create `tests/warehouse/test_aggregates.py`:

```python
from __future__ import annotations

import pytest

from warehouse import aggregates, duck, manifest


@pytest.fixture
def con(warehouse_store):
    m = manifest.load(warehouse_store)
    c = duck.connect(warehouse_store)
    duck.register_views(c, warehouse_store, m)
    return c


def test_matchup_history_needs_three_plate_appearances(con):
    # Fixture has 1 PA for (100,200) and 1 for (100,201) — below the floor the
    # Postgres original used (`having count(*) >= 3`).
    assert aggregates.matchup_history(con) == []


def test_matchup_history_counts_outcomes(con):
    con.execute("""
        create or replace view at_bats as
        select * from (values
            (1, 1, 0, 100, 200, 4, 'strikeout'),
            (2, 1, 1, 100, 200, 3, 'walk'),
            (3, 1, 2, 100, 200, 5, 'hit')
        ) as t(id, game_pk, at_bat_index, pitcher_id, batter_id,
               pitch_count, result)
    """)
    rows = aggregates.matchup_history(con)
    assert len(rows) == 1
    row = rows[0]
    assert (row["pitcher_id"], row["batter_id"]) == (100, 200)
    assert row["pa_count"] == 3
    assert row["so_count"] == 1
    assert row["bb_count"] == 1
    assert row["h_count"] == 1


def test_pitcher_profiles_cover_both_scopes(con):
    scopes = {r["scope"] for r in aggregates.pitcher_profiles(con)}
    assert scopes <= {"career", "d30"}
    assert "career" in scopes


def test_pitcher_profile_zone_rate_matches_the_fixture(con):
    # All 5 fixture pitches have zone=5, which is inside the strike zone (1-9).
    career = [r for r in aggregates.pitcher_profiles(con)
              if r["scope"] == "career" and r["pitcher_id"] == 100]
    assert len(career) == 1
    assert career[0]["pitches"] == 5
    assert career[0]["zone_rate"] == pytest.approx(1.0)


def test_pitcher_profile_fastball_velocity_is_the_fixture_mean(con):
    # Every fixture pitch is FF at 96, 94, 95, 93, 97 -> mean 95.0
    career = [r for r in aggregates.pitcher_profiles(con)
              if r["scope"] == "career" and r["pitcher_id"] == 100][0]
    assert career["fb_velo"] == pytest.approx(95.0)


def test_batter_profiles_are_one_row_per_batter_and_scope(con):
    rows = [r for r in aggregates.batter_profiles(con) if r["scope"] == "career"]
    assert {r["batter_id"] for r in rows} == {200}


def test_market_baselines_pick_the_most_common_outcome(con):
    con.execute("""
        create or replace view at_bats as
        select * from (values
            (1, 1, 0, 100, 200, 4, 'out'),
            (2, 1, 1, 100, 200, 3, 'out'),
            (3, 1, 2, 100, 200, 5, 'strikeout')
        ) as t(id, game_pk, at_bat_index, pitcher_id, batter_id,
               pitch_count, result)
    """)
    rows = {r["market"]: r for r in aggregates.market_baselines(con)}
    assert rows["ab_result"]["baseline_outcome"] == "out"
    assert rows["ab_result"]["baseline_rate"] == pytest.approx(2 / 3)
    assert rows["ab_result"]["n"] == 3


def test_market_baselines_break_a_tie_deterministically(con):
    """The fixture is a deliberate tie: 2 strike_foul, 2 ball, 1 in_play.

    `order by n desc, outcome` breaks it alphabetically, so 'ball' wins. The
    point of this test is that a tie resolves the same way on every run — a
    non-deterministic baseline would make the accuracy surface jitter between
    nightly publishes for no real reason.
    """
    rows = {r["market"]: r for r in aggregates.market_baselines(con)}
    assert rows["pitch_result"]["baseline_outcome"] == "ball"
    assert rows["pitch_result"]["baseline_rate"] == pytest.approx(2 / 5)
    assert rows["pitch_result"]["n"] == 5


def test_fatigue_profile_buckets_by_in_game_pitch_count(con):
    rows = aggregates.pitcher_fatigue_profile(con)
    assert {r["pitcher_id"] for r in rows} == {100}
    # All 5 fixture pitches fall in bucket 0 (pitches 1-15 of the start).
    assert [r["bucket"] for r in rows] == [0]
    assert rows[0]["velo_delta"] == pytest.approx(0.0)


def test_all_aggregates_returns_every_table(warehouse_store):
    got = aggregates.all_aggregates(warehouse_store)
    assert set(got) == {"matchup_history", "pitcher_profiles",
                        "batter_profiles", "pitcher_fatigue_profile",
                        "market_baselines"}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest tests/warehouse/test_aggregates.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'warehouse.aggregates'`

- [ ] **Step 3: Write the implementation**

Create `warehouse/aggregates.py`:

```python
"""Display aggregates, computed in DuckDB over full history.

These are published back into Supabase as small tables (warehouse/publish.py).
Everything here feeds display surfaces on the Data Feed. The one exception is
matchup_history, which the live scorer also reads — it moved here because
refresh_matchup_history() scanned all of at_bats with no time window and could
not survive the hot-window prune.

Deliberate non-goal: the d30 scope duplicates pitcher_rolling_stats /
batter_rolling_stats, which stay in Postgres. Those remain authoritative for
LIVE SCORING; these copies are for display only. A warehouse outage therefore
degrades a panel, never the model.
"""

from __future__ import annotations

from warehouse import duck, manifest

# In-game pitch-count bucket width for the fatigue curve.
FATIGUE_BUCKET_PITCHES = 15

MATCHUP_HISTORY_SQL = """
select pitcher_id, batter_id,
    count(*) as pa_count,
    count(*) filter (where result = 'strikeout') as so_count,
    count(*) filter (where result = 'walk') as bb_count,
    count(*) filter (where result = 'hit') as h_count
from at_bats
where pitcher_id is not null and batter_id is not null
group by pitcher_id, batter_id
having count(*) >= 3
"""

# `scope` is materialised by a cross join against a two-row scope list so
# career and d30 come out of one scan.
PITCHER_PROFILES_SQL = f"""
with scoped as (
    select p.*, s.scope
    from pitches p
    cross join (select 'career' as scope union all select 'd30') s
    where p.pitcher_id is not null
      and (s.scope = 'career'
           or p.pitch_ts >= (select max(pitch_ts) from pitches)
                            - interval 30 day)
)
select pitcher_id, scope,
    count(*) as pitches,
    avg(case when zone between 1 and 9 then 1.0 else 0.0 end) as zone_rate,
    cast(count(*) filter (where description = 'swinging_strike') as double)
      / nullif(count(*), 0) as whiff_rate,
    cast(count(*) filter (
          where (description in ('swinging_strike','foul')
                 or result_category = 'in_play') and zone > 9
        ) as double)
      / nullif(count(*) filter (where zone > 9), 0) as chase_rate,
    avg(start_speed) filter (where pitch_type in ('FF','FT','SI','FC'))
      as fb_velo,
    avg(start_speed) filter (where pitch_type not in ('FF','FT','SI','FC'))
      as os_velo
from scoped
group by pitcher_id, scope
"""

BATTER_PROFILES_SQL = """
with scoped as (
    select p.*, s.scope
    from pitches p
    cross join (select 'career' as scope union all select 'd30') s
    where p.batter_id is not null
      and (s.scope = 'career'
           or p.pitch_ts >= (select max(pitch_ts) from pitches)
                            - interval 30 day)
),
pitch_side as (
    select batter_id, scope,
        count(*) as pitches,
        cast(count(*) filter (
              where (description in ('swinging_strike','foul')
                     or result_category = 'in_play') and zone > 9
            ) as double)
          / nullif(count(*) filter (where zone > 9), 0) as chase_rate,
        cast(count(*) filter (
              where description = 'foul' or result_category = 'in_play'
            ) as double)
          / nullif(count(*) filter (
              where description in ('swinging_strike','foul')
                 or result_category = 'in_play'), 0) as contact_rate
    from scoped group by batter_id, scope
),
ab_side as (
    select batter_id,
        avg(case when result = 'strikeout' then 1.0 else 0.0 end) as k_rate,
        avg(case when result = 'walk' then 1.0 else 0.0 end) as bb_rate
    from at_bats where batter_id is not null group by batter_id
)
select ps.batter_id, ps.scope, ps.pitches, ps.chase_rate, ps.contact_rate,
    ab.k_rate, ab.bb_rate
from pitch_side ps
left join ab_side ab on ab.batter_id = ps.batter_id
"""

# Cumulative pitch count within a start, bucketed, with each bucket's mean
# velocity expressed as a delta from the pitcher's own first bucket. That
# delta is the "is he tiring?" signal; absolute velocity is already on the
# pitcher profile.
PITCHER_FATIGUE_SQL = f"""
with numbered as (
    select pitcher_id, game_pk, start_speed,
        row_number() over (
            partition by pitcher_id, game_pk
            order by at_bat_index, pitch_number) as game_pitch_no
    from pitches
    where pitcher_id is not null and start_speed is not null
),
bucketed as (
    select pitcher_id,
        cast((game_pitch_no - 1) / {FATIGUE_BUCKET_PITCHES} as integer) as bucket,
        count(*) as pitches,
        avg(start_speed) as mean_velo
    from numbered
    group by pitcher_id, bucket
),
base as (
    select pitcher_id, mean_velo as base_velo
    from bucketed where bucket = 0
)
select b.pitcher_id, b.bucket, b.pitches, b.mean_velo,
    b.mean_velo - base.base_velo as velo_delta
from bucketed b
join base on base.pitcher_id = b.pitcher_id
order by b.pitcher_id, b.bucket
"""

# The honest denominator for the accuracy surface: always guessing the most
# common outcome. Without this, a 52.5% win rate reads as a win rather than
# +6.1 points over a trivial guess.
MARKET_BASELINES_SQL = """
with pitch_outcomes as (
    select 'pitch_result' as market, result_category as outcome, count(*) as n
    from pitches where result_category is not null
    group by result_category
),
ab_outcomes as (
    select 'ab_result' as market, result as outcome, count(*) as n
    from at_bats where result is not null
    group by result
),
unioned as (
    select * from pitch_outcomes union all select * from ab_outcomes
),
ranked as (
    select market, outcome, n,
        sum(n) over (partition by market) as market_n,
        row_number() over (partition by market order by n desc, outcome) as rk
    from unioned
)
select market, outcome as baseline_outcome,
    cast(n as double) / nullif(market_n, 0) as baseline_rate,
    market_n as n
from ranked where rk = 1
"""


def _rows(con, sql: str) -> list[dict]:  # noqa: ANN001
    cur = con.execute(sql)
    names = [d[0] for d in cur.description]
    return [dict(zip(names, row)) for row in cur.fetchall()]


def matchup_history(con) -> list[dict]:  # noqa: ANN001
    return _rows(con, MATCHUP_HISTORY_SQL)


def pitcher_profiles(con) -> list[dict]:  # noqa: ANN001
    return _rows(con, PITCHER_PROFILES_SQL)


def batter_profiles(con) -> list[dict]:  # noqa: ANN001
    return _rows(con, BATTER_PROFILES_SQL)


def pitcher_fatigue_profile(con) -> list[dict]:  # noqa: ANN001
    return _rows(con, PITCHER_FATIGUE_SQL)


def market_baselines(con) -> list[dict]:  # noqa: ANN001
    return _rows(con, MARKET_BASELINES_SQL)


def all_aggregates(store) -> dict[str, list[dict]]:  # noqa: ANN001
    m = manifest.load(store)
    con = duck.connect(store)
    duck.register_views(con, store, m)
    return {
        "matchup_history": matchup_history(con),
        "pitcher_profiles": pitcher_profiles(con),
        "batter_profiles": batter_profiles(con),
        "pitcher_fatigue_profile": pitcher_fatigue_profile(con),
        "market_baselines": market_baselines(con),
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python -m pytest tests/warehouse/test_aggregates.py -v`
Expected: PASS, 10 tests

- [ ] **Step 5: Commit**

```bash
git add warehouse/aggregates.py tests/warehouse/test_aggregates.py
git commit -m "feat(warehouse): matchup, profiles, fatigue, and baseline aggregates"
```

---

## Task 13: Aggregate tables migration

**Files:**
- Create: `supabase/migrations/20260730000001_warehouse_tables.sql`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260730000001_warehouse_tables.sql`:

```sql
-- Aggregate tables published nightly by the DuckDB/R2 warehouse job
-- (warehouse/publish.py). All are small, derived, and safe to rebuild from
-- R2 at any time — none is a source of truth.
--
-- SIZE: ~41,000 matchup rows (7 MB, already present under the old name) plus
-- roughly 2,600 profile rows and 5 baseline rows, well under 1 MB combined.
--
-- Why these live in Supabase at all: the public API cannot query R2, and the
-- Data Feed needs them at request time. The nightly job is the only writer.

-- Pitcher display profiles. `scope` is 'career' or 'd30'.
--
-- NOTE: the d30 scope intentionally duplicates pitcher_rolling_stats. That
-- table stays authoritative for LIVE SCORING (model.ts reads it); this one is
-- display-only, so a failed warehouse run degrades a panel and never the
-- model.
create table if not exists pitcher_profiles (
    pitcher_id  integer not null,
    scope       text    not null,
    pitches     bigint,
    zone_rate   numeric(6,4),
    whiff_rate  numeric(6,4),
    chase_rate  numeric(6,4),
    fb_velo     numeric(5,2),
    os_velo     numeric(5,2),
    updated_at  timestamptz default now(),
    primary key (pitcher_id, scope)
);

create table if not exists batter_profiles (
    batter_id     integer not null,
    scope         text    not null,
    pitches       bigint,
    chase_rate    numeric(6,4),
    contact_rate  numeric(6,4),
    k_rate        numeric(6,4),
    bb_rate       numeric(6,4),
    updated_at    timestamptz default now(),
    primary key (batter_id, scope)
);

-- Velocity decay across a start. `bucket` is the in-game pitch-count bucket
-- (0 = pitches 1-15, 1 = 16-30, ...); velo_delta is that bucket's mean
-- velocity minus bucket 0's, which is the "is he tiring?" signal.
--
-- This replaces the pitcher_game_log table dropped in 20260728000001. A
-- per-game log would be ~33,000 rows for a surface that only needs a
-- per-pitcher curve plus live data from the hot window.
create table if not exists pitcher_fatigue_profile (
    pitcher_id  integer not null,
    bucket      integer not null,
    pitches     bigint,
    mean_velo   numeric(5,2),
    velo_delta  numeric(5,2),
    updated_at  timestamptz default now(),
    primary key (pitcher_id, bucket)
);

-- Always-guess-the-most-common-outcome rate per market: the honest denominator
-- for the accuracy surface.
create table if not exists market_baselines (
    market            text not null primary key,
    baseline_outcome  text,
    baseline_rate     numeric(6,4),
    n                 bigint,
    updated_at        timestamptz default now()
);

alter table pitcher_profiles         enable row level security;
alter table batter_profiles          enable row level security;
alter table pitcher_fatigue_profile  enable row level security;
alter table market_baselines         enable row level security;

-- Public read, matching every other app-data table.
do $$
declare
    t text;
    roles text := (
        select string_agg(quote_ident(rolname), ', ')
        from pg_roles where rolname in ('anon', 'authenticated')
    );
begin
    if roles is null then return; end if;
    foreach t in array array['pitcher_profiles', 'batter_profiles',
                             'pitcher_fatigue_profile', 'market_baselines']
    loop
        if not exists (
            select 1 from pg_policies
            where schemaname = 'public' and tablename = t
              and policyname = 'public read'
        ) then
            execute format(
                'create policy "public read" on %I for select to %s using (true)',
                t, roles);
        end if;
    end loop;
end $$;
```

- [ ] **Step 2: Verify the migration applies to a clean Postgres**

The `migrations` job in `ci.yml` replays every migration against a stock
Postgres 16 container.

Run: `git add supabase/migrations/20260730000001_warehouse_tables.sql && git commit -m "feat(db): warehouse aggregate tables" && git push`
Expected: the `migrations` CI job passes.

- [ ] **Step 3: Apply to production**

Use the Supabase MCP `apply_migration` with name `warehouse_tables` and the
file's contents.

- [ ] **Step 4: Confirm the tables exist with RLS**

```sql
select c.relname, c.relrowsecurity,
       (select count(*) from pg_policies p
        where p.schemaname='public' and p.tablename=c.relname) as policies
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public'
  and c.relname in ('pitcher_profiles','batter_profiles',
                    'pitcher_fatigue_profile','market_baselines');
```

Expected: four rows, `relrowsecurity = true`, `policies = 1` each.

---

## Task 14: Publish aggregates to Supabase

**Files:**
- Create: `warehouse/publish.py`, `tests/warehouse/test_publish.py`
- Modify: `warehouse/cli.py`

**Interfaces:**
- Consumes: `warehouse.aggregates.all_aggregates`, `backend.db.client.get_client`
- Produces: `CONFLICT_KEYS: dict[str, str]`, `publish_table(client, table: str, rows: list[dict]) -> int`, `publish_all(client, store) -> dict[str, int]`

- [ ] **Step 1: Write the failing test**

Create `tests/warehouse/test_publish.py`:

```python
from __future__ import annotations

import pytest

from warehouse import publish


class _FakeTable:
    def __init__(self, sink, name):
        self._sink, self._name = sink, name

    def upsert(self, rows, on_conflict=None):
        self._sink.append({"table": self._name, "rows": rows,
                           "on_conflict": on_conflict})
        return self

    def execute(self):
        return type("Res", (), {"data": self._sink[-1]["rows"]})()


class _FakeClient:
    def __init__(self):
        self.calls = []

    def table(self, name):
        return _FakeTable(self.calls, name)


def test_every_published_table_has_a_conflict_key():
    assert set(publish.CONFLICT_KEYS) == {
        "matchup_history", "pitcher_profiles", "batter_profiles",
        "pitcher_fatigue_profile", "market_baselines",
    }


def test_publish_table_upserts_on_the_declared_key():
    client = _FakeClient()
    n = publish.publish_table(
        client, "market_baselines",
        [{"market": "ab_result", "baseline_outcome": "out",
          "baseline_rate": 0.464, "n": 100}])
    assert n == 1
    assert client.calls[0]["on_conflict"] == "market"


def test_publish_table_is_a_noop_for_zero_rows():
    client = _FakeClient()
    assert publish.publish_table(client, "market_baselines", []) == 0
    assert client.calls == []


def test_publish_table_stamps_updated_at():
    client = _FakeClient()
    publish.publish_table(client, "market_baselines",
                          [{"market": "ab_result"}])
    assert "updated_at" in client.calls[0]["rows"][0]


def test_publish_table_chunks_large_inputs():
    client = _FakeClient()
    rows = [{"pitcher_id": i, "batter_id": i} for i in range(2500)]
    publish.publish_table(client, "matchup_history", rows)
    # CHUNK is 1000, so 2500 rows means three requests.
    assert len(client.calls) == 3


def test_publish_table_rejects_an_unknown_table():
    with pytest.raises(KeyError):
        publish.publish_table(_FakeClient(), "not_a_table", [{"x": 1}])
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest tests/warehouse/test_publish.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'warehouse.publish'`

- [ ] **Step 3: Write the implementation**

Create `warehouse/publish.py`:

```python
"""Push warehouse aggregates into Supabase.

Upserts only — never deletes. A player who stops appearing keeps their last
computed profile rather than vanishing from the UI, and a partial run leaves
stale-but-valid rows instead of gaps.
"""

from __future__ import annotations

from datetime import datetime, timezone

from warehouse.aggregates import all_aggregates

# PostgREST handles large payloads poorly; chunk well under any limit.
CHUNK = 1000

CONFLICT_KEYS = {
    "matchup_history": "pitcher_id,batter_id",
    "pitcher_profiles": "pitcher_id,scope",
    "batter_profiles": "batter_id,scope",
    "pitcher_fatigue_profile": "pitcher_id,bucket",
    "market_baselines": "market",
}


def publish_table(client, table: str, rows: list[dict]) -> int:  # noqa: ANN001
    on_conflict = CONFLICT_KEYS[table]
    if not rows:
        return 0
    now = datetime.now(timezone.utc).isoformat()
    stamped = [{**row, "updated_at": now} for row in rows]
    written = 0
    for start in range(0, len(stamped), CHUNK):
        batch = stamped[start:start + CHUNK]
        client.table(table).upsert(batch, on_conflict=on_conflict).execute()
        written += len(batch)
    return written


def publish_all(client, store) -> dict[str, int]:  # noqa: ANN001
    out: dict[str, int] = {}
    for table, rows in all_aggregates(store).items():
        out[table] = publish_table(client, table, rows)
        print(f"[warehouse] published {table}: {out[table]} rows")
    return out
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python -m pytest tests/warehouse/test_publish.py -v`
Expected: PASS, 6 tests

- [ ] **Step 5: Wire `publish` into the CLI**

In `warehouse/cli.py`, add the import:

```python
from warehouse.publish import publish_all  # noqa: E402
```

Add the subparser inside `build_parser`, next to `snapshot`:

```python
    common(sub.add_parser("publish"))
```

Add the branch in `main`, immediately after the `snapshot` branch:

```python
    if args.command == "publish":
        print(json.dumps(publish_all(client, store)))
        return 0
```

- [ ] **Step 6: Add the publish step to the nightly workflow**

In `.github/workflows/warehouse.yml`, append after the `Export` step:

```yaml
      - name: Publish aggregates
        run: python -m warehouse publish
```

- [ ] **Step 7: Verify against production and compare to the current table**

Run: `python -m warehouse publish`

Then confirm the recomputed matchup history matches what Postgres held before:

```sql
select count(*) as pairs, sum(pa_count) as pas from matchup_history;
```

**Acceptance:** `pairs` is within 1% of 40,704. A large drop means the
warehouse is missing days; check `manifest.days(m, 'at_bats')` against the
expected span from 2025-03-27.

Then check the new tables are populated:

```sql
select 'pitcher' as t, count(*) from pitcher_profiles
union all select 'batter', count(*) from batter_profiles
union all select 'fatigue', count(*) from pitcher_fatigue_profile
union all select 'baselines', count(*) from market_baselines;
```

Expected: pitcher and batter profiles in the hundreds-to-low-thousands,
baselines exactly 2 rows (`pitch_result`, `ab_result`).

- [ ] **Step 8: Commit**

```bash
git add warehouse/publish.py warehouse/cli.py tests/warehouse/test_publish.py .github/workflows/warehouse.yml
git commit -m "feat(warehouse): publish aggregates to Supabase nightly"
```

---

## Task 15: Retire the Postgres matchup refresh and surface staleness

**Files:**
- Modify: `supabase/functions/daily-ingest/index.ts`
- Modify: `supabase/functions/api/index.ts`

- [ ] **Step 1: Stop calling `refresh_matchup_history` from daily-ingest**

In `supabase/functions/daily-ingest/index.ts`, replace the three-RPC block
(currently lines 60–64) with:

```ts
    // Aggregates the live scorer reads. matchup_history is no longer refreshed
    // here: it needs full at_bats history, which now lives in R2. The nightly
    // warehouse job (.github/workflows/warehouse.yml) computes and publishes it.
    const { data: n1, error: e1 } = await svc().rpc("refresh_pitcher_rolling_stats");
    const { data: n2, error: e2 } = await svc().rpc("refresh_batter_rolling_stats");
    for (const e of [e1, e2]) if (e) errors.push(`rpc: ${e.message}`);
    detail.rolling = { pitchers: n1, batters: n2 };
```

- [ ] **Step 2: Add warehouse staleness to `/health`**

In `supabase/functions/api/index.ts`, inside `health()`, add a fifth parallel
query to the `Promise.all` destructure:

```ts
  const [{ count: pitchCount }, { data: runs }, { data: model }, { data: bf },
         { data: baselines }] = await Promise.all([
    db.from("pitches").select("id", { count: "exact", head: true }),
    db.from("ingest_runs").select("job,finished_at,ok").order("id", { ascending: false }).limit(200),
    db.from("model_params").select("market,version").eq("is_active", true),
    db.from("backfill_progress").select("cursor_date,start_date,done,updated_at").eq("id", 1).maybeSingle(),
    db.from("market_baselines").select("updated_at").order("updated_at", { ascending: false }).limit(1),
  ]);
```

Then, before the `return json({...})`, add:

```ts
  // Warehouse freshness. The nightly job publishes market_baselines last, so
  // its timestamp is the best single signal that the whole run completed.
  // A silently failing job would otherwise only be visible in GitHub Actions.
  const whTs = baselines?.[0]?.updated_at ?? null;
  const whAge = whTs ? Math.round((now - new Date(whTs).getTime()) / 1000) : null;
```

And add to the returned object, after `backfill`:

```ts
    warehouse: {
      last_publish: whTs,
      age_seconds: whAge,
      // Nightly at 14:00 UTC; two missed runs is a real problem.
      fresh: whAge == null ? false : whAge <= 48 * 3600,
    },
```

- [ ] **Step 3: Typecheck the edge functions**

Run: `deno check supabase/functions/api/index.ts supabase/functions/daily-ingest/index.ts`
Expected: no errors.

- [ ] **Step 4: Deploy and verify**

Deploy both functions via the Supabase MCP `deploy_edge_function`, or push and
let `deploy-supabase.yml` run.

Run: `curl -s https://gfxpchtyncgsczqdvohr.functions.supabase.co/api/health | python -m json.tool`
Expected: a `warehouse` block with a recent `last_publish` and `fresh: true`.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/daily-ingest/index.ts supabase/functions/api/index.ts
git commit -m "feat: move matchup refresh to the warehouse, surface staleness in /health"
```

---

# Phase D — Reclaim capacity (spec Phase 1)

**Do not start Phase D until Phases A, B and C are complete and verified.**
This is the only irreversible phase in the plan. Its preconditions:

- [ ] R2 holds every day from 2025-03-27 to yesterday, all verified (Task 7)
- [ ] Training reproduces the `v1_20260707` metrics from the warehouse (Task 10)
- [ ] `matchup_history` is being published from the warehouse (Task 14)
- [ ] `/api/health` reports `warehouse.fresh: true` (Task 15)

## Task 16: Hot-window table swap

**Files:**
- Create: `supabase/migrations/20260731000001_hot_window_swap.sql`

- [ ] **Step 1: Record the pre-migration state**

```sql
select pg_size_pretty(pg_database_size(current_database())) as db_size,
  (select count(*) from pitches) as pitches,
  (select count(*) from at_bats) as at_bats,
  (select count(*) from pitches
    where pitch_ts >= now() - interval '35 days') as pitches_retained,
  (select count(*) from at_bats a join games g on g.game_pk = a.game_pk
    where g.official_date >= (now() - interval '35 days')::date) as at_bats_retained;
```

Write the results into the migration's header comment.

- [ ] **Step 2: Pause the live poller**

The bulk `INSERT` generates significant WAL and `live-poll` writes to
`pitches` every 30 seconds. Run:

```sql
select cron.unschedule(jobid) from cron.job where jobname = 'np-live-poll';
```

Confirm: `select jobname from cron.job;` — `np-live-poll` absent.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260731000001_hot_window_swap.sql`:

```sql
-- Reduce pitches and at_bats to a 35-day hot window. Full history lives in
-- Cloudflare R2 as Parquet (warehouse/, .github/workflows/warehouse.yml).
--
-- PRECONDITIONS — verify all four before applying:
--   1. R2 holds every day from 2025-03-27 to yesterday, verified against the
--      manifest checksums.
--   2. scripts/train_models.py reproduces the v1_20260707 metrics from R2.
--   3. matchup_history is published by the warehouse job, not refreshed here.
--   4. np-live-poll is unscheduled for the duration of this migration.
--
-- WHY A TABLE SWAP RATHER THAN DELETE:
-- DELETE marks tuples dead but does not return space to the OS, so
-- pg_database_size would not move and no capacity would be reclaimed. VACUUM
-- FULL needs roughly 2x the table size in transient space, which is
-- impossible at 453 MB of a 500 MB cap, and pg_repack is unavailable. Copying
-- only the retained rows into a new table needs 2x the RETAINED size instead.
--
-- ORDER MATTERS: at_bats first. The old table is not dropped until commit, so
-- both copies coexist.
--   at_bats first:  453 -> peak 459 -> 402 MB
--   pitches next:   402 -> peak 433 -> 146 MB
-- Reversing this puts peak at 484 MB, leaving 16 MB of headroom.
--
-- MEASURED BEFORE (fill in from Step 1):
--   db_size <n>, pitches <n>, at_bats <n>,
--   pitches_retained <n>, at_bats_retained <n>

-- ── at_bats first (small table, buys headroom) ─────────────────────────────
-- at_bats has no index on end_ts (only id, game_pk+at_bat_index, pitcher_id,
-- batter_id), so the window is expressed through games.official_date, which
-- keeps this on the game_pk index rather than a timestamp seq scan.
create table at_bats_new (like at_bats including all);

insert into at_bats_new
select a.* from at_bats a
join games g on g.game_pk = a.game_pk
where g.official_date >= (now() - interval '35 days')::date;

drop table at_bats;
alter table at_bats_new rename to at_bats;

-- LIKE ... INCLUDING ALL copies indexes, unique constraints and defaults but
-- NOT row-level security or policies. Recreate them explicitly.
alter table at_bats enable row level security;
create policy "public read" on at_bats
    for select to anon, authenticated using (true);

-- ── pitches ────────────────────────────────────────────────────────────────
create table pitches_new (like pitches including all);

insert into pitches_new
select * from pitches
where pitch_ts >= now() - interval '35 days';

drop table pitches;
alter table pitches_new rename to pitches;

alter table pitches enable row level security;
create policy "public read" on pitches
    for select to anon, authenticated using (true);

-- ── drop what can no longer be computed in Postgres ────────────────────────
-- These four scanned all of `pitches`/`at_bats`. Against a 35-day window they
-- would still succeed and quietly return a fraction of the data, producing a
-- worse model with no error. Dropping them makes that mistake impossible.
-- Their replacements are in warehouse/cells.py.
--
-- train_home_advantage is deliberately NOT dropped: it reads only `games`,
-- which this migration does not touch, so scripts/train_models.py still calls
-- it as an RPC.
drop function if exists train_pitch_result_cells();
drop function if exists train_ab_result_cells();
drop function if exists train_pitch_speed_cells();
drop function if exists train_ab_pitches_cells();

-- refresh_matchup_history() scanned all of at_bats with no time window. The
-- warehouse job computes matchup_history now (warehouse/aggregates.py) and
-- daily-ingest no longer calls this.
drop function if exists refresh_matchup_history();

-- ── ongoing prune ──────────────────────────────────────────────────────────
-- Steady state needs no repack: each day inserts ~3,800 pitches and deletes
-- ~3,800, autovacuum returns the space to the free space map, and new inserts
-- reuse it. The table stabilises around 31 MB.
create or replace function prune_hot_window(keep_days int default 35)
returns jsonb language plpgsql security definer
set search_path = public, pg_temp as $$
declare
    cutoff date := (now() - make_interval(days => keep_days))::date;
    n_pitches int;
    n_at_bats int;
begin
    delete from pitches where pitch_ts < cutoff;
    get diagnostics n_pitches = row_count;

    delete from at_bats a
    where not exists (
        select 1 from games g
        where g.game_pk = a.game_pk and g.official_date >= cutoff
    );
    get diagnostics n_at_bats = row_count;

    return jsonb_build_object('cutoff', cutoff,
                              'pitches', n_pitches,
                              'at_bats', n_at_bats);
end $$;

revoke execute on function prune_hot_window(int) from anon, authenticated, public;
```

- [ ] **Step 4: Apply the migration**

Apply via the Supabase MCP `apply_migration`, name `hot_window_swap`.

Expected: succeeds. If it fails partway, `at_bats_new` or `pitches_new` may
remain — each statement is its own transaction under `apply_migration`. Check
`select relname from pg_class where relname like '%_new'` and drop any leftover
before retrying.

- [ ] **Step 5: Verify the reclaim and the policies**

```sql
select pg_size_pretty(pg_database_size(current_database())) as db_size,
  (select count(*) from pitches) as pitches,
  (select count(*) from at_bats) as at_bats,
  (select count(*) from pg_policies
    where schemaname='public' and tablename='pitches') as pitch_policies,
  (select count(*) from pg_policies
    where schemaname='public' and tablename='at_bats') as ab_policies,
  (select relrowsecurity from pg_class where relname='pitches') as pitch_rls,
  (select relrowsecurity from pg_class where relname='at_bats') as ab_rls;
```

**Acceptance:**
- `db_size` ≤ 200 MB (expected ~146 MB)
- `pitches` matches `pitches_retained` from Step 1
- `pitch_policies = 1`, `ab_policies = 1`
- `pitch_rls = true`, `ab_rls = true`

- [ ] **Step 6: Confirm the API is byte-identical**

Before resuming the poller, compare responses to what they were. `/live`
depends on live games, so check the endpoints that do not:

```bash
for route in health games picks/today record sportsbooks; do
  echo "== $route"
  curl -s "https://gfxpchtyncgsczqdvohr.functions.supabase.co/api/$route" \
    | python -c "import json,sys; d=json.load(sys.stdin); print(type(d).__name__, len(d) if isinstance(d,(list,dict)) else '')"
done
```

Expected: every route returns 200 with the same shape. `/health` now reports a
much smaller `pitches_rows` — that is the intended change and the only one.

- [ ] **Step 7: Resume the live poller**

```sql
select cron.schedule('np-live-poll', '30 seconds',
                     $$select call_edge_function('live-poll')$$);
```

Confirm after two minutes: `select job, finished_at, ok from ingest_runs
where job = 'live-poll' order by id desc limit 3;`
Expected: recent successful rows.

- [ ] **Step 8: Confirm settle still grades**

`settle` reads `pitches` and `at_bats` for same-day games, all inside the
35-day window.

```sql
select count(*) filter (where result is null) as ungraded,
       max(graded_at) as last_graded
from predictions;
```

Expected: `last_graded` within the last 10 minutes.

- [ ] **Step 9: Commit**

```bash
git add supabase/migrations/20260731000001_hot_window_swap.sql
git commit -m "feat(db): reduce pitches/at_bats to a 35-day hot window

Reclaimed <before> MB -> <after> MB. Full history in R2 as Parquet.
Dropped the four full-history training RPCs (replaced by warehouse/cells.py)
and refresh_matchup_history (replaced by warehouse/aggregates.py).
train_home_advantage kept: it reads only games, which is not pruned."
```

---

## Task 17: Schedule the ongoing prune, gated on the manifest

**Files:**
- Modify: `warehouse/cli.py`
- Create: `tests/warehouse/test_prune_gate.py`
- Modify: `.github/workflows/warehouse.yml`

**Interfaces:**
- Consumes: `warehouse.manifest.is_verified`
- Produces: `prunable_days(manifest_obj, days, datasets) -> tuple[list[str], list[str]]` and a `prune` CLI subcommand

The gate: a day is prunable only when **every** date-partitioned dataset has a
verified manifest entry for it.

- [ ] **Step 1: Write the failing test**

Create `tests/warehouse/test_prune_gate.py`:

```python
from __future__ import annotations

from warehouse import manifest
from warehouse.cli import prunable_days

DATASETS = ["pitches", "at_bats", "predictions"]


def _verified(m, dataset, day):
    return manifest.record(m, dataset, day, rows=1, size_bytes=1,
                           checksum="c", verified_at="t")


def test_a_day_verified_for_every_dataset_is_prunable():
    m = manifest.empty()
    for ds in DATASETS:
        _verified(m, ds, "2026-06-01")
    ok, blocked = prunable_days(m, ["2026-06-01"], DATASETS)
    assert ok == ["2026-06-01"]
    assert blocked == []


def test_a_day_missing_one_dataset_is_blocked():
    m = manifest.empty()
    _verified(m, "pitches", "2026-06-01")
    _verified(m, "at_bats", "2026-06-01")
    ok, blocked = prunable_days(m, ["2026-06-01"], DATASETS)
    assert ok == []
    assert blocked == ["2026-06-01"]


def test_a_day_with_an_unverified_entry_is_blocked():
    m = manifest.empty()
    for ds in DATASETS:
        _verified(m, ds, "2026-06-01")
    # Checksum cleared: exported but never verified.
    manifest.record(m, "pitches", "2026-06-01", rows=1, size_bytes=1,
                    checksum="", verified_at="t")
    ok, blocked = prunable_days(m, ["2026-06-01"], DATASETS)
    assert ok == []
    assert blocked == ["2026-06-01"]


def test_an_entirely_unknown_day_is_blocked():
    ok, blocked = prunable_days(manifest.empty(), ["1999-01-01"], DATASETS)
    assert ok == []
    assert blocked == ["1999-01-01"]


def test_days_are_evaluated_independently():
    m = manifest.empty()
    for ds in DATASETS:
        _verified(m, ds, "2026-06-01")
    _verified(m, "pitches", "2026-06-02")
    ok, blocked = prunable_days(m, ["2026-06-01", "2026-06-02"], DATASETS)
    assert ok == ["2026-06-01"]
    assert blocked == ["2026-06-02"]
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest tests/warehouse/test_prune_gate.py -v`
Expected: FAIL — `ImportError: cannot import name 'prunable_days'`

- [ ] **Step 3: Implement the gate and the prune command**

In `warehouse/cli.py`, add after `daterange`:

```python
def prunable_days(manifest_obj, days: list[str],  # noqa: ANN001
                  datasets: list[str]) -> tuple[list[str], list[str]]:
    """Split `days` into (safe to prune, blocked).

    A day is safe only when EVERY date-partitioned dataset has a verified
    manifest entry for it. This is the last check between a failed export and
    permanent data loss, so anything unknown or unverified is blocked.
    """
    ok, blocked = [], []
    for day in days:
        if all(manifest.is_verified(manifest_obj, ds, day) for ds in datasets):
            ok.append(day)
        else:
            blocked.append(day)
    return ok, blocked
```

Add the `run_prune` function after `run_snapshot`:

```python
def run_prune(client, store, keep_days: int) -> dict:  # noqa: ANN001
    """Prune the hot window, but only if every expired day is in the warehouse.

    Checks the boundary week — the days about to fall out of the window. If any
    of them is unverified the prune is refused outright rather than partially
    applied, because prune_hot_window() works on a single cutoff date.
    """
    from datetime import date

    m = manifest.load(store)
    cutoff = date.fromisoformat(default_date()) - timedelta(days=keep_days - 1)
    boundary = daterange((cutoff - timedelta(days=6)).isoformat(),
                         cutoff.isoformat())
    ok, blocked = prunable_days(m, boundary, list(DATASETS))
    if blocked:
        print(f"[warehouse] REFUSING to prune — unverified days: {blocked}")
        return {"pruned": False, "blocked": blocked}

    result = client.rpc("prune_hot_window", {"keep_days": keep_days}).execute()
    print(f"[warehouse] pruned: {result.data}")
    return {"pruned": True, "verified_boundary": ok, "result": result.data}
```

Add to `build_parser`, next to `publish`:

```python
    p_prune = common(sub.add_parser("prune"))
    p_prune.add_argument("--keep-days", type=int, default=35)
```

Add to `main`, after the `publish` branch:

```python
    if args.command == "prune":
        summary = run_prune(client, store, args.keep_days)
        print(json.dumps(summary, default=str))
        return 0 if summary["pruned"] else 1
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python -m pytest tests/warehouse/test_prune_gate.py -v`
Expected: PASS, 5 tests

- [ ] **Step 5: Confirm the gate refuses when it should**

Run a deliberate negative test against a local store with an empty manifest:

Run: `python -m warehouse prune --local ./.warehouse-empty`
Expected: `REFUSING to prune — unverified days: [...]`, exit code 1, and **no
SQL executed**.

- [ ] **Step 6: Add the prune step to the nightly workflow**

In `.github/workflows/warehouse.yml`, append as the **last** step so it can
only run after export, verify, and publish have all succeeded:

```yaml
      # Last, and only reached if every step above succeeded. run_prune()
      # additionally refuses unless the boundary week is verified in the
      # manifest, so a green export is necessary but not sufficient.
      - name: Prune hot window
        run: python -m warehouse prune --keep-days 35
```

- [ ] **Step 7: Run the full nightly pipeline once by hand**

Run: **Warehouse → Run workflow** (no inputs).
Expected: green; log shows snapshot, export, publish, and
`pruned: {"cutoff": ..., "pitches": <small n>, "at_bats": <small n>}`.

The counts should be small — one day's worth — because Task 16 already removed
the bulk.

- [ ] **Step 8: Confirm steady state after a week**

```sql
select pg_size_pretty(pg_database_size(current_database())) as db_size,
  (select count(*) from pitches) as pitches,
  (select min(pitch_ts)::date from pitches) as oldest_pitch;
```

**Acceptance:** `db_size` stable under 200 MB and `oldest_pitch` is ~35 days
back. A growing `db_size` means the prune is being refused — check the workflow
log for `REFUSING`.

- [ ] **Step 9: Commit**

```bash
git add warehouse/cli.py tests/warehouse/test_prune_gate.py .github/workflows/warehouse.yml
git commit -m "feat(warehouse): manifest-gated nightly prune of the hot window"
```

---

## Final acceptance — the whole plan

- [ ] `python -m pytest tests/ -q` passes
- [ ] Supabase `pg_database_size` under 200 MB, down from 453 MB
- [ ] R2 holds every day from 2025-03-27, all verified
- [ ] `scripts/train_models.py` reproduces the `v1_20260707` metrics from R2
- [ ] `python scripts/models.py status` reports no version mismatch
- [ ] `/api/health` returns `status: ok`, `data_fresh: true`, `warehouse.fresh: true`
- [ ] `matchup_history` within 1% of 40,704 pairs
- [ ] Every API route returns the same shape it did before Phase D
- [ ] `np-live-poll` and `np-settle` both writing successfully to `ingest_runs`

---

## Notes for the implementer

**The two gates that matter.** Task 10's metric reproduction and Task 17's
manifest check are not ceremony. The first is the only thing that distinguishes
a correct DuckDB translation from one that silently trains on the wrong data;
the second is the only thing between a failed export and permanent loss of two
seasons of history. If either is inconvenient, that is the point.

**If Task 10's metrics come close but not equal,** start with the
`DECIMAL(18,9)` casts in `warehouse/cells.py`. Postgres buckets these rates on
`numeric`; binary floating point moves rows across bucket boundaries. Task 9's
header explains this and Task 10 Step 6 has a cell-by-cell diff script.

**Task 16 is the only irreversible step in the plan.** Its four preconditions
are listed at the top of Phase D. Do not begin it with any of them unmet, and
do not skip pausing `np-live-poll` — the bulk insert plus 30-second writes to
the table being copied is how this goes wrong.

**Not in scope.** The spec's §12 records four findings deliberately excluded:
the on-deck board rendering perturbed synthetic numbers as model output, the
uncaptured `result_detail` surfaces, the missing base-state/pitch-count/
times-through-order features, and the 444 dormant `odds` rows. Leave them
alone; the first needs a product decision.
