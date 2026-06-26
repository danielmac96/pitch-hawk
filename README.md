## MLB Pitch Predictor — MVP

End-to-end pipeline that ingests historical Statcast data, polls live MLB games every `POLL_INTERVAL_SECONDS` (default 8s), runs stub predictors for four pitch/at-bat markets, and exposes the results through a FastAPI backend and two static frontends. Predictions are intentionally rule-based — the goal of this MVP is to lock in the data shape and API contract before any real ML work.

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

# 4. open the picks site (front door) or the live terminal
start frontend\index.html      # consumer picks site
start frontend\terminal.html   # dense live-edge dashboard
```

### Frontend

Two static front-ends, no build step — open the HTML files directly or serve the `frontend/` folder.

| file | audience | purpose |
|---|---|---|
| `index.html` | public / casual bettors | **Consumer picks site (the foundation).** Today's quick at-bat picks as cards, each with an affiliate "Bet at <book>" CTA and an expandable **"Why this pick"** dropdown of supporting bullet points. Includes a public **track record** (record, win%, units, ROI, by-market + recently-settled tables) so visitors can verify before they trust. Styled by `site.css`, rendered by `site.js`, sample data in `picks-data.js`. |
| `terminal.html` | power users | Dense Bloomberg-style live-edge dashboard. Plain `fetch()` against `http://localhost:8080`; game dropdown pulls from `/games`; edge rows with `edge > 0.05` render in bold. Styled by `styles.css`, mock feed in `mock.js`. |

The picks site runs standalone on bundled sample data (`picks-data.js`) and is API-ready: set `API_BASE` in `site.js` to the deployed backend and the loaders pull live `/sportsbooks` (affiliate-resolved book URLs), `/picks/today`, and `/record`, and log affiliate clicks to `/track/click`. `/record` is built from real graded picks (see `backend/jobs/settle_predictions.py`) — it will be honestly empty/zero until predictions have actually settled, not the illustrative sample numbers in `picks-data.js`.

### Tables

| table | purpose |
|---|---|
| `pitches`     | one row per pitch, both historical (pybaseball) and live (MLB Stats API). Conflict key on `(game_pk, at_bat_index, pitch_number)` so re-runs are safe. |
| `at_bats`     | one row per plate appearance. Populated by the historical Savant backfill (`build_at_bats`) AND live, same-day, by the poller (`mlb_api.get_play_by_play_with_at_bats`) as soon as MLB Stats API reports an at-bat-ending event — this is what lets `ab_result`/`ab_pitches_ou` predictions get graded without waiting for a backfill. |
| `live_state`  | one row per in-progress game, refreshed every `POLL_INTERVAL_SECONDS` by the poller. PK is `game_pk`. |
| `predictions` | append-only audit log of `/predictions/{game_pk}` and `/live` responses — full odds-joined market rows (`recommendation`, `line`, `price`, `probs`, `edge`), not just a scalar collapse. `backend/jobs/settle_predictions.py` grades each row in place (`result`, `profit_units`) once the real outcome is known; `GET /record` aggregates the graded rows. |
| `game_context` | one row per game: venue, home-plate umpire, weather. Lat/lon for outdoor venues comes from MLB Stats API's `/venues/{id}` endpoint (looked up + cached per process), not a hand-maintained dict. |
| `odds`        | reserved for when stub odds are replaced with a real source; currently unused. |

Odds come from `backend/ingestion/odds_provider.py`: a `get_odds(game_pk)` call resolves to whichever `OddsProvider` is configured (`ODDS_PROVIDER` env var, default `"stub"` → `StubOddsProvider`). Every route imports `get_odds`/`calculate_edge` from `odds_provider`, not a hardcoded stub, so wiring in a real sportsbook feed later is a new `OddsProvider` subclass + a config change, not a rewrite of call sites. `backend/ingestion/odds_stub.py` still exists as a thin backward-compatible alias to the stub provider.

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
