# Data pipeline redesign — historic offload, shared live state, model docs

**Status:** approved design, ready for implementation planning
**Date:** 2026-07-29
**Supabase project:** `MLB Next Pitch` (`gfxpchtyncgsczqdvohr`), region `us-east-2`, Postgres 17.6
**Repo:** `danielmac96/mlb-next-pitch`

---

## 1. Why

Three problems, addressed together because they share a pipeline:

1. **Capacity.** Supabase is at 453 MB of a 500 MB cap. `pitches` grows ~0.9 MB/day, giving roughly seven weeks of headroom.
2. **Ephemeral state.** The Data Feed and the Live Board's at-bat history are accumulated in browser memory and lost on reload. Every user sees a different, session-local view of the same games.
3. **Undocumented models.** `docs/MODELS.md` is an operator runbook. It does not explain what the models are, how they were trained, or what their measured performance means.

---

## 2. Verified current state

All figures measured 2026-07-29 via `execute_sql`, not estimated.

### Storage

| Table | Size | Est. rows | Read by public API? |
|---|---:|---:|---|
| `pitches` | 287 MB | 1,200,095 | **No** |
| `predictions` | 65 MB | 220,080 | Yes |
| `at_bats` | 57 MB | 309,742 | **No** |
| `picks` | 9.5 MB | 15,628 | Yes |
| `matchup_history` | 7.0 MB | 40,704 | No (model input) |
| `ingest_runs` | 3.2 MB | 10,141 | Yes (`/health`) |
| `games` | 1.1 MB | 4,120 | Yes |
| `live_state` | 384 kB | 250 | Yes |
| `player_info` | 232 kB | 1,724 | Yes |
| `pitcher_rolling_stats` | 184 kB | 575 | No (model input) |
| `batter_rolling_stats` | 144 kB | 482 | No (model input) |
| `odds` | 128 kB | 444 | Yes (flag-gated) |
| `model_params` | 64 kB | 5 | Yes (`/health`) |
| `prediction_accuracy_daily` | 64 kB | 106 | No — **nothing serves it** |
| `app_secrets` | 32 kB | 3 | Internal |
| `backfill_progress` | 24 kB | 1 | Yes (`/health`) |
| `cron.job_run_details` | 7.5 MB | 11,804 | No |
| **Database total** | **453 MB / 500 MB** | | |

`pitches` + `at_bats` = **344 MB, 76% of the database.** Every query in
`supabase/functions/api/index.ts` was traced: it reads `live_state`, `games`,
`player_info`, `predictions`, `picks`, `odds`, `model_params`, `ingest_runs`,
`backfill_progress`. **Neither `pitches` nor `at_bats` is read at serve time.**

### The only deep-history consumers

| Consumer | Reads | Window | Disposition |
|---|---|---|---|
| `train_*_cells()` × 5 | `pitches` | **all** | → warehouse |
| `refresh_matchup_history()` | `at_bats` | **all** | → warehouse |
| `refresh_pitcher_rolling_stats()` | `pitches` | 30 days | **stays in Postgres** |
| `refresh_batter_rolling_stats()` | `pitches` | 30 days | **stays in Postgres** |
| `settle` | `pitches`, `at_bats` | same-day | **stays in Postgres** |

### Pipeline state

- Migrations applied through `20260728000003`. The three files uncommitted in
  git **are already live in the database.**
- Cron jobs: `np-live-poll` (30s), `np-settle` (*/10min), `np-daily-ingest`
  (13:00 UTC), `np-prune-cron-history` (13:15 UTC). `np-backfill` and
  `np-odds-ingest` are deliberately off.
- Settlement has **caught up**: picks pending 10,047 → **29**; picks graded
  4,119 → **15,635**. The public record in `DATA-INVENTORY.md` is stale; it is
  no longer frozen.
- Predictions: 128,240 graded, 92,398 ungraded and falling. Range 2026-07-07 →
  2026-07-30 (23 days — the 21-day prune has not yet bitten).
- `pitches` spans 2025-03-27 onward.

### Models

Five active rows, **all `v1_20260707`**. No second version has ever been
written.

