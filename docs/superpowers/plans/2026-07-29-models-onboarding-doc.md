# MODELS.md Onboarding Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `docs/MODELS.md` so a data scientist who knows MLB data and nothing about this app can understand the current modelling methodology, judge how much to trust it, and replace a model.

**Architecture:** Documentation only. No code changes, no schema changes, no calculations beyond reading values already stored. Every factual claim traces to a query or a source file cited in this plan.

**Tech Stack:** Markdown.

## Global Constraints

- **No new calculations.** Report what is stored. Where a number does not exist, say it does not exist. This is an explicit instruction from the CEO and it is also the honest approach — the gaps are the most useful content in the document.
- **No hedging on the validation gap.** The single most important fact is that no holdout validation exists. It gets its own section and is stated plainly, not softened.
- The document replaces `docs/MODELS.md` entirely. The existing content is an operator runbook; it survives as two sections (replacing a model, adding a model type), not as the frame.
- Audience: knows baseball and baseball data, has never seen this codebase. Explain app-specific machinery; do not explain what a strikeout is.
- Cite source files with paths and line numbers so claims are checkable.
- Keep the existing doc's register: direct, comment-dense, explains *why* not just *what*.

---

## Verified facts — the research is done, do not re-derive

Everything below was measured on 2026-07-29 against project `gfxpchtyncgsczqdvohr`. Use these values; do not recompute them.

### The registry: five active models, all one version

| Market | `params.type` | Stored metrics | `training_rows` |
|---|---|---|---:|
| `pitch_result` | `multinomial_logistic` | `weighted_logloss` 1.01565, `cells` 899 | 1,122,199 |
| `ab_result` | `multinomial_logistic` | `weighted_logloss` 1.23678, `cells` 2,400 | 1,122,381 |
| `pitch_speed_ou` | `linear` | `sigma` 5.374, `r2_cells` 0.9686 | 1,111,519 |
| `ab_pitches_ou` | `remaining_table` | `states` 12 | 1,121,660 |
| `game_moneyline` | `log5` | `home_win_rate` 0.5359, `games` 3,784 | 3,784 |

All five are `version = v1_20260707`, `activated_at` 2026-07-07, `notes = "initial train"`. **No second version has ever been written to `model_params`.**

### Finding 1 — the best-performing market is not this app's model

`predictions.model_version`, grouped, all time:

| Market | `model_version` | Rows | Wins | Losses |
|---|---|---:|---:|---:|
| `pitch_result` | `v1_20260707` | 49,060 | 12,887 | 15,494 |
| `pitch_speed_ou` | `v1_20260707` | 49,060 | 14,067 | 13,623 |
| `ab_result` | `v1_20260707` | 49,060 | 13,658 | 14,800 |
| `ab_pitches_ou` | `v1_20260707` | 26,625 | 12,228 | 4,401 |
| `ab_pitches_ou` | **`heuristic_v0`** | 2,596 | **2** | **2,484** |
| `game_moneyline` | **`mlb_winprob_v1`** | 48,964 | 21,080 | 7,282 |

**Every single `game_moneyline` prediction is stamped `mlb_winprob_v1`. Not one comes from the trained `log5` model.**

`live-poll` scores the moneyline with `liveHomeWinProb()`
([_shared/mlb.ts:290](supabase/functions/_shared/mlb.ts:290)), which fetches
MLB's own `/game/{pk}/winProbability` endpoint, and stamps
`model_version: "mlb_winprob_v1"`
([live-poll/index.ts:237](supabase/functions/live-poll/index.ts:237)).

The trained `log5` model is consumed only by `log5HomeProb()`
([_shared/model.ts:300](supabase/functions/_shared/model.ts:300)), whose sole
caller is `odds-ingest`
([odds-ingest/index.ts:325](supabase/functions/odds-ingest/index.ts:325)) — a
job that is **deliberately unscheduled** (`np-odds-ingest` is off).

So: the 70.8% moneyline win rate that `DATA-INVENTORY.md` reports as the app's
strongest result is **MLB's live win probability feed, relayed**. The app's own
moneyline model has never scored a live prediction. This must be stated
unambiguously — a new data scientist would otherwise spend weeks assuming the
log5 model works well.

### Finding 2 — the `ab_pitches_ou` heuristic fallback is broken

