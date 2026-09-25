# Claude Design directive: Pitch Hawk slate + decision redesign

**Attach before pasting:** `docs/DATA-MAP-FOR-DESIGN.md` (required) and `docs/design-tokens.md`.
If you want the canvas at https://claude.ai/artifact/8kSunHaKKv7s4YzLHVcgtv used as a layout
reference, share it with the project first. Paste everything below the line.

---

## Role and goal

You are redesigning **Pitch Hawk**, an MLB model-analytics board. Build a design that lets a
user do two things in one visit:

1. **See the full slate.** Every game today: status, score, and the whole-game predictions.
2. **Make a fast, data-driven decision.** Find the strongest predictions **before first pitch**
   and **while games are live**. Understand *why* each one is strong, and trust how fresh it is.

The attached `DATA-MAP-FOR-DESIGN.md` is the only source of truth for data. Every number you
draw must map to a field, route or client-side calculation it lists. If you need something it
does not have, draw the slot empty and tag it (see Rule 4). **Never invent a metric.**

## Success test

A first-time user must answer each question below in the stated time without scrolling past
the first screen on desktop. The design is done when every one passes.

| # | Question | Time |
|---|---|---|
| 1 | What's on today, and what is live right now? | 5 s |
| 2 | Pregame: which batters are the model's strongest 1+ Hit and 1+ HR reads today, and is their lineup confirmed? | 10 s |
| 3 | In-game: which game has swung most since first pitch, and what is the model's call on the pitch about to be thrown? | 10 s |
| 4 | For any one prediction: how far above average is it, what supports it, and how fresh is it? | 1 click |

## The five rules (apply everywhere)

**Rule 1: every prediction carries its decision context.** A bare probability is not enough.
Every prediction shows:

| element | how | source |
|---|---|---|
| **Value** | big mono number | `probability`, `probs{}`, `predicted_value` |
| **Baseline** | a tick on the bar, plus "league x%" | league rate at the **same batting slot**: `1-(1-p_league)^expected_pa`, where p_league is .239 for hit and .032 for HR |
| **Lift** | `+6 pts` / `1.4×` badge; the primary sort key | value − baseline, computed client-side |
| **Phase** | `PREGAME` / `LIVE` / `FINAL` chip | `phase`, game status |
| **Freshness** | "updated 7:42 PM", or "frozen at first pitch" | `updated_at`, `scored_at` |
| **Status** | `LINEUP ✓` (slot 1–9) or `LINEUP PENDING` (slot null → 4.04 xPA) | `lineup_slot` |
| **Why** | one line built only from served inputs, e.g. `30d HR/PA 5.8% · Sale HR/PA 2.1% · H2H 2-9` | rolling stats, matchup, profiles |

**Rule 2: judge rare events against their base rate.** Colour a 1+ HR probability of 19% by
its lift over the ~13% league rate at that slot, never against 50%. Use accent green for lift
≥ +10% relative, neutral text for roughly average, and muted for below average. Accuracy
colours are ≥66% green, ≥50% amber, otherwise red.

**Rule 3: separate pregame from live, visibly.** Frozen numbers say `PREGAME`. Numbers that
update carry the pulsing `● LIVE` dot and refresh on the 8-second poll. Only these update in a
game:
- win probability (`mlb_winprob_v1`)
- the pitch and at-bat calls

The game total and the player projections freeze at first pitch. Say so, and never imply
otherwise.

**Rule 4: reserved slots are designed, not hidden.** A market the data map ranks but nobody
models yet gets a full slot:
- its label
- `[LINE]`
- `—`
- an outlined `NOT MODELED` tag

Show the supporting stats that do exist beside it. Data that exists but no route serves gets
the same treatment with a `NOT SERVED` tag. Never put a sample number in a reserved slot.

**Rule 5: analytics voice, not a sportsbook.** Never use these words or concepts:
- odds, edge, bet, lock, pick, parlay, bankroll, "value play"

Projections are "model-fair probabilities". Write "strongest reads", not "best bets".

## Markets, in decision priority

- **Batter:**
  1. **1+ Hit** (served)
  2. **1+ Home run** (served)
  3. 1+ H+R+RBI (reserved)
  4. Total bases 1.5+ (reserved)
- **Starting pitcher:** all reserved; show 30-day K%, whiff, HR/PA, FB velo and fatigue beside
  them.
  1. Strikeouts
  2. Outs recorded
  3. Hits allowed
  4. Earned runs
  5. Walks
- **Game:**
  1. **Win probability**: pregame `log5_v1` → live `mlb_winprob_v1`
  2. **Total**: pregame, frozen
  3. Live total (reserved)
