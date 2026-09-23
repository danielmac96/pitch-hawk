-- Two more display aggregates, built nightly in DuckDB over R2 and published
-- by `python -m warehouse publish`. Frontend surfaces; no model tables.
--
--   batted_ball_profile   player x role x scope -- GB/FB/LD/popup, pull,
--                         oppo, pull-in-the-air, hard-hit, mean EV and LA
--   park_hr_factors       venue x season -- how much more often a home run
--                         is hit at a park than away from it
--
-- Also drops two columns from `batter_rolling_stats` that have been NULL
-- since the schema landed; see the bottom of this file.
--
-- The publish contract is unchanged: fill `<table>_staging` in batches, then
-- call publish_aggregate(), whose body swaps the contents in one transaction.


-- ── the whitelist, in one place ──────────────────────────────────────────
-- publish_aggregate, clear_aggregate_staging and the RLS block each carried
-- their own copy of this list. Three copies of a list that must agree is how
-- a table ends up publishable but un-clearable, and adding two tables would
-- have made it three copies of nine names. One home instead.
create or replace function publishable_aggregates()
returns text[] language sql immutable
set search_path = public, pg_temp as $$
    select array[
        'pitcher_profiles',
        'batter_profiles',
        'situational_splits',
        'pitcher_fatigue_profile',
        'batter_power_profile',
        'game_context',
        'matchup_history',
        'batted_ball_profile',
        'park_hr_factors'
    ]
$$;


-- ── batted_ball_profile ──────────────────────────────────────────────────
-- Rates are over BALLS IN PLAY, never plate appearances. A hitter who strikes
-- out half the time can still pull everything he touches, and that is a
-- different fact from how often he touches anything.
--
-- `pull_air_rate` is the column worth the build: pulled balls in the air are
-- where home runs come from, and neither pull_rate nor fb_rate alone
-- separates a pull hitter who beats the ball into the ground from one who
-- lifts it. Measured on the live feed, home runs average +16.1 degrees of
-- pull against +4.2 for all batted balls.
--
-- `role` carries both sides of the matchup. A pitcher's batted-ball profile
-- is a real scouting fact ("he gets pulled in the air") and has no place in
-- batter_power_profile, which is why this is a separate table rather than
-- more columns there.
--
-- season_floor is stored rather than assumed: scope='career' means "every
-- season in the published window", which is three, not 2015. Statcast-floored
-- at 2017 -- launch_speed covers 87% of balls in play in 2015 and does not
-- pass 99% until 2020, so an earlier hard_hit_rate measures tracking coverage
-- rather than a skill.
create table if not exists batted_ball_profile (
    player_id          int  not null,
    role               text not null,          -- 'batter' | 'pitcher'
    scope              text not null,          -- 'career' | 'season' | 'd30'
    season_floor       int,
    bip                bigint,                 -- balls in play, the denominator
    gb_rate            numeric,
    fb_rate            numeric,
    ld_rate            numeric,
    popup_rate         numeric,
    -- gb+fb+ld+popup sums to 1.0 by construction: bunt variants fold into
    -- their base trajectory rather than falling outside every category.
    pull_rate          numeric,
    oppo_rate          numeric,
    pull_air_rate      numeric,
    hard_hit_rate      numeric,                -- exit velocity >= 95 mph
    avg_launch_speed   numeric,
    avg_launch_angle   numeric,
    updated_at         timestamptz not null default now(),
    primary key (player_id, role, scope)
);


-- ── park_hr_factors ──────────────────────────────────────────────────────
-- Deliberately NOT the construction park_factors() uses. That RPC divides a
-- venue's runs per game by the league mean, which confounds the park with the
-- clubs who play in it: a team built around power inflates its own venue, and
-- a model applying the factor to a hitter then counts the roster twice.
--
-- This is the paired form. For each team-season, the home-run rate across all
-- plate appearances at that club's park -- both sides batting -- against the
-- rate across all plate appearances in the parks it visits. The home club
-- appears on both sides of the ratio, so its own power largely divides out.
--
-- Per venue-SEASON because fences move: Camden Yards reports left_center 410
-- through 2022 and 376 from 2026. One all-history factor would average a park
-- across two different shapes.
--
-- Both the raw and the shrunk factor are stored. `hr_factor` is shrunk toward
-- 1.0 by home sample; a consumer wanting different shrinkage has the counts.
create table if not exists park_hr_factors (
    venue_id       int not null,
    season         int not null,
    season_floor   int,
    home_pa        bigint,
    home_hr        bigint,
    away_pa        bigint,
    away_hr        bigint,
    home_hr_rate   numeric,
    away_hr_rate   numeric,
    raw_factor     numeric,       -- unshrunk; noisy on a single season
    hr_factor      numeric,       -- shrunk toward 1.0, the one to serve
    updated_at     timestamptz not null default now(),
    primary key (venue_id, season)
);

create index if not exists park_hr_factors_season_idx
    on park_hr_factors (season);


