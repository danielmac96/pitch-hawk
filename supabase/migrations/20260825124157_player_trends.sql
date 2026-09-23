-- Profitable trends: rank players by how well the model has read them against
-- its own baseline in the same window.
--
-- Everything the panel needs except three things already lives in
-- player_prediction_daily (20260806020238): per (day, player, role, market)
-- wins/losses/pushes and mean profit. The three it lacks are a home/away split,
-- the player's team, and how far velocity calls missed by. This migration adds
-- those, plus a streak function, plus the two aggregations the route calls.
--
-- ── 1. new columns ────────────────────────────────────────────────────────
--
-- `side` joins the primary key, so a player's home work and away work are
-- separate rows and the split is a filter rather than a second table.
--
-- It defaults to '' rather than NULL for the same reason model_version does:
-- it has to sit in the key. '' is not "unknown weather", it is a specific and
-- permanent state — a row rolled up before this migration, whose side cannot be
-- recovered because `predictions` only retains 21 days while this table keeps
-- 90. Those rows stay, unattributed, and the trends route counts them in a
-- player's totals but never in the home/away split. Deleting them instead would
-- throw away two months of real record to avoid one honest gap.
alter table player_prediction_daily
    add column if not exists side           text not null default '',
    add column if not exists team_id        int,
    add column if not exists mean_abs_error numeric(8,4);

alter table prediction_accuracy_daily
    add column if not exists mean_abs_error numeric(8,4);

-- Rekey on side. Existing rows carry '' and so cannot collide with the
-- 'home'/'away' rows the rewritten rollup writes.
do $$
begin
    if exists (
        select 1 from pg_constraint
        where conname = 'player_prediction_daily_pkey'
          and (select count(*) from unnest(conkey)) = 5
    ) then
        alter table player_prediction_daily drop constraint player_prediction_daily_pkey;
        alter table player_prediction_daily
            add constraint player_prediction_daily_pkey
            primary key (day, player_id, role, market, model_version, side);
    end if;
end $$;

create index if not exists player_prediction_daily_trends_idx
    on player_prediction_daily (day, market, role, side);

-- The unattributed rows for days the rollup can still recompute have to go, or
-- rebuilding them at side='home'/'away' would double-count the same calls
-- against the same player. Days older than the raw-prediction horizon are not
-- recomputable and are left alone.
delete from player_prediction_daily
where side = '' and day >= (now() - interval '21 days')::date;

-- ── 2. mean_abs_error in the accuracy rollup ──────────────────────────────
-- Only the over/under markets carry a numeric predicted and actual, so this is
-- NULL for the categorical ones rather than zero. It is what lets the Data
-- Feed's Velo MAE tile describe a window instead of one loaded slate.
create or replace function rollup_prediction_accuracy(p_days int default 7)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
    insert into prediction_accuracy_daily as t (
        day, market, model_version, n, n_graded, wins, losses, pushes,
        mean_confidence, mean_profit_units, mean_abs_error, updated_at
    )
    select
        created_at::date,
        market,
        coalesce(model_version, ''),
        count(*),
        count(*) filter (where result is not null),
        count(*) filter (where result = 'win'),
        count(*) filter (where result = 'loss'),
        count(*) filter (where result = 'push'),
        round(avg(confidence), 4),
        round(avg(profit_units), 4),
        round(avg(abs(predicted_value - actual_value))
              filter (where predicted_value is not null and actual_value is not null), 4),
        now()
    from predictions
    where created_at >= (now() - make_interval(days => p_days))::date
      and market is not null
    group by 1, 2, 3
    on conflict (day, market, model_version) do update set
        n                 = excluded.n,
        n_graded          = excluded.n_graded,
        wins              = excluded.wins,
        losses            = excluded.losses,
        pushes            = excluded.pushes,
        mean_confidence   = excluded.mean_confidence,
        mean_profit_units = excluded.mean_profit_units,
        mean_abs_error    = excluded.mean_abs_error,
        updated_at        = now();
    get diagnostics n = row_count;
    return n;
end $$;

