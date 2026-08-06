-- Inputs for the game_total model.
--
-- Both are group-bys, which PostgREST cannot express, and both are cheap enough
-- to run once per game-predict invocation (hourly) rather than being
-- materialised. Keeping them as functions means the model reads the same
-- numbers the database has, with no publish step to fall out of date.

-- Team scoring and run-prevention rates for a season, from completed games.
--
-- Each game contributes to both teams: the home team's runs scored are the away
-- team's runs allowed. Early in a season the sample is thin, so the caller
-- blends these toward the league mean by `games`.
-- win_pct rides along rather than getting its own function because it comes off
-- the same scan, and log5HomeProb (the moneyline model) needs it. That number
-- used to be computed inline in odds-ingest, which no longer runs -- which is
-- why pregame moneyline coverage was zero.
--
-- Regular season only (game_type = 'R'): the All-Star rosters are team ids
-- 159/160 with a single Final game apiece, and log5 on a 1.000 win percentage
-- produces a nonsense moneyline.
create or replace function team_run_rates(p_season int)
returns table (
    team_id int,
    games   bigint,
    rs_pg   numeric,
    ra_pg   numeric,
    win_pct numeric
) language sql stable security definer set search_path = public, pg_temp as $$
    with sides as (
        select home_team_id as team_id, home_score as rs, away_score as ra
        from games
        where season = p_season and status like 'Final%' and game_type = 'R'
          and home_score is not null and away_score is not null
        union all
        select away_team_id, away_score, home_score
        from games
        where season = p_season and status like 'Final%' and game_type = 'R'
          and home_score is not null and away_score is not null
    )
    select
        team_id,
        count(*),
        round(avg(rs), 3),
        round(avg(ra), 3),
        -- Ties are impossible in MLB, so wins/games is the win percentage.
        round(avg(case when rs > ra then 1.0 else 0.0 end), 4)
    from sides
    where team_id is not null
    group by team_id;
$$;

-- Park run factors from game_context, which carries full history.
--
-- Shrunk toward 1.0 with a 200-game prior: a venue with 40 games of data should
-- not move a projection as much as one with 2,000. Returned as a multiplier so
-- the model can apply it directly.
create or replace function park_factors(p_from_season int default null)
returns table (
    venue_id  int,
    games     bigint,
    runs_pg   numeric,
    factor    numeric
) language sql stable security definer set search_path = public, pg_temp as $$
    with scored as (
        select venue_id, (home_score + away_score)::numeric as runs
        from game_context
        where venue_id is not null
          and home_score is not null and away_score is not null
          and (p_from_season is null or season >= p_from_season)
    ),
    lg as (select avg(runs) as mean_runs from scored),
    byvenue as (
        select venue_id, count(*) as games, avg(runs) as runs_pg
        from scored group by venue_id
    )
    select
        b.venue_id,
        b.games,
        round(b.runs_pg, 3),
        -- shrink: w = n / (n + 200)
        round(
            1 + (b.runs_pg / nullif(lg.mean_runs, 0) - 1)
                * (b.games::numeric / (b.games + 200)),
            4)
    from byvenue b cross join lg;
$$;

-- Called only by the game-predict edge function under the service role.
revoke execute on function team_run_rates(int) from anon, authenticated, public;
revoke execute on function park_factors(int) from anon, authenticated, public;
