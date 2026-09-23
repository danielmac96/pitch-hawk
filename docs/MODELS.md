# Models — insert, activate, roll back

Every market is scored by the active row in `model_params` (one active row per
market). The edge function `supabase/functions/_shared/model.ts` reads whatever
is active via `loadActiveModels()` and degrades to a calibrated league-average
heuristic (`heuristic_v0`) when no trained row exists — so the app works on day
zero and sharpens the moment training runs.

## Day-to-day: the CLI

The offline workbench in `modeling/` owns the whole lifecycle. It replaced
`scripts/train_models.py` and `scripts/models.py`, both deleted.

```bash
python -m modeling build                       # R2 -> local cell cache (only R2 command)
python -m modeling sweep pitch_result          # walk-forward over every hyperparameter pair
python -m modeling train pitch_result          # sweep + holdout + record, no promotion
python -m modeling train pitch_result --promote  # + gate + activate

python -m modeling baseline                    # score the live version for a comparable number
python -m modeling list                        # every version, per market
python -m modeling show pitch_result           # active params (JSON)
python -m modeling status                      # registry version vs what live scoring stamps
python -m modeling activate pitch_result v2_20260809
python -m modeling rollback pitch_result       # undo, atomically
```

The loop is: `build` once → `baseline` to give the live version a comparable
number → `train` to see the sweep and the holdout → `train --promote` when the
gate agrees → watch `status` → `rollback` if graded results disagree.

`status` compares the registry's active version against
`predictions.model_version` (what live scoring actually stamped), so a
forgotten `live-poll` redeploy shows up as a mismatch instead of a mystery.

**There is no `--force`.** The old trainer had one, and it existed to skip the
gate. A held version is the gate working; overriding it is a human decision
that goes through an explicit `activate`.

## How a version is judged

The retired trainer gated on **in-sample** training log-loss, which cannot see
overfitting at all: a version that memorised its training cells scored better
and promoted. The gate now compares **out-of-sample** metrics:

- **Walk-forward**, ten folds. Fold N trains strictly on seasons `< N`;
  test seasons are 2016–2025.
- **2020 is reported per fold but excluded from the aggregate** — a 60-game
  COVID season distorts the mean by both sample size and schedule.
- **2026 is a frozen holdout**: never trained on, never selected on. It is
  scored once, after the sweep has already picked a winner.
- The shipped coefficients are then refit on **every** season including 2026 —
  the holdout validated the recipe, so the production fit should see all data.
- **Gate tolerance is 2%.** A new version promotes unless it is more than 2%
  worse than the active one on the market's primary metric.
- **Regression veto**: `linear` markets are held if out-of-sample σ-coverage
  leaves `[0.63, 0.73]`. A mis-scaled sigma has good RMSE and produces
  confidently wrong probabilities; RMSE alone cannot see it.

- **Calibration veto**: a market that declares a `calibration_band` is held
  when out-of-sample **calibration-in-the-large** falls outside it — mean
  predicted probability over observed rate, where 1.0 is correct and 1.4 means
  40% over-confident.

  Same shape and same rationale as the sigma veto, and it is the check
  `ab_result` never had: that market shipped predicting ~1.4× the realised
  rate and was patched at serve time with `CALIB_SHRINK = 0.7`, a constant
  applied after the fact to output nobody had gated.

  It sits beside `ece` rather than replacing it because binning fails on a
  rare class — with home runs at ~3.2% of plate appearances, ten uniform bins
  put nearly everything in one, and `calibration_bins` bins on class index 1,
  which for `("home_run", "other")` is the 97% class. Ratios have no bins and
  no class-index trap.

  The band is **wider for the rarer class** (`batter_hr` ±0.15, `batter_hit`
  ±0.10), which is the opposite of the instinct: the ratio rests on a seventh
  as many positive events, so a matching band would hold good models on
  sampling variance rather than on bias.

Every run is written to **`model_runs`**, promoted or not, with its folds,
config, holdout, params and the gate's verdict in `notes`. The rejected runs
are half the record: a registry holding only winners cannot show that a
version was *chosen* rather than merely produced. The dashboard reads this at
**Models** (`dashboard/pages/2_Models.py`).

## Offline/production parity

`modeling/score.py` is a Python mirror of `model.ts`, pinned to it at `1e-9` by
`tests/modeling/test_parity.py` against golden fixtures the TypeScript itself
emits. Without it, "validated offline" and "computed in production" are two
unverified claims.

Regenerate the fixtures after any change to scoring in `model.ts`:

```bash
deno test --allow-write --allow-read supabase/functions/tests/scorer_golden_test.ts
```

If Python and TypeScript disagree, **the TypeScript is correct** — it is what
serves users.

