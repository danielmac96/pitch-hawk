# Handoff: Pitch Hawk board redesign (Home · Live Feed · Data Feed)

## Overview

A redesign of the three tabs in the Pitch Hawk SPA (`frontend/`):

- **Home** — the "Today's games" card grid is replaced by one **row pill per game**, ordered live (latest inning first) → final → upcoming. Each pill carries teams, score, inning, runners on base, balls-strikes-outs, the game moneyline prediction and the game total prediction, and expands to a second tier of game metadata (stadium, roof, weather, wind, HP umpire, first pitch, attendance). Clicking a pill jumps to that game in the Live Feed. The hero, the live-board promo and "How it works" are unchanged.
- **Live Feed** — the "best call now" hero gains a **Showing** selector: `★ Top at-bat` (highest model probability across all live games — the current behaviour) or any individual live game. Below the hero, **every game on the slate** appears as a pill, not just live ones; pregame games show the frozen game-level lines plus the opening-at-bat reads.
- **Data Feed** — all analytics move to the top of the page, the expandable history moves to the bottom and becomes a strict **day → game → at-bat → pitch** accordion. A filter bar (window, team, player, home/away, batter/pitcher) scopes the page, and a **Profitable trends** panel ranks players by edge against the model's own window baseline. Clicking any team, batter or pitcher name anywhere opens a p30d scoped overlay.

Everywhere a record is shown (`14/19`), the percentage is now shown next to it in the same mono face and the same accuracy colour: `14/19 · 74%`.

## About the design files

`Pitch Hawk Redesign.dc.html` in this bundle is a **design reference created in HTML** — a prototype showing the intended look and behaviour with hard-coded sample data. It is not production code to copy.

The target codebase is `frontend/` in `danielmac96/pitch-hawk`: **vanilla JS, no framework, no bundler.** Recreate these designs in that idiom, not as React:

- every view is a method on `class Board` returning an **HTML string**;
- `render()` replaces the whole tree with `innerHTML` on each 8s poll, so **nothing may hold state in the DOM** — open/closed pills live in `this.state`;
- interactivity is `data-act` / `data-arg` delegation from the two listeners on the root;
- styling is inline styles reading `this.C` (the dark palette) — the board is dark-only;
- positioning-sensitive copy goes in `copy.js`, data-vocabulary micro-labels stay inline.

The prototype renders desktop (1180) and phone (390) side by side. Both are real targets: `mob()` is `window.innerWidth < 1024`.

## Fidelity

**High-fidelity.** Colours, type, spacing and radii are the repo's own tokens (`docs/design-tokens.md`, `frontend/pitchhawk.css`, `Board.C`). Recreate pixel-perfectly using the existing palette constants — do not introduce new colours.

---

## Screens

### 1. Home — `homeHtml()`

**Unchanged:** header, hero (`ph-hero`), "Today at a glance" panel, live-board promo (`ph-promo`), "How it works", footer.

**Replaced:** the `slateCards` grid.

**New structure** — three groups, each a label row plus a stack of pills, `gap: 6px`:

| Group | Label | Colour | Order |
|---|---|---|---|
| Live | `LIVE NOW` | `#4ade80` | latest inning first — bottom 9th above middle 8th. Strict inning order; do **not** demote blowouts. |
| Final | `FINAL` | `#8493aa` | as returned |
| Upcoming | `UPCOMING` | `#7fa0c4` | soonest first pitch first |

Group label row: `font-size:10px; font-weight:800; letter-spacing:.08em`, then a mono count (`10.5px`, `#6f7f96`), then a `1px` rule in `#1a2740` filling the remainder.

**Pill (desktop)** — `border:1px solid #253449; border-radius:12px; background:#141f33; overflow:hidden`. Header row is a grid, `padding:11px 14px; gap:12px`:

```
grid-template-columns: 86px 210px 150px 118px 152px 152px 128px 30px
```

1. **Status chip** — `10px/800`, `letter-spacing:.05em`, `padding:3px 7px`, `border-radius:6px`.
   - live: `● BOT 9`, fg `#4ade80`, bg `rgba(74,222,128,.13)`
   - final: `FINAL`, fg `#8493aa`, bg `#1b2942`
   - scheduled: first-pitch clock (`7:45 PM`), fg `#7fa0c4`, bg `#16294a`
