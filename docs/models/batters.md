# Batter props — hit, home run, total bases, H+R+RBI

**Predicts.** For each batter in a posted lineup, this game:
`batter_hit` P(≥1 hit) · `batter_hr` P(≥1 HR) · `batter_tb15` P(total bases
≥ 2) · `batter_hrr` P(hits + runs + RBI ≥ 1). Live: rest-of-game P(hit),
P(HR).

## Status (2026-10-12)

| market | serving | v3 |
|---|---|---|
| `batter_hit`, `batter_hr` | `v2_20260924` — running 1.21× and 1.52× hot | validated, not staged |
| `batter_tb15`, `batter_hrr` | `base_v1` placeholder — ungraded | validated, not staged |
| rest-of-game hit / HR | `base_v1` | derived from v3, not validated |

## Process (v3)

1. Per trip to the plate, a PA distribution from [`pa_outcome`](pa_outcome.md):
   `q·p(vs starter, time through order) + (1−q)·p(vs bullpen)`, where
   `q` = P(starter still pitching) from the workload model.
2. Number of PAs N ~ empirical distribution by lineup slot and home/away.
3. Roll up in closed form: P(≥1 hit) = Σₖ P(N=k)·(1 − Π(1−hᵢ)); HR the same;
   total bases by dynamic programme capped at 2.
4. Pass through a per-market logistic calibrator **only if it improves
   validation log loss**; otherwise ship the structural probability.

## Features considered

| candidate | outcome |
|---|---|
| Constant expected PA by slot (v2 / base) | Replaced by the full PA-count distribution. |
| One opposing-pitcher rate for the whole game | Replaced by the starter / bullpen mix per trip. |
| Calibrator for every market | Kept for `batter_hit` and `batter_hrr`; dropped for `batter_hr` and `batter_tb15` (it scored worse than the raw probability out of sample). |
| H+R+RBI extras: expected times on base, top-5 slot, lineup offensive value | Kept for `batter_hrr` only. |
| Contact quality (hard-hit, pulled-air, exit velocity) | Not used: computed in the warehouse, no serving source. |
| Pinch-hit / substitution risk, weather per batter | Not tried. |

## Features used

| market | structural input | calibrator |
|---|---|---|
| `batter_hit` | P(≥1 hit) | a = −0.037, b = 0.984 |
| `batter_hr` | P(≥1 HR) | none |
| `batter_tb15` | P(TB ≥ 2) | none |
| `batter_hrr` | P(≥1 hit) | a = −0.085, b = 0.855, `e_onbase` +0.356, `top_order` −0.024, `log_team_value` −0.015 |

Upstream inputs are the 33 `pa_outcome` features, lineup slot, home/away and
the starter workload distribution.

## Algorithm

Closed-form probability roll-up of a per-PA multinomial, then
`sigmoid(a + b·logit p + Σ wⱼxⱼ)`. No market-specific model is fitted beyond
the 2–5 calibrator parameters, so the four markets cannot disagree with each
other or with the starter and game markets.

## Training

| | |
|---|---|
| labels | `player_box` official lines (h, hr, tb, r, rbi); zero-PA rows are void |
| rows | posted starters only, ~44k batter-games per season |
| calibrator | `LogisticRegression(C=100)`, fitted on seasons before the test season, on structural probabilities from PA-model folds that never saw those games (stacked walk-forward) |
| shipped fit | 2016–2026 |

## Validation and test

Log loss. Baseline = training-seasons' rate for that lineup slot. Numbers are
for the shipped variant (calibrated or not, as above).

| market | validation 2018–25 | baseline | test 2026 (n=43,903) | baseline | 2026 calibration |
|---|---|---|---|---|---|
| `batter_hit` | **0.6555** | 0.6609 | **0.6623** | 0.6667 | 0.990 |
| `batter_hr` | **0.3536** | 0.3601 | **0.3492** | 0.3550 | 0.957 |
| `batter_tb15` | **0.6428** | 0.6467 | **0.6400** | 0.6436 | 0.998 |
| `batter_hrr` | **0.6165** | 0.6216 | **0.6217** | 0.6255 | 0.985 |

`batter_hrr` without its calibrator loses to the baseline (0.6226 vs 0.6216,
calibration 0.92): P(≥1 hit) alone is not a model of runs and RBIs.

## Live (served versions, 2026-09-24 → 10-12)

| market | version | n | predicted | observed | log loss | constant-rate log loss |
|---|---|---|---|---|---|---|
| `batter_hit` | v2_20260924 | 395 | 0.647 | 0.534 | 0.716 | 0.691 |
| `batter_hr` | v2_20260924 | 395 | 0.127 | 0.084 | 0.294 | 0.287 |
| `batter_tb15`, `batter_hrr` | base_v1 | 0 graded of 291 | — | — | — | — |

Both served v2 models are worse than predicting the observed rate for
everyone.

## How we got here

* **2026-09-24, v2:** per-PA binary logistic on batter rate, pitcher rate and
  platoon (career window), promoted with per-PA calibration 1.01 (hit) and
  1.04 (HR) on the holdout. Served from 30-day rates, so it needed shrinkage
  constants (`HIT_K=50`, `HR_K=150`) and still runs hot at game level.
* **2026-10-02, base_v1:** `tb15` and `hrr` added as league × 30-day-rate
  placeholders so the board had a number.
* **2026-10-08, v3:** all four rebuilt on `pa_outcome`; one rating function
  for training and serving, no patch constants.
* **2026-10-10:** `game-predict` publishes a ladder (every line of each count
  distribution). Only the lines above have validation numbers.

## Next steps

| market | step |
|---|---|
| all | Activate v3. Then track live calibration against a 0.90–1.10 band once n ≥ 1,000 per market. |
| `batter_tb15`, `batter_hrr` | Fix grading — zero graded rows since 2026-10-03. |
| `batter_hr` | Under-predicts in 2026 (0.957). Add temperature and wind (already in the team-runs model) and a contact-quality rating. |
| `batter_hrr` | Replace the P(hit) proxy with structural runs and RBIs (on-base × teammates' advancement); the calibrator currently does the modelling. |
| `batter_hit` | Model lineup exits (pinch hitters, blowouts) in the PA-count distribution; it is the only input not conditioned on the game. |
| ladders | Validate every published line (hits 1.5, TB 2.5, H+R+RBI 1.5 / 2.5), not just one per market. |
| rest-of-game | Build a validation set from in-game states; none exists. |
| all | Compare with sportsbook prop prices once prop odds are ingested (deferred by product decision). |
