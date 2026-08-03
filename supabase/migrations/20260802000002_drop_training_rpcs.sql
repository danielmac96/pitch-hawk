-- Phase 3, Task 3.1 — remove the RPCs that read all of pitches/at_bats.
--
-- The hot-window swap in 20260802000003 cuts both tables to 35 days. Every
-- function below reads them with NO time filter, so after the swap each would
-- keep working, keep returning a result, and quietly mean something entirely
-- different. That invisibility is the whole reason they go in the same change
-- rather than "later": a dropped function is a loud error at the call site, a
-- silently narrowed one is a quietly worse model and a corrupted table.

-- ── the four training cell RPCs ──────────────────────────────────────────
-- Read every row of pitches/at_bats to build weighted aggregate cells.
-- scripts/train_models.py is their only caller; it is being made to fail
-- loudly rather than train on 35 days, and train-models.yml's weekly
-- schedule is disabled in the same commit. The model layer is deferred
-- (see docs/plans/data-pipeline-2026-08-02.md, "Deferred"), so these are
-- rebuilt against DuckDB over R2 when that work resumes, not restored here.
drop function if exists train_pitch_result_cells();
drop function if exists train_ab_result_cells();
drop function if exists train_pitch_speed_cells();
drop function if exists train_ab_pitches_cells();

-- train_home_advantage reads only `games`, which the swap does not touch.
-- It stays.

-- ── refresh_matchup_history ──────────────────────────────────────────────
-- NOT in the plan as written. Found on 2026-08-02 while auditing what else
-- reads these tables unwindowed, and it is the most dangerous item here —
-- the only one that WRITES its misreading to disk.
--
--   insert into matchup_history ... select ... from at_bats
--   where pitcher_id is not null and batter_id is not null
--   group by pitcher_id, batter_id having count(*) >= 3
--   on conflict (pitcher_id, batter_id) do update set pa_count = excluded...
--
-- No time filter, and an upsert that OVERWRITES. Post-swap it would recompute
-- career head-to-head counts from 35 days and overwrite the stored career
-- numbers for every pair that happened to meet inside the window. The rows it
-- does not touch keep correct career values, so the table ends up a silent
-- mix of career and 35-day figures with nothing to distinguish them.
--
-- It is called by supabase/functions/daily-ingest/index.ts every day at
-- 13:00 UTC via np-daily-ingest, so this would have fired within hours of the
-- swap. The call is removed from daily-ingest in the same commit; that
-- function must be redeployed with this migration, not after it.
--
-- matchup_history keeps its existing rows, frozen and correct, until Phase 4
-- Task 4.2 rebuilds it from the warehouse as matchup_history v2 (3 seasons,
-- >= 3 PA) — which is already the plan of record for that table.
drop function if exists refresh_matchup_history();

-- ── deliberately NOT dropped ─────────────────────────────────────────────
-- get_pitcher_stats, get_pitcher_ab_stats and get_league_averages also read
-- the full tables unwindowed, and post-swap will return 35-day figures. They
-- are left in place because they are read-only — they persist nothing, so
-- there is no corruption to prevent — and their only caller is
-- backend/models/stats_cache.py, part of the deferred model layer. They are
-- recorded here so the narrowing is a known, written-down consequence of the
-- swap rather than something rediscovered later.
