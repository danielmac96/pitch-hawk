"""Display aggregates, computed in DuckDB over the R2 warehouse.

Seven tables, each built by one function returning a PyArrow table. They serve
the frontend only. **No model tables live here** — `market_baselines`,
`holdout_predictions`, `context_cells` and the rest are deferred; see the
"Deferred" section of docs/plans/data-pipeline-2026-08-02.md.

Two windowing rules, and both are deliberate:

  WINDOW_SEASONS = 3   Player-scoped tables cover the last three seasons. The
                       measured cardinalities the budget was sized from are
                       three-season numbers, and a player who last pitched in
                       2016 is not a surface anyone needs.

  game_context         Full history. It is one row per game with no player
                       grain, so all 26,893 games cost ~6 MB.

`scope='career'` therefore means "everything in the published window", not
"everything ever". That is a real distinction, so every scoped table carries a
`season_floor` column stating the earliest season it actually includes —
rather than leaving a reader to assume 2015.

STATCAST_FLOOR = 2017 exists because the feed changes underneath us:
`extension` is 0.1% populated in 2015 and 0.3% in 2016, then 99.6% from 2017.
`launch_speed` runs 87% of balls in play in 2015 and only passes 99% in 2020.
Pre-2017 nulls are NOT missing-at-random, so `batter_power_profile` — the one
table built on Statcast columns — floors at 2017 and says so in its own
`season_floor`.
"""

from __future__ import annotations

from datetime import datetime, timezone

WINDOW_SEASONS = 3
STATCAST_FLOOR = 2017

# Minimum pitches for a player to earn a profile row. Mirrors the floor in
# refresh_pitcher_rolling_stats so the warehouse `d30` scope and the Postgres
# rolling table describe the same population.
MIN_PITCHES = 30

# In-game pitch-count buckets for the fatigue curve: 0-24, 25-49, 50-74,
# 75-99, 100+. Integer division is explicit -- DuckDB's `/` is float division,
# which silently produces fractional buckets and a row per distinct fraction.
BUCKET = "least(cast(pitch_of_game / 25 as integer), 4)"

# Swing / contact vocabulary, shared by both profile builders so a pitcher's
# whiff rate and a batter's are computed identically.
_SWUNG = "(description in ('swinging_strike','foul') or result_category = 'in_play')"
_WHIFF = "description = 'swinging_strike'"
_CONTACT = "(description = 'foul' or result_category = 'in_play')"
_FASTBALL = "pitch_type in ('FF','FT','SI','FC')"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _scoped(table: str) -> str:
    """Fan `table` out across the three scopes.

    `career` is the whole published window; `season` is the latest season
    present; `d30` is the trailing 30 days of game dates actually in the
    warehouse -- not of wall-clock time, so a stalled ingest narrows the
    window rather than silently emptying it.
    """
    return f"""
    (select sc.scope, t.*
       from {table} t
       cross join (select unnest(['career','season','d30']) as scope) sc
       cross join (select max(game_date) as maxd,
                          max(cast(year(game_date) as integer)) as maxy
                     from {table}) b
      where sc.scope = 'career'
         or (sc.scope = 'season' and cast(year(t.game_date) as integer) = b.maxy)
         or (sc.scope = 'd30' and t.game_date >= b.maxd - interval 29 day))
    """


# ── 1 & 2: pitcher / batter profiles ────────────────────────────────────────