| Market | Type | Stored metrics | Training rows |
|---|---|---|---:|
| `pitch_result` | `multinomial_logistic` | `weighted_logloss` 1.01565, 899 cells | 1,122,199 |
| `ab_result` | `multinomial_logistic` | `weighted_logloss` 1.23678, 2,400 cells | 1,122,381 |
| `pitch_speed_ou` | `linear` + normal CDF | `sigma` 5.374, `r2_cells` 0.9686 | 1,111,519 |
| `ab_pitches_ou` | `remaining_table` | 12 count-states | 1,121,660 |
| `game_moneyline` | `log5` | `home_win_rate` 0.5359 | 3,784 games |

**Finding — scheduled retraining is broken.** `.github/workflows/train-models.yml`
runs Mondays 12:00 UTC and `train_models.py` stamps `v1_<YYYYMMDD>` on every
run. Three Mondays have passed since 2026-07-07 (07-13, 07-20, 07-27) and no new
`model_params` rows exist. No training run has succeeded in three weeks. Cause
unknown — requires reading the Actions run log.

---

## 3. Decisions

| Decision | Choice | Rationale |
|---|---|---|
| History store | **Cloudflare R2, Parquet** | 10 GB free, **zero egress** — training re-reads the whole dataset every run, which is the cost that bites on metered stores |
| Hot window | **35 days** | Keeps both `refresh_*_rolling_stats` in Postgres unchanged. Costs ~34 MB vs a 1-day window; avoids putting live model inputs behind a new pipeline |
| Compute host | **GitHub Actions** | Already in use (`train-models.yml`); batch shape, no 300 s function ceiling |
| Query engine | **DuckDB** | Reads Parquet over S3 natively; reproduces the existing cell-aggregation SQL |
| Aggregate surfaces | all four selected | model accuracy, pitcher profiles, batter profiles + H2H, velocity decay |

### Rejected

- **Supabase Pro ($25/mo, 8 GB).** Lowest total cost of ownership and zero
  pipeline work. Presented explicitly; CEO chose the offload. Retained as the
  escape hatch if the warehouse jobs prove fragile.
- **Neon free Postgres.** Same 0.5 GB ceiling — moves the wall rather than
  removing it.
- **Vercel Blob / Supabase Storage.** Metered egress and a 1 GB free tier
  respectively.

### Projected footprint

| | Before | After |
|---|---:|---:|
| `pitches` | 287 MB | ~31 MB (35 d) |
| `at_bats` | 57 MB | ~6 MB (35 d) |
| Supabase total | **453 MB** | **~146 MB** |
| R2 | — | ~350 MB raw; Parquet size **to be measured in Phase 0** |

Parquet compression is deliberately left unstated. Phase 0 measures it before
any deletion is scheduled.

---

## 4. Architecture

```
┌─ Cloudflare R2 ──────────────┐   ┌─ Supabase (500 MB cap) ─────────┐   ┌─ Vercel ─────┐
│ pitch-hawk-warehouse/        │   │ HOT (35-day window)             │   │ static       │
│  pitches/season=/month=/     │   │  pitches, at_bats               │   │ frontend     │
│  at_bats/season=/month=/     │   │ SERVE                           │   │              │
│  predictions/day=/           │   │  live_state, games, player_info │   │ reads the    │
│  _manifest.json              │   │  predictions (21 d), picks      │   │ api edge fn  │
│                              │   │ MODEL INPUTS                    │   │              │
│ full history · source of     │   │  *_rolling_stats (Postgres)     │   │              │
│ truth for training and       │   │  matchup_history  ← published   │   │              │
│ deep aggregates              │   │  *_profiles       ← published   │   │              │
└──────────────┬───────────────┘   └────────────┬────────────────────┘   └──────────────┘
               │                                 │
               └─── GitHub Actions ──────────────┘
                    nightly warehouse job (Python + DuckDB)
```

**Load-bearing property:** `pitches` and `at_bats` have no serve-time readers,
so relocating them cannot break the website.

---

## 5. The nightly warehouse job

New workflow `.github/workflows/warehouse.yml`, scheduled after
`np-daily-ingest` (13:00 UTC) has finished — **14:00 UTC**.

Five steps. **The order is the safety property.**

