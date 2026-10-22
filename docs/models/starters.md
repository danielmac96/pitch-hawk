# Starter props — strikeouts, hits allowed, outs, earned runs, walks

**Predicts.** For each probable starter: a full count distribution, from
which a model-fair line (median half-point), an expected count and P(over)
are read. Markets: `pitcher_k`, `pitcher_hits`, `pitcher_outs`, `pitcher_er`,
`pitcher_bb`.

## Status (2026-10-12)

All five serve `base_v1` (league × 30-day rates over a fixed 22.5 batters
faced) and **none has a graded row**. v3 is validated and not staged for
four; `pitcher_bb` v3 is not good enough to ship.

## Process (v3)

1. **Workload.** Outs recorded and batters faced: a linear model for the
   mean plus the empirical integer residual distribution.
2. **Per-PA rates.** [`pa_outcome`](pa_outcome.md) for this pitcher against
   each batter in the lineup, weighted by PAs in each time through the order.
3. **Counts given outs = o.** K ~ Binomial(o, pK/(pK+pOUT)); baserunners
   ~ NegBin(o, p_out); hits | baserunners ~ Binomial(pH/(pH+pBB)); walks are
   the rest. Mixed over the outs distribution.
4. **Earned runs.** Poisson GLM, negative-binomial dispersion by moments.
5. **Calibrate P(over)** only where it improves validation log loss.

## Features considered

| candidate | outcome |
|---|---|
| Fixed 22.5 batters faced (base_v1) | Replaced by the workload model. |
| Workload: decayed own outs, team leash, decayed pitches, rest days, first start of season, out-getting quality | All six kept. |
| Calibrator for every market | Kept for `pitcher_er`, `pitcher_bb`; dropped for K, hits, outs (worse out of sample — outs 0.6950 vs 0.6930). |
| ER from the count roll-up | Replaced by a GLM on expected outs and run value per out. |
| In-game pitch count, bullpen availability, opener flag, umpire, defence | Not tried. |

## Features used

| component | features (fitted coefficient) |
|---|---|
| workload, outs | `own_mean` 0.670 · `team_leash` 0.126 · `pitches_mean` 0.116 · `rest` 0.069 · `first_start` −1.93 · `quality` 8.31 |
| workload, BF | same six |
| decays | τ = 150 days; priors 16 outs / 23 BF / 88 pitches at k = 3; team leash k = 10 |
| counts | lineup-averaged `pa_outcome` distribution |
| `pitcher_er` GLM | `log_e_outs` 0.794 · `log_runs_per_out` 1.226 · NB α = 0.218 |
| calibrators | `pitcher_er` a = 0.025, b = 0.828 · `pitcher_bb` a = −0.191, b = 1.264 |

## Algorithm

A linear location model with an empirical residual pmf gives a discrete
workload distribution without assuming a shape. Counts conditional on outs
are binomial / negative binomial, which follow directly from independent PAs.
Earned runs are over-dispersed and depend on sequencing, so they get a
Poisson GLM with NB2 variance instead of a roll-up.

## Training

| | |
|---|---|
| labels | `player_box` pitching lines |
| rows | one per start, ~4,850 per season |
| fit | least squares (workload), `PoissonRegressor(alpha=0)` (ER), `LogisticRegression(C=100)` (calibrators) |
| folds | stacked walk-forward 2018–2025, as for batters; shipped fit 2016–2026 |

## Validation and test

**Read MAE, not log loss.** The line is the model's own median, so P(over)
is ~0.5 by construction and its log loss stays near ln 2 (0.693) regardless
of skill. MAE of the expected count; baseline = one constant, the league
mean per start over the training seasons (not each pitcher's own average —
a weak baseline; P-003 adds full-distribution scores).

| market | validation 2018–25 | baseline | test 2026 (n=4,839) | baseline | P(over) log loss 2026 |
|---|---|---|---|---|---|
| `pitcher_k` | **1.83** | 2.05 | **1.80** | 2.02 | 0.688 |
| `pitcher_hits` | **1.76** | 1.84 | **1.75** | 1.85 | 0.686 |
| `pitcher_outs` | **3.12** | 3.40 | **3.06** | 3.37 | 0.693 |
| `pitcher_er` | **1.58** | 1.63 | **1.56** | 1.64 | 0.684 |
| `pitcher_bb` | 1.063 | **1.056** | 1.03 | 1.05 | 0.685 |

`pitcher_bb` loses to the baseline in validation and its 2026 P(over)
calibration is 0.90. It stays on `base_v1`.

## Live

No graded rows for any starter market (32 projections per market due since
2026-10-03, 0 graded).

## How we got here

* **To 2026-10-02:** no starter props.
* **2026-10-02, base_v1:** placeholders; every pitcher prop graded void
  (stale `settle` deploy, measured 2026-10-07).
* **2026-10-08, v3:** workload model + PA roll-up; grading moved to the
  official boxscore.
* **2026-10-10:** ladders published for every line.

## Next steps

| market | step |
|---|---|
| all | Fix grading first — there is no live record at all. Then activate v3 (not `pitcher_bb`). |
| all | Change the headline metric. Score the full distribution (CRPS / exact-count NLL) and P(over) at fixed, book-style lines; the self-priced median cannot show skill. |
| `pitcher_k` | Largest edge (−11% MAE). Add whiff / called-strike ratings from pitch data and the lineup's K rate by handedness. |
| `pitcher_outs` | P(over) shows no skill (0.693). Add recent pitch-count trend, bullpen rest, opener / bulk detection; test a non-linear workload model. |
| `pitcher_hits` | Smallest reliable edge. Add team defence and park-specific hit rates (BABIP). |
| `pitcher_er` | Add bullpen quality for inherited runners and defence; calibrator slope 0.83 says its raw P(over) is too extreme. |
| `pitcher_bb` | Decide: fix or remove from the board. Fix path = the `pa_outcome` walk under-prediction (0.948 in 2026) plus umpire zone; a placeholder with no record is the current state. |
