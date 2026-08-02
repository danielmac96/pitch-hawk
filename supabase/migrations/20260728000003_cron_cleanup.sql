-- Cron hygiene + restart the stalled settlement pipeline.
--
-- Two problems found on 2026-07-28:
--
-- 1) np-backfill still fires EVERY MINUTE even though backfill_progress.done
--    has been true since 2026-07-07. The DO block short-circuits, so it does no
--    work — but pg_cron still records every tick in cron.job_run_details, at
--    ~1,440 rows/day for nothing. Unschedule it; re-add it only if a new
--    backfill window is ever started.
--
-- 2) 20260716000001_live_windows.sql unscheduled np-settle and never restored
--    it. Consequence: 9,961 picks are stuck 'pending' and 131,346 predictions
--    are ungraded, so /record is frozen and rollup_prediction_accuracy() would
--    aggregate nothing but nulls.
--
-- np-odds-ingest stays OFF deliberately — no odds surface has shipped in the
-- UI yet (PH_FEATURES.wageringInsights defaults false), so ingesting odds would
-- only grow the `odds` table with data nothing reads.

-- Backfill is complete; stop the per-minute no-op.
do $$
declare j record;
begin
    for j in select jobid, jobname from cron.job where jobname = 'np-backfill' loop
        perform cron.unschedule(j.jobid);
    end loop;
end $$;

-- Restart settlement. Every 10 minutes, matching the original cadence from
-- 20260703000002_cron.sql.
--
-- NOTE: the first run grades a ~10-month backlog (9,961 pending picks). That
-- will move the public /record numbers in one step. Confirm that is intended
-- before applying this migration.
do $$
declare j record;
begin
    for j in select jobid, jobname from cron.job where jobname = 'np-settle' loop
        perform cron.unschedule(j.jobid);
    end loop;
end $$;

select cron.schedule('np-settle', '*/10 * * * *', $$select call_edge_function('settle')$$);