def _profiles(con, role: str, season_floor: int):  # noqa: ANN001
    """Shared body. `role` picks which side of the matchup is the subject."""
    id_col = "pitcher_id" if role == "pitcher" else "batter_id"
    sql = f"""
    with px as {_scoped('pitches')},
    ax as {_scoped('at_bats')},
    p as (
        select scope, {id_col} as player_id,
               count(*)                                        as pitches,
               count(*) filter (where zone between 1 and 9)     as in_zone,
               count(*) filter (where zone > 9)                 as out_zone,
               count(*) filter (where {_SWUNG})                 as swung,
               count(*) filter (where {_SWUNG} and zone > 9)    as chased,
               count(*) filter (where {_WHIFF})                 as whiffs,
               count(*) filter (where {_CONTACT})               as contact,
               avg(start_speed) filter (where {_FASTBALL})      as fb_velo,
               avg(start_speed) filter (where not {_FASTBALL})  as os_velo
          from px
         where {id_col} is not null
         group by 1, 2
        having count(*) >= {MIN_PITCHES}
    ),
    a as (
        select scope, {id_col} as player_id,
               count(*)                                       as pa,
               avg(case when result = 'strikeout' then 1.0 else 0.0 end) as k_rate,
               avg(case when result = 'walk'      then 1.0 else 0.0 end) as bb_rate
          from ax
         where {id_col} is not null
         group by 1, 2
    )
    select p.player_id,
           p.scope,
           {season_floor}                                      as season_floor,
           p.pitches,
           coalesce(a.pa, 0)                                    as pa,
           round(p.in_zone   / nullif(p.pitches,  0), 4)        as zone_rate,
           round(p.whiffs    / nullif(p.swung,    0), 4)        as whiff_rate,
           round(p.chased    / nullif(p.out_zone, 0), 4)        as chase_rate,
           round(p.contact   / nullif(p.swung,    0), 4)        as contact_rate,
           round(a.k_rate,  4)                                  as k_rate,
           round(a.bb_rate, 4)                                  as bb_rate,
           round(p.fb_velo, 1)                                  as avg_fastball_velo,
           round(p.os_velo, 1)                                  as avg_offspeed_velo
      from p left join a using (scope, player_id)
     order by p.player_id, p.scope
    """
    return con.execute(sql).fetch_arrow_table()


def pitcher_profiles(con, season_floor: int):  # noqa: ANN001
    return _profiles(con, "pitcher", season_floor)


def batter_profiles(con, season_floor: int):  # noqa: ANN001
    return _profiles(con, "batter", season_floor)


# ── 3: situational splits ───────────────────────────────────────────────────

def situational_splits(con, season_floor: int):  # noqa: ANN001
    """player x role x base-state x opposing hand.

    This is the table DATA-INVENTORY called our "single biggest gap" —
    *"We do not record who is on base... we cannot produce any of them."*
    That has been false since the warehouse landed: `men_on_base` is 100%
    populated across all 2,013 days, derived from carried-forward base
    occupancy rather than the leaky `matchup.splits.menOnBase`.

    No minimum-PA floor: the measured 16k budget assumed none, and a
    bases-loaded split with three plate appearances is still the honest
    answer to "how has he done with the bases loaded".
    """
    sql = f"""
    with ab as (
        select pitcher_id, batter_id, men_on_base, bat_side, pitch_hand, result
          from at_bats
    ),
    velo as (
        select pitcher_id, men_on_base, bat_side, avg(start_speed) as v
          from pitches where pitcher_id is not null group by 1,2,3
    ),
    p as (
        select 'pitcher' as role, pitcher_id as player_id, men_on_base,
               bat_side as opp_hand, count(*) as pa,
               avg(case when result='strikeout' then 1.0 else 0.0 end) as k_rate,
               avg(case when result='walk'      then 1.0 else 0.0 end) as bb_rate,
               avg(case when result='hit'       then 1.0 else 0.0 end) as hit_rate
          from ab where pitcher_id is not null group by 1,2,3,4
    ),
    b as (
        select 'batter' as role, batter_id as player_id, men_on_base,
               pitch_hand as opp_hand, count(*) as pa,
               avg(case when result='strikeout' then 1.0 else 0.0 end),
               avg(case when result='walk'      then 1.0 else 0.0 end),
               avg(case when result='hit'       then 1.0 else 0.0 end)
          from ab where batter_id is not null group by 1,2,3,4
    ),
    u as (select * from p union all select * from b)
    select u.player_id, u.role, u.men_on_base, u.opp_hand,
           {season_floor} as season_floor,
           u.pa,
           round(u.k_rate, 4)   as k_rate,
           round(u.bb_rate, 4)  as bb_rate,
           round(u.hit_rate, 4) as hit_rate,
           round(velo.v, 1)     as avg_velo
      from u
      left join velo
        on u.role = 'pitcher' and velo.pitcher_id = u.player_id
       and velo.men_on_base = u.men_on_base and velo.bat_side = u.opp_hand
     where u.men_on_base is not null and u.opp_hand is not null
     order by u.role, u.player_id, u.men_on_base, u.opp_hand
    """
    return con.execute(sql).fetch_arrow_table()