2. **Matchup** — `AWY @ HOM` at `13.5px/800`; below it the venue (and, for scheduled games, `· in 1h 12m`) in mono `10.5px`, `#8493aa`. Button, `data-act="goLiveGame"`.
3. **Score** — mono `19px/700`, `#eef3f9` live / `#aebdd2` final / `#6f7f96` (`—`) scheduled, followed by a `10.5px` `#6f7f96` caption (`bot 9` / `final` / `first pitch`).
4. **Situation** — bases diamond plus count. Diamond: a `32×24` relative box with three `10×10` spans, `transform:rotate(45deg)`, `border:1px solid #31435f`, `border-radius:2px`; second base at `top:0;left:11px`, third at `top:11px;left:1px`, first at `top:11px;left:21px`. Occupied fill `#e0a83a`, empty `transparent`. Next to it, mono `12.5px` count (`2-1`) over `10px` `#6f7f96` outs (`2 out`).
5. **Moneyline** — pick abbr `12.5px/800` + probability mono `12.5px/600` in the accuracy colour, over `MONEYLINE · PREGAME` at `9.5px/800`, `#6f7f96`.
6. **Total** — same shape: `O 8.5` + `57%`, caption `TOTAL · PREGAME`.
7. **CTA pill** — `Live feed →` / `Recap →` / `Preview →`, `border:1px solid #253449; background:#1b2942; color:#aebdd2; 11px/700; padding:6px 11px; border-radius:999px`.
8. **Chevron** — `▸` / `▾`, `14px/700`, `#8493aa`. Toggles the second tier only; it must `stopPropagation` so it does not navigate.

**Second tier** (chevron open) — `border-top:1px solid #253449; background:#101b2e; padding:12px 14px 13px`. A four-column grid of label/value pairs (`gap:10px 22px`): STADIUM, ROOF, WEATHER, WIND, HP UMPIRE, FIRST PITCH, ATTENDANCE, MODEL VERSION. Labels `9.5px/800`, `#6f7f96`; values mono `12.5px`, `#eef3f9`. Below a `#1a2740` rule: a `Go to Live Feed →` pill (`border:1px solid #1f3d2b; background:#12301f; color:#4ade80`) and an `11px` `#6f7f96` note explaining why a field may be a dash.

**Pill (phone, <1024)** — same card, three stacked lines inside `padding:10px 11px`, `gap:7px`:
1. chip · matchup · score (right) · chevron
2. bases diamond (`28×21`, `9px` bases) · `2-1 · 2 out` · venue right-aligned in `10.5px`
3. rule, then `ML NYM 78%` · `TOT U 8.5 61%` · `Live feed →` link right-aligned

Second tier on phone is a two-column label/value grid plus a full-width 44px `Go to Live Feed →` button.

**Missing data renders as `—`, never as zero or a guess.** See *Backend gaps*.

### 2. Live Feed — `liveHtml()`

**Showing selector** — above the hero: label `SHOWING` (`10px/800`, `#6f7f96`) then a chip row. First chip `★ Top at-bat`, then one chip per live game (`NYM @ ATL`). Active chip: `border:1px solid #22a566; background:#12301f; color:#4ade80`. Inactive: `border:1px solid #253449; background:#1b2942; color:#aebdd2`. `12px/600`, `padding:6px 12px`, `border-radius:999px`.

- `Top at-bat` = the existing `bestCall()` across all live games. Badge reads `TOP AT-BAT · ALL GAMES`, note `highest model probability of N open at-bats`.
- A game chip pins the hero to that game's open at-bat. Badge `SELECTED GAME`, note `the open at-bat in this game`.
- The hero, its probability distribution, the three projection tiles and the **Current at-bat** panel all follow the selection.
- Selection lives in `this.state.heroSel` (`"top"` or a `gamePk`), survives the poll, and defaults to `"top"`.

Hero card styling is unchanged (`border:1px solid #1f3d2b`, `background:linear-gradient(180deg,#12301f,#0f1f18)`, `radius:14px`, `padding:16px 18px`). The third tile now reads `14/19 · 74%`.

**Game list** — every game on the slate, not only live ones, ordered live → final → upcoming. Pill header grid, `padding:12px 14px; gap:12px`:

```
grid-template-columns: 18px 84px 190px 132px 118px 150px minmax(0,1fr) 140px
```

chevron · status chip · matchup+venue · score · count/outs · ML+total (total in the caption line: `ML · O 8.5 57% TOTAL`) · call chip + text · at-bat accuracy with a 5px progress bar.

- live pill border `#1f3d2b`; others `#253449`
- call chip: `TOP CALL` (green) for live, `GRADED` (grey) for final, `FIRST AB` (blue `#7fa0c4` on `#16294a`) for scheduled
- expanding a **live or final** game lists its at-bat calls; expanding a **scheduled** game lists the opening-at-bat predictions, with the note *"frozen pregame lines above · first-at-bat reads open when the lineup posts"*
- at-bat row grid: `34px minmax(0,1fr) minmax(0,1fr) 220px 96px 88px` — inning, team+batter (batter name is a button that opens the entity overlay), pitcher, call chip (`Strike / foul 71% → pending`, green/red/neutral background), pitches `actual / projected`, accuracy `3/4 · 75%`

