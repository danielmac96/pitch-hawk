-- Phase 4, Task 4.3 — display aggregates published nightly from the R2
-- warehouse via DuckDB. Frontend surfaces only; no model tables.
--
-- Six new tables plus an in-place extension of `matchup_history`, which
-- already exists and is read by backend/models/stats_cache.py using
-- pa_count/so_count/bb_count/h_count. Those names are kept and the v2 columns
-- added beside them, so the deferred model layer keeps working.
--
-- PUBLISHING IS ALL-OR-NOTHING PER TABLE. A half-written aggregate that the
-- frontend reads is worse than a stale one, and PostgREST has no multi-request
-- transaction. So each table gets a `_staging` twin: the publisher fills
-- staging in batches (partial staging harms nothing, nobody reads it), then
-- calls publish_aggregate(), whose plpgsql body is a single transaction that
-- swaps the contents over. A crash mid-upload leaves the live table untouched.
--
-- Budget: ~10 MB measured across all seven, against ~300 MB of post-prune
-- headroom. Well inside the ~28 MB the plan allowed.

-- ── 1 & 2: player profiles ───────────────────────────────────────────────
-- scope in (career, season, d30). `career` means "all seasons in the
-- published window" (three), which is why season_floor is stored rather than
-- assumed. Deliberately SEPARATE from pitcher_rolling_stats/
-- batter_rolling_stats, which stay authoritative for live scoring: scope=d30
-- duplicates them on purpose, so a warehouse outage degrades a display and
-- never a prediction.
create table if not exists pitcher_profiles (
    player_id           int  not null,
    scope               text not null,
    season_floor        int,
    pitches             bigint,
    pa                  bigint,
    zone_rate           numeric,
    whiff_rate          numeric,
    chase_rate          numeric,
    contact_rate        numeric,
    k_rate              numeric,
    bb_rate             numeric,
    avg_fastball_velo   numeric,
    avg_offspeed_velo   numeric,
    updated_at          timestamptz not null default now(),
    primary key (player_id, scope)
);

create table if not exists batter_profiles (
    player_id           int  not null,
    scope               text not null,
    season_floor        int,
    pitches             bigint,
    pa                  bigint,
    zone_rate           numeric,
    whiff_rate          numeric,
    chase_rate          numeric,
    contact_rate        numeric,
    k_rate              numeric,
    bb_rate             numeric,
    avg_fastball_velo   numeric,
    avg_offspeed_velo   numeric,
    updated_at          timestamptz not null default now(),
    primary key (player_id, scope)
);

-- ── 3: situational splits ────────────────────────────────────────────────
-- DATA-INVENTORY calls base-state splits our "single biggest gap" and says we
-- "cannot produce any of them". That has been stale since the warehouse
-- landed: men_on_base is 100% populated across all 2,013 days.
create table if not exists situational_splits (
    player_id     int  not null,
    role          text not null,          -- pitcher | batter
    men_on_base   text not null,          -- Empty | Men_On | RISP | Loaded
    opp_hand      text not null,          -- opposing batter side / pitcher hand
    season_floor  int,
    pa            bigint,
    k_rate        numeric,
    bb_rate       numeric,
    hit_rate      numeric,
    avg_velo      numeric,
    updated_at    timestamptz not null default now(),
    primary key (player_id, role, men_on_base, opp_hand)
);

-- ── 4: pitcher fatigue ───────────────────────────────────────────────────
-- The TYPICAL decay curve. The current game's trend is computed live from the
-- 35-day hot `pitches` table -- which is why no per-game pitcher log exists.
create table if not exists pitcher_fatigue_profile (
    pitcher_id             int not null,
    pitch_bucket           int not null,  -- 0:0-24 1:25-49 2:50-74 3:75-99 4:100+
    season_floor           int,
    n                      bigint,
    mean_velo              numeric,
    velo_delta_vs_bucket0  numeric,
    whiff_rate             numeric,
    updated_at             timestamptz not null default now(),
    primary key (pitcher_id, pitch_bucket)
);

-- ── 5: batter power ──────────────────────────────────────────────────────
-- season_floor is 2017 here and not negotiable: launch_speed covers 87% of
-- balls in play in 2015 and only passes 99% in 2020, so a pre-2017 barrel
-- rate measures feed coverage rather than the hitter.
create table if not exists batter_power_profile (
    batter_id          int  not null,
    scope              text not null,
    season_floor       int,
    pa                 bigint,
    hr                 bigint,
    xbh                bigint,
    total_bases        bigint,
    iso                numeric,
    barrel_rate        numeric,
    avg_launch_speed   numeric,
    avg_launch_angle   numeric,
    updated_at         timestamptz not null default now(),
    primary key (batter_id, scope)
);

