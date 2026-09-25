# Pitch Hawk — master data map (for Claude Design)

> One file a designer or design agent can ingest and know **every piece of data the
> product holds, where it comes from, how fresh it is, and what does not exist yet.**
> Read from the migrations (`supabase/migrations/`), the API (`supabase/functions/api/index.ts`),
> the scorers (`supabase/functions/_shared/`), and a read-only query of the live
> database on **2026-09-24**. Nothing was written to the database.
>
> Rule for every design built from this: **a value that does not exist renders `—`,
> never `0`, never a guess.** A slot for a metric we don't have yet is designed with
> an empty value and a `NOT YET MODELED` tag.

---

## 0. The product in one paragraph

Pitch Hawk is an MLB **analytics board**, not a sportsbook. It ingests the MLB Stats API
every ~15–30 s during games, scores model predictions at four grains (**pitch → at-bat →
player-game → game**), grades them after the fact, and serves them through one read-only
JSON API to a static single-page app. Wagering UI (odds, edge, picks) exists behind a
feature flag that is **off**. Every player projection is labelled `book = "model_fair"`:
a model probability, not a price.

Three tabs today: **Home** (schedule + game pills), **Live Feed** (live games + pitch-level
calls), **Data Feed** (history + accuracy analytics).

---

## 1. Systems and freshness

| system | holds | freshness |
|---|---|---|
| MLB Stats API | the only upstream source | real time |
| Supabase Postgres (500 MB cap) | today's slate, live state, 35 days of pitches/at-bats, all predictions, display aggregates | live-poll every ~15–30 s during games; `game-predict` hourly pregame; `daily-ingest` 10:00 UTC |
| Cloudflare R2 warehouse | 2015 → today, ~8M pitches / 2M at-bats / 27k games, Parquet | nightly 04:00 ET. **Publishes display aggregates back to Postgres nightly** |
| Vercel | static SPA, no data | — |

**Freshness classes the UI must show honestly:**

| class | examples | label to show |
|---|---|---|
| **LIVE** (updates every poll) | score, inning, count, outs, current batter/pitcher, pitch-level calls, **live win probability** | pulsing `● LIVE` |
| **PREGAME, re-scored until first pitch** | batter P(hit) / P(HR) projections (lineups post ~3 h before first pitch) | `PREGAME · updated hh:mm` |
| **PREGAME, frozen** | game total, pregame moneyline, opening at-bat reads | `PREGAME` |
| **NIGHTLY** (yesterday and earlier) | stadium metadata, umpire, attendance, profiles, splits, park factors, batted-ball | `as of last night` |
| **GRADED** (after final) | at-bat/pitch accuracy, projection results | `graded` |

---

## 2. Entities and their IDs

| entity | key | display fields | source table |
|---|---|---|---|
| Game | `game_pk` (bigint) | `away_abbr @ home_abbr`, `start_ts`, `status`, `venue_name`, scores | `games` |
| Team | `team_id` (108–158) | `abbr` (30 clubs, e.g. `NYM`, `ATL`, `AZ`, `ATH`, `CWS`, `WSH`) | `games`, `_shared/vocab.ts` |
| Player | `player_id` (int) | `full_name`, `bat_side` (L/R/S), `pitch_hand` (L/R), `position` | `player_info` |
| At-bat | `(game_pk, at_bat_index)` | game-wide index, not 1..n per team | `at_bats` |
| Pitch | `(game_pk, at_bat_index, pitch_number)` | `pitch_number` is **0-based** in predictions; display +1 | `pitches` |
| Venue | `venue_id` | `venue_name` | `games`, `park_hr_factors` |

**Game `status` / `phase`:** the API normalises to `phase ∈ {pregame, live, final}`. A
game is only `live` when its `live_state` row is <30 min old.

---

## 3. Tables — full inventory

### 3.1 Live pipeline

| table | grain | key fields for design | retention |
|---|---|---|---|
| `games` | game | `game_pk, official_date, status, start_ts, home/away_team, home/away_abbr, home/away_team_id, venue_id, venue_name, home_score, away_score` | permanent |
| `live_state` | game (in progress) | `inning, top_inning, balls, strikes, outs, batter_id, pitcher_id, pitch_count_pa, home_score, away_score, last_pitch_ts, raw_json.current_pa_pitches[]` | overwritten |
| `pitches` | pitch | `pitch_type, start_speed, zone, description, result_category (strike_foul/ball/in_play), balls, strikes, outs, inning, top_inning` | 35 days |
| `at_bats` | plate appearance | `result (strikeout/walk/hit/out), result_detail (single/double/triple/home_run/...), pitch_count, batter_id, pitcher_id` | 35 days |
| `player_info` | player | `full_name, bat_side, pitch_hand, position, debut_date` | permanent |
| `pitcher_rolling_stats` | pitcher, last 30 d | `zone_rate, whiff_rate, chase_rate_against, contact_rate_against, k_rate, bb_rate, hit_rate, hr_rate, avg_fastball_velo, avg_offspeed_velo, sample_pitches, sample_abs` | daily refresh |
| `batter_rolling_stats` | batter, last 30 d | `chase_rate, contact_rate, k_rate, bb_rate, hit_rate, hr_rate, sample_pas` (449 batters have HR rate today) | daily refresh |
| `odds` | snapshot | `market, outcome, line, price_american, implied_prob, novig_prob, source, player_id` (today only `game_total` has rows) | 14 days, **flag-gated** |

