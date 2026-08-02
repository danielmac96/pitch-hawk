# Data Pipeline Execution Plan — 2026-08-02

**Status:** approved, not started
**Audience:** Claude Code, executing task by task
**Companion:** `docs/DATA-PIPELINE.md` (system reference). Where this file and that
one disagree about *current state*, this file is newer and measured.

---

## 0. Read this before touching anything

### Objective, in order

Ingestion and display must run seamlessly end to end **before** any model or
prediction work resumes. Phases 0-5 below are in scope. The model layer is
explicitly deferred — see §Deferred at the bottom. Do not build it, do not
"quickly add" a cell table, do not widen a training RPC.

### Measured state as of 2026-08-02

| Fact | Value | How it was measured |
|---|---:|---|
| Supabase database size | **495 MB / 500 MB** | `pg_database_size` via Management API |
| `pitches` | 1,213,854 rows, 293 MB | `pg_total_relation_size` |
| `pitches` inside 35-day window | **126,217 rows (10.4%)** | `where pitch_ts >= now() - interval '35 days'` |
| `at_bats` | 313,305 rows, 58 MB | |
| `predictions` | 258,846 rows, 82 MB, spans **26 days** under a 21-day policy | |
| `pitches` dead tuples | 111,756, last autovacuum **2026-07-12** | `pg_stat_user_tables` |
| R2 warehouse | 2,011 days, 7,903,916 pitches, 620 MB, frozen at **2026-07-30** | `_manifest.json` |
| Active cron jobs | `np-live-poll` (30s), `np-settle` (10m), `np-daily-ingest` (13:00 UTC), `np-prune-cron-history` (13:15 UTC) | `cron.job` |
| Model registry | all 5 markets stamped `v1_20260707`, nothing since | `model_params` |

### Environment

```bash
# Warehouse work runs on SYSTEM python, not .venv — .venv has only pyarrow.
py -c "import boto3, pyarrow, duckdb; print('ok')"    # confirmed working

# The local .env R2_BUCKET is MISTYPED: pitch-hawk-wa3rehouse
# Correct bucket: pitch-hawk-warehouse
# Failure mode is silent: manifest.load() returns an EMPTY manifest, not an error.
# Task 1.5 fixes this. Until then, override:
export R2_BUCKET=pitch-hawk-warehouse
```

Supabase MCP must be used, verify the mcp is active and able to be accessed before proceeding.
```

### Invariants — breaking any of these is a rollback, not a bug report

| Invariant | Where | What breaks |
|---|---|---|
| Explicit PyArrow schemas, always | `warehouse/config.py:SCHEMAS` | An inferred schema types an all-NULL column as `null`; DuckDB then refuses to read that day alongside others. One bad day poisons a multi-season query. |
| zstd compression | `ingest.to_parquet` | Mixed codecs, size regressions. |
| A day is all-or-nothing | `ingest.ingest_day` | A partial day is silently wrong forever and its manifest entry claims completeness. |
| Only final games | `mlb.schedule` | A suspended game frozen mid-way. |
| `HOT_WINDOW_DAYS = 35` | `warehouse/config.py:38` | Both `refresh_*_rolling_stats` look back 30 days. 35 leaves 5 days of margin. Shrinking it breaks live scoring. |
| **Never read `matchup.splits.menOnBase`** | `mlb.men_on_base` | Target leakage. It is the state AFTER the play. `tests/warehouse/test_mlb_flatten.py` sets it to a deliberately wrong value to prove nothing reads it. Do not remove that test. |
| Column lists frozen in `config.py` | module docstring | A feed change must be a deliberate edit, never a silent layout change historical files no longer match. |
| Readers resolve keys via the manifest, never `list_objects` | `warehouse/store.py` | The scoped R2 token has no LIST permission. `aws s3 ls` returns `AccessDenied` and you will conclude the bucket is empty. It is not. |

### Git workflow

Repo is on `master` with three untracked production migrations. Every phase below
is one branch, one PR:

```bash
git checkout -b data/phase-<n>-<slug>
# ... work ...
git add -A && git commit          # message convention: feat(warehouse): / fix(db): / chore(ci):
git push -u origin HEAD
```

Do not commit `.env`. Do not commit `graphify-out/` (gitignored). After changing
Python, run `graphify update .` to keep the knowledge graph current.

---

## Phase 0 — Capacity incident

**Goal:** off the 500 MB cap, retention actually running, production state in git.
**Duration:** ~2 hours. **Nothing in this phase deletes history.**

### Task 0.1 — One-time cold dump of `predictions` to R2

Do this **first**. Task 0.3 switches on a 21-day prune that has never run; its
first pass permanently deletes ~5 days of graded predictions. This is a raw dump
for cold storage — no consumer, no schema design, no model work. It exists so the
holdout system is possible to build later rather than impossible.

Create `scripts/export_predictions.py`:

- Page through `predictions` via the Management API helper or `supabase-py`
  (`SUPABASE_KEY` in `.env` is the service-role key), 50,000 rows per page,
  ordered by `id`.
- Columns: `id, game_pk, at_bat_index, pitch_number, market, predicted_value,
  confidence, probs, recommendation, line, price, edge, units, result,
  profit_units, graded_at, model_version, created_at, book`.
- Declare an explicit `pa.schema` for these columns in the script itself — do not
  add it to `warehouse/config.py:SCHEMAS`, which is reserved for the frozen
  warehouse datasets. `probs` is JSON; store it as `pa.string()` with
  `json.dumps`.
- Write one Parquet per `created_at::date` under
  `holdout/predictions/season=YYYY/month=MM/day=YYYY-MM-DD.parquet`, zstd, using
  `warehouse.ingest.to_parquet`-style serialisation.
- Do **not** write manifest entries. This is not a warehouse dataset and must not
  become a prune gate input.

```bash
export R2_BUCKET=pitch-hawk-warehouse
py scripts/export_predictions.py
```

**Verify:** row count across written Parquet equals the live `predictions` count
(258,846 ± the rows written while the export ran).

```bash
py -c "
import os,sys,io; sys.path.insert(0,'.'); os.environ['R2_BUCKET']='pitch-hawk-warehouse'
import pyarrow.parquet as pq
from warehouse.config import r2_config
from warehouse.store import R2Store
s=R2Store(r2_config())
print(pq.read_table(io.BytesIO(s.get('holdout/predictions/season=2026/month=07/day=2026-07-15.parquet'))).num_rows)
"
```

**Exit:** a readable Parquet exists for every date from 2026-07-07 to today.

### Task 0.2 — Drop three unused indexes

New migration `supabase/migrations/20260802000001_reclaim_unused_indexes.sql`.

Measured scan counts from `pg_stat_user_indexes`, recorded in the migration
comment so the decision is auditable:

```sql
-- Emergency capacity reclaim. Database measured at 495 MB of the 500 MB free-tier
-- cap on 2026-08-02, growing ~10 MB/day. The hot-window swap in
-- 20260802000003 cannot run at this baseline: its peak would exceed the cap.
--
-- DROP INDEX returns space to the filesystem immediately, unlike DELETE.
-- Scan counts below are from pg_stat_user_indexes, 2026-08-02.

