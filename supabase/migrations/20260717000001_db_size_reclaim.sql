-- Reclaim database size (free plan 0.5GB cap). Applied to prod 2026-07-17 as
-- remote version 20260717214246; this file keeps the repo mirror in sync.
-- 1) Exact-duplicate indexes: the unique constraints already index the same
--    columns, so these secondary indexes are pure overhead (~61 MB).
drop index if exists public.pitches_game_pa_pitch_idx;   -- = pitches_game_pk_at_bat_index_pitch_number_key
drop index if exists public.at_bats_game_pa_idx;         -- = at_bats_game_pk_at_bat_index_key
-- 2) Never-scanned index (advisor lint 0005); recreate later if a pitcher-keyed
--    query path appears: create index pitches_pitcher_idx on pitches(pitcher_id);
drop index if exists public.pitches_pitcher_idx;         -- ~11 MB, 0 scans

-- 3) pg_cron keeps every run forever in cron.job_run_details; with live-poll
--    firing every 30s that is ~5k rows/day. Keep a week.
create or replace function prune_cron_history(keep_days int default 7)
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare n bigint;
begin
  delete from cron.job_run_details
  where end_time < now() - make_interval(days => keep_days);
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function prune_cron_history(int) from anon, authenticated, public;

-- Daily, right after the 13:00 daily-ingest.
select cron.schedule('np-prune-cron-history', '15 13 * * *', $$select prune_cron_history(7)$$);
