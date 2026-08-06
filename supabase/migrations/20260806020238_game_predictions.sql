-- Durable game-level predictions.
--
-- Measured 2026-08-06: today's 11 games were all `Scheduled` with zero rows in
-- `predictions`, zero rows in `odds`, and no `live_state` record. Predictions
-- only ever existed because `np-live-poll` wrote them, and that job is gated to
-- [start_ts, start_ts + 4h) -- so before first pitch there is nothing to serve,
-- and `game_total` has never had a single row in any window because its only
-- source was the unscheduled odds-ingest job.
--
-- `predictions` stays exactly as it is: per-pitch, 21-day retention, the live
-- board's source. This table sits beside it at game granularity so a full-slate
-- prediction survives the prune and can be queried over a 30-day window.
--
-- Sizing: 15 games x 6 markets x 2 phases = 180 rows/day, ~5.4k rows for a
-- 30-day window. Under 5 MB with indexes, against ~280 MB of headroom.

-- ---------------------------------------------------------------------------
-- game_predictions
-- ---------------------------------------------------------------------------
-- One row per (game, market, phase).
--
--   phase = 'pregame' : written once by game-predict before first pitch and
--                       then FROZEN. This is the honest pre-game call and the
--                       only one that can be fairly graded as a track record.
--   phase = 'live'    : upserted in place by live-poll as the game moves. Bounded
--                       at 6 rows per game no matter how many times it polls.
create table if not exists game_predictions (
    game_pk         bigint not null,
    official_date   date   not null,
    market          text   not null,
    phase           text   not null check (phase in ('pregame', 'live')),

    predicted_value numeric(8,4),
    probs           jsonb,
    recommendation  text,
    confidence      numeric(5,4),
    line            numeric(6,2),
    price           int,
    edge            numeric(7,4),
    book            text,
    model_version   text not null default '',

    -- Denormalized filter keys. The feed read path filters by team and pitcher
    -- on a 30-day window; making it join `games` for every row would put the
    -- slowest table in the schema on the hot path for no benefit.
    home_team_id    int,
    away_team_id    int,
    home_abbr       text,
    away_abbr       text,
    home_pitcher_id int,
    away_pitcher_id int,

    -- Grading, written by settle once the game is Final.
    actual_value    numeric(8,4),
    result          text,
    profit_units    numeric(7,3),
    graded_at       timestamptz,

    -- How many per-pitch rows backed this game, so the feed can show depth
    -- after the raw rows are pruned.
    n_pitch_predictions int default 0,

    scored_at       timestamptz default now(),
    updated_at      timestamptz default now(),
    primary key (game_pk, market, phase)
);

-- The feed's four access patterns. Date leads every one of them because the
-- window is always bounded -- there is no unbounded scan of this table.
create index if not exists game_predictions_date_idx
    on game_predictions (official_date desc, market);
create index if not exists game_predictions_team_idx
    on game_predictions (official_date desc, home_team_id, away_team_id);
create index if not exists game_predictions_home_pitcher_idx
    on game_predictions (home_pitcher_id, official_date desc)
    where home_pitcher_id is not null;
create index if not exists game_predictions_away_pitcher_idx
    on game_predictions (away_pitcher_id, official_date desc)
    where away_pitcher_id is not null;
-- Ungraded lookup for settle, mirroring predictions_ungraded_idx.
create index if not exists game_predictions_ungraded_idx
    on game_predictions (game_pk) where result is null;

alter table game_predictions enable row level security;

-- ---------------------------------------------------------------------------
-- player_prediction_daily
-- ---------------------------------------------------------------------------
-- Pitcher/batter filtering for the feed.
--
-- `predictions` carries no player id -- only (game_pk, at_bat_index) -- so
-- per-player history has to be derived by joining `at_bats` before the raw rows
-- are pruned at 21 days. at_bats lives in the 35-day hot window, so the join is
-- valid across the whole 30-day feed window.
create table if not exists player_prediction_daily (
    day               date not null,
    player_id         int  not null,
    role              text not null check (role in ('pitcher', 'batter')),
    market            text not null,
    -- '' rather than NULL so it can sit in the primary key, matching
    -- prediction_accuracy_daily.
    model_version     text not null default '',
    n                 bigint,
    n_graded          bigint,
    wins              bigint,
    losses            bigint,
    pushes            bigint,
    mean_confidence   numeric(6,4),
    mean_profit_units numeric(8,4),
    updated_at        timestamptz default now(),
    primary key (day, player_id, role, market, model_version)
);

