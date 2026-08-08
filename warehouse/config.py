"""Warehouse configuration: credentials, dataset layout, and Parquet schemas.

The warehouse holds MLB history as Parquet in Cloudflare R2. Unlike the
Supabase tables it supersedes, it is ingested directly from the MLB Stats API,
which means two things:

  1. Depth. Pitch-level detail (velocity, zone, plate coordinates, spin, break)
     begins in 2008 with the PITCHf/x rollout and is absent before it. Exit
     velocity and launch angle begin in 2015 with Statcast. The warehouse
     starts at 2015 so every season carries the identical field set and no
     model has to reason about a mixed schema.

  2. Width. The play-by-play response already contains ~40 measured fields per
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

SCHEMAS: dict[str, pa.Schema] = {
    "pitches": PITCH_SCHEMA,
    "at_bats": AT_BAT_SCHEMA,
    "games": GAME_SCHEMA,
    "players": PLAYER_SCHEMA,
    "predictions": PREDICTION_SCHEMA,
    "picks": PICK_SCHEMA,
    "game_predictions": GAME_PREDICTION_SCHEMA,
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
EXPORT_DATASETS = ("predictions", "picks", "game_predictions")

# Every day-partitioned dataset, whichever direction it came from.
DAY_PARTITIONED = DATASETS + EXPORT_DATASETS

# Overwritten in full each run.
SNAPSHOTS = ("players",)

# Natural keys, used to build the export checksum. A checksum mismatch at equal
# row counts means rows were substituted or renumbered.
KEY_COLUMNS: dict[str, tuple[str, ...]] = {
    "pitches": ("game_pk", "at_bat_index", "pitch_number"),
    "at_bats": ("game_pk", "at_bat_index"),
    "games": ("game_pk",),
    "players": ("player_id",),
    "predictions": ("id",),
    "picks": ("id",),
    # game_predictions has no surrogate key; this triple is its primary key.
    "game_predictions": ("game_pk", "market", "phase"),
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