# ── 4: pitcher fatigue ──────────────────────────────────────────────────────

def pitcher_fatigue_profile(con, season_floor: int):  # noqa: ANN001
    """The *typical* decay curve per pitcher. The *current game's* trend is
    computed live from the 35-day hot `pitches` table in Postgres — which is
    why no per-game pitcher log is reinstated.

    `velo_delta_vs_bucket0` is within-pitcher, so league-wide velocity drift
    across seasons cancels out of it.
    """
    sql = f"""
    with b as (
        select pitcher_id, {BUCKET} as pitch_bucket,
               count(*) as n,
               avg(start_speed) as mean_velo,
               count(*) filter (where {_WHIFF}) as whiffs,
               count(*) filter (where {_SWUNG}) as swung
          from pitches
         where pitcher_id is not null and pitch_of_game is not null
         group by 1, 2
    ),
    base as (select pitcher_id, mean_velo from b where pitch_bucket = 0)
    select b.pitcher_id,
           b.pitch_bucket,
           {season_floor} as season_floor,
           b.n,
           round(b.mean_velo, 1) as mean_velo,
           round(b.mean_velo - base.mean_velo, 2) as velo_delta_vs_bucket0,
           round(b.whiffs / nullif(b.swung, 0), 4) as whiff_rate
      from b left join base using (pitcher_id)
     order by b.pitcher_id, b.pitch_bucket
    """
    return con.execute(sql).fetch_arrow_table()


# ── 5: batter power ─────────────────────────────────────────────────────────

def batter_power_profile(con, season_floor: int):  # noqa: ANN001
    """HR / XBH / ISO / barrel rate.

    Needs no new capture: `at_bats.result_detail` has distinguished
    single/double/triple/home_run all along, and the serve path collapses all
    of it into one `hit` bucket. Statcast columns add barrel rate on top.

    `barrel` uses the standard approximation — exit velocity >= 98 mph with a
    launch-angle window centred on 26-30 degrees that widens by one degree
    each way per mph above 98.

    Floored at STATCAST_FLOOR: launch_speed covers only 87% of balls in play
    in 2015, so a pre-2017 barrel rate is a coverage artefact, not a skill
    measurement.
    """
    sql = f"""
    with ax as {_scoped('at_bats')},
    px as {_scoped('pitches')},
    a as (
        select scope, batter_id,
               count(*) as pa,
               count(*) filter (where result_detail = 'home_run') as hr,
               count(*) filter (where result_detail in ('double','triple','home_run')) as xbh,
               count(*) filter (where result_detail = 'single')    as singles,
               count(*) filter (where result_detail = 'double')    as doubles,
               count(*) filter (where result_detail = 'triple')    as triples,
               -- ISO needs at-bats, not plate appearances: walks, HBP and
               -- sacrifices are plate appearances but not at-bats.
               count(*) filter (where result_detail not in (
                   'walk','intent_walk','hit_by_pitch','sac_fly','sac_bunt',
                   'catcher_interf')) as ab
          from ax where batter_id is not null group by 1, 2
    ),
    bb as (
        select scope, batter_id,
               count(*) filter (where launch_speed is not null) as tracked,
               count(*) filter (
                   where launch_speed >= 98
                     and launch_angle between 26 - (launch_speed - 98)
                                          and 30 + (launch_speed - 98)) as barrels,
               avg(launch_speed) as ev,
               avg(launch_angle) as la
          from px
         where batter_id is not null and result_category = 'in_play'
         group by 1, 2
    )
    select a.batter_id,
           a.scope,
           {season_floor} as season_floor,
           a.pa,
           a.hr,
           a.xbh,
           (a.singles + 2*a.doubles + 3*a.triples + 4*a.hr) as total_bases,
           round(((a.singles + 2*a.doubles + 3*a.triples + 4*a.hr)
                  - (a.singles + a.doubles + a.triples + a.hr))
                 / nullif(a.ab, 0), 4)                    as iso,
           round(bb.barrels / nullif(bb.tracked, 0), 4)   as barrel_rate,
           round(bb.ev, 1)                                as avg_launch_speed,
           round(bb.la, 1)                                as avg_launch_angle
      from a left join bb using (scope, batter_id)
     where a.pa >= 10
     order by a.batter_id, a.scope
    """
    return con.execute(sql).fetch_arrow_table()


