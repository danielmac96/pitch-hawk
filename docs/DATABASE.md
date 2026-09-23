# Database reference

Schema lives in `supabase/migrations/`; filename order is apply order, and the
migrations are the source of truth. Everything below was read back from a
Postgres 16 with the full migration sequence applied — not from memory.

All app tables have RLS with a public-`SELECT` policy. `app_secrets` and
`backfill_progress` have RLS and **no** policies, so only the service role
reaches them.

> Thirty of the thirty-one migrations are idempotent.
> `20260802000003_hot_window_swap.sql` is a one-shot table swap and fails on a
> second run; `supabase db push` only applies unrecorded versions, so this is
> safe in deploy, but do not hand-run that file against a project that has it.

---

## Live pipeline

| table | purpose |
|---|---|
| `games` | one row per scheduled/played game (status, teams, scores, venue) |
| `pitches` | one row per pitch; conflict key `(game_pk, at_bat_index, pitch_number)`. **35-day hot window** — full history lives in R2 |
| `at_bats` | one row per plate appearance with result + pitch count; conflict key `(game_pk, at_bat_index)`. Same 35-day window |
| `live_state` | one row per in-progress game (count, players, current-PA pitches in `raw_json`), PK `game_pk` |
| `player_info` | names, handedness, position |
| `pitcher_rolling_stats` / `batter_rolling_stats` | 30-day aggregates the live scorer reads; refreshed daily by `refresh_*_rolling_stats`. `batter_rolling_stats.exit_velo_avg` / `.hard_hit_rate` were dropped in `20260919000001` -- declared since the core schema and NULL on every row ever, because the live `pitches` table has no `launch_speed`. Hard-hit rate now lives on `batted_ball_profile`, built from the warehouse where the input actually exists. `hit_rate` / `hr_rate` were ADDED in `20260923000001` and are populated: unlike exit velocity they come from `at_bats.result_detail`, which the hot table does carry. They are what `batter_hit` / `batter_hr` read at serving time. |
| `odds` | append-only snapshots per (game, market, source, outcome, **player**) with `implied_prob` and de-vigged `novig_prob`; pruned to 14d keeping the last snapshot. `player_id` is null for the game-level markets and set for player props (`batter_hit` / `batter_hr`), which are stored under OUR market names so a line joins the model that priced it |
| `ingest_runs` | per-job run log (ok, detail JSON); 7-day retention. `live-poll` no-ops are not logged |
| `backfill_progress` | single-row cursor for the self-draining backfill |
| `app_secrets` | cron secret, functions URL, CORS allowlist, optional API keys |

`at_bats_old` and `pitches_old` are leftovers of the hot-window swap. The drops
were deliberately left commented out in `20260802000003` so the swap could be
reversed; they hold pre-window rows and nothing reads them.

## Predictions and grading

| table | purpose |
|---|---|
| `predictions` | append-only audit log of every scored market row, graded in place by `settle`. Carries `actual_value` / `actual_label` and `backfilled_at`. **21-day retention**, rolled up first |
| `prediction_accuracy_daily` | permanent per-day/market/version accuracy aggregate; survives the `predictions` prune |
| `game_predictions` | pregame moneyline and totals, frozen once set. 35-day retention |
| `player_prediction_daily` | per-player per-day rollup |
| `picks` | published picks; unique `nulls not distinct (pick_date, game_pk, market, at_bat_index, recommendation)`; graded by `settle` |
| `model_params` | model registry — exactly one `is_active` row per market, enforced by a partial unique index |
| `model_runs` | every training run, promoted or not, with folds, config, holdout, params and the gate's verdict |

**Retention interlock:** the rollup must run before the prune. `predictions`
older than 21 days are deleted permanently, so `rollup_prediction_accuracy`
runs first and `prune_predictions` skips if it did not.

## Player projections

`player_game_projections` — per-batter, per-game P(hit) and P(home run),
written by `game-predict` on every pass and served at `GET /projections`.

**Its own table, not `predictions`.** `predictions` is keyed
`(game_pk, at_bat_index, pitch_number, market)` and carries no `player_id`; a
game-long projection has no at-bat index, and `settle` grades against the next
pitch, the finished at-bat or the final score — none of which is "did this
batter get a hit today". Keeping it separate means `predictions` / `picks` /
`settle` are untouched.

**Not graded, deliberately.** No `result`, no `profit_units`, no `graded_at`.
Every row is `book = 'model_fair'`: there is no prop source for these markets,
so a track record here would be measured against even money.

