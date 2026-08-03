"""Tests for the DuckDB read layer and the display aggregates.

Builds a small synthetic warehouse in `LocalStore(tmp_path)` — real Parquet
written through `ingest.to_parquet` with the frozen SCHEMAS, indexed by a real
manifest — then runs the actual aggregate SQL over it. No credentials, no
network, no R2.

Synthetic rather than fixture-derived because the aggregates have sample
floors (MIN_PITCHES = 30, matchup min_pa = 3) that the 6-pitch play-by-play
fixture cannot clear.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import pytest

from warehouse import aggregates as agg
from warehouse import duck, ingest, manifest
from warehouse.config import object_key
from warehouse.store import LocalStore

pytest.importorskip("duckdb")

SEASON = 2026
DAYS = 6
PITCHERS = (100, 101)
BATTERS = (200, 201, 202)


def _rows_for_day(day: str, game_pk: int):
    """One game: every pitcher faces every batter twice, 10 pitches each."""
    gd = date.fromisoformat(day)
    ts = datetime.fromisoformat(day).replace(tzinfo=timezone.utc)
    pitches, at_bats, abi = [], [], 0
    for pitcher in PITCHERS:
        # Per-pitcher cumulative count, as warehouse.mlb.flatten_play_by_play
        # produces it. A game-wide counter would leave the second pitcher with
        # no bucket-0 rows and therefore no fatigue baseline.
        pog = 0
        for batter in BATTERS:
            for meeting in range(2):
                result = ("strikeout" if meeting == 0 else "hit")
                detail = ("strikeout" if meeting == 0 else "home_run")
                for pn in range(1, 11):
                    pog += 1
                    pitches.append({
                        "game_pk": game_pk, "at_bat_index": abi,
                        "pitch_number": pn, "pitcher_id": pitcher,
                        "batter_id": batter, "game_date": gd,
                        "pitch_ts": ts + timedelta(minutes=abi),
                        "balls": 0, "strikes": 0, "outs": 0, "inning": 1,
                        "top_inning": True,
                        "men_on_base": "RISP" if meeting else "Empty",
                        "home_score": 0, "away_score": 0,
                        "pitch_of_game": pog,
                        "times_through_order": meeting + 1,
                        "bat_side": "R", "pitch_hand": "L",
                        "pitch_type": "FF" if pn % 2 else "SL",
                        "description": "swinging_strike" if pn % 2 else "foul",
                        "result_category": "in_play" if pn == 10 else "strike_foul",
                        "is_strike": True, "is_ball": False,
                        "is_in_play": pn == 10,
                        "start_speed": 95.0 - pog / 40.0,
                        "zone": 5 if pn % 2 else 13,
                        "launch_speed": 104.0 if pn == 10 else None,
                        "launch_angle": 28.0 if pn == 10 else None,
                    })
                at_bats.append({
                    "game_pk": game_pk, "at_bat_index": abi,
                    "pitcher_id": pitcher, "batter_id": batter,
                    "game_date": gd, "inning": 1, "top_inning": True,
                    "pitch_count": 10, "result": result,
                    "result_detail": detail, "event": detail.title(), "rbi": 0,
                    "is_scoring_play": False,
                    "men_on_base": "RISP" if meeting else "Empty",
                    "home_score": 0, "away_score": 0,
                    "times_through_order": meeting + 1,
                    "bat_side": "R", "pitch_hand": "L",
                    "start_ts": ts, "end_ts": ts,
                })
                abi += 1
    game = {"game_pk": game_pk, "game_date": gd, "season": SEASON,
            "game_type": "R", "status": "Final", "home_team_id": 1,
            "away_team_id": 2, "home_abbr": "AAA", "away_abbr": "BBB",
            "home_score": 3, "away_score": 2, "venue_id": 9,
            "venue_name": "Test Park", "hp_umpire_id": 77,
            "hp_umpire": "Ump", "weather_condition": "Clear", "temp_f": 70,
            "wind_mph": 5, "wind_direction": "Out", "attendance": 30000,
            "game_duration_min": 180}
    return pitches, at_bats, [game]


@pytest.fixture
def store(tmp_path):
    """A real, manifest-indexed warehouse on disk."""
    s = LocalStore(tmp_path)
    m = manifest.empty()
    start = date(SEASON, 7, 1)
    for i in range(DAYS):
        day = (start + timedelta(days=i)).isoformat()
        pitches, at_bats, games = _rows_for_day(day, 900000 + i)
        for name, rows in (("pitches", pitches), ("at_bats", at_bats),
                           ("games", games)):
            blob = ingest.to_parquet(rows, name)
            s.put(object_key(name, day), blob)
            manifest.record(m, name, day, rows=len(rows), size_bytes=len(blob),
                            checksum=ingest.checksum(rows, name),
                            ingested_at="2026-08-03T00:00:00+00:00",
                            games=len(games))
    manifest.save(s, m)
    return s


@pytest.fixture
def con(store):
    c = duck.connect(store)
    duck.register(c, store)
    yield c
    c.close()


# ── the read layer ──────────────────────────────────────────────────────────

def test_register_exposes_every_dataset(store, con):
    assert con.execute("select count(*) from pitches").fetchone()[0] == \
        DAYS * len(PITCHERS) * len(BATTERS) * 2 * 10
    assert con.execute("select count(*) from at_bats").fetchone()[0] == \
        DAYS * len(PITCHERS) * len(BATTERS) * 2
    assert con.execute("select count(*) from games").fetchone()[0] == DAYS


def test_dataset_resolves_through_the_manifest_not_a_listing(store):
    """The scoped R2 token may have no LIST permission, and a manifest also
    excludes objects the warehouse does not claim to hold."""
    m = manifest.load(store)
    expr = duck.dataset(store, "pitches", m=m)
    assert expr.startswith("read_parquet([")
    assert expr.count("'") == 2 * DAYS          # one quoted path per day

    # An object present in the bucket but absent from the manifest is ignored.
    store.put(object_key("pitches", "2026-09-09"), b"not even parquet")
    assert "2026-09-09" not in duck.dataset(store, "pitches", m=manifest.load(store))


def test_dataset_raises_rather_than_scanning_nothing(store):
    with pytest.raises(ValueError, match="no days"):
        duck.dataset(store, "pitches", seasons=[1999])


def test_recent_seasons_is_a_window_not_all_history(store):
    assert duck.recent_seasons(store, 3) == [SEASON]


# ── the aggregates ──────────────────────────────────────────────────────────

def test_profiles_carry_every_scope_and_a_season_floor(con):
    t = agg.pitcher_profiles(con, SEASON).to_pylist()
    assert {r["scope"] for r in t} == {"career", "season", "d30"}
    assert {r["player_id"] for r in t} == set(PITCHERS)
    assert all(r["season_floor"] == SEASON for r in t)

    career = [r for r in t if r["scope"] == "career"][0]
    # 3 batters x 2 meetings x 10 pitches x 6 days
    assert career["pitches"] == 360
    assert career["pa"] == 36
    # Half the at-bats are strikeouts by construction.
    assert career["k_rate"] == pytest.approx(0.5)
    # Odd-numbered pitches are in zone 5, even ones zone 13.
    assert career["zone_rate"] == pytest.approx(0.5)


def test_profiles_apply_the_minimum_pitch_floor(con):
    """A player under MIN_PITCHES earns no row at all, rather than a row of
    noise the Data Feed would render as fact."""
    assert agg.MIN_PITCHES == 30
    t = agg.batter_profiles(con, SEASON).to_pylist()
    assert all(r["pitches"] >= agg.MIN_PITCHES for r in t)


def test_situational_splits_key_on_base_state_and_platoon(con):
    t = agg.situational_splits(con, SEASON).to_pylist()
    assert {r["men_on_base"] for r in t} == {"Empty", "RISP"}
    assert {r["role"] for r in t} == {"pitcher", "batter"}
    # Pitchers see right-handed batters; batters see a left-handed pitcher.
    assert {r["opp_hand"] for r in t if r["role"] == "pitcher"} == {"R"}
    assert {r["opp_hand"] for r in t if r["role"] == "batter"} == {"L"}
    # By construction every Empty at-bat is a strikeout and every RISP one a hit.
    for r in t:
        assert r["k_rate"] == pytest.approx(1.0 if r["men_on_base"] == "Empty" else 0.0)


def test_fatigue_buckets_are_integers_and_velocity_decays(con):
    """Regression: DuckDB's `/` is float division, so a naive bucket
    expression yields a row per distinct fraction instead of five."""
    t = agg.pitcher_fatigue_profile(con, SEASON).to_pylist()
    assert all(isinstance(r["pitch_bucket"], int) for r in t)
    assert {r["pitch_bucket"] for r in t} <= {0, 1, 2, 3, 4}

    for pid in PITCHERS:
        curve = sorted((r for r in t if r["pitcher_id"] == pid),
                       key=lambda r: r["pitch_bucket"])
        assert curve[0]["velo_delta_vs_bucket0"] == 0
        # start_speed declines with pitch_of_game in the fixture.
        deltas = [r["velo_delta_vs_bucket0"] for r in curve]
        assert deltas == sorted(deltas, reverse=True)


def test_power_profile_floors_at_the_statcast_era(con):
    t = agg.batter_power_profile(con, agg.STATCAST_FLOOR).to_pylist()
    assert all(r["season_floor"] == 2017 for r in t)
    career = [r for r in t if r["scope"] == "career"][0]
    # Half of each batter's at-bats are home runs by construction.
    assert career["hr"] == career["pa"] / 2
    assert career["xbh"] == career["hr"]
    assert career["barrel_rate"] == pytest.approx(1.0)   # 104 mph at 28 deg


def test_game_context_deduplicates_game_pk(store, con):
    """`mlb.schedule()` returns some games twice, so `games` holds 26,893 rows
    for 26,856 distinct game_pk in production. game_context is keyed on
    game_pk, so a duplicate is a failed publish, not a cosmetic issue."""
    baseline = agg.game_context(con, SEASON).num_rows
    assert baseline == DAYS

    # Re-write one day with its game duplicated, exactly as the feed does.
    day = date(SEASON, 7, 1).isoformat()
    _, _, games = _rows_for_day(day, 900000)
    blob = ingest.to_parquet(games * 2, "games")
    store.put(object_key("games", day), blob)

    c2 = duck.connect(store)
    duck.register(c2, store)
    assert c2.execute("select count(*) from games").fetchone()[0] == DAYS + 1
    assert agg.game_context(c2, SEASON).num_rows == baseline
    c2.close()


def test_matchup_history_respects_the_pa_floor(con):
    """The floor is a budget decision: no floor is ~34 MB and 68% of rows are
    pairs with one or two meetings."""
    high = agg.matchup_history(con, SEASON, min_pa=3).to_pylist()
    assert len(high) == len(PITCHERS) * len(BATTERS)
    assert all(r["pa_count"] >= 3 for r in high)

    impossible = agg.matchup_history(con, SEASON, min_pa=999).to_pylist()
    assert impossible == []


def test_matchup_history_keeps_the_legacy_column_names(con):
    """backend/models/stats_cache.py reads pa_count/so_count/bb_count/h_count.
    The v2 columns are additive; renaming would break the model layer."""
    cols = set(agg.matchup_history(con, SEASON).schema.names)
    assert {"pa_count", "so_count", "bb_count", "h_count"} <= cols
    assert {"hr_count", "bat_side", "pitch_hand", "last_faced",
            "season_floor"} <= cols


def test_every_registered_builder_produces_rows(con):
    """Guards the registry: a table added to BUILDERS but broken would
    otherwise only surface as a 0-row publish, which publish_aggregate
    rejects at the very end of a two-minute build."""
    for name, (fn, _) in agg.BUILDERS.items():
        floor = agg.STATCAST_FLOOR if name in agg.STATCAST_TABLES else SEASON
        assert fn(con, floor).num_rows > 0, name


# ── publish plumbing ────────────────────────────────────────────────────────

def test_rows_of_makes_arrow_json_safe(con):
    from warehouse import publish

    rows = publish.rows_of(agg.game_context(con, SEASON))
    assert isinstance(rows[0]["game_date"], str)     # date -> ISO string

    # NaN and Infinity are valid floats and invalid JSON; a rate over an empty
    # group produces them.
    assert publish._jsonable(float("nan")) is None
    assert publish._jsonable(float("inf")) is None
    assert publish._jsonable(1.5) == 1.5
