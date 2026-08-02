-- Drop four tables that were created but never populated (all confirmed 0 rows
-- on 2026-07-28) plus the dead pitches.raw_json column.
--
-- SPACE IMPACT: ~0 bytes. Empty tables occupy 0-8 KB each, and raw_json is
-- 100% NULL so it costs only a null-bitmap bit per row. This migration is
-- schema hygiene, not capacity relief — the actual growth control lives in
-- 20260728000002_retention_predictions.sql.
--
-- Why each is safe to drop:
--   bet_clicks       — affiliate click funnel; no affiliate deals exist, and
--                      the POST /track/click route is removed alongside this.
--   game_context     — weather/venue/umpire; only the FastAPI dev predictor
--                      ever read it, and its ingestion never ran in production.
--   pitcher_game_log — per-game pitch count / velocity / days rest. Same story.
--                      NOTE: this is the natural backing table for the Data
--                      Feed's "pitcher speed trends"; when that ships it should
--                      return as a rollup derived from `pitches`, not as a
--                      separately ingested table.
--   umpire_stats     — umpire zone rates; never populated, and the predictor
--                      branch that read it always fell through to the default.
--
-- Reversible: these are empty, so recovery is re-running the matching
-- `create table` statements from 20260703000001_core_schema.sql.

drop table if exists bet_clicks;
drop table if exists game_context;
drop table if exists pitcher_game_log;
drop table if exists umpire_stats;

-- Never written by the production ingest path (_shared/ingest.ts →
-- flattenPitch builds no raw_json key); only the retired FastAPI backfill in
-- backend/ingestion/mlb_api.py ever set it, and it never ran against prod.
alter table pitches drop column if exists raw_json;
