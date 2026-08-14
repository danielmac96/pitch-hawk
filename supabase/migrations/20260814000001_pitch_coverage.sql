-- Per-pitch prediction coverage.
--
-- 20260806020249 measures coverage per GAME: count(distinct market) against a
-- hardcoded 6. That number cannot see the gap this migration exists to expose.
-- A game where live-poll wrote one batch in the 3rd inning and then errored for
-- six innings scores 6/6, fully covered, because it produced all six markets at
-- least once.
--
-- The real question is per pitch: did every pitch actually thrown get a
-- velocity call and a result call? Until 2026-08-14 the answer was no by
-- construction — live-poll wrote one batch per 30-second poll rather than one
-- per pitch, so any pitch sharing an interval with another was ingested into
-- `pitches` and never scored. Nothing in the schema, the API or the dashboard
-- would have surfaced that.
--
-- THE OFF-BY-ONE IS DELIBERATE. A prediction is a call made INTO a position:
-- `predictions.pitch_number` = k means "k pitches thrown so far, here is the
-- call on the next one". `pitches.pitch_number` is 1-based. So the row that
-- called pitch number n is the prediction stamped n - 1. Joining them on equal
-- pitch_number would compare a call to the pitch before the one it was about
-- and report a plausible-looking, wrong number.
--
-- RETENTION. `predictions` is pruned at 21 days (20260728000002) while
-- `pitches` keeps a 35-day hot window (20260802000003). Days 22-35 therefore
-- read as zero coverage because the calls are gone, not because they were never
-- made. Callers must bound their window to 21 days; prediction_coverage_pitch()
-- below does.

create or replace view pitch_prediction_coverage as
with thrown as (
    select p.game_pk, p.at_bat_index, p.pitch_number
    from pitches p
    where p.at_bat_index is not null
      and p.pitch_number is not null
),
called as (
    select
        pr.game_pk,
        pr.at_bat_index,
        pr.pitch_number,
        bool_or(pr.market = 'pitch_speed_ou') as has_velo,
        bool_or(pr.market = 'pitch_result')   as has_result
    from predictions pr
    where pr.market in ('pitch_speed_ou', 'pitch_result')
      and pr.at_bat_index is not null
      and pr.pitch_number is not null
    group by 1, 2, 3
)
select
    g.official_date,
    t.game_pk,
    g.status,
    count(*)                                                as pitches_thrown,
    count(*) filter (where c.has_velo)                      as velo_called,
    count(*) filter (where c.has_result)                    as result_called,
    count(*) filter (where c.has_velo and c.has_result)     as both_called,
    count(*) filter (where c.game_pk is null)               as uncalled
from thrown t
join games g on g.game_pk = t.game_pk
-- n - 1: the call that was about pitch n. See the header.
left join called c
       on c.game_pk = t.game_pk
      and c.at_bat_index = t.at_bat_index
      and c.pitch_number = t.pitch_number - 1
group by g.official_date, t.game_pk, g.status;

grant select on pitch_prediction_coverage to anon, authenticated;

-- Daily rollup for /api/coverage and the QA dashboard.
--
-- `both_rate` is the headline: the fraction of pitches actually thrown that
-- carry BOTH a velocity and a result call. That is the number the per-pitch
-- writer moves, and the one a regression would drop.
create or replace function prediction_coverage_pitch(p_from date, p_to date)
returns table (
    official_date   date,
    games           bigint,
    pitches_thrown  bigint,
    velo_called     bigint,
    result_called   bigint,
    both_called     bigint,
    uncalled        bigint,
    both_rate       numeric
) language sql stable security definer set search_path = public, pg_temp as $$
    select
        c.official_date,
        count(*),
        sum(c.pitches_thrown),
        sum(c.velo_called),
        sum(c.result_called),
        sum(c.both_called),
        sum(c.uncalled),
        case when sum(c.pitches_thrown) > 0
             then round(sum(c.both_called)::numeric / sum(c.pitches_thrown), 4)
        end
    from pitch_prediction_coverage c
    where c.official_date between
        -- Clamped to the raw-prediction retention horizon. Past it the calls
        -- have been pruned and every day would read as a total failure.
        greatest(p_from, (current_date - 21)) and p_to
    group by c.official_date
    order by c.official_date desc;
$$;

-- Read-only aggregate over public data, matching the prediction_coverage()
-- grant pattern in 20260806020249.
grant execute on function prediction_coverage_pitch(date, date) to anon, authenticated;
