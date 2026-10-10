# Pitch Hawk — 100-user simulation: UX & value-finding pain points
Run 2026-10-10 · 10 cohorts × 10 personas · wagering flag ON · local mock API (live API blocked by network policy)
Raw data: results/*.json (per-persona journeys, pain points, quotes) · simulation brief: BRIEF.md

## Headline
| metric | value |
|---|---|
| Task success | **1 full / 69 partial / 30 failed** |
| Would return | 16 yes / 66 maybe / 18 no |
| Mean NPS score (0–10) | 4.8 (NPS −93) |
| Median time-to-first-value | ~120 s |
| Unique pain-point ids | 175 → clustered into 12 themes |

Cohorts: sharp props (NPS 3.8, 4 failed) · HR longshots (5.2, 3) · rec parlays (4.8, 3) · live in-game (4.7, 4) · DFS pick'em (4.8, 2) · quant validators (5.1, 3) · mobile-first (5.4, 2) · pitcher props (3.8, **6**) · game lines (4.8, 2) · first-run/trackers (5.3, 1).

Users liked the per-PA × xPA breakdown, the lineup-confirmed filter, the one-line WHY, honest BASE/small-sample/SAMPLE labels, fast search, deep links, the Biggest Swing/Due Up cards, and the weather/ump/park grid.

## Ranked themes (personas affected × avg severity)
| # | theme | personas | cohorts | avg sev | failed-task root cause |
|---|---|---|---|---|---|
| 1 | **No market price / edge anywhere** (props, game lines, live) | **63** | 9 | 4.1 | 8 |
| 2 | **Pick tracking: bet slip, CLV/ROI, history, dates** | 30 | **10** | 3.7 | 4 |
| 3 | **Trust & provenance** (calibration, model version, BASE, methodology) | 33 | **10** | 3.4 | 1 |
| 4 | **Lines don't match book menus** (alt ladders, line input, under/less side, F5/NRFI/TT/TB/HRR 1.5) | 22 | 5 | **4.2** | **7** |
| 5 | Mobile layout & density | 24 | 8 | 2.9 | 0 |
| 6 | Pitcher/starter tooling | 20 | 7 | 3.4 | 3 |
| 7 | Discovery/IA (single-market view, filters, game↔props nav) | 22 | 6 | 2.8 | 0 |
| 8 | Parlay builder & correlation | 13 (9/10 of rec cohort) | 3 | 4.2 | — |
| 9 | Matchup context on board (hand, park/wind, Statcast, bullpen) | 14 | 4 | 3.8 | 3 |
| 10 | Live: alerts, freshness, live totals, multi-game | 13 | 5 | 4.0 | 4 |
| 11 | Export / share / API | 12 | 4 | 3.8 | — |
| 12 | Onboarding & jargon | 7 | 4 | 3.0 | — |

### 1. No market price or edge (44 personas cite props specifically)
- The board ranks by **LIFT = model − league rate**, which is not a value signal. Every session ends in a sportsbook app and by-hand odds conversion.
- Verified in code: `loadLive` fetches `/edge/{pk}` when the flag is on (pitchhawk-data.js:363), but **pitchhawk.js never renders sources/price/edge**. `docs/FRONTEND.md` claims the flag restores an "Edge column" and "edge-threshold highlighting"; that is doc drift.
- Player-prop odds ingest exists (The Odds API, behind `the_odds_api_props`), but `odds-ingest` has no cron.
- Pitcher lines are the model's own floor(mean)+0.5 (`_shared/basemodels.ts:124`), not book lines.
- Cheap wins with no data cost: show fair American odds next to every %, and add a "your price" input on each row that computes edge/EV and sorts by it.

### 2. Pick tracking (all 10 cohorts)
- The star pins a player or game, not a leg (`b:`/`g:` keys, pitchhawk.js:755). The watch pill then shows a *different* market (806–812). Pitchers can't be starred.
- Pins are deleted after the slate (`expirePins`, 670–685). They are stored only in localStorage, so nothing syncs across devices.
- `?date=` is silently ignored, so yesterday's board and picks can't be viewed.
- Wanted: a leg-level slip (player + market + side + line + price + stake), auto-grading, and a record with ROI and CLV.

### 3. Trust & provenance (all 10 cohorts)
- **Bug (verified):** headline Brier skill pools markets against one base rate (`derive()`, pitchhawk.js:~3901). With All selected it shows 24.5%, while per-market skill is 0.5–1.3%.
- The model version appears only in a tooltip. It's not on rows, the CSV, or the Data Feed, and results can't be split by version. BASE vs trained isn't disclosed per number.
- The 7-day Predictions tiles (n≈27) conflict with the 30-day Data Feed and don't link to it. Data Feed uses 10-pt bins, which can't resolve HR (+300…+700 sits in 12–25%). Gaps are coloured by absolute points.
- Starter props are graded by the backend but never shown. The Guide is a glossary, not methodology.

### 4. Lines don't match what books/apps post (highest failure rate per persona)
- There's no K/outs/H/ER/BB alt ladder, though Poisson makes the full distribution cheap (pitchhawk.js:2439).
- Users can't type the book's line. Only the over side is shown. There's no 2+ hits, no HRR 1.5, TB isn't rankable, and there's no F5/NRFI/team total/run line. Team run means already exist in `game-predict` (mu_home/mu_away, :629–641).

### 5–12. Highlights
- **Live bug (verified):** alerts are effectively dead. Polling stops when the tab is hidden (pitchhawk.js:4660), but OS notifications only fire *when* hidden (701–704).
- Live Markets shows the frozen pregame total; the live total exists only inside an expanded Home card. The "updated" clock is fetch time, not last-pitch time. The offline banner scrolls away while the header still says "auto-refreshing".
- **Mobile:** at 375×667 the first pick is about 500px down; the top 25 is a 5,480px scroll; names truncate at 360/375; the chip row and results count clip ("St…", "126 r…"); 93 of 98 controls are under 44px; the mobile model-record chip ignores the selected market (pitchhawk.js:1483).
- **Starters tab:** no sort, no min-lift or lineup filters; the form columns (30D K%, whiff, velo, fatigue) are all "—" with no reason given. No opposing-lineup K% vs hand, leash or days of rest.
- **IA:** single-market chips allow no cross-market "best plays". The "Live mode" label persists when filtered to Upcoming (pitchhawk.js:1074). Batter names in the game drawer aren't links. There's no `#/game/<pk>` page.
- **Export:** no ids, as-of timestamp or model_version in the CSV; no Data Feed export; no share for a specific pick.
- **Copy:** copy.js:59 says "props reserved until modeled" while props are on screen; the Guide opens with "Nothing here is a price or a pick".

## Suggested plan shape (for the Claude Code plan)
**Phase 0: verified bugs, small diffs.** Per-market Brier skill; alerts in hidden tabs (keep a slow poll, or send in-tab toasts plus OS notifications in any state); `?date=` routing; mobile record chip follows the market; "Live mode" label; pins persist and keep their market; stale copy; FRONTEND.md drift.
**Phase 1: value without new data feeds.** Fair American odds everywhere; a "your price/line" input per row giving edge, EV and breakeven, sortable by edge; an Over/Under (More/Less) toggle; distribution ladders for pitcher props, 2+ H, TB, HRR 1.5.
**Phase 2: wire real prices.** Render `/edge` for ML/totals (data is already fetched); schedule props odds ingest within API quota (pregame snapshot plus close for CLV); add a best-price/book column and sort by edge vs best price.
**Phase 3: pick slip & record.** Leg-level picks with price and stake, graded automatically, with a history page (date nav), ROI/CLV, CSV and share link; parlay combined probability with a same-game correlation warning.
**Phase 4: trust & IA.** Model version and BASE flag per row; one calibration surface with finer low-probability bins; starter grading; Starters sort/filter; a cross-market "Best plays" view; a game page linking to its props; context columns (hand, park/wind HR impact).
**Phase 5: mobile pass.** Compact rows (about 90px), first pick above the fold at 375×667, 44px targets, a sticky offline/stale state, a scroll affordance on the chip row.

## Caveats
LLM-simulated users, not real ones. The data is synthetic (mock API; total line hard-coded to 8.5 in dev_mock_api.py; Data Feed is a labelled dev fixture), so some trust and calibration reactions are amplified by mock values. Absolute NPS should be read as directional; the rankings and verified bugs are the actionable part. Loading and empty states weren't testable because the mock responds instantly.
