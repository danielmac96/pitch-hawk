"""A scan must survive PITCH_SCHEMA having grown under it.

`warehouse.config.PITCH_SCHEMA` gained the pitch-physics columns
(release_pos/vel_*, accel_*, pfx_*, break_vertical, type_confidence) in
2026-09. None of the ~2,065 day-files written before that carry them, so every
multi-day read now spans two different schemas — and `read_parquet([...])`
without `union_by_name` fails the whole scan on a binder error rather than
reading the absent columns back as NULL. That would take out `publish`,
`export` and `modeling build` the first night a new-schema day landed.

Narrow files are written straight through pyarrow rather than
`ingest.to_parquet`, which always stamps the current (wide) schema — the point
is to reproduce a file from before the widening.
"""

from __future__ import annotations

from datetime import date, datetime, timezone

import pytest

from warehouse import duck, ingest, manifest
from warehouse.config import PITCH_SCHEMA, object_key
from warehouse.store import LocalStore

pytest.importorskip("duckdb")
pa = pytest.importorskip("pyarrow")
pq = pytest.importorskip("pyarrow.parquet")

# Exactly the fields commit 9275cd0 added to PITCH_SCHEMA.
NEW_COLUMNS = (
    "release_pos_x", "release_pos_y", "release_pos_z",
    "release_vel_x", "release_vel_y", "release_vel_z",
    "accel_x", "accel_y", "accel_z",
    "pfx_x", "pfx_z", "break_vertical", "type_confidence",
)

NARROW_DAY = "2026-07-01"
WIDE_DAY = "2026-07-02"
PER_DAY = 3


def _pitch_rows(day: str, game_pk: int) -> list[dict]:
    gd = date.fromisoformat(day)
    ts = datetime.fromisoformat(day).replace(tzinfo=timezone.utc)
    rows = []
    for pn in range(1, PER_DAY + 1):
        row = {
            "game_pk": game_pk, "at_bat_index": 0, "pitch_number": pn,
            "pitcher_id": 100, "batter_id": 200, "game_date": gd,
            "pitch_ts": ts, "balls": 0, "strikes": 0, "outs": 0,
            "inning": 1, "top_inning": True,
        }
        # Give the new columns real values so an all-NULL column cannot pass
        # the assertion below by accident.
        for i, col in enumerate(NEW_COLUMNS):
            row[col] = float(pn + i)
        rows.append(row)
    return rows


def _narrow_parquet(rows: list[dict]) -> bytes:
    """A pitches file as it looked before the physics columns existed."""
    import io

    schema = pa.schema([f for f in PITCH_SCHEMA if f.name not in NEW_COLUMNS])
    shaped = [{f.name: r.get(f.name) for f in schema} for r in rows]
    buf = io.BytesIO()
    pq.write_table(pa.Table.from_pylist(shaped, schema=schema), buf,
                   compression="zstd")
    return buf.getvalue()


@pytest.fixture
def store(tmp_path):
    """One pre-widening day and one post-widening day, in one manifest."""
    s = LocalStore(tmp_path)
    m = manifest.empty()
    for day, blob_fn, game_pk in ((NARROW_DAY, _narrow_parquet, 900001),
                                  (WIDE_DAY, None, 900002)):
        rows = _pitch_rows(day, game_pk)
        blob = blob_fn(rows) if blob_fn else ingest.to_parquet(rows, "pitches")
        s.put(object_key("pitches", day), blob)
        manifest.record(m, "pitches", day, rows=len(rows),
                        size_bytes=len(blob),
                        checksum=ingest.checksum(rows, "pitches"),
                        ingested_at="2026-09-24T00:00:00+00:00", games=1)
    manifest.save(s, m)
    return s


def test_narrow_file_is_actually_narrow(store):
    """Guard the guard: if this fails the fixture stopped testing anything."""
    blob = store.get(object_key("pitches", NARROW_DAY))
    names = set(pq.read_schema(pa.BufferReader(blob)).names)
    assert not (names & set(NEW_COLUMNS))
    wide = store.get(object_key("pitches", WIDE_DAY))
    assert set(NEW_COLUMNS) <= set(pq.read_schema(pa.BufferReader(wide)).names)


def test_dataset_expression_unions_by_name(store):
    assert "union_by_name = true" in duck.dataset(store, "pitches")


def test_mixed_schemas_scan_as_one_relation(store):
    con = duck.connect(store)
    try:
        src = duck.dataset(store, "pitches")
        total, with_physics = con.execute(
            f"select count(*), count(release_pos_x) from {src}").fetchone()
        # Both days scan; the pre-widening day reads back NULL rather than
        # taking the whole query down.
        assert total == PER_DAY * 2
        assert with_physics == PER_DAY
    finally:
        con.close()


def test_missing_column_is_null_not_absent(store):
    """`register` builds views over the same expression, so `select *` must
    expose the new columns for every day — NULL where the file predates them."""
    con = duck.connect(store)
    try:
        duck.register(con, store, names=("pitches",))
        rows = con.execute(
            "select game_date, release_pos_x from pitches order by game_date, "
            "pitch_number").fetchall()
        assert [r[1] for r in rows if str(r[0]) == NARROW_DAY] == [None] * PER_DAY
        assert all(r[1] is not None for r in rows if str(r[0]) == WIDE_DAY)
    finally:
        con.close()