2,596 rows on `heuristic_v0` went **2–2,484**. That is a 0.08% win rate, which
is not underperformance; it is a defect.

Mechanism, from `predictAbPitches()`
([_shared/model.ts:239](supabase/functions/_shared/model.ts:239)): when the
`remaining_table` has no cell for the current `balls-strikes` key, `version`
stays `"heuristic_v0"` and the mean becomes
`Math.max(current + 1, LEAGUE.avg_pitches_pa)`. `ouJoin(…, modelFair = true)`
in `live-poll` then rounds that to the nearest 0.5 to make a model-fair line
([live-poll/index.ts:78](supabase/functions/live-poll/index.ts:78)), so the
prediction is "the at-bat ends in about one more pitch" — and it loses almost
every time.

The trained table has 12 states, which covers a legal `0-3` × `0-2` count grid.
These rows are therefore out-of-range count states. Last occurrence
2026-07-28, so it is still live. **Document it as a known defect; do not fix it
in this plan.**

### Finding 3 — `ab_result` output is knowingly miscalibrated and patched

`_shared/model.ts:59-74` carries `CALIB_SHRINK = 0.7` and this comment:

> graded `ab_result` strikeout picks show model prob ~1.4x the realized rate
> (e.g. model 0.55 -> actual 0.38)

`predictAbResult` applies `shrinkToPrior(scoreMultinomial(...), LEAGUE.ab_result)`,
keeping 70% of the model's deviation from the league prior. The code calls this
"coarse but monotonic". This is a documented calibration failure with a
band-aid in front of it, and it is exactly what a new data scientist should
address first. It also means **the probabilities served are not the model's raw
output** — a detail that would otherwise take a long time to discover.

### Finding 4 — win/loss counts disagree with DATA-INVENTORY

`DATA-INVENTORY.md` reports "14,352 graded predictions each" and win rates of
70.8 / 56.4 / 52.5 / 47.3 / 44.8%. The `predictions` table above shows
different denominators (28,000–48,000 decided rows per market) and different
implied rates — e.g. `ab_pitches_ou` at 12,228/16,629 versus the reported 56.4%.

**Do not adjudicate this.** State that two sources disagree, show both, and name
it as something to resolve. The likely cause is a different window or
denominator, but verifying that would be a calculation and is out of scope.

### Scheduled retraining has not run

`.github/workflows/train-models.yml` is scheduled Mondays 12:00 UTC and
`train_models.py` stamps `v1_<YYYYMMDD>` per run. Three Mondays have passed
since 2026-07-07 (07-13, 07-20, 07-27) and `model_params` still holds only the
five original rows. **No training run has succeeded in three weeks.** Cause
not yet determined.

### Algorithms, as implemented

Trainer: [scripts/train_models.py](scripts/train_models.py). Scorer:
[supabase/functions/_shared/model.ts](supabase/functions/_shared/model.ts).

- **`pitch_result`, `ab_result`** — `sklearn.linear_model.LogisticRegression(max_iter=2000, C=10.0)`, `sample_weight` = cell row count. Scored as softmax over `intercept[k] + Σ coef[k][j]·featureValue(features[j])`.
  - `pitch_result` features: `balls`, `strikes`, `two_strikes`, `three_balls`, `pitcher_zone_delta`, `batter_chase_delta`
  - `ab_result` features: `balls`, `strikes`, `pitcher_k_delta`, `pitcher_bb_delta`, `batter_k_delta`, `platoon_same`
  - **`pitcher_bb_delta` is hardcoded to 0.0 during training** (`train_models.py:107`, comment: "folded into intercept for v1 cells") while `featureValue()` computes a real value at scoring time. Training and serving disagree on this feature.
- **`pitch_speed_ou`** — `LinearRegression` weighted by cell count on `[velo_bucket, balls, strikes, pitch_of_pa]`. `sigma = sqrt(between_var + within_var)`, where `within_var` is the weighted mean of per-cell `var_speed`. Served as `P(over line) = 1 - normCdf((line - mu)/sigma)` using an Abramowitz-Stegun approximation.
- **`ab_pitches_ou`** — empirical distribution of *remaining* pitches keyed by `balls-strikes`, capped at 12. No fitting.
- **`game_moneyline`** — log5 on season win percentages with a home-advantage shift in odds space. Trained `home_adv` 0.5359; `log5HomeProb`'s default parameter is `0.542`. **Not used in live scoring** (Finding 1).