-- ── 3. side + team + MAE in the player rollup ─────────────────────────────
-- Side is derived from the at-bat's FIRST pitch: top of the inning is the away
-- side batting, so the pitcher's side is its inverse. No API row names a
-- batting team, and at_bats carries no half-inning, so `pitches` is the only
-- place this exists. The lateral picks one row per at-bat off the unique
-- (game_pk, at_bat_index, pitch_number) index.
--
-- A missing first pitch leaves side '' and team NULL rather than guessing: an
-- at-bat we cannot place is not an at-bat that happened at home.
create or replace function rollup_player_predictions(p_days int default 7)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
    insert into player_prediction_daily as t (
        day, player_id, role, side, team_id, market, model_version,
        n, n_graded, wins, losses, pushes,
        mean_confidence, mean_profit_units, mean_abs_error, updated_at
    )
    select
        p.created_at::date,
        x.player_id,
        x.role,
        x.side,
        max(x.team_id),
        p.market,
        coalesce(p.model_version, ''),
        count(*),
        count(*) filter (where p.result is not null),
        count(*) filter (where p.result = 'win'),
        count(*) filter (where p.result = 'loss'),
        count(*) filter (where p.result = 'push'),
        round(avg(p.confidence), 4),
        round(avg(p.profit_units), 4),
        round(avg(abs(p.predicted_value - p.actual_value))
              filter (where p.predicted_value is not null and p.actual_value is not null), 4),
        now()
    from predictions p
    join at_bats a
      on a.game_pk = p.game_pk
     and a.at_bat_index = p.at_bat_index
    join games g on g.game_pk = p.game_pk
    left join lateral (
        select pt.top_inning
        from pitches pt
        where pt.game_pk = a.game_pk and pt.at_bat_index = a.at_bat_index
        order by pt.pitch_number
        limit 1
    ) fp on true
    cross join lateral (values
        (a.pitcher_id, 'pitcher',
         case when fp.top_inning is null then '' when fp.top_inning then 'home' else 'away' end,
         case when fp.top_inning is null then null when fp.top_inning then g.home_team_id else g.away_team_id end),
        (a.batter_id, 'batter',
         case when fp.top_inning is null then '' when fp.top_inning then 'away' else 'home' end,
         case when fp.top_inning is null then null when fp.top_inning then g.away_team_id else g.home_team_id end)
    ) as x(player_id, role, side, team_id)
    where p.created_at >= (now() - make_interval(days => p_days))::date
      and p.market is not null
      and p.at_bat_index is not null
      and x.player_id is not null
    group by 1, 2, 3, 4, 6, 7
    on conflict (day, player_id, role, market, model_version, side) do update set
        team_id           = excluded.team_id,
        n                 = excluded.n,
        n_graded          = excluded.n_graded,
        wins              = excluded.wins,
        losses            = excluded.losses,
        pushes            = excluded.pushes,
        mean_confidence   = excluded.mean_confidence,
        mean_profit_units = excluded.mean_profit_units,
        mean_abs_error    = excluded.mean_abs_error,
        updated_at        = now();
    get diagnostics n = row_count;
    return n;
end $$;

-- Both rollups keep the batch timeout set in 20260825123241; CREATE OR REPLACE
-- above does not carry the setting over, so it is reapplied here.
alter function rollup_prediction_accuracy(int) set statement_timeout = '120s';
alter function rollup_player_predictions(int)  set statement_timeout = '120s';

-- ── 4. current streak ─────────────────────────────────────────────────────
-- Consecutive graded CALLS, newest first — "W5" means the last five settled
-- calls involving this player were right, which is what the panel's W5/L3
-- reads as. A day-level streak off the rollup would have meant five winning
-- days, a different and weaker claim.
--
-- This is the one number the daily aggregates genuinely cannot answer: ordering
-- is lost the moment calls are grouped by day. So it goes back to the raw rows,
-- and is therefore bounded by their 21-day retention — past that it returns
-- nothing and the route reports streak: null rather than a truncated run.
--
-- Bounded by an explicit player list. The route ranks first and asks for
-- streaks only for the handful of players it is about to return, which turns a
-- full scan of both sides of every prediction into an at_bats probe.
--
-- Pushes are skipped, not counted as breaks: a push is not a wrong call, and
-- ending a streak on one would report the model as having gone cold when it
-- had merely landed on the number.
create or replace function player_streaks(
    p_from date, p_to date, p_player_ids int[]
)
returns table (player_id int, role text, streak int)
language sql stable security definer set search_path = public, pg_temp as $$
    with graded as (
        select x.player_id, x.role, p.id, p.result
        from at_bats a
        join predictions p
          on p.game_pk = a.game_pk
         and p.at_bat_index = a.at_bat_index
        cross join lateral (values
            (a.pitcher_id, 'pitcher'),
            (a.batter_id,  'batter')
        ) as x(player_id, role)
        where x.player_id = any(p_player_ids)
          and p.created_at >= p_from
          and p.created_at < (p_to + 1)
          and p.result in ('win', 'loss')
    ),
    ranked as (
        select
            g.player_id, g.role, g.result,
            -- Gaps and islands. Within a player the two row numbers advance
            -- together only while the result is unchanged, so the leading run
            -- — and only it — has a difference of zero.
            row_number() over (partition by g.player_id, g.role order by g.id desc)
          - row_number() over (partition by g.player_id, g.role, g.result order by g.id desc)
            as grp
        from graded g
    )
    select
        r.player_id,
        r.role,
        (case when r.result = 'win' then count(*) else -count(*) end)::int
    from ranked r
    where r.grp = 0
    group by r.player_id, r.role, r.result;
$$;

-- ── 5. the two aggregations the /trends route calls ───────────────────────
-- The window baseline: the model's record over the same window under the same
-- filters, so a player's edge is measured against like and not against the
-- all-markets average.
create or replace function player_trends_baseline(
    p_from date, p_to date,
    p_market text default null, p_role text default null,
    p_side text default null, p_team_id int default null
)
returns table (n_graded bigint, wins bigint, losses bigint,
               win_rate numeric, profit_units numeric)