### 5.1 Export

Read yesterday's rows from Supabase for games in a terminal state; write
Parquet to R2.

```
s3://pitch-hawk-warehouse/pitches/season=2026/month=07/day=2026-07-28.parquet
s3://pitch-hawk-warehouse/at_bats/season=2026/month=07/day=2026-07-28.parquet
s3://pitch-hawk-warehouse/predictions/season=2026/month=07/day=2026-07-28.parquet
s3://pitch-hawk-warehouse/player_info/snapshot.parquet
s3://pitch-hawk-warehouse/games/snapshot.parquet
```

**Two snapshot datasets accompany the partitioned ones.** `player_info` (1,724
rows) and `games` (4,120 rows) are overwritten in full each run. They are not
pruned from Postgres and are not being offloaded — the warehouse copies exist
only so DuckDB can join against them mid-query without a round trip to
Supabase. `train_ab_result_cells` joins `player_info` twice for platoon splits,
and the `at_bats` date partitioning resolves through `games.official_date`
because `at_bats` has no index on `end_ts`.

Only **final** games are exported. A suspended or in-progress game is skipped
and retried the next night, so a partial game is never frozen into the
warehouse.

**`predictions` is exported too.** `prediction_accuracy_daily` keeps aggregates,
but the row-level graded predictions are the only possible input to genuine
out-of-sample model validation — which §7 establishes the project does not
currently have. Exporting them costs nothing and means that within a season
there is a real holdout evaluation set. This directly addresses the largest
methodological gap in the project.

### 5.2 Verify

Reconcile before anything is deleted:

- row count per day, Supabase vs Parquet
- `min`/`max` of the partition key
- a content checksum over the primary-key columns

Results are appended to `_manifest.json` at the bucket root:

```json
{ "pitches": { "2026-07-28": { "rows": 3781, "bytes": 412330,
                                "checksum": "…", "verified_at": "…" } } }
```

**Readers consult the manifest; they never glob.** Scoped R2
`Object Read & Write` tokens are ambiguous about bucket `LIST`, and a manifest
is more robust regardless — it doubles as the integrity record the prune step
gates on.

### 5.3 Aggregate

DuckDB over the **full** R2 dataset. Produces:

| Table | Grain | Est. rows | Replaces |
|---|---|---:|---|
| `matchup_history` | pitcher × batter | ~41,000 | existing `refresh_matchup_history()` |
| `pitcher_profiles` | pitcher × scope (season/30d) | ~1,200 | new |
| `batter_profiles` | batter × scope | ~1,400 | new |
| `pitcher_fatigue_profile` | pitcher | ~600 | new |
| `market_baselines` | market | 5 | new |

**`pitcher_fatigue_profile` design note.** The Data Feed's "is he tiring?"
story needs two halves. The *typical* decay curve — mean velocity delta by
in-game pitch-count bucket, per pitcher — is a warehouse aggregate of ~600
rows. The *current* game's trend is computed live from the 35-day hot
`pitches` table. This is why the dropped `pitcher_game_log` table is **not**
reinstated: a per-game log would be ~33,000 rows and ~7 MB for a surface that
only ever needs a per-pitcher curve plus live data.

**`market_baselines`** stores the most-common-outcome rate per market over full
history — the honest denominator for the accuracy surface. Without it, a 52.5%
win rate looks like a win instead of +6.1 points over a trivial guess.

### 5.4 Publish

Upsert the aggregates into Supabase. Total footprint under 8 MB, dominated by
the existing `matchup_history`.

Every table carries `updated_at`. `/api/health` gains a staleness check so a
silently failing job is visible on the site rather than only in GitHub.

### 5.5 Prune

**Runs only if 5.2 passed.** Deletes `pitches` and `at_bats` older than 35 days.

**Critical: `DELETE` does not return space to the OS.** Dead tuples are
reusable by the table but `pg_database_size` does not shrink, so a plain
`DELETE` would free zero measured capacity. `VACUUM FULL` needs roughly 2× the
table size in transient space — impossible at 453/500 MB — and `pg_repack` is
not available.

**The initial reclaim is therefore a table swap:**