-- ── staging twins ────────────────────────────────────────────────────────
create table if not exists batted_ball_profile_staging (like batted_ball_profile including defaults);
create table if not exists park_hr_factors_staging     (like park_hr_factors     including defaults);


-- ── swap + clear, now reading the shared whitelist ───────────────────────
create or replace function publish_aggregate(p_table text)
returns int language plpgsql security definer
set search_path = public, pg_temp as $$
declare
    n int;
begin
    -- Whitelist, not quoting, is what makes format(%I) safe here: p_table
    -- arrives from a client holding the service-role key.
    if not (p_table = any(publishable_aggregates())) then
        raise exception 'publish_aggregate: % is not a publishable aggregate',
            p_table;
    end if;

    -- `where true` is not decoration: Supabase runs pg_safeupdate on the
    -- PostgREST connection, which rejects an unqualified DELETE with
    -- SQLSTATE 21000 even inside a SECURITY DEFINER function.
    execute format('delete from %I where true', p_table);
    execute format('insert into %I select * from %I', p_table, p_table || '_staging');
    get diagnostics n = row_count;
    execute format('delete from %I where true', p_table || '_staging');

    -- Refuse to publish an empty table. Every one of these is populated in
    -- normal operation, so zero rows means the build failed upstream, and
    -- blanking a frontend panel is worse than serving yesterday's numbers.
    -- Raising rolls back the delete+insert above with it.
    if n = 0 then
        raise exception 'publish_aggregate: refusing to publish 0 rows into %',
            p_table;
    end if;
    return n;
end $$;

create or replace function clear_aggregate_staging(p_table text)
returns void language plpgsql security definer
set search_path = public, pg_temp as $$
begin
    if not (p_table = any(publishable_aggregates())) then
        raise exception 'clear_aggregate_staging: % is not a publishable aggregate',
            p_table;
    end if;
    execute format('delete from %I where true', p_table || '_staging');
end $$;


-- ── freshness ────────────────────────────────────────────────────────────
-- One row per table so a single stalled aggregate is visible rather than
-- averaged away. Surfaced by /api/health.
create or replace function aggregate_freshness()
returns table (table_name text, rows bigint, updated_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
    select 'pitcher_profiles',        count(*), max(updated_at) from pitcher_profiles
    union all select 'batter_profiles',         count(*), max(updated_at) from batter_profiles
    union all select 'situational_splits',      count(*), max(updated_at) from situational_splits
    union all select 'pitcher_fatigue_profile', count(*), max(updated_at) from pitcher_fatigue_profile
    union all select 'batter_power_profile',    count(*), max(updated_at) from batter_power_profile
    union all select 'game_context',            count(*), max(updated_at) from game_context
    union all select 'matchup_history',         count(*), max(updated_at) from matchup_history
    union all select 'batted_ball_profile',     count(*), max(updated_at) from batted_ball_profile
    union all select 'park_hr_factors',         count(*), max(updated_at) from park_hr_factors
$$;


-- ── RLS ──────────────────────────────────────────────────────────────────
-- Public read on the live tables. Staging gets RLS enabled and NO policy,
-- which denies anon/authenticated outright; the publisher uses the
-- service-role key, which bypasses RLS.
--
-- Roles are resolved from pg_roles rather than named literally: CI applies
-- every migration against a clean Postgres that has only anon and
-- authenticated, and a bare `to service_role` there is a hard failure.
do $$
declare
    live text[] := array['batted_ball_profile','park_hr_factors'];
    staging text[] := array['batted_ball_profile_staging','park_hr_factors_staging'];
    t text;
    readers text := (select string_agg(quote_ident(rolname), ', ')
                     from pg_roles where rolname in ('anon','authenticated'));
begin
    foreach t in array live || staging loop
        execute format('alter table %I enable row level security', t);
    end loop;

    if readers is not null then
        foreach t in array live loop
            execute format(
                'drop policy if exists %I on %I', t || '_read', t);
            execute format(
                'create policy %I on %I for select to %s using (true)',
                t || '_read', t, readers);
        end loop;
    end if;
end $$;

revoke execute on function publishable_aggregates() from anon, authenticated;


-- ── the two columns that never held a value ──────────────────────────────
-- `batter_rolling_stats` has declared exit_velo_avg and hard_hit_rate since
-- 20260703000001. refresh_batter_rolling_stats() has never written either:
-- both need launch_speed, and the live `pitches` table does not capture it --
-- only the R2 warehouse does. So they have been NULL for every row, for every
-- day, while looking to any reader like available data.
--
-- Dropped rather than backfilled. hard_hit_rate now exists for real on
-- batted_ball_profile, computed from the warehouse where the input actually
-- lives, and a second copy on a table owned by a different writer is how two
-- numbers for one thing start disagreeing.
--
-- Safe: grep confirms no reader anywhere in the repo -- not the API, not the
-- frontend, not the scorer. They appear only in their own CREATE TABLE.
alter table batter_rolling_stats
    drop column if exists exit_velo_avg,
    drop column if exists hard_hit_rate;
