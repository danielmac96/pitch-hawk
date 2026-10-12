# pa_outcome — the plate-appearance outcome model

**Predicts.** For one plate appearance: P(K, BB+HBP, 1B, 2B, 3B, HR, OUT)
given batter, pitcher, park and context. Not shown to users; every v3 batter,
starter and game market is a roll-up of it.

## Status (2026-10-12)

Validated 2026-10-08, **not staged, not served**. `model_ratings` (its
serving input) is empty. Nothing downstream can go live before this does.

## Process

1. Label each regular-season PA from `at_bats.result_detail`
   (`ratings.py::EVENT_CLASS`); non-PA endings (pickoff, caught stealing,
   catcher interference) are dropped.
2. Compute as-of ratings per batter, pitcher, team bullpen and park —
   exponentially decayed outcome rates shrunk to the league rate, using only
   days before the game.
3. Fit one multinomial logistic regression on those ratings plus context.
4. Publish current ratings nightly to `model_ratings`; `_shared/props.ts`
   scores a PA with the same arithmetic (parity pinned at 1e-9).

## Features considered

| candidate | outcome |
|---|---|
| Raw league logit per class (7) | **Rejected.** One value per season, so it fitted season effects: coefficients ±13, optimiser at its iteration cap, HR calibration 0.99–1.06 across folds. |
| log5 matchup logit per class (6) | **Kept** in its place — carries the league level inside a fixed structure. |
| Rating decay τ ∈ {180, 365, 540, 730, 1095} days | Tuned by next-PA log loss on 2017–2025: **540** for batters, pitchers and bullpens. |
| Rating shrinkage k ∈ {25 … 3200} PA, per class | Tuned per class (below). |
| Park shrinkage k ∈ {200, 800, 3200, 12800} | **200**; park τ fixed at 1095. |
| Pitch-level inputs (velocity, movement, exit velocity, launch angle) | **Not tried.** In the warehouse; no serving path yet. |
| Count, base-out state, score | **Not tried.** |

## Features used (33)

| group | n | definition |
|---|---|---|
| `bat_c` | 7 | logit(batter rating) − logit(league), per class |
| `pit_c` | 7 | same for the pitcher (bullpen rating for pooled relief) |
| `park_c` | 7 | log park factor: observed ÷ log5-expected outcomes at the venue |
| `l5_c` | 6 | log(p5_c / p5_OUT), p5 = log5(batter, pitcher, league) |
| context | 6 | `same_hand`, `pit_left`, `bat_home`, `reliever`, `tto2`, `tto3` |

Fitted shrinkage k (PA), class order K, BB, 1B, 2B, 3B, HR, OUT:

| subject | k |
|---|---|
| batter | 25, 50, 100, 800, 400, 100, 50 |
| pitcher | 50, 100, 400, 800, 3200, 400, 100 |
| bullpen | 200, 400, 1600, 3200, 12800, 1600, 400 |

Small k = the rate is the player's own quickly (strikeouts); large k = mostly
league (triples, a pitcher's doubles).

## Algorithm

Multinomial logistic regression, OUT as reference. With coefficient 1 on
`l5_c` and 0 elsewhere it is exactly the log5 odds-ratio formula; the other
terms let the data correct log5 where it is wrong. Chosen because it is
linear in log-odds (so the TypeScript scorer is a dot product and a softmax),
calibrated by construction, and transparent against the log5 baseline.

## Training

| | |
|---|---|
| data | regular-season PAs 2016–2026 (2015 is ratings burn-in), ~2.3M rows, from R2 `at_bats` ⋈ `games` ⋈ `player_box` |
| fit | scikit-learn `LogisticRegression`, L2 with `C=1.0` (not swept), lbfgs, `max_iter=3000`, features standardised then mapped back to raw-scale coefficients |
| folds | expanding window: train 2016…S−1, test S, S = 2018…2025 |
| shipped fit | all of 2016–2026 |
| run | `python -m modeling markets --record` (via `model-lab.yml`) |

## Validation — walk-forward 2018–2025 (n = 1,300,093, 2020 excluded)

| | log loss | calibration |
|---|---|---|
| **model, 7-class** | **1.4359** | |
| baseline: raw log5 | 1.4383 | |
| baseline: league rates only | 1.4616 | |
| hit (binary) | 0.5249 | 1.013 |
| HR | 0.1371 | 0.981 |
| K | 0.5204 | 0.963 |
| BB | 0.3090 | 1.012 |

## Test — 2026 holdout (n = 184,037)

| | log loss | calibration |
|---|---|---|
| **model, 7-class** | **1.4315** | |
| baseline: league rates only | 1.4559 | |
| hit | 0.5211 | 1.001 |
| HR | 0.1340 | 0.961 |
| K | 0.5147 | 1.000 |
| BB | 0.3210 | 0.948 |

## Live

None. Not served.

## How we got here

* **v2 (to 2026-09):** each market had its own model on bucketed career / 30 /
  90-day rates from R2, but was served from 30-day rolling stats in Postgres
  (1.7× the spread), patched with hand-set shrinkage constants.
* **v3 run 1 (2026-10-08 02:15):** league-logit features. Log loss 1.4368,
  2026 HR calibration 0.933, BB 0.926.
* **v3 run 2 (2026-10-08 05:13, current):** log5 logits. Log loss 1.4359,
  2026 HR 0.961, BB 0.948.
* **Caveat.** Run 2's feature change was chosen partly on run 1's 2026
  calibration. 2026 is therefore not a clean test for `pa_outcome` feature
  choices; the next clean season is 2027.

## Next steps

| # | step | expected effect |
|---|---|---|
| 1 | Activate, then `publish-ratings` (prerequisite for all of v3). | Unblocks every derived market. |
| 2 | Add pitch-level ratings: pitcher whiff / velocity / movement, batter exit velocity, hard-hit and pulled-air rate. | Gain over log5 is only 0.0024 log loss; ratings built from outcomes alone are near their ceiling. Needs the pitch-physics re-ingest and a serving path first. |
| 3 | Fix the walk and home-run under-prediction in 2026 (0.948, 0.961). Test a shorter league τ than 365 and handedness-split ratings. | Flows straight into `pitcher_bb` and `batter_hr`. |
| 4 | Sweep `C`; it has only ever been 1.0. | Cheap; unknown size. |
| 5 | Add count as a feature. | Lets this model replace `ab_result` and feed the live markets. |