- **In-game micro** (Live Feed only):
  - next pitch `pitch_result` (3 classes)
  - velo `pitch_speed_ou`
  - at-bat outcome `ab_result` (4 classes)
  - pitches in the at-bat `ab_pitches_ou`

## Information architecture

Tabs: **Home · Predictions · Live · Data Feed.** Data Feed exists already and is out of scope.
Keep its tab and don't redesign it.

A global **mode switch** sits in the header of Home and Predictions: `Pregame | Live`. It
defaults to Live when any game is live, otherwise Pregame. It changes what the decision
surfaces rank. It never hides games from the slate.

### 1. Home: the slate plus the decision strip

The first screen, top to bottom:

1. **Slate bar.** A thin row with games, live, upcoming, final, lineups confirmed `x/12`, and
   the last update.
2. **Decision strip.** Four cards; what they show depends on the mode.
   - **Pregame** (each card names the player, game, value, lift and "why"; tap to jump to it):
     - Strongest 1+ Hit
     - Strongest 1+ HR
     - Biggest pregame favourite (win probability)
     - Highest projected total
   - **Live:**
     - **Biggest swing**: live − pregame win probability, in points
     - **Top call now**: the highest-probability next-pitch or at-bat call across live games
     - **Upcoming batter with a strong read**: needs "who bats next"; derive it from the
       lineup slot plus the current batter, or tag it `NOT SERVED`
     - **Closest game**: win probability nearest 50%
3. **The full slate.** Game pills grouped LIVE (latest inning first) → UPCOMING (soonest
   first) → FINAL. A collapsed pill shows:
   - status chip
   - matchup and venue
   - score
   - count, outs and bases diamond (runners are not served, so the diamond is empty and the
     situation cell shows `—`)
   - win probability with phase, plus `from 58%` and ▲▼ once live
   - total (PREGAME)
   - **the game's strongest batter read**, with lift
   - chevron

Expanding a pill shows:
- **Metadata:**
  - stadium, roof, first pitch, probable starters
  - weather, wind, umpire and park HR factor, each tagged `NOT SERVED` for today's games
- **Player game markets**, with segmented tabs `AWY batters | HOM batters | Starters`:
  - **Batter rows** show:
    - slot, name and hand, and the opposing starter
    - 1+ Hit and 1+ HR, each with value, bar, league tick, lift and `per-PA · xPA`
    - H+R+RBI and TB, reserved
    - 30-day hit/PA and 30-day HR/PA
    - H2H (`—` under 3 PA)
    - today so far (`NOT SERVED`)
  - **Rows are sorted by lift by default**, with a toggle to switch to batting order.
  - **Starter rows:** the five reserved props plus supporting form.
- **Empty states:**
  - lineup pending (it posts about 3 h before first pitch; projections re-score until then)
  - final (graded hit / miss / DNP; DNP is excluded from accuracy)

### 2. Predictions: the decision table

One ranked, filterable view of every prediction on the slate.

- **Filters**, all in one bar:
  - mode (Pregame | Live)
  - market (1+ Hit · 1+ HR · Win prob · Total · Pitcher props)
  - team
  - status (All · Live · Upcoming · Final)
  - `Lineup confirmed only`
  - `Min lift` slider
  - clear
  - a result count
- **Sort:** by lift by default, with probability and start time as alternatives. Every column
  header is sortable.
- **Batter table** (top 25, expandable). Columns:
  - rank
  - player / team / slot / opposing starter
  - phase + freshness
  - lineup status
  - P(1+) with bar and tick
  - lift
  - why (Rule 1)
  - rest of game (reserved on live rows)
  - result (`HIT` · `MISS` · `DNP` · `pending`)
- **Game table.** Columns:
  - status
  - matchup / starters
  - win probability pregame → now, with ▲▼ in points and a sparkline
  - projected runs
  - total (PREGAME)
  - live total (reserved)
  - result
  The sparkline's history comes from the per-pitch `game_moneyline` rows. Flag it
  `NEEDS ROUTE` if you can't bind it to a listed route.
- **Pitcher table:** every starter, with the five reserved props and supporting form.
- **Trust strip.** One tile per market for 1+ Hit calibration, 1+ HR calibration, 7-day win
  probability, 7-day at-bat accuracy, and velo MAE. The two calibrations show `—` and
  "0 graded" until games settle. The strip tells the user how much weight a number deserves.

### 3. Live: the in-game cockpit

For live games only. This is where fast in-game decisions happen.

- **Game switcher chips:** `★ Top call now`, then one chip per live game with its score and
  inning.
- **Hero:**
  - situation and matchup
  - **next pitch**: the call plus its 3-class distribution
  - **how this at-bat ends**: the call plus its 4-class distribution
  - tiles: velo call and O/U, pitches in the at-bat and O/U, at-bat accuracy this game as
    `c/n · P%`, and pitch accuracy plus velo MAE
