-- Schedule full-slate pregame scoring.
--
-- Runs at :05 past every hour, which covers both halves of the intended
-- cadence: np-daily-ingest loads the slate at 13:00 UTC and this fires at 13:05
-- against it, then keeps refreshing hourly as probable starters firm up and
-- scratches land. No cross-function invocation from daily-ingest is needed for
-- the slate-load run -- 13:05 is the slate-load run.
--
-- Gated so it costs nothing on an idle day: it only fires when the slate holds a
-- game that has not started yet. Same guard shape as np-live-poll
-- (20260716000001), which fires only inside a game window.
--
-- Pregame rows are frozen (game-predict upserts with ignoreDuplicates), so an
-- hourly re-run is cheap and idempotent: it writes only the games and markets
-- that do not have a row yet.

do $$
declare j record;
begin
    for j in select jobid from cron.job where jobname = 'np-game-predict' loop
        perform cron.unschedule(j.jobid);
    end loop;
end $$;

select cron.schedule('np-game-predict', '5 * * * *', $$
do $body$
begin
    if exists (
        select 1 from games
        where official_date = (now() at time zone 'America/New_York')::date
          and start_ts > now()
          and status not like 'Final%'
          and status not in ('Postponed', 'Cancelled', 'Canceled', 'Suspended')
    ) then
        perform call_edge_function('game-predict');
    end if;
end $body$
$$);
