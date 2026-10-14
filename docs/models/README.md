# Model cards — start here

As of **2026-10-12**. One card per model group, all in the same layout:
status → process → features considered → features used → algorithm →
training → validation → test → live → how we got here → next steps.

| card | predictions |
|---|---|
| [pa_outcome](pa_outcome.md) | P(K, BB, 1B, 2B, 3B, HR, OUT) for one plate appearance — the base every v3 market is derived from |
| [batters](batters.md) | `batter_hit`, `batter_hr`, `batter_tb15`, `batter_hrr`, rest-of-game hit / HR |
| [starters](starters.md) | `pitcher_k`, `pitcher_hits`, `pitcher_outs`, `pitcher_er`, `pitcher_bb` |
| [game](game.md) | `game_moneyline`, `game_total` (pregame and live) |
| [micro](micro.md) | `pitch_result`, `ab_result`, `pitch_speed_ou`, `ab_pitches_ou` |

Model development — proposals, experiment results, decisions, and the state
of the training data — is tracked in **[LAB.md](LAB.md)**.

Read in this order: this page → [`../MODELING-METHODS.md`](../MODELING-METHODS.md)
(the maths) → the cards → [`../MODELS.md`](../MODELS.md) (registry: stage,
activate, roll back) → [`../DATA-PIPELINE.md`](../DATA-PIPELINE.md) (where the
data comes from).

## Where everything stands

**v3 is validated and not in production.** The v3 pipeline ran on 2026-10-08
(git `d94ccc6`) and every result is in `model_runs`, but `stage-v3` /
`activate` were never run: `model_params` holds no `v3_*` row and
`model_ratings` is empty. Production serves the older versions below.

| market | serving today | validated replacement | live record (through 2026-10-12) |
|---|---|---|---|
| `batter_hit` | `v2_20260924` (PA-level logistic) | v3 — beats baseline | predicts 0.647, observed 0.534 (n=395): **1.21× hot** |
| `batter_hr` | `v2_20260924` | v3 — beats baseline | predicts 0.127, observed 0.084 (n=395): **1.52× hot** |
| `batter_tb15`, `batter_hrr` | `base_v1` (league × 30-day rates) | v3 — beats baseline | **0 of 291 graded** per market |
| `pitcher_k`, `_hits`, `_outs`, `_er` | `base_v1` | v3 — beats baseline | **0 of 32 graded** per market |
| `pitcher_bb` | `base_v1` | none yet — v3 lost to a league-mean constant; fix in P-002 | 0 of 32 graded |
| `game_moneyline` pregame | `log5_v1` (formula, hardcoded 0.542 home edge) | v3 — beats baseline | 60.3% correct, log loss 0.655 (n=300) |
| `game_moneyline` live | `mlb_winprob_v1` (MLB's own number) | none | — |
| `game_total` pregame | `total_v1` (formula) | v3 — small edge | picks 46.5%, MAE 3.21 runs (n=284) |
| rest-of-game hit / HR, live total | `base_v1` | derived from v3, **not validated** | not graded |
| `pitch_result`, `ab_result`, `pitch_speed_ou`, `ab_pitches_ou` | `v2_20260809` (cell models) | none yet | see [micro](micro.md) |

Live samples are small and include the postseason; every model is trained on
regular-season games only.

## How every model is validated

| term | meaning here |
|---|---|
| **validation** | walk-forward: each test season is scored by a model fitted only on earlier seasons. Aggregate excludes 2020 (60 games). v3 tests 2018–2025; v2 tests 2016–2025. |
| **test** | the 2026 season, held out of fitting and selection. See the caveat in [pa_outcome](pa_outcome.md#how-we-got-here). |
| **baseline** | the naive predictor a model must beat; named in each results table. |
| **log loss** | mean −ln(probability given to what happened). Lower is better; 0.693 = a coin flip on a 50/50 event. |
| **calibration** | mean predicted ÷ observed rate. 1.00 is correct; 1.20 says "yes" 20% too often. |
| **MAE** | mean absolute error of an expected count. |
| **NLL** | log loss of the full count distribution (exact total runs). |
| **ECE / σ-coverage** | v2 only: binned calibration error; share of actuals within ±1σ (should be 0.68). |

Shipped coefficients are refit on every season including 2026 after the
holdout has scored the recipe.

## Re-measure

```sql
-- latest run per market and pipeline
select distinct on (market, config->>'pipeline')
       market, config->>'pipeline' as pipeline, status, version,
       oos_metrics, holdout_metrics, created_at
from model_runs order by market, config->>'pipeline', created_at desc;

-- what production serves
select market, version, params->>'type' as type, activated_at
from model_params where is_active order by market;

-- live calibration of graded projections
select market, model_version, count(*) n, avg(probability) predicted,
       avg((result = 'hit')::int) observed
from player_game_projections where result in ('hit','miss') group by 1, 2;
```

The same three views are on the dashboard's **Models** page
(`streamlit run app.py` from `dashboard/`; see
[`../../dashboard/README.md`](../../dashboard/README.md)).

## Next steps, in priority order

Per-market detail is at the bottom of each card.

| # | step | why |
|---|---|---|
| 1 | **Activate v3** for every market except `pitcher_bb` (order in [`../MODELS.md`](../MODELS.md#v3-params)). | The served batter models run 1.2–1.5× hot; four starter props and two batter props are on placeholders; the moneyline is a formula. Replacements are validated. |
| 2 | **Fix prop grading.** `batter_tb15`, `batter_hrr` and all five `pitcher_*` markets have zero graded rows since 2026-10-03. Cause not diagnosed. | No live record means no way to confirm v3 after activation. |
| 3 | **Give v3 a promotion gate.** v3 runs are recorded as `completed` and staged by hand; the 2% gate and calibration veto apply to v2 only. | Promotion is currently a judgement call with no recorded rule. |
| 4 | **Benchmark against market prices.** No model is compared with a sportsbook line; every baseline is internal. | Beating the slot rate is necessary, not sufficient. |
| 5 | **Pitch-level features for `pa_outcome`** (velocity, movement, contact quality). | The largest untapped signal, and it lifts every derived market at once. Blocked on the pitch-physics re-ingest (2019–2026 columns were still NULL as of 2026-09-24 — verify). |
| 6 | **Validate what is published but unmeasured:** the per-line ladders, rest-of-game hit / HR, live total. | Only one line per market has a validation number. |
| 7 | **Move the micro markets onto v3 ratings.** | Removes `CALIB_SHRINK`, the folded features and the self-priced speed line. |