### The cell-aggregation approach

Training never downloads 1.19M rows. Five Postgres functions return **weighted
aggregate cells** — 899 for `pitch_result`, 2,400 for `ab_result` — and
`train_models.py` fits on those with `sample_weight = n`. This is why training
runs from a laptop or a GitHub runner over a million pitches.

It is also the direct cause of the `r2_cells` illusion in the next section.

### Validation: what exists

- **No train/test split. No holdout. No cross-validation. No calibration curve.** Every stored metric is computed on the same weighted cells the model was fit on (`train_models.py:68-70` for log-loss, `:136` for R²).
- **`r2_cells = 0.9686` is R² against cell *means*, not per-pitch outcomes.** It measures how well a plane fits ~900 pre-averaged points. Per-pitch predictive skill is `sigma = 5.374` mph — a standard deviation of more than five miles an hour on a quantity whose league mean is 92.8.
- That single fact resolves the apparent paradox in `DATA-INVENTORY.md`: `pitch_speed_ou` looks near-perfect in training (0.9686) and lands at 47.3% live, below a coin flip. **There is no contradiction. The training metric never measured the thing the live number measures.**
- The quality gate (`QUALITY_METRIC` / `QUALITY_TOLERANCE = 0.02`) compares a new version's *in-sample* metric to the active version's *in-sample* metric. It cannot detect overfitting, because both sides are training-set numbers.
- Markets with no comparable metric (`ab_pitches_ou`, `game_moneyline`) **always auto-activate**.

### Live track record: what exists

- `prediction_accuracy_daily` — 106 day/market rows, permanent, never pruned. Written by `rollup_prediction_accuracy()` before `prune_predictions()` deletes the raw rows (`daily-ingest/index.ts:69-80`). Columns: `n`, `n_graded`, `wins`, `losses`, `pushes`, `mean_confidence`, `mean_profit_units`.
- `predictions` — 220,080 rows, 21-day retention, graded by `settle`.
- `picks` — 15,628 rows, 15,635 graded / 29 pending as of 2026-07-29. `pick_record()` RPC aggregates it; `/api/record` serves it.
- **Nothing serves `prediction_accuracy_daily`.** It is the only permanent record of model performance and there is no route to it. (A `GET /accuracy` endpoint is planned in `2026-07-29-shared-live-state.md` Task 6.)
- Baselines: `DATA-INVENTORY.md` cites 53.5 / 50.0 / 46.4% but no table stores them. (`market_baselines` is planned in `2026-07-29-warehouse-and-capacity.md` Task 13.)

### The `heuristic_v0` fallback

Every market degrades to a league-average heuristic when no active row exists,
so the app works before training has ever run
([_shared/model.ts:1-14](supabase/functions/_shared/model.ts:1)). Constants in
`LEAGUE`: `avg_speed` 92.8, `pitch_result` {strike_foul .455, ball .352,
in_play .193}, `ab_result` {strikeout .221, walk .087, hit .239, out .453},
`avg_pitches_pa` 3.85, `speed_sigma` 5.4. `COUNT_PITCH_DELTAS` hand-tunes five
count states (3-0, 3-1, 0-2, 1-2, 2-2).

### Also worth documenting

- `predicted_value` for the two categorical markets is the **top probability**, not the predicted class. The class is in `recommendation`.
- `confidence` is `null` for `pitch_speed_ou` and `ab_pitches_ou` until joined to a line.
- Picks published at `book: "model_fair"` are graded against the **model's own line at even money**, so their record must never be read as beating a sportsbook (`live-poll/index.ts:46-51`).
- `AB_PICK_MIN_PROB = 0.52`, `ML_PICK_EDGE = 0.04` are the pick-publication thresholds.
- `activate_model()` / `rollback_model()` are `SECURITY DEFINER` and revoked from `anon`/`authenticated`.

---

## Task 1: Confirm the volatile facts still hold

**Files:** none — a verification step, because the doc's credibility rests on these numbers.

The tables above were measured on 2026-07-29. Re-run the two queries whose
answers move, and use fresh numbers in the document.

- [ ] **Step 1: Re-check the registry**

```sql
select market, version, is_active, activated_at, training_rows, metrics, notes
from model_params order by market, activated_at desc nulls last;
```

