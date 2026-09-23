# Pitch Hawk — Data Operations

**Audience:** whoever is on the hook when a pipeline stops.
**Scope:** every automated data call in the system — what triggers it, how often
it fires, what it writes, whether it is currently working, and what happens when
it isn't. From `statsapi.mlb.com` through Supabase Postgres and Cloudflare R2 to
the served frontend.
**How to read it.** This file describes *shape* — what runs, on what trigger,
and why each job is built the way it is. It deliberately holds very few
measured numbers, because those rot: §7 gives the command for each instead.
A dated measurement of the system as it stood on 2026-08-07, including an
open-defect log from that morning, is in
[`STATUS-2026-08-07.md`](STATUS-2026-08-07.md) — read that as history.

**Companion documents.** [`DATA-PIPELINE.md`](DATA-PIPELINE.md) is the *design*
document — semantics, invariants, rationale, rejected alternatives. This file is
the *operations* view. Where the two disagree about current state, **this file
wins**; where they disagree about why something is built the way it is,
`DATA-PIPELINE.md` wins.

---

## 1. The one-paragraph version

Two independent readers pull from the same public MLB Stats API. The **live
path** (Deno edge functions, driven by pg_cron) keeps a 35-day hot window in
Supabase Postgres current to within 15 seconds and scores predictions against
it. The **history path** (Python, driven by a GitHub Actions nightly) writes
11 seasons of wide Parquet into Cloudflare R2, verifies it against a re-fetch,
then computes display aggregates in DuckDB over R2 and publishes them back into
Supabase. Vercel serves a static SPA that reads one edge function and holds no
data of its own. As of today all four live schedulers are firing, R2 is current
through yesterday, the database sits at 227 MB of its 500 MB cap, and **one job
— `daily-ingest` — is failing** (§8.1).

---

## 2. Every automated call, in one table

Four different schedulers drive this system. Knowing which one owns a given job
is the first thing to establish when something stops.

### 2.1 pg_cron — inside Supabase Postgres

Jobs dispatch through `call_edge_function()` (`SECURITY DEFINER`, `pg_net`,
`x-cron-secret` header). **Trust `cron.job`, not the migrations** — schedules
have been changed in production after the migration that created them.

> **Rescheduled 2026-08-08** (`20260808000001_eastern_schedules.sql`). Pregame
> scoring moved to a single 10:00 ET run, grading became event-driven, and the
> 10-minute settle timer was retired. Rows below marked ⟳ are the new shape.

**All Eastern-time jobs run hourly and return immediately unless the local hour
matches.** pg_cron evaluates schedules in UTC and has no per-job timezone, so a
literal `0 14 * * *` is 10:00 in New York only between March and November. The
hourly tick is one cheap `exists`; the gate is
`now() at time zone 'America/New_York'`, which is correct across both DST
transitions with nobody re-cutting the cron in November.

| Job | Cadence | Fires | Conditional gate | Writes | Last observed |
|---|---|---|---|---|---|
| `np-live-poll` | **every 15s** | `live-poll` | only if a game is inside `[start_ts, start_ts+4h)` **or** a `live_state` row is still `status='live'` | `pitches`, `at_bats`, `live_state`, `predictions`, `picks`, `game_predictions` (`phase='live'`) | ✅ 2,002 ok / 0 failed in 48 h |
| ⟳ `np-game-predict` | **10:00 ET**, then hourly gap-fill | `game-predict` | at 10:00, any unstarted game today; after 10:00, **only** if an unstarted game is missing pregame markets | `game_predictions` (`phase='pregame'`) | ✅ 43 ok / 0 failed in 48 h |
| ⟳ `np-settle-sweep` | **03:00 ET** | `settle` | local hour = 3 | grades whatever the live chain missed, ahead of the 04:00 export | new |
| ~~`np-settle`~~ | ~~every 10 min~~ | — | **retired** — `live-poll` now chains `settle` directly (§5.3) | — | — |
| `np-daily-ingest` | **daily 13:00 UTC** | `daily-ingest` | none | re-ingest of finals, slate upsert, rolling stats, rollups, retention prunes | ❌ **failed 2026-08-07** (§8.1) |
| `np-prune-cron-history` | **daily 13:15 UTC** | `prune_cron_history(7)` (SQL, no edge fn) | none | trims `cron.job_run_details` | ✅ |

Two edge functions are deployed and callable but have **no `cron.job` row at
all** — deliberately unscheduled, not broken:

- **`odds-ingest`** — the only caller of the trained log5 moneyline model. Its
  absence is why `odds` holds 178 stale rows and why every served moneyline is
  stamped `mlb_winprob_v1` (MLB's own feed) rather than our model.

  It now also carries **player props** (`batter_hit` / `batter_hr`), behind a
  *second* switch: `app_secrets.the_odds_api_key` **and**
  `app_secrets.the_odds_api_props = 'true'`. Two flags because props are not on
  the bulk odds endpoint — The Odds API serves them one event at a time, so a
  15-game slate costs 1 + 15 requests against a 500/month free tier. "We have a
  key" and "we can afford ~16 calls a slate" are different decisions.
- **`backfill`** — drained and retired. `backfill_progress` reads `done=true`.

### 2.2 GitHub Actions

| Workflow | Trigger | What it does | Health |
|---|---|---|---|
| ⟳ `warehouse.yml` | **04:00 ET** — `0 8 * * *` **and** `0 9 * * *`, both guarded | `guard` picks today's real 04:00 line; `ingest`: `status` → `pending --max-gap 14` → per day `ingest`, `verify --record`, `weather --from` → `weather --catchup 120` → `contact` (Mondays); `export`: yesterday's model output → R2; `publish`: DuckDB aggregates → Supabase | ✅ 4 of last 5 green |
| `ci.yml` | every push + every PR | pytest; `deno check` + `deno test` on the edge functions; all migrations applied to a stock PG16 with `cron`/`pg_net` stubbed | ✅ green on `master` |
| `deploy-supabase.yml` | `workflow_dispatch` **only** | link → `db push` → rotate `cron_secret` → deploy all 8 edge functions | ⚠️ 4 consecutive failures 2026-08-06 (all from a non-default branch; `schedule`/`dispatch` only run from `master`) |
| `train-models.yml` | `workflow_dispatch` **only** | records a `model_runs` row per market, over **every market in the registry** rather than a hardcoded list | ✅ by design — it never passes `--promote`, so production is untouched. Promotion is a human command ([`MODELS.md`](MODELS.md)) |

### 2.2.1 What the nightly gained in 2026-09

Four steps that existed only as CLI commands until they were wired in. Each is
non-fatal on its own: none of them may turn a good ingest into a red nightly.

| step | cadence | why that cadence |
|---|---|---|
| `weather --from <day>` | per ingested day | Needs that day's `games` file and the venues snapshot, so it runs **after** ingest and verify |
| `weather --catchup 120` | every run | Drains the historical backlog one slice a night. One upstream request — Open-Meteo charges per call, not per day — so ~2,000 days clear in about three weeks with nobody doing anything. A no-op once drained |
| `contact` | **Mondays only** | A full-history scan of every pitch since 2017, and a *physics* lookup rather than a form measurement: a 2018 ball at 104 mph and 26° says the same thing today as last night. One more day of games moves ~2,200 cells by nothing measurable |
| `refresh_venues` | inside `warehouse ingest` | One API call per run; park dimensions change between seasons, so it is refetched rather than merged |

**`warehouse status` now reports snapshots.** `players`, `venues` and
`contact_quality` are written whole and carry no manifest entry, so nothing
used to see them — "is it there, and how big" meant opening the bucket by
hand. A missing snapshot now says so by name.

**The weather diagnostic names the cause.** An absent venues snapshot means
every day writes nothing, and reporting that as "no games in range" sends the
reader to the schedule instead of to the one command that fixes it.

### 2.3 Vercel — git-push, not cron

Project `pitch-hawk` (`prj_pmfGlZlMUOWZylkKsAHrGB2R11sF`). Every deployment is
triggered by a GitHub push; there are no Vercel cron jobs and no Vercel
functions. `vercel.json` builds `scripts/build_frontend.sh` → `dist` as a static
SPA. Last production deployment is `READY` on `a200477` (PR #23).

**Vercel is not part of the ingestion pipeline.** It holds no data and makes no
upstream calls. It is a consumer, reaching Supabase through the single `api`
edge function. A total Vercel outage costs the website; it costs no data.

### 2.4 Manual / on-demand

`python -m warehouse {status,pending,ingest,verify,backfill,publish}`,
`scripts/warehouse_backfill.py`, and the two `workflow_dispatch` workflows.
None of these run unattended.

---

## 3. System flow

Every solid edge below exists and ran today.

```mermaid
flowchart TB
    MLB[("MLB Stats API<br/>statsapi.mlb.com/api/v1<br/>public, unauthenticated")]

    subgraph LIVE["LIVE PATH — Deno edge functions, driven by pg_cron"]
        direction TB
        LP["live-poll<br/><i>every 15s, gated on game window</i>"]
        GP["game-predict<br/><i>10:00 ET + gap-fill</i>"]
        ST["settle<br/><i>chained from live-poll<br/>+ 03:00 ET sweep</i>"]
        DI["daily-ingest<br/><i>daily 13:00 UTC</i>"]
        PG[("Supabase Postgres<br/>35-day hot window<br/>227 MB / 500 MB")]
    end

    subgraph HIST["HISTORY PATH — Python, driven by GitHub Actions"]
        direction TB
        ING["warehouse ingest<br/><i>nightly 04:00 ET</i>"]
        VER["warehouse verify --record<br/><i>re-fetches from MLB</i>"]
        R2[("Cloudflare R2<br/>2,018 days Parquet<br/>622 MB / 10 GB")]
        DUCK["DuckDB over R2<br/>warehouse/aggregates.py"]
        PUB["warehouse publish<br/>staging + swap"]
        EXP["warehouse export<br/><i>nightly 04:00 ET</i>"]
    end

    SERVE["api edge function<br/>CDN + in-instance cache<br/>TTL 10s – 3600s"]
    FE["Vercel static SPA<br/>polls /api/live ~8s"]

    MLB -->|"schedule, playByPlay"| LP
    MLB -->|"schedule, probables"| GP
    MLB -->|"schedule, playByPlay, people"| DI
    MLB -->|"schedule, playByPlay, boxscore"| ING
    MLB -->|"independent re-fetch"| VER

    LP --> PG
    GP --> PG
    DI --> PG
    ST --> PG

    ING --> R2
    R2 --> VER
    VER -->|"verified_by gate"| R2
    R2 --> DUCK --> PUB -->|"7 aggregate tables"| PG

    PG -->|"predictions, picks,<br/>game_predictions —<br/>before retention deletes them"| EXP --> R2

    PG --> SERVE --> FE

    VER -.->|"gates the 35-day prune"| PG
    R2 -->|"feature cells via DuckDB"| TRAIN["modeling/<br/>manual, gated"]
    TRAIN -.->|"only on --promote"| PG

    style TRAIN stroke-dasharray: 5 5
```

The only dashed edge left is training. Everything else is live.

---

## 4. The 24-hour clock

Times are **Eastern**, because that is now the anchor for every job except
`daily-ingest`. UTC equivalents are given in parentheses for EDT (in-season).

```mermaid
gantt
    title One day of automated data calls, America/New_York
    dateFormat HH:mm
    axisFormat %H:%M

    section Overnight batch
    settle sweep — the pre-export guarantee  :milestone, sw, 03:00, 0m
    warehouse ingest + verify                :wi, 04:00, 25m
    export predictions to R2                 :crit, ex, 04:25, 8m
    publish aggregates to Supabase           :wp, 04:25, 14m

    section Morning
    daily-ingest — 13-00 UTC                 :milestone, di, 09:00, 0m
    prune cron history                       :milestone, pc, 09:15, 0m
    game-predict — main pregame run          :crit, gp, 10:00, 15m
    game-predict — hourly gap-fill only      :gf, 10:15, 585m

    section Game time
    live-poll — every 15s                    :active, lp, 19:00, 360m
    settle — chained, within 30s of a result :active, st, 19:00, 360m
```

**The 03:00 → 04:00 ordering is the one that matters.** The export copies
*graded* rows, so the settle sweep has to have finished first. One hour of
margin, and the export overwrites by default so a row graded later still
reaches R2 on a subsequent run.

**GitHub's scheduler is late, and the workflow is built for it.** Measured
starts across five nights ran **56 minutes to 2h29m** after the nominal time
(14:56, 16:02, 16:08, 16:14, 16:29 against a `0 14` cron). The 04:00 bars above
are therefore nominal — the real ingest often begins after 05:00 ET. This is
why the DST guard branches on `github.event.schedule` (which cron line fired)
rather than on the wall clock: an hour-equality check would skip the entire
night whenever the queue was busy. Nothing downstream cares about the delay,
because ingest only writes final games and the export overwrites.

---

## 5. Per-pipeline detail

### 5.1 `live-poll` — 15 seconds

**Trigger.** pg_cron `np-live-poll`, but the job body is a `do $$` block that
calls the edge function **only** if a game is inside `[start_ts, start_ts + 4h)`
or a `live_state` row still reads `live`. Off-hours the cron entry fires and does
nothing, which is why 2,002 successful runs in 48 hours is the correct number
rather than 5,760.

**The second condition is load-bearing.** A game running past four hours keeps
polling because `live_state` says it is live, and `live-poll`'s own stale-cleanup
is what eventually marks it final — which closes the loop. Without it, extra-inning
games would freeze mid-board.

**Per cycle:** pull today's schedule; for each in-progress game pull
`playByPlay`; if nothing changed since `last_pitch_ts`, refresh `live_state` and
stop. On a new pitch: upsert `pitches`/`at_bats`, refresh `live_state` (current-PA
pitch list cached in `raw_json`), load rolling stats and `player_info`, score four
micro-markets plus the moneyline with the active `model_params` row, insert a
`predictions` batch, upsert the `phase='live'` `game_predictions` row, and publish
threshold-crossing `picks` (`AB_PICK_MIN_PROB = 0.52`, `ML_PICK_EDGE = 0.04`).

**Failure mode.** Logs to `ingest_runs`, returns 200 with an error list. A failed
cycle is cheap — the next cycle re-polls full game state, so nothing is lost. This
is why pausing it for four minutes during the Phase 3 swap cost nothing.

### 5.2 `game-predict` — 10:00 ET, then gap-fill only

**New as of 2026-08-06** (PR #23, edge function version 1, migration
`20260806020310_cron_game_predict.sql`). Not described in any older document.

**The problem it solves.** `live-poll` was the only writer of predictions, and
pg_cron gates it to `[start_ts, start_ts + 4h)`. A user loading the site in the
morning saw an empty board, because nothing had been computed yet. Coverage went
from **0 of 11 games pregame-complete on 2026-08-05 to 15 of 15 on 2026-08-07**
(§7.2).

**Per cycle:** resolve today's slate, skip anything matching `NOT_SCOREABLE`
(started, final, postponed, cancelled, suspended), then for each remaining game
score all six markets. Both probable starters are scored against a league-average
batter and the two distributions averaged — scoring only the home starter would
report a number for half the game.

**Pregame rows are written once and never updated.** That is deliberate: the
frozen row is the model's honest pre-game call and the only one that can be
fairly graded as a track record. In-game movement lives in the `phase='live'`
row.

**Schedule, as of 2026-08-08.** The main run is 10:00 ET. Every later hour
re-runs **only** if a game that has still not started is missing pregame
markets. Previously this fired unconditionally at :05 of every hour, which was
self-healing but wasteful — because the rows are frozen, 13 of every 14 runs
wrote nothing.

The gap-fill branch is not optional dressing. Pregame coverage is the metric
this function exists to move (0/15 games before it shipped, 15/15 after), and a
single daily run has two ways to lose it: the 10:00 run fails, or a probable
starter is announced after it. The gate counts distinct `phase='pregame'`
markets per game against the expected six, straight off `game_predictions`
(~3k rows) rather than through `prediction_coverage_daily`, whose raw-market
fallback aggregates all ~250k rows of `predictions` and is far too heavy to run
hourly.

### 5.3 `settle` — chained from `live-poll`, plus a 03:00 ET sweep

Grades three things against real outcomes: `predictions` (against the next pitch,
the finished at-bat, or the final score), `picks` (with profit in units, using
`winProfit` on American odds), and `game_predictions` rows of both phases.
Batch size 400. The grading rules are documented in the function itself,
`supabase/functions/settle/index.ts`.

**Trigger, as of 2026-08-08.** The `np-settle` 10-minute timer is retired.
`live-poll` now calls `settle` itself via `invokeFunction()` in `_shared/db.ts`,
at the end of any cycle that either ingested new pitches or marked a game
final. A result is graded within ~15 seconds of landing instead of up to ten
minutes later.

Two details that make this safe rather than merely faster:

- **The final-game branch is a separate trigger, not an afterthought.** When
  the last game leaves the board, `live-poll` takes the `!liveGames.length`
  path, marks stale `live_state` rows final, and returns — and pg_cron then
  stops calling it entirely. Game-level markets (moneyline, totals) only become
  gradable at exactly that moment. Without chaining settle from *that* branch,
  every game-level prediction would sit ungraded until the next morning.
- **Chained failures are non-fatal and never block ingest.** `invokeFunction`
  returns errors rather than throwing, on a 20-second timeout. A failed chain
  costs grading latency, not a dropped pitch.

The cron secret is read fresh on every call and deliberately not cached:
`deploy-supabase.yml` rotates it on every deploy, and a warm instance holding
the old value would send 403s to a perfectly healthy function.

`np-settle-sweep` at 03:00 ET is the backstop and, more importantly, the
guarantee the 04:00 export depends on — a row exported ungraded is a row the
holdout set can never score.

### 5.4 `daily-ingest` — daily 13:00 UTC

The heaviest single job, and the one currently failing. Six stages, and **the
ordering between stages 4 and 5 is a correctness constraint, not a preference**:

1. Re-ingest finals for `T-2` and `T-1` (two days, to catch late finishes).
2. Upsert today's and tomorrow's slate.
3. `ensurePlayers` for anyone seen in the last two days of `at_bats`.
4. `refresh_pitcher_rolling_stats` / `refresh_batter_rolling_stats` — both look
   back 30 days, inside the 35-day hot window.
5. **Rollups before prunes.** `rollup_prediction_accuracy` writes the permanent
   accuracy record; `rollup_player_predictions` derives per-player history —
   `predictions` carries no player id, so joining `at_bats` at this moment is the
   *only* chance to derive it before the raw rows are deleted.
6. Retention: `ingest_runs` 7 d, `odds` 14 d, `predictions` 21 d,
   `game_predictions` 35 d, `player_prediction_daily` 90 d. **`prune_predictions`
   is skipped if either rollup failed** — a bad rollup must not be allowed to
   silently destroy predictions we have no aggregate for.

`refresh_matchup_history` was called here until 2026-08-02 and was dropped: it
read `at_bats` unwindowed and upserted over career head-to-head counts, so
against a 35-day `at_bats` it would have overwritten career history with 35-day
figures within hours of the swap. `matchup_history` is now rebuilt from the
warehouse instead.

**Observed runtime** 10–30 s on success. Today it hit 30 s and failed at stage 5
(§8.1).

### 5.5 Warehouse nightly — `warehouse.yml`, 04:00 ET nominal

Four jobs: `guard` → `ingest` → (`export`, `publish`). `publish` is gated on
`needs: ingest` succeeding, because publishing aggregates built from a day that
failed verification would put unverified numbers on the site.

**`export` is sequenced after `ingest` but NOT gated on it**, and the
distinction is deliberate. They are unrelated datasets from unrelated sources:
a day whose games are not all final blocks the MLB ingest and has no bearing on
whether our own predictions can be copied out. Coupling them would let one
delayed West Coast game quietly stop the holdout set accumulating — the exact
"every day of delay is a day of evaluation data permanently lost" problem the
export exists to end. The ordering that *is* required is manifest safety: both
jobs do a load-modify-save on one JSON object and must not overlap.

**The DST guard branches on which cron line fired, not on the wall clock.**
GitHub cron is UTC-only, so 04:00 ET needs two lines (`0 8` for EDT, `0 9` for
EST) with one of them discarded each day. The obvious guard — compare the
current Eastern hour to 04 — would have been a bug: this scheduler runs
56 minutes to 2h29m late, so a busy queue would skip the whole night. Instead
the guard reads `github.event.schedule`, the literal cron expression that
triggered the run, and compares it against what `TZ=America/New_York date +%z`
says the correct line is. A run that starts at 06:12 ET still knows it was the
04:00 line.

**Job `ingest`** (timeout 45 min, `concurrency: cancel-in-progress: false` — never
two writers on one manifest):

1. `python -m warehouse status` — doubles as the credential check. `R2Store`
   probes the bucket at construction and raises on a wrong name, rather than
   reporting an empty manifest the way a mistyped `R2_BUCKET` silently did until
   2026-08-02.
2. `python -m warehouse pending --max-gap 14` → `days.txt`. Exits 2 if the whole
   catch-up window is missing, which means a deliberate backfill is needed rather
   than a nightly.
3. Per day: `ingest --day` then **`verify --day --record`**. `--record` is the
   point of the job — without it the day is stored but never earns the prune's
   delete gate.
4. `status` again, `if: always()`.

**Job `publish`:** builds seven aggregate tables in DuckDB over R2 and publishes
each via clear-staging → batched insert → `publish_aggregate()` in one plpgsql
transaction. A failure leaves the previous night's aggregates serving rather than
a half-written table, and a zero-row publish is refused outright.

**Measured run history:**

| Date (UTC) | Result | Duration | Note |
|---|---|---|---|
| 2026-08-03 16:29 | ✅ | 13m34s | |
| 2026-08-04 16:14 | ✅ | 12m23s | |
| 2026-08-05 16:02 | ✅ | 14m04s | |
| 2026-08-06 16:08 | ❌ | 15m03s | *"The job was not acquired by Runner of type hosted"* — GitHub infrastructure. Our code never ran; `publish` correctly did not run either. |
| 2026-08-07 14:56 | ✅ | 38m42s | **Caught up two days unattended.** |

That last row is the design working. A whole night was lost to a GitHub
infrastructure fault, nobody intervened, and the next night's
`pending --max-gap 14` found both missing days and processed them. The long
duration is the catch-up, not a regression.

### 5.6 `warehouse export` — the holdout capture, 04:00 ET

**New 2026-08-08.** Copies yesterday's `predictions`, `picks` and
`game_predictions` out of Supabase into R2 Parquet before the retention timers
reach them — 21 days for `predictions`, 35 for `game_predictions`. Until this
existed, every graded prediction older than three weeks was simply deleted,
which is why no holdout validation exists anywhere in this project.

| | |
|---|---|
| **Command** | `python -m warehouse export [--day D \| --range A..B] [--skip-existing]` |
| **Keys** | `<dataset>/season=YYYY/month=MM/day=YYYY-MM-DD.parquet` — same Hive layout as the MLB datasets, so DuckDB can join a prediction onto the pitch it was made against |
| **Measured** | 2026-08-06: 10,904 predictions, 824 picks, 121 game_predictions → **293 KB** total. ~50 MB per season against a 10 GB tier |

Three properties worth knowing:

**The day is the Eastern game date, not a UTC timestamp date.** `predictions`
carries no date column at all, so it is scoped by joining `games.official_date`
via `game_pk`. Slicing `created_at` instead would be wrong in a way that is easy
to miss: measured on the 2026-08-06 export, rows run to 23:58 ET, which is
03:58 **UTC on 2026-08-07**. `official_date` is denormalised onto each row so
the file stands alone once Supabase has pruned `games`.

**These days are recorded as ingested and can never be verified, by design.**
`warehouse.verify` earns a verification by re-fetching from the MLB API and
re-deriving from scratch. There is no upstream to re-fetch model output from, so
any check could only compare the export against itself — the exact
self-certification that made the v1 manifest worthless. `EXPORT_DATASETS` is
therefore a separate tuple from `DATASETS`, `verify` never walks it, and the
prune's delete gate only ever asks about `pitches`.
`test_export_datasets_are_never_verifiable` locks this in.

**It overwrites by default.** Unlike an MLB day, which is immutable once its
games are final, an exported day legitimately changes: a suspended game
finishes the next afternoon and its rows grade then. Re-running is how those
late grades reach R2, so the nightly must not pass `--skip-existing` — that
flag exists for bulk backfills only.

> **Not migrated:** a one-time cold dump predating this job left output in the
> bucket under `holdout/predictions/` (present from 2026-07-07). It is outside
> the manifest and uses a different, locally declared schema — no
> `official_date`, and rows dated by `created_at`, which files a 23:58 ET
> prediction under the next day. It has deliberately not been folded in:
> silently unioning two different column lists would be worse than leaving it
> visible. Anyone building a holdout set across that boundary has to reconcile
> the two by hand. The script that wrote it was removed in 2026-08.

### 5.7 Serving the day: one shared state for every user

**New 2026-08-08.** The design goal is that predictions are made and graded
entirely in the background, and a visitor simply *loads* the current state —
nothing starts happening because someone opened the page, and two people
looking at the same moment see the same thing.

Most of that was already true. `/api/live` returns the **whole day's slate**
(`games where official_date = today`), not just games in progress, with the
frozen `phase='pregame'` markets standing in until first pitch and the
`phase='live'` row superseding them after. It is served from Postgres through a
CDN-cached edge function, so it is identical for everyone.

**One surface was not.** The Data Feed's per-pitch graded table was built in
the browser: `trackGradedLog()` walked each `/live` poll, graded the pitches
that arrived, and pushed them onto an array capped at 400 entries. The
consequences were all the same bug wearing different clothes —

| Symptom | Cause |
|---|---|
| Two users saw different tables at the same moment | Each accumulated only what its own tab observed |
| A refresh emptied it | The array was never persisted |
| Opening at 21:00 showed nothing from the 13:00 games | Those pitches were never observed by that session |
| It only ever held 400 rows | Hard cap, oldest discarded |

None of this was a data problem. The server had made and graded every one of
those predictions hours earlier — **nothing served them**.

`GET /api/pitches` does. Handler in `_shared/pitchfeed.ts`, TTL 15 s.

| Param | Meaning |
|---|---|
| `date` | Eastern game date, default today |
| `game_pk` | one game; must be on that date, else empty |
| `market` | comma-separated, validated against the known markets |
| `status` | `graded` drops rows still pending |
| `cursor`, `limit` | paginated, default 200, hard max 1000 |

Three things it does that the client cannot:

- **Resolves the day through `games.official_date`.** `predictions` has no date
  column, and slicing `created_at` would misfile every late-evening row — rows
  measured on 2026-08-06 run to 23:58 ET, which is the next day in UTC.
- **Computes the signed miss server-side**, so every client renders the same
  number rather than each deriving its own.
- **Carries the situation the prediction was made *into*.** Supabase stores
  balls/strikes post-pitch, so the count comes from the pitch at
  `pitch_number`, while what was actually thrown next comes from
  `pitch_number + 1`. Getting those two rows the wrong way round would
  misreport the model against itself, so a test pins it.

`predictions` also gained `actual_value` / `actual_label`
(`20260808000002`). `settle` already computed the actual for every market while
grading and threw it away; it now stores it. That is what lets the feed render
"called 94.2, actual 93.1, +1.1" from the table alone — and it puts actuals
into the R2 holdout export, which otherwise carried predictions with nothing to
score them against.

> **Rows graded before that migration have null actuals** and no backfill is
> possible beyond the 35-day `pitches` window. The read path renders null as
> "—", never as 0.0: a fabricated zero would read as a perfect prediction.

### 5.8 CI and deploy

`ci.yml` runs on every push and PR. Its three jobs are worth knowing because two
of them exist as scar tissue:

- **`backend`** installs `requirements-warehouse.txt` alongside
  `requirements.txt`. Without it, `config.py`, `ingest.py`, `manifest.py` and
  `verify.py` are unimportable and silently uncovered — which is how the manifest
  self-certification defect survived to 2026-08-02.
- **`edge-functions`** runs `deno check` on all eight functions plus
  `deno test supabase/functions/tests/`. The API and its read handlers ship
  inside the Deno function, so pytest cannot reach them — those tests are the
  only coverage the public API has.
- **`migrations`** applies every migration to a stock PG16 with `cron.schedule`
  and `cron.job` stubbed, rather than skipping the files that touch pg_cron —
  skipping them would silently drop their schema changes from coverage.

`deploy-supabase.yml` is dispatch-only and idempotent. Note it **rotates
`cron_secret` on every run**, so a deploy while jobs are in flight will 401 the
next cycle or two. Edge function versions confirm the last successful deploy:
`api` v12, `live-poll` v6, `daily-ingest` v6, `settle` v3, `game-predict` v1, all
updated 2026-08-06.

---

## 6. Where the model process inserts

There are **five** distinct points where the model touches data, on three
different clocks. This is the part nothing else documents.

```mermaid
sequenceDiagram
    autonumber
    participant MLB as MLB Stats API
    participant GP as game-predict (10:00 ET)
    participant LP as live-poll (15s)
    participant M as model_params<br/>(active registry)
    participant DB as Supabase
    participant ST as settle (chained)
    participant DAY as daily-ingest (13:00 UTC)
    participant R2 as Cloudflare R2

    Note over GP: 1. PREGAME — frozen call
    GP->>MLB: schedule + probable starters
    GP->>M: loadActiveModels()
    GP->>DB: latestOdds() for the line join
    GP->>DB: game_predictions (phase='pregame')<br/>6 markets x every game, written ONCE

    Note over LP: 2. LIVE — moving call
    LP->>MLB: playByPlay
    LP->>DB: pitcher/batter_rolling_stats, player_info
    LP->>M: loadActiveModels()
    LP->>DB: predictions (per pitch)
    LP->>DB: picks (threshold crossings only)
    LP->>DB: game_predictions (phase='live', upserted)

    Note over LP,ST: 3. GRADING — event-driven, not polled
    LP->>ST: invoke settle, but only when a pitch landed<br/>or a game was marked final
    ST->>DB: grade predictions vs next pitch / final at-bat / final score
    ST->>DB: grade picks (profit_units)
    ST->>DB: grade game_predictions (both phases)
    Note over ST: 03:00 ET sweep catches anything the chain missed

    Note over R2: 4. EXPORT — 04:00 ET, before retention deletes the rows
    R2->>DB: read yesterday's graded rows by Eastern game date
    DB-->>R2: predictions + picks + game_predictions -> Parquet

    Note over DAY: 5. ROLLUP then PRUNE — order is load-bearing
    DAY->>DB: rollup_prediction_accuracy() fills prediction_accuracy_daily
    DAY->>DB: rollup_player_predictions() fills player_prediction_daily
    DAY->>DB: prune_predictions(21d) — SKIPPED if either rollup failed

    Note over M: 6. TRAINING — manual, never automatic
    M->>R2: python -m modeling build (feature cells via DuckDB)
    M->>M: sweep + walk-forward + frozen 2026 holdout
    M->>DB: model_runs row — every run, promoted or not
    M--xDB: model_params UNCHANGED unless a human passes --promote
```

**Training does not run on a schedule, and that is the design.**
`train-models.yml` is `workflow_dispatch` only and never passes `--promote`, so
a run there records a `model_runs` row and changes nothing about what
production serves. `build` scans the whole corpus (~2,000 Parquet files per
dataset) and costs real R2 operations, so it should be an intentional act.

Promotion is a separate, deliberate command at a terminal, gated on
out-of-sample metrics. `python -m modeling status` compares the registry's
active version against what live scoring actually stamped on
`predictions.model_version`, which is how a forgotten `live-poll` redeploy
surfaces as a mismatch rather than a mystery.

The full lifecycle, the gate rules and the registry operations live in
[`MODELS.md`](MODELS.md), which is authoritative for anything about models.

**One caveat worth repeating here:** the `game_moneyline` numbers served are
not the trained log5 model. `model.ts` has no `log5` branch at all — both
callers take the function default `homeAdv = 0.542`. `live-poll` stamps MLB's
own win-probability feed as `mlb_winprob_v1`; `game-predict` stamps `log5_v1`
but reads no `model_params`. A promoted `game_moneyline` row would be
recorded, versioned and completely inert.

---

## 7. Runbooks — how to measure any of this yourself

These are the exact commands used for this assessment.

**pg_cron schedules — the source of truth, not the migrations:**
```sql
select jobname, schedule, active, command from cron.job order by jobname;
```

**Job health over the last 48 hours:**
```sql
select job,
       count(*) filter (where ok)     as ok,
       count(*) filter (where not ok) as failed,
       max(started_at)                as last_run
from ingest_runs
where started_at > now() - interval '48 hours'
group by 1 order by 1;
```

**Why a job failed** — `detail` carries the error list and the per-stage counts:
```sql
select id, started_at, ok, detail
from ingest_runs where job = 'daily-ingest' order by id desc limit 5;
```

**Capacity and table sizes:**
```sql
select relname, pg_size_pretty(pg_total_relation_size(c.oid)) as size
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by pg_total_relation_size(c.oid) desc limit 20;

select pg_size_pretty(pg_database_size(current_database()));
```

**Aggregate freshness:**
```sql
select 'pitcher_profiles' t, max(updated_at) u, count(*) n from pitcher_profiles
union all select 'situational_splits', max(updated_at), count(*) from situational_splits
union all select 'matchup_history',    max(updated_at), count(*) from matchup_history;
```

**Prediction coverage — did the board have content before first pitch:**
```sql
select * from prediction_coverage(current_date - 5, current_date)
order by official_date desc;
```

**The 8-second ceiling behind §8.1:**
```sql
select rolname, rolconfig from pg_roles
where rolname in ('authenticator', 'service_role', 'anon', 'postgres');
```

**R2 warehouse — currency, row counts, verification split:**
```bash
py -m warehouse status
```
> Use `py` (system Python 3.13), not `.venv` — `.venv` holds only `pyarrow`.
> `warehouse` additionally needs `boto3`, `duckdb` and `python-dotenv` from
> `requirements-warehouse.txt`.

**Re-export a day of model output** (safe to re-run; overwrites by design):
```bash
py -m warehouse export --day 2026-08-06
py -m warehouse export --range 2026-07-20..2026-08-06 --skip-existing
py -m warehouse --local ./tmp export --day 2026-08-06   # no R2, dry run
```

**Read an exported day back:**
```sql
select result, count(*)
from read_parquet('s3://pitch-hawk-warehouse/predictions/season=2026/month=08/day=*.parquet')
group by 1;
```

**GitHub Actions history:**
```bash
gh run list --limit 30
gh run view <run-id>              # annotations explain infrastructure failures
```

**Live serving health:**
```bash
curl -s https://gfxpchtyncgsczqdvohr.supabase.co/functions/v1/api/health
```

**Vercel:**
```bash
vercel ls                          # or the Vercel MCP: list_projects / list_deployments
```

---

## 8. What is still not built

| Missing | Consequence of leaving it |
|---|---|
| **`market_baselines`** | Published accuracy numbers have no honest denominator. A 52.5% at-bat-result rate reads as a win rather than as +6.1 points over always guessing the most common outcome. |
| The model-facing cell tables (`context_cells`, `pitch_sequence_cells`, `fatigue_cells`, `pitch_arsenal`) | The two sub-baseline markets stay unexplained. Deferred deliberately — see `DATA-PIPELINE.md` §11. |
| **Alerting** | Nothing pages when a job fails. `ingest_runs` records it; someone has to look. |

Both halves of the original data proposal shipped: seven display aggregates
are live, published nightly and served, and training now reads R2 through
DuckDB (`modeling/`). What remains is the baseline table that would make the
published accuracy numbers interpretable, and the cell tables behind the two
markets that score below their own baseline.