-- ── 6: game context ──────────────────────────────────────────────────────
-- A copy, not an ingestion project. The game_context/umpire_stats tables
-- dropped in 20260728000001 never held a row, while GAME_SCHEMA has carried
-- hp_umpire_id, weather, wind, attendance and duration for 26,893 games all
-- along. Full history: no player grain, so it is cheap.
create table if not exists game_context (
    game_pk            bigint primary key,
    game_date          date,
    season             int,
    game_type          text,
    home_team_id       int,
    away_team_id       int,
    home_abbr          text,
    away_abbr          text,
    home_score         int,
    away_score         int,
    venue_id           int,
    venue_name         text,
    hp_umpire_id       int,
    hp_umpire          text,
    weather_condition  text,
    temp_f             int,
    wind_mph           int,
    wind_direction     text,
    attendance         int,
    game_duration_min  int,
    updated_at         timestamptz not null default now()
);

-- ── 7: matchup_history, extended in place ────────────────────────────────
-- Kept rather than replaced by a v2 table: stats_cache.py reads pa_count,
-- so_count, bb_count and h_count. New columns are additive.
alter table matchup_history add column if not exists season_floor int;
alter table matchup_history add column if not exists hr_count     int default 0;
alter table matchup_history add column if not exists bat_side     text;
alter table matchup_history add column if not exists pitch_hand   text;
alter table matchup_history add column if not exists last_faced   date;

-- ── staging twins ────────────────────────────────────────────────────────
-- `including defaults` but NOT constraints: the publisher may retry a batch,
-- and a primary key on staging would turn a harmless duplicate into a failed
-- publish. Correctness comes from the aggregate query, which groups.
create table if not exists pitcher_profiles_staging        (like pitcher_profiles        including defaults);
create table if not exists batter_profiles_staging         (like batter_profiles         including defaults);
create table if not exists situational_splits_staging      (like situational_splits      including defaults);
create table if not exists pitcher_fatigue_profile_staging (like pitcher_fatigue_profile including defaults);
create table if not exists batter_power_profile_staging    (like batter_power_profile    including defaults);
create table if not exists game_context_staging            (like game_context            including defaults);
create table if not exists matchup_history_staging         (like matchup_history         including defaults);

-- ── the atomic swap ──────────────────────────────────────────────────────
create or replace function publish_aggregate(p_table text)
returns int language plpgsql security definer
set search_path = public, pg_temp as $$
declare
    n int;
    allowed text[] := array[
        'pitcher_profiles','batter_profiles','situational_splits',
        'pitcher_fatigue_profile','batter_power_profile','game_context',
        'matchup_history'];
begin
    -- Whitelist, not quoting, is what makes format(%I) safe here: p_table
    -- arrives from a client holding the service-role key.
    if not (p_table = any(allowed)) then
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

-- Clearing staging needs its own entry point: PostgREST requires a filter on
-- every DELETE, so the client would otherwise have to invent a
-- always-true predicate against a column whose name and type it must guess.
create or replace function clear_aggregate_staging(p_table text)
returns void language plpgsql security definer
set search_path = public, pg_temp as $$
declare
    allowed text[] := array[
        'pitcher_profiles','batter_profiles','situational_splits',
        'pitcher_fatigue_profile','batter_power_profile','game_context',
        'matchup_history'];
begin
    if not (p_table = any(allowed)) then
        raise exception 'clear_aggregate_staging: % is not a publishable aggregate',
            p_table;
    end if;
    execute format('delete from %I where true', p_table || '_staging');
end $$;

-- Freshness, surfaced by /api/health. One row per table so a single stalled
-- aggregate is visible rather than averaged away.
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
$$;

-- ── RLS ──────────────────────────────────────────────────────────────────
-- Public read on the live tables. Staging tables get RLS enabled and NO
-- policy, which denies anon/authenticated outright; the publisher uses the
-- service-role key, which bypasses RLS.
--
-- Roles are resolved from pg_roles rather than named literally: CI applies
-- every migration against a clean Postgres 16 that has only anon and
-- authenticated, and a bare `to service_role` there is a hard failure.
do $$
declare
    live text[] := array[
        'pitcher_profiles','batter_profiles','situational_splits',
        'pitcher_fatigue_profile','batter_power_profile','game_context'];
    staging text[] := array[
        'pitcher_profiles_staging','batter_profiles_staging',
        'situational_splits_staging','pitcher_fatigue_profile_staging',
        'batter_power_profile_staging','game_context_staging',
        'matchup_history_staging'];
    t text;
    readers text := (select string_agg(quote_ident(rolname), ', ')
                     from pg_roles where rolname in ('anon','authenticated'));
begin
    foreach t in array live || staging loop
        execute format('alter table %I enable row level security', t);
    end loop;

    if readers is null then return; end if;

    foreach t in array live loop
        if not exists (select 1 from pg_policies
                        where schemaname = 'public' and tablename = t
                          and policyname = 'public read') then
            execute format(
                'create policy "public read" on %I for select to %s using (true)',
                t, readers);
        end if;
    end loop;
end $$;
