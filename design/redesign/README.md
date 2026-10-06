# Handoff: Pitch Hawk Redesign (Home · Predictions · Live · Data Feed)

## Overview
Pitch Hawk is an MLB analytics board. It shows model-fair probabilities, not prices, and has no wagering UI. This redesign covers the four top-level tabs of the SPA in `danielmac96/pitch-hawk` → `frontend/`:

| Tab | Job |
|---|---|
| **Home** | Today's slate: a status bar, a strip of 4 decision cards, and game pills grouped Live / Upcoming / Final. Each pill expands to player game markets. |
| **Predictions** | Every probability on today's slate in one filterable, sortable table, switchable by market. |
| **Live** | The in-game view for one live game: next pitch, at-bat outcome, pitch log, batter/pitcher/game rail, and the other live games. |
| **Data Feed** | Past model performance. A master filter bar drives the analysis charts (left 2/3) and a resolved-markets feed (right 1/3). |

The demo runs the **Fri Sep 25** evening slate: 12 games (5 live, 5 upcoming, 2 final) with real 2025 rosters.

## About the design files
`design/Pitch Hawk Redesign.dc.html` is a **design reference built in HTML**. It's a working prototype of the intended look and behaviour, not production code. Rebuild it inside the existing `frontend/` app with that app's patterns (vanilla JS string templates in `pitchhawk.js`, styles in `pitchhawk.css`, copy in `copy.js`). Don't ship the HTML, its inline styles, or `support.js` (the prototype runtime).

To view it, open `design/Pitch Hawk Redesign.dc.html` in a browser. `support.js` must sit next to it. Use the header tabs to move between screens. The **DEMO STATE** buttons in the footer switch between the normal, no-games and API-down states.

The prototype's data is fabricated in its script block (`GAMES`, `LU`, `buildHist()`, `buildToday()`). Treat it as a fixture that shows the shape and edge cases. Real values come from the API (see `DATA_CONTRACT.md`).

