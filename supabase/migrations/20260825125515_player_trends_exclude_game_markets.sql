-- Exclude the two game-level markets from the unfiltered player view.
--
-- live-poll writes game_moneyline into `predictions` stamped with the at-bat in
-- progress, so rollup_player_predictions attributes a game win-probability call
-- to whichever pitcher and batter happened to be on the field when it was
-- scored. That is fine for the feed, which asks "what did we say about this
-- game", and wrong for a trends table, which asks "how well has the model read
-- this player" -- the call was not about them. Left in, a closer's record was
-- padded with the win probability of games he happened to be finishing.
--
-- Excluded only when no market is named. Asking for market=game_total
-- explicitly still returns it, because then the caller has said what they mean.

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
      and (case when p_market is null
                then d.market not in ('game_moneyline', 'game_total')
                else d.market = p_market end)
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
          and (case when p_market is null
                    then d.market not in ('game_moneyline', 'game_total')
                    else d.market = p_market end)
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

revoke execute on function player_trends_baseline(date, date, text, text, text, int) from anon, authenticated, public;
revoke execute on function player_trends(date, date, text, text, text, int, int, int, text) from anon, authenticated, public;
