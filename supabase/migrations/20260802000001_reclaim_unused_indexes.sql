-- Emergency capacity reclaim.
--
-- The database measured 497 MB of the 500 MB free-tier cap on 2026-08-02,
-- growing ~4-5 MB/day. At that headroom the next few days of live-poll writes
-- reach the cap, and the hot-window swap in a later migration cannot run at
-- this baseline: its peak would exceed it.
--
-- DROP INDEX returns space to the filesystem immediately, unlike DELETE, whose
-- dead tuples are reusable by the table but do not shrink pg_database_size.
-- No row of data is removed by this migration.
--
-- Scan counts below are from pg_stat_user_indexes, measured 2026-08-02.

-- Never wait behind np-live-poll, which upserts `pitches` every 30 seconds.
-- DROP INDEX needs ACCESS EXCLUSIVE on the parent table; without a timeout a
-- blocked drop queues behind an in-flight upsert and every subsequent write
-- queues behind the drop. Failing fast and re-running is the safe trade.
set local lock_timeout = '5s';

-- 37 MB, 69 scans since the last stats reset. The only reader of pitch_ts is
-- the hot-window filter, which runs once during the swap and seq-scans
-- acceptably over a 168 MB heap. Recreate it on the post-swap table if a
-- time-ranged query path appears -- it will be ~4 MB there.
drop index if exists public.pitches_ts_idx;

-- 3.0 MB / 2 scans and 2.8 MB / 4 scans. Effectively unused.
drop index if exists public.at_bats_pitcher_idx;
drop index if exists public.at_bats_batter_idx;

-- Deliberately NOT dropped, recorded here so the decision is not re-litigated:
--   pitches_game_pk_at_bat_index_pitch_number_key  49 MB, 10,227,811 scans
--                                                  -- the live upsert path
--   at_bats_game_pk_at_bat_index_key               16 MB,  2,612,280 scans
--   pitches_batter_idx                             11 MB,      2,603 scans
--                                                  -- the swap shrinks this to
--                                                  -- ~1 MB for free