## Fidelity
**High fidelity.** Colours, type, spacing, radii, copy and interactions are final. Match them closely, using the tokens below (they are the repo's existing tokens from `docs/design-tokens.md`).

## Other docs in this bundle
- `DATA_CONTRACT.md`: every field each screen needs, the route it comes from today, and the new routes the Data Feed needs.
- `CLAUDE_CODE_KICKOFF.md`: a prompt to paste into Claude Code, a build order, and acceptance checks.

---

## Design tokens

### Colour
| Token | Hex | Use |
|---|---|---|
| bg | `#0c1424` | page |
| panel | `#141f33` | cards, tables |
| panel2 | `#101b2e` | table headers, inner wells, KPI tiles |
| panel3 | `#0d1729` | bar tracks inside the Live hero |
| chip | `#1b2942` | segmented-control track, neutral chips, bar tracks |
| active | `#33465f` | selected segment |
| bd | `#253449` | default border |
| bd2 | `#31435f` | dashed "not served / not modeled" borders, axis lines |
| row | `#1a2740` | row dividers |
| txt | `#eef3f9` | primary text |
| dim | `#aebdd2` | secondary text, labels |
| mut | `#8493aa` | tertiary text, captions |
| faint | `#5d6f88` | axis labels, counts under charts |
| blue | `#7fa0c4` | pregame phase text (bg `#16294a`) |
| acc | `#22a566` | brand accent, sliders, "within 3 pts" bars |
| grn | `#4ade80` | live, selected filter text (on `#12301f`, border `#22a566`) |
| grn-edge | `#1f3d2b` | live card and pill borders |
| amb | `#e0a83a` | pins (★), NEEDS ROUTE tags (border `#6b5220`), "landed less" bars |
| data-blue | `#2f8fd6` | "landed more than predicted" bars |
| purple | `#b49bff` on `#241d3d` | SP tag, PITCHING label |
| error banner | bg `#3a1c1a`, border `#5a2a26`, text `#ff9b8f` | API unreachable |

Result chips: **good** fg `#5fe094` bg `rgba(34,165,102,.22)` · **amber** fg `#f0c063` bg `rgba(224,168,58,.20)` · **bad** fg `#ff9b8f` bg `rgba(242,86,76,.20)` · **DNP** fg `#aebdd2`, transparent, border `#31435f` · **pending** fg `#aebdd2` bg `#1b2942`.

Live chip: fg `#4ade80` bg `rgba(74,222,128,.13)`. Final chip: fg `#aebdd2` bg `#1b2942`. Pregame chip: fg `#7fa0c4` bg `#16294a`.

Pitch type colours: FF `#e0392f` · SI `#e8863a` · FC `#d6a11e` · SL/ST `#2f8fd6` · CU/KC `#8a5cf0` · CH `#26a269` · FS `#12a594`.

### Type
- **Hanken Grotesk** 400–800 for UI. H1 28px/800/-.02em. Card titles 16px/800. Body 13px. Captions 11–12px.
- **IBM Plex Mono** 400–700 for **every number**: probabilities, times, counts, scores.
- Kicker labels: 9.5–10px / 800 / letter-spacing .06–.09em / uppercase / `#aebdd2` or `#8493aa`.
- Tag chips (NOT SERVED, NOT MODELED): 8–8.5px / 800 / .05em, 1px `#31435f` border, pill.

### Shape and spacing
- Radii: cards/tables 12px · Live hero 18px · segmented controls and chips 999px · inner cells 8px · type badges 5–6px.
- No shadows. Separation comes from borders and panel shades only.
- Content max-width 1368px with 24px side padding. Gaps between cards 8–16px. Card padding 13–14px. Table row padding 8–9px × 14px.

### Motion
- `ph-pulse`: opacity 1→.3→1 over 1.8s ease-in-out, infinite. Used on live dots.
- `ph-flash`: background `rgba(74,222,128,.45)` → transparent over 1.6s ease-out, played once when a freshness stamp updates.
- Honour `prefers-reduced-motion` by turning off all animation.

---

## Global shell
- **Sticky header.** Background `rgba(12,20,36,.85)` with 12px backdrop blur and a bottom border. Left: ◆ logo ("Pitch" + green "Hawk"). Next to it, a pulsing dot with "5 games live · auto-refreshing" (or "No games live right now"). Right: a pill-shaped tab bar (Home · Predictions · Live · Data Feed) on a `#1b2942` track. The selected tab is `#33465f` with white text.
- **API-down banner** (top of main): "✗ FEED UNREACHABLE", then "Couldn't reach the Pitch Hawk API. This is a connection problem, not an empty slate. Retrying on the 8-second poll.", with "last good update hh:mm:ss PM" on the right.
- **★ WATCHING row** (Home and Live only, when any pins exist). One pill per pinned game or batter. Clicking the pill jumps to it; clicking its ★ unpins it. Pins persist in `localStorage['ph-watch']` as keys `g:<game_pk>` and `b:<batterId>`.
- **Footer.** Logo, disclaimer ("Live MLB data with model-driven projections, for information and entertainment only…"), and the DEMO STATE switcher. The switcher is a **prototype-only** control; replace it with real states.
- Polling: every 8s. The "updated" clock ticks on each poll.

---

## Screen: Home
1. **Title row.** "Today's slate" plus "Fri Sep 25 · all times ET" in mono. On the right, "RANK READS FOR" with a segmented control [Pregame | ● Live]. It defaults to Live when any game is live.
2. **Status bar** (panel2, mono 12px): `12 games · ● 5 live · 5 upcoming · 2 final · lineups confirmed 9/12`, and on the right `updated 7:52:06 PM · polls every 8s`.
3. **Decision strip.** A kicker (● LIVE DECISIONS in green, or PREGAME DECISIONS in blue) with a subtitle, then a 4-column grid of cards.
   - Card anatomy: kicker and phase chip; title (ellipsised); sub line; big mono value (26px); lift chip; baseline text; progress bar (5px, with a white 2px tick at the league rate) or sparkline; a **one-line "why"** (mono 11px), with a second line in `#8493aa`; footer with a freshness stamp (flashes on update) and a status chip.
   - Pregame cards: Strongest 1+ Hit · Strongest 1+ HR · Biggest pregame favourite · Highest projected total.
   - Live cards: Biggest swing (win-prob sparkline, tagged NEEDS ROUTE) · Top call now · Closest game · Due up (strongest HR read among the next 3 batters).
   - Clicking a card opens that game's pill (Home) or selects that game on Live.
4. **Game pills**, grouped Live / Upcoming / Final. Each group has a header: title, count, a rule, and a hint.
   - Row grid: `24px 84px minmax(140px,1fr) 100px 104px 176px 118px minmax(220px,1.35fr) 24px`. The columns are pin · status chip · matchup + venue/"in 1h 20m" · score · bases diamond (always empty, with a tooltip) + count/outs · win prob (team, %, ▲/▼ delta, "from x%", phase caption) · total pick · strongest read (name, market, %, lift chip) · chevron.
   - Live pills use border `#1f3d2b`.
   - **Expanded panel** (panel2):
     - An 8-column metadata grid: STADIUM, ROOF, FIRST PITCH, PROBABLE STARTERS, WEATHER (NOT SERVED), WIND, and so on.
     - A PLAYER GAME MARKETS segmented control: [AWAY batters | HOME batters | Starters].
     - A SORT control: [Lift | Batting order].
     - Batter table columns: pin, #, batter · vs starter, 1+ HIT, 1+ HR, H+R+RBI 1+ (NOT MODELED), TB 1.5+ (NOT MODELED), 30D H·HR/PA, H2H, TODAY (NOT SERVED), RESULT (H and HR chips).
     - Starters table: five prop cells (NOT MODELED), then 30D K%, WHIFF, HR/PA, FB VELO, FATIGUE.
     - A LINEUP PENDING dashed note appears when that side's lineup isn't posted. Final games get a grading note.
5. **Empty state.** When there are no games, one panel reads "No MLB games on today's schedule…". The API-down message is different and must not look like an empty slate.

**Probability cell** (used everywhere): the value is mono 15px, green `#4ade80` if ≥1.10× league, `#8493aa` if <0.95×, otherwise txt. Next to it: a lift chip (`+6 pts`) and "league 23%". Below: a 5px bar filled to p (the HR bar is scaled to a 40% maximum) with a white tick at the league rate, then "per-PA .271 · 4.36 xPA".

## Screen: Predictions
- H1 "Predictions" with the sub "Every model-fair probability on today's slate, ranked by lift over the league rate."
- **Filter bar** (panel, 12px radius):
  - [Pregame | Live] mode control.
  - Market chips: 1+ Hit · 1+ HR · Win prob · Totals · Starters.
  - Team select.
  - Status chips: All · Live · Upcoming · Final.
  - "Include pending lineups" toggle.
  - MIN LIFT range slider from −10 to +15 (−10 means "any").
  - Clear, and "N results" on the right.
- **Trust tiles:** 5 KPI tiles in panel2.
- **Tables** (panel, header row in panel2, 9.5px/800 headers):
  - Batters: rank, pin, player·team·slot, phase·fresh, lineup, P(1+ HIT or HR), lift, why (2 lines), rest of game (NOT MODELED), result. Headers for Name, Phase, Probability and Lift are sortable (arrow shown). The table shows 25 rows at first, then a "Show all" row.
  - Games: status, matchup·starters, win prob pregame→now with sparkline (NEEDS ROUTE), projected runs, total, live total (NOT MODELED), and WP/TOT result chips.
  - Starters: the same columns as the pill's Starters tab.
- Live mode puts in-progress games first, and its caption says reads froze at first pitch.
- Empty state: "No predictions match these filters" with a Clear filters button.

## Screen: Live
- A **SHOWING** chip row: Top call (best game) plus one chip per live game.
- Grid: `minmax(0,1.65fr) minmax(340px,1fr)`.
  - **Hero** (18px radius, gradient `#12301f`→`#0f1f18`, border `#1f3d2b`):
    - LIVE badge and situation line (mono), plus "updated hh:mm:ss".
    - Batter vs pitcher, with hands.
    - Two columns, NEXT PITCH and HOW THIS AT-BAT ENDS. Each has a 28px call and a 22px green %, then distribution rows laid out as `96px bar 46px 58px` (label, 7px bar, %, league).
    - Four stat tiles at the bottom.
  - **Pitch-by-pitch log.** Columns: #, count, type badge (pitch colour), velo called→actual, Δ chip, call + p, result, grade chip. Each row has a 2px left edge coloured by grade.
  - **Rail:**
    - AT THE PLATE: pregame reads frozen at first pitch, rest of game (NOT MODELED), today so far (NOT SERVED).
    - PITCHING: five prop cells (NOT MODELED), pitch count (NOT SERVED), 30D K%, whiff·FB velo.
    - GAME: live win prob, delta, "opened x%", a 46px sparkline (NEEDS ROUTE), and the pregame total.
- **Other live games:** an auto-fill grid of cards (minimum 250px). Each card has chip, matchup, score, count, win prob, top call, and at-bat accuracy with a bar. Clicking a card switches the main view to that game.
- Empty state: "Nothing live right now…".

## Screen: Data Feed (new)
Layout, top to bottom:

1. H1 "Data Feed" with the sub "How resolved predictions have landed. Pick a scenario to see the model's record on it."
2. **Master filter bar**: full width, and the **only** filter surface on the tab. It drives every chart **and** the feed.
   - Timeframe segmented control: Today · 7D · 14D · 30D (default 30D).
   - Market chips: All · 1+ Hit · 1+ HR · Win prob · Totals · At-bat · Pitch. Selected chips use `#12301f` bg, `#22a566` border and `#4ade80` text.
   - A line break, then:
   - Team select ("All teams" plus team abbreviations).
   - **Stadium select.** Each option reads `Stadium · TEAM · City, ST` (e.g. "Wrigley Field · CHC · Chicago, IL"), sorted by stadium name, starting with "All stadiums". It filters to games played at that park, for both teams.
   - Pitcher hand segmented control: Any SP · vs LHP · vs RHP.
   - Batting side segmented control: Home + away · Home · Away.
   - Clear, which resets everything to the defaults.
   - On the right, a mono scenario summary such as "NYY · @ Yankee Stadium · vs LHP · Last 30 days · 312 graded".
3. Below the bar is a flex row with wrapping. Left column: `flex: 2 1 460px`. Right column: `flex: 1 1 270px`. Gap 16px.

**Left column (analysis)**
- **KPI tiles:** auto-fit grid, minimum 150px.
  - GRADED: count, with "last 30 days · all markets".
  - LANDED: the landed %, with "model predicted x%".
  - CALIBRATION GAP: `+1.2 pts` in green if |gap| < 2, amber if < 4, red otherwise, with "landed more/less often than predicted".
  - BRIER SKILL: skill %, with "Brier 0.214 vs base rate".
  - Under the tiles, a caption: "A read lands when the model's pick happens. Each read is graded once, at the probability it carried when the market locked. DNP reads are voided."
- **Calibration:** ten 10-point probability bands in a 160px plot.
  - Each band's bar height is the landed rate; a 2px white line marks the mean predicted probability.
  - Bar colour: `#22a566` if within 3 pts, `#2f8fd6` if it landed more, `#e0a83a` if it landed less.
  - The landed % sits above each bar; band labels and counts sit below. A legend follows. Hover shows "n reads · predicted x · landed y".
- **Daily gap · landed − predicted:** one bar per day, drawn up or down from a centre line and clamped to ±10 pts, with the same colour rule. Days outside the timeframe are shown at 35% opacity. The Today setting shows the last 7 days for context. Date labels appear at the start and at TODAY.
- **By market table.** Columns `minmax(130px,1.3fr) 70px 70px 70px 84px 76px minmax(110px,1fr)`: Market, Graded, Model, Landed, Gap, Skill, and a landed-vs-model bar (green fill to landed, white tick at model). The table ignores the market filter so all six rows always show. Clicking a row sets the market filter; clicking it again clears it. The selected row is tinted `#12301f`.
- **By team:** an auto-fill tile grid (minimum 96px). Each tile shows team, gap and read count. The tile is tinted blue or amber by gap, with alpha of `min(.38, |gap|×6)`, and stays neutral under 2 pts. The grid ignores the team filter. Clicking a tile sets the team filter; clicking again clears it. The selected tile gets a `#4ade80` border.
- **Matchup splits** (within the current scenario): rows grouped as PITCHER (vs LHP, vs RHP), SIDE (batting at home, batting away) and ORDER (slots 1–3, 4–6, 7–9). Each row shows label, n, a bar, landed % and gap.
- **Empty state:** "Nothing graded for this scenario". It explains that win-prob and totals have no hand or side, so those splits hide them, and offers a Clear filters button.

**Right column (resolved markets feed)**
- A panel that sticks at `top: 72px` with `max-height: calc(100vh − 88px)`. The list scrolls inside the panel.
- Header: "● RESOLVED MARKETS" in green, with "40 of 2,114" on the right. The subtitle is "most recent first · <active filters>".
- Items are grouped by day. Group headers stick to the top of the list and read "TODAY · THU SEP 25" / "WED SEP 24", with "N resolved" on the right.
- Each item has two rows:
  - Row 1: market tag (9px/800, `#7fa0c4`: 1+ HIT, 1+ HR, WIN, TOTAL, AT-BAT, PITCH), subject in bold (batter name, "PHI to win", "Over 8.5", "Ball"), model % in mono, and a result chip (LANDED green / MISS red / DNP outline).
  - Row 2: meta (`NYY · #2 vs Rogers (L) · NYY @ BAL`; missed pitch and at-bat calls add " · was Strike / Foul") and the time on the right.
- The list shows 40 items, with a "Show 40 more" button. Changing any filter resets it to 40.
- There are no filters inside the feed; the master bar controls it.

**Maths** (for any set of graded reads, voids excluded):
`n` · `exp = mean(p)` · `act = mean(outcome)` · `gap = act − exp` · `brier = mean((p − o)²)` · `skill = 1 − brier / (act·(1 − act))`.

---

## Interactions and state
| State | Scope | Notes |
|---|---|---|
| `view` | global | home / pred / live / data |
| `mode` | Home, Predictions | pregame / live; defaults to live if any game is live |
| `pins[]` | global, persisted | `localStorage['ph-watch']` |
| `open{pk}`, `tab{pk}`, `psort{pk}` | Home pills | expansion, side tab, sort |
| `liveSel` | Live | `'top'` or a `game_pk` |
| `pMarket, pTeam, pStatus, pLineup, pMin, pSort, pDir, pAll` | Predictions | filters and sort |
| `dTf, dMk, dTeam, dPark, dHand, dSide, dFeedN` | Data Feed | master filters; `dFeedN` resets to 40 on every filter change |
| demo state | prototype only | normal / noGames / apiDown; replace with real fetch states |

- Opening a pill from anywhere (a card, a Predictions row, a Watching pill) switches to Home, expands that pill, selects the right side tab, and scrolls so the pill's top sits 80px below the viewport top. Don't use `scrollIntoView`.
- A pending call is never shown as a miss. Show `pending`, and treat DNP/void as excluded.
- Any missing value renders `—`, never `0`.

## Known gaps (carried from the desktop pass; keep the visual tags)
1. **Pending lineups.** Show a dashed LINEUP PENDING chip. The batter is scored at 4.04 xPA and re-scored hourly.
2. **Accuracy grading mismatch.** The Data Feed grades each read once, at its lock-time probability. Confirm this matches how `prediction_accuracy_daily` grades.
3. **Pregame ranking during live games.** Batter reads freeze at first pitch; label them "PREGAME · FROZEN".
4. **"Due up" derivation.** Uses the current slot plus the next 1–3 slots. `/live` doesn't serve the upcoming order.
5. **Sparklines need a route.** There's no per-pitch win-prob history endpoint. Keep the NEEDS ROUTE tag.
6. **Data Feed history.** `batter_hit`/`batter_hr` went live 2026-09-24, so real history is thin. The per-read attributes the splits need (hand, side, slot, venue) need a route; see `DATA_CONTRACT.md`.
7. **Mobile (390px)** is built (2026-10) without a separate design pass: a single column, the same tab bar, and every wide table as an expandable card rather than a sideways-scrolling one. See `docs/design-tokens.md` §Responsive system.

## Assets
There are no images. The logo is a ◆ glyph plus text, and icons are text glyphs (★ ☆ ▸ ▾ ● ▲ ▼ ✗). Fonts are Google Fonts: Hanken Grotesk (400–800) and IBM Plex Mono (400–700).

## Files
- `design/Pitch Hawk Redesign.dc.html`: the full prototype (all four tabs, fixture data, state logic in the script block at the bottom).
- `design/support.js`: the prototype runtime, needed only to open the HTML. Don't port it.
- `DATA_CONTRACT.md`, `CLAUDE_CODE_KICKOFF.md`.

Repo files each screen maps to (from `github.md`):

| Screen | Repo files |
|---|---|
| Header / nav | `frontend/pitchhawk.js` (headerHtml), `frontend/pitchhawk.css`, `frontend/copy.js` |
| Home | `frontend/pitchhawk.js` (homeHtml, slatePillHtml, slateChipHtml, basesHtml, slateMetaHtml) |
| Predictions | `docs/DATA-MAP-FOR-DESIGN.md` §3–6, `design/player-markets/CLAUDE_DESIGN_PROMPT.md` |
| Live | `frontend/pitchhawk.js` (heroHtml, heroChipsHtml, currentAbHtml, liveGamePillHtml, pitchColor, veloBand) |
| Data Feed | the current Data Feed code in `frontend/pitchhawk.js`, plus the `/accuracy`, `/trends`, `/feed` and `/pitches` routes |
