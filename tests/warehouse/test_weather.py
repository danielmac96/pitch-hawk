"""Gametime weather: the wind projection, the hour choice, and the join.

The sign of `wind_out_component` is the thing to guard. Inverted, it would turn
the strongest weather signal a home-run model has into its exact opposite while
still producing plausible-looking mph. `test_wind_convention_matches_mlb_labels`
is the pin on that; the rest of the file is the join around it.

No network: Open-Meteo is stubbed.
"""

from __future__ import annotations

import io
from datetime import date, datetime, timezone

import pyarrow.parquet as pq
import pytest

from warehouse import ingest
from warehouse.config import WEATHER_SCHEMA, object_key, snapshot_key
from warehouse.ingest import to_parquet
from warehouse.store import LocalStore
from warehouse.weather import (
    HOURLY_VARS, hour_key, rows_for_games, wind_out_component,
)

# Center field bears ENE. Yankee Stadium reads 75.0 upstream.
AZ = 75.0


# ── the wind projection ─────────────────────────────────────────────────────

def test_wind_blowing_from_behind_the_plate_is_fully_out():
    assert wind_out_component(10, AZ + 180, AZ) == pytest.approx(10)


def test_wind_blowing_in_from_center_is_fully_negative():
    assert wind_out_component(10, AZ, AZ) == pytest.approx(-10)


def test_crosswind_projects_to_roughly_zero():
    assert wind_out_component(10, AZ + 90, AZ) == pytest.approx(0, abs=1e-9)
    assert wind_out_component(10, AZ - 90, AZ) == pytest.approx(0, abs=1e-9)


def test_projection_is_symmetric_about_the_field_axis():
    """A wind 30 degrees off the axis either way has the same out-component.

    Catches a sign error in the angle difference, which a head-on test cannot:
    cos is even, so `from - az` and `az - from` agree only if the rest is right.
    """
    assert wind_out_component(12, AZ + 180 + 30, AZ) == pytest.approx(
        wind_out_component(12, AZ + 180 - 30, AZ))


def test_wind_convention_matches_mlb_labels():
    """The empirical check, reproduced as a unit test on representative cases.

    Validated live over 61 games in 2025: "Out To ..." averaged +3.18 mph,
    "In From ..." -3.20, crosswinds +0.90. These cases encode the same
    relationship at the three park orientations that bracket the league.
    """
    for az in (4.0, 75.0, 116.0):          # Coors, Yankee Stadium, PNC
        out = wind_out_component(12, (az + 180) % 360, az)
        into = wind_out_component(12, az, az)
        assert out > 0 and into < 0, f"convention inverted at azimuth {az}"
        assert out == pytest.approx(-into)


def test_projection_is_none_when_any_input_is_missing():
    """Better no number than a confident zero. A null azimuth is a park we do
    not have geometry for, not a park with no wind."""
    assert wind_out_component(None, 180, AZ) is None
    assert wind_out_component(10, None, AZ) is None
    assert wind_out_component(10, 180, None) is None


# ── the hour choice ─────────────────────────────────────────────────────────

def test_hour_key_floors_to_the_hour_containing_first_pitch():
    ts = datetime(2025, 7, 4, 19, 40, tzinfo=timezone.utc)
    assert hour_key(ts) == "2025-07-04T19:00"


def test_hour_key_normalises_strings_and_naive_timestamps():
    assert hour_key("2025-07-04T19:40:00Z") == "2025-07-04T19:00"
    assert hour_key(datetime(2025, 7, 4, 19, 40)) == "2025-07-04T19:00"
    assert hour_key(None) is None
    assert hour_key("not a timestamp") is None


# ── the join ────────────────────────────────────────────────────────────────

def _series(hour="2025-07-04T19:00", **over):
    vals = {"temperature_2m": 82.0, "relative_humidity_2m": 55.0,
            "wind_speed_10m": 10.0, "wind_direction_10m": (AZ + 180) % 360,
            "surface_pressure": 1012.0, "precipitation": 25.4}
    vals.update(over)
    return {"hourly": dict({"time": [hour]},
                           **{v: [vals[v]] for v in HOURLY_VARS})}


GAME = {"game_pk": 1, "game_date": date(2025, 7, 4), "venue_id": 3313,
        "start_ts": datetime(2025, 7, 4, 19, 40, tzinfo=timezone.utc)}
VENUES = {3313: {"venue_id": 3313, "latitude": 40.8, "longitude": -73.9,
                 "azimuth_angle": AZ}}


def test_row_carries_the_reading_and_the_derived_component():
    row = rows_for_games([GAME], VENUES, {3313: _series()})[0]
    assert row["game_pk"] == 1
    assert row["obs_ts"] == datetime(2025, 7, 4, 19, tzinfo=timezone.utc)
    assert row["temp_f"] == 82.0
    assert row["wind_out_mph"] == pytest.approx(10)
    assert row["source"] == "open_meteo_archive"


def test_precipitation_is_converted_from_mm_to_inches():
    """Requested in mm so the unit is explicit on the wire, stored in inches to
    match every other imperial column in the warehouse."""
    row = rows_for_games([GAME], VENUES, {3313: _series()})[0]
    assert row["precip_in"] == pytest.approx(1.0)


def test_a_game_with_no_matching_hour_is_dropped_not_nulled():
    """A row of nulls keyed to a game_pk claims we looked and found no weather.
    We did not look -- the hour was not in the series."""
    assert rows_for_games(
        [GAME], VENUES, {3313: _series(hour="2025-07-04T02:00")}) == []


