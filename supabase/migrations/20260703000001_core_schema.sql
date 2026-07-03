-- NextPitch — consolidated core schema (supersedes backend/db/*.sql).
-- Idempotent: safe to re-run. Applied to the live project via Supabase MCP /
-- CLI; kept in-repo as the source of truth.

-- ─────────────────────────────────────────────────────────────────────────
-- Raw MLB data
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists games (
    game_pk       bigint primary key,
    official_date date,
    game_type     text,
    season        int,
    status        text,
    home_team_id  int,
    home_team     text,
    home_abbr     text,
    away_team_id  int,
    away_team     text,
    away_abbr     text,
    venue_id      int,
    venue_name    text,
    start_ts      timestamptz,
    home_score    int,
    away_score    int,
    updated_at    timestamptz default now()
);
create index if not exists games_date_idx on games (official_date);
create index if not exists games_status_idx on games (status);

create table if not exists pitches (
    id              bigserial primary key,
    game_pk         bigint      not null,
    at_bat_index    int         not null,
    pitch_number    int         not null,
    pitcher_id      int,
    batter_id       int,
    pitch_type      text,
    start_speed     numeric(5,1),
    zone            int,
    description     text,
    result_category text,
    balls           int,
    strikes         int,
    outs            int,
    inning          int,
    top_inning      boolean,
    pitch_ts        timestamptz,
    raw_json        jsonb,
    unique (game_pk, at_bat_index, pitch_number)
);
create index if not exists pitches_game_pa_pitch_idx
    on pitches (game_pk, at_bat_index, pitch_number);
create index if not exists pitches_pitcher_idx on pitches (pitcher_id);
create index if not exists pitches_batter_idx on pitches (batter_id);
create index if not exists pitches_ts_idx on pitches (pitch_ts);

create table if not exists at_bats (
    id              bigserial primary key,
    game_pk         bigint      not null,
    at_bat_index    int         not null,
    pitcher_id      int,
    batter_id       int,
    pitch_count     int,
    result          text,
    result_detail   text,
    start_ts        timestamptz,
    end_ts          timestamptz,
    unique (game_pk, at_bat_index)
);
create index if not exists at_bats_game_pa_idx on at_bats (game_pk, at_bat_index);
create index if not exists at_bats_pitcher_idx on at_bats (pitcher_id);
create index if not exists at_bats_batter_idx on at_bats (batter_id);

create table if not exists live_state (
    game_pk         bigint primary key,
    status          text,
    inning          int,
    top_inning      boolean,
    batter_id       int,
    pitcher_id      int,
    balls           int,
    strikes         int,
    outs            int,
    pitch_count_pa  int,
    last_pitch_ts   timestamptz,
    home_score      int,
    away_score      int,
    raw_json        jsonb,
    updated_at      timestamptz default now()
);
create index if not exists live_state_updated_at_idx on live_state (updated_at);
alter table live_state add column if not exists home_score int;
alter table live_state add column if not exists away_score int;

create table if not exists player_info (
    player_id   int primary key,
    full_name   text,
    bat_side    text,
    pitch_hand  text,
    position    text,
    debut_date  date,
    updated_at  timestamptz default now()
);

create table if not exists game_context (
    game_pk         bigint primary key,
    venue_id        int,
    venue_name      text,
    umpire_id       int,
    umpire_name     text,
    temperature_f   numeric(5,1),
    wind_speed_mph  numeric(5,1),
    wind_dir_deg    int,
    is_dome         boolean default false,
    roof_closed     boolean,
    updated_at      timestamptz default now()
);

create table if not exists pitcher_game_log (
    game_pk             bigint not null,
    pitcher_id          int    not null,
    pitch_count_in_game int,
    max_velocity        numeric(5,1),
    avg_velocity        numeric(5,1),
    days_rest           int,
    is_starter          boolean,
    entry_inning        int,
    updated_at          timestamptz default now(),
    primary key (game_pk, pitcher_id)
);

create table if not exists matchup_history (
    pitcher_id  int not null,
    batter_id   int not null,
    pa_count    int default 0,
    so_count    int default 0,
    bb_count    int default 0,
    h_count     int default 0,
    updated_at  timestamptz default now(),
    primary key (pitcher_id, batter_id)
);

create table if not exists umpire_stats (
    umpire_id   int primary key,
    umpire_name text,
    games       int,
    zone_rate   numeric(6,4),
    updated_at  timestamptz default now()
);

create table if not exists pitcher_rolling_stats (
    pitcher_id           int primary key,
    sample_pitches       int,
    sample_abs           int,
    zone_rate            numeric(6,4),
    chase_rate_against   numeric(6,4),
    whiff_rate           numeric(6,4),
    avg_fastball_velo    numeric(5,1),
    avg_offspeed_velo    numeric(5,1),
    k_rate               numeric(6,4),
    bb_rate              numeric(6,4),
    contact_rate_against numeric(6,4),
    updated_at           timestamptz default now()
);

create table if not exists batter_rolling_stats (
    batter_id      int primary key,
    sample_pas     int,
    chase_rate     numeric(6,4),
    contact_rate   numeric(6,4),
    k_rate         numeric(6,4),
    bb_rate        numeric(6,4),
    exit_velo_avg  numeric(5,1),
    hard_hit_rate  numeric(6,4),
    updated_at     timestamptz default now()
);

-- ─────────────────────────────────────────────────────────────────────────
-- Markets: odds, predictions, picks, clicks
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists odds (
    id            bigserial primary key,
    game_pk       bigint,
    market        text,
    outcome       text,               -- 'over'/'under'/'home'/'away'/… (null for legacy 2-sided rows)
    line          numeric(6,2),
    over_price    int,
    under_price   int,
    price_american int,
    implied_prob  numeric(6,4),
    source        text default 'stub',
    meta          jsonb,
    fetched_at    timestamptz default now()
);
alter table odds add column if not exists outcome text;
alter table odds add column if not exists price_american int;
alter table odds add column if not exists implied_prob numeric(6,4);
alter table odds add column if not exists meta jsonb;
create index if not exists odds_game_market_idx on odds (game_pk, market, fetched_at desc);

create table if not exists predictions (
    id              bigserial primary key,
    game_pk         bigint,
    at_bat_index    int,
    pitch_number    int,
    market          text,
    predicted_value numeric(8,4),
    confidence      numeric(5,4),
    probs           jsonb,
    recommendation  text,
    line            numeric(6,2),
    price           int,
    edge            numeric(7,4),
    units           numeric(4,2) default 1,
    result          text,
    profit_units    numeric(7,3),
    graded_at       timestamptz,
    model_version   text default 'stub_v0',
    created_at      timestamptz default now()
);
create index if not exists predictions_game_pa_market_idx
    on predictions (game_pk, at_bat_index, market);
create index if not exists predictions_ungraded_idx
    on predictions (id) where result is null;

-- Curated, published pick history (what /picks/today and /record serve).
create table if not exists picks (
    id             bigserial primary key,
    pick_date      date not null default (now() at time zone 'utc')::date,
    game_pk        bigint,
    at_bat_index   int,
    market         text not null,
    recommendation text,
    label          text,
    line           numeric(6,2),
    price          int,
    confidence     numeric(5,4),
    edge           numeric(7,4),
    units          numeric(4,2) default 1,
    book           text,
    source         text,
    model_version  text,
    status         text default 'pending',   -- pending | win | loss | push | void
    profit_units   numeric(7,3),
    payload        jsonb,                    -- {game:{away,home,venue,matchup,first_pitch}, pitcher:{}, batter:{}, bullets:[]}
    created_at     timestamptz default now(),
    graded_at      timestamptz,
    -- NULLS NOT DISTINCT so game-level picks (at_bat_index null) can't dupe.
    unique nulls not distinct (pick_date, game_pk, market, at_bat_index, recommendation)
);
create index if not exists picks_date_idx on picks (pick_date);
create index if not exists picks_status_idx on picks (status);

create table if not exists bet_clicks (
    id                   bigserial primary key,
    game_pk              bigint,
    market               text,
    side                 text,
    book                 text,
    edge                 numeric(6,4),
    affiliate_configured boolean,
    clicked_at           timestamptz default now()
);
create index if not exists bet_clicks_book_clicked_idx on bet_clicks (book, clicked_at);

-- ─────────────────────────────────────────────────────────────────────────
-- Models + pipeline bookkeeping
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists model_params (
    id            bigserial primary key,
    market        text not null,
    version       text not null,
    params        jsonb not null,
    metrics       jsonb,
    training_rows bigint,
    is_active     boolean default false,
    trained_at    timestamptz default now(),
    unique (market, version)
);
create unique index if not exists model_params_one_active
    on model_params (market) where is_active;

create table if not exists ingest_runs (
    id          bigserial primary key,
    job         text not null,
    started_at  timestamptz default now(),
    finished_at timestamptz,
    ok          boolean,
    detail      jsonb
);
create index if not exists ingest_runs_job_idx on ingest_runs (job, started_at desc);

create table if not exists backfill_progress (
    id            int primary key default 1,
    start_date    date not null,
    end_date      date not null,
    cursor_date   date not null,
    games_done    int default 0,
    pitches_done  bigint default 0,
    done          boolean default false,
    updated_at    timestamptz default now(),
    check (id = 1)
);

-- Shared secrets for cron -> edge function calls and external ingest jobs.
-- Never exposed via the API: RLS enabled with NO anon policies.
create table if not exists app_secrets (
    key   text primary key,
    value text not null
);

-- ─────────────────────────────────────────────────────────────────────────
-- Aggregate RPCs (model features)
-- ─────────────────────────────────────────────────────────────────────────

create or replace function get_pitcher_stats()
returns table (
    pitcher_id int, sample_pitches bigint, avg_speed numeric,
    strike_foul_rate numeric, ball_rate numeric, in_play_rate numeric
) language sql stable as $$
    select pitcher_id, count(*),
        avg(start_speed),
        avg(case when result_category = 'strike_foul' then 1.0 else 0.0 end),
        avg(case when result_category = 'ball'        then 1.0 else 0.0 end),
        avg(case when result_category = 'in_play'     then 1.0 else 0.0 end)
    from pitches where pitcher_id is not null
    group by pitcher_id having count(*) >= 10;
$$;

create or replace function get_pitcher_ab_stats()
returns table (
    pitcher_id int, sample_abs bigint, avg_pitches numeric,
    so_rate numeric, bb_rate numeric, hit_rate numeric, out_rate numeric
) language sql stable as $$
    select pitcher_id, count(*), avg(pitch_count),
        avg(case when result = 'strikeout' then 1.0 else 0.0 end),
        avg(case when result = 'walk'      then 1.0 else 0.0 end),
        avg(case when result = 'hit'       then 1.0 else 0.0 end),
        avg(case when result = 'out'       then 1.0 else 0.0 end)
    from at_bats where pitcher_id is not null
    group by pitcher_id having count(*) >= 5;
$$;

create or replace function get_league_averages()
returns table (
    pitch_sample bigint, avg_speed numeric, strike_foul_rate numeric,
    ball_rate numeric, in_play_rate numeric, ab_sample bigint,
    avg_pitches_pa numeric, so_rate numeric, bb_rate numeric,
    hit_rate numeric, out_rate numeric
) language sql stable as $$
    select
        (select count(*) from pitches),
        (select avg(start_speed) from pitches),
        (select avg(case when result_category='strike_foul' then 1.0 else 0.0 end) from pitches),
        (select avg(case when result_category='ball'        then 1.0 else 0.0 end) from pitches),
        (select avg(case when result_category='in_play'     then 1.0 else 0.0 end) from pitches),
        (select count(*) from at_bats),
        (select avg(pitch_count) from at_bats),
        (select avg(case when result='strikeout' then 1.0 else 0.0 end) from at_bats),
        (select avg(case when result='walk'      then 1.0 else 0.0 end) from at_bats),
        (select avg(case when result='hit'       then 1.0 else 0.0 end) from at_bats),
        (select avg(case when result='out'       then 1.0 else 0.0 end) from at_bats);
$$;

-- 30-day rolling refreshers. Full recompute + upsert; returns rows written.
create or replace function refresh_pitcher_rolling_stats()
returns int language plpgsql as $$
declare n int;
begin
    with recent as (
        select * from pitches
        where pitch_ts >= now() - interval '30 days' and pitcher_id is not null
    ),
    swings as (
        select pitcher_id,
            count(*) filter (where zone between 1 and 9) as in_zone,
            count(*) as total,
            count(*) filter (where description in ('swinging_strike','foul') or result_category = 'in_play') as swung,
            count(*) filter (where (description in ('swinging_strike','foul') or result_category = 'in_play') and zone > 9) as chased,
            count(*) filter (where zone > 9) as out_zone,
            count(*) filter (where description = 'swinging_strike') as whiffs,
            count(*) filter (where (description = 'foul' or result_category = 'in_play')) as contact,
            avg(start_speed) filter (where pitch_type in ('FF','FT','SI','FC')) as fb_velo,
            avg(start_speed) filter (where pitch_type not in ('FF','FT','SI','FC')) as os_velo
        from recent group by pitcher_id
    ),
    recent_abs as (
        select pitcher_id,
            count(*) as n_abs,
            avg(case when result = 'strikeout' then 1.0 else 0.0 end) as k_rate,
            avg(case when result = 'walk' then 1.0 else 0.0 end) as bb_rate
        from at_bats
        where end_ts >= now() - interval '30 days' and pitcher_id is not null
        group by pitcher_id
    ),
    merged as (
        select s.pitcher_id,
            s.total as sample_pitches,
            coalesce(a.n_abs, 0) as sample_abs,
            case when s.total > 0 then s.in_zone::numeric / s.total end as zone_rate,
            case when s.out_zone > 0 then s.chased::numeric / s.out_zone end as chase_rate_against,
            case when s.swung > 0 then s.whiffs::numeric / s.swung end as whiff_rate,
            s.fb_velo, s.os_velo, a.k_rate, a.bb_rate,
            case when s.swung > 0 then s.contact::numeric / s.swung end as contact_rate_against
        from swings s left join recent_abs a using (pitcher_id)
        where s.total >= 30
    )
    insert into pitcher_rolling_stats as t (
        pitcher_id, sample_pitches, sample_abs, zone_rate, chase_rate_against,
        whiff_rate, avg_fastball_velo, avg_offspeed_velo, k_rate, bb_rate,
        contact_rate_against, updated_at
    )
    select pitcher_id, sample_pitches, sample_abs, round(zone_rate, 4),
           round(chase_rate_against, 4), round(whiff_rate, 4),
           round(fb_velo::numeric, 1), round(os_velo::numeric, 1),
           round(k_rate, 4), round(bb_rate, 4), round(contact_rate_against, 4), now()
    from merged
    on conflict (pitcher_id) do update set
        sample_pitches = excluded.sample_pitches,
        sample_abs = excluded.sample_abs,
        zone_rate = excluded.zone_rate,
        chase_rate_against = excluded.chase_rate_against,
        whiff_rate = excluded.whiff_rate,
        avg_fastball_velo = excluded.avg_fastball_velo,
        avg_offspeed_velo = excluded.avg_offspeed_velo,
        k_rate = excluded.k_rate,
        bb_rate = excluded.bb_rate,
        contact_rate_against = excluded.contact_rate_against,
        updated_at = now();
    get diagnostics n = row_count;
    return n;
end $$;

create or replace function refresh_batter_rolling_stats()
returns int language plpgsql as $$
declare n int;
begin
    with recent as (
        select * from pitches
        where pitch_ts >= now() - interval '30 days' and batter_id is not null
    ),
    swings as (
        select batter_id,
            count(*) as total,
            count(*) filter (where description in ('swinging_strike','foul') or result_category = 'in_play') as swung,
            count(*) filter (where (description in ('swinging_strike','foul') or result_category = 'in_play') and zone > 9) as chased,
            count(*) filter (where zone > 9) as out_zone,
            count(*) filter (where (description = 'foul' or result_category = 'in_play')) as contact
        from recent group by batter_id
    ),
    recent_pas as (
        select batter_id,
            count(*) as n_pas,
            avg(case when result = 'strikeout' then 1.0 else 0.0 end) as k_rate,
            avg(case when result = 'walk' then 1.0 else 0.0 end) as bb_rate
        from at_bats
        where end_ts >= now() - interval '30 days' and batter_id is not null
        group by batter_id
    ),
    merged as (
        select s.batter_id,
            coalesce(p.n_pas, 0) as sample_pas,
            case when s.out_zone > 0 then s.chased::numeric / s.out_zone end as chase_rate,
            case when s.swung > 0 then s.contact::numeric / s.swung end as contact_rate,
            p.k_rate, p.bb_rate
        from swings s left join recent_pas p using (batter_id)
        where s.total >= 30
    )
    insert into batter_rolling_stats as t (
        batter_id, sample_pas, chase_rate, contact_rate, k_rate, bb_rate, updated_at
    )
    select batter_id, sample_pas, round(chase_rate, 4), round(contact_rate, 4),
           round(k_rate, 4), round(bb_rate, 4), now()
    from merged
    on conflict (batter_id) do update set
        sample_pas = excluded.sample_pas,
        chase_rate = excluded.chase_rate,
        contact_rate = excluded.contact_rate,
        k_rate = excluded.k_rate,
        bb_rate = excluded.bb_rate,
        updated_at = now();
    get diagnostics n = row_count;
    return n;
end $$;

-- Career pitcher×batter matchup counts, recomputed from at_bats.
create or replace function refresh_matchup_history()
returns int language plpgsql as $$
declare n int;
begin
    insert into matchup_history as t (pitcher_id, batter_id, pa_count, so_count, bb_count, h_count, updated_at)
    select pitcher_id, batter_id, count(*),
        count(*) filter (where result = 'strikeout'),
        count(*) filter (where result = 'walk'),
        count(*) filter (where result = 'hit'),
        now()
    from at_bats
    where pitcher_id is not null and batter_id is not null
    group by pitcher_id, batter_id
    having count(*) >= 3
    on conflict (pitcher_id, batter_id) do update set
        pa_count = excluded.pa_count,
        so_count = excluded.so_count,
        bb_count = excluded.bb_count,
        h_count = excluded.h_count,
        updated_at = now();
    get diagnostics n = row_count;
    return n;
end $$;

-- ─────────────────────────────────────────────────────────────────────────
-- Row-level security: public read for app data, no public writes.
-- Writes happen with the service role (edge functions) which bypasses RLS.
-- ─────────────────────────────────────────────────────────────────────────

do $$
declare t text;
begin
    foreach t in array array[
        'games','pitches','at_bats','live_state','player_info','game_context',
        'pitcher_game_log','matchup_history','umpire_stats',
        'pitcher_rolling_stats','batter_rolling_stats','odds','predictions',
        'picks','model_params','ingest_runs','backfill_progress',
        'bet_clicks','app_secrets'
    ] loop
        execute format('alter table %I enable row level security', t);
    end loop;
end $$;

-- Supabase always has the anon/authenticated roles; guard so the migration
-- also applies cleanly on a vanilla Postgres (roles simply absent -> skipped).
do $$
declare
    t text;
    roles text := (
        select string_agg(quote_ident(rolname), ', ')
        from pg_roles where rolname in ('anon', 'authenticated')
    );
begin
    if roles is null then
        raise notice 'anon/authenticated roles absent; skipping public-read policies';
        return;
    end if;
    foreach t in array array[
        'games','pitches','at_bats','live_state','player_info','game_context',
        'pitcher_game_log','matchup_history','umpire_stats',
        'pitcher_rolling_stats','batter_rolling_stats','odds','predictions',
        'picks','model_params','ingest_runs'
    ] loop
        if not exists (
            select 1 from pg_policies
            where schemaname = 'public' and tablename = t and policyname = 'public read'
        ) then
            execute format(
                'create policy "public read" on %I for select to %s using (true)', t, roles);
        end if;
    end loop;

    -- Click tracking: anon may insert (fire-and-forget funnel data), not read.
    if not exists (
        select 1 from pg_policies
        where schemaname = 'public' and tablename = 'bet_clicks'
          and policyname = 'public insert'
    ) then
        execute format(
            'create policy "public insert" on bet_clicks for insert to %s with check (true)', roles);
    end if;
end $$;
