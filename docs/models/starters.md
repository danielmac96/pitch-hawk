# Starter props — strikeouts, hits allowed, outs recorded, earned runs, walks

**Question.** For the probable starter: a model-fair line (the median
half-point) and P(over) for K, hits allowed, outs recorded, earned runs and
walks.

**Labels.** `player_box` pitching lines (official K, H, BB, outs, ER).

**Structure.** Workload (outs and batters faced) from a linear location
model on the pitcher's decayed outs and pitches per start, his team's starter
leash, rest days, first start of the season and out-getting quality, plus an
empirical residual pmf. Count distributions from the lineup-averaged PA
distribution (`derive.starter_counts`); earned runs from a Poisson GLM on
expected outs and run value per out with negative-binomial dispersion.
Calibrators kept for `pitcher_er` (and `pitcher_bb`); identity elsewhere.

**How to read the numbers.** With the line at the model's own median,
P(over) sits near 50% by construction, so its log loss stays near ln 2
whatever the skill. The honest measure is how close the **expected count** is
to what happened (MAE), against the pitcher's own decayed average.

## Results (MAE of the expected count; baseline = training-season mean)

| market | OOS v3 | OOS baseline | 2026 v3 | 2026 baseline |
|---|---|---|---|---|
| pitcher_k | **1.83** | 2.05 | **1.80** | 2.02 |
| pitcher_hits | **1.76** | 1.84 | **1.75** | 1.85 |
| pitcher_outs | **3.12** | 3.40 | **3.06** | 3.37 |
| pitcher_er | **1.58** | 1.63 | **1.56** | 1.64 |
| pitcher_bb | 1.063 | 1.056 | 1.03 | 1.05 |

**pitcher_bb is not staged** (`stage-v3` leaves it out): no better than the
pitcher's own average OOS and 2026 holdout calibration 0.90. It stays on
`base_v1` until a run shows it winning.

## Known limits
* Pitch counts within a game (fatigue, a short leash after traffic) are not
  conditioned on; the residual pmf carries the average.
* Opener / bulk-reliever games read as a short start.