Expected: still five `v1_20260707` rows. **If new versions exist, scheduled
training has started working** — update the "retraining has not run" finding
accordingly rather than repeating a stale claim.

- [ ] **Step 2: Re-check the served model versions**

```sql
select market, model_version, count(*) as n,
  count(*) filter (where result='win') as wins,
  count(*) filter (where result='loss') as losses,
  max(created_at)::date as last_seen
from predictions group by market, model_version order by market, n desc;
```

Expected: `game_moneyline` still 100% `mlb_winprob_v1`, and the
`ab_pitches_ou` / `heuristic_v0` row still catastrophically negative. Both are
load-bearing findings; confirm before publishing them.

- [ ] **Step 3: Record the measurement date**

Note today's date. The document carries an "as of" line and every count is
stamped with it.

---

## Task 2: Write the document

**Files:**
- Modify: `docs/MODELS.md` (full replacement)

Ten sections. Content for each is specified below; the verified-facts section
above supplies every number.

- [ ] **Step 1: Write sections 1–3 (orientation)**

**1. What this app predicts.** The five markets in baseball terms: the next
pitch's outcome class (strike-or-foul / ball / in-play), the next pitch's
velocity over-or-under a line, how the plate appearance ends (strikeout / walk /
hit / out), how many pitches the plate appearance takes, and who wins the game.
State up front that the first four are scored per pitch during live games and
the fifth is relayed from MLB.

**2. The data.** 1,193,565 pitches over two seasons (2025 full + 2026 to date),
308,056 plate appearances, 4,110 games, 1,721 players. Per pitch: velocity,
pitch type, zone 1–14, outcome description and category, ball/strike count,
outs, inning, half, timestamp — 99.96% complete on velocity/type/zone. Per PA:
pitch count, coarse result, and a detailed result with 20+ values.

Then, prominently, **what is not captured**: who is on base, cumulative in-game
pitch count, times through the order, and score at pitch time. Note that the
MLB feed returns base state and ingest discards it, and that these are the
leading hypothesis for why the two next-pitch markets underperform.

**3. How a prediction happens.** The runtime path: `pg_cron` fires `live-poll`
every 30 s → it fetches MLB play-by-play → `loadActiveModels()` reads
`model_params` → `predict*()` in `model.ts` scores → a row lands in
`predictions` → `settle` (and now `live-poll` inline) grades it → `/api/live`
serves it behind a 10 s CDN cache. Include the `ScoreContext` shape and note
that `pitcher_rolling_stats` / `batter_rolling_stats` are the feature source at
scoring time.

- [ ] **Step 2: Write sections 4–5 (the models and how they were fit)**

**4. The five models.** One subsection each: algorithm, feature list, `params`
JSON shape, and stored metrics. Reuse the registry table verbatim. Flag inside
the relevant subsections:

- `ab_result` — the `CALIB_SHRINK = 0.7` shrink-to-prior, quoting the source
  comment about model probabilities running ~1.4× the realized rate. Say plainly
  that served probabilities are not the model's raw output.
- `ab_result` — `pitcher_bb_delta` is trained as a constant 0.0 but computed for
  real at scoring time. Training and serving disagree on one of six features.
- `game_moneyline` — **the trained model does not score anything.** Full
  explanation from Finding 1, with the file and line citations.
- `ab_pitches_ou` — the `heuristic_v0` defect from Finding 2, with the 2–2,484
  record and the mechanism.

Then the `heuristic_v0` fallback: why it exists (day-zero operation), the
`LEAGUE` constants, and how to tell from `predictions.model_version` whether a
row was scored by a trained model or the fallback.

**5. How training works.** The cell-aggregation trick and why: five RPCs return
weighted aggregate cells so a million pitches transfer as a few thousand rows,
fit with `sample_weight = n`. Show the sklearn configuration. Explain the
version stamp (`v1_<YYYYMMDD>`), the quality gate and its 2% tolerance, and that
`ab_pitches_ou` and `game_moneyline` bypass the gate entirely.

Note the pipeline location: `.github/workflows/train-models.yml`, Mondays 12:00
UTC — **and that it has not produced a version since 2026-07-07.**

- [ ] **Step 3: Write section 6 — validation. This is the section that matters.**

Lead with the plain statement: **no holdout validation exists for any model.**

Then, in order:

1. Every stored metric is in-sample, on the weighted training cells. Cite the
   lines in `train_models.py`.
2. `r2_cells = 0.9686` is R² against cell means, not per-pitch outcomes. Explain
   what it does and does not measure. Give the honest per-pitch figure:
   `sigma = 5.374` mph against a league mean of 92.8.
3. State that this resolves the `DATA-INVENTORY.md` paradox: 0.9686 in training
   and 47.3% live is not a contradiction, because the training metric never
   measured predictive skill.
4. The quality gate compares in-sample to in-sample and therefore cannot detect
   overfitting.
5. No calibration curve exists, which is why `CALIB_SHRINK` is a hand-tuned
   constant rather than a fitted correction.
6. What it would take to fix: graded `predictions` rows are the natural
   out-of-sample evaluation set, and the warehouse plan exports them to R2 so
   they survive the 21-day retention. Point at that plan rather than restating it.

No hedging. Do not write "limited validation" or "validation could be improved".
Write that it does not exist.

- [ ] **Step 4: Write section 7 — the live track record**

Where performance is actually recorded: `prediction_accuracy_daily` (106 rows,
permanent), `predictions` (21-day), `picks` and `pick_record()`.

Include the served-versions table from Finding 1 as the raw record.

Then Finding 4: `DATA-INVENTORY.md` and the `predictions` table disagree on
denominators and rates. Show both, state that the discrepancy is unresolved, and
name it as a thing to check. Do not pick a winner.

Explain how to read a win rate honestly: against the most-common-outcome
baseline, not against 50%. Note that no table stores those baselines today and
where `market_baselines` is planned.

Flag the `model_fair` caveat: those picks are graded against the model's own
line at even money and must never be read as beating a sportsbook.

- [ ] **Step 5: Write sections 8–9 — the operator runbook**

These carry over from the existing `docs/MODELS.md`, largely intact.

**8. Replacing a model.** The `scripts/models.py` CLI (`list`, `show`, `status`,
`train --dry-run`, `activate`, `rollback`), the upgrade loop, the SQL path with
`activate_model()` / `rollback_model()`, and the note that both are
`SECURITY DEFINER` and revoked from `anon`/`authenticated`. Keep the existing
explanation of why `status` compares the registry against
`predictions.model_version` — it catches a forgotten `live-poll` redeploy.

**9. Adding a model type.** The four steps: extend the scorer's `params.type`
branch in `model.ts`, add any new inputs to `featureValue()`, produce and insert
the `params` JSON, redeploy `live-poll`. Keep the `params` shape reference for
all four existing types.

- [ ] **Step 6: Write section 10 — known weaknesses**

A prioritised list, each with what is known and what is not:

1. `game_moneyline`'s trained model is unused; the headline number is MLB's feed.
2. No holdout validation anywhere.
3. `ab_result` is knowingly miscalibrated and patched with a constant.
4. `ab_pitches_ou`'s heuristic fallback is 2–2,484.
5. `pitcher_bb_delta` trains as zero and serves as a real value.
6. Two of five markets sit below their trivial baseline; the two candidate
   explanations (feature starvation vs irreducible difficulty) and the fact that
   base state / in-game pitch count / times-through-order would test the first.
7. Scheduled retraining has not succeeded in three weeks.

- [ ] **Step 7: Add the header**

```markdown
# Models — methodology, performance, and how to change them

**Audience:** a data scientist new to this project who knows MLB data
**As of:** <measurement date from Task 1>
**Sources:** `model_params`, `predictions`, `prediction_accuracy_daily`;
`scripts/train_models.py`; `supabase/functions/_shared/model.ts`

Every number here is read from the database or the source files cited. Nothing
is recomputed, and where a measurement does not exist this document says so
rather than estimating.
```

- [ ] **Step 8: Commit**

```bash
git add docs/MODELS.md
git commit -m "docs: rewrite MODELS.md as data-scientist onboarding

Replaces the operator runbook with a full methodology document. Records four
findings from tracing the scorer and the predictions table:

- Every game_moneyline prediction is stamped mlb_winprob_v1. The trained log5
  model has never scored a live prediction; the 70.8% headline is MLB's own
  win-probability feed relayed through live-poll.
- ab_pitches_ou's heuristic_v0 fallback went 2-2484 on 2,596 rows.
- ab_result output is knowingly miscalibrated (model prob ~1.4x realized) and
  patched with a hand-tuned CALIB_SHRINK constant, so served probabilities are
  not the model's raw output.
- DATA-INVENTORY's win rates disagree with the predictions table's denominators;
  both are shown and the discrepancy is left open.

The validation section states plainly that no holdout exists and that
r2_cells 0.9686 is R-squared against cell means, which is why pitch_speed_ou
reads near-perfect in training and 47.3% live."
```