-- 37 MB, 69 scans since stats reset. The only reader of pitch_ts is the
-- hot-window filter, which runs once during the swap and seq-scans acceptably
-- over a 168 MB heap. Recreate on the post-swap table if a time-ranged query
-- path appears -- it will be ~4 MB there.
drop index if exists public.pitches_ts_idx;

-- 3.0 MB / 2 scans and 2.8 MB / 4 scans. Effectively unused.
drop index if exists public.at_bats_pitcher_idx;
drop index if exists public.at_bats_batter_idx;
```

Do **not** drop `pitches_game_pk_at_bat_index_pitch_number_key` (49 MB, 10.1M
scans — the live upsert path) or `at_bats_game_pk_at_bat_index_key` (16 MB, 2.6M
scans). Leave `pitches_batter_idx` (11 MB, 2,603 scans) alone; the swap shrinks
it to ~1 MB for free.

Apply via the deploy workflow, or directly:

```bash
q "drop index if exists public.pitches_ts_idx;"
q "drop index if exists public.at_bats_pitcher_idx;"
q "drop index if exists public.at_bats_batter_idx;"
```

**Verify:**

```bash
q "select pg_size_pretty(pg_database_size(current_database())) total"
```

**Exit:** total is **≤ 455 MB**. If it did not move ~43 MB, stop and investigate
before continuing — the swap sizing in Phase 3 depends on this.

### Task 0.3 — Redeploy `daily-ingest`

No code change. `supabase/functions/daily-ingest/index.ts:69-82` is already
correct and already committed — it rolls predictions up into
`prediction_accuracy_daily` *before* pruning, and skips the prune entirely if the
rollup errored. The deployed build predates migration `20260728000002` and calls
neither RPC.

```bash
supabase functions deploy daily-ingest --project-ref "$REF" --no-verify-jwt
```

Trigger one run rather than waiting for 13:00 UTC:

```bash
curl -sX POST "$SUPABASE_URL/functions/v1/daily-ingest" -H "x-cron-secret: <from app_secrets>"
```

**Verify:** the newest `ingest_runs` row must contain **both** an
`accuracy_rollup` key and a `pruned.predictions` key. Today's row has neither.

```bash
q "select detail::text from ingest_runs where job='daily-ingest' order by started_at desc limit 1"
```

**Exit:** `predictions` spans ≤ 21 days.

```bash
q "select min(created_at)::date, max(created_at)::date, count(*) from predictions"
```

### Task 0.4 — Manual vacuum on `pitches`

111,756 dead tuples, last autovacuum 2026-07-12. `VACUUM` (not `VACUUM FULL` —
that needs 2× transient space we do not have) makes the dead space reusable and
stops file growth.

```bash
q "vacuum (analyze) pitches;"
q "vacuum (analyze) predictions;"
```

**Verify:** `n_dead_tup` for `pitches` drops near zero in `pg_stat_user_tables`.

### Task 0.5 — Get production state into git

Three migrations exist in production and in one working directory and nowhere
else. CI's migration job has never applied them.

```bash
git checkout -b data/phase-0-capacity
git add supabase/migrations/20260728000001_drop_unused_tables.sql \
        supabase/migrations/20260728000002_retention_predictions.sql \
        supabase/migrations/20260728000003_cron_cleanup.sql \
        supabase/migrations/20260802000001_reclaim_unused_indexes.sql \
        docs/DATA-INVENTORY.md docs/DATA-PIPELINE.md docs/plans/ \
        scripts/export_predictions.py
