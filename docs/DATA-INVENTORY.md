# Pitch Hawk — Data Inventory

**Audience:** Head of Product
**Purpose:** what data we hold today, what it lets us build, and where the gaps are
**As of:** 2026-07-28 · Supabase project `MLB Next Pitch` (`gfxpchtyncgsczqdvohr`)

---

## The three things that matter most

1. **We are at 467 MB of a 500 MB cap (93%).** Storage is the binding constraint
   on every "let's also capture X" decision below. ~36 MB of cleanup is queued;
   beyond that, new data means a paid tier.

2. **Two of our four core prediction markets are performing at or below a
   coin flip.** Next-pitch speed and next-pitch result — the two most visible
   things on the Live Feed — are not currently beating a trivial guess. Details
   in *Model performance*.

3. **The Data Feed tab has no backing data service.** Everything it shows is
   accumulated in the browser while the tab is open and is lost on refresh.
   Nothing on that tab survives a page reload today.

---

## What we hold

Complete play-by-play for **two MLB seasons**, ingested from the MLB Stats API.

| What | Volume | Coverage |
|---|---:|---|
| Pitches | 1,193,565 | 2025 full season (723,555 · 2,475 games) + 2026 to date (470,010 · 1,603 games) |
| Plate appearances | 308,056 | same window |
| Games | 4,110 | scheduled + final, 2025-03-27 → 2026-09-22 |
| Players | 1,721 | name, handedness, position, debut |
| Pitcher×batter matchups | 40,551 pairs | avg 4.3 PAs/pair, deepest 21 |
| 30-day rolling form | 573 pitchers · 481 batters | refreshed daily |
| Predictions (raw) | 201,516 | rolling 21-day window |
| Prediction accuracy history | 106 day/market rows | permanent, never pruned |
| Published picks | 14,166 | 2026-07-07 onward |

**Per-pitch we capture:** velocity, pitch type, strike-zone location (1–14),
outcome, ball/strike count, outs, inning, half-inning, timestamp.
Completeness is excellent — **99.96%** of pitches have velocity, type and zone.

**Per plate appearance we capture:** pitch count, coarse result, and a detailed
result (`single`, `double`, `triple`, `home_run`, `walk`, `hit_by_pitch`,
`sac_fly`, `grounded_into_double_play`, and 20+ more).

---

## What we can build today

These are supported by data already in hand — no new ingestion required.

| Capability | Backed by |
|---|---|
| Live pitch-by-pitch board with model probabilities | `live_state` + `predictions`, refreshed every 30s |
| Next-pitch speed / result / AB outcome / AB pitch-count predictions | 1.19M-pitch training corpus |
| Pitcher & batter **recent form** (30-day) | `pitcher_rolling_stats`, `batter_rolling_stats` |
| Pitcher **tendencies** — zone rate, whiff rate, chase-induced, fastball vs offspeed velocity | same |
| Batter tendencies — chase rate, contact rate, K/BB rate | same |
| **Head-to-head history** — this batter vs this pitcher, career PA/K/BB/H | `matchup_history` |
| **Count-situation splits** — behaviour at 0-2 vs 3-1, etc. | `pitches.balls/strikes` |
| Platoon splits (L/R matchups) | `player_info` handedness |
| **Home-run and extra-base-hit rates** | `at_bats.result_detail` |
| Velocity distribution per pitcher, per pitch type | `pitches.start_speed` + `pitch_type` |
| Model accuracy reporting over time | `prediction_accuracy_daily` |

**The most under-used asset:** `at_bats.result_detail` already distinguishes
home runs, doubles and triples. We are currently collapsing all of it into a
single `hit` bucket. Total-bases, XBH and HR-rate surfaces are available with
zero new data capture.

---

## What we cannot build, and why

Ordered by product impact.

### 1. Situational splits — "with runners in scoring position"
**Blocked.** We do not record who is on base. Not on the pitch, not on the
plate appearance. This is the single biggest gap: RISP, bases-empty, and
runners-on splits are table stakes for a baseball analytics product, and we
cannot produce any of them.
*It also degrades predictions* — pitchers throw differently from the stretch,
which affects both velocity and pitch counts.
**Cost to fix:** the MLB feed already returns it; we discard it during ingest.
One ingest change + a backfill. ~15–25 MB.

### 2. Pitcher fatigue / velocity decay — "is he tiring?"
**Blocked.** We do not track cumulative pitch count within a game. A pitcher's
velocity trend across a start — arguably the most compelling "trend" story on
the Data Feed — is not currently derivable at serve time.
**Cost to fix:** computable from data we already hold, as a nightly rollup.
Small (~5 MB). No new ingestion.

