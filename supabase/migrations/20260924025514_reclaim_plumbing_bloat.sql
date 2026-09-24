-- Reclaim the plumbing bloat, and keep it from coming back.
--
-- Measured 2026-09-23, with the database at 640 MB against a 500 MB cap:
--
--   schema   size     what it actually was
--   public   455 MB   the application
--   net      150 MB   pg_net's response cache -- 151 live rows
--   cron      23 MB   job_run_details, 40,539 rows
--
-- 173 MB, 27% of the database, was plumbing. Two independent causes:
--
-- 1. net._http_response. Every cron job reaches its edge function through
--    net.http_post, and pg_net stores the response body for net.ttl (6 hours)
--    so that net.http_collect_response can read it back. Nothing in this
--    project ever calls http_collect_response -- grep the migrations: the only
--    net.* reference anywhere is the http_post itself. So every response body
--    since the project was created has been written, TOASTed, and thrown away
--    unread. The TTL delete runs correctly (the table held exactly the last
--    six hours) but DELETE frees no measured space, and autovacuum will not
--    compact the TOAST relation -- the same reason the hot-window swap exists.
--
--    TRUNCATE does reclaim, and is safe here specifically because the table is
--    UNLOGGED (relpersistence='u' -- pg_net's own design; its contents do not
--    survive a restart either) and because nothing reads it. A response that
--    lands mid-truncate is lost, which for fire-and-forget http_post is what
--    would have happened six hours later anyway.
--
-- 2. cron.job_run_details. np-live-poll runs every 15 seconds, so it alone
--    writes 5,760 rows/day -- 5,790 of every 5,790 rows, to two significant
--    figures. Seven days of that buried the handful of rows that actually get
--    read when the nightly breaks. Keeping live-poll for one day and
--    everything else for seven cut 40,539 rows to 6,109 with no loss of
--    diagnostic value.
--
-- Index bloat was reclaimed separately with REINDEX INDEX CONCURRENTLY and is
-- NOT automated here -- REINDEX cannot run inside a function's transaction
-- block. It is a manual step; see the runbook note at the bottom.
--
--   step                                    after
--   truncate net._http_response             491 MB
--   prune + VACUUM FULL job_run_details     470 MB
--   reindex predictions (6 indexes)         400 MB
--   reindex pitches, picks, ppd             363 MB

-- ── 1. pg_net response cache ────────────────────────────────────────────────

create or replace function prune_net_responses()
returns void language plpgsql security definer set search_path = net, pg_temp as $$
begin
  -- TRUNCATE, not DELETE: DELETE is what let this reach 150 MB. Unconditional
  -- because nothing collects these responses; see the header.
  truncate net._http_response;
end $$;

revoke execute on function prune_net_responses() from anon, authenticated, public;

comment on function prune_net_responses() is
  'Truncates pg_net''s unread response cache. Safe only while nothing calls '
  'net.http_collect_response -- check that before relying on it.';

-- 03:40 UTC: after the 13:00 daily-ingest is long done and before the
-- warehouse nightly at 08:00/09:00 UTC, so a truncate never lands mid-run.
select cron.schedule('np-prune-net-responses', '40 3 * * *',
                     $$select prune_net_responses()$$);

-- ── 2. cron history ─────────────────────────────────────────────────────────

-- The one-argument form must go first. `create or replace` on a different
-- signature creates a SECOND function rather than replacing this one, and
-- because poll_days carries a default, a bare prune_cron_history(7) would then
-- match both and fail with "function is not unique".
drop function if exists prune_cron_history(int);

-- keep_days still governs the jobs worth reading. poll_days governs the
-- 15-second heartbeat, which is only ever useful for "was it running at all".
create or replace function prune_cron_history(keep_days int default 7,
                                              poll_days int default 1)
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
-- Two counters, because GET DIAGNOSTICS assigns a variable from a diagnostic
-- item and takes no expression -- `get diagnostics n = n + row_count` is a
-- syntax error, not a running total.
declare aged bigint; polled bigint;
begin
  delete from cron.job_run_details
  where end_time < now() - make_interval(days => keep_days);
  get diagnostics aged = row_count;

  -- Matched by name, not by the jobid that happened to be 13 in September --
  -- rescheduling a job gives it a new one.
  delete from cron.job_run_details d
  using cron.job j
  where j.jobid = d.jobid
    and j.jobname = 'np-live-poll'
    and d.end_time < now() - make_interval(days => poll_days);
  get diagnostics polled = row_count;

  return aged + polled;
end $$;

revoke execute on function prune_cron_history(int, int) from anon, authenticated, public;

-- Re-point the existing schedule at the two-argument form. cron.schedule on an
-- existing jobname updates it in place rather than creating a second job.
select cron.schedule('np-prune-cron-history', '15 13 * * *',
                     $$select prune_cron_history(7, 1)$$);

-- ── manual follow-up, not automated ─────────────────────────────────────────
--
-- Btree bloat returns with the prune-and-refill cycle: predictions' six
-- indexes were 114 MB against 109 MB of heap for 347k rows, and rebuilt to
-- 36 MB. predictions_backfilled_idx was 1600 kB and rebuilt to 8192 bytes.
-- Roughly quarterly, or whenever the database creeps past ~450 MB, run:
--
--   reindex index concurrently public.predictions_game_market_id_idx;
--   reindex table concurrently public.predictions;
--   reindex table concurrently public.pitches;
--   reindex table concurrently public.picks;
--   reindex table concurrently public.player_prediction_daily;
--
-- CONCURRENTLY matters: a plain REINDEX takes ACCESS EXCLUSIVE and would block
-- np-live-poll's writes. Run them one at a time -- each needs transient space
-- equal to the index being rebuilt -- and afterwards confirm the rebuild did
-- not half-fail:
--
--   select count(*) from pg_index where not indisvalid;   -- must be 0
--
-- A non-zero count means an abandoned *_ccnew index is still on disk; drop it
-- and rerun that one.
