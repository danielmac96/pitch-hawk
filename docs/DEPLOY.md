# Deploying Pitch Hawk

The production system runs **entirely on Supabase**: Postgres stores every
table, edge functions do all data collection and prediction, and `pg_cron`
drives the schedule. The static frontend only reads from it.

## Architecture

Eight edge functions deploy; five `pg_cron` jobs drive them.

| function | schedule | writes |
|---|---|---|
| `live-poll` | 15s (`np-live-poll`) | `live_state`, `pitches`, `at_bats`, `predictions`, `picks`; chains `settle` |
| `game-predict` | hourly (`np-game-predict`) | `game_predictions` — pregame moneyline/totals, frozen once set |
| `daily-ingest` | 13:00 UTC (`np-daily-ingest`) | finals, slate, rolling stats, retention rollups + prunes |
| `settle` | chained from `live-poll`, plus `np-settle-sweep` at 03:00 ET | grades `predictions` and `picks` |
| `api` | on request | nothing — read-only public data |
| `odds-ingest` | **unscheduled** | `odds`, pregame picks |
| `backfill` | **unscheduled** | historical `pitches`/`at_bats`/`games` |
| `backfill-predictions` | **unscheduled** | fills prediction holes |

The last three are deployed but have no `cron.job` row; run them on demand.
`np-prune-cron-history` is the fifth job and trims `cron.job_run_details`.

Confirm rather than trust:

```sql
select jobname, schedule, active from cron.job order by jobname;
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
stores the cron secret + functions URL, deploys all eight functions, and seeds
the backfill. Safe to re-run to ship changes: `db push` applies only versions
the remote has not recorded. Train models later
with the **"Train models"** workflow (needs `SUPABASE_URL` + `SUPABASE_KEY`
secrets). Deploy the frontend on Vercel: import the repo (root `vercel.json`
is preconfigured) and set env var `SUPABASE_FUNCTIONS_URL` =
`https://<ref>.supabase.co/functions/v1`.

## One-time provisioning (local CLI alternative)

1. **Migrations** — apply, in order, `supabase/migrations/*.sql`
   (via MCP `apply_migration`, `supabase db push`, or the SQL editor).
   All are idempotent except `20260802000003_hot_window_swap.sql`, a one-shot
   table swap that fails on a second run — `db push` skips already-recorded
   versions, so this only matters if you hand-run files.
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
3. **Edge functions** — deploy all eight from `supabase/functions/` with
   `verify_jwt=false` (each mutating function checks `x-cron-secret` itself;
   `api` is read-only public data):

   ```
   api  backfill  backfill-predictions  daily-ingest
   game-predict  live-poll  odds-ingest  settle
   ```

   This list must match `scripts/provision.sh` and both
   `.github/workflows/{ci,deploy-supabase}.yml`. It was six here for a month
   while the workflows deployed eight, which left a CLI-provisioned project
   with no pregame board.
4. **Kick the backfill** — `np-backfill` is unscheduled, so seed the window and
   then invoke `backfill` yourself (or re-run the deploy workflow, which seeds
   it for you):
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
   pip install -r requirements-modeling.txt
   python -m modeling build
   SUPABASE_URL=... SUPABASE_KEY=... python -m modeling train pitch_result --promote
   ```
   (Repeat per market. Until a model is active, live predictions fall back to a
   league-average heuristic and are labeled as such. `--promote` is what changes
   production; without it the run is only recorded to `model_runs`.)
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
select count(*) from pitches;                             -- HOT WINDOW only (35d)
                                                          -- full history: python -m warehouse status
select market, version, metrics from model_params where is_active;
select status, count(*) from picks group by 1;            -- pick record
```

## Capturing screenshots for the README

The board is live-data-only, so a useful screenshot has to be taken **during a
live game window** against a working API. A capture taken off-hours, or against
a paused Supabase project, shows an empty state rather than the product — which
is why the six PNGs previously committed here were removed rather than
refreshed.

```bash
npm i --no-save playwright
mkdir -p docs/screenshots
bash scripts/build_frontend.sh          # points dist/ at the live API
python -m http.server 5173 -d dist &

node -e '
const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch();
  for (const [w, h, tag] of [[1440, 900, "1440"], [390, 844, "390"]]) {
    const p = await (await b.newContext({ viewport: { width: w, height: h } })).newPage();
    for (const name of ["Home", "Live Feed", "Data Feed"]) {
      await p.goto("http://127.0.0.1:5173/", { waitUntil: "networkidle" });
      await p.getByText(name, { exact: true }).first().click().catch(() => {});
      await p.waitForTimeout(1500);
      await p.screenshot({ path: `docs/screenshots/${name.replace(" ", "-").toLowerCase()}-${tag}.png`, fullPage: true });
    }
  }
  await b.close();
})();'
```

Then replace the `<!-- SCREENSHOT: ... -->` comment near the top of `README.md`
with the image links.
