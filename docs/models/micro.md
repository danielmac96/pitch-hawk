# Per-pitch and per-at-bat markets (v2 cell models)

**Predicts.** Live, during a game:

| market | question | classes / output |
|---|---|---|
| `pitch_result` | next pitch | strike-or-foul, ball, in play |
| `ab_result` | this plate appearance | strikeout, walk, hit, out |
| `pitch_speed_ou` | next pitch velocity | mean + σ → P(over line) |
| `ab_pitches_ou` | pitches left in this PA | distribution by count |

## Status (2026-10-12)

All four serve `v2_20260809`, promoted 2026-08-09 through the automated
gate. Not part of v3. Registry mechanics: [`../MODELS.md`](../MODELS.md).

## Process

1. `python -m modeling build` aggregates R2 pitches / at-bats into **cells**:
   (season, count state, bucketed form rate) → outcome counts.
2. `sweep` fits every (form window, recency half-life) pair walk-forward.
3. `train` scores the winner on 2026, records the run; `--promote` activates
   it if it is within 2% of the active version and passes the calibration /
   σ vetoes.
4. `live-poll` scores each pitch with `_shared/model.ts`; a Python mirror is
   pinned to it at 1e-9.

## Features considered

| candidate | outcome |
|---|---|
| Form window: career, 30-day, 90-day | **Career** won for every market. |
| Recency half-life ∈ {1, 2, 3, none} | **1** for all four. |
| Batter chase rate (`pitch_result`); pitcher BB rate, batter K rate, platoon (`ab_result`) | **Folded into the intercept**: named in the model and computed live, but trained as zero because the cell grain does not carry them. `pitcher_bb_delta` is a real train/serve mismatch. |
| Pitch type, pitch mix, previous pitch, base-out state | Not tried. |

## Features used

| market | family | features actually trained |
|---|---|---|
| `pitch_result` | multinomial logistic | `balls`, `strikes`, `two_strikes`, `three_balls`, `pitcher_zone_delta` |
| `ab_result` | multinomial logistic | `balls`, `strikes`, `pitcher_k_delta` |
| `pitch_speed_ou` | weighted linear regression | `balls`, `strikes`, `pitch_of_pa`, `pitcher_velo` |
| `ab_pitches_ou` | lookup table | count state (12 states) |

## Algorithm

Logistic and linear models fitted on weighted cells rather than rows: the
same estimates as row-level fits at a fraction of the cost, and coefficients
simple enough to score in an edge function. `ab_pitches_ou` is an empirical
distribution of remaining pitches per count, with no parameters.

## Training

| | |
|---|---|
| data | 2015–2026 from R2; ~6.4M pitches / ~1.6M PAs scored across the validation folds |
| fit | `LogisticRegression(C=10)`; weighted least squares with σ = √(between + within cell variance) |
| folds | walk-forward, test seasons 2016–2025, 2020 excluded (9 used) |
| shipped fit | all seasons including 2026 |

## Validation and test

| market | metric | validation | test 2026 | previous active |
|---|---|---|---|---|
| `pitch_result` | log loss / ECE | 1.0161 / 0.004 | 1.0178 / 0.005 | 1.0181 |
| `ab_result` | log loss / ECE | 1.2447 / 0.003 | 1.2485 / 0.006 | 1.2486 |
| `pitch_speed_ou` | RMSE on cell means / σ-coverage | 1.78 mph / 0.696 | 1.74 / 0.697 | 4.31 |
| `ab_pitches_ou` | log loss | 1.6821 | 1.6832 | 1.6821 |

No naive baseline is recorded for these; the gate compares only with the
previous version. `pitch_speed_ou` RMSE is against cell means — per-pitch
spread is σ = 5.40 mph.

## Live (`v2_20260809`, 2026-08-09 → 10-12)

| market | graded | pick correct | MAE |
|---|---|---|---|
| `pitch_result` | 182,756 | 47.6% | |
| `ab_result` | 182,756 | 43.8% | |
| `pitch_speed_ou` | 182,756 | 51.3% | 5.1 mph |
| `ab_pitches_ou` | 39,739 | 57.5% (v1: 65.5% on 07-07 → 08-09) | 1.70 pitches |

## How we got here

* **2026-07-07, v1:** first trained versions, gated on in-sample log loss.
* **2026-08-09, v2:** rebuilt in the `modeling/` workbench with walk-forward
  validation and an out-of-sample gate. `pitch_speed_ou` moved most
  (RMSE 4.31 → 1.78).
* `ab_result` shipped ~1.4× over-confident and is still patched at serve time
  with `CALIB_SHRINK = 0.7`.

## Next steps

| market | step |
|---|---|
| all | Record a naive baseline (count-state rates) so skill is measurable, not just version-over-version change. |
| `ab_result` | Replace with [`pa_outcome`](pa_outcome.md) conditioned on the count. Removes `CALIB_SHRINK` and the three folded features. |
| `pitch_result` | Add the batter side (chase rate) to the cell grain; then pitch type and previous pitch. |
| `pitch_speed_ou` | The line equals the model's own prediction, so the hit rate is ~50% by construction. Model pitch mix — P(pitch type | count, pitcher) × per-type velocity — and price against a fixed per-pitcher line. |
| `ab_pitches_ou` | Explain the live drop from 65.5% (v1) to 57.5% (v2) when validation log loss was unchanged; check how the line is set before touching the model. |