def test_a_game_at_an_unknown_venue_is_dropped():
    assert rows_for_games([GAME], {}, {3313: _series()}) == []


def test_missing_wind_leaves_the_component_null_but_keeps_the_row():
    """Temperature is still a real observation when wind is not."""
    row = rows_for_games(
        [GAME], VENUES, {3313: _series(wind_direction_10m=None)})[0]
    assert row["temp_f"] == 82.0
    assert row["wind_out_mph"] is None


def test_rows_match_the_declared_schema():
    rows = rows_for_games([GAME], VENUES, {3313: _series()})
    tbl = pq.read_table(io.BytesIO(to_parquet(rows, "game_weather")))
    assert tbl.schema.equals(WEATHER_SCHEMA)
    assert tbl.num_rows == 1


def test_flattener_emits_a_key_for_every_schema_column():
    emitted = set(rows_for_games([GAME], VENUES, {3313: _series()})[0])
    declared = {f.name for f in WEATHER_SCHEMA}
    assert declared - emitted == set()
    assert emitted - declared == set()


# ── the range ingest ────────────────────────────────────────────────────────

@pytest.fixture
def seeded(tmp_path, monkeypatch):
    """A store holding one day of `games` and a venue snapshot, Open-Meteo
    stubbed at the name `warehouse.ingest` bound."""
    store = LocalStore(tmp_path)
    store.put(object_key("games", "2025-07-04"), to_parquet([{
        "game_pk": 1, "game_date": date(2025, 7, 4), "season": 2025,
        "venue_id": 3313, "venue_name": "Yankee Stadium",
        "start_ts": datetime(2025, 7, 4, 19, 40, tzinfo=timezone.utc),
    }], "games"))
    store.put(snapshot_key("venues"), to_parquet(
        [dict(VENUES[3313], season=2025, name="Yankee Stadium")], "venues"))
    calls = []

    def fake_fetch(points, start, end, *, archive=True):
        calls.append({"points": list(points), "start": start, "end": end})
        return [_series() for _ in points]

    monkeypatch.setattr(ingest, "fetch_hourly", fake_fetch)
    return store, calls


def test_range_ingest_writes_a_day_and_records_it(seeded):
    store, calls = seeded
    totals = ingest.ingest_weather_range(store, "2025-07-04", "2025-07-04")

    assert totals["days"] == 1 and totals["rows"] == 1
    tbl = pq.read_table(
        io.BytesIO(store.get(object_key("game_weather", "2025-07-04"))))
    assert tbl.schema.equals(WEATHER_SCHEMA)
    assert tbl.to_pylist()[0]["wind_out_mph"] == pytest.approx(10)


def test_range_ingest_makes_one_upstream_call_for_the_whole_range(seeded):
    """The cost argument for this design. A season must not become 180 calls."""
    store, calls = seeded
    ingest.ingest_weather_range(store, "2025-07-01", "2025-07-31")
    assert len(calls) == 1
    assert calls[0]["start"] == "2025-07-01"


def test_fetch_window_extends_one_day_past_the_range(seeded):
    """MLB keys a game to its Eastern official date; Eastern is UTC-4/-5.

    A West Coast night game on official date D starts on D+1 in UTC -- 6:10pm
    PT is 01:10Z. A window stopping at `end` dropped every one of them: 4 of
    15 games on 2025-07-04, which is ~27% of a slate, every slate. Caught only
    by running the ingest against a real day.
    """
    store, calls = seeded
    ingest.ingest_weather_range(store, "2025-07-04", "2025-07-04")
    assert calls[0]["end"] == "2025-07-05", (
        "fetch window must cover the UTC day after the last official date")


def test_a_late_game_rolling_past_utc_midnight_is_captured(seeded, monkeypatch):
    """The regression this protects, end to end rather than by parameter."""
    store, _ = seeded
    # A 6:10pm PT first pitch on the 4th: official date 07-04, UTC hour 07-05.
    store.put(object_key("games", "2025-07-04"), to_parquet([{
        "game_pk": 2, "game_date": date(2025, 7, 4), "season": 2025,
        "venue_id": 3313, "venue_name": "Yankee Stadium",
        "start_ts": datetime(2025, 7, 5, 1, 10, tzinfo=timezone.utc),
    }], "games"))

    def late_series(points, start, end, *, archive=True):
        return [_series(hour="2025-07-05T01:00") for _ in points]

    monkeypatch.setattr(ingest, "fetch_hourly", late_series)
    totals = ingest.ingest_weather_range(store, "2025-07-04", "2025-07-04")
    assert totals["rows"] == 1, "late game dropped"
    row = pq.read_table(io.BytesIO(
        store.get(object_key("game_weather", "2025-07-04")))).to_pylist()[0]
    # Filed under its OFFICIAL date, sampled at its actual UTC hour.
    assert row["game_date"] == date(2025, 7, 4)
    assert row["obs_ts"] == datetime(2025, 7, 5, 1, tzinfo=timezone.utc)


def test_days_without_games_are_skipped_not_written_empty(seeded):
    store, _ = seeded
    ingest.ingest_weather_range(store, "2025-07-04", "2025-07-06")
    assert store.exists(object_key("game_weather", "2025-07-04"))
    assert not store.exists(object_key("game_weather", "2025-07-05"))


def test_range_with_no_games_at_all_makes_no_upstream_call(seeded):
    store, calls = seeded
    totals = ingest.ingest_weather_range(store, "2025-08-01", "2025-08-02")
    assert totals["rows"] == 0
    assert calls == [], "fetched weather for days holding no games"
