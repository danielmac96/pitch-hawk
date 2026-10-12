# Model lab

The working record of model development: what is being tried, how it scored,
what was decided. The [cards](README.md) describe what is live; this is where
it changes.

Tables between `lab:begin` / `lab:end` markers are generated — edit anything
else by hand.

## Working loop

1. **Propose.** Add a row to [Proposals](#proposals) with the next free id.
2. **Run**, tagged with the id, on a runner (commit
   `modeling/lab/request.json`; see `.github/workflows/model-lab.yml`):
   ```bash
   python -m modeling markets --record --proposal P-002
   ```
3. **Refresh** the leaderboard:
   ```bash
   python -m modeling report              # leaderboard
   python -m modeling report --readiness  # + data readiness (a few minutes)
   ```
4. **Decide.** Update the proposal's status and add a line to
   [Decisions](#decisions). `python -m modeling stage-v3` applies the
   promotion rule and refuses a run that fails it.

## Protocol

1. **Every number comes from `model_runs`.** A run is recorded whether or not
   it wins. Nothing is typed into the generated tables.
2. **Validation** is walk-forward, test seasons 2018–2025, 2020 excluded
   from the aggregate. A naive baseline is recorded for every fold.
3. **Test** is the 2026 season. It is scored once per proposal and never
   used to choose between variants. 2026 is already spent for `pa_outcome`
   feature choices (run 2 of 2026-10-08 was chosen partly on run 1's 2026
   calibration); **2027 is the next clean test** and is untouched from its
   first game.
4. **Promotion rule** (`modeling/report.py::verdict`). A run may be staged
   only if it:
   - beats its best baseline on validation **and** on the 2026 test;
   - has 2026 calibration within 1 ± 0.10 (± 0.15 for events rarer than
     15%), judged on the variant that ships — a calibrator that did not
     help is dropped, and its numbers do not count;
   - is not more than 2% worse on validation than the active v3 version.
5. **Rejected proposals stay** in this file with the reason.
6. **Models are fitted on the regular season only.** Postseason games live in
   the `post_*` datasets and are used for grading, not fitting.

## Data readiness

A season is ready when every pitch-day is verified, the pitch-physics
columns are filled, `outs` never exceeds 2 and `player_box` covers every
game-day. Columns show the share of pitches with a value.

<!-- lab:begin readiness -->
_Generated 2026-10-12 by `python -m modeling report --readiness`. 0 of 12 seasons ready._

| season | pitch-days | verified | pitches | start_speed | spin_rate | release_pos_x | pfx_x | launch_speed | max outs | ready |
|---|---|---|---|---|---|---|---|---|---|---|
| 2015 | 179 | 0 | 703,549 | 99.8% | 99.8% | 0.0% | 0.0% | 16.1% | 3 | no: 179 pitch-days unverified; pitch physics not filled; outs out of range |
| 2016 | 179 | 0 | 716,116 | 100.0% | 99.9% | 0.0% | 0.0% | 15.8% | 3 | no: 179 pitch-days unverified; pitch physics not filled; outs out of range |
| 2017 | 179 | 0 | 721,244 | 99.6% | 97.7% | 99.6% | 99.6% | 15.8% | 3 | no: 179 pitch-days unverified; outs out of range |
| 2018 | 184 | 0 | 721,829 | 99.6% | 98.1% | 97.6% | 97.6% | 16.0% | 3 | no: 184 pitch-days unverified; pitch physics not filled; outs out of range |
| 2019 | 185 | 0 | 733,698 | 99.4% | 97.6% | 0.0% | 0.0% | 15.7% | 3 | no: 185 pitch-days unverified; pitch physics not filled; outs out of range |
| 2020 | 67 | 0 | 264,190 | 100.0% | 99.5% | 0.0% | 0.0% | 16.6% | 3 | no: 67 pitch-days unverified; pitch physics not filled; outs out of range |
| 2021 | 182 | 0 | 712,404 | 100.0% | 99.6% | 0.0% | 0.0% | 17.1% | 3 | no: 182 pitch-days unverified; pitch physics not filled; outs out of range |
| 2022 | 179 | 0 | 708,876 | 99.9% | 99.7% | 0.0% | 0.0% | 17.5% | 3 | no: 179 pitch-days unverified; pitch physics not filled; outs out of range |
| 2023 | 183 | 0 | 719,921 | 100.0% | 99.4% | 0.0% | 0.0% | 17.3% | 3 | no: 183 pitch-days unverified; pitch physics not filled; outs out of range |
| 2024 | 185 | 0 | 710,320 | 99.9% | 99.4% | 0.0% | 0.0% | 17.4% | 3 | no: 185 pitch-days unverified; pitch physics not filled; outs out of range |
| 2025 | 184 | 182 | 711,264 | 100.0% | 99.7% | 0.0% | 0.0% | 17.5% | 3 | no: 2 pitch-days unverified; pitch physics not filled; outs out of range |
| 2026 | 184 | 156 | 713,670 | 100.0% | 99.8% | 2.9% | 2.9% | 17.4% | 3 | no: 28 pitch-days unverified; pitch physics not filled; outs out of range |

| dataset | seasons | days | rows | verified days |
|---|---|---|---|---|
| `at_bats` | 2015-2026 | 2,070 | 2,096,235 | 338 |
| `games` | 2015-2026 | 2,070 | 27,655 | 338 |
| `game_weather` | 2015-2026 | 2,070 | 27,478 | 0 |
| `player_box` | 2015-2026 | 2,070 | 792,016 | 0 |
<!-- lab:end readiness -->

### Data notes

| date | finding | consequence |
|---|---|---|
| 2026-10-12 | `pitches.outs` held the post-PA out count (22% of rows wrong, every season). Fixed in the flattener; stored history is still wrong until re-ingested. | Do not use `outs` from any season not marked ready. No current model reads it. |
| 2026-10-12 | Pitch-physics columns (`release_*`, `accel_*`, `pfx_*`) are filled for 2017 and most of 2018 only. | Blocks P-007. Fixed by the season re-ingest (`warehouse-backfill.yml`). |
| 2026-10-12 | 2015–2016: the MLB feed carries the physics fields but has no `extension`, `plate_time`, `break_vertical_induced` or `break_horizontal` (0.1–0.3% filled). Not an ingest defect. | Features built on those four columns start in 2017. |
| 2026-10-12 | Only 2025 (182 of 184 days) and 2026 (156 of 184) are verified; re-ingest clears verification by design. | Each backfill run re-verifies its seasons. |
| 2026-10-12 | Postseason was never in R2 (ingest fetched regular season only). Now written to `post_pitches`, `post_at_bats`, `post_games`, `post_player_box`. | Live October predictions can be graded from the warehouse. Not read by any fit. |
| 2026-10-12 | Our own prediction export had holes (the nightly export ran on few nights after 2026-09-24). The nightly now re-exports a trailing week. | Run the nightly once with `export_days=35` to refill what Supabase still holds. |

## Leaderboard

<!-- lab:begin leaderboard -->
_Generated 2026-10-12 by `python -m modeling report`. Do not edit by hand._

**Serving**

| market | version | live_stamp | state |
|---|---|---|---|
| ab_pitches_ou | v2_20260809 | v2_20260809 | ✅ match |
| ab_result | v2_20260809 | v2_20260809 | ✅ match |
| batter_hit | v2_20260924 | v2_20260924 | ✅ match |
| batter_hit_rog | base_v1 |  | — no live rows |
| batter_hr | v2_20260924 | v2_20260924 | ✅ match |
| batter_hr_rog | base_v1 |  | — no live rows |
| batter_hrr | base_v1 | base_v1 | ✅ match |
| batter_tb15 | base_v1 | base_v1 | ✅ match |
| game_moneyline | v1_20260707 | mlb_winprob_v1 | 🚫 not read |
| game_total_live | base_v1 |  | — no live rows |
| pitch_result | v2_20260809 | v2_20260809 | ✅ match |
| pitch_speed_ou | v2_20260809 | v2_20260809 | ✅ match |
| pitcher_bb | base_v1 | base_v1 | ✅ match |
| pitcher_er | base_v1 | base_v1 | ✅ match |
| pitcher_hits | base_v1 | base_v1 | ✅ match |
| pitcher_k | base_v1 | base_v1 | ✅ match |
| pitcher_outs | base_v1 | base_v1 | ✅ match |

Scored with no registry row: `game_total` → `total_v1`.

Validated v3 runs not staged: `batter_hit`, `batter_hr`, `batter_hrr`, `batter_tb15`, `game_moneyline`, `game_total`, `pa_outcome`, `pitcher_bb`, `pitcher_er`, `pitcher_hits`, `pitcher_k`, `pitcher_outs`, `team_runs`, `workload`.

**Runs** — latest per market, pipeline and proposal; lower is better

| market | pipeline | proposal | run | metric | validation | val_baseline | test_2026 | test_baseline | test_calibration | promotable | served |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ab_pitches_ou | v2 |  | 2026-08-09 | logloss | 1.6821 |  | 1.6832 |  |  |  | yes |
| ab_result | v2 |  | 2026-08-09 | logloss | 1.2447 |  | 1.2485 |  |  |  | yes |
| batter_hit | markets_v3 |  | 2026-10-08 | logloss | 0.6555 | 0.6609 | 0.6623 | 0.6667 | 0.9900 | yes | no |
| batter_hit | v2 |  | 2026-09-24 | logloss | 0.5238 |  | 0.5212 |  | 1.0116 |  | yes |
| batter_hr | markets_v3 |  | 2026-10-08 | logloss | 0.3536 | 0.3601 | 0.3492 | 0.3550 | 0.9568 | yes | no |
| batter_hr | v2 |  | 2026-09-24 | logloss | 0.1359 |  | 0.1355 |  | 1.0400 |  | yes |
| batter_hrr | markets_v3 |  | 2026-10-08 | logloss | 0.6165 | 0.6216 | 0.6217 | 0.6255 | 0.9849 | yes | no |
| batter_tb15 | markets_v3 |  | 2026-10-08 | logloss | 0.6428 | 0.6467 | 0.6400 | 0.6436 | 0.9975 | yes | no |
| game_moneyline | markets_v3 |  | 2026-10-08 | logloss | 0.6750 | 0.6913 | 0.6821 | 0.6916 | 1.0012 | yes | no |
| game_moneyline | v2 |  | 2026-08-09 | brier | 0.2490 |  | 0.2495 |  |  |  | no |
| game_total | markets_v3 |  | 2026-10-08 | logloss | 0.6894 | 0.6936 | 0.6847 | 0.6931 | 0.9167 | yes | no |
| pa_outcome | markets_v3 |  | 2026-10-08 | logloss | 1.4359 | 1.4616 | 1.4315 |  |  | yes | no |
| pa_outcome | v2 |  | 2026-10-08 | logloss | 1.4368 | 1.4616 | 1.4320 | 1.4559 |  |  | no |
| pitch_result | v2 |  | 2026-08-09 | logloss | 1.0161 |  | 1.0178 |  |  |  | yes |
| pitch_speed_ou | v2 |  | 2026-08-09 | rmse | 1.7799 |  | 1.7375 |  |  |  | yes |
| pitcher_bb | markets_v3 |  | 2026-10-08 | mae_expected | 1.0633 | 1.0562 | 1.0278 | 1.0534 | 0.9022 | no | no |
| pitcher_er | markets_v3 |  | 2026-10-08 | mae_expected | 1.5752 | 1.6349 | 1.5649 | 1.6432 | 0.9978 | yes | no |
| pitcher_hits | markets_v3 |  | 2026-10-08 | mae_expected | 1.7601 | 1.8433 | 1.7510 | 1.8504 | 0.9740 | yes | no |
| pitcher_k | markets_v3 |  | 2026-10-08 | mae_expected | 1.8312 | 2.0541 | 1.7997 | 2.0153 | 1.0299 | yes | no |
| pitcher_outs | markets_v3 |  | 2026-10-08 | mae_expected | 3.1229 | 3.3985 | 3.0615 | 3.3741 | 1.0341 | yes | no |

**Live** — graded player projections (ratio = predicted ÷ observed)

| market | model_version | n | mean_predicted | observed | ratio |
|---|---|---|---|---|---|
| batter_hit | v2_20260924 | 395 | 0.6469 | 0.5342 | 1.2110 |
| batter_hr | v2_20260924 | 395 | 0.1266 | 0.0835 | 1.5153 |

**Live** — pregame game markets

| market | model_version | n | mean_confidence | won |
|---|---|---|---|---|
| game_moneyline | log5_v1 | 300 | 0.5775 | 0.6033 |
| game_total | total_v1 | 284 | 0.5117 | 0.4648 |
<!-- lab:end leaderboard -->

## Proposals

Status: `proposed` → `running` → `accepted` / `rejected`. Needs = what must
be true before it can start.

| id | market | status | hypothesis | change | judged on | needs |
|---|---|---|---|---|---|---|
| P-001 | all v3 markets | proposed | The 2026-10-08 results hold on re-ingested, verified data. | Re-run the v3 pipeline unchanged; stage and activate what passes the rule. | Every market within noise of its 2026-10-08 numbers; rule passes. | `at_bats`, `player_box` ready |
| P-002 | `pitcher_bb` | proposed | It fails because `pa_outcome` under-predicts walks (2026 calibration 0.948), not because of the roll-up. | Shorter league τ for BB; handedness-split BB ratings; umpire zone term if still short. | Expected-walks MAE below the pitcher's own mean on validation and test. If not: remove the market. | P-001 |
| P-003 | every published line | running | Skill at the published alternate lines is unmeasured, and the self-priced median hides starter-prop skill. | No model change. Score the full count distribution: RPS (the sum of Brier scores over every ladder line) and exact-count NLL, each against the training seasons' marginal distribution. Implemented 2026-10-12 for the five starter markets and for hits, home runs and total bases; first numbers arrive with the P-001 run. `batter_hrr` has no count distribution (it is P(hit) through a calibrator), so its 2+ and 3+ lines stay unscored until it has a structural model. | RPS below its baseline on validation and test, per market. | P-001 |
| P-004 | rest-of-game hit / HR | proposed | Per-PA v3 rates rolled over a remaining-PA distribution beat the `base_v1` constant-rate formula. | Replay every PA boundary 2018–2026: remaining PAs given inning, slot, score, outs. New `modeling/live.py`, TypeScript twin. | Log loss by inning against `base_v1` and against the remaining-PA base rate. | P-001; `outs` ready |
| P-005 | `game_total` live | proposed | Runs so far plus a negative binomial for the remainder beats scaling pregame means by outs left. | Same replay at half-inning boundaries; adjust for starter still in vs bullpen. | Exact-total NLL by inning against `base_v1`. | P-001; `outs` ready |
| P-006 | `game_moneyline` live | proposed | The P-005 run distributions give a win probability at least as good as MLB's. | Win probability from remaining-run distributions and the score. | Log loss against archived `mlb_winprob_v1` and a base-out-score table. Replace only if it wins. | P-005 |
| P-007 | `pa_outcome` v4 | proposed | Outcome-only ratings are near their ceiling (0.0024 log loss over log5); pitch-level ratings add signal. | Pitcher whiff / velocity / movement ratings and batter exit-velocity / hard-hit / pulled-air ratings through the same decay-and-shrink function; serving path in `publish-ratings`. | 7-class log loss; then every derived market. | all seasons ready |
| P-008 | `ab_result`, `pitch_speed_ou` | proposed | `pa_outcome` with count replaces `ab_result` and removes `CALIB_SHRINK`; a pitch-mix mixture gives `pitch_speed_ou` a real line. | Count features on `pa_outcome`; P(pitch type) × per-type velocity. | Log loss against v2 and a count-state baseline. | P-001 |

## Decisions

| date | decision | why |
|---|---|---|
| 2026-10-08 | `pa_outcome` uses log5 matchup logits, not raw league logits. | League logits fitted season effects (coefficients ±13, 2026 HR calibration 0.933 → 0.961 after the change). |
| 2026-10-08 | Calibrators shipped only for `batter_hit`, `batter_hrr`, `pitcher_er`, `pitcher_bb`, `game_moneyline`. | Elsewhere the calibrated probability scored worse out of sample than the raw one. |
| 2026-10-08 | `pitcher_bb` v3 not staged. | Validation MAE 1.063 against 1.056 for the pitcher's own mean. |
| 2026-10-12 | Promotion rule adopted and enforced in `stage-v3`. | v3 staging had no recorded rule. |
| 2026-10-12 | Postseason kept out of every fit; stored separately. | Most readers of `pitches` / `at_bats` do not filter on game type. |
