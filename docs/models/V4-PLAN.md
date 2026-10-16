# v4 — one model per market

Status: **plan, in progress** (opened 2026-10-15). Owner: modeling lead.
Tracked as proposal **P-009** in [LAB.md](LAB.md).

## Why a v4

v3 derives every player and game market from one plate-appearance model
through closed-form roll-ups and a thin calibrator. That is elegant, and the
leaderboard shows it beats naive baselines, but it has three structural limits:

1. **One model's errors propagate everywhere.** `pa_outcome` under-predicts
   walks (2026 calibration 0.948) and `pitcher_bb` fails for that reason alone
   (P-002). A roll-up cannot correct an outcome the base model gets wrong.
2. **Market-specific signal has nowhere to go.** Pitch count leash, umpire
   zone, rest days, bullpen usage, weather on fly balls, lineup protection for
   RBIs — none of it enters a structural roll-up whose only inputs are seven
   per-PA probabilities and a workload pmf.
3. **The micro markets never moved** — `pitch_result`, `ab_result`,
   `pitch_speed_ou`, `ab_pitches_ou` are still August cell models with a
   serve-time `CALIB_SHRINK` and folded features, and they ignore pitch-level
   physics the warehouse now holds for every season (2026-10-13 readiness:
   12 of 12 seasons ready).

v4 fits **a dedicated model per market on that market's own outcome
variable**, with the v3 structural prediction available as *one feature among
many* (stacking) and always as a *baseline to beat*. Nothing is removed: v3
stays recorded, and a v4 market that cannot beat v3 out of sample does not
ship.

## Definition of done

For **every market the app offers** (17 + the unregistered `game_total`):

| # | deliverable | evidence |
|---|---|---|
| 1 | A v4 model fitted on the market's own outcome variable | `model_runs` row, `config.pipeline = "v4"` |
| 2 | Its full iteration history — every candidate tried, chosen or not, with the reason | `model_runs` rows tagged `config.iteration`, one per candidate |
| 3 | Walk-forward validation 2018–2025 (2020 reported, excluded), 2026 test, against named baselines including v3 | `folds`, `oos_metrics`, `holdout_metrics` |
| 4 | **Backfilled out-of-sample predictions** for every row 2018→today: each season predicted by a model that never saw it | R2 `model_backfill/v4/<market>/<season>.parquet` + `v4_backfill_daily` in Supabase |
| 5 | **Kept up to date**: the nightly scores yesterday's games with the frozen production fit and grades them | `warehouse.yml` step; `v4_backfill_daily.max(day)` = yesterday |
| 6 | Dashboard shows how each model was built, trained, validated, tested, and iterated | `dashboard/pages/3_Model_Lab_v4.py` |
| 7 | Tests: leakage, schema, metrics, determinism on the synthetic league | `pytest tests/modeling/test_v4_*.py` green in CI |

**Explicitly out of scope for this plan:** activating v4 in production
serving. GBM scorers do not exist in the TypeScript edge functions, and the
house rule is "CI records, humans promote". Phase 6 below describes the path;
it is gated on a human decision per market.

## Market catalogue — outcome variable, grain, family

| market | grain | outcome variable (y) | rows (approx, 2015–26) | primary metric | baselines |
|---|---|---|---|---|---|
| `pitch_result` | pitch | {strike/foul, ball, in-play} | 7.9M | log loss (3-class) | count-state rate; v2 |
| `pitch_speed_ou` | pitch | release speed (mph) → P(> line) | 7.9M | Gaussian NLL; RMSE; σ-coverage | pitcher's prior-mean by pitch type; v2 |
| `ab_result` | PA, at each count state | {K, BB, hit, out} | 2.1M PAs | log loss (4-class) | count-state rate; v2; `pa_outcome` collapsed |
| `ab_pitches_ou` | PA, at each count state | remaining pitches (0..12+) | 2.1M PAs | count NLL, RPS | count-state histogram (= v2) |
| `batter_hit` | batter-game | H ≥ 1 | 790k | log loss | slot rate; v3 |
| `batter_hr` | batter-game | HR ≥ 1 | 790k | log loss | slot rate; v3 |
| `batter_tb15` | batter-game | TB ≥ 2 | 790k | log loss (+ RPS of TB count) | slot rate; v3 |
| `batter_hrr` | batter-game | H+R+RBI ≥ 1 (+ count 0..5+) | 790k | log loss (+ RPS) | slot rate; v3 |
| `batter_hit_rog` | batter × PA boundary | ≥1 hit in the rest of the game | ~2M | log loss by inning | `base_v1` formula; remaining-PA rate |
| `batter_hr_rog` | batter × PA boundary | ≥1 HR in the rest of the game | ~2M | log loss by inning | `base_v1`; remaining-PA rate |
| `pitcher_k` | start | strikeouts (count) | 55k | count NLL, RPS, MAE(E[y]) | pitcher's decayed mean; v3 |
| `pitcher_bb` | start | walks (count, BB only — see P-002) | 55k | count NLL, RPS, MAE | decayed mean; v3 |
| `pitcher_hits` | start | hits allowed | 55k | count NLL, RPS, MAE | decayed mean; v3 |
| `pitcher_outs` | start | outs recorded | 55k | count NLL, RPS, MAE | decayed mean; v3 |
| `pitcher_er` | start | earned runs | 55k | count NLL, RPS, MAE | decayed mean; v3 |
| `game_moneyline` | game | home win | 27.6k | log loss | home rate; production log5 (0.542); v3 |
| `game_total` | game | total runs (count) → P(> 8.5) | 27.6k | exact-total NLL; log loss @ 8.5 | league NB; production `total_v1`; v3 |
| `game_total_live` | game × half-inning | final total given state | ~480k | exact-total NLL by inning | pregame-scaled `base_v1` |