```sql
create table pitches_new (like pitches including all);
insert into pitches_new select * from pitches
  where pitch_ts >= now() - interval '35 days';
-- inside one transaction:
drop table pitches;  alter table pitches_new rename to pitches;
```

**Peak disk during the swap is the binding constraint, and the order of the two
tables matters.** The old table is not dropped until the transaction commits, so
both copies coexist. Starting at 453 MB of a 500 MB cap:

| Step | Peak during step | After commit |
|---|---:|---:|
| Swap `at_bats` (+6 MB new, −57 MB old) | 459 MB | 402 MB |
| Swap `pitches` (+31 MB new, −287 MB old) | 433 MB | **146 MB** |

**`at_bats` must go first.** Reversing the order puts peak at 484 MB — only
16 MB of headroom, with no margin for WAL or a mistake. Doing the small table
first buys 51 MB of room before the large one is attempted.

`LIKE … INCLUDING ALL` copies indexes, unique constraints and defaults but
**not RLS policies or grants** — those must be recreated explicitly in the same
migration.

Both swaps should run in a low-traffic window: the bulk `INSERT` generates
significant WAL, and `live-poll` writes to `pitches` every 30 s during games.
Pause `np-live-poll` for the duration and resume after.

**Steady state needs no repack.** Once the window is established, each day
inserts ~3,800 rows and deletes ~3,800; autovacuum returns the space to the free
space map and new inserts reuse it. The table stabilises at ~31 MB.

**Drop the moved training RPCs in the same migration.** After the prune,
`train_*_cells()` would silently return 35 days instead of two seasons and
produce a quietly worse model. **Four** functions are dropped so that mistake is
impossible: `train_pitch_result_cells`, `train_ab_result_cells`,
`train_pitch_speed_cells`, `train_ab_pitches_cells`.

**`train_home_advantage` stays.** It reads only `games`, which the prune never
touches, so it remains a Postgres RPC and `game_moneyline` training is
unaffected. (§6 previously implied all five moved; only four do.)

---

## 6. Training migration

`train_models.py` calls five RPCs returning **weighted aggregate cells** — 899
for `pitch_result`, 2,400 for `ab_result` — so training never downloads 1.19M
rows. That design is what makes this migration tractable.

**Scope:** reimplement those five queries as DuckDB SQL over R2 Parquet,
emitting the identical cell shape. **Every `fit_*` function and all sklearn code
is unchanged.** Only the data source moves.

**Acceptance gate — non-negotiable.** Re-run training against R2 and reproduce
the stored `v1_20260707` metrics within 1%:

| Market | Target |
|---|---|
| `pitch_result` | `weighted_logloss` 1.01565 |
| `ab_result` | `weighted_logloss` 1.23678 |
| `pitch_speed_ou` | `sigma` 5.374, `r2_cells` 0.9686 |
| `game_moneyline` | `home_win_rate` 0.5359 |

If the numbers match, the DuckDB translation is correct. If they don't, the
warehouse queries are wrong and no model ships. This is the cheapest possible
guard against a silently degraded model.

`train-models.yml` gains the four R2 secrets and drops `SUPABASE_KEY` from the
read path (it still needs it to write `model_params`). **Its existing failure
must be diagnosed first** — migrating a job that is already broken would
confound the acceptance gate.

---

## 7. Objective 2 — one shared state

### The finding

`settle` already writes `predictions.result` per pitch, server-side, using
`gradeRow()` — the same rules the frontend re-implements in `gradedPred()`
(`frontend/pitchhawk-data.js:532`). **The Data Feed's graded log already exists
in the database.** It is discarded because no endpoint serves it.

This is a read-path problem and a de-duplication problem, not data capture.

### 7.1 Grading becomes single-source

Extract `gradeRow()` and `nextPitch()` from `supabase/functions/settle/index.ts`
into **`supabase/functions/_shared/grade.ts`**. Consumed by `settle` and
`live-poll`. The frontend copy is **deleted**, not ported — this removes a
duplicate implementation rather than adding a third.

### 7.2 Instant grading in `live-poll`

`live-poll` already fetches the full play-by-play each tick. After upserting
pitches it grades the prediction rows written at earlier positions in the same
pass — no extra fetch. Grading becomes near-instant instead of lagging up to
10 minutes.

