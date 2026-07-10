## NextPitch — MLB live at-bat markets MVP

An end-to-end product that ingests all MLB data daily, polls live games in real
time, runs per-market models, prices them against real odds, and tracks every
pick — **all hosted on Supabase** (Postgres + edge functions + pg_cron). A
static frontend reads it directly for a live investor demo.

> **Production runs on Supabase, not this FastAPI app.** See
> [`docs/DEPLOY.md`](docs/DEPLOY.md) and `scripts/provision.sh` for the hosted
> pipeline (`supabase/functions/`, `supabase/migrations/`). The FastAPI backend
> in `backend/` remains a full local-dev stack that mirrors the same logic, but
> nothing in production depends on it.

### Quick start

Three ways to run it, fastest first. The live API is already deployed on
Supabase, so you don't need a backend to see real data.

**A — Frontend against the live hosted API (fastest, no backend).**
`build_frontend.sh` wires `dist/` to the live functions URL by default:

```
bash scripts/build_frontend.sh          # writes dist/ pointed at the live API
python -m http.server 5173 -d dist       # or any static server
# open http://localhost:5173
```

(Opening `frontend/index.html` raw instead runs in bundled sample-data mode —
the placeholder in `config.js` is only substituted by the build.)

**B — Full local backend (FastAPI + live poller), for backend iteration.**
Mirrors the hosted logic. Needs a Supabase project:

```
python -m venv .venv && .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env                      # set SUPABASE_URL + SUPABASE_KEY (service-role)
# apply backend/db/schema.sql in the Supabase SQL editor once
.venv\Scripts\python.exe -m uvicorn backend.api.main:app --port 8080 --reload
```

Health check `http://127.0.0.1:8080/health`, then open `frontend/index.html`
with `window.PITCH_EDGE_API = "http://localhost:8080"` (see `frontend/config.js`).
See [`STARTUP.md`](./STARTUP.md) for the full local runbook (backfill, feeds, tests).

**C — Deploy the frontend to Vercel.** Static build; `vercel.json` is
preconfigured (`bash scripts/build_frontend.sh` → `dist/`):

```
npx vercel deploy            # or import the repo at vercel.com/new
```

- The build **defaults to the live Supabase functions URL**, so a plain deploy
  is wired with no env var. To target a different Supabase project, set
  `SUPABASE_FUNCTIONS_URL=https://<ref>.supabase.co/functions/v1` in the Vercel
  dashboard.
