-- Pipeline scheduling: pg_cron + pg_net invoke the edge functions.
--
-- {{PROJECT_REF}} is substituted with the real project ref at apply time
-- (see scripts/provision_supabase.md). The cron secret is generated once and
-- stored in app_secrets('cron_secret') — also at apply time, never committed.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Helper: POST to an edge function with the cron secret header.
create or replace function call_edge_function(fn text, payload jsonb default '{}'::jsonb)
returns void language plpgsql security definer as $$
begin
    perform net.http_post(
        url := 'https://{{PROJECT_REF}}.supabase.co/functions/v1/' || fn,
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'x-cron-secret', (select value from app_secrets where key = 'cron_secret')
        ),
        body := payload,
        timeout_milliseconds := 55000
    );
end $$;

-- Re-schedule idempotently.
do $$
declare j record;
begin
    for j in select jobid, jobname from cron.job
        where jobname in ('np-live-poll','np-odds-ingest','np-settle','np-daily-ingest','np-backfill')
    loop
        perform cron.unschedule(j.jobid);
    end loop;
end $$;

-- Live poller: every 30 seconds (fast no-op when no games are in progress).
select cron.schedule('np-live-poll', '30 seconds', $$select call_edge_function('live-poll')$$);

-- Odds snapshots + pregame picks: every 5 minutes.
select cron.schedule('np-odds-ingest', '*/5 * * * *', $$select call_edge_function('odds-ingest')$$);

-- Settlement: every 10 minutes.
select cron.schedule('np-settle', '*/10 * * * *', $$select call_edge_function('settle')$$);

-- Daily full refresh at 10:00 UTC (after the last West Coast games end).
select cron.schedule('np-daily-ingest', '0 10 * * *', $$select call_edge_function('daily-ingest')$$);

-- Backfill driver: every minute while backfill_progress.done is false.
select cron.schedule('np-backfill', '* * * * *', $$
do $body$
begin
    if exists (select 1 from backfill_progress where id = 1 and not done) then
        perform call_edge_function('backfill');
    end if;
end $body$
$$);