Two probabilities per row and they answer different questions:
`per_pa_probability` is what the model emits, per plate appearance;
`probability` is that rolled up over `expected_pa` trips. Both are stored so
the published number is reproducible rather than merely trusted. Expected
plate appearances come from the batting-order slot — *measured* at 4.49 for
the leadoff spot down to 3.45 for the ninth.

Re-scored every pass rather than frozen like the pregame markets, because
lineups post a few hours before first pitch: the 10:00 ET run usually sees
none and a later one sees all nine. 35-day retention, via
`prune_player_game_projections`.

**Graded, but not priced.** `settle` fills `result` / `actual_count` /
`plate_appearances` once a game is final — and nothing else. No `profit_units`,
no price: grading a `model_fair` row against even money would manufacture a
betting record out of a market with no line.

What grading buys is **realised calibration**. `projection_calibration()`
reports mean predicted against observed rate per market, the production
counterpart of the offline gate's `calibration_ratio`;
`projection_reliability(market)` breaks it into deciles when the single number
says something is wrong and the question becomes where. This is the check that
would have caught `ab_result` running ~1.4× hot — that was found from graded
picks, not from a training run.

`result = 'void'` is a projected batter who **did not bat** — a late scratch,
or a lineup that changed after scoring. Voids are excluded from both sides of
the calibration ratio: counting them as misses would drag the observed rate
down by however often clubs change their minds, and a calibrated model would
then read as over-confident.

## Display aggregates

Built nightly from R2 by `python -m warehouse publish`, each staged into a
`*_staging` twin and swapped in one transaction — a failure leaves the previous
night's data serving rather than a half-written table.

| table | served at |
|---|---|
| `pitcher_profiles` / `batter_profiles` | `/player/{id}/profile` |
| `situational_splits` | `/player/{id}/splits` |
| `pitcher_fatigue_profile` | `/player/{id}/fatigue` |
| `batter_power_profile` | (feeds profiles) |
| `batted_ball_profile` | (not yet routed) |
| `park_hr_factors` | (not yet routed) |
| `matchup_history` | `/matchup/{pitcher}/{batter}` |
| `game_context` | `/game/{game_pk}/context` |

`batted_ball_profile` is player x role x scope: GB/FB/LD/popup, pull, oppo,
pull-in-the-air, hard-hit (EV >= 95), mean exit velocity and launch angle.
Rates are over **balls in play**, never plate appearances.

`park_hr_factors` is venue x **season** -- fences move, so one all-history
factor would average a park across two shapes. It is a paired home-vs-away
ratio, NOT the league-mean construction `park_factors()` uses; see
`docs/DATA-PIPELINE.md` 10.9 for why.

The publishable set lives in one place, `publishable_aggregates()`.
`publish_aggregate`, `clear_aggregate_staging` and the RLS block all read it
rather than carrying their own copies.

`matchup_history` keeps the column names `pa_count` / `so_count` / `bb_count` /
`h_count`. `_shared/aggregates.ts` serves them straight through, so renaming
them is a breaking API change.

## Views

| view | purpose |
|---|---|
| `prediction_coverage_daily` | per-game market coverage |
| `pitch_prediction_coverage` | per-pitch velocity/result coverage |

The per-pitch view exists because the per-game number cannot see a game that
was scored once and then stopped.

---

## Functions

Read the live list rather than trusting a doc:

```sql
select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' order by proname;
```

| function | purpose |
|---|---|
| `activate_model` / `rollback_model` | atomic registry swap; rollback reactivates the previously active version |
| `pick_record` | record-page aggregate |
| `prediction_coverage` / `prediction_coverage_pitch` | coverage readouts behind `/coverage` |
| `aggregate_freshness` | when each display aggregate was last published |
| `publish_aggregate` / `clear_aggregate_staging` | the stage-then-swap pair, called per table by `warehouse publish` |
| `refresh_pitcher_rolling_stats` / `refresh_batter_rolling_stats` | daily rolling-stat rebuild |
| `rollup_prediction_accuracy` / `rollup_player_predictions` | retention rollups, run before the prunes |
| `prune_predictions` / `prune_odds` / `prune_ingest_runs` / `prune_game_predictions` / `prune_player_prediction_daily` / `prune_cron_history` | retention |
| `team_run_rates` / `park_factors` | inputs to `game-predict` |

`SECURITY DEFINER` helpers have `EXECUTE` revoked from `anon` and
`authenticated` — run them as the service role.

Five functions were dropped in `20260823000001` after being verified
unreferenced: `get_pitcher_stats`, `get_pitcher_ab_stats`,
`get_league_averages`, `train_home_advantage`, and
`prediction_pitch_coverage(date)` (a near-name collision with
`prediction_coverage_pitch`). The `train_*_cells` RPCs went earlier, in
`20260802000002`, when training moved to the offline workbench.