# ── 6: game context ─────────────────────────────────────────────────────────

def game_context(con, season_floor: int):  # noqa: ANN001
    """One row per game. A copy, not an ingestion project.

    The dropped `game_context`/`umpire_stats` tables were removed in
    20260728000001 after never holding a row, while GAME_SCHEMA has carried
    hp_umpire_id, weather, wind, attendance and duration for every game all
    along. Full history: no player grain, so 26,893 games cost ~6 MB.

    The QUALIFY is load-bearing. `games` holds 26,893 rows for 26,856 distinct
    game_pk: `mlb.schedule()` appends every entry the schedule endpoint returns
    for a date without deduplicating gamePk, and for 37 games it returns the
    same game twice. The rows are byte-identical, so keeping one is lossless.
    `pitches` and `at_bats` are unaffected -- ingest_day builds those from a
    dict keyed by game_pk; only `games` is built from the list.

    Deliberately NOT fixed in mlb.schedule(): verify re-derives a day with the
    same code, so deduplicating at ingest would change the re-derived row count
    for those 37 days and fail verification on every one of them until each was
    re-ingested. That is a separately-scheduled repair, not a side effect of
    shipping the read layer.
    """
    sql = """
    select game_pk, game_date, season, game_type,
           home_team_id, away_team_id, home_abbr, away_abbr,
           home_score, away_score,
           venue_id, venue_name,
           hp_umpire_id, hp_umpire,
           weather_condition, temp_f, wind_mph, wind_direction,
           attendance, game_duration_min
      from games
     qualify row_number() over (partition by game_pk order by game_date) = 1
     order by game_pk
    """
    return con.execute(sql).fetch_arrow_table()


# ── 7: matchup history v2 ───────────────────────────────────────────────────

def matchup_history(con, season_floor: int, min_pa: int = 3):  # noqa: ANN001
    """pitcher x batter head-to-head.

    The PA floor is a budget decision, not a default. Measured over three
    seasons: no floor is 200,602 pairs / ~34 MB, and 68% of those rows are
    pairs with one or two career meetings, which carry no signal. A >= 3 floor
    is 65,327 pairs / ~11 MB. Keep it configurable; keep it defaulted to 3.

    This replaces the Postgres `refresh_matchup_history()` dropped in
    20260802000002, which recomputed from an unwindowed `at_bats` and would
    have overwritten career counts with 35-day figures after the hot-window
    swap.

    Emits `pa_count` rather than `pa` because this REPLACES the contents of the
    existing Postgres `matchup_history` rather than creating a v2 table beside
    it. `backend/models/stats_cache.py:396` reads pa_count/so_count/bb_count/
    h_count; renaming them would break the deferred model layer for no gain.
    The v2 columns are added alongside, not instead.
    """
    sql = f"""
    select pitcher_id, batter_id,
           {season_floor} as season_floor,
           count(*)                                                as pa_count,
           count(*) filter (where result = 'strikeout')            as so_count,
           count(*) filter (where result = 'walk')                 as bb_count,
           count(*) filter (where result = 'hit')                  as h_count,
           count(*) filter (where result_detail = 'home_run')      as hr_count,
           any_value(bat_side)                                     as bat_side,
           any_value(pitch_hand)                                   as pitch_hand,
           max(game_date)                                          as last_faced
      from at_bats
     where pitcher_id is not null and batter_id is not null
     group by 1, 2
    having count(*) >= {min_pa}
     order by pitcher_id, batter_id
    """
    return con.execute(sql).fetch_arrow_table()


# ── registry ────────────────────────────────────────────────────────────────
# full_history: game_context is one row per game and cheap; everything else is
# player-scoped and windowed to WINDOW_SEASONS.
BUILDERS = {
    "pitcher_profiles":        (pitcher_profiles,        False),
    "batter_profiles":         (batter_profiles,         False),
    "situational_splits":      (situational_splits,      False),
    "pitcher_fatigue_profile": (pitcher_fatigue_profile, False),
    "batter_power_profile":    (batter_power_profile,    False),
    "game_context":            (game_context,            True),
    "matchup_history":         (matchup_history,         False),
}

# Statcast-dependent tables floor at 2017; the rest at the window start.
STATCAST_TABLES = {"batter_power_profile"}

TABLE_NAMES = tuple(BUILDERS)