create index if not exists player_prediction_daily_player_idx
    on player_prediction_daily (player_id, day desc);

alter table player_prediction_daily enable row level security;

-- Public read on both, consistent with every other app-data table.
do $$
declare
    roles text := (
        select string_agg(quote_ident(rolname), ', ')
        from pg_roles where rolname in ('anon', 'authenticated')
    );
    t text;
begin
    if roles is null then return; end if;
    foreach t in array array['game_predictions', 'player_prediction_daily'] loop
        if not exists (
            select 1 from pg_policies
            where schemaname = 'public' and tablename = t and policyname = 'public read'
        ) then
            execute format(
                'create policy "public read" on %I for select to %s using (true)', t, roles);
        end if;
    end loop;
end $$;

-- ---------------------------------------------------------------------------
-- rollup_player_predictions
-- ---------------------------------------------------------------------------
-- Aggregate the trailing p_days of per-pitch predictions per player. Modelled
-- directly on rollup_prediction_accuracy, which does the identical aggregation
-- without the player join.
--
-- Like that function the window intentionally exceeds one day: settlement grades
-- asynchronously, so a day's win count keeps moving after the day closes.
--
-- The lateral VALUES fans each prediction out to both participants, so a single
-- at-bat's rows count toward the pitcher's record and the batter's record. That
-- is deliberate -- "how did the model do on Skenes" and "how did the model do on
-- Judge" are both questions the feed has to answer about the same pitch.
create or replace function rollup_player_predictions(p_days int default 7)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
    insert into player_prediction_daily as t (
        day, player_id, role, market, model_version,
        n, n_graded, wins, losses, pushes,
        mean_confidence, mean_profit_units, updated_at
    )
    select
        p.created_at::date,
        x.player_id,
        x.role,
        p.market,
        coalesce(p.model_version, ''),
        count(*),
        count(*) filter (where p.result is not null),
        count(*) filter (where p.result = 'win'),
        count(*) filter (where p.result = 'loss'),
        count(*) filter (where p.result = 'push'),
        round(avg(p.confidence), 4),
        round(avg(p.profit_units), 4),
        now()
    from predictions p
    join at_bats a
      on a.game_pk = p.game_pk
     and a.at_bat_index = p.at_bat_index
    cross join lateral (values
        (a.pitcher_id, 'pitcher'),
        (a.batter_id,  'batter')
    ) as x(player_id, role)
    where p.created_at >= (now() - make_interval(days => p_days))::date
      and p.market is not null
      and p.at_bat_index is not null
      and x.player_id is not null
    group by 1, 2, 3, 4, 5
    on conflict (day, player_id, role, market, model_version) do update set
        n                 = excluded.n,
        n_graded          = excluded.n_graded,
        wins              = excluded.wins,
        losses            = excluded.losses,
        pushes            = excluded.pushes,
        mean_confidence   = excluded.mean_confidence,
        mean_profit_units = excluded.mean_profit_units,
        updated_at        = now();
    get diagnostics n = row_count;
    return n;
end $$;

-- ---------------------------------------------------------------------------
-- Retention
-- ---------------------------------------------------------------------------
-- 35 days gives the 30-day feed a 5-day margin, matching the HOT_WINDOW_DAYS
-- convention in warehouse/config.py:38. Note this does NOT touch
-- prune_predictions -- per-pitch retention stays at 21 days.
create or replace function prune_game_predictions(keep_days int default 35)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
    delete from game_predictions
    where official_date < (now() - make_interval(days => keep_days))::date;
    get diagnostics n = row_count;
    return n;
end $$;

-- The player rollup is ~700 rows/day; 90 days is ~63k rows and a few MB, and it
-- is the only per-player accuracy record that survives the 21-day raw prune.
create or replace function prune_player_prediction_daily(keep_days int default 90)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
    delete from player_prediction_daily
    where day < (now() - make_interval(days => keep_days))::date;
    get diagnostics n = row_count;
    return n;
end $$;

-- None of these are reachable from the public API.
revoke execute on function rollup_player_predictions(int) from anon, authenticated, public;
revoke execute on function prune_game_predictions(int) from anon, authenticated, public;
revoke execute on function prune_player_prediction_daily(int) from anon, authenticated, public;
