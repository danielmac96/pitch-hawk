"""Warehouse configuration: credentials, dataset layout, and Parquet schemas.

The warehouse holds MLB history as Parquet in Cloudflare R2. Unlike the
Supabase tables it supersedes, it is ingested directly from the MLB Stats API,
which means two things:

  1. Depth. Pitch-level detail (velocity, zone, plate coordinates, spin, break)
     begins in 2008 with the PITCHf/x rollout and is absent before it. Exit
     velocity and launch angle begin in 2015 with Statcast. The warehouse
     starts at 2015 so every season carries the identical field set and no
     model has to reason about a mixed schema.

  2. Width. The play-by-play response already contains ~53 measured fields per
     pitch; the Supabase ingest kept 6. Since a historical backfill re-fetches
     every game anyway, capturing the rest costs nothing but schema.

Column lists are frozen here rather than discovered from the API. A change in
the feed should be a deliberate edit to this file, never a silent change to the
Parquet layout that historical files no longer match.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

import pyarrow as pa
from dotenv import load_dotenv

load_dotenv(".env")

# Statcast era. Before 2015 there is no launch speed/angle; before 2008 there
# is no pitch data at all. Verified against the API on 2026-07-30.
FIRST_SEASON = 2015

# Days of pitch/at-bat history retained in Postgres once the hot-window swap
# lands. Both refresh_*_rolling_stats look back 30 days; 35 leaves margin.
HOT_WINDOW_DAYS = 35

MANIFEST_KEY = "_manifest.json"

_TS = pa.timestamp("us", tz="UTC")

# ── pitches ─────────────────────────────────────────────────────────────────
# Ordered: identity, situation, outcome, physics, batted ball.
#
# Conventions that matter for anyone querying this:
#   balls/strikes  are PRE-pitch (the count the pitcher faced). The MLB feed
#                  reports post-pitch counts on the event; the flattener lags
#                  them. This differs from the Supabase `pitches` table, which
#                  stores post-pitch counts.
#   home_score/away_score are PRE-plate-appearance (the score the pitcher
#                  faced), carried forward from the previous play's result.
#   men_on_base    is DERIVED from base occupancy carried forward from the
#                  previous play, reset at each half-inning:
#                  Empty | Men_On | RISP | Loaded. The API's
#                  matchup.splits.menOnBase is deliberately NOT used: it is the
#                  state AFTER the play and leaks the at-bat's own outcome. A
#                  batter who reaches base always shows a runner on, so a model
#                  trained on it validates beautifully and is worthless live.
#                  See warehouse/mlb.py:men_on_base(), and the test in
#                  tests/warehouse/test_mlb_flatten.py that sets splits to a
#                  deliberately wrong value to prove nothing reads it.
#   pitch_of_game  is that pitcher's cumulative pitch count in the game, which
#                  is what a fatigue/velocity-decay model needs.
PITCH_SCHEMA = pa.schema([
    # identity
    ("game_pk", pa.int64()),
    ("at_bat_index", pa.int32()),
    ("pitch_number", pa.int32()),
    ("pitcher_id", pa.int32()),
    ("batter_id", pa.int32()),
    ("game_date", pa.date32()),
    ("pitch_ts", _TS),
    # situation (pre-pitch)
    ("balls", pa.int32()),
    ("strikes", pa.int32()),
    ("outs", pa.int32()),
    ("inning", pa.int32()),
    ("top_inning", pa.bool_()),
    ("men_on_base", pa.string()),
    ("on_first", pa.int32()),
    ("on_second", pa.int32()),
    ("on_third", pa.int32()),
    ("home_score", pa.int32()),
    ("away_score", pa.int32()),
    ("pitch_of_game", pa.int32()),
    ("times_through_order", pa.int32()),
    ("bat_side", pa.string()),
    ("pitch_hand", pa.string()),
    # outcome
    ("pitch_type", pa.string()),
    ("description", pa.string()),
    ("result_category", pa.string()),
    ("is_strike", pa.bool_()),
    ("is_ball", pa.bool_()),
    ("is_in_play", pa.bool_()),
    # physics
    ("start_speed", pa.float64()),
    ("end_speed", pa.float64()),
    ("zone", pa.int32()),
    ("plate_x", pa.float64()),
    ("plate_z", pa.float64()),
    ("sz_top", pa.float64()),
    ("sz_bottom", pa.float64()),
    ("spin_rate", pa.int32()),
    ("spin_direction", pa.int32()),
    ("break_vertical_induced", pa.float64()),
    ("break_horizontal", pa.float64()),
    ("break_angle", pa.float64()),
    ("break_length", pa.float64()),
    ("extension", pa.float64()),
    ("plate_time", pa.float64()),
    # release point, trajectory and movement (pitchData.coordinates)
    #
    # These arrive in the SAME payload as plate_x/plate_z and were discarded
    # until 2026-09; capturing them costs no extra API call. Release point is
    # what separates two pitchers throwing identical velocity and spin, and
    # pfx_x/pfx_z are the movement values nearly every public Statcast analysis
    # is written against.
    #
    # `coordinates` also carries `x`/`y`, the legacy Gameday pixel coordinates.
    # They are deliberately NOT captured: they are display units with no
    # physical meaning, and plate_x/plate_z already hold the real position.
    #
    # Coverage is NOT assumed to match plate_x. Measure it per season before any
    # model reasons about a null here -- `extension` looked complete too until
    # someone checked 2015 and found 0.1% (docs/DATA-PIPELINE.md 5.4).
    ("release_pos_x", pa.float64()),
    ("release_pos_y", pa.float64()),
    ("release_pos_z", pa.float64()),
    ("release_vel_x", pa.float64()),
    ("release_vel_y", pa.float64()),
    ("release_vel_z", pa.float64()),
    ("accel_x", pa.float64()),
    ("accel_y", pa.float64()),
    ("accel_z", pa.float64()),
    ("pfx_x", pa.float64()),
    ("pfx_z", pa.float64()),
    # breaks.* beyond the induced value we already kept
    ("break_vertical", pa.float64()),
    # typeConfidence qualifies pitch_type, which is a classifier output rather
    # than a measurement, so a low value is a real caveat on any arsenal stat.
    ("type_confidence", pa.float64()),
    #
    # Deliberately NOT captured, having been measured against live games:
    #   breaks.breakY          constant 24.0 -- the measurement distance
    #   pitchData.strikeZoneWidth  constant 17.0 -- the width of home plate
    #   pitchData.strikeZoneDepth  constant within a game, and inconsistent
    #                              between games (17.0 vs 8.5), so it measures
    #                              nothing about the pitch either way
    # All three are plate geometry, not observations. sz_top/sz_bottom DO vary
    # per batter and are kept. Storing 7.9M copies of a constant buys nothing.
    # batted ball (2015+, only on balls in play)
    ("launch_speed", pa.float64()),
    ("launch_angle", pa.float64()),
    ("total_distance", pa.float64()),
    ("trajectory", pa.string()),
    ("hit_hardness", pa.string()),
    ("hit_location", pa.string()),
    ("hit_coord_x", pa.float64()),
    ("hit_coord_y", pa.float64()),
])

# ── at_bats ─────────────────────────────────────────────────────────────────
AT_BAT_SCHEMA = pa.schema([
    ("game_pk", pa.int64()),
    ("at_bat_index", pa.int32()),
    ("pitcher_id", pa.int32()),
    ("batter_id", pa.int32()),
    ("game_date", pa.date32()),
    ("inning", pa.int32()),
    ("top_inning", pa.bool_()),
    ("pitch_count", pa.int32()),
    ("result", pa.string()),
    ("result_detail", pa.string()),
    ("event", pa.string()),
    ("rbi", pa.int32()),
    ("is_scoring_play", pa.bool_()),
    ("men_on_base", pa.string()),
    ("home_score", pa.int32()),
    ("away_score", pa.int32()),
    ("times_through_order", pa.int32()),
    ("bat_side", pa.string()),
    ("pitch_hand", pa.string()),
    ("start_ts", _TS),
    ("end_ts", _TS),
])

# ── games ───────────────────────────────────────────────────────────────────
# Includes the boxscore context the dropped game_context/umpire_stats tables
# were meant to hold: home-plate umpire, weather, wind, attendance.
GAME_SCHEMA = pa.schema([
    ("game_pk", pa.int64()),
    ("game_date", pa.date32()),
    ("season", pa.int32()),
    ("game_type", pa.string()),
    ("status", pa.string()),
    ("home_team_id", pa.int32()),
    ("away_team_id", pa.int32()),
    ("home_team", pa.string()),
    ("away_team", pa.string()),
    ("home_abbr", pa.string()),
    ("away_abbr", pa.string()),
    ("home_score", pa.int32()),
    ("away_score", pa.int32()),
    ("venue_id", pa.int32()),
    ("venue_name", pa.string()),
    ("start_ts", _TS),
    # boxscore context
    ("hp_umpire_id", pa.int32()),
    ("hp_umpire", pa.string()),
    ("weather_condition", pa.string()),
    ("temp_f", pa.int32()),
    ("wind_mph", pa.int32()),
    ("wind_direction", pa.string()),
    ("attendance", pa.int32()),
    ("game_duration_min", pa.int32()),
])

# ── players ─────────────────────────────────────────────────────────────────
PLAYER_SCHEMA = pa.schema([
    ("player_id", pa.int32()),
    ("full_name", pa.string()),
    ("bat_side", pa.string()),
    ("pitch_hand", pa.string()),
    ("position", pa.string()),
    ("debut_date", pa.date32()),
    ("birth_date", pa.date32()),
])

# ── venues ──────────────────────────────────────────────────────────────────
# Grain is venue x SEASON, not venue. Park dimensions change: Camden Yards
# (venue 2) reports left_center 410 through 2022 and 376 from 2025, and
# right_center is null in 2017 and populated from 2021. Storing a single
# current-state row would silently explain a 2017 home run with a 2026 fence.
#
# `/venues?sportId=1&season=YYYY` honours the season and returns every venue in
# one call, so all of history is ~12 requests rather than 30 per season.
#
# Coverage, measured 2026-09-18: all 30 active MLB venues carry latitude,
# longitude, elevation, azimuth_angle and the five outfield distances. The
# wider 55-63 rows the endpoint returns include spring-training and minor
# league parks, many of which do NOT -- filter on the venue_ids that appear in
# `games` before treating a null as meaningful.
#
# azimuth_angle is the compass bearing of the field. It is what turns a wind
# direction into "blowing out toward the pull field" rather than a bare number.
#
# roof_type is Open | Retractable | Dome. It is the roof the park HAS, never
# whether the roof was CLOSED for a given game -- that is per-game and comes
# from the weather string (condition 'Dome' / 'Roof Closed', wind '0 mph,
# None'), not from here.
VENUE_SCHEMA = pa.schema([
    ("venue_id", pa.int32()),
    ("season", pa.int32()),
    ("name", pa.string()),
    ("city", pa.string()),
    ("state", pa.string()),
    ("latitude", pa.float64()),
    ("longitude", pa.float64()),
    ("elevation_ft", pa.int32()),
    ("azimuth_angle", pa.float64()),
    ("tz_id", pa.string()),
    ("roof_type", pa.string()),
    ("turf_type", pa.string()),
    ("capacity", pa.int32()),
    ("left_line", pa.int32()),
    ("left_center", pa.int32()),
    ("center", pa.int32()),
    ("right_center", pa.int32()),
    ("right_line", pa.int32()),
])


# ── game_weather ────────────────────────────────────────────────────────────
# Gametime conditions per game, from Open-Meteo. One row per game, day
# partitioned to match `games` so DuckDB joins them on identical Hive keys.
#
# WHY THIS EXISTS RATHER THAN REUSING `games.temp_f`.
# The warehouse already stores weather -- parsed out of the BOXSCORE, which
# only exists once a game is final. A pregame call cannot read it. Training a
# weather term on post-hoc observations and then serving it a forecast is a
# train/serve mismatch, and the model would never show it. Open-Meteo has both
# a forecast API and an archive reaching back decades, so both sides of that
# line can be fed from ONE source with one set of units and one grid.
#
# `games.temp_f` is kept as-is. It is MLB's own reading and the honest record
# of what the club reported; this is a second, independent observation. They
# will not agree exactly and are not meant to.
#
# ROOF STATE IS NOT HERE, DELIBERATELY. 8 of 30 parks can be covered, and an
# outdoor reading for a covered game is not a weak feature but a wrong one.
# The gate is a per-game MLB fact (`games.weather_condition` reads 'Dome' or
# 'Roof Closed'), so it is derived once where that column lives and applied at
# read time. Duplicating it here is how two copies drift apart.
WEATHER_SCHEMA = pa.schema([
    ("game_pk", pa.int64()),
    ("game_date", pa.date32()),
    ("venue_id", pa.int32()),
    # The hour actually sampled: the UTC hour containing first pitch.
    ("obs_ts", _TS),
    ("temp_f", pa.float64()),
    ("humidity_pct", pa.float64()),
    ("wind_mph", pa.float64()),
    # Meteorological convention: the direction the wind blows FROM.
    ("wind_dir_deg", pa.float64()),
    # Signed component along home -> center field, in mph. Positive is blowing
    # out. This is the column a home-run model actually wants: bare speed says
    # nothing without the park's orientation. See warehouse/weather.py for the
    # derivation and the empirical check on its sign.
    ("wind_out_mph", pa.float64()),
    ("pressure_hpa", pa.float64()),
    ("precip_in", pa.float64()),
    ("source", pa.string()),
])


# ── contact_quality ─────────────────────────────────────────────────────────
# P(hit) and P(home run) GIVEN A BALL IN PLAY, by how it was struck.
#
# This is the in-house xBA / xHR. Baseball Savant publishes
# `estimated_ba_using_speedangle`, but that is itself a lookup on exit velocity
# and launch angle -- and we hold 11 seasons of both PLUS the realised outcome.
# So the table is fitted from our own data rather than scraped, which also
# means it can carry spray angle, which Savant's two-variable version cannot.
#
# TWO GRAINS, emitted into one table so a consumer backs off explicitly rather
# than silently:
#   ev_la_pull   exit velocity x launch angle x pull angle -- the real thing
#   ev_la        the same table marginalised over spray, always populated
# A cell below MIN_OBS at the fine grain is not emitted at all; the consumer
# falls back to `ev_la`. Counts are kept alongside the rates so any shrinkage
# is still possible downstream -- no prior is baked in here, because none has
# been validated.
#
# PULL ANGLE, not raw spray. Spray is signed from the catcher's view
# (negative toward the left-field line); pull angle flips it for right-handed
# batters so positive is always "toward the batter's pull side". That makes
# the table handedness-agnostic and roughly doubles the sample per cell.
# Measured: home runs average +16.1 degrees of pull against +4.2 for all
# batted balls, which is the pulled-fly-ball effect the column exists to carry.
#
# THESE ARE CONDITIONAL ON CONTACT. P(hit) here is per ball in play, never per
# plate appearance -- strikeouts and walks are not in the denominator. A caller
# wanting a per-PA number must multiply by P(ball in play).
#
# Floored at 2017: launch_speed covers 87% of balls in play in 2015 and does
# not pass 99% until 2020, so an earlier cell measures coverage, not contact.
CONTACT_SCHEMA = pa.schema([
    ("grain", pa.string()),
    # Bucket LOWER EDGES, in the feature's own units, so a consumer recovers
    # the value without needing to know the step.
    ("ev_bucket", pa.int32()),
    ("la_bucket", pa.int32()),
    ("pull_bucket", pa.int32()),      # null at the `ev_la` grain
    ("season_floor", pa.int32()),
    ("n", pa.int64()),
    ("hits", pa.int64()),
    ("hr", pa.int64()),
    ("xbh", pa.int64()),
    ("total_bases", pa.int64()),
    ("p_hit", pa.float64()),
    ("p_hr", pa.float64()),
    ("p_xbh", pa.float64()),
    # Expected total bases per ball in play -- the single number that ranks
    # contact quality without picking between "a hit" and "a home run".
    ("xtb", pa.float64()),
])


# ── Our own output, exported back out of Supabase ───────────────────────────
#
# Everything above this line is MLB's data, re-derivable from the API at any
# time. Everything below is OURS: what the model said, and whether it was
# right. That difference is not cosmetic — it is why these are a separate
# dataset family (see EXPORT_DATASETS).
#
# Supabase deletes `predictions` after 21 days, `game_predictions` after 35 and
# `picks` never but unboundedly. Before this export existed, every graded
# prediction older than three weeks was gone, which is why no holdout
# validation exists anywhere in this project.
#
# `probs` and `payload` are jsonb upstream. Parquet has no native JSON type, so
# they land as strings holding JSON. DuckDB reads them back with json_extract.

PREDICTION_SCHEMA = pa.schema([
    ("id", pa.int64()),
    ("game_pk", pa.int64()),
    # Denormalised from `games` so a file is self-describing. `created_at` is
    # NOT a substitute: a prediction written at 23:30 ET belongs to that day's
    # slate but carries the next day's UTC date.
    ("official_date", pa.date32()),
    ("at_bat_index", pa.int32()),
    ("pitch_number", pa.int32()),
    ("market", pa.string()),
    ("predicted_value", pa.float64()),
    ("confidence", pa.float64()),
    ("probs", pa.string()),
    ("recommendation", pa.string()),
    ("line", pa.float64()),
    ("price", pa.int32()),
    ("edge", pa.float64()),
    ("units", pa.float64()),
    ("result", pa.string()),
    # What actually happened, not just whether we were right. Added
    # 2026-08-08 with migration 20260808000002; rows graded before it carry
    # nulls, and no backfill is possible past the 35-day `pitches` window.
    # Without these, out-of-sample scoring has to re-join `pitches` in R2 —
    # possible, since both sides share this partitioning, but needless.
    ("actual_value", pa.float64()),
    ("actual_label", pa.string()),
    ("profit_units", pa.float64()),
    ("graded_at", pa.timestamp("us", tz="UTC")),
    ("model_version", pa.string()),
    ("created_at", pa.timestamp("us", tz="UTC")),
    ("book", pa.string()),
])

PICK_SCHEMA = pa.schema([
    ("id", pa.int64()),
    ("pick_date", pa.date32()),
    ("game_pk", pa.int64()),
    ("at_bat_index", pa.int32()),
    ("market", pa.string()),
    ("recommendation", pa.string()),
    ("label", pa.string()),
    ("line", pa.float64()),
    ("price", pa.int32()),
    ("confidence", pa.float64()),
    ("edge", pa.float64()),
    ("units", pa.float64()),
    ("book", pa.string()),
    ("source", pa.string()),
    ("model_version", pa.string()),
    ("status", pa.string()),
    ("profit_units", pa.float64()),
    ("payload", pa.string()),
    ("created_at", pa.timestamp("us", tz="UTC")),
    ("graded_at", pa.timestamp("us", tz="UTC")),
])

GAME_PREDICTION_SCHEMA = pa.schema([
    ("game_pk", pa.int64()),
    ("official_date", pa.date32()),
    ("market", pa.string()),
    ("phase", pa.string()),
    ("predicted_value", pa.float64()),
    ("probs", pa.string()),
    ("recommendation", pa.string()),
    ("confidence", pa.float64()),
    ("line", pa.float64()),
    ("price", pa.int32()),
    ("edge", pa.float64()),
    ("book", pa.string()),
    ("model_version", pa.string()),
    ("home_team_id", pa.int32()),
    ("away_team_id", pa.int32()),
    ("home_abbr", pa.string()),
    ("away_abbr", pa.string()),
    ("home_pitcher_id", pa.int32()),
    ("away_pitcher_id", pa.int32()),
    ("actual_value", pa.float64()),
    ("result", pa.string()),
    ("profit_units", pa.float64()),
    ("graded_at", pa.timestamp("us", tz="UTC")),
    ("n_pitch_predictions", pa.int32()),
    ("scored_at", pa.timestamp("us", tz="UTC")),
    ("updated_at", pa.timestamp("us", tz="UTC")),
])

PROJECTION_SCHEMA = pa.schema([
    ("game_pk", pa.int64()),
    ("player_id", pa.int32()),
    ("market", pa.string()),
    ("official_date", pa.date32()),
    ("team_id", pa.int32()),
    ("opponent_id", pa.int32()),
    ("is_home", pa.bool_()),
    ("lineup_slot", pa.int32()),
    ("opposing_pitcher_id", pa.int32()),
    ("probability", pa.float64()),
    ("per_pa_probability", pa.float64()),
    ("expected_pa", pa.float64()),
    ("model_version", pa.string()),
    ("book", pa.string()),
    # The graded outcome. This is the reason the dataset is exported at all:
    # Supabase prunes these at 35 days, so without a copy the realised
    # calibration record would only ever cover the last five weeks -- and a
    # five-week window is exactly what you cannot answer "is this model
    # drifting" with.
    ("result", pa.string()),
    ("actual_count", pa.int32()),
    ("plate_appearances", pa.int32()),
    ("graded_at", _TS),
    ("scored_at", _TS),
    ("updated_at", _TS),
])

SCHEMAS: dict[str, pa.Schema] = {
    "pitches": PITCH_SCHEMA,
    "at_bats": AT_BAT_SCHEMA,
    "games": GAME_SCHEMA,
    "players": PLAYER_SCHEMA,
    "venues": VENUE_SCHEMA,
    "game_weather": WEATHER_SCHEMA,
    "contact_quality": CONTACT_SCHEMA,
    "predictions": PREDICTION_SCHEMA,
    "picks": PICK_SCHEMA,
    "game_predictions": GAME_PREDICTION_SCHEMA,
    "player_game_projections": PROJECTION_SCHEMA,
}

# Date-partitioned datasets ingested FROM the MLB API, one file per day.
DATASETS = ("pitches", "at_bats", "games")

# Date-partitioned datasets exported FROM Supabase, one file per day.
#
# Deliberately NOT part of DATASETS, and the separation is load-bearing:
# `warehouse.verify` earns a day its manifest verification by re-fetching it
# from the MLB API and re-deriving it from scratch. There is no upstream to
# re-fetch these from — they are our own model output, and Supabase deletes
# them on a retention timer. A verify pass over them could only ever compare
# them against themselves, which is exactly the self-certification defect that
# made the v1 manifest worthless (see manifest.py).
#
# So: these days carry `ingested_at` and never `verified_at`. Nothing gates on
# their verification, and the prune's delete gate only ever asks about
# `pitches`.
EXPORT_DATASETS = ("predictions", "picks", "game_predictions",
                   "player_game_projections")

# Day-partitioned, but sourced from neither the MLB API nor Supabase.
#
# A third family rather than a member of DATASETS, because DATASETS is the set
# `warehouse.verify` re-derives by re-fetching from the MLB Stats API. There is
# no MLB upstream for these, so sweeping them in would mean either a verify
# that silently skips them or one that compares them against themselves --
# the self-certification defect that made the v1 manifest worthless.
#
# Unlike EXPORT_DATASETS these ARE independently re-fetchable, from Open-Meteo,
# whose archive is stable for a past date. A verifier for them is therefore
# possible and simply does not exist yet. Nothing gates on their verification.
DERIVED_DATASETS = ("game_weather",)

# Every day-partitioned dataset, whichever direction it came from.
DAY_PARTITIONED = DATASETS + EXPORT_DATASETS + DERIVED_DATASETS

# Overwritten in full each run.
SNAPSHOTS = ("players", "venues", "contact_quality")

# Natural keys, used to build the export checksum. A checksum mismatch at equal
# row counts means rows were substituted or renumbered.
KEY_COLUMNS: dict[str, tuple[str, ...]] = {
    "pitches": ("game_pk", "at_bat_index", "pitch_number"),
    "at_bats": ("game_pk", "at_bat_index"),
    "games": ("game_pk",),
    "players": ("player_id",),
    "venues": ("venue_id", "season"),
    "game_weather": ("game_pk",),
    "contact_quality": ("grain", "ev_bucket", "la_bucket", "pull_bucket"),
    "predictions": ("id",),
    "picks": ("id",),
    # game_predictions has no surrogate key; this triple is its primary key.
    "game_predictions": ("game_pk", "market", "phase"),
    "player_game_projections": ("game_pk", "player_id", "market"),
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


def supabase_client():
    """Service-role Supabase client, shared by every Python caller.

    `supabase` is imported lazily so the R2/Parquet side of the warehouse — the
    manifest, the DuckDB reader, the aggregate builders — stays usable with no
    Supabase dependency installed at all.

    One home on purpose. This used to exist three times (`backend/db/client.py`,
    `warehouse.publish._client`, `warehouse.export._client`), which meant three
    different error messages for the same missing environment variable.
    """
    from supabase import create_client

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_KEY")
    if not url or not key:
        raise RuntimeError(
            "SUPABASE_URL and SUPABASE_KEY are required; set them in .env "
            "locally or as Actions secrets. Writes (model_params, the display "
            "aggregates, the holdout export) need the service-role key.")
    return create_client(url, key)


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
    """Key for one date-partitioned dataset-day. `day` is YYYY-MM-DD.

    Accepts both the MLB-sourced datasets and the Supabase exports; they share
    one key scheme so DuckDB can join a prediction to the pitch it was made
    against with the same Hive partitioning on both sides.
    """
    if dataset not in DAY_PARTITIONED:
        raise ValueError(
            f"unknown dataset {dataset!r}; "
            f"expected one of {sorted(DAY_PARTITIONED)}")
    return f"{dataset}/season={day[:4]}/month={day[5:7]}/day={day}.parquet"


def snapshot_key(dataset: str) -> str:
    if dataset not in SNAPSHOTS:
        raise ValueError(
            f"unknown snapshot {dataset!r}; expected one of {sorted(SNAPSHOTS)}")
    return f"{dataset}/snapshot.parquet"
