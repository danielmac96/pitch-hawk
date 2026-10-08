# pa_outcome — the plate-appearance outcome model

**Question.** For one plate appearance between this batter and this pitcher
in this park: P(K, BB+HBP, 1B, 2B, 3B, HR, OUT)?

**Label.** `at_bats.result_detail` mapped to 7 classes
(`modeling/ratings.py::EVENT_CLASS`); non-PA endings (caught stealing,
pickoffs, catcher interference …) are excluded.

**Features** (33, `pa_model.pa_features`): per class, batter and pitcher
rating log-odds relative to the league; park log factor; six log5 matchup
logits; same hand, left-handed pitcher, batting at home, reliever, 2nd / 3rd+
time through the order. Ratings are as-of the game day, exclusive, from
`ratings.py`.

**Family.** Multinomial logistic regression (OUT reference), fitted on
2016+ (2015 is ratings burn-in).

**Served by.** `_shared/props.ts::paDist` from `model_ratings` (nightly
`publish-ratings`) — identical arithmetic to training, pinned at 1e-9.

## Results

| | log loss | vs log5 | vs league-only |
|---|---|---|---|
| OOS 2018–2025 | **1.4359** | 1.4383 | 1.4616 |
| 2026 holdout | **1.4315** | — | 1.4559 |

Per-PA calibration (mean predicted / observed), OOS: hit 1.013, HR 0.981,
K 0.963, BB 1.012. 2026 holdout: hit 1.001, K 1.000, HR 0.961, BB 0.948.

## History
* First run used seven raw league-logit features; they fitted season effects
  (coefficients ±13, HR holdout calibration 0.93). Replaced by log5 logits,
  which carry the league level inside a fixed structure.

## Known limits
* Walks run ~5% low in 2026; watch it as the season's sample grows.
* No pitch-level information (velocity, movement, contact quality) yet —
  the obvious next features, and the warehouse already stores them.