- **Side rail**, three cards:
  - **Batter** at the plate:
    - pregame 1+ Hit and 1+ HR, labelled "frozen at first pitch"
    - rest of game (reserved)
    - today so far (`NOT SERVED`)
  - **Pitcher:** the reserved props, pitch count (`NOT SERVED`) and 30-day K%.
  - **Game:** live win probability, a sparkline, "opened x%", and the total (PREGAME).
- **Pitch-by-pitch log.** Columns:
  - pitch number
  - count
  - pitch-type chip
  - velo called → actual, plus the difference
  - call and its probability
  - result
  - grade (`✓ CALLED` · `✗ MISSED` · `PENDING`)

  A pending call is never drawn as a miss.
- **Other live games:** compact pills with count, win probability, a swing arrow, the top call
  and an accuracy bar. Tapping a pill switches the hero.

## Interaction rules

- One click from any player or game to its full context. There are no dead ends.
- **Pin.** A ☆ on any batter row or game adds it to a "Watching" row at the top of Home and
  Live. It persists per viewer in `localStorage`, wrapped in try/catch.
- Show what changed: a projection re-scored since page load flashes its freshness stamp once.
  The previous value isn't stored, so draw "was x%" as `NOT SERVED`.
- The poll must not reset any open pill, tab, filter, sort, mode or selected chip.
- Motion is limited to the live dot and the freshness flash. Both are off under
  `prefers-reduced-motion`.

## Visual system

- **Dark only.** Use the data map's §8 tokens and **no new colours**, except `#b49bff` for
  pitcher tags.
- **Colour meaning:**
  - green `#4ade80` / `#22a566`: live and strong lift
  - amber `#e0a83a`: middling
  - red `#ff9b8f`: miss
  - blue `#7fa0c4`: upcoming
  - dashed `#31435f` outlines: reserved slots
- **Type:** Hanken Grotesk 400–800; headings 800 with `-.02em` tracking. **IBM Plex Mono for
  every number.**
- **Radii:** 999px for chips, 12px for cards and pills, 18px for the hero.
- **Glyphs:** only `◆ ● ○ ▸ ▾ ▲ ▼ ★ ☆ → ✓ ✗`. No icon files, no emoji.
- **Readability:** records always read `c/n · P%`; missing is `—` (never `0%`); text contrast
  must be ≥ 4.5:1.

## Viewports and required states

- Design each page at **1440** and **390**. The phone breakpoint is `< 1024`; below 768px the
  tabs become a bottom bar with 48px targets.
- On phone:
  - The decision strip becomes a horizontal snap row.
  - Tables become stacked cards: name, value and lift on line 1, the "why" on line 2 (muted).
  - Touch targets are ≥44px.
- **Draw every state:**
  - Home in Pregame mode and in Live mode
  - live, upcoming (lineup ✓), upcoming (pending) and final pills
  - an expanded pill on each tab
  - a reserved slot
  - a not-served slot
  - a graded row and a DNP row
  - an empty filter result
  - no games today
  - API unreachable

## Build constraints (so it ports)

The target is `frontend/`: **vanilla JS, no framework, no bundler.**
- Views are methods that return HTML strings.
- `innerHTML` re-renders the whole tree on each 8-second poll, so **no state may live in the
  DOM**. Everything lives in `this.state`.
- Interactivity uses `data-act` delegation.
- Styles are inline and read the token object.

Design for that: no hover-only information, no scroll-linked effects, no `scrollIntoView`.

## Deliverables

1. **Pages.** Home, Predictions and Live at 1440 and 390, interactive: mode switch, pills,
   tabs, filters, sort, game chips and pins all work.
2. **Component sheet.** Include:
   - game pill (all states)
   - decision card
   - batter row
   - pitcher row
   - probability bar with league tick and lift badge
   - "why" line
   - phase and freshness chips
   - reserved cell
   - not-served cell
   - grade chips
   - sparkline
3. **Field-binding table.** For every number, give its source as `route → field` or the
   client-side formula, using the data map's names (for example
   `/projections → rows[].probability`, `/live → markets_pregame[game_moneyline].probs.home`).
   Mark each `NOT MODELED`, `NOT SERVED` and `NEEDS ROUTE` item with the backend work it
   waits on.
4. **Handoff.** A handoff `README.md` plus a ready-to-paste **Claude Code prompt** that builds
   the design one page at a time in `frontend/pitchhawk.js`, `copy.js` and
   `pitchhawk-data.js`. Include:
   - a new `loadProjections()` adapter over `GET /projections`
   - a team-abbreviation join from `team_id`
   - the lift calculation in one shared helper

**Before drawing,** list every field you need that the data map lacks. Mark each as a reserved
or not-served slot. Then build.
