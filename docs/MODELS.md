# Models — insert, activate, roll back

Every market is scored by the active row in `model_params` (one active row per
market). The edge function `supabase/functions/_shared/model.ts` reads whatever
is active via `loadActiveModels()` and degrades to a calibrated league-average
heuristic (`heuristic_v0`) when no trained row exists — so the app works on day
zero and sharpens the moment training runs.

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

Fit and write with the trainer (auto-activates only if the quality gate passes —
not worse than the active by >2% on log-loss/sigma):

```bash
SUPABASE_URL=... SUPABASE_KEY=<service_role> python scripts/train_models.py
# preview without activating:
python scripts/train_models.py --dry-run
# override the gate:
python scripts/train_models.py --force
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
2. If it needs new inputs, add them to `featureValue()`.
3. Produce the `params` JSON (a trainer function in `scripts/train_models.py`, or
   by hand), insert, and `activate_model(...)`.
4. Redeploy the `live-poll` edge function so the new scorer ships.

## Verify what's live

```sql
select market, version, is_active, activated_at, metrics from model_params order by market, activated_at desc nulls last;
```

`/api/health` also lists the active `market`/`version` per market, and live
`predictions.model_version` shows the trained version (not `heuristic_v0`) once a
model is active.
