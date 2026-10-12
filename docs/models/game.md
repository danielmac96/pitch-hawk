# Game markets — moneyline and total

**Predicts.** `game_moneyline`: P(home team wins), pregame and live.
`game_total`: distribution of total runs → model-fair line and P(over),
pregame and live.

## Status (2026-10-12)

| market | serving | v3 |
|---|---|---|
| moneyline, pregame | `log5_v1` — log5 on season win%, hardcoded 0.542 home edge. The registry's active `v1_20260707` row is **not read**. | validated, not staged |
| moneyline, live | `mlb_winprob_v1` — MLB's own win probability | none |
| total, pregame | `total_v1` — hand-weighted formula, no registry row | validated, not staged |
| total, live | `base_v1` | derived from v3, not validated |

## Process (v3)

1. **Lineup value.** Each team's nine batters' PA distributions against the
   opposing starter and bullpen, wOBA-weighted over expected trips.
2. **Team runs.** Poisson GLM on that value plus home and weather; NB2
   dispersion by moments.
3. **Moneyline.** P(home outscores away) + 0.52 × P(tie after nine), from the
   two run distributions, then a logistic calibrator.
4. **Total.** Convolution of the two team distributions. No calibrator.
5. **Live total.** Stored pregame team means scaled by outs remaining.

Before lineups post, each team's last scored lineup stands in.

## Features considered

| candidate | outcome |
|---|---|
| Season win% log5 with fixed home edge (production) | Replaced; replayed as a baseline. Walk-forward puts the home edge at 0.536, not 0.542. |
| Normal approximation for the total | Replaced by the exact convolution. |
| Temperature, wind toward centre, roof | Kept (zeroed under a closed roof). |
| Moneyline calibrator | Kept (0.6750 vs 0.6770 uncalibrated). |
| Bullpen fatigue, umpire, travel / rest, starter-specific run prevention beyond `pa_outcome` | Not tried. Bullpen and umpire data are in the warehouse. |
| Market price as a feature or benchmark | Not tried. |

## Features used

| component | features (fitted coefficient) |
|---|---|
| team runs GLM | `log_value` 1.712 · `home` 0.031 · `temp_c` 0.0038 · `wind_out` 0.0027 · intercept −2.735 · NB α = 0.265 |
| moneyline | two NB run pmfs · `extra_home` 0.52 · calibrator a = 0.080, b = 1.417 |
| total | two NB run pmfs |

## Algorithm

Runs are over-dispersed counts, so each team is a negative binomial whose
mean comes from a log-linear GLM. Win probability and totals then follow by
enumeration, so the moneyline, the total and the player props all come from
the same lineup-versus-pitching expectation.

## Training

| | |
|---|---|
| rows | two team-games per regular-season game, ~2,400 games per season |
| fit | `PoissonRegressor(alpha=0, max_iter=500)`; α by method of moments; calibrator `LogisticRegression(C=100)` |
| folds | stacked walk-forward 2018–2025; shipped fit 2016–2026 |

## Validation and test

| | validation 2018–25 | baselines | test 2026 (n=2,407) | baselines |
|---|---|---|---|---|
| moneyline log loss | **0.6750** | production log5 0.7084 · home rate 0.6913 | **0.6821** | 0.7179 · 0.6916 |
| moneyline accuracy | 57.8% | | 55.5% | |
| moneyline calibration | 0.999 | | 1.001 | |
| total P(over 8.5) log loss | **0.6894** | league 0.6936 | **0.6847** | 0.6931 |
| total exact NLL | **2.8686** | league 2.8786 | **2.8607** | 2.8736 |
| total MAE (runs) | 3.55 | | 3.49 | |
| total calibration at 8.5 | 0.964 | | **0.917** | |

The production log5 formula scores worse than always predicting the home
rate.

## Live (served versions, 2026-09-07 → 10-12)

| market | version | n | result |
|---|---|---|---|
| moneyline pregame | log5_v1 | 300 | 60.3% correct at mean confidence 0.578; log loss 0.655 |
| total pregame | total_v1 | 284 | picks 46.5% correct; MAE 3.21 runs; log loss 0.695 |

300 games is too few to rank log5_v1 against v3; the 2,407-game replay above
is the comparison to trust.

## How we got here

* **2026-07-07:** `game_moneyline` fitted as log5 + home edge. The edge
  function never read the row; production used the function default.
* **2026-08-09:** refit measured the home edge at 0.536. Still inert.
* **`game_total`:** always a formula in `model.ts`, never registered.
* **2026-10-08, v3:** both rebuilt from team run distributions.

## Next steps

| market | step |
|---|---|
| both | Activate v3 (`team_runs`, then the two markets). |
| both | Benchmark against closing lines — the `odds` table holds game prices. This is the only baseline that matters for a game market. |
| moneyline | Calibrator slope 1.42 means the structural probabilities are far too compressed. Find the missing spread (bullpen quality, lineup-value mapping, starter depth) rather than leaving it to the calibrator. |
| moneyline, live | Build an in-house live model from the run distributions and remaining outs; `mlb_winprob_v1` is an external number we cannot validate or improve. |
| total | Under-predicts overs in 2026 (0.917). Shorten the league-level memory or add a season-to-date scoring term. |
| total | Add bullpen fatigue and umpire. Edge over the league baseline is 0.004 log loss; expect small gains. |
| total, live | Validate; the outs-remaining scaling has no measurement. |
