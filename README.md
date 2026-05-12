## MLB Pitch Predictor — MVP

End-to-end pipeline that ingests historical Statcast data, polls live MLB games every 15s, runs stub predictors for four pitch/at-bat markets, and exposes the results through a FastAPI backend and a single-page HTML dashboard. Predictions are intentionally rule-based — the goal of this MVP is to lock in the data shape and API contract before any real ML work.

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
                       odds_stub.py
                                                  PitchPredictor (stub)
                                                  backend/models/predictor.py
                                                  reads pitches table for pitcher averages
```

The live poller is an asyncio background task started in FastAPI's `lifespan`. Each tick it calls `get_live_games()` → `get_play_by_play(game_pk)` → idempotent upsert into `pitches` (conflict key `(game_pk, at_bat_index, pitch_number)`) → upsert into `live_state` keyed on `game_pk`.

### Setup

```
cp .env.example .env           # then put real SUPABASE_URL + SUPABASE_KEY in .env (not .env.example)
pip install -r requirements.txt
```

Apply the database schema once by pasting `backend/db/schema.sql` into the Supabase SQL editor.

### Run

```
# 1. (optional) load historical Statcast data
python scripts/backfill.py                       # full default range (2025-03-27 → yesterday)
python scripts/backfill.py 2025-04-15 2025-04-21  # or a custom 7-day window

# 2. smoke-test the MLB feed
python scripts/verify_feeds.py

# 3. start the API + live poller
.venv\Scripts\python.exe -m uvicorn backend.api.main:app --host 127.0.0.1 --port 8000 --reload

# 4. open the dashboard
start frontend\index.html
```

The frontend is a single self-contained HTML file using plain `fetch()` against `http://localhost:8000`. The game dropdown pulls from `/games`. Edge rows with `edge > 0.05` render in bold.

### Tables

| table | purpose |
|---|---|
| `pitches`     | one row per pitch, both historical (pybaseball) and live (MLB Stats API). Conflict key on `(game_pk, at_bat_index, pitch_number)` so re-runs are safe. |
| `at_bats`     | one row per plate appearance, derived from `pitches` by `build_at_bats`. |
| `live_state`  | one row per in-progress game, refreshed every 15s by the poller. PK is `game_pk`. |
| `predictions` | append-only audit log of `/predictions/{game_pk}` responses (scalar collapse for the probabilistic markets). |
| `odds`        | reserved for when stub odds are replaced with a real source; currently unused. |

### TODOs for next phase

- Replace `PitchPredictor` stubs with a real model — `scikit-learn` or `XGBoost` per market, trained on the backfilled `pitches`/`at_bats` data.
- Replace `odds_stub` with a DraftKings (or any sportsbook) API or scraper.
- Lower live-feed latency below 15s — try MLB's unofficial WebSocket or a paid Sportradar feed.
- Feature engineering: pitcher × batter handedness splits, count-aware pitch tendencies, recent-pitch state.
- Persist all probabilistic outcomes in `predictions` (current schema only has scalar `predicted_value`).
- Deploy: backend on Railway/Render, frontend on Vercel, keep Supabase as the DB.
- Add auth before exposing publicly (currently CORS is `*` and there's no auth layer).
- Backfill prior seasons (2022–2024) with the same loader — just extend the date range.
