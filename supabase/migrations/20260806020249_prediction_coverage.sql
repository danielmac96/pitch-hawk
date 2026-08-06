-- Prediction coverage instrumentation.
--
-- The gap this measures, on 2026-08-06: 11 games on the slate, 0 with any
-- prediction. Coverage only ever appeared once a game went live, so a user
-- logging in before first pitch saw an empty board. This view and RPC make that
-- number visible before and after the fix, and make a regression catchable.
--
-- Six markets are expected per game: pitch_result, pitch_speed_ou, ab_result,
-- ab_pitches_ou, game_moneyline, game_total.

-- Per-game coverage for every scheduled game, from both the new game-level
-- table and the raw per-pitch table. The raw fallback matters for days that
-- predate game_predictions but still have retained `predictions` rows -- without
-- it the backfilled history would read as a coverage failure.
create or replace view prediction_coverage_daily as
select
    g.official_date,
    g.game_pk,
    g.status,
    g.start_ts,
    coalesce(gp.pregame_markets, 0)          as pregame_markets,
    coalesce(gp.live_markets, 0)             as live_markets,
    coalesce(raw.raw_markets, 0)             as raw_markets,
    greatest(
        coalesce(gp.pregame_markets, 0),
        coalesce(gp.live_markets, 0),
        coalesce(raw.raw_markets, 0)
    )                                        as markets_covered,
    6                                        as markets_expected
from games g
left join (
    select
        game_pk,
        count(distinct market) filter (where phase = 'pregame') as pregame_markets,
        count(distinct market) filter (where phase = 'live')    as live_markets
    from game_predictions
    group by game_pk
) gp on gp.game_pk = g.game_pk
left join (
    select game_pk, count(distinct market) as raw_markets
    from predictions
    group by game_pk
) raw on raw.game_pk = g.game_pk;

grant select on prediction_coverage_daily to anon, authenticated;

-- Aggregate rollup for the /api/coverage route and the QA dashboard.
--
-- `full_cov` counts games carrying all six markets from any source;
-- `pregame_full` counts games that had all six BEFORE first pitch, which is the
-- number this work actually moves. A game can be fully covered in hindsight and
-- still have shown an empty board all morning.
create or replace function prediction_coverage(p_from date, p_to date)
returns table (
    official_date   date,
    games           bigint,
    full_cov        bigint,
    partial_cov     bigint,
    zero_cov        bigint,
    pregame_full    bigint,
    avg_markets     numeric
) language sql stable security definer set search_path = public, pg_temp as $$
    select
        c.official_date,
        count(*),
        count(*) filter (where c.markets_covered >= c.markets_expected),
        count(*) filter (where c.markets_covered between 1 and c.markets_expected - 1),
        count(*) filter (where c.markets_covered = 0),
        count(*) filter (where c.pregame_markets >= c.markets_expected),
        round(avg(c.markets_covered), 2)
    from prediction_coverage_daily c
    where c.official_date between p_from and p_to
    group by c.official_date
    order by c.official_date desc;
$$;

-- Read-only aggregate over public data; the frontend calls it through
-- /api/coverage. Matches the pick_record() grant pattern.
grant execute on function prediction_coverage(date, date) to anon, authenticated;