---

## Task 3: Cross-check every claim

**Files:** none — the acceptance gate.

- [ ] **Step 1: Verify each cited file and line**

For every `path:line` citation in the document, open it and confirm the claim.
The citations that matter most:

- `_shared/model.ts:65` — `CALIB_SHRINK = 0.7`
- `_shared/model.ts:239` — `predictAbPitches` and the missing-cell branch
- `_shared/model.ts:300` — `log5HomeProb`
- `_shared/mlb.ts:290` — `liveHomeWinProb`
- `live-poll/index.ts:237` — the moneyline path and `mlb_winprob_v1`
- `odds-ingest/index.ts:325` — the only `log5HomeProb` caller
- `train_models.py:107` — `pitcher_bb_delta` hardcoded to 0.0
- `train_models.py:68-70`, `:136` — in-sample metrics

Line numbers shift; correct any that have moved rather than leaving them wrong.

- [ ] **Step 2: Confirm no calculations crept in**

Search the document for derived statistics. Win/loss **counts** are stored data
and fine. A computed rate the database does not hold is a scope violation unless
it is quoted from `DATA-INVENTORY.md` **and attributed to it**.

- [ ] **Step 3: Confirm the validation section does not hedge**

Run: `grep -in "limited validation\|could be improved\|room for improvement\|somewhat\|relatively robust" docs/MODELS.md`
Expected: **no matches.** Any hit is softening that the CEO explicitly did not ask for and a new data scientist would be misled by.

Confirm the section contains the literal claim that no holdout validation exists:

Run: `grep -in "no holdout" docs/MODELS.md`
Expected: at least one match.

- [ ] **Step 4: Confirm the four findings are all present**

Run: `grep -c "mlb_winprob_v1" docs/MODELS.md`
Expected: at least 2.

Run: `grep -in "2,484\|CALIB_SHRINK\|pitcher_bb_delta" docs/MODELS.md`
Expected: all three present.

- [ ] **Step 5: Read it as the target reader**

Read start to finish as someone who knows MLB data and has never seen this repo.
Check three things:

1. Could you replace `pitch_result` with a new model using only this document?
2. Would you know how much to trust each market's reported performance?
3. Would you be surprised later by anything the document should have told you?

The third is the real test. The `game_moneyline` finding is the one that would
otherwise cost weeks.

- [ ] **Step 6: Commit any corrections**

```bash
git add docs/MODELS.md
git commit -m "docs: correct MODELS.md citations after cross-check"
```

---

## Final acceptance

- [ ] `docs/MODELS.md` has all ten sections
- [ ] Every `path:line` citation verified against current source
- [ ] No computed statistic that is not either stored or attributed to `DATA-INVENTORY.md`
- [ ] The validation section states, without hedging, that no holdout validation exists
- [ ] The `r2_cells` explanation reconciles 0.9686 in training with 47.3% live
- [ ] All four findings documented: unused moneyline model, the 2–2,484 fallback, the calibration patch, the win-rate discrepancy
- [ ] Replacing a model and adding a model type are both actionable from the document alone

---

## Notes for the implementer

**This document's value is its candour.** The existing `MODELS.md` is a
competent runbook that happens to omit that the best-performing market is not
this app's model and that no model has ever been validated out of sample. A
rewrite that stays comfortable would be worse than no rewrite, because it would
launder those facts into apparent rigour.

**Finding 1 is the headline.** If the reader takes away one thing, it should be
that `game_moneyline`'s 70.8% is MLB's win-probability feed relayed, and the
trained log5 model has never scored a live prediction. It is not a criticism of
anyone — relaying a good feed is a reasonable engineering choice — but
presenting it as model performance is not.

**Resist fixing things.** Findings 2, 3, and 5 are live defects and the
temptation to patch them will be strong. This plan is documentation only. Write
them down; let the CEO decide priority.