`game_moneyline` live stays on MLB's own win probability until P-006; v4
does not take it on.

## Model families (per market, the same menu)

Every market runs the same candidate ladder, so "why this model" is answered
by a recorded comparison rather than by taste:

| iteration | candidate | purpose |
|---|---|---|
| `i0_baseline` | the naive baseline(s) above | the floor |
| `i1_v3` | v3 structural prediction (where one exists) | the incumbent |
| `i2_glm` | regularised GLM (logistic / multinomial / Poisson / NB) on engineered features | interpretable challenger |
| `i3_gbm` | histogram gradient boosting on engineered features | non-linear challenger |
| `i4_gbm_stack` | `i3` + the v3 structural prediction(s) as features | does v4 add to v3 or replace it? |
| `i5_tuned` | best of `i2`–`i4` with a small hyperparameter search, nested in the walk-forward | the candidate |
| `i6_calibrated` | `i5` + isotonic/Platt calibrator fitted per fold | kept only if it improves OOS log loss (same rule as v3's `_keep_cal`) |

The **chosen** iteration is the one with the best validation primary metric
that also passes the gate (below). The 2026 test is scored for every
candidate but **never used to choose** — it is reported so the dashboard can
show whether the choice generalised.

Count markets (`pitcher_*`, `game_total`, `ab_pitches_ou`, `batter_hrr`
count) are distributional: the GBM predicts a mean, and the distribution is a
negative binomial whose dispersion is fitted per fold (or an ordinal
multiclass GBM where the support is small — `ab_pitches_ou`). This keeps
every ladder line scoreable with RPS, as P-003 requires.

Engine: scikit-learn `HistGradientBoosting*` (already a dependency; no new
package). LightGBM is not added — the gain does not justify a new native
dependency on the runner.

## Features (new and reused)

All features are **as-of the morning of the game** (pregame markets) or
**as-of the pitch/PA** (in-game markets), computed only from strictly earlier
days — the same `interval 1 day preceding` bound `features._windows()`
enforces. Leakage is tested, not trusted (`test_v4_leakage.py`: shuffle a
future day's outcomes and assert no feature for an earlier day changes).

Feature groups, built once into a cached frame per grain:

| group | examples | grains |
|---|---|---|
| **v3 ratings** (reused) | batter / pitcher / pen / park 7-class decayed rates, league rate | all |
| **v3 structural** (reused, for stacking) | P(hit), P(HR), E[TB], E[K], workload pmf mean, team run mean | game, player |
| **rolling form** (new) | 7/30/90-day and season rates: K%, BB%, hit%, HR%, ISO; pitch-level whiff%, CSW%, zone%, chase% | all |
| **pitch physics** (new) | pitcher's as-of mean velo / spin / IVB / HB / extension per pitch type; arsenal share; velo trend vs own season mean | pitch, PA, start |
| **contact quality** (new) | batter as-of EV, hard-hit %, barrel proxy, launch-angle sweet-spot %, pull-air % | PA, batter-game |
| **workload & rest** (new) | days rest, last-start pitch count, season IP, team bullpen innings last 3 days | start, game |
| **context** (new) | park (v3 park factors), temp, wind-out component, roof, umpire's as-of called-strike rate, day/night, travel/rest for team | all pregame |
| **lineup** (new) | slot, expected PA, protection (OBP of hitters behind), team implied runs from v3 | batter-game |
| **matchup** (new) | platoon, batter vs pitch-hand split, career head-to-head PA (shrunk) | PA, batter-game |
| **in-game state** (micro / live) | count, outs, base state, inning, score diff, pitch of game, TTO, pitcher's in-game velo delta vs own mean, previous pitch type/result | pitch, PA, live |

New feature code lives in `modeling/v4/features/`, one module per group;
every feature is declared once with its grain and its as-of rule.

## Validation protocol (inherits the LAB protocol)

- **Walk-forward**: for each test season S in 2018..2025, fit on seasons < S
  (from 2015), score S. 2020 is reported, excluded from the aggregate.
- **Test**: 2026, fitted on 2015–2025, scored once per candidate, never used
  to choose. (Per LAB.md, 2026 is partly spent for `pa_outcome`; 2027 is the
  next clean test and the dashboard will flag it as such once it exists.)
- **Production fit**: refit the chosen recipe on 2015–2026.
- **Backfill**: the walk-forward and test predictions *are* the backfill for
  2018–2026 — each row predicted by a model that never saw its season. After
  2026, rows are predicted by the production fit, which never saw them either.
- **Metrics recorded for every fold and candidate**: primary metric; log loss,
  Brier, calibration-in-the-large, ECE (10-bin), AUC for binary; RPS and count
  NLL for counts; RMSE, MAE, Gaussian NLL and σ-coverage for speed; reliability
  bins (for plots); feature importances (permutation, on the test fold).
- **Large-grain markets** (pitch, PA): each fold trains on a stratified
  subsample capped at 2M rows (seeded, recorded in `config`) and scores the
  full test season. Runner memory (7 GB) is the binding constraint.

## Gate (v4 → stageable)

A v4 market is **stageable** only if its chosen iteration:

1. beats every baseline **and v3/v2** on validation primary metric, and is not
   worse than them on 2026;
2. has 2026 calibration-in-the-large within 1 ± 0.10 (± 0.15 for events rarer
   than 15%) — the existing `report.verdict` rule;
3. for `pitch_speed_ou`, OOS σ-coverage in [0.63, 0.73];
4. shows no single fold more than 5% worse than the incumbent (stability).

Implemented as `modeling/v4/gate.py`, reusing `report.verdict` where it
applies. Recorded on the run as `status = "stageable"` or `"held"` with the
reason in `notes`.

## Storage

| what | where | why |
|---|---|---|
| iteration runs, folds, metrics, params summary | `model_runs` (existing) | one experiment record for v2, v3 and v4 |
| model card metadata (outcome, grain, features, importances, reliability bins) | `model_runs.config` / `calibration` jsonb | dashboard reads one table |
| row-level backfilled predictions | R2 `model_backfill/v4/<market>/<season>.parquet` | 2018–2026 pitch grain is ~6M rows/market; Supabase's 35-day hot window cannot hold it |
| daily per-market metrics (n, mean pred, observed, log loss, Brier, …) | new table `v4_backfill_daily` | dashboard trend lines; small (≈18 markets × ~1,600 days) |
| production fits (pickled sklearn) | R2 `model_artifacts/v4/<market>/<run_id>.pkl` | the nightly scorer loads the frozen fit |

The R2 token cannot LIST, so backfill and artifact keys are recorded in a
small index object `model_backfill/v4/_index.json`, the same pattern as
`_manifest.json`.

## Phases

| phase | scope | output |
|---|---|---|
| **0. Plan** | this document; P-009 in LAB.md | ✅ |
| **1. Framework** | `modeling/v4/`: market registry (outcome, grain, baselines), candidate ladder runner, walk-forward with subsampling, metrics, gate, run recording, backfill writer + index, `python -m modeling v4 {build,train,backfill,score,report}`; synthetic-league tests | code + tests, runs locally on the synthetic league |
| **2. Feature frames** | grain frames + feature groups above, cached to `.cache/v4/*.parquet` on the runner; leakage tests | `python -m modeling v4 build` |
| **3. Game + player markets** | 4 batter, 5 starter, moneyline, total — run the ladder, record, backfill | `model_runs` + R2 backfill + `v4_backfill_daily` |
| **4. Micro + live markets** | `pitch_result`, `pitch_speed_ou`, `ab_result`, `ab_pitches_ou`, `batter_hit_rog`, `batter_hr_rog`, `game_total_live` | same |
| **5. Keep current + dashboard** | nightly `python -m modeling v4 score --yesterday` in `warehouse.yml`; dashboard page; `report` writes a v4 block in LAB.md; model card `docs/models/v4.md` | live tracking from the day it merges |
| **6. Serving (human-gated, separate PR)** | export GBM trees to JSON, TS tree scorer in `_shared/`, 1e-9 parity golden like `props_golden`, `stage-v4` | per-market activation by a human |

Execution path: training reads R2, whose secrets live only in GitHub Actions,
so every run goes through `model-lab.yml` (commit `modeling/lab/request.json`
on this branch). Results are read back from `model_runs` and the job logs.
Each run is a step in the iteration history, including failures.

## Risks

| risk | mitigation |
|---|---|
| 7 GB runner OOM on pitch grain | column-pruned DuckDB reads, float32, 2M-row training subsample per fold, one market per step |
| 340-min job limit | one request step per market group; frames cached between steps within a job |
| Leakage through as-of joins | strictly-prior-day bound generated in one place; shuffle test |
| Choosing on the test season | 2026 never enters candidate selection; selection code has no access to the 2026 fold |
| Overfitting via the ladder itself (garden of forking paths) | ladder is fixed in advance (this table); every candidate recorded; stability criterion in the gate |
| v4 beats v3 offline but cannot be served | phase 6 is explicit; until then v4 is a backfilled, nightly-scored shadow model, labelled as such on the dashboard |
