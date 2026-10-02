-- Attribute predictions to the game they are about, and keep backfilled rows
-- out of the live track record.
--
-- Prerequisite for the historical backfill (see docs: the backtest plan). Three
-- things keyed a prediction to the moment the ROW was written rather than the
-- game it describes. That was harmless while every row was written live, a
-- few hours at most from first pitch. It stops being harmless the moment
-- backfill-predictions writes a row today about a game played on 09-14:
--
--   rollup_prediction_accuracy / rollup_player_predictions
--       grouped by created_at::date, so the backfilled row was credited to
--       TODAY, and counted as a live call. They also used the UTC date, so
--       every evening game already landed on the next day.
--   prune_predictions
--       deleted by created_at, so a backfilled row about an old game survived
--       21 days past its insertion instead of 21 days past its game.
--   refresh_graded_reads
--       had no backfilled_at filter, so reconstructed calls entered the Data
--       Feed's graded reads alongside live ones.
--
-- All four now join `games` and use official_date (the America/New_York slate
-- date the rest of the product already uses), and the live-record functions
-- exclude backfilled_at IS NOT NULL. Backfilled history gets its own,
-- labelled series instead (product decision, 2026-10-02).
--
-- Days outside the rollup window keep the UTC created_at attribution they were
-- written with; only the trailing p_days are re-derived on each run.


-- ── 1. projection columns ────────────────────────────────────────────────
-- role / line / expected_value were added to production directly with the
-- base-model starter props and never had a migration; types match prod
-- exactly, so these are no-ops there and correct on a fresh database.
alter table player_game_projections
    add column if not exists role           text,
    add column if not exists line           numeric(6,2),
    add column if not exists expected_value numeric(8,4),
    -- Same meaning as predictions.backfilled_at: written after the fact,
    -- never available before the game. Filter IS NULL for the live record.
    add column if not exists backfilled_at  timestamptz;

comment on column player_game_projections.backfilled_at is
    'Set when the row was reconstructed after the game rather than published '
    'pregame by game-predict. Filter on IS NULL for a true live track record.';


-- ── 2. daily accuracy rollup, by slate date ──────────────────────────────
-- Whole slate days only: the window is a set of official_dates, so a day is
-- either fully re-derived or not touched. A created_at window could cut a day
-- in half and overwrite it with a partial count.
create or replace function rollup_prediction_accuracy(p_days int default 7)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare
    d_to   date := (now() at time zone 'America/New_York')::date;
    d_from date := d_to - greatest(p_days, 1);
    n      int;
begin
    insert into prediction_accuracy_daily as t (
        day, market, model_version, n, n_graded, wins, losses, pushes,
        mean_confidence, mean_profit_units, mean_abs_error, updated_at
    )
    select
        g.official_date,
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
    from games g
    join predictions p on p.game_pk = g.game_pk
    where g.official_date between d_from and d_to
      and p.market is not null
      and p.backfilled_at is null
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


-- ── 3. per-player rollup, same change ────────────────────────────────────
-- Body otherwise identical to 20260825124157_player_trends.sql.
create or replace function rollup_player_predictions(p_days int default 7)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare
    d_to   date := (now() at time zone 'America/New_York')::date;
    d_from date := d_to - greatest(p_days, 1);
    n      int;
begin
    insert into player_prediction_daily as t (
        day, player_id, role, side, team_id, market, model_version,
        n, n_graded, wins, losses, pushes,
        mean_confidence, mean_profit_units, mean_abs_error, updated_at
    )
    select
        g.official_date,
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
    from games g
    join predictions p on p.game_pk = g.game_pk
    join at_bats a
      on a.game_pk = p.game_pk
     and a.at_bat_index = p.at_bat_index
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
    where g.official_date between d_from and d_to
      and p.market is not null
      and p.at_bat_index is not null
      and p.backfilled_at is null
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


-- ── 4. prune by the game's date ──────────────────────────────────────────
-- Live and backfilled rows alike age out 21 days after the game they describe.
-- The rollups above cover p_days = 7, well inside the horizon, so nothing is
-- pruned before it has been rolled up.
create or replace function prune_predictions(keep_days int default 21)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
    delete from predictions p
     using games g
     where g.game_pk = p.game_pk
       and g.official_date < (now() at time zone 'America/New_York')::date - keep_days;
    get diagnostics n = row_count;
    return n;
end $$;

-- CREATE OR REPLACE does not carry these over (see 20260825124157).
alter function rollup_prediction_accuracy(int) set statement_timeout = '120s';
alter function rollup_player_predictions(int)  set statement_timeout = '120s';
alter function prune_predictions(int)          set statement_timeout = '300s';
revoke execute on function rollup_prediction_accuracy(int) from anon, authenticated, public;
revoke execute on function rollup_player_predictions(int)  from anon, authenticated, public;
revoke execute on function prune_predictions(int)          from anon, authenticated, public;


