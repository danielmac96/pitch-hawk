# Metrics & data inventory — 2026-09-28

> **What this is.** One human-readable answer to: *what does Pitch Hawk collect,
> what does it calculate, where does each piece live (R2 vs Supabase), what does
> the website actually show, and what is still missing on the back end.*
>
> **How it was built.** Read from the code (`warehouse/`, `modeling/`,
> `supabase/migrations/`, `supabase/functions/`, `frontend/`), the recent commit
> history, the design handoffs in `design/` and `design_handoff_board_redesign/`,
> and **read-only** queries of the live Supabase project and GitHub Actions on
> 2026-09-28. Nothing was written to the database.
>
> **This is a dated snapshot.** Row counts rot (see the README's rule on prose
> figures). The SQL to re-measure is in [§8](#8-re-measure-this-yourself). The
> reference docs this summarises are still the authorities:
> [`DATABASE.md`](DATABASE.md), [`DATA-PIPELINE.md`](DATA-PIPELINE.md),
> [`DATA-OPERATIONS.md`](DATA-OPERATIONS.md), [`MODELS.md`](MODELS.md),
> [`DATA-MAP-FOR-DESIGN.md`](DATA-MAP-FOR-DESIGN.md).

---

## 0. The whole system in 30 seconds

```
MLB Stats API ──┬──► Supabase edge functions (every 15 s in games) ──► Supabase Postgres (hot, ~35 days)
                │         live-poll · game-predict · settle · daily-ingest            │
                │                                                                      ├──► api edge fn ──► Vercel SPA
                └──► GitHub Actions nightly (04:00 ET) ──► Cloudflare R2 (Parquet, 2015→today)
                                                             │        ▲
Open-Meteo ─────────────────────────────────────────────────┘        │ export (our predictions)
                                                             │
                                                             └──► publish: 9 display aggregates ──► Supabase
                                                             └──► modeling/ (DuckDB) ──► model_params ──► Supabase
```

- **Collected** from one upstream (MLB Stats API) plus Open-Meteo for weather.
- **Supabase** holds the live game, the last ~35 days of pitches/at-bats, every
  prediction, grading, and small nightly aggregates. 393 MB of a 500 MB cap.
- **R2** holds full history since 2015 at full width (~64 pitch columns vs about a dozen
  in Postgres), plus an archive of our own predictions.
- **The frontend** reads only the `api` edge function. It never touches R2.

---

## 1. Health right now — read this first

Four things are wrong today. The first two affect what users see.

| # | Severity | Problem | Evidence (2026-09-28) |
|---|---|---|---|
| 1 | 🔴 | **Per-pitch and at-bat predictions have not been graded since 2026-09-12.** `settle` pulls the 400 **oldest** ungraded `predictions` rows (`order("id").limit(400)`, `settle/index.ts:113`). The oldest 400 all belong to **4 games from 2026-09-11 that are still `In Progress` in `games`**, so they can never grade. Every run fetches the same 400, grades 0, and stops. It is head-of-line blocking. | `max(predictions.graded_at) = 2026-09-12 03:21Z`. 100% of the 90,514 predictions made 09-23..09-27 are ungraded, all on final games. Settle logs `predictions_graded: 0` every run. `game_predictions`, `picks` and projections grade normally because they order newest-first or by status. |
| 2 | 🔴 | **The warehouse nightly has not exported or published since ~2026-09-24.** The real 04:00 run's `ingest` job hangs in the **"Status after"** step until GitHub cancels it about 55 minutes later. `export` and `publish` are then skipped. The second, guard-only run of the pair is the one reported as ✅ `success`, so the workflow list looks green. | Runs #101, #103, #105 were `cancelled`. #102, #104, #106 were `success` with ingest, export and publish all `skipped`. `aggregate_freshness()`: 7 tables last published 2026-09-23 13:35Z, and `batted_ball_profile` / `park_hr_factors` 2026-09-24 03:2xZ. |
| 3 | 🟠 | **Batter Hit/HR projections are nearly empty.** `game-predict` runs at 10:00 ET, when lineups are rarely posted. The hourly re-runs fire **only** when a game is missing pregame game markets (`DATA-OPERATIONS.md` §5.2). Game markets are always complete after 10:00, so projections are never re-scored once lineups post. `DATABASE.md` says "re-scored every pass", but that is not what happens. | `player_game_projections`: 144 rows on 09-24, 18 on 09-25, 18 on 09-26, **0 on 09-27** (`no_lineup: 15 of 15`). |
| 4 | 🟡 | The per-pitch rows that issue #1 left ungraded will hit the 21-day prune starting ~10-03 (09-12 + 21 d). Anything pruned before it is graded is lost from `prediction_accuracy_daily` permanently. | Retention interlock in `DATABASE.md`. |

Everything else is healthy. `live-poll` had 1 failure in 3 days (an upstream HTML
error page). `daily-ingest`, `game-predict` and the settle sweep are all `ok`.

---

## 2. What's being COLLECTED

### 2.1 From the MLB Stats API

| Grain | Supabase (hot, 35 d) keeps | R2 warehouse (2015→) keeps |
|---|---|---|
| **Pitch** | `pitch_type, start_speed, zone, description, result_category, balls, strikes, outs, inning, top_inning` (**post-pitch** count) | ~64 columns. Identity; **pre-pitch** count; `men_on_base` + `on_first/second/third` (player ids); scores; `pitch_of_game`; `times_through_order`; handedness. Outcome flags. Physics: `start/end_speed, zone, plate_x/z, sz_top/bottom, spin_rate/direction, break_*` (induced vertical, horizontal, angle, length), `extension, plate_time`. **Since 2026-09:** release point `release_pos_x/y/z`, release velocity, acceleration, `pfx_x/z`. Batted ball: `launch_speed, launch_angle, total_distance, trajectory, hit_hardness, hit_location, hit_coord_x/y` |
| **At-bat** | `result, result_detail, pitch_count, batter_id, pitcher_id` | Adds `event` (e.g. "Grounded Into DP"), `rbi, is_scoring_play, men_on_base`, scores, `times_through_order`, hands, timestamps |
| **Game** | status, teams/abbrs/ids, venue, start, scores | Adds `hp_umpire(_id), weather_condition, temp_f, wind_mph, wind_direction, attendance, game_duration_min` (boxscore, final games only) |
| **Live state** | `live_state`: inning, half, count, outs, batter, pitcher, PA pitch count, scores, current-PA pitches (`raw_json`) | — (transient) |
| **Player** | `player_info`: name, bat side, pitch hand, position, debut | `players` snapshot: same + birth date |
| **Venue** | — | `venues` snapshot, venue × **season**: lat/lon, elevation, azimuth, roof type, turf, capacity, fence distances. 727 rows |

### 2.2 From other sources

| Source | What | Where |
|---|---|---|
| Open-Meteo archive/forecast | `game_weather`: temp, humidity, wind speed/dir, **`wind_out_mph`** (wind toward CF), pressure, precip, at first-pitch hour | R2 only (22.7k rows, 2017→). Today's forecast is fetched by `game-predict` for `game_total` but **not stored** |
| ESPN | `odds`: `game_total` lines only | Supabase, 178 stale rows. `odds-ingest` has **no cron** |

### 2.3 Known collection defects

- `pitches.outs` violates its own range on ~22% of rows (open ingest bug, `dashboard/README.md`).
- **Runners on base are not stored in `live_state`.** The MLB live feed has them. The UI draws an empty diamond.
- **Physics re-ingest is incomplete.** Release-point/pfx columns exist for 2017, part of 2018, and new nightly days. 2019–2026 history still lacks them (`91166be`). A `--force` re-ingest also clears manifest verification.

---

## 3. What's being CALCULATED

### 3.1 Rolling form, in Postgres (daily, `daily-ingest`)

| Table | Rows now | Metrics (30-day window) | Used by |
|---|---:|---|---|
| `pitcher_rolling_stats` | 723 | zone_rate, whiff_rate, chase_rate_against, contact_rate_against, k_rate, bb_rate, hit_rate, hr_rate, avg_fastball_velo, avg_offspeed_velo, sample_pitches, sample_abs | live scorer features |
| `batter_rolling_stats` | 576 | chase_rate, contact_rate, k_rate, bb_rate, **hit_rate, hr_rate** (added 09-23), sample_pas | live scorer, batter projections |
| `team_run_rates()` / `park_factors()` | fn | team runs scored/allowed, simple park factor | `game_total` |

### 3.2 Nightly display aggregates (built in R2 with DuckDB, published to Supabase)

| Table | Rows | Metrics | Freshness |
|---|---:|---|---|
| `pitcher_profiles` / `batter_profiles` | 2,570 / 1,938 | pitches, PA, zone, whiff, chase, contact, K, BB, FB/offspeed velo. Scopes career(3 seasons)/season/d30 | 09-23 ⚠️ |
| `situational_splits` | 16,136 | PA, K, BB, hit rate, velo by men-on state × opp hand | 09-23 ⚠️ |
| `pitcher_fatigue_profile` | 4,366 | mean velo, Δ vs first bucket, whiff rate by pitch-count bucket (0-24…100+) | 09-23 ⚠️ |
| `batter_power_profile` | 1,921 | PA, HR, XBH, TB, ISO, barrel rate, avg EV/LA | 09-23 ⚠️ |
| `batted_ball_profile` | 3,938 | GB/FB/LD/popup, pull/oppo/pull-air, hard-hit (EV≥95), avg EV/LA — per ball in play | 09-24 ⚠️ |
| `park_hr_factors` | 360 | venue × season HR factor (shrunk, paired home/away), raw factor | 09-24 ⚠️ |
| `matchup_history` | 72,384 | pitcher × batter PA, SO, BB, H, HR, last faced (≥3 PA) | 09-23 ⚠️ |
| `game_context` | 27,546 | venue, HP umpire, weather, temp, wind, attendance, duration (final games) | 09-23 ⚠️ |

⚠️ = stale because of health issue #2.

**R2-only calculations:** `contact_quality` is an in-house xBA/xHR: P(hit), P(HR), P(XBH) and xTB per EV × LA (× pull angle) cell, 5,590 cells, 2017+, rebuilt Mondays. It is **not published to Supabase and not used by any model yet.**

### 3.3 Models — every prediction the product makes

| Market | Grain | Question | Features | Active version | Where written |
|---|---|---|---|---|---|
| `pitch_result` | pitch | strike/foul · ball · in play | balls, strikes, 2-strike, 3-ball, pitcher zone Δ, batter chase Δ* | v2_20260809 | `predictions` |
| `pitch_speed_ou` | pitch | velocity (mean ± σ) → P(over) | balls, strikes, pitch # in PA, pitcher velo | v2_20260809 | `predictions` |
| `ab_result` | at-bat | K · BB · hit · out | balls, strikes, pitcher K Δ, pitcher BB Δ*, batter K Δ*, platoon* (served ×0.7 calibration shrink) | v2_20260809 | `predictions` |
| `ab_pitches_ou` | at-bat | pitches in the PA → P(over) | remaining-pitches table by count | v2_20260809 | `predictions` |
| `batter_hit` | player-game | 1+ hit | batter hit Δ, pitcher hit Δ, platoon. Per-PA → game via expected PA by lineup slot | v2_20260924 | `player_game_projections` |
| `batter_hr` | player-game | 1+ HR | batter HR Δ, pitcher HR Δ, platoon | v2_20260924 | `player_game_projections` |
| `game_moneyline` | game | home/away win | pregame: `log5_v1` with hardcoded `homeAdv=0.542` (registry row v1_20260707 is **not read**). Live: MLB's own win prob `mlb_winprob_v1` | — | `game_predictions`, `predictions` |
| `game_total` | game | runs O/U | formula: team run rates, park factor, starter, weather (`total_v1`). Unregistered | — | `game_predictions` |

\* `intercept_folded`: trained as a constant, computed for real at serve time (a known train/serve gap, `DATA-PIPELINE.md` §8.5).

Model registry: 7 active `model_params` rows, 16 `model_runs`.

### 3.4 Grading & accuracy (calculated after games)

| What | Table / function | State |
|---|---|---|
| Per-pitch/AB win/loss, actual value/label, error | `predictions.result` etc. via `settle` | 🔴 stalled since 09-12 (issue #1) |
| Game-level grading | `game_predictions.result` | ✅ 5,065 / 5,115 graded |
| Projection grading (hit/miss/void, actual count, PA) | `player_game_projections` | ✅ 178 graded, 2 void |
| Daily accuracy rollup (permanent) | `prediction_accuracy_daily` | 421 rows, 07-07 → 09-27 (recent days hold no graded rows) |
| Per-player accuracy rollup | `player_prediction_daily` → `/trends` | 126k rows |
| Realised projection calibration | `projection_calibration()`, `projection_reliability()` | Only 89 graded per market. **batter_hit** predicted 0.657 vs observed 0.607 (ratio ≈ 1.08). **batter_hr** 0.126 vs 0.112 (≈ 1.12). Both run slightly hot, and the sample is tiny |
| Coverage | `prediction_coverage_daily`, `pitch_prediction_coverage` views | → `/coverage` |

---

## 4. Where everything SITS

### 4.1 Supabase Postgres — 393 MB of 500 MB

| Table | Rows (est.) | Size | Retention |
|---|---:|---:|---|
| `predictions` | 348k | 162 MB | 21 d (rolled up first) |
| `pitches` | 346k | 76 MB | 35 d |
| `player_prediction_daily` | 126k | 36 MB | pruned |
| `picks` | 67k | 31 MB | flag-gated wagering. Still written, not shown |
| `at_bats` | 89k | 19 MB | 35 d |
| `matchup_history` | 72k | 15 MB | nightly swap |
| `ingest_runs` | 26k | 12 MB | 7 d |
| `game_context` | 27.5k | 9.8 MB | nightly swap |
| `situational_splits` | 16k | 4.2 MB | nightly swap |
| `game_predictions` | 5.1k | 2.5 MB | 35 d |
| `games` | 4.9k | 1.2 MB | permanent (2025-03-27 → 2026-09-29, incl. 4 postseason games on 09-29) |
| other aggregates, rolling stats, `player_info`, `live_state`, `odds`, `model_*`, `player_game_projections`, `prediction_accuracy_daily` | small | < 5 MB total | — |

`at_bats_old` / `pitches_old` are gone. Every `*_staging` twin is empty, as expected.

### 4.2 Cloudflare R2 — `pitch-hawk-warehouse`

| Dataset | Partitioning | Source | Contents |
|---|---|---|---|
| `pitches/`, `at_bats/`, `games/` | day | MLB API, verified against it | 2015-04-05 → yesterday. ~8M pitches, ~2M PAs, ~27k games. Last measured ~622 MB |
| `game_weather/` | day | Open-Meteo | 22.7k games, 2017+ |
| `predictions/`, `picks/`, `game_predictions/`, `player_game_projections/` | day | **exported from Supabase** before the prune | the only permanent copy of our raw predictions (holdout set). ⚠️ stalled with issue #2 |
| `players/`, `venues/`, `contact_quality/` | snapshot | MLB API / derived | 4k+ players, 727 venue-seasons, 5,590 contact cells |
| `_manifest.json` | — | — | ingest + verification record per dataset-day |

I could not reach R2 from this session. Re-measure with `python -m warehouse status`.

### 4.3 Who owns what (rule of thumb)

- **Needs to be live or served to the site** → Supabase.
- **History, full width, training input, our own archived predictions** → R2.
- **Aggregates** are computed in R2 and **copied** to Supabase nightly.
- **Model coefficients** are trained from R2 (`modeling/`) and **stored** in Supabase `model_params`.

---

## 5. What the FRONT END shows (and from where)

The SPA (`frontend/`, Vercel) has three tabs and calls these routes: `/games`,
`/live`, `/board`, `/pitches`, `/accuracy`, `/feed`, `/trends`,
`/game/{pk}/context`, `/player/{id}/profile`, `/player/{id}/fatigue`,
`/matchup/{p}/{b}`, `/health`.

| Tab | What the user sees | Source |
|---|---|---|
| **Home** | Slate grouped LIVE → FINAL → UPCOMING. Each pill shows status, matchup, venue, score, count/outs, bases diamond (**always empty**), **moneyline** (pregame log5 / live MLB win prob) and **game total** (pregame, frozen). Chevron opens stadium/roof/weather/wind/umpire/attendance/model version | `/games`, `/live`, `/board`, `/game/{pk}/context` (only yesterday and earlier have context) |
| **Live Feed** | "Best call now" hero with a **Showing** selector (top at-bat or a chosen game). Next-pitch result distribution, AB outcome, velo O/U, pitches-in-AB O/U, game accuracy `c/n · P%`. Every game as a pill, with at-bat call rows, pitch table (count, type, velo called→actual, Δ, call, result, grade, BF badge) and opening-at-bat reads for scheduled games | `/live`, `/pitches` per game |
| **Data Feed** | Window chips + filters (team, player, home/away, role). **KPI tiles:** at-bat call accuracy, pitch-result accuracy, velo MAE, high-confidence accuracy, days/games graded. **Profitable trends** (per-player accuracy vs baseline, streaks). **Charts:** accuracy over time by market, pitch-result accuracy by count, pitch mix & velocity, batter tendencies. **Scouting context:** pitcher profile (K/BB/whiff/zone/chase × scope), fatigue curve, head-to-head, game context. Day → game → at-bat → pitch history accordion. Entity overlay (p30d) on any name | `/accuracy`, `/trends`, `/pitches`, `/feed`, `/player/*`, `/matchup`, `/game/*/context` |

**Served by the API but not shown anywhere yet:**
`/projections` (batter 1+ Hit / 1+ HR), `/player/{id}/splits`, `/coverage`.
Wagering routes (`/odds/today`, `/picks/today`, `/record`, `/edge`, `/sportsbooks`) are feature-flagged off.

**In Supabase but with no API route:** `batted_ball_profile`, `park_hr_factors`, `batter_power_profile` (feeds profile only), `pitcher/batter_rolling_stats`, `projection_calibration()`.

**Effect of today's health issues on the UI:** at-bat and pitch accuracy KPIs, the accuracy chart and the history grades show **pending / no data for 09-12 onward** (#1). Scouting panels and game context are frozen at 09-23 (#2).

---

## 6. What STILL NEEDS to be added on the back end

Pulled from the design handoffs (`design_handoff_board_redesign/`,
`design/player-markets/CLAUDE_DESIGN_PROMPT.md`, `DATA-MAP-FOR-DESIGN.md`), the
recent commits, and the known-gap lists in the reference docs. Ordered by
priority.

### 6.1 Fix first (broken, not missing)

1. **Unblock `settle` for `predictions`.** Skip or void rows whose game can never finish (e.g. order newest-first like the other graders, or filter to final games), and reconcile the 4 stuck 09-11 games in `games`. Then backfill grading for 09-12 → today **before the 21-day prune reaches them (~10-03)**.
2. **Fix the warehouse nightly hang.** Find why `Status after` never returns, and add a step timeout. Make a cancelled real run fail loudly, not hide behind the guard-only ✅. Then re-run export + publish for the missed days.
3. **Re-score batter projections after lineups post.** Let the hourly `game-predict` gap-fill also fire when an unstarted game has projections missing or `lineup_slot` null. Until this ships the player markets will stay mostly empty.
4. **Alerting.** Nothing pages on failure. Issues #1 and #2 ran silently for 16 and 4 days.

### 6.2 Needed by the shipped / designed frontend

| # | Item | Why the frontend needs it | Status |
|---|---|---|---|
| 1 | **Runners on base** in `live_state` → `/live` (`postOnFirst/Second/Third` from the live feed) | Home + Live Feed bases diamond and situation cell | ❌ not started. The diamond is always empty |
| 2 | **`loadProjections()` + a Predictions tab** wired to `/projections` | 1+ Hit / 1+ HR "strongest reads", lift vs league baseline, lineup ✓/pending | Back end ✅ (route exists). **Frontend not wired** (0 references). Blocked in practice by fix #3 |
| 3 | **Route `batted_ball_profile` and `park_hr_factors`** (e.g. `/player/{id}/batted-ball`, `/park/{venue_id}`) | "Why" line for HR reads, park HR factor in the game metadata tier | ❌ data exists, not routed |
| 4 | **Today's game context** (pregame weather, roof, umpire) stored and served | Metadata tier is `—` for every game today, because `game_context` only covers final games | ❌ `game-predict` fetches the forecast then discards it |
| 5 | **Win-probability history per game** (sparkline, "opened x%", biggest swing) | Predictions/Live designs | ⚠️ data exists in per-pitch `game_moneyline` rows. Needs a route |
| 6 | **In-game player lines** ("today so far": H / HR / PA for a batter, pitch count / K for the pitcher) | Live side rail | ❌ derivable from `at_bats`/`pitches`, not served |
| 7 | **Projection calibration readout** served (`projection_calibration()` → e.g. `/calibration`) | Trust strip tiles for 1+ Hit / 1+ HR | ❌ function exists, no route |
| 8 | **`market_baselines`** (always-guess-the-mode accuracy per market) | Makes every accuracy KPI honest ("+6 pts over baseline" vs a raw 52%) | ❌ proposed in `DATA-PIPELINE.md` §10.1 |
| 9 | **"Was x%"**: previous projection value when re-scored | Freshness-flash design | ❌ projections are overwritten in place |
| 10 | **On-deck / next batter** | "Upcoming batter with a strong read" card | ❌ `/live` has none (the frontend perturbs sample data) |

### 6.3 Markets that are designed as reserved slots ("NOT MODELED")

All derivable from columns already in R2 (`DATA-PIPELINE.md` §5.3.1). Each needs a spec in
`modeling/specs/`, cell SQL, a serving feature source, a scorer in `_shared/`, and a
table/route (probably the same `player_game_projections` + `/projections` pattern).

| Rank | Market | Role | Input already held | Extra work |
|---|---|---|---|---|
| 1 | **Pitcher strikeouts O/U** | pitcher | `ab_result` K prob, `pitcher_rolling_stats.k_rate/whiff_rate`, opp batters' K rate | needs expected batters faced (below) |
| 2 | **Batter H+R+RBI (1+ / 2+)** | batter | `at_bats.rbi`, P(hit) | **runs scored** need base-state runner tracking via `on_first/second/third` ids |
| 3 | **Pitcher outs recorded / IP** | pitcher | `pitches.pitch_of_game`, fatigue profile | must use `at_bats.event` (double plays), not `.result` |
| 4 | **Pitcher hits allowed O/U** | pitcher | `hit_rate`, `contact_rate_against` | expected batters faced |
| 5 | **Pitcher earned runs O/U** | pitcher | team run rates, `game_total` | `game_total` per-side mean isn't stored |
| 6 | **Batter total bases O/U 1.5** | batter | `batter_power_profile.total_bases/iso`, `contact_quality.xtb` | — |
| 7 | **Pitcher walks allowed** | pitcher | `bb_rate` | expected batters faced |
| 8 | **Live total runs** | game | live score + `game_total` | new live scorer |
| 9 | **Live "rest of game" P(hit)/P(HR)** | batter | per-PA prob × remaining PA | `1-(1-p)^remaining_PA`. Needs remaining-PA estimate |
| — | Team total hits/HR, game total hits/Ks, NRFI / first-inning run | team/game | `at_bats` | lower priority (audit list) |

### 6.4 Model-quality back-end work (not user-visible yet)

- **`game_moneyline`**: add a `log5` branch to `model.ts` so the registry row is actually read (fitted `homeAdv ≈ 0.535` vs hardcoded 0.542). Until then do not promote it.
- **`game_total`**: register it (spec + fitter + `model_params` row).
- **Close the `intercept_folded` train/serve gaps** in `ab_result` (`pitcher_bb_delta`, `batter_k_delta`, `platoon_same`) and `pitch_result` (`batter_chase_delta`).
- **Stale league baseline**: `LEAGUE.ab_result.hit = 0.239` vs 2026's actual 0.2157. It matters for `batter_hit` shrinkage and needs a retrain (`a4cfac5`).
- **Batter markets are fitted on career rates and served on 30-day rates.** Shrinkage (`HR_K=150`, `HIT_K=50`) patches this. A served career/season rate would close it properly.
- **`ab_pitches_ou` `heuristic_v0` fallback** defect (2–2,484) in the missing-cell branch.
- **Use the new data:** `contact_quality`, `game_weather.wind_out_mph`, `park_hr_factors` and pitch physics are captured but feed **no model**. `batter_hr` is the obvious first consumer.
- **Model-facing cell tables** (`context_cells`, `pitch_sequence_cells`, `fatigue_cells`, `pitch_arsenal`) for the two sub-baseline micro markets (`DATA-PIPELINE.md` §11).
- **Finish the physics re-ingest** for 2018 (partial) through 2026 on a runner that stays awake, then re-verify.
- **A verifier for `game_weather`** (Open-Meteo is re-fetchable. None exists).

### 6.5 Housekeeping

- `odds-ingest` has no cron. `odds` holds 178 stale ESPN `game_total` rows. Either schedule it or drop the table from the size budget.
- `picks` (31 MB) is still written every poll even though wagering is flagged off.
- Python dependencies are unpinned.
- Postseason: 4 `game_type = 'F'` games on 09-29. Confirm that the regular-season-trained models and `expected_pa` assumptions are acceptable for them, or gate them.

---

## 7. Quick glossary

| Term | Meaning |
|---|---|
| **hot window** | the last 35 days of `pitches`/`at_bats` kept in Postgres. Older rows live only in R2 |
| **display aggregate** | a nightly table computed in R2 and swapped into Supabase for the API |
| **model_fair** | a model probability, not a sportsbook price. Every player projection carries this |
| **graded** | `settle` has compared the call with what happened. Ungraded rows show as pending, never as misses |
| **Δ features** | a player's 30-day rate minus the league baseline, shrunk by sample size |
| **void / DNP** | projected batter did not bat. Excluded from accuracy |

---

## 8. Re-measure this yourself

```sql
-- sizes
select relname, n_live_tup, pg_size_pretty(pg_total_relation_size(relid))
from pg_stat_user_tables order by pg_total_relation_size(relid) desc;

-- active models
select market, version, params->>'type', activated_at from model_params where is_active;

-- grading health (issue #1)
select max(graded_at) from predictions;
select g.status, count(*) from (select game_pk from predictions where result is null order by id limit 400) p
join games g using (game_pk) group by 1;

-- aggregate freshness (issue #2)
select * from aggregate_freshness();

-- projections per day (issue #3)
select official_date, count(*) from player_game_projections group by 1 order by 1;

-- realised projection calibration
select * from projection_calibration();

-- job health
select job, max(started_at), bool_and(ok) filter (where started_at > now() - interval '3 days')
from ingest_runs group by 1;
```

R2: `python -m warehouse status`. Nightly: the `ingest` job of the *cancelled*
`Warehouse nightly` run, not the green one.