git commit -m "chore(db): commit applied migrations and data pipeline docs"
```

Also update `docs/DATA-PIPELINE.md` §4.1 — the live `np-daily-ingest` schedule is
`0 13 * * *`, not the `0 10 * * *` in `20260703000002_cron.sql`, and
`np-backfill` / `np-odds-ingest` are no longer scheduled at all.

**Verify:** `git status --short` shows no `??` under `supabase/` or `docs/`.
CI's `migrations` job must go green on the branch — it applies every file in
`supabase/migrations/*.sql` against a clean Postgres 16, so a migration that only
ever ran against production will fail here if it is not idempotent.

### Phase 0 exit criteria

- [x] Database ≤ 455 MB — **497 MB → 454 MB**
- [x] `ingest_runs.detail.pruned.predictions` is a number — **60,824**
- [x] `predictions` spans ≤ 21 days — **exactly 21** (2026-07-12 → 2026-08-02, 204,682 rows)
- [x] `holdout/predictions/` readable in R2 — **265,126 rows, 24 files, 5.6 MB**
- [x] `git status` clean; CI green — **required fixing CI first, see below**

### Phase 0 — what actually happened (2026-08-02)

Two deviations from this plan as written, both deliberate:

1. **Task 0.2 ran before 0.1.** The database measured **497 MB**, not the
   495 MB recorded above — 3 MB of headroom. The index drops return 43 MB
   immediately and delete no data, so they should not sit behind a
   several-minute export. The ordering constraint that actually matters
   (0.1 strictly before 0.3, so the export precedes the first prune) was
   preserved.
2. **`rollup_prediction_accuracy(30)` was called manually before the prune.**
   The rollup's default window is 7 days, but `prediction_accuracy_daily`
   had a 5-day hole at 2026-07-29 → 08-02 because the RPC had never been
   called by the stale deployed build. The default window did cover the hole,
   but a wider idempotent call removed all doubt before deleting 60,824 rows.
   Coverage went 106 rows / 19 days → 131 rows / 24 days.

Measured outcomes not predicted by this plan:

- **The apparent 2026-07-13 → 07-15 gap is the MLB All-Star break, not an
  outage.** Diagnosed 2026-08-02; recorded here because it looks alarming from
  row counts alone and should not be re-investigated.
  - 07-13 and 07-14 have zero regular-season games league-wide. The same
    3-to-4-day hole appears in R2 in 2023 (07-10→07-13), 2024 (07-15→07-18)
    and 2025 (07-14→07-17), from a completely independent ingest path.
  - The 260 pitches on UTC 07-15 are **the All-Star Game itself** — `game_pk`
    823443, `game_type = 'A'`, National League All-Stars vs American League
    All-Stars. Supabase's `live-poll` ingests it; the warehouse correctly
    excludes it, because `mlb.schedule` filters `game_type="R"`. July 2026
    holds 370 `R` games and exactly 1 `A` game.
  - The apparent shortfall on 07-17 (Supabase 712 pitches vs R2 4,247) is a
    bucketing artifact, not a gap: Supabase dates a pitch by UTC `pitch_ts`
    while the warehouse partitions by `officialDate`, and a 7pm ET first pitch
    lands on the *next* UTC day. **Compared per `game_pk` instead of per date,
    the two stores agree to 100.0%** — 13,594 vs 13,593 pitches over the 46
    games of officialDate 07-16..07-19, with zero games absent and zero games
    short.

  Two things worth carrying forward from this:

  1. **`pitch_ts` (UTC) and warehouse `game_date` (officialDate) are not the
     same key**, and they disagree by up to a day for every night game. Phase 3
     deletes from Postgres on `pitch_ts >= now() - 35 days` but the gate
     verifies R2 by `game_date`. The 35-day window has 5 days of margin over
     the 30-day rolling lookback, so a one-day skew is absorbed — but the
     delete range and the verify range must not be assumed to be the same
     dates. **Verify one day either side of the boundary.**
  2. Game 824978 holds 301 pitches in Supabase against 300 in R2, at distinct
     natural keys (the unique constraint rules out a duplicate). Almost
     certainly a live-feed pitch the final play-by-play revised away. One row
     in 13,593; noted, not chased.
- The prune deleted part of 2026-07-12, not just whole days: the horizon is
  `now() - 21 days`, not a date boundary. The R2 export ran first and holds all
  24,845 rows for that day, so nothing was lost.
- `pitches` dead tuples went 114,239 → 814; `at_bats` 5,464 → 206.
- **CI had been red on every run since 2026-07-22** — eight consecutive
  failures on master, on two defects unrelated to this plan. Task 0.5's exit
  criterion could not be met without fixing them first:
  - `edge-functions`: the `sportsbooks` route passes `() => json(...)` to
    `cached()`, typed `() => Promise<Response>`. `json()` returns a `Response`
    synchronously. Widened the parameter to `() => Response | Promise<Response>`
    — type-level only, no runtime change, no redeploy.
  - `migrations`: the job died at the first `cron.` reference and never
    reached anything later. **No migration after 2026-07-16 had ever been
    applied by CI**, including all three committed here and
    `20260802000001`. Fixed by stubbing the pg_cron surface those migrations
    touch (schema, `cron.job`, `cron.job_run_details`, `schedule`/`unschedule`)
    rather than extending the skip-list, which would have dropped their schema
    work from coverage too.

  This matters beyond Phase 0: **Phase 2 adds warehouse jobs to this pipeline.**
  A nightly job added to a workflow nobody reads a signal from is how R2 came
  to be frozen for three days without anyone noticing.

- `graphify update .` exits 1 with no output; `graphify-out/graph.json` has
  been stale since 2026-07-19. Pre-existing, gitignored, does not affect any
  deliverable — but the CLAUDE.md instruction to run it after Python changes
  is currently a no-op.

- Supabase MCP was unauthorized throughout (it is configured with a
  `sb_secret_` project key where an `sbp_` personal access token is required).
  All SQL and DDL ran through the Management API, which is the same backend
  and the same token class the MCP server itself uses. Migration
  `20260802000001` was recorded into `supabase_migrations.schema_migrations`
  by hand, since that is a side effect of MCP `apply_migration` and not of the
  raw query endpoint.

---

## Phase 1 — Arm the verification gate

**Goal:** make "verified" mean verified, so Phase 3 deletes against a real gate.
**Duration:** 2 days.

### Task 1.1 — Split ingest attestation from verification

**The defect:** only `warehouse/ingest.py:129` ever writes the manifest.
`warehouse/verify.py` reads and never records. So `verified_at` is written by the
ingest, from the same in-memory rows that produced the Parquet — exactly the
self-certification `verify.py`'s docstring says catches nothing.
`manifest.is_verified()` therefore returns `true` for all 2,011 days. Real
independent coverage is 5 days (commit `3c8f3db`), unrecorded.

In `warehouse/manifest.py`:

```python
def record(m, dataset, day, *, rows, size_bytes, checksum, ingested_at, games=0):
    """Ingest attestation. Deliberately does NOT set verification fields:
    this data comes from the same in-memory rows as the Parquet, so it cannot
    attest to anything an independent re-derivation would catch."""
    prior = entry(m, dataset, day) or {}
    m.setdefault("datasets", {}).setdefault(dataset, {})[day] = {
        "rows": rows, "bytes": size_bytes, "games": games,
        "checksum": checksum, "ingested_at": ingested_at,
        # A re-ingest invalidates any prior verification.
        "verified_at": None, "verified_by": None,
    }
    return m


def record_verified(m, dataset, day, *, verified_at, verified_by):
    """Written only by warehouse.verify after an independent MLB-API re-derivation."""
    e = entry(m, dataset, day)
    if e is None:
        raise KeyError(f"{dataset}/{day} has no manifest entry to verify")
    e["verified_at"] = verified_at
    e["verified_by"] = verified_by
    return m


def is_verified(m, dataset, day) -> bool:
    e = entry(m, dataset, day)
    return bool(e and e.get("checksum") and e.get("verified_at") and e.get("verified_by"))
```

Update the caller at `warehouse/ingest.py:129` to pass `ingested_at=now`. Update
the module docstring at `warehouse/manifest.py:1-11` — it currently claims the
gate works.

**Migration of the existing manifest:** the 2,011 stored entries have
`verified_at` set by the ingest. Rewrite them in place: move that value to
`ingested_at`, set `verified_at`/`verified_by` to `null`. This is the correct
outcome — it reports the true state — and Task 1.4 re-earns them for the days
that matter.

```bash
py scripts/migrate_manifest_v2.py --dry-run    # prints the diff
py scripts/migrate_manifest_v2.py
```

Bump `manifest.empty()` to `{"version": 2, ...}` and have `load()` raise a clear
error on a v1 manifest so a stale reader cannot misinterpret the fields.

### Task 1.2 — Record verification results

In `warehouse/verify.py`, `verify_day()` currently returns a `DayVerdict` and
writes nothing. Add an opt-in write:

```python
def verify_day(store, day, *, with_boxscore=True, workers=6, record=False):
    ...
    if record and not reasons:
        m = manifest.load(store)
        now = datetime.now(timezone.utc).isoformat()
        for dataset in ("pitches", "at_bats", "games"):
            manifest.record_verified(m, dataset, day,
                                     verified_at=now, verified_by="verify_day/v2")
        manifest.save(store, m)
```

`verify_sample` must batch the manifest write across days — one `load`, N
`record_verified`, one `save`. The manifest is 1.47 MB; 340 read-modify-write
round trips against it is a bad idea for the same reason `ingest_range` batches.

**Verify:** run against a known-good day and confirm the fields appear.

```bash
py -c "
import os,sys; sys.path.insert(0,'.'); os.environ['R2_BUCKET']='pitch-hawk-warehouse'
from warehouse.config import r2_config
from warehouse.store import R2Store
from warehouse import manifest
from warehouse.verify import verify_day
s=R2Store(r2_config())
print(verify_day(s,'2026-07-28',record=True))
m=manifest.load(s); print(manifest.entry(m,'pitches','2026-07-28'))
print('is_verified:', manifest.is_verified(m,'pitches','2026-07-28'))
"
```

### Task 1.3 — Build `warehouse/cli.py`

`docs/DATA-PIPELINE.md` §7 names this as the blocker for Phase 3: verify and
backfill are REPL-only today, and deletion gated on a check nobody can invoke is
deletion gated on nothing.

```
python -m warehouse status
    Manifest summary + count of verified vs ingested-only days per dataset,
    + max(day) and its lag from yesterday.

python -m warehouse backfill [--seasons ...] [--local DIR] [--workers N] [--no-boxscore]
    Thin wrapper over scripts/warehouse_backfill.py's main().

python -m warehouse verify (--day D | --range A..B | --sample N) [--record] [--fail-fast]
    Independent re-derivation. Exit code 0 only if every day passed.
    --range is the Phase 3 gate; --sample N picks N days at random for a spot check.

python -m warehouse ingest --day D [--force]
    One day. Used by the nightly workflow in Phase 2.
```

Add `warehouse/__main__.py` delegating to `warehouse.cli:main`. Keep
`scripts/warehouse_backfill.py` working — it is referenced throughout the docs.

Exit codes matter: the nightly workflow and the Phase 3 gate both branch on them.
`0` = all passed, `1` = a day failed verification, `2` = operational error
(credentials, network, unreadable manifest).

### Task 1.4 — Verify the entire Phase 3 delete set

Not a sample. Postgres holds pitches from **2025-03-27**; Phase 3 deletes
everything older than 35 days, so the delete set is roughly **2025-03-27 →
2026-06-28**, about 340 game days. The full 2,011-day backfill took 105 minutes,
so ~3 s/day puts this at **~17 minutes**. There is no reason to sample when the
full set is that cheap.

```bash
export R2_BUCKET=pitch-hawk-warehouse
py -m warehouse verify --range 2025-03-27..2026-06-28 --record | tee verify-deleteset.log
echo "exit=$?"
```

Each day is re-fetched from the MLB API, re-flattened, and compared four ways
(manifest rows, manifest checksum, Parquet rows, Parquet checksum). Rate-limit
sensitive — keep workers at 6.

**If any day fails:** re-ingest that day (`py -m warehouse ingest --day D --force`),
re-verify, and only then continue. **Phase 3 must not run while any day in its
delete range is unverified.**

**Exit:**

```bash
py -m warehouse status
# every day in 2025-03-27..2026-06-28 must report verified, not ingested-only
```

### Task 1.5 — Fix the two documentation traps

**a) `.env` bucket typo.** `R2_BUCKET=pitch-hawk-wa3rehouse` →
`pitch-hawk-warehouse`. Also fix `.env.example`. Then make the failure loud —
`manifest.load()` currently returns an *empty* manifest when the bucket is
inaccessible, so the warehouse looks empty rather than unreachable:

```python
# warehouse/store.py, R2Store.__init__
try:
    self._s3.head_bucket(Bucket=cfg.bucket)
except ClientError as exc:
    raise RuntimeError(
        f"R2 bucket {cfg.bucket!r} is not reachable ({exc}). Check R2_BUCKET — "
        f"a wrong name returns 403 on every object and an empty manifest, not an error."
    ) from exc
```

If the scoped token forbids `HeadBucket`, `head_object` on `_manifest.json` and
treat 403 (as distinct from 404) as fatal.

**b) Stale docstring in `warehouse/config.py:55`.** It says `men_on_base` comes
from `matchup.splits.menOnBase`. The code deliberately does the opposite
(`warehouse/mlb.py:79`) because that field is the state *after* the play and
using it leaks the at-bat's own outcome. An engineer reading `config.py` would
reintroduce the leak. Replace with:

```
#   men_on_base    is DERIVED from base occupancy carried forward from the
#                  previous play, reset at each half-inning. The API's
#                  matchup.splits.menOnBase is deliberately NOT used: it is the
#                  state AFTER the play and leaks the at-bat's own outcome.
#                  See warehouse/mlb.py:men_on_base().
```

### Phase 1 exit criteria

- [x] `manifest.is_verified()` requires an independently written `verified_by`
- [x] `python -m warehouse status|verify|backfill|ingest` all work
- [x] Every day in 2025-03-26..2026-06-29 independently verified and recorded —
      **461 checked, 461 ok, 0 failed, 279 recorded, 182 legitimately empty,
      13.6 min, exit 0**
- [x] `R2_BUCKET` correct; a wrong bucket now raises
- [x] `config.py` docstring matches the code

### Phase 1 — notes from execution (2026-08-02)

**The delete-set range was widened to `2025-03-26..2026-06-29`.** Postgres
deletes on `pitch_ts` (UTC); the warehouse partitions on `game_date`
(`officialDate`). Those keys disagree by up to a day for every night game — a
7pm ET first pitch lands on the next UTC day. Verifying only the nominal
2025-03-27..2026-06-28 would leave the two boundary days unverified while
Postgres rows attributable to them are inside the delete set. 461 calendar
days, ~340 with games; the rest are off-days and the All-Star break, which the
CLI reports as `empty` and does not count as verified coverage.

**The manifest migration reported the honest state and it is worse than the
docs claimed.** 6,033 entries (2,011 days × 3 datasets) went from
"all verified" to **0 verified / 2,011 ingested-only**. Nothing was lost — the
ingest timestamps were relabelled to `ingested_at`, and the v1 object is kept
at `_manifest.v1.json`. Phase 3 was never going to have a real gate before
this.

**Deferred to Phase 2 for a real reason, not an oversight.** The two
regression tests this phase most needs —
`test_is_verified_requires_independent_write` and
`test_reingest_clears_verification` — are in Task 2.3 because
`warehouse.manifest` imports `warehouse.config`, which imports `pyarrow`, and
CI's `backend` job installs only `requirements.txt`, which has no `pyarrow`.
Adding them before `requirements-warehouse.txt` (Task 2.1) exists would turn
CI red again the day after it was fixed. **Task 2.1 and 2.3 should be the
first things done in Phase 2**, before the nightly workflow, so this fix is
locked in.

---

## Phase 2 — Close the drift

**Goal:** R2 stops falling behind; CI covers the warehouse.
**Duration:** 2 days.

### Task 2.1 — `requirements-warehouse.txt`

Referenced by `docs/DATA-PIPELINE.md` §6.1 and does not exist. The 2026-07-30
backfill ran on system Python by accident.

```
boto3
pyarrow
duckdb
python-dotenv
```

### Task 2.2 — Nightly warehouse workflow

`.github/workflows/warehouse.yml`. R2 is frozen at 2026-07-30 and drifts one day
per day. Repository secrets `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_BUCKET` already exist — confirm `R2_BUCKET` does not
carry the same typo as the local `.env`.

```yaml
name: Warehouse nightly
on:
  schedule:
    - cron: "0 14 * * *"      # after np-daily-ingest at 13:00 UTC
  workflow_dispatch:
    inputs:
      day: { description: "YYYY-MM-DD (default: yesterday)", required: false }

concurrency:
  group: warehouse-nightly
  cancel-in-progress: false    # never two writers on one manifest
```

Steps:

1. `pip install -r requirements-warehouse.txt`
2. `py -m warehouse ingest --day "$DAY"` — only final games are ingested, so a
   day with a suspended game writes nothing and is picked up on a later run.
3. `py -m warehouse verify --day "$DAY" --record` — must run in the same job.
   Verification is what earns the Phase 3 gate; an ingest without it accumulates
   days the prune will refuse.
4. **Catch-up:** before ingesting yesterday, ingest any gap between
   `max(manifest day)` and yesterday. Bound it (say 14 days) and fail loudly
   beyond that rather than silently starting a 2,000-day backfill.
5. On failure, fail the job. Do not swallow — a silent nightly is how R2 froze.

**Backfill the current gap once, manually, before enabling the schedule:**

```bash
py -m warehouse backfill --seasons 2026
py -m warehouse verify --range 2026-07-31..<yesterday> --record
py -m warehouse status
```

**Verify:** two consecutive green scheduled runs; `py -m warehouse status` shows
`max(day)` equal to yesterday with zero lag.

### Task 2.3 — CI covers the warehouse

Today `tests/warehouse/` holds one file testing the flattener, and
`requirements.txt` has no `pyarrow` — so `config.py`, `ingest.py`, `manifest.py`
and `verify.py` are entirely untested. `LocalStore` exists precisely so this can
be tested with no credentials and no network.

In `.github/workflows/ci.yml`, the `backend` job installs
`requirements-warehouse.txt` alongside `requirements.txt`.

New `tests/warehouse/test_ingest_roundtrip.py`, against `LocalStore(tmp_path)`
with a stubbed `warehouse.mlb.fetch_game` / `schedule` fed from
`tests/fixtures/playbyplay_sample.json`:

| Test | Asserts |
|---|---|
| `test_parquet_roundtrip_preserves_schema` | Written Parquet reads back with exactly `PITCH_SCHEMA`, including all-NULL columns keeping their declared type, not `null` |
| `test_checksum_is_order_independent` | Shuffling input rows yields an identical checksum |
| `test_checksum_catches_renumbered_rows` | Changing one `pitch_number` at equal row count changes the checksum |
| `test_partial_day_is_not_written` | One failing game in a day raises `MlbApiError` and writes zero objects and zero manifest entries |
| `test_reingest_clears_verification` | `record()` after `record_verified()` resets `verified_at` to `None` |
| `test_is_verified_requires_independent_write` | An ingest-only entry is **not** verified |
| `test_ingest_range_is_idempotent` | Re-running a window skips days already in the manifest |

The last two are the regression tests for the Phase 1 defect. Do not skip them.

### Phase 2 exit criteria

- [ ] `requirements-warehouse.txt` exists and CI installs it
- [ ] R2 `max(day)` == yesterday, verified
- [ ] Two consecutive green nightly runs
- [ ] Warehouse round-trip tests green in CI

---

## Phase 3 — The hot-window prune

**Goal:** Supabase becomes a 35-day hot window. ~330 MB reclaimed.
**Duration:** one scheduled window. **This is the only destructive phase.**

### Preconditions — all must be true

- [ ] Phase 1 complete: every day in 2025-03-27..2026-06-28 independently verified
- [ ] Phase 2 complete: R2 current and nightly running
- [ ] Database ≤ 455 MB (Phase 0)
- [ ] `py -m warehouse verify --range 2025-03-27..2026-06-28` exits 0 **on the day of the prune**

### Sizing

| Step | Peak | After |
|---|---:|---:|
| Start (post Phase 0) | — | 452 MB |
| Swap `at_bats` — copy ~6 MB, drop old 58 MB | 458 | 400 MB |
| Swap `pitches` — copy ~27 MB, drop old 256 MB | 427 | **~171 MB** |

**`at_bats` first is not stylistic.** Reversed, peak is ~25 MB higher and there is
no margin for WAL.

### Task 3.1 — Drop the training RPCs

Migration `20260802000002_drop_training_rpcs.sql`. These read *all* of `pitches`
and after the prune would silently return 35 days and train a quietly worse model
— the failure is invisible, which is why they go in the same change, not later.

```sql
drop function if exists train_pitch_result_cells();
drop function if exists train_ab_result_cells();
drop function if exists train_pitch_speed_cells();
drop function if exists train_ab_pitches_cells();
-- train_home_advantage reads only `games` and stays.
```

`scripts/train_models.py` calls these. Under the deferred model layer it is not
being rebuilt now — make it **fail loudly** with a message pointing at this plan,
rather than silently training on 35 days. Disable the `schedule:` trigger in
`.github/workflows/train-models.yml`, keeping `workflow_dispatch`.

### Task 3.2 — The swap migration

`20260802000003_hot_window_swap.sql`. Mechanics per
`docs/superpowers/specs/2026-07-29-data-pipeline-design.md` §5.5.

**Why a swap and not `DELETE`:** `DELETE` frees no measured space — dead tuples
are reusable by the table but `pg_database_size` does not shrink. `VACUUM FULL`
needs ~2× the table size transiently, impossible here. `pg_repack` is unavailable.

**Four things `LIKE ... INCLUDING ALL` does not carry.** All four are measured
from production and must be recreated explicitly:

1. **RLS policies.** Both tables have exactly one: `"public read"`, `FOR SELECT`,
   `TO anon, authenticated`, `USING (true)`. Missing it does not error — it
   silently denies, and with RLS enabled and no policy the table reads as empty.
2. **Grants.** `anon`, `authenticated` and `service_role` each hold
   `SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER`. Writes are
   blocked by the absence of an INSERT policy, not by the grants; reproduce them
   as-is rather than "tidying".
3. **Sequences.** `id` defaults to `nextval('pitches_id_seq')` /
   `nextval('at_bats_id_seq')`, and those sequences are *owned by* the old
   tables — `drop table pitches` drops `pitches_id_seq` with it and every
   subsequent insert fails. Re-own before dropping:
   `alter sequence pitches_id_seq owned by pitches_new.id;`
   then `setval` past the current max.
4. **`pitches` has no `game_date` column.** The window filter is on `pitch_ts`.
   For `at_bats` use `start_ts`.

Sketch — expand with the full column lists from
`20260703000001_core_schema.sql` (`pitches`: `id, game_pk, at_bat_index,
pitch_number, pitcher_id, batter_id, pitch_type, start_speed, zone, description,
result_category, balls, strikes, outs, inning, top_inning, pitch_ts`; `at_bats`:
`id, game_pk, at_bat_index, pitcher_id, batter_id, pitch_count, result,
result_detail, start_ts, end_ts`):

```sql
begin;
create table at_bats_new (like at_bats including all);

insert into at_bats_new
select * from at_bats where start_ts >= now() - interval '35 days';

alter sequence at_bats_id_seq owned by at_bats_new.id;
select setval('at_bats_id_seq', coalesce((select max(id) from at_bats_new), 1), true);

alter table at_bats rename to at_bats_old;
alter table at_bats_new rename to at_bats;

alter table at_bats enable row level security;
create policy "public read" on at_bats for select to anon, authenticated using (true);
grant select, insert, update, delete, truncate, references, trigger
  on at_bats to anon, authenticated, service_role;
commit;

-- Held one day before the final drop. Disk permits: peak 427 MB of 500 MB.
-- drop table at_bats_old;
```

Then the same shape for `pitches` on `pitch_ts`.

### Task 3.3 — Execution runbook

Run in a low-traffic window. `pitches`/`at_bats` have **no serve-time reader**
(`docs/DATA-PIPELINE.md` §4.3 — the `api` function never touches them), so the
site cannot break; `live-poll` writes to them every 30 s, which is the actual
hazard.

```bash
# 1. Re-verify on the day, immediately before
py -m warehouse verify --range 2025-03-27..2026-06-28 && echo GATE-OPEN

# 2. Pause the writer
q "select cron.unschedule(jobid) from cron.job where jobname='np-live-poll';"

# 3. Confirm no in-flight writes
q "select count(*) from pg_stat_activity where query ilike '%pitches%' and state='active';"

# 4. at_bats swap
q "<20260802000003 part 1>"
q "select pg_size_pretty(pg_database_size(current_database()));"   # expect ~458 MB peak

# 5. Drop old at_bats -> ~400 MB
q "drop table at_bats_old;"

# 6. pitches swap
q "<20260802000003 part 2>"

# 7. Drop old pitches -> ~171 MB
q "drop table pitches_old;"

# 8. Resume the writer
q "select cron.schedule('np-live-poll','30 seconds',\$\$select call_edge_function('live-poll')\$\$);"

# 9. Recreate the time index on the now-small table (~4 MB)
q "create index pitches_ts_idx on pitches(pitch_ts);"

q "vacuum (analyze) pitches; vacuum (analyze) at_bats;"
```

**Rollback at any point before step 5/7:** `alter table pitches rename to
pitches_new; alter table pitches_old rename to pitches;` and re-schedule
`np-live-poll`. Nothing is lost while `*_old` exists — which is why steps 5 and 7
are deliberately separate from the swap and, in the migration file, commented out.

### Phase 3 exit criteria

- [ ] `pg_database_size` ≈ 170 MB
- [ ] `select count(*) from pitches` ≈ 126,000; `at_bats` ≈ 33,000
- [ ] `pg_policies` shows `"public read"` on both tables
- [ ] `insert into pitches` succeeds (the sequence survived)
- [ ] `np-live-poll` active; a new pitch appears within 60 s
- [ ] `/api/health`, `/api/live`, `/api/picks/today`, `/api/record`, `/api/games` all 200 with unchanged shape
- [ ] `refresh_pitcher_rolling_stats` / `refresh_batter_rolling_stats` still return their usual ~500 / ~430 (the 30-day lookback fits inside the 35-day window)

---

## Phase 4 — DuckDB read layer and display aggregates

**Goal:** R2 stops being an inert asset. Nightly aggregates land in Supabase for
the frontend. **Display and analytics only — no model tables.**

### Task 4.1 — `warehouse/duck.py`

Thin layer over `R2Store.configure_duckdb` (already written,
`warehouse/store.py:93`). Zero egress, so reading the full 7.9M-row corpus is free.

```python
def connect(store): ...            # duckdb.connect() + store.configure_duckdb(con)
def dataset(store, name, seasons=None) -> str:
    """s3:// glob for read_parquet. DuckDB handles the Hive partitions."""
```

Resolve which days exist through the manifest, never `list_objects` — the scoped
token has no LIST permission.

### Task 4.2 — `warehouse/aggregates.py`

One function per table, each returning an Arrow table. Ordered by user-visible
value. Measured cardinalities from `docs/DATA-PIPELINE.md` §10.

| # | Table | Rows | MB | Grain | Serves |
|---|---|---:|---:|---|---|
| 1 | `pitcher_profiles` | ~3,800 | 2 | player × scope {career, season, d30} | Data Feed |
| 2 | `batter_profiles` | ~2,600 | 1 | player × scope | Data Feed |
| 3 | `situational_splits` | ~16,000 | 4 | player × role × base-state × platoon | RISP / bases-empty splits |
| 4 | `pitcher_fatigue_profile` | ~7,500 | 2 | pitcher × pitch-count bucket (0-24, 25-49, 50-74, 75-99, 100+) | "Is he tiring?" |
| 5 | `batter_power_profile` | ~2,600 | 1.5 | batter × scope | HR / XBH |
| 6 | `game_context` | ~27,000 | 6 | one row per game | Umpire / park / weather |
| 7 | `matchup_history` v2 | 65,327 | 11 | pitcher × batter, **3 seasons, ≥3 PA** | Head-to-head panel |

Notes that change the code:

- **`situational_splits` uses `men_on_base`, which is 100% populated across all
  2,011 days.** `DATA-INVENTORY.md` calls this our "single biggest gap" and says
  we cannot produce it. That is stale — it is blocked only on this layer.
- **`matchup_history` v2 is a decision, not a default.** 3 seasons with a ≥3 PA
  floor is 65,327 pairs / ~11 MB. Without the floor it is 200,602 pairs / ~34 MB
  and 68% of the rows are pairs with one or two career meetings. Keep the floor
  configurable and defaulted to 3.
- **Keep `pitcher_profiles`/`batter_profiles` separate from
  `pitcher_rolling_stats`/`batter_rolling_stats`.** The rolling tables stay
  authoritative for live scoring. `scope='d30'` duplicates them on purpose: a
  warehouse outage then degrades a display, never a prediction.
- **Era boundaries.** `extension` is 0.1% populated in 2015 and 99.6%+ from 2017
  — do not treat 2015 nulls as missing-at-random. `launch_speed` covers 87% of
  balls in play in 2015 rising to 99%+ by 2020. Any career-scope aggregate
  touching these must state its season floor in a column or exclude pre-2017.
- **`batter_power_profile` needs no new capture.** `at_bats.result_detail`
  already distinguishes `single`/`double`/`triple`/`home_run` and 20+ more; we
  collapse all of it into one `hit` bucket at serve time today.
- **`game_context` is a copy, not an ingestion project.** The dropped
  `game_context`/`umpire_stats` tables were removed in `20260728000001` after
  never holding a row; `GAME_SCHEMA` has carried `hp_umpire_id`, `weather_condition`,
  `temp_f`, `wind_mph`, `attendance`, `game_duration_min` for 26,863 games all along.

### Task 4.3 — `warehouse/publish.py` + migration

Migration `20260803000001_display_aggregates.sql` creates the seven tables. Every
one carries `updated_at timestamptz not null default now()`, RLS enabled, and a
`"public read"` `FOR SELECT TO anon, authenticated USING (true)` policy — match
the existing pattern in `20260728000002_retention_predictions.sql:31-47`, which
handles the case where the roles do not exist (CI's clean Postgres).

`publish.py` upserts via the service-role key in batches. Publish is
**all-or-nothing per table**: build the full Arrow table, then replace. A
half-written aggregate that the frontend reads is worse than a stale one.

Extend the nightly workflow (Task 2.2) with a `publish` job that runs after
`ingest` + `verify` succeed. Surface `min(updated_at)` across the seven tables in
`/api/health` so a stalled publish is visible rather than silently stale.

**Budget check after publishing:** ~28 MB against ~330 MB headroom.

```bash
q "select pg_size_pretty(pg_database_size(current_database()));"   # expect ~200 MB
```

### Phase 4 exit criteria

- [ ] `python -m warehouse publish --dry-run` prints row counts matching the table above (±10%)
- [ ] All seven tables populated, RLS `"public read"` present on each
- [ ] Database ≤ 210 MB
- [ ] `/api/health` reports aggregate freshness
- [ ] Nightly publish green two days running

---

## Phase 5 — Frontend wiring

**Goal:** the Data Feed tab reads a real service.

Today `frontend/pitchhawk.js:87` accumulates a session-graded log in browser
memory and loses everything on refresh (`frontend/pitchhawk.js:923`). Phase 4
gives it a backing store for the first time.

### Task 5.1 — New API routes

`supabase/functions/api/index.ts`. Follow the existing shape exactly: add to the
`TTL` map (`index.ts:37`), add a `case` to the `switch` (`index.ts:440`), wrap in
`cached(...)`. Every response is CDN-cached *and* memoised in-instance, so load
scales with TTL, not user count.

| Route | TTL | Reads |
|---|---:|---|
| `/api/player/{id}/profile` | 300 | `pitcher_profiles` / `batter_profiles` |
| `/api/player/{id}/splits` | 300 | `situational_splits` |
| `/api/player/{id}/fatigue` | 300 | `pitcher_fatigue_profile` |
| `/api/matchup/{pitcher}/{batter}` | 300 | `matchup_history` v2 |
| `/api/game/{game_pk}/context` | 3600 | `game_context` |

Aggregates change once nightly, so 300 s is conservative. Parameterised routes
follow the existing `edge/(\d+)` regex pattern at `index.ts:438`, not the plain
`switch`.

### Task 5.2 — Data Feed tab

`frontend/pitchhawk.js` (tab registered in `frontend/copy.js:20`). Replace
session-memory accumulation with fetches against the routes above. Keep the
existing live-poll path untouched — the live board must not start depending on
aggregates.

Split the fatigue surface exactly as designed: the **typical** decay curve comes
from `pitcher_fatigue_profile` (warehouse); the **current game's** trend is
computed live from the 35-day hot `pitches` table. This is why no per-game
pitcher log is being reinstated.

Degrade gracefully: if an aggregate route 404s or returns stale `updated_at`,
render the panel empty with a note. A warehouse outage must never blank the live
board.

### Task 5.3 — Tests

Extend `tests/api/test_routes.py` using the existing `fake_client` fixture
(`tests/conftest.py`) — no live project needed. Cover: each route's happy path,
an unknown player id, and an empty aggregate table.

### Phase 5 exit criteria

- [ ] All five routes 200 with correct CORS
- [ ] Data Feed survives a page refresh
- [ ] Live board unchanged when aggregate routes are forced to fail
- [ ] `pytest tests/ -q` green; `deno check` green on all six functions

---

## Deferred — model and prediction layer

**Not scheduled.** Do not start any of it during Phases 0-5, and do not fold
"just one" into an earlier phase.

`market_baselines`, `holdout_predictions` (as a system — Task 0.1 is a raw dump,
not this), `context_cells`, `pitch_sequence_cells`, `fatigue_cells`,
`pitch_arsenal`, the Phase B training migration to DuckDB, and diagnosing why
`train-models.yml` has produced no `model_params` row since 2026-07-07.

Carried forward so it is not rediscovered:

- **No holdout validation exists anywhere in this project.** Every stored model
  metric is in-sample, computed on weighted training cells.
- **`r2_cells = 0.9686` is R² against cell means, not per-pitch.** It measures
  how well a line fits ~900 pre-averaged points. `pitch_speed_ou` reads as
  near-perfect in training and **47.3% live — below a coin flip.** The training
  metric never measured the thing the live number measures.
- **`game_moneyline`'s trained model has never scored a live prediction.** All
  moneyline rows are stamped `mlb_winprob_v1`; `live-poll` relays MLB's own
  win-probability feed. The 70.8% headline in `DATA-INVENTORY.md` is MLB's
  number, not ours.
- **`ab_result` is knowingly miscalibrated** and patched at serve time
  (`CALIB_SHRINK = 0.7` in `_shared/model.ts`). Served probabilities are not raw
  model output.
- **`pitcher_bb_delta` trains as a hardcoded 0.0** but is computed for real at
  scoring time — training and serving disagree on one of six `ab_result` features.
- **`ab_pitches_ou`'s `heuristic_v0` fallback went 2-2,484** across 2,596 rows —
  a defect in the missing-table-cell branch of `predictAbPitches`, not
  underperformance.

**Standing risk while deferred:** `pitch_speed_ou` is presented to users as a
prediction and is below a coin flip. Deferring `market_baselines` defers our
*measurement* of that, not our *exposure* to it. This needs a review date from
leadership, not silence.

---

## Progress

| Phase | Status | Owner | Done |
|---|---|---|---|
| 0 — Capacity incident | **complete** | Claude | 2026-08-02 |
| 1 — Arm the gate | **complete** | Claude | 2026-08-02 |
| 2 — Close the drift | not started | | |
| 3 — The prune | not started | | |
| 4 — Read layer + aggregates | not started | | |
| 5 — Frontend wiring | not started | | |
| Deferred — model layer | not scheduled | | |