- After the first deploy, lock CORS to your domain (until set it's `*`):
  ```sql
  insert into app_secrets (key, value) values ('allowed_origins','https://<your-app>.vercel.app')
  on conflict (key) do update set value = excluded.value;
  ```

Deploying the **backend** (Supabase edge functions + pg_cron) is a separate,
one-time step — see [`docs/DEPLOY.md`](docs/DEPLOY.md).

### Hosted pipeline (Supabase)

| edge function | cadence (pg_cron) | job |
|---|---|---|
| `backfill`      | every 1m while pending | historical games → `pitches`/`at_bats`/`games` |
| `daily-ingest`  | daily 10:00 UTC | yesterday's finals + today's slate + rolling stats + players |
| `live-poll`     | every 30s | live `live_state`, `predictions`, published `picks` |
| `odds-ingest`   | every 5m | real odds from ESPN + Kalshi (free, no-auth) → `odds`, pregame picks |
| `settle`        | every 10m | grade `predictions` and `picks` against outcomes |
| `api`           | on request | public read API the frontend consumes |

v1 models per market (`scripts/train_models.py` → `model_params`): multinomial
logistic (pitch_result, ab_result), weighted linear + σ (pitch_speed),
empirical remaining-pitches table (ab_pitches), log5 (moneyline). Until trained,
scoring falls back to a labeled league-average heuristic so the app works day
zero.

### Local FastAPI stack (dev/mirror)

Polls live MLB games every `POLL_INTERVAL_SECONDS` (default 8s), runs the same
four pitch/at-bat market predictors, and exposes them via FastAPI. Useful for
local iteration without deploying edge functions.

### Markets

| key | meaning |
|---|---|
| `pitch_speed_ou`  | over/under on next pitch mph |
| `pitch_result`    | strike/foul vs ball vs in-play |
| `ab_result`       | strikeout / walk / hit / out |
| `ab_pitches_ou`   | over/under on total pitches in at-bat |

### Architecture

Four-layer flow, with Supabase Postgres as the storage layer between ingestion and serving:

```
sources              ingestion                    storage          api             frontend
─────────            ──────────────────           ─────────        ─────────       ──────────
MLB Stats API   ──►  backend/ingestion/      ──►  pitches     ──►  /predictions ──►  index.html
                       mlb_api.py (httpx,         at_bats          /odds            (fetch loop,
                       async; live poller)        live_state       /edge             15s refresh)
Baseball Savant ──►  backend/ingestion/      ──►  predictions       /games
                       savant_loader.py           odds              /health
                       (pybaseball backfill)
DraftKings (TBD) ──► backend/ingestion/
                       odds_provider.py
                       (OddsProvider, stub default)
                                                  PitchPredictor (stub)
                                                  backend/models/predictor.py
                                                  reads pitches table for pitcher averages
```

The live poller is an asyncio background task started in FastAPI's `lifespan`. Each tick (every `POLL_INTERVAL_SECONDS`, default 8s — see `backend/config.py`) it calls `get_live_games()` → `get_play_by_play(game_pk)` → idempotent upsert into `pitches` (conflict key `(game_pk, at_bat_index, pitch_number)`) → upsert into `live_state` keyed on `game_pk`.

### Setup

```
cp .env.example .env           # then put real SUPABASE_URL + SUPABASE_KEY in .env (not .env.example)
pip install -r requirements.txt
```

All poll/refresh intervals and cache TTLs live in `backend/config.py` and can be overridden via env vars (`POLL_INTERVAL_SECONDS`, `STATS_REFRESH_SECONDS`, `ROLLING_REFRESH_SECONDS`, `FALLBACK_TTL_SECONDS`, `ROLLING_TTL_SECONDS`, `MATCHUP_TTL_SECONDS`, `GAME_CTX_TTL_SECONDS`, `GAME_LOG_TTL_SECONDS`).

Set `API_KEY` in `.env` before deploying anywhere public — every route then requires an `X-API-Key` header (checked in `backend/api/auth.py`). Unset (the local-dev default), auth is skipped but a per-IP rate limit (`RATE_LIMIT_PER_MINUTE`, default 120/min) still applies.

Apply the database schema once by pasting `backend/db/schema.sql` into the Supabase SQL editor.

### Run

```
# 1. (optional) load historical Statcast data
python scripts/backfill.py                       # full default range (2025-03-27 → yesterday)
python scripts/backfill.py 2025-04-15 2025-04-21  # or a custom 7-day window

# 2. smoke-test the MLB feed
python scripts/verify_feeds.py

# 3. start the API + live poller
.venv\Scripts\python.exe -m uvicorn backend.api.main:app --host 127.0.0.1 --port 8080 --reload

# 4. open the app
start frontend\index.html
```

### Frontend

A single static single-page app, no build step — open `frontend/index.html` directly or serve the `frontend/` folder. It renders three tabs off one shell: **Home** (public picks site), **Live Markets** (dense real-time edge board), and **Data Feed** (raw table/game previews).

| file | role |
|---|---|
| `index.html` | shell — mounts `<div id="np-root">`, loads the scripts below |
| `nextpitch.css` | all styling: layout, light/dark theme tokens (persisted in `localStorage`, honors `prefers-color-scheme`) |
| `nextpitch.js` | renders all three tabs, tab switching, filters, edge/price/implied sorting |
| `nextpitch-data.js` | bundled sample games/markets/sources + the edge engine + `NEXTPITCH.loadLive()` live adapter |
| `picks-data.js` | bundled sample picks + track record for the Home tab |
| `config.js` | injects `window.PITCH_EDGE_API` from `SUPABASE_FUNCTIONS_URL` at deploy time (see `scripts/build_frontend.sh`) |

The app boots on the bundled sample data (`picks-data.js` / `nextpitch-data.js`) so it's never blank, then polls the backend every 8s via `NEXTPITCH.loadLive()` (which fetches `GET /live` + `GET /edge/{game_pk}` and normalizes them into the board's shape) and swaps in live games when the API answers with live content; the Home tab separately pulls `/sportsbooks`, `/picks/today`, and `/record`, and logs affiliate clicks to `/track/click`. `/record` is built from real graded picks (see `backend/jobs/settle_predictions.py`) — it will be honestly empty/zero until predictions have actually settled, not the illustrative sample numbers in `picks-data.js`. Point either at a deployed API with `window.PITCH_EDGE_API` (defaults to `http://localhost:8080`). Only over/under markets are priced by a source today, so only those show an edge on the Live Markets tab; categorical markets still show the model distribution in the Data Feed. On-deck ("Upcoming") projections are derived by perturbing the live book until a backend next-batter endpoint exists.