**Not in the live payload:** runners on base (the live feed has them; `live_state` does not
store them). The bases diamond renders empty with a `—` situation until that ships.

### 3.2 Predictions

| table | grain | what it holds |
|---|---|---|
| `predictions` | (pitch position × market) | every in-game call: `market, recommendation, predicted_value, confidence, probs{}, line, result (win/loss/push/void), actual_value, actual_label, model_version, backfilled_at` (353k rows, 21-day retention) |
| `game_predictions` | (game × market × phase) | `phase ∈ {pregame, live}`; `probs{}`, `recommendation`, `line`, `confidence`, `home/away_pitcher_id` (probable starters), `actual_value`, `result` |
| `player_game_projections` | (game × batter × market) | **NEW.** `market ∈ {batter_hit, batter_hr}`, `probability` (per game), `per_pa_probability`, `expected_pa`, `lineup_slot`, `is_home`, `team_id`, `opponent_id`, `opposing_pitcher_id`, `model_version`, `book='model_fair'`, `result (hit/miss/void)`, `actual_count`, `plate_appearances` |
| `prediction_accuracy_daily` | day × market | permanent accuracy rollup: `n_graded, wins, losses, mean_confidence, mean_abs_error` |
| `player_prediction_daily` | day × player × role × market × side | per-player accuracy rollup (feeds `/trends`) |
| `picks` | published pick | flag-gated, wagering only |
| `model_params` / `model_runs` | model registry | one active version per market; every training run |

**Active models (live DB, 2026-09-24):**

| market | version | active since |
|---|---|---|
| `pitch_result` | v2_20260809 | 2026-08-09 |
| `ab_result` | v2_20260809 | 2026-08-09 |
| `pitch_speed_ou` | v2_20260809 | 2026-08-09 |
| `ab_pitches_ou` | v2_20260809 | 2026-08-09 |
| `batter_hit` | **v2_20260924** | **today** |
| `batter_hr` | **v2_20260924** | **today** |
| `game_moneyline` | v1_20260707 (registered but **not read**; pregame uses `log5_v1`, live uses `mlb_winprob_v1`) | — |
| `game_total` | formula, unregistered | — |

`player_game_projections` today: **144 rows, 1 day (2026-09-24), 0 graded.** Calibration
readouts are therefore empty and must render `—` until games settle.

### 3.3 Nightly display aggregates (published from R2)

| table | grain | fields | API route |
|---|---|---|---|
| `pitcher_profiles` / `batter_profiles` | player × scope (career/season/d30) | `pitches, pa, zone_rate, whiff_rate, chase_rate, contact_rate, k_rate, bb_rate, avg_fastball_velo, avg_offspeed_velo` | `/player/{id}/profile` |
| `situational_splits` | player × role × men_on (Empty/Men_On/RISP/Loaded) × opp_hand | `pa, k_rate, bb_rate, hit_rate, avg_velo` | `/player/{id}/splits` |
| `pitcher_fatigue_profile` | pitcher × pitch bucket (0-24 … 100+) | `mean_velo, velo_delta_vs_bucket0, whiff_rate` | `/player/{id}/fatigue` |
| `batter_power_profile` | batter × scope | `pa, hr, xbh, total_bases, iso, barrel_rate, avg_launch_speed, avg_launch_angle` | feeds profile |
| `batted_ball_profile` | player × role × scope | `bip, gb/fb/ld/popup_rate, pull/oppo/pull_air_rate, hard_hit_rate (EV≥95), avg_launch_speed/angle` (3,938 rows) | **not routed yet** |
| `park_hr_factors` | venue × season | `hr_factor` (shrunk to 1.0), `raw_factor`, home/away HR rates (360 rows) | **not routed yet** |
| `matchup_history` | pitcher × batter | `pa_count, so_count, bb_count, h_count, hr_count, last_faced` (3-PA floor) | `/matchup/{p}/{b}` |
| `game_context` | game (completed only) | `venue_name, hp_umpire, weather_condition, temp_f, wind_mph, wind_direction, attendance, game_duration_min` (27.5k rows) | `/game/{pk}/context` |

