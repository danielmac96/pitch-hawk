"""The venue dimension: park geometry, location and roof, keyed by season.

The season key is the whole point of this dataset. Park dimensions change --
Camden Yards reports left_center 410 through 2022 and 376 from 2026 -- so a
single current-state row would explain a 2017 home run with a 2026 fence.
`test_refresh_replaces_only_the_named_seasons` is the guard on that.

Runs against LocalStore with the MLB API stubbed: no credentials, no network.
"""

from __future__ import annotations

import io

import pyarrow.parquet as pq
import pytest

from warehouse import ingest
from warehouse.config import VENUE_SCHEMA, snapshot_key
from warehouse.mlb import MlbApiError, flatten_venue
from warehouse.store import LocalStore


def _api_venue(vid=2, name="Oriole Park at Camden Yards", left_center=410):
    """Shaped like the /venues?hydrate=location,fieldInfo,timezone response."""
    return {
        "id": vid, "name": name,
        "location": {
            "city": "Baltimore", "state": "Maryland", "stateAbbrev": "MD",
            "defaultCoordinates": {"latitude": 39.283, "longitude": -76.621},
            "azimuthAngle": 32.0, "elevation": 33,
        },
        "timeZone": {"id": "America/New_York", "offset": -4},
        "fieldInfo": {
            "capacity": 44970, "turfType": "Grass", "roofType": "Open",
            "leftLine": 333, "leftCenter": left_center, "center": 400,
            "rightCenter": 373, "rightLine": 318,
        },
    }


@pytest.fixture
def store(tmp_path) -> LocalStore:
    return LocalStore(tmp_path)


@pytest.fixture
def stub_venues(monkeypatch):
    """Stub at the name `warehouse.ingest` bound, not `warehouse.mlb`.

    ingest.py does `from warehouse.mlb import fetch_venues`, so patching
    `warehouse.mlb.fetch_venues` would not affect it.
    """
    state = {"fail": set(), "calls": []}

    def fake(season: int):
        state["calls"].append(season)
        if season in state["fail"]:
            raise MlbApiError(f"stubbed failure for {season}")
        # left_center moves in 2026, as it does upstream.
        lc = 376 if season >= 2026 else 410
        return [flatten_venue(_api_venue(left_center=lc), season),
                flatten_venue(_api_venue(vid=19, name="Coors Field"), season)]

    monkeypatch.setattr(ingest, "fetch_venues", fake)
    return state


def _read(store) -> list[dict]:
    return pq.read_table(
        io.BytesIO(store.get(snapshot_key("venues")))).to_pylist()


# ── flattening ──────────────────────────────────────────────────────────────

def test_flatten_maps_location_and_field_info():
    v = flatten_venue(_api_venue(), 2026)
    assert v["venue_id"] == 2
    assert v["season"] == 2026
    assert v["city"] == "Baltimore"
    assert v["state"] == "MD"          # stateAbbrev wins over state
    assert (v["latitude"], v["longitude"]) == (39.283, -76.621)
    assert v["elevation_ft"] == 33
    assert v["azimuth_angle"] == 32.0
    assert v["tz_id"] == "America/New_York"
    assert v["roof_type"] == "Open"
    assert v["turf_type"] == "Grass"
    assert v["capacity"] == 44970
    assert (v["left_line"], v["left_center"], v["center"],
            v["right_center"], v["right_line"]) == (333, 410, 400, 373, 318)


def test_flatten_tolerates_a_venue_with_no_location_or_field_info():
    """Spring-training and minor league parks come back sparse.

    They are stored rather than filtered -- `games.venue_id` is the read-time
    filter -- so the flattener must not raise on them.
    """
    v = flatten_venue({"id": 5000, "name": "Some Complex"}, 2026)
    assert v["venue_id"] == 5000
    assert v["latitude"] is None
    assert v["azimuth_angle"] is None
    assert v["left_line"] is None


def test_flatten_emits_a_key_for_every_schema_column():
    """A schema column the flattener never sets becomes an all-NULL column.

    `to_parquet` shapes rows with `r.get(f.name)`, so the omission does not
    raise -- it just looks like missing data forever.
    """
    emitted = set(flatten_venue(_api_venue(), 2026))
    declared = {f.name for f in VENUE_SCHEMA}
    assert declared - emitted == set()
    assert emitted - declared == set()


# ── refresh ─────────────────────────────────────────────────────────────────

def test_refresh_writes_a_snapshot_matching_the_declared_schema(
        store, stub_venues):
    n = ingest.refresh_venues(store, [2026])
    assert n == 2
    tbl = pq.read_table(io.BytesIO(store.get(snapshot_key("venues"))))
    assert tbl.schema.equals(VENUE_SCHEMA)
    assert tbl.num_rows == 2


def test_refresh_replaces_only_the_named_seasons(store, stub_venues):
    """The reason this is not merge-only, unlike refresh_players.

    Player attributes are immutable so a re-fetch is waste. Fences move, so a
    season already present may be exactly the season that moved them.
    """
    ingest.refresh_venues(store, [2022])
    ingest.refresh_venues(store, [2026])

    rows = _read(store)
    assert {r["season"] for r in rows} == {2022, 2026}      # 2022 survived
    lc = {(r["season"], r["venue_id"]): r["left_center"] for r in rows}
    assert lc[(2022, 2)] == 410
    assert lc[(2026, 2)] == 376                             # and was not overwritten

    # Re-running a season replaces its rows rather than duplicating them.
    ingest.refresh_venues(store, [2026])
    assert len(_read(store)) == len(rows)


def test_refresh_keeps_an_existing_season_when_the_api_fails(
        store, stub_venues):
    """A transient upstream failure must not silently delete history."""
    ingest.refresh_venues(store, [2022])
    stub_venues["fail"] = {2022}

    ingest.refresh_venues(store, [2022, 2026])

    rows = _read(store)
    assert {r["season"] for r in rows} == {2022, 2026}
    assert [r for r in rows if r["season"] == 2022], "2022 was dropped"


def test_refresh_writes_nothing_when_every_season_fails(store, stub_venues):
    ingest.refresh_venues(store, [2022])
    before = store.get(snapshot_key("venues"))
    stub_venues["fail"] = {2026}

    assert ingest.refresh_venues(store, [2026]) == 0
    assert store.get(snapshot_key("venues")) == before
