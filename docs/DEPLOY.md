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

## One-time provisioning

1. **Migrations** — apply, in order, `supabase/migrations/*.sql`
   (via MCP `apply_migration`, `supabase db push`, or the SQL editor).
   In `20260703000002_cron.sql`, replace `{{PROJECT_REF}}` with your
   project ref first.
2. **Cron secret** — generate a random string and store it:
   ```sql
   insert into app_secrets (key, value) values ('cron_secret', '<random>')
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
6. **Frontend** — in `frontend/config.js` replace
   `{{SUPABASE_FUNCTIONS_URL}}` with `https://<ref>.supabase.co/functions/v1`,
   then host `frontend/` anywhere static (Vercel, GitHub Pages, S3…).

## Ops queries

```sql
select * from ingest_runs order by id desc limit 20;      -- job health
select * from backfill_progress;                          -- backfill status
select count(*) from pitches;                             -- dataset size
select market, version, metrics from model_params where is_active;
select status, count(*) from picks group by 1;            -- pick record
```