Pregame weather for **today's** games is fetched by `game-predict` (temp, wind, condition,
roof) and used in the game total, but it is **not stored or served**. Design the slot; it's
blank today.

### 3.4 Warehouse only (R2, not served, ~8M pitches since 2015)

Full pitch physics (spin, break, extension, plate location, release point), batted ball
(`launch_speed, launch_angle, total_distance, trajectory, hit_location`), base state
(`on_first/second/third` as player ids), `times_through_order`, `pitch_of_game`,
`at_bats.rbi`, `at_bats.event`. **Every player-game market below can be derived from these**
(audited in `DATA-PIPELINE.md` §5.3.1). They need a model and a serving table first.

---

## 4. API — what the frontend can call

Base: `/api/<route>` on the Supabase edge function. All JSON, CDN-cached.

| route | returns | use in design |
|---|---|---|
| `GET /games` | today's slate: status, teams, abbrs, start, scores, venue | schedule |
| `GET /live` | **whole slate** with `phase`, `situation{inning, half ▲/▼, count, outs, home/away_score}`, `batter_name/hand`, `pitcher_name/hand`, `probable_home/away_pitcher{id,name}`, `markets[]` (latest per market), `markets_pregame[]` (frozen), `current_pa_pitches[]`, `pa_predictions[]`, `coverage{markets_covered, missing[]}` | Home pills, Live Feed |
| `GET /board?date=` | `{date, recap, live, upcoming, final}` | past slates |
| `GET /projections?date=&market=` | `{date, priced:false, rows[{game_pk, player_id, player, market, team_id, opponent_id, is_home, lineup_slot, opposing_pitcher_id, opposing_pitcher, probability, per_pa_probability, expected_pa, model_version, book, updated_at}]}` | **player markets dropdown** |
| `GET /pitches?date=&game_pk=` | graded per-pitch/per-AB rows (`PitchFeedRow`) | drill-downs |
| `GET /accuracy?from&to&market` | per-day, per-market accuracy | charts |
| `GET /trends?...` | per-player accuracy vs baseline, streaks | Data Feed |
| `GET /feed?from&to` | game-level prediction history | game history |
| `GET /coverage` | per-game market coverage | QA / badges |
| `GET /player/{id}/profile·splits·fatigue` | nightly profiles | player drawer |
| `GET /matchup/{pitcher}/{batter}` | head-to-head (`found:false` under 3 PA, the norm) | matchup chip |
| `GET /game/{pk}/context` | venue, ump, weather, attendance (`found:false` for today's games) | game metadata tier |
| `GET /health` | active model versions | footer |
| `odds/today`, `picks/today`, `record`, `edge/{pk}`, `sportsbooks` | wagering | **flag off, don't design** |

---

## 5. Markets — every prediction the product makes

### 5.1 Pitch level (LIVE feed)

| market | question | output | vocab |
|---|---|---|---|
| `pitch_result` | what is the next pitch? | 3-class probs | `strike_foul`, `ball`, `in_play` (league 45.5 / 35.2 / 19.3 %) |
| `pitch_speed_ou` | how fast is it? | mean mph + σ (5.4) → P(over line) | mph, O/U |

### 5.2 At-bat level (LIVE feed)

| market | question | output | vocab |
|---|---|---|---|
| `ab_result` | how does this PA end? | 4-class probs | `strikeout` 22.1 %, `walk` 8.7 %, `hit` 23.9 %, `out` 45.3 % |
| `ab_pitches_ou` | how many pitches does it take? | expected pitches (league 3.85) + distribution → P(over) | O/U line |

### 5.3 Player-game level (NEW — pregame, re-scored until lineups lock)

| market | question | output | status |
|---|---|---|---|
| `batter_hit` | 1+ hit today? | `probability`, `per_pa_probability`, `expected_pa` | ✅ live, served at `/projections` |
| `batter_hr` | 1+ HR today? | same (league 3.2 %/PA ≈ 12–14 %/game) | ✅ live, served at `/projections` |

`expected_pa` comes from the lineup slot: **4.49** leadoff → **3.45** ninth, **4.04** when the
lineup isn't posted. Sanity ceilings are HR ≤ 40 % and hit ≤ 95 %. Implausible rows are dropped, not shown.
`result` values are `hit`, `miss`, and `void` (the batter did not bat; excluded from accuracy).

### 5.4 Game level

| market | phase | output | note |
|---|---|---|---|
| `game_moneyline` | pregame (`log5_v1`) **and live** (`mlb_winprob_v1`) | `probs{home, away}`, `recommendation` | **the only game market that updates live** |
| `game_total` | pregame only | projected runs + P(over line) | uses team run rates, park factor, starter profile, weather |
| `pitch_result` / `ab_result` / `pitch_speed_ou` / `ab_pitches_ou` | pregame + live mirror | opening at-bat read (pregame) or latest call (live) | |

---

## 6. Requested player markets: what exists, ranked by impact

Impact = how much users look for the market × how directly our data supports it today.

| rank | market | role | value today | supporting data already served | gap |
|---|---|---|---|---|---|
| 1 | **1+ Hit** | batter | ✅ `batter_hit.probability` | `per_pa_probability`, `expected_pa`, `lineup_slot`, 30-d `hit_rate`, matchup `h_count/pa_count` | — |
| 2 | **1+ Home Run** | batter | ✅ `batter_hr.probability` | 30-d `hr_rate`, `batted_ball_profile.hard_hit_rate / pull_air_rate / fb_rate`, `batter_power_profile.iso / barrel_rate`, `park_hr_factors.hr_factor`, pitcher `hr_rate`, matchup `hr_count` | park/batted-ball not routed |
| 3 | **Pitcher strikeouts (O/U)** | pitcher | ❌ **blank** | `pitcher_rolling_stats.k_rate / whiff_rate`, profiles, opponent batters' `k_rate`, `ab_result` K prob per PA | no model or table |
| 4 | **Batter H+R+RBI (1+ / 2+)** | batter | ❌ **blank** | P(hit) component only; `at_bats.rbi` in R2 | runs need base-state derivation |
| 5 | **Pitcher outs recorded / IP** | pitcher | ❌ **blank** | `pitcher_fatigue_profile`, `sample_pitches`, avg pitches per PA | needs `at_bats.event` model |
| 6 | **Pitcher hits allowed (O/U)** | pitcher | ❌ **blank** | `pitcher_rolling_stats.hit_rate`, `contact_rate_against` | no model |
| 7 | **Pitcher earned runs allowed (O/U)** | pitcher | ❌ **blank** | team run rates, `game_total` per-side mean (not stored per side) | no model |
| 8 | Batter total bases (O/U 1.5) | batter | ❌ **blank** | `batter_power_profile.total_bases / iso` | no model |
| 9 | Pitcher walks allowed | pitcher | ❌ **blank** | `pitcher_rolling_stats.bb_rate` | no model |

**Blank-slot contract:** the market row still renders its label, line placeholder and the
supporting context that *does* exist (e.g. a starter's 30-d K rate beside an empty K
projection). The value cell shows `—` with a `NOT YET MODELED` tag.

---

## 7. What updates live vs. what doesn't

| surface | updates in-game? |
|---|---|
| score, inning, count, outs, batter, pitcher | ✅ every poll |
| pitch_result / pitch_speed / ab_result / ab_pitches calls | ✅ every pitch |
| game win probability | ✅ (`mlb_winprob_v1`) |
| game total | ❌ frozen pregame. A live total is **not modeled**, so leave the slot blank |
| batter P(hit)/P(HR) | ❌ stops at first pitch. **Live "rest of game" P(hit)/P(HR) is not modeled**. Derivable later as `1-(1-p)^remaining_PA`, blank today |
| in-game batter line (H / HR / PA so far) | derivable from `at_bats` for today, but not served per player. Blank slot |
| pitcher live pitch count / K so far | derivable from `pitches`/`at_bats`, not served. Blank slot |

---

## 8. Visual tokens (dark-only, from `docs/design-tokens.md`)

```
bg #0c1424  panel #141f33  panel2 #101b2e  panel3 #0d1729  chip #1b2942
bd #253449  bd2 #31435f  row #1a2740
txt #eef3f9  dim #aebdd2  mut #8493aa  faint #6f7f96  blue #7fa0c4
acc #22a566  grn #4ade80  amb #e0a83a  red #ff7b6b  purple(pitcher) #b49bff
good fg #5fe094 bg rgba(34,165,102,.22) · amber fg #f0c063 · bad fg #ff9b8f
Type: Hanken Grotesk 400–800 (headings 800/-.02em); IBM Plex Mono for every number
Probability bands: ≥66% green · ≥50% amber · else red (accuracy); for rare-event
props (HR) colour relative to league base rate, not absolute.
```

---

## 9. Gotchas a designer must respect

1. `ok`/graded is **null while pending**: never show a pending call as a miss.
2. `pitch_number` is 0-based; `error` is `predicted − actual` (negate for "actual vs call").
3. Team abbreviations for a player projection come from `team_id` (vocab map), not the row.
4. `/live` has no runners; bases diamond is empty and the situation cell shows `—`.
5. `game_context` covers only completed games, so today's stadium/ump/weather is `—` with a note.
6. Projections are `model_fair` and **not prices**: no odds, no edge, and no "bet" language.
7. `batter_hit`/`batter_hr` went live **2026-09-24**. There is no track record yet, so calibration shows `—`.
8. Late scratch equals `void`, so show a `DNP` badge, not a miss.
