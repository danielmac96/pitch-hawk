# Deploying NextPitch

The production system runs **entirely on Supabase**: Postgres stores every
table, edge functions do all data collection and prediction, and pg_cron
drives the schedule. The static frontend just reads from it. The FastAPI
backend in `backend/` remains a full local-dev stack but nothing in
production depends on it.

## Architecture

```
MLB Stats API ──┐
ESPN odds ──────┤   Supabase edge functions          Postgres            frontend
Kalshi ─────────┤   ──────────────────────           ────────            ────────
                ├─► backfill      (cron: 1m while pending) ─► pitches/at_bats/games
                ├─► daily-ingest  (cron: 10:00 UTC)  ─► + rolling stats, players
                ├─► live-poll     (cron: 30s)        ─► live_state, predictions, picks
                ├─► odds-ingest   (cron: 5m)         ─► odds, pregame picks
                └─► settle        (cron: 10m)        ─► graded predictions + picks
                    api           (public, read-only) ◄── frontend fetches /live,
                                                          /edge/{pk}, /picks/today,
                                                          /record, /sportsbooks
```

## Fastest path — GitHub Actions (no local setup)

You don't need a local machine or CLI. Add three repository secrets under
**Settings → Secrets and variables → Actions**:

| secret | where |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | supabase.com/dashboard/account/tokens |
| `SUPABASE_PROJECT_REF`  | Project Settings → General |
| `SUPABASE_DB_PASSWORD`  | Project Settings → Database |

Then **Actions → "Deploy pipeline to Supabase" → Run workflow** (tick
"Load demo seed" for an immediately-populated board). It pushes migrations,
stores the cron secret + functions URL, deploys all six functions, and seeds
the backfill — idempotent, so re-run it to ship changes. Train models later
with the **"Train models"** workflow (needs `SUPABASE_URL` + `SUPABASE_KEY`
secrets). Deploy the frontend on Vercel: import the repo (root `vercel.json`
is preconfigured) and set env var `SUPABASE_FUNCTIONS_URL` =
`https://<ref>.supabase.co/functions/v1`.

## One-time provisioning (local CLI alternative)

1. **Migrations** — apply, in order, `supabase/migrations/*.sql`
   (via MCP `apply_migration`, `supabase db push`, or the SQL editor).
   The cron migration is ref-agnostic: it reads the functions base URL and
   cron secret from `app_secrets` at call time, so there is nothing to
   substitute.
2. **Cron secret + functions URL** — generate a random secret and store both
   (the cron dispatcher `call_edge_function` uses them):
   ```sql
   insert into app_secrets (key, value) values
     ('cron_secret', '<random 32+ chars>'),
     ('functions_base_url', 'https://<ref>.supabase.co/functions/v1')
   on conflict (key) do update set value = excluded.value;
   ```
3. **Edge functions** — deploy `backfill`, `daily-ingest`, `live-poll`,
   `odds-ingest`, `settle`, and `api` from `supabase/functions/` with
   `verify_jwt=false` (each mutating function checks `x-cron-secret`
   itself; `api` is read-only public data).
4. **Kick the backfill** — set the window and let cron drain it:
   ```sql
   insert into backfill_progress (id, start_date, end_date, cursor_date)
   values (1, '2025-03-27', current_date - 1, current_date - 1)
   on conflict (id) do update set start_date = excluded.start_date,
     end_date = excluded.end_date, cursor_date = excluded.cursor_date,
     done = false;
   ```
   Progress is visible in `backfill_progress` and `ingest_runs`.
5. **Train models** once the backfill has data:
   ```
   pip install -r requirements-train.txt
   SUPABASE_URL=... SUPABASE_KEY=... python scripts/train_models.py
   ```
   (Re-run weekly, or wire it into CI. Until it runs, live predictions
   fall back to a league-average heuristic and are labeled as such.)
6. **(Optional) demo seed** — for off-hours investor demos when no games
   are live, load a small labeled sample so the board and record render
   populated: `supabase db query < supabase/seed_demo.sql` (or run
   `provision.sh` with `SEED_DEMO=1`). Everything is `source='demo'`;
   remove with `delete from picks where source='demo';`. Don't load it
   into an instance you present as a real track record.
7. **Frontend** — in `frontend/config.js` replace
   `{{SUPABASE_FUNCTIONS_URL}}` with `https://<ref>.supabase.co/functions/v1`,
   then host `frontend/` anywhere static (Vercel, GitHub Pages, S3…).

## Optional `app_secrets` (set via SQL / MCP `execute_sql`)

| key | effect |
|---|---|
| `allowed_origins` | comma-separated CORS allowlist for the `api` function (e.g. your Vercel domain). Until set, CORS is `*`. |
| `the_odds_api_key` | activates the The Odds API provider in `odds-ingest` (DraftKings/FanDuel/… lines, per-book `source`). Free tier is 500 req/mo. |
| `season_start` | backfill window start (`YYYY-MM-DD`); defaults to `<year>-03-15`. |

```sql
insert into app_secrets (key, value) values
  ('allowed_origins', 'https://<your-app>.vercel.app'),
  ('the_odds_api_key', '<key>')
on conflict (key) do update set value = excluded.value;
```

The entire provisioning flow can also be driven through the Supabase MCP tools
(`apply_migration`, `execute_sql`, `deploy_edge_function`, `get_advisors`) with
no local CLI — see `docs/MODELS.md` for the model-registry commands.

## Ops queries

```sql
select * from ingest_runs order by id desc limit 20;      -- job health
select * from backfill_progress;                          -- backfill status
select count(*) from pitches;                             -- dataset size
select market, version, metrics from model_params where is_active;
select status, count(*) from picks group by 1;            -- pick record
```
