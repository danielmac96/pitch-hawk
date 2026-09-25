# Feed Redesign — backend hookup

> **Status: shipped.** The redesign was ported into `frontend/pitchhawk.js` on
> 2026-08-19 — template strings, the `C` token block, `window.PITCHHAWK`. The
> mockup stays here as the visual reference. This file is now a record of what
> the real contract turned out to be, because §3 of the original draft named
> almost no field correctly and anyone reading it cold would rebuild the same
> wrong `adapt()`.

Files in this bundle:

| File | Purpose |
| --- | --- |
| `Feed Redesign.dc.html` | The mockup. Self-contained: template + logic in one file. |
| `support.js` | Runtime the mockup loads (React render + template compiler). Required to open the HTML standalone. |
| `HOOKUP.md` | This file. |

Open `Feed Redesign.dc.html` in a browser with `support.js` beside it — no build step, no server.

---

## Where the fake data lives

All synthetic data comes from **one method** in the logic class: `build()`. It returns

```js
{ today: [game, ...], historic: [game, ...] }
```

Nothing else in the component invents data. Every accuracy number, MAE, chart bar
and KPI is *derived* from that shape by `abStats()`, `gameStats()` and `charts()`.

In the shipped port the equivalent seam is `buildGameModels()` in
`frontend/pitchhawk.js` — the one place backend field names appear. Everything
downstream of it reads the shape below.

## The shape the views want

```js
game = {
  pk:      "824319",         // String(game_pk)
  away:    "LAD",            // parsed out of game_label
  home:    "COL",
  abs:     [ab, ...]         // ASCENDING at-bat order — the UI does not re-sort
}

ab = {
  abi:          80,            // at_bat_index — NOT a per-game 1..n counter
  inn:          "B9",          // half + inning
  team:         "COL",         // BATTING team — derived, see below
  batter:       "TJ Rumfield",
  pitcher:      "Tanner Scott",
  predLabel:    "strikeout",   // vocab key, not display text
  predProb:     0.41,
  actual:       "walk",        // null while unsettled
  ok:           false,         // null while unsettled — never false
  projPitches:  3.6,
  actPitches:   5,
  pitches:      [pitch, ...]
}

pitch = {
  n:          2,               // pitch_number + 1
  count:      "1-1",           // count BEFORE the pitch; null when unknown
  type:       "FF",
  predVelo:   95.4,
  velo:       96.1,
  delta:      0.7,             // actual − called
  predResult: "strike_foul",   // vocab key
  predProb:   0.52,
  result:     "ball",          // vocab key, null while unsettled
  ok:         false,           // null while unsettled
  back:       false,           // reconstructed by backfill-predictions
  pc:         37               // pitcher's cumulative count — derived, not served
}
```

Two rules the UI relies on:

- `abs` is in ascending at-bat order.
- `ok` is **`null`, never `false`, while a call is ungraded.** The original draft
  said to set it `false` and count pending rows in the denominator. That reports
  the model as wrong for being unsettled, so the port excludes ungraded rows from
  both numerator and denominator on every accuracy readout.

---

## The real backend contract

`window.PITCHHAWK` (in `frontend/pitchhawk-data.js`) is the only data layer:

- `loadBoard(apiBase, fetchImpl, date)` → `{ date, recap, live, upcoming, final }` — **note `final`**, which the original draft omitted.
- `loadGamePitches(apiBase, gamePk, date, fetchImpl, markets)` → every prediction row for one game, as a flat array of raw server rows.
- `loadPitches(apiBase, params, fetchImpl)` → `{ date, rows, next_cursor, summary }` for a whole slate, paginated.
- `loadAccuracy(apiBase, { from, to, market }, fetchImpl)` → per-day, per-market grading (added for this redesign; see below).
- `loadFeed(apiBase, filters, fetchImpl)` → `{ from, to, filters, games, players, summary, next_cursor }`. **Game-level rows from `game_predictions`, not at-bats** — it cannot feed the drill-down. It takes `from`/`to`, not `days`.
- `loadLive(apiBase, fetchImpl)` → the **whole slate** with a `phase` per game, not just what is in progress.
- `paSummaries(rows)` → per-plate-appearance rollups, **newest at-bat first** (the redesign needs ascending, so it does its own grouping).
- `tick()` and `enrichPitchPredictions()` are sample-data generators. They are not poll helpers and must never touch live data.

### Row shape

`PitchFeedRow` in `supabase/functions/_shared/pitchfeed.ts` is the authority.
Verified against a live response on 2026-08-19:

```
id, game_pk, game_label, at_bat_index, pitch_number, market, recommendation,
predicted_value, line, confidence, result, actual_value, actual_label, error,
profit_units, pitcher_id, pitcher_name, batter_id, batter_name, inning, half,
count, outs, actual_pitch_type, model_version, created_at, graded_at,
backfilled_at
```

**One row is one (position, market) pair, not one pitch.** A thrown pitch
produces a `pitch_speed_ou` row *and* a `pitch_result` row; its at-bat adds
`ab_result` and `ab_pitches_ou`. Bucket by `market` before reading anything.

### Corrections to the original §3 `adapt()`

Every name in that draft was a placeholder, and almost none of them exist:

| Draft said | Actually | Note |
| --- | --- | --- |
| `at_bat_number` | `at_bat_index` | game-wide index, not a per-team counter |
| `pitch_number` (1-based) | `pitch_number` | **0-based position**: the row at `k` is the call made *into* pitch `k+1`. Display number is `k+1`; pitch count is `max(k)+1` |
| `${r.balls}-${r.strikes}` | `count` | already `"1-1"`, pre-pitch, **`null` when the pitch could not be joined** |
| `r.pitch_type` | `actual_pitch_type` | the pitch thrown *next* |
| `predicted_speed` | `predicted_value` | on `pitch_speed_ou` rows only |
| `release_speed` | `actual_value` | same rows |
| `err: release_speed - predicted_speed` | `error` | server-computed and **signed `predicted − actual`** — verified live: pred 94.77, actual 97.8, error −3.03. The delta a reader wants is its negation |
| `predicted_pitch_result` | `recommendation` on `pitch_result` rows | values are `strike_foul` / `ball` / `in_play`, not `"Strike/Foul"` |
| `pitch_result` | `actual_label` | same rows |
| `pitch_result_confidence` | `confidence` | |
| `ok: actual === predicted` | `result === "win"` | grading is **read**, never re-derived. `"win" \| "loss" \| "push" \| "void" \| null` |
| `r.pitcher` (pitch-count key) | `pitcher_id` | |
| `inning_topbot === "Top"` | `half === "▲"` | |
| `head.batting_team` | *(does not exist)* | derive: `half === "▲"` → away side batting. Team abbreviations come only from `game_label` (`"LAD @ COL"`) |
| `predicted_ab_result` / `ab_result_confidence` / `ab_result` | `recommendation` / `confidence` / `actual_label` on the `ab_result` row | |
| `predicted_ab_pitches` | `predicted_value` on the `ab_pitches_ou` row | |
| `g.statusText` / `g.when` / `g.date` / `g.score` string | `g.status` / `g.startTs` / `board.date` / `g.score.{away,home}` | client game objects are camelCase; `score` is an object |

Two fields the draft did not mention and the port depends on:

- **`backfilled_at`** — non-null means the call was reconstructed after the fact
  by `backfill-predictions`, not made at the time. Badged `BF`, still counted.
- **`probs` is not served here.** `pitchfeed.ts` selects `confidence` but not
  `probs`, so the hero's pitch-result distribution bars come from `/live`
  (`nextCall(g)`), which is the only place the full distribution exists.

---

## Loading strategy

The draft's `componentDidMount` — board, then one `loadGamePitches` per live
game, then `loadFeed` — does not scale and does not answer the question.
Measured on the real 15-game slate of 2026-08-18:

| Approach | Cost |
| --- | --- |
| Whole day as one paged stream (`/pitches?date=`) | 15 pages, 14,000 rows, **34 s serially** |
| Per game, four at a time | 17,533 rows, **7.3 s total, first pill at 3.2 s** |

Per game wins twice. It is faster, and — because `/pitches` returns newest-id
first — it is the only one that can paint early *honestly*: a game is spliced in
only once all of its rows are present, so every pill on screen is correct the
moment it appears. A half-loaded day-stream holds half of every game and would
report an accuracy for each that is simply wrong until the last page lands.

Live games are then refreshed narrowly on the 8s poll, gated on a situation
signature (`inning:half:count:outs:pitchCountPa:phase`); finished and scheduled
games never move.

### Polling and drill-down state

`render()` replaces the whole tree with `innerHTML` every poll, so **nothing may
hold state in the DOM.** Expansion lives in `state.openG` keyed by `game_pk` and
`state.openAb` keyed by `game_pk + ":" + at_bat_index`, and filters in
`state.phFilters` keyed by `game_pk`. Auto-expansion of the live game runs once
per date behind a flag, so a poll never re-opens what the reader just collapsed.

## The "best call now" panel

Best call = the highest `modelProb` across the four micro-markets over every
live game, read from the normalized `/live` markets (`g.m`). That game becomes
the hero's subject and the one the board drills into by default. `poolCount` is
how many of the four are actually `covered`.

## Charts

Three of the four compute from the same at-bat/pitch rows the drill-down reads,
so a number in a chart and a number in a row cannot disagree.

The fourth — accuracy over time by market — needed a per-day, per-market grading
source. It turned out to already exist: **`prediction_accuracy_daily`**, rolled
up nightly by `rollup_prediction_accuracy()` since migration
`20260728000002_retention_predictions.sql`, never pruned, public-read — and
served by nothing. `GET /api/accuracy?from&to[&market]` was added for it
(`supabase/functions/api/index.ts`), summing the `model_version` split
server-side so a mid-window promotion reads as one day rather than two
half-height bars. It is the only series on the tab that outlives the 21-day
raw-prediction prune.

## Retention

Raw `predictions` are pruned at 21 days, and `/pitches` serves one day at a
time, so the drill-down browses a day at a time within that window. The Data
Feed's day stepper clamps to it and says so when a day has aged out, rather
than rendering an aged-out day as a day the model said nothing about.

## Wagering

Off throughout, per the product decision. No odds are fetched and none are
rendered; `PH_FEATURES.wageringInsights` is not read by either feed.