### 3. Data Feed — `dataHtml()`

Order on the page, top to bottom:

1. **Title block** (`copy.dataTitle` / `dataSub`) with the **window** chips on the right: `Today · 7 days · 14 days · 30 days · Custom`. Active chip `#12301f` / `#22a566` / `#4ade80`.
2. **Filter bar** — `border:1px solid #253449; border-radius:12px; background:#101b2e; padding:11px 13px`, one flex row:
   - `TEAM` select (all 30 abbrs, default "All teams")
   - `PLAYER` select (default "All players")
   - vertical `1px` divider `#31435f`
   - `SPLIT` segmented: Both / Home / Away
   - `ROLE` segmented: All / Batters / Pitchers
   - `Clear` pill when any filter is dirty
   - right-aligned mono `11px` summary: `All teams · All players · home + away · batters + pitchers · 7 days — 7 qualified players`
   - selects: `background:#141f33; color:#eef3f9; border:1px solid #253449` (→ `#22a566` when set), `radius:7px`, `11.5px/600`, `padding:6px 9px`
   - filters scope the KPIs, every chart and the trends panel; they are **not** applied to the day/game/at-bat history below (that follows the window only)
3. **KPI tiles** — five, unchanged shape.
4. **Profitable trends** (full width, first card in the chart grid, green border `#1f3d2b`) — *"players the model has read better — or worse — than its own window baseline, under the filters above"*. Row grid `minmax(0,1.1fr) 58px 66px 120px minmax(0,1fr) 72px 62px`: player name (button → overlay) with a one-line reason beneath, `BAT`/`PIT` + team (`#7fa0c4` / `#b49bff`), Home/Away, graded calls `41/54 · 76%`, edge bar + `+11.4 pt`, net units, streak `W5` / `L3`. Positive green `#4ade80`, negative red `#ff9b8f`.
5. **Charts**, two-up: Accuracy over time by market · Pitch-result accuracy by count · Pitch mix and velocity trend · Batter tendencies · Pitcher tendencies p30d (full width, with a per-day velo sparkline and a fatigue Δ column).
6. **Prediction history** — the drill-down, now four levels:
   - **Day pill**: `Sat · Aug 22` · `15 games` · settle note · `184/271 · 68%` at-bat calls with progress bar · `912/1344 · 68%` pitch · `1.4 mph MAE`
   - **Game pill** (nested, `#0d1729` ground): matchup · score · innings/pitches · `14/19 · 74%` · MAE
   - **At-bat pill**: inning · team+batter · pitcher · call chip · pitches · `4/5 · 80%`
   - **Pitch table**: the existing `pitchTableHtml` columns — `P · CNT · TYPE · VELO ACT · CALL · Δ · RESULT vs CALL · GRADE`
   - all four levels expand **in place**; open state keyed by path (`d-0`, `d-0/g-1`, `d-0/g-1/ab-2`) in `this.state`

**Entity overlay** — clicking any team, batter or pitcher name anywhere on the board opens a modal: `rgba(6,11,20,.72)` scrim, `640px` card, `#0c1424`, `radius:16px`. Header `BATTER · PAST 30 DAYS` + name + Close pill. Body: four stat tiles (call accuracy, graded calls, velo MAE, games), a 30-bar per-day accuracy chart, and a tendencies list (strike/foul, ball, in play, chase rate, zone rate).

---

## Interactions & behaviour

| Action | Result |
|---|---|
| Click a Home pill (chip, matchup or CTA) | switch to Live Feed, expand that game's pill, scroll it into the viewport — do **not** use `scrollIntoView`; set `scrollTop` |
| Click a Home pill's chevron | toggle the metadata tier in place; must not navigate |
| Click a Showing chip | set `state.heroSel`, re-render the hero |
| Click a Live Feed pill | toggle its at-bat list |
| Click a window / split / role chip | set the filter, re-render the analytics half |
| Change a team / player select | same; the select must not be re-rendered mid-interaction (`render()` already skips while a filter control has focus) |
| Click `Clear` | reset team, player, split, role — not the window |
| Click a player or team name | open the entity overlay |
| Poll (8s) | re-render; every open/selected state survives because it lives in `this.state` |

Hover: cards use the existing `.ph-card-hover` class. Motion is limited to the `ph-pulse` live dot, disabled under `prefers-reduced-motion`.

## State

```js
state = {
  view: "home" | "live" | "data",
  openG: {},        // Home + Live Feed pill open state, keyed by gamePk
  heroSel: "top",   // "top" | gamePk
  dfOpen: {},       // history accordion, keyed by "d-0/g-1/ab-2"
  dfRange: "7d",    // today | 7d | 14d | 30d | custom
  dfTeam: "", dfPlayer: "", dfSide: "all", dfRole: "all",
  entity: null,     // { kind: "BATTER" | "PITCHER" | "TEAM", id, name }
}
```