`settle` remains the backstop for game-end markets (`game_moneyline`, final
`ab_result`) and for games `live-poll` missed.

### 7.3 `settle` throughput

Two defects to fix while clearing the 92,398-row backlog:

- `BATCH = 400` with **one `UPDATE` per row**. Row-at-a-time updates, not the
  batch size, are the bottleneck. Replace with a single bulk upsert per game.
- `.order("id")` ascending processes oldest-first. Correct for backlog
  drainage, and acceptable once §7.2 handles freshness.

### 7.4 New endpoints

All on the existing `api` function, all CDN-cached. **Because every user
requests the identical URL, "one state for all users" is a property of the
cache** — one origin query per TTL per game regardless of concurrent users.

| Endpoint | Returns | TTL |
|---|---|---:|
| `GET /feed/{game_pk}` | completed at-bats for that game with per-pitch graded predictions, newest first, `?limit=` (default 50 ABs) | 10 s |
| `GET /feed/today` | cross-game graded pitch log, keyset-paginated on `predictions.id` | 15 s |
| `GET /accuracy?days=30` | `prediction_accuracy_daily` joined to `market_baselines` | 300 s |

`/feed/{game_pk}` payload shape:

```
{ game_pk, updated_at,
  at_bats: [ { at_bat_index, inning, half, pitcher, batter, result, pitch_count,
               pitches:     [ { pitch_number, type, speed, zone, description,
                                result_category, balls, strikes } ],
               predictions: [ { market, recommendation, confidence, line,
                                predicted_value, result } ] } ],
  totals: { graded, correct, by_market: { … } } }
```

Null fields are omitted to keep the payload small — a full game is ~300
pitches and ~76 at-bats.

**Retention boundary:** `predictions` keeps 21 days, so the feed reaches back 21
days and no further. Games older than that return at-bat data (35-day hot
window) with no predictions attached. Acceptable; must be stated in the UI
rather than rendered as an empty state.

### 7.5 Frontend

**Delete** from `frontend/pitchhawk.js`: `trackAtBats`, `trackGradedLog`,
`summarizePa`, and the `paHist` / `paWatch` / `gradedLog` / `_seenPitch`
instance state. **Delete** the grading branch of `gradedPred` in
`frontend/pitchhawk-data.js`; keep its row-shaping.

**Add:** hydrate `/feed/{game_pk}` on boot and on game switch; append from the
existing poll. A user joining in the 7th inning sees exactly what a user who
watched from the 1st sees.

---

## 8. Objective 3 — rewrite `docs/MODELS.md`

Audience: a data scientist who knows MLB data and nothing about this app.
**No new calculations** — document what is stored, and state plainly what is not.

### Sections

1. **What the app predicts** — the five markets in baseball terms
2. **Data** — 1.19M pitches / 308K PAs, per-pitch and per-PA fields, 99.96%
   completeness; what is *not* captured (base state, in-game pitch count, times
   through order, score at pitch time) and why that matters
3. **Runtime path** — `live-poll` → `loadActiveModels()` → `model.ts`
   `predict*` → a `predictions` row → CDN-cached `/live`
4. **The five models** — algorithm, features, `params` JSON shape, stored
   metrics (table in §2 above)
5. **Training** — the weighted-cell aggregation trick and why it exists
   (millions of rows, tiny transfer); sklearn config: `LogisticRegression(C=10,
   max_iter=2000)`, sample-weighted by cell count
6. **What validation exists, and what does not** ← *the most important section*
7. **Live track record** — `prediction_accuracy_daily`, how to read it against
   `market_baselines`
8. **Replacing a model** — the `scripts/models.py` lifecycle, the 2% quality
   gate, `activate_model` / `rollback_model`
9. **Adding a model type** — extend `model.ts`, `featureValue()`, redeploy
10. **Known weaknesses** — the two sub-baseline markets and the two competing
    explanations

### Findings added after tracing the scorer (2026-07-29)

Four things surfaced while reading `_shared/model.ts` and `predictions` that the
document must carry. All are verified; details in
`docs/superpowers/plans/2026-07-29-models-onboarding-doc.md`.

