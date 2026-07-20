# Rebrand inventory — de-gambling the frontend

What was hidden or rewritten to reposition NextPitch as a live analytics
board, where it lives, and how to restore the wagering UI. Produced during
the brand/mobile-first session; the classification below is the working
record of every gambling-term hit in the repo.

## The flag

One flag gates everything: `window.NP_FEATURES.wageringInsights`
(`frontend/config.js`). Default **off**.

Restore paths (either works, no code changes):

1. **Build time** — `NEXTPITCH_FEATURE_WAGERING=true bash scripts/build_frontend.sh`
   (on Vercel: set the `NEXTPITCH_FEATURE_WAGERING` env var to `true`).
2. **Runtime, any browser** — `localStorage["np-feature-wagering"] = "true"`,
   reload. (`"false"` forces it off; removing the key falls back to the
   build-time value.)

Flipping the flag on restores: the "Live Markets" tab name and heading, the
sportsbook/prediction-market source filter chips, edge-threshold highlighting
and its legend, the Edge column in the Data Feed's live at-bats table, the
settled-picks table (when the API serves graded picks), the wagering hero and
"how it works" copy, the 21+/1-800-GAMBLER compliance lines, and the
per-game `/edge/{game_pk}` API calls.

## Bucket classification (every gambling-term hit)

### Copy — rewritten (both voices kept in `frontend/copy.js`)

| Where | Was | Is (flag off) |
| --- | --- | --- |
| `index.html` title | NextPitch — MLB At-Bat Markets | NextPitch — Live MLB At-Bat Analytics |
| `index.html` meta description | "…markets, probabilities, and projections…" | "…probabilities, projections, and the game state…" |
| Header/live tab | Live Markets | Live Board / Live board |
| Hero badge | MLB · At-Bat Markets | MLB · Live At-Bat Analytics |
| Hero sub | "…odds comparison and graded picks are on the way." | "…follows every game as it unfolds." |
| Hero compliance line | 21+ · For entertainment · 1-800-GAMBLER | removed (returns with flag) |
| Promo bullet | "strike / ball / in-play odds" | "strike / ball / in-play probabilities" |
| How-it-works step 4 | "Next up: Live odds comparison, +EV picks, and a public graded record…" | "Grade: every call is checked against what actually happened…" |
| Footer disclaimer | betting-advice + 1-800-GAMBLER text | plain analytics disclaimer |
| Stale banner | "showing last known prices" | "showing the last data received" |
| `README.md` | "MLB live at-bat markets" title | "live MLB at-bat analytics" + positioning note |

### Surface — hidden behind the flag (`WAGER` in `nextpitch.js`)

- Sources filter row (DraftKings / FanDuel / Kalshi / Polymarket chips), Live tab
- Edge-threshold legend + all edge-based highlighting (`bestOfSources` returns
  null when off, so `hot()` never fires)
- Edge column (header + chip cell) in the Data Feed "Live at-bats · all games" table
- "Recently settled at-bats" block (Pick/Price/Result table)
- `/edge/{game_pk}` fetches in `loadLive()` (`nextpitch-data.js`) — verified at
  the network level, not just the DOM

### Data — left in place, disconnected from the UI

- Entire backend: `supabase/functions/` (odds-ingest, settle, api `/edge`
  `/picks` `/record` `/sportsbooks` routes), `supabase/migrations/` (odds,
  predictions, picks, bet_clicks tables), `backend/` FastAPI mirror,
  `scripts/train_models.py`, all tests. Nothing renamed — the model-vs-market
  pipeline is the product's data layer and keeps running.
- `frontend/nextpitch-data.js` edge engine (odds math, SOURCES, buildSources,
  sample generators) — still exported, consumed only when the flag is on.
- `frontend/picks-data.js` — sample picks/track-record dataset; was already
  not loaded by `index.html`. Untouched.

### Incidental — no change

- "spread" (bid/ask spread in comments), "edge functions" (Supabase's product
  name), "pick" in non-wagering prose, CSS `--good-*`/`--bad-*` token names
  (they grade model correctness, not bets).

## Regression check

`rg -i "sportsbook|parlay|bankroll|\bwager|1-800-GAMBLER" frontend/` must hit
only `copy.js` (wagering-variant strings), `config.js`/`build_frontend.sh`
(flag plumbing), `nextpitch-data.js`/`picks-data.js` (Data bucket), and
comments. No default-rendered string may match.
