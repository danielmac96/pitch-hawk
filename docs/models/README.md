# Model cards

One card per model or market group: what it answers, what it is trained on,
how it is served, how it scored out of sample, and what it gets wrong. The
method behind all of them is in [`../MODELING-METHODS.md`](../MODELING-METHODS.md);
registry mechanics in [`../MODELS.md`](../MODELS.md).

| card | markets | status (2026-10-08 run) |
|---|---|---|
| [pa_outcome](pa_outcome.md) | the plate-appearance model every other card stacks on | ready |
| [batters](batters.md) | batter_hit, batter_hr, batter_tb15, batter_hrr, rest-of-game hit/HR | ready |
| [starters](starters.md) | pitcher_k, pitcher_hits, pitcher_outs, pitcher_er, pitcher_bb | ready except **pitcher_bb** (stays on base_v1) |
| [game](game.md) | game_moneyline (pregame), game_total (pregame + live) | ready |
| [micro](micro.md) | pitch_result, ab_result, pitch_speed_ou, ab_pitches_ou | unchanged v2 cell models |

**Where the numbers come from.** Every figure is from `model_runs` rows with
`config.pipeline = 'markets_v3'` recorded on 2026-10-08 (model-lab run #6).
Out-of-sample (OOS) = walk-forward seasons 2018–2025, each scored by models
fitted only on earlier seasons, 2020 excluded from the average; holdout =
the 2026 season, never used to fit or choose anything. Re-measure with:

```sql
select market, oos_metrics, holdout_metrics, created_at
from model_runs where config->>'pipeline' = 'markets_v3'
order by created_at desc;
```