1. **`game_moneyline`'s trained model has never scored a live prediction.** All
   48,964 moneyline rows are stamped `mlb_winprob_v1` — `live-poll` relays MLB's
   own `/game/{pk}/winProbability` feed. The trained `log5` model is called only
   by `odds-ingest`, which is deliberately unscheduled. **The 70.8% headline in
   *Model performance* above is MLB's feed, not this app's model.**
2. **`ab_pitches_ou`'s `heuristic_v0` fallback went 2–2,484** across 2,596 rows.
   Not underperformance — a defect in the missing-table-cell branch of
   `predictAbPitches`.
3. **`ab_result` probabilities are knowingly miscalibrated and patched.**
   `CALIB_SHRINK = 0.7` shrinks output toward the league prior because graded
   picks showed model probability running ~1.4× the realized rate. Served
   probabilities are not the model's raw output.
4. **`pitcher_bb_delta` trains as a hardcoded 0.0** but is computed for real at
   scoring time — training and serving disagree on one of six `ab_result`
   features.

### The honest core of §6

- **No holdout validation exists.** Every stored metric is in-sample, computed
  on the weighted training cells.
- **`r2_cells = 0.9686` is R² against *cell means*, not per-pitch.** It measures
  how well a line fits ~900 pre-averaged points. It is not predictive skill and
  should not be read as such.
- That single fact reconciles the apparent contradiction in
  `DATA-INVENTORY.md`: `pitch_speed_ou` reads as near-perfect in training
  (0.9686) and **47.3% live, below a coin flip.** There is no paradox — the
  training metric never measured the thing the live number measures.
- Measured live performance against correct baselines (from
  `DATA-INVENTORY.md`, 14,352 graded predictions per market): moneyline 70.8%
  vs 53.5%; AB pitch count 56.4% vs 50.0%; at-bat result 52.5% vs 46.4%;
  next-pitch speed 47.3% vs 50.0%; next-pitch result 44.8% vs 46.4%.
- **The fix is now structural:** §5.1 exports row-level `predictions` to R2, so
  a real out-of-sample evaluation set accumulates from day one of Phase 0.

---

## 9. Schema changes

### New tables (published nightly, RLS + public read, matching existing convention)

| Table | Key | Notes |
|---|---|---|
| `pitcher_profiles` | `(pitcher_id, scope)` | `scope ∈ {'career','season','d30'}` |
| `batter_profiles` | `(batter_id, scope)` | same `scope` domain |
| `pitcher_fatigue_profile` | `(pitcher_id)` | velocity delta by in-game pitch-count bucket |
| `market_baselines` | `(market)` | most-common-outcome rate over full history |

`scope = 'd30'` intentionally duplicates what `pitcher_rolling_stats` already
computes in Postgres. The Postgres version stays authoritative for **live
scoring** (it is what `model.ts` reads); the warehouse version exists only for
the Data Feed's display surfaces. Keeping them separate means a warehouse
outage degrades a display, never live scoring.

### Dropped

- `train_pitch_result_cells`, `train_ab_result_cells`,
  `train_pitch_speed_cells`, `train_ab_pitches_cells` — unsafe post-prune (§5.5)
- `refresh_matchup_history()` — moves to the warehouse

**Kept:** `train_home_advantage` — reads only `games`, never pruned.

### Rebuilt

- `pitches`, `at_bats` — table swap for the one-time reclaim (§5.5)

### Unchanged

`refresh_pitcher_rolling_stats()`, `refresh_batter_rolling_stats()`,
`rollup_prediction_accuracy()`, `prune_predictions()`, `prune_ingest_runs()`,
`pick_record()`, `activate_model()`, `rollback_model()`.

---