language sql stable security definer set search_path = public, pg_temp as $$
    select
        coalesce(sum(d.n_graded), 0),
        coalesce(sum(d.wins), 0),
        coalesce(sum(d.losses), 0),
        case when coalesce(sum(d.wins + d.losses), 0) > 0
             then round(sum(d.wins)::numeric / sum(d.wins + d.losses), 4) end,
        round(coalesce(sum(d.mean_profit_units * d.n_graded), 0), 2)
    from player_prediction_daily d
    where d.day between p_from and p_to
      and (p_market  is null or d.market  = p_market)
      and (p_role    is null or d.role    = p_role)
      and (p_side    is null or d.side    = p_side)
      and (p_team_id is null or d.team_id = p_team_id);
$$;

-- One row per player, already filtered by the sample floor and ranked. Doing
-- this in SQL rather than in the edge function is not an optimisation: a 90-day
-- window is tens of thousands of daily rows, and PostgREST would have to page
-- all of them across the wire to sum six columns.
create or replace function player_trends(
    p_from date, p_to date,
    p_market text default null, p_role text default null,
    p_side text default null, p_team_id int default null,
    p_min_graded int default 20, p_limit int default 50,
    p_order text default 'edge'
)
returns table (
    player_id int, name text, role text, team_id int,
    n bigint, n_graded bigint, wins bigint, losses bigint, pushes bigint,
    win_rate numeric, profit_units numeric, mean_abs_error numeric,
    home_graded bigint, home_wins bigint, home_win_rate numeric,
    away_graded bigint, away_wins bigint, away_win_rate numeric
)
language sql stable security definer set search_path = public, pg_temp as $$
    with agg as (
        select
            d.player_id,
            d.role,
            max(d.team_id) as team_id,
            sum(d.n)        as n,
            sum(d.n_graded) as n_graded,
            sum(d.wins)     as wins,
            sum(d.losses)   as losses,
            sum(d.pushes)   as pushes,
            round(coalesce(sum(d.mean_profit_units * d.n_graded), 0), 2) as profit_units,
            -- Weighted by graded count, matching how /api/accuracy folds the
            -- model_version split: a day that served four calls must not pull
            -- the mean as hard as one that served four hundred.
            case when sum(d.n_graded) filter (where d.mean_abs_error is not null) > 0
                 then round(
                     sum(d.mean_abs_error * d.n_graded) filter (where d.mean_abs_error is not null)
                   / sum(d.n_graded) filter (where d.mean_abs_error is not null), 2)
            end as mean_abs_error,
            sum(d.wins + d.losses) filter (where d.side = 'home') as home_graded,
            sum(d.wins)            filter (where d.side = 'home') as home_wins,
            sum(d.wins + d.losses) filter (where d.side = 'away') as away_graded,
            sum(d.wins)            filter (where d.side = 'away') as away_wins
        from player_prediction_daily d
        where d.day between p_from and p_to
          and (p_market  is null or d.market  = p_market)
          and (p_role    is null or d.role    = p_role)
          and (p_side    is null or d.side    = p_side)
          and (p_team_id is null or d.team_id = p_team_id)
        group by d.player_id, d.role
    )
    select
        a.player_id,
        pi.full_name,
        a.role,
        a.team_id,
        a.n, a.n_graded, a.wins, a.losses, a.pushes,
        round(a.wins::numeric / (a.wins + a.losses), 4) as win_rate,
        a.profit_units,
        a.mean_abs_error,
        coalesce(a.home_graded, 0), coalesce(a.home_wins, 0),
        case when coalesce(a.home_graded, 0) > 0
             then round(a.home_wins::numeric / a.home_graded, 4) end,
        coalesce(a.away_graded, 0), coalesce(a.away_wins, 0),
        case when coalesce(a.away_graded, 0) > 0
             then round(a.away_wins::numeric / a.away_graded, 4) end
    from agg a
    left join player_info pi on pi.player_id = a.player_id
    -- The sample floor. Without it a 4-for-5 stretch outranks a 60-call edge,
    -- which is exactly the failure a "profitable trends" table invites.
    where (a.wins + a.losses) >= greatest(p_min_graded, 1)
    order by
        case when p_order = 'units'    then a.profit_units end desc nulls last,
        case when p_order = 'win_rate' then round(a.wins::numeric / (a.wins + a.losses), 4) end desc nulls last,
        -- Default. Ranking on win rate is the same ordering as ranking on edge,
        -- because the baseline is one number for the whole window.
        case when p_order not in ('units', 'win_rate')
             then round(a.wins::numeric / (a.wins + a.losses), 4) end desc nulls last,
        a.n_graded desc
    limit greatest(least(p_limit, 200), 1);
$$;

revoke execute on function player_streaks(date, date, int[]) from anon, authenticated, public;
revoke execute on function player_trends_baseline(date, date, text, text, text, int) from anon, authenticated, public;
revoke execute on function player_trends(date, date, text, text, text, int, int, int, text) from anon, authenticated, public;
