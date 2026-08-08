-- Move the prediction jobs onto an Eastern-time schedule, and make scoring
-- event-driven instead of polled.
--
-- Three changes:
--
--   1. np-game-predict  hourly-always  ->  10:00 ET main run + gap-fill only
--   2. np-settle        every 10 min   ->  deleted; live-poll now chains settle
--   3. np-settle-sweep  (new)          ->  03:00 ET, the guaranteed pre-export pass
--
-- WHY THE LOCAL-HOUR GATE INSTEAD OF A UTC CRON EXPRESSION
--
-- pg_cron evaluates schedules in the database timezone (UTC here) and has no
-- per-job timezone. A literal '0 14 * * *' is 10:00 in New York from March to
-- November and 09:00 for the rest of the year, because the US moved to DST but
-- the cron expression did not. Every job below therefore runs *hourly* and
-- returns immediately unless the local Eastern hour matches. The hourly tick is
-- one cheap `exists` against `games`, and the schedule stays correct across both
-- DST transitions without anyone remembering to re-cut it in November.
--
-- This is the same shape the existing guards already use -- 20260806020310 and
-- 20260716000001 both reason in `now() at time zone 'America/New_York'`.

-- ── 1. Pregame scoring: one 10:00 ET run, then gap-fill only ────────────────
--
-- Previously this fired unconditionally at :05 of every hour whenever the slate
-- held an unstarted game. That was self-healing but wasteful: pregame rows are
-- frozen (game-predict upserts with ignoreDuplicates), so 13 of every 14 runs
-- wrote nothing.
--
-- The main run is now 10:00 ET. Later hours re-run ONLY if some game that has
-- still not started is missing pregame markets -- which is what recovers a
-- failed 10:00 run, and a probable starter announced after it. Coverage went
-- from 0/15 to 15/15 games when hourly scoring shipped; the gap-fill branch is
-- what keeps that guarantee without the 13 no-op runs.
--
-- The count is against `game_predictions` directly rather than the
-- `prediction_coverage_daily` view: the view aggregates all of `predictions`
-- (~250k rows) to compute its raw-market fallback, which is far too heavy for
-- an hourly gate. `game_predictions` is ~3k rows and is the authoritative
-- source for the pregame phase anyway.

do $$
declare j record;
begin
    for j in select jobid from cron.job where jobname = 'np-game-predict' loop
        perform cron.unschedule(j.jobid);
    end loop;
end $$;

select cron.schedule('np-game-predict', '5 * * * *', $$
do $body$
declare
    et_now  timestamp := now() at time zone 'America/New_York';
    et_hour int       := extract(hour from et_now);
    et_date date      := et_now::date;
    fire    boolean;
begin
    -- Nothing to predict before the main run.
    if et_hour < 10 then
        return;
    end if;

    if et_hour = 10 then
        -- Main run: any game on today's slate that has not started yet.
        select exists (
            select 1 from games
            where official_date = et_date
              and start_ts > now()
              and status not like 'Final%'
              and status not in ('Postponed', 'Cancelled', 'Canceled', 'Suspended')
        ) into fire;
    else
        -- Gap-fill: only games still ahead of first pitch can take a pregame
        -- row at all, so a game that has already started is not a gap.
        -- Six markets are expected per game (see 20260806020249).
        select exists (
            select 1 from games g
            where g.official_date = et_date
              and g.start_ts > now()
              and g.status not like 'Final%'
              and g.status not in ('Postponed', 'Cancelled', 'Canceled', 'Suspended')
              and (
                  select count(distinct gp.market)
                  from game_predictions gp
                  where gp.game_pk = g.game_pk and gp.phase = 'pregame'
              ) < 6
        ) into fire;
    end if;

    if fire then
        perform call_edge_function('game-predict');
    end if;
end $body$
$$);


-- ── 2. Retire the 10-minute settle timer ───────────────────────────────────
--
-- live-poll now invokes settle itself at the end of any cycle that ingested new
-- pitches or marked a game final, so a result is graded within ~30s of landing
-- rather than up to 10 minutes later. Polling every 10 minutes on top of that
-- would grade nothing on most runs.
--
-- Note what this deliberately gives up: settle no longer runs at all outside
-- game windows, because live-poll does not. Anything that could not be graded
-- while games were on -- a game that went final after the last poll cycle, or a
-- row whose grading errored -- waits for the sweep in step 3.

do $$
declare j record;
begin
    for j in select jobid from cron.job where jobname = 'np-settle' loop
        perform cron.unschedule(j.jobid);
    end loop;
end $$;


-- ── 3. The guaranteed pre-export sweep, 03:00 ET ───────────────────────────
--
-- This exists for the export, not for the website. The 04:00 ET warehouse job
-- uploads the day's predictions to R2, and a row exported ungraded is a row the
-- holdout set can never score. One hour of margin between the two.
--
-- 03:00 ET is after the last West Coast finish on all but a pathological night
-- (a 22:00 ET first pitch runs to roughly 01:00-02:00 ET). A game still not
-- final at 03:00 keeps its rows ungraded, they export with result = null, and
-- the following night's sweep grades them -- the export is keyed by day and is
-- re-runnable, so nothing is lost permanently.

select cron.schedule('np-settle-sweep', '0 * * * *', $$
do $body$
begin
    if extract(hour from (now() at time zone 'America/New_York')) = 3 then
        perform call_edge_function('settle');
    end if;
end $body$
$$);
