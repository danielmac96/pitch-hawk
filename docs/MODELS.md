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
| `market` | one of `pitch_result`, `ab_result`, `pitch_speed_ou`, `ab_pitches_ou`, `game_moneyline` |
| `version` | free-form, e.g. `v1_20260707`; unique per `(market, version)` |
| `params` | the model itself (JSON, shape depends on `type` — see below) |
| `metrics` | training metrics (used by the quality gate) |
| `is_active` | exactly one true row per market (partial unique index enforces it) |
| `activated_at` | set every time a version is activated; drives `rollback_model` |
| `notes` | why it was (or wasn't) activated |

## `params` shapes per `type`

The scorer in `model.ts` branches on `params.type`:

- **`multinomial_logistic`** (`pitch_result`, `ab_result`)
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
   (`bucket_step`, `bucket_col`, `bucket_baseline`, `datasets`).
5. `python -m modeling build --market <m>` then `sweep`, then `train`.
6. Redeploy the `live-poll` edge function so the new scorer ships.

## Adding a new market

One file in `modeling/specs/`, registered in `modeling/specs/__init__.py`. If
adding a market requires editing an engine file (`features.py`, `fit.py`,
`validate.py`) for anything other than a genuinely new model *family*, the
abstraction is wrong — say so rather than special-casing on market name.

## Verify what's live

```sql
select market, version, is_active, activated_at, metrics from model_params order by market, activated_at desc nulls last;
```

`/api/health` also lists the active `market`/`version` per market, and live
`predictions.model_version` shows the trained version (not `heuristic_v0`) once a
model is active.