## 10. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Pruning against a bad export — irreversible data loss | **High** | Verify-before-prune ordering; export-only soak for two weeks; prune gated on the manifest |
| `DELETE` frees no measured space | **High** | Table swap, not `VACUUM FULL` (§5.5) — the naive approach cannot work at 90% capacity |
| Running out of disk *during* the swap | **High** | `at_bats` first, then `pitches` — peak 459 MB vs 484 MB if reversed (§5.5). Pause `np-live-poll`; low-traffic window |
| Rewritten training silently degrades the model | **High** | Must reproduce `v1_20260707` metrics within 1% before anything ships (§6) |
| Table swap loses RLS policies | **Medium** | `LIKE INCLUDING ALL` omits policies and grants; recreate explicitly and assert in CI |
| Warehouse job fails silently, `matchup_history` goes stale, live model loses features | **Medium** | `updated_at` staleness surfaced in `/api/health`; job writes to `ingest_runs` |
| Someone trains on the truncated window | **Medium** | Training RPCs dropped in the prune migration |
| `train-models.yml` already broken | **Medium** | Diagnose *before* migrating it, or the acceptance gate is confounded |
| Parquet size unknown | Low | Measured in Phase 0, before any deletion |

---

## 11. Phasing

Objectives 2 and 3 have **no dependency** on objective 1 and can run in
parallel.

### Prerequisites (CEO — R2 secrets already added ✓)

- [x] R2 bucket `pitch-hawk-warehouse`, `ENAM`, private
- [x] Scoped `Object Read & Write` token; four secrets in GitHub Actions
- [ ] Same four values in a local gitignored `.env` for pre-scheduling tests
- [ ] `gh auth login` so the `train-models.yml` failure can be read
- [ ] Confirm whether `mlb-next-pitch` is public or private

### Phase 0 — export only, nothing deleted
Warehouse workflow with export + verify + manifest. Backfill all history to R2.
**Acceptance:** manifest reconciles for every day; measured Parquet size
reported. **Zero risk — no deletion path exists yet.**

### Phase 1 — reclaim capacity
Table-swap migration, 35-day window, drop training RPCs, daily prune wired to
the manifest gate.
**Acceptance:** `pg_database_size` ≤ 200 MB; API responses byte-identical
before and after; RLS policies verified present.
*This is the phase that solves the capacity problem.*

### Phase 2 — training on the warehouse
DuckDB translations of the five cell queries; `train_models.py` data source
swapped; `train-models.yml` failure fixed.
**Acceptance:** reproduces all four `v1_20260707` metrics within 1%.

### Phase 3 — aggregates
Four new tables computed in DuckDB and published nightly; `matchup_history`
refresh moved; health staleness checks.
**Acceptance:** recomputed `matchup_history` matches the current 40,704 rows;
profiles populated for every active player.

### Phase 4 — shared live state
`_shared/grade.ts`; inline grading in `live-poll`; bulk-upsert `settle`; three
new endpoints; frontend hydration and deletions.
**Acceptance:** a hard reload mid-game reproduces the full feed; two
simultaneous clients render identical content; the 92,398-row backlog is clear.

### Phase 5 — `docs/MODELS.md`
Ten sections per §8. **Acceptance:** every factual claim traceable to a
verified query in this spec; §6 states the absence of holdout validation
without hedging.

---

## 12. Out of scope — flagged findings

Not part of this work; recorded because they were found while tracing it.

1. **The Upcoming / on-deck board displays synthetic numbers as model output.**
   `perturbUpcoming()` (`frontend/pitchhawk-data.js:375`) derives the on-deck
   book by applying random jitter to the live book, and `loadLive()` calls
   `enrichUpcoming()` on real data. For an app that publishes a win/loss
   record, showing randomised values in the same visual language as genuine
   predictions is a credibility risk. **Recommendation: hide the Upcoming
   toggle until a real on-deck projection exists.** Needs a CEO decision.

2. **`result_detail` is still collapsed to `hit`.** `at_bats.result_detail`
   already distinguishes home runs, doubles and triples. Once the warehouse
   exists, HR/XBH/total-bases surfaces are a DuckDB query away with zero new
   capture. The cheapest feature on the roadmap after this work.

3. **Base state, in-game pitch count, times-through-order remain uncaptured.**
   These are the leading hypothesis for why the two next-pitch markets are
   sub-baseline. The MLB feed already returns base state; ingest discards it.
   Worth reconsidering once Phase 1 has freed ~300 MB.

4. **`odds` holds 444 stale rows** behind a disabled flag. Deciding never to
   ship wagering would let a meaningful amount of code and schema be deleted.
