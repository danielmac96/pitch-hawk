# Claude Code prompt

Paste this into Claude Code from the root of `pitch-hawk`, with `design_handoff_board_redesign/` copied into the repo (or its path passed in).

---

Read `design_handoff_board_redesign/README.md` in full, then open `design_handoff_board_redesign/Pitch Hawk Redesign.dc.html` in a browser to see the intended result. That HTML file is a **design reference built in React-flavoured markup with hard-coded sample data** — do not port it, do not add a framework, and do not copy its component structure. Recreate the designs in this repo's existing frontend idiom.

Before writing anything, read these files completely:

- `frontend/pitchhawk.js` — the whole `class Board`, especially `homeHtml`, `liveHtml`, `dataHtml`, `gamePillHtml`, `gameBodyHtml`, `abRowHtml`, `pitchTableHtml`, `heroHtml`, `currentAbHtml`, `feedHtml`, the chart methods, `render`, `poll`, and the `data-act` delegation in the constructor
- `frontend/pitchhawk-data.js` — `PITCHHAWK` adapters and normalisers, especially the `/live` shape and the comment block around line 140
- `frontend/copy.js`, `frontend/pitchhawk.css`, `docs/design-tokens.md`, `docs/FRONTEND.md`
- `supabase/functions/api/` — the routes the board consumes, so you know exactly what each endpoint returns

Constraints that are not negotiable:

- Vanilla JS. No framework, no bundler, no npm dependency. `scripts/build_frontend.sh` stays the whole build.
- Every view is a method returning an HTML string; `render()` replaces the tree with `innerHTML` on the 8s poll. **No state in the DOM** — every open pill, selected chip and filter value lives in `this.state`, or it dies eight seconds later.
- Interactivity is `data-act` / `data-arg` delegation from the existing root listeners. Add new actions there; do not attach per-element listeners.
- Inline styles reading `this.C`. Dark-only. Do not introduce a colour that is not in `this.C` / `this.GRD` or listed in the handoff README's token table.
- Every number a fan compares is IBM Plex Mono. Headings are Hanken Grotesk 800 / `-.02em`.
- Never call `scrollIntoView`.
- Missing data renders `—`. Never 0%, never a fabricated value. The existing `pct()` contract applies everywhere.
- Keep the wagering feature flag clean: `rg -i "sportsbook|parlay|bankroll|\bwager|1-800-GAMBLER" frontend/` must still only hit `copy.js` and `config.js`.

Implement in this order, and stop after each step so I can look at it:

**1. Home game pills.** Replace the `slateCards` grid in `homeHtml()` with the three-group pill list (live latest-inning-first → final → upcoming). Extract the pill into its own method — it is reused by the Live Feed. Add the metadata second tier behind a chevron, fed by `GET /game/{game_pk}/context`; fetch context lazily on first expand, once per game, and cache it on `this.state`. Clicking the pill body switches to the Live Feed with that game expanded.

**2. Live Feed.** Add the `Showing` chip row and `state.heroSel`; `"top"` keeps today's `bestCall()` behaviour, a gamePk pins the hero and the current-at-bat panel to that game. Render a pill for **every** game on the slate, not only live ones — scheduled games show the frozen game lines plus their opening-at-bat predictions.

**3. Records with percentages.** Anywhere the board prints a ratio (`this.ratio(c, n)`), print `c/n · P%` with the percentage in the same mono face and the same `accColor(rate)`. Do this once in a helper and use it everywhere: game pills, at-bat rows, day pills, KPI subtitles, hero tiles.

**4. Data Feed reorder.** Move every analytic above the history. The page becomes: title + window chips → filter bar → KPI tiles → trends panel → charts → prediction history. Convert the history to the four-level day → game → at-bat → pitch accordion, open state keyed by path in `this.state.dfOpen`.

**5. Data Feed filters.** Window (Today / 7 / 14 / 30 / custom), team select, player select, Home/Away split, Batters/Pitchers role, Clear. Filters scope the KPIs, the charts and the trends panel — not the history accordion, which follows the window only. `render()` already skips a re-render while a filter control has focus; make sure the new selects are covered by that guard.

**6. Entity overlay.** Clicking a team, batter or pitcher name anywhere opens a p30d modal — four stat tiles, a per-day accuracy bar chart, a tendencies list. Reuse `/player/{id}/profile` and `/player/{id}/fatigue` where they cover it.

**7. Profitable trends.** This one needs backend work; do it last and propose the shape before you build it. It needs, per player and window: graded calls, win rate, win rate vs the window baseline, net units, current streak, and a home/away split. Either extend `/accuracy` with a `group_by=player,side` mode or add `GET /trends`. Apply a minimum-sample floor of 20 graded calls so a small hot streak cannot top the table. Follow the repo's existing conventions for a new API route and its migration.

Known backend gaps — call them out rather than papering over them:

- `/live` carries **no runners**; `pitchhawk-data.js` hard-codes all three bases false. Thread `postOnFirst/Second/Third` from the MLB live feed through `live-poll` into `live_state`. Until that ships, render an empty diamond and a `—` situation cell.
- `/live` carries no score or venue — read those from `/games` / `/board`.
- `game_moneyline` is fitted but not served (`model.ts` has no `log5` branch; `game-predict` uses the default `homeAdv`), and `game_total` is scored but unregistered. Both are frozen at pregame. The design labels them `PREGAME`; keep that label honest and do not imply a live line.
- Game context is written by the nightly warehouse publish, so today's games have none — the metadata tier must degrade to dashes with the explanatory note, never to a spinner.

When each step is done, run the frontend against the live API (`bash scripts/build_frontend.sh && python -m http.server 5173 -d dist`) and check it at 390, 768, 1024 and 1440. Confirm that an open pill, a selected hero chip and a set filter all survive an 8s poll.