## Data — what exists today

| Need | Source | Status |
|---|---|---|
| Slate, status, start time, scores | `GET /games` | ✅ |
| Inning, half, count, outs, current batter/pitcher, pitches | `GET /live` | ✅ |
| Graded at-bat and pitch calls | `GET /pitches` (`loadDayRows`) | ✅ |
| Day scores for a past slate | `GET /board` | ✅ |
| Accuracy by market by day | `GET /accuracy` | ✅ |
| Stadium, weather, wind, umpire, attendance | `GET /game/{game_pk}/context` | ⚠️ published by the **nightly warehouse job** — today's games appear tomorrow |
| Pitcher profile / fatigue / head-to-head | `GET /player/{id}/profile`, `/fatigue`, `GET /matchup/{p}/{b}` | ✅ (30-pitch floor, 3-PA floor) |

### Backend gaps this design exposes

1. **Runners on base are not in the payload.** `pitchhawk-data.js` hard-codes `runners: { first: false, second: false, third: false }` and the comment at line 140 confirms `/live` carries no runners. The diamond needs `matchup.postOnFirst/Second/Third` (or `linescore.offense`) from the MLB live feed threaded through `live-poll` into the `live_state` row. Until then render all three bases empty and the situation cell as `—`.
2. **`/live` carries no score or venue** — the pill's score for a live game must come from `/games` (or `/board`), not `/live`.
3. **`game_moneyline` is fitted but not served.** `model.ts` has no `log5` branch and `game-predict` falls back to `homeAdv = 0.542`. The ML cell is honest only once that ships; label it `PREGAME` and do not imply it updates.
4. **`game_total` is scored but unregistered** — no `model_params` row, no `modeling/specs/` module. Same caveat.
5. **Both game-level markets are frozen at pregame** (`game-predict` runs hourly before first pitch, then never updates). The design states this in the caption rather than implying a live line.
6. **The Profitable trends panel needs a new aggregate**: per player, per window, graded calls and win rate against a baseline win rate, plus a home/away split. There is no endpoint for this today — either extend `/accuracy` with `group_by=player,side` or add `GET /trends?days=30&team=&player=&side=&role=`. It also needs a **minimum-sample floor** (suggest 20 graded calls) so a 4-for-5 stretch cannot outrank a 60-call edge.

## Design tokens

Dark-only. From `Board.C` and `pitchhawk.css` `[data-theme="dark"]`:

```
bg      #0c1424      panel   #141f33      panel2  #101b2e
panel3  #0d1729      rail    #0a1322      chip    #1b2942
bd      #253449      bd2     #31435f      row     #1a2740
txt     #eef3f9      dim     #aebdd2      mut     #8493aa      faint #6f7f96
blue    #7fa0c4      vs      #3a4a63
acc     #22a566      grn     #4ade80      amb     #e0a83a      red   #ff7b6b
good    fg #5fe094 / bg rgba(34,165,102,.22)
amber   fg #f0c063 / bg rgba(224,168,58,.20)
bad     fg #ff9b8f / bg rgba(242,86,76,.20)
gbd     #1f3d2b      gbg  linear-gradient(180deg,#12301f,#0f1f18)      gsub #82ae92
runner-occupied  #e0a83a
pitch types  FF/FA #e0392f · SI/FT #e8863a · FC #d6a11e · SL/ST #2f8fd6
             CB/CU/KC #8a5cf0 · CH #26a269 · SP #12a594
```

Accuracy banding (`accBand`): ≥66% green, ≥50% amber, else red. Velocity banding via `veloBand(delta)`.

Type: **Hanken Grotesk** 400–800 for text, headings at 800 / `-.02em`; **IBM Plex Mono** 400–600 for every comparable number — scores, velo, counts, percentages, ratios. Radii: 999px pills, 9–12px rows, 12–14px cards, 18px hero. Touch targets ≥44px on phone.

## Assets

None. No images, no icon files — the only glyphs are `◆ ● ▸ ▾ ▲ ▼ ★ →`, set in text as they are today.

## Files

- `Pitch Hawk Redesign.dc.html` — the design reference (open it in a browser; the top switcher changes tab, both viewports render side by side)
- `CLAUDE_CODE_PROMPT.md` — a ready-to-paste prompt for Claude Code
- Target files in the repo: `frontend/pitchhawk.js` (all three views), `frontend/copy.js` (new strings), `frontend/pitchhawk-data.js` (runners, trends adapter), `frontend/pitchhawk.css` (no change expected)