### Tables

| table | purpose |
|---|---|
| `pitches`     | one row per pitch, both historical (pybaseball) and live (MLB Stats API). Conflict key on `(game_pk, at_bat_index, pitch_number)` so re-runs are safe. |
| `at_bats`     | one row per plate appearance. Populated by the historical Savant backfill (`build_at_bats`) AND live, same-day, by the poller (`mlb_api.get_play_by_play_with_at_bats`) as soon as MLB Stats API reports an at-bat-ending event — this is what lets `ab_result`/`ab_pitches_ou` predictions get graded without waiting for a backfill. |
| `live_state`  | one row per in-progress game, refreshed every `POLL_INTERVAL_SECONDS` by the poller. PK is `game_pk`. |
| `predictions` | append-only audit log of `/predictions/{game_pk}` and `/live` responses — full odds-joined market rows (`recommendation`, `line`, `price`, `probs`, `edge`), not just a scalar collapse. `backend/jobs/settle_predictions.py` grades each row in place (`result`, `profit_units`) once the real outcome is known; `GET /record` aggregates the graded rows. |
| `game_context` | one row per game: venue, home-plate umpire, weather. Lat/lon for outdoor venues comes from MLB Stats API's `/venues/{id}` endpoint (looked up + cached per process), not a hand-maintained dict. |
| `odds`        | reserved for when stub odds are replaced with a real source; currently unused. |

Odds come from `backend/ingestion/odds_provider.py`: a `get_odds(game_pk)` call resolves to whichever `OddsProvider` is configured (`ODDS_PROVIDER` env var, default `"stub"` → `StubOddsProvider`). `backend/api/routes/predictions.py` imports `get_odds` from `odds_provider`, so wiring in a real sportsbook feed there later is a new `OddsProvider` subclass + a config change, not a rewrite of the call site. `backend/api/routes/live.py` and `odds.py` currently import directly from `backend/ingestion/odds_stub.py` (a thin backward-compatible alias that always uses the stub regardless of `ODDS_PROVIDER`) — worth revisiting if those routes need to honor a configured non-stub provider too.

### Tests

```
pip install -r requirements-dev.txt
pytest                       # unit/route tests only — no network, no real Supabase
pytest -m network tests/smoke  # optional: hits the real MLB Stats API
```

Route and cache tests run against a `FakeSupabaseClient` (`tests/conftest.py`), never a real project. `tests/smoke/` is excluded by default (see `pytest.ini`) so CI never depends on `statsapi.mlb.com` uptime.

### TODOs for next phase

- Replace `PitchPredictor` stubs with a real model — `scikit-learn` or `XGBoost` per market, trained on the backfilled `pitches`/`at_bats` data.
- Replace `odds_stub` with a DraftKings (or any sportsbook) API or scraper — `ab_result`/`pitch_result` currently have no real price at all, so their `/record` profit is a flat ±1 unit, not a real-money line.
- Lower live-feed latency below `POLL_INTERVAL_SECONDS` — try MLB's unofficial WebSocket or a paid Sportradar feed.
- Feature engineering: pitcher × batter handedness splits, count-aware pitch tendencies, recent-pitch state.
- Deploy: backend on Railway/Render, frontend on Vercel, keep Supabase as the DB.
- Backfill prior seasons (2022–2024) with the same loader — just extend the date range.
- Apply `backend/db/schema_additions.sql` (ALTERs + new `game_context` table) to any already-deployed Supabase project — `schema.sql`'s `create table if not exists` won't retrofit existing tables.
