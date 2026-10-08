# Batter props — hit, home run, total bases 1.5+, H+R+RBI 1+

**Question.** For a posted starter: P(≥1 hit), P(≥1 HR), P(TB ≥ 2),
P(H+R+RBI ≥ 1) in this game.

**Labels.** `player_box` (official boxscore lines): h, hr, tb, r, rbi; rows
with zero PA are void (not misses), as in grading.

**Structure.** Per-trip PA distributions from `pa_outcome`, mixing starter
(by time through the order) and bullpen by P(starter still in), over the
empirical PA-count distribution for the lineup slot and home/away
(`MODELING-METHODS.md` §5). Then a calibrator where it helps OOS: kept for
`batter_hit` and `batter_hrr` (with expected times on base, top-of-order and
lineup offence as extra inputs); identity for `batter_hr` and `batter_tb15`.

**Served by.** `game-predict` → `player_game_projections` (`model_version
v3_*`), only for posted lineups. Rest-of-game (live) uses the published
per-PA hit/HR rates over the remaining-PA expectation.

## Results (log loss; baseline = the training seasons' rate for that lineup slot)

| market | OOS v3 | OOS baseline | 2026 v3 | 2026 baseline | 2026 calibration |
|---|---|---|---|---|---|
| batter_hit | **0.6555** | 0.6609 | **0.6623** | 0.6667 | 0.990 |
| batter_hr | **0.3537** | 0.3601 | **0.3491** | 0.3550 | 0.972 |
| batter_tb15 | **0.6428** | 0.6467 | **0.6399** | 0.6436 | 0.994 |
| batter_hrr | **0.6165** | 0.6216 | **0.6217** | 0.6255 | 0.985 |

For comparison, the v2 `batter_hit` / `batter_hr` served 0.648 / 0.127
against observed 0.520 / 0.093 on the live record (1.25× / 1.37× hot).

## Known limits
* PAs independent given the matchup; the calibrator absorbs the average gap.
* Pinch-hit and defensive substitutions after the posted lineup are not
  modelled (a scratch is void, not a miss).
