-- Re-grade the base-model player props.
--
-- The `settle` deployed on 2026-10-01 20:14 ET predates the commit that taught
-- it the base markets (0c6386c, 21:04 ET), and was never redeployed. It routed
-- every projection row through gradeProjection(), which only knows hits and
-- home runs, so:
--
--   batter_tb15, batter_hrr   graded as "at least one HIT" -- the 86/94
--                             hit/miss split is identical to batter_hit's,
--                             and actual_count holds hits, not total bases
--   pitcher_*                 graded as a BATTER: a starter has no plate
--                             appearances, so every row is 'void'
--
-- Every one of those results is wrong, so all of them are cleared and the
-- redeployed settle (which reads the official boxscore, _shared/boxscore.ts)
-- grades them again on its next pass. batter_hit / batter_hr were graded
-- correctly and are left alone.
--
-- Apply AFTER redeploying settle. Applied before, the stale settle would
-- simply mis-grade the rows again.

update player_game_projections
   set result = null,
       actual_count = null,
       plate_appearances = null,
       graded_at = null
 where market in ('batter_tb15', 'batter_hrr',
                  'pitcher_k', 'pitcher_bb', 'pitcher_hits',
                  'pitcher_outs', 'pitcher_er')
   and result is not null;
