-- Drop five functions that nothing calls.
--
-- Each was verified unreferenced across every edge function, Python module,
-- workflow, script and doc in the repo before being listed here. `drop function
-- if exists` with the exact signature, so this is idempotent and safe to
-- re-apply -- which `supabase db push --include-all` will do.
--
-- Two groups, for two different reasons.
--
-- 1. Orphaned when backend/ was removed (2026-08). get_pitcher_stats and
--    get_pitcher_ab_stats existed to feed backend/models/stats_cache.py, the
--    FastAPI mirror's rolling-stat cache. Production never called them: the
--    live scorer reads pitcher_rolling_stats / batter_rolling_stats directly
--    (supabase/functions/_shared/model.ts), which daily-ingest refreshes
--    through refresh_pitcher_rolling_stats / refresh_batter_rolling_stats.
--    Those two refreshers stay -- they are live.
--
-- 2. Never had a caller at all.
--    * get_league_averages: 20260802000002 records the belief that
--      stats_cache.py called it. It did not -- that module used hardcoded
--      LEAGUE_* constants. The edge scorer likewise carries its own LEAGUE
--      table in model.ts.
--    * train_home_advantage: survived the 20260802000002 training-RPC cull on
--      the grounds that it "reads only `games`", which is true and beside the
--      point -- nothing ever invoked it. The number it computes now comes from
--      the offline workbench (`python -m modeling train game_moneyline`),
--      which measures it against a walk-forward instead.
--    * prediction_pitch_coverage(date): a near-name collision with the
--      function the API actually serves. api/index.ts calls
--      prediction_coverage_pitch() (20260814000001); this one was added a day
--      later in 20260815000001 and wired to nothing.

drop function if exists get_pitcher_stats();
drop function if exists get_pitcher_ab_stats();
drop function if exists get_league_averages();
drop function if exists train_home_advantage();
drop function if exists prediction_pitch_coverage(date);
