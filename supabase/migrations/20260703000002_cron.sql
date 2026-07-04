-- Pipeline scheduling: pg_cron + pg_net invoke the edge functions.
--
-- Ref-agnostic: the functions base URL and cron secret are read from
-- app_secrets at call time (seeded once by scripts/provision.sh or the deploy
-- workflow), so this migration contains no project-specific values and never
-- needs string substitution.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Helper: POST to an edge function with the cron secret header. Both the base
-- URL (functions_base_url, e.g. https://<ref>.supabase.co/functions/v1) and
-- the shared secret live in app_secrets. No-op if the base URL isn't set yet.
create or replace function call_edge_function(fn text, payload jsonb default '{}'::jsonb)
returns void language plpgsql security definer as $$
declare base text;
begin
    select value into base from app_secrets where key = 'functions_base_url';
    if base is null then
        raise notice 'functions_base_url not set in app_secrets; skipping %', fn;
        return;
    end if;
    perform net.http_post(
        url := base || '/' || fn,
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