### 3. Times through the order
**Blocked.** Third-time-through penalty is one of the strongest known signals
for at-bat outcomes. Not captured.
**Cost to fix:** derivable from existing data. Negligible storage.

### 4. Score and game leverage at pitch time
**Blocked.** We store the score on the live game state but never stamp it onto
the pitch record, so "how does he pitch with a 4-run lead" is unanswerable
historically.

### 5. Anything requiring a page refresh to persist
**Blocked.** No API endpoint serves pitcher/batter history, form, trends or
splits. The data exists in the database; there is no route to it. This is a
backend gap, not a data gap — and it is the cheapest high-impact fix on this
list.

### 6. Odds, edges and betting surfaces
**Deliberately off.** Odds ingestion is paused and the wagering UI is behind a
disabled feature flag. 444 stale odds rows remain. This is a product decision
to revisit, not a data limitation.

---

## Model performance — read this carefully

Raw win rates are misleading because the markets have different numbers of
outcomes. Measured against the correct baseline (always guessing the most
common outcome), over 14,352 graded predictions each:

| Market | Model | Baseline | Verdict |
|---|---:|---:|---|
| Game moneyline | 70.8% | 53.5% | **Strong** — clearly adding value |
| AB pitch count O/U | 56.4% | 50.0% | **Good** — +6.4 pts |
| At-bat result | 52.5% | 46.4% | **Good** — +6.1 pts |
| Next-pitch speed O/U | 47.3% | 50.0% | **Below a coin flip** |
| Next-pitch result | 44.8% | 46.4% | **Below always-guess-strike** |

The two weakest markets are the two most prominent on the Live Feed. Two
plausible readings, and we should determine which before investing further:

- **Feature starvation** — next-pitch outcomes depend heavily on base state,
  fatigue and sequencing (what was just thrown), none of which we capture. This
  points at gaps 1–3 above.
- **Market difficulty** — next-pitch outcome may be close to irreducibly random
  at our feature resolution, in which case we should reposition these as
  *context* rather than *predictions*.

**Recommendation:** treat this as a decision point, not a bug to quietly fix.
Filling gaps 1–3 is the cheapest way to test the first hypothesis.

Also note: **10,047 of 14,166 picks are stuck unresolved** because the
settlement job has been switched off since 2026-07-16. The published record
(1,979 W / 1,721 L / 419 push) has been frozen for two weeks.

---

## Storage position

| | Size |
|---|---:|
| Pitches (incl. indexes) | 284 MB |
| Plate appearances | 57 MB |
| Predictions | 53 MB |
| Everything else in the app | ~25 MB |
| Pipeline overhead (cron/network logs) | ~43 MB |
| **Total** | **467 MB of 500 MB** |

Recent cleanup removed four never-used tables, added retention to the only
unbounded table, and pruned 64,000 rows of bookkeeping. A further ~36 MB of
pipeline overhead is queued for reclamation.

**Implication for product:** we have roughly 30–70 MB of headroom depending on
that cleanup. Gaps 1–3 above fit inside it — collectively ~25–35 MB. Anything
larger (more seasons of history, pitch-level spin/movement data, video) needs a
paid tier first. The next tier is 8 GB, which removes this constraint entirely
for the foreseeable future.

---

## Suggested sequence

1. **Restart settlement** — unfreezes the public record. Hours of work.
2. **Build the Data Feed API** — the data already exists and is unreachable.
   Highest impact per unit effort on this list.
3. **Capture base state, in-game pitch count, times-through-order** — unblocks
   situational splits and velocity trends, and tests whether the two weak
   markets are feature-starved.
4. **Surface `result_detail`** — HR/XBH content for free.
5. **Decide on the paid tier** before any further history or data-richness work.

---

## Open questions for product

- **Player coverage looks thin.** We have 674 distinct batters for the 2025
  season across 2,475 games. Game and pitch coverage is complete (292
  pitches/game matches a real game), and pitcher coverage looks right at 873.
  The batter count is lower than a full MLB season would suggest. Worth an
  audit before we publish anything claiming league-wide batter coverage.
- **Is next-pitch prediction the right headline?** Two of the four markets
  don't currently beat a trivial guess. Repositioning them as live context is a
  legitimate alternative to investing in better features.
- **Do we still want odds and betting surfaces?** Infrastructure exists and is
  switched off. Keeping it dormant is cheap; deciding never to ship it would
  let us delete a meaningful amount of code and schema.