One consequence worth knowing: feature *baselines* live in `model.ts`
(`pitcher_zone_delta` is `zone_rate - 0.48`, `pitcher_k_delta` subtracts
`LEAGUE.ab_result.strikeout`). The cell SQL centres on those same constants
rather than recomputing them from the scan, because training and serving must
centre a feature identically or the shipped coefficients meet a differently
scaled input. No scorer parity test can catch that — the scorer is handed the
delta already computed — so it is pinned by `tests/modeling/test_cells.py`.

## `game_total` is scored but unregistered

`game-predict` scores a sixth market, `game_total`, from `team_run_rates` and
`park_factors` (`_shared/model.ts`). It has no `model_params` row, no
`modeling/specs/` module and no place in the registry — it is a formula, not a
fitted model. `python -m modeling list` will never show it. Registering it
means writing a spec and a fitter like any other market.

## `game_moneyline` is fitted but not served

`model.ts` has **no `params.type === "log5"` branch**. `game-predict` calls
`log5HomeProb(homeWinPct, awayWinPct)` and takes the function's default
`homeAdv = 0.542`; it never reads `model_params` for this market. A promoted
`game_moneyline` row would be recorded, versioned, and completely inert.

It stays in the workbench so the number is measured rather than being an
unexamined constant in a function signature — the walk-forward puts it at
**~0.535**, not 0.542 — and so the validation path already exists whenever the
edge function learns to read it. The Models dashboard flags the market with 🚫.
Until then, **do not `--promote` it**.

## The registry

`model_params` columns that matter:

| column | meaning |
|---|---|
| `market` | one of `pitch_result`, `ab_result`, `pitch_speed_ou`, `ab_pitches_ou`, `game_moneyline`, `batter_hit`, `batter_hr` |
| `version` | free-form, e.g. `v1_20260707`; unique per `(market, version)` |
| `params` | the model itself (JSON, shape depends on `type` — see below) |
| `metrics` | training metrics (used by the quality gate) |
| `is_active` | exactly one true row per market (partial unique index enforces it) |
| `activated_at` | set every time a version is activated; drives `rollback_model` |
| `notes` | why it was (or wasn't) activated |

## `params` shapes per `type`

The scorer in `model.ts` branches on `params.type`:

- **`multinomial_logistic`** (`pitch_result`, `ab_result`, `batter_hit`, `batter_hr`)
  ```json
  {
    "type": "multinomial_logistic",
    "classes": ["strike_foul", "ball", "in_play"],
    "features": ["balls", "strikes", "two_strikes", "..."],
    "coef": [[c11, c12, ...], ...],   // one row per class
    "intercept": [i1, i2, ...]         // one per class
  }
  ```
  Score = softmax over `intercept[k] + Σ coef[k][j]·featureValue(features[j])`.

  With **two** classes this is a binary logistic, which is what `batter_hit`
  and `batter_hr` use — no new family and no new scorer branch. Gate those on
  log loss, never accuracy: home runs are ~3.2% of plate appearances, so a
  model that always answers "no" is 96.8% accurate and worth nothing.

- **`linear`** (`pitch_speed_ou`)
  ```json
  { "type": "linear", "features": ["pitcher_velo", "balls", "strikes", "pitch_of_pa"],
    "coef": [..], "intercept": 0.0, "sigma": 5.4 }
  ```
  Predicts a mean; `sigma` turns it into P(over line) via a normal CDF.

- **`remaining_table`** (`ab_pitches_ou`)
  ```json
  { "type": "remaining_table",
    "table": { "0-0": { "mean": 3.6, "dist": { "1": 0.02, "2": 0.11, ... } }, ... } }
  ```
  Keyed by `balls-strikes`; `dist` maps REMAINING pitches → probability.

- **`log5`** (`game_moneyline`) — `{ "type": "log5", "home_adv": 0.54 }`.

Feature names must be ones `featureValue()` in `model.ts` understands.

## Insert & activate a new version

Fit and write with the workbench. It activates only if the out-of-sample gate
passes; without `--promote` it records the run and changes nothing:

```bash
# record only -- production untouched
python -m modeling train pitch_result
# gate on out-of-sample metrics, then activate if it passes
SUPABASE_URL=... SUPABASE_KEY=<service_role> python -m modeling train pitch_result --promote
```

Or drop a row in by hand and flip it live (works through the Supabase SQL editor
or MCP `execute_sql`):

```sql
insert into model_params (market, version, params, metrics)
values ('pitch_result', 'v2_20260710', '{"type":"multinomial_logistic", ...}'::jsonb, '{}'::jsonb);

select activate_model('pitch_result', 'v2_20260710');  -- atomic swap
select rollback_model('pitch_result');                 -- undo: reactivate the prior version
```

`activate_model` deactivates the old row and activates the named one in a single
call; `rollback_model` reactivates whichever version was active immediately
before. Both are `SECURITY DEFINER` and revoked from `anon`/`authenticated` — run
them as the service role.

## Add a new model `type`

1. Extend the scorer in `supabase/functions/_shared/model.ts`: handle the new
   `params.type` in the relevant `predict*` function, and keep the existing
   heuristic fallback for when it's absent.
2. If it needs new inputs, add them to `featureValue()`, and mirror them in
   `modeling/score.py` — `tests/modeling/test_parity.py` parses the real
   `switch` statement and fails if the two drift.
3. Add the family to `FAMILIES` in `modeling/spec.py`, a fitter in
   `modeling/fit.py::_FITTERS`, and an evaluator in
   `modeling/validate.py::_EVALUATORS`. Both dispatch tables raise on an
   unknown family rather than defaulting.
4. Add a market module under `modeling/specs/` and register it. The engine
   never branches on market name — per-market differences go on `MarketSpec`
   (`form_features`, `intercept_folded`, `datasets`).
5. `python -m modeling build --market <m>` then `sweep`, then `train`.
6. Redeploy the `live-poll` edge function so the new scorer ships.

## Adding a new market

One file in `modeling/specs/`, registered in `modeling/specs/__init__.py`. If
adding a market requires editing an engine file (`features.py`, `fit.py`,
`validate.py`) for anything other than a genuinely new model *family*, the
abstraction is wrong — say so rather than special-casing on market name.

### Declaring features

Every name in `feature_names` must be accounted for, and `MarketSpec` refuses
to construct otherwise. There are three kinds:

| kind | how | built from |
|---|---|---|
| **static** | nothing — free to every market | the cell grain: `bias`, `balls`, `strikes`, `two_strikes`, `three_balls`, `pitch_of_pa` |
| **form** | a `FormFeature` in `form_features` | a per-window bucket column your `cell_sql` emits |
| **folded** | listed in `intercept_folded` | nothing — trains as zero, absorbed by the intercept |

```python
form_features=(
    FormFeature("pitcher_k_delta", "p_k_bucket", step=0.035),
    FormFeature("batter_k_delta",  "b_k_bucket", step=0.040),
),
intercept_folded=("platoon_same",),
```

A market may declare **as many form dimensions as it needs**. Until 2026-09 it
could not: every pitcher-form name read one shared array and every batter-form
name was hardcoded to zero in `_design`, so "how the pitcher has been throwing"
and "how the batter has been hitting" could not both vary. A hit or home-run
market needs exactly that.

The five original markets declare no `form_features`; theirs are derived from
the legacy `bucket_col` / `bucket_step` / `bucket_baseline` triple, so their
design matrices are byte-identical. New specs should declare `FormFeature`
directly.

**`intercept_folded` is a confession, not a convenience.** `pitcher_bb_delta`
trained as a constant 0.0 for a year while `model.ts` computed it for real at
serving time — training and production disagreeing on one of six features,
recorded in `DATA-PIPELINE.md` §8.5 and easy to miss because nothing in the
spec said so. Now the spec says so. Closing one means adding the bucket column
to `cell_sql` and moving the name into `form_features`.

A name outside `SCORABLE_FEATURES` is rejected outright: `featureValue()` ends
in `default: return 0`, so the fit would learn a coefficient production never
applies. `tests/modeling/test_parity.py` reads the real `switch` and fails if
that set drifts from it.

### Form spines

Four, all sharing one leakage bound through `features._windows()`:

| spine | subject | grain | carries |
|---|---|---|---|
| `FORM_SPINE_SQL` | pitcher | pitch | zone rate, velocity |
| `FORM_SPINE_AB_SQL` | pitcher | plate appearance | K rate |
| `FORM_SPINE_BAT_AB_SQL` | batter | plate appearance | K, BB, hit, **HR** rate |
| `FORM_SPINE_BAT_CONTACT_SQL` | batter | ball in play | hard-hit, pull-in-air, exit velo |

The window bound is `interval 1 day preceding` — **exclusive of the current
day**. It is generated, not copied, because four hand-written copies is three
chances to relax one silently.

Note the two batter spines have different denominators on purpose: outcome
rates are per plate appearance, contact rates per ball in play. A hitter who
strikes out half the time can still scorch everything he touches.

## Verify what's live

```sql
select market, version, is_active, activated_at, metrics from model_params order by market, activated_at desc nulls last;
```

`/api/health` also lists the active `market`/`version` per market, and live
`predictions.model_version` shows the trained version (not `heuristic_v0`) once a
model is active.