-- ── 5. graded reads: live calls only ─────────────────────────────────────
-- Taken from the PRODUCTION definition, which has drifted from
-- 20260930221608: prod restricts the projection branch to batter_hit /
-- batter_hr (the Data Feed's two batter markets). That filter is kept, and the
-- only change is `backfilled_at is null` on both row-level sources.
create or replace function refresh_graded_reads(p_days int default 2)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
    d_to   date := (now() at time zone 'America/New_York')::date;
    d_from date := d_to - greatest(p_days, 1) + 1;
    n      int;
begin
    delete from graded_read where official_date between d_from and d_to;

    with gs as materialized (
        select * from games where official_date between d_from and d_to
    ),
    pr as materialized (
        select p.id, p.game_pk, p.at_bat_index, p.market, p.result, p.recommendation,
               p.actual_label, p.graded_at, p.created_at,
               coalesce((p.probs ->> p.recommendation)::numeric, p.confidence) as prob,
               row_number() over (partition by p.game_pk, p.at_bat_index, p.market
                                  order by p.pitch_number desc) as rn
          from predictions p
          join gs on gs.game_pk = p.game_pk
         where p.market in ('pitch_result', 'ab_result')
           and p.result in ('win', 'loss', 'void')
           and p.backfilled_at is null
    )
    insert into graded_read
    select 'p:' || pgp.market || ':' || pgp.game_pk || ':' || pgp.player_id,
           coalesce(pgp.graded_at, pgp.updated_at), pgp.official_date, pgp.market,
           g.game_pk, g.away_abbr, g.home_abbr, g.venue_id, g.venue_name,
           array[case when pgp.is_home then g.home_abbr else g.away_abbr end],
           null, pgp.probability, pgp.result, null,
           sp.pitch_hand, case when pgp.is_home then 'home' else 'away' end, pgp.lineup_slot,
           pgp.player_id, pgp.opposing_pitcher_id,
           case when pgp.is_home then g.home_abbr else g.away_abbr end
      from player_game_projections pgp
      join gs g on g.game_pk = pgp.game_pk
      left join player_info sp on sp.player_id = pgp.opposing_pitcher_id
     where pgp.market in ('batter_hit', 'batter_hr')
       and pgp.result in ('hit', 'miss', 'void')
       and pgp.probability is not null
       and pgp.backfilled_at is null

    union all
    select 'g:' || gp.market || ':' || gp.game_pk,
           coalesce(gp.graded_at, gp.updated_at), gp.official_date, gp.market,
           g.game_pk, g.away_abbr, g.home_abbr, g.venue_id, g.venue_name,
           array[g.away_abbr, g.home_abbr],
           case when gp.market = 'game_moneyline'
                then (case gp.recommendation when 'home' then g.home_abbr
                                             when 'away' then g.away_abbr
                                             else gp.recommendation end) || ' to win'
                else initcap(gp.recommendation) || ' ' || trim_scale(gp.line)::text end,
           coalesce((gp.probs ->> gp.recommendation)::numeric, gp.confidence),
           case gp.result when 'win' then 'hit' when 'loss' then 'miss' else 'void' end,
           null, null, null, null, null, null, null
      from game_predictions gp
      join gs g on g.game_pk = gp.game_pk
     where gp.phase = 'pregame'
       and gp.market in ('game_moneyline', 'game_total')
       and gp.result in ('win', 'loss', 'void')
       and coalesce((gp.probs ->> gp.recommendation)::numeric, gp.confidence) is not null

    union all
    select 'x:' || p.id,
           coalesce(p.graded_at, p.created_at), g.official_date, p.market,
           g.game_pk, g.away_abbr, g.home_abbr, g.venue_id, g.venue_name,
           array[g.away_abbr, g.home_abbr],
           p.recommendation,
           p.prob,
           case p.result when 'win' then 'hit' when 'loss' then 'miss' else 'void' end,
           p.actual_label,
           pi.pitch_hand,
           case when s.top_inning then 'away' when not s.top_inning then 'home' end,
           slot.lineup_slot,
           ab.batter_id, ab.pitcher_id,
           case when s.top_inning then g.away_abbr when not s.top_inning then g.home_abbr end
      from pr p
      join gs g on g.game_pk = p.game_pk
      left join at_bats ab on ab.game_pk = p.game_pk and ab.at_bat_index = p.at_bat_index
      left join player_info pi on pi.player_id = ab.pitcher_id
      left join lateral (
          select x.top_inning from pitches x
           where x.game_pk = p.game_pk and x.at_bat_index = p.at_bat_index
           limit 1
      ) s on true
      left join lateral (
          select q.lineup_slot from player_game_projections q
           where q.game_pk = p.game_pk and q.player_id = ab.batter_id
             and q.market = 'batter_hit'
           limit 1
      ) slot on true
     where (p.market = 'pitch_result' or p.rn = 1)
       and p.prob is not null;

    get diagnostics n = row_count;

    delete from graded_read
     where market in ('pitch_result', 'ab_result')
       and official_date < d_to - 35;

    return n;
end;
$$;

revoke execute on function refresh_graded_reads(int) from anon, authenticated, public;
