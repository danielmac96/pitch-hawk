# Claude Code kickoff

## Paste this into Claude Code (repo root of danielmac96/pitch-hawk)

> Implement the Pitch Hawk redesign described in `design/redesign/README.md`. The HTML in `design/redesign/design/` is a visual and behavioural reference only. Rebuild it inside `frontend/` using the existing vanilla-JS string-template pattern in `frontend/pitchhawk.js`, CSS classes in `frontend/pitchhawk.css`, and copy in `frontend/copy.js`. Use the tokens already in `docs/design-tokens.md`; the README's token table matches them. Wire data per `DATA_CONTRACT.md`. Where a field isn't served, render `—` with the NOT SERVED / NOT MODELED / NEEDS ROUTE tag shown in the design; never fake values. Before starting, read `docs/DATA-MAP-FOR-DESIGN.md` and the current `frontend/pitchhawk.js`. Work in the phases in `CLAUDE_CODE_KICKOFF.md` and stop after each phase for review.

## Phases
1. **Shell and tokens.** Build the header tab bar (Home · Predictions · Live · Data Feed), the live-count indicator, the API-down banner, the ★ Watching row with `localStorage['ph-watch']`, the footer, the 8s poll, and the `ph-pulse` / `ph-flash` animations with a reduced-motion guard.
2. **Home.** Build the status bar, Pregame/Live mode toggle, 4 decision cards, grouped game pills, and pill expansion (metadata grid, side tabs, sort, batter table, starters table, lineup-pending and final notes). Use the shared probability-cell component.
3. **Predictions.** Build the filter bar, 5 trust tiles, the three table variants, sortable headers, "Show all", and the empty state.
4. **Live.** Build the SHOWING chips, hero (next pitch and at-bat distributions), pitch log, three rail cards, other-live-games grid, and the nothing-live state.
5. **Data Feed.** Build the master filter bar (timeframe, market, team, stadium, hand, side, Clear, scenario summary), KPI tiles, calibration chart, daily gap chart, by-market table, team grid, matchup splits, sticky resolved-markets feed with day groups and paging, and the empty states. Start with the client-side aggregation from the prototype's `dataVals()` over `/graded` rows. Move to `/graded/summary` if the backend adds it.
6. **Mobile (390px).** Not designed yet; ask before building.

## Where things are in the prototype script
- `GAMES`, `LU`, `POWER`, `CONTACT`: slate fixture (replace with `/live` + `/projections`).
- `cell(b, m)`: probability cell maths (lift in pts, relative-to-league bands ≥1.10 / <0.95, bar and tick widths).
- `why(b, m)`: the two "why" lines.
- `wp(g)`, `topCall(g)`, `chipOf`, `phaseChip`, `resChip`: game helpers.
- `buildHist()`, `buildToday()`: Data Feed fixtures (replace with `/graded`).
- `dataVals(demo)`: every Data Feed filter and aggregate. Port its logic, including which aggregates ignore which filter.
- `renderVals()`: the rest of the view model.

## Acceptance checks
- [ ] Every number uses IBM Plex Mono; every missing value is `—` with the right tag.
- [ ] Pins survive a reload; unpinning from the Watching row works.
- [ ] Opening a pill from a card, Predictions row, or Watching pill lands on Home with that pill expanded on the right side tab, scrolled to about 80px from the top.
- [ ] Mode defaults to Live whenever a game is live.
- [ ] API-down and no-games states are visually distinct.
- [ ] Pending calls never show as MISS; DNP/void are excluded from every accuracy figure.
- [ ] Data Feed: one filter bar drives all charts and the feed; the feed has no filters of its own.
- [ ] Data Feed: the by-market table ignores the market filter, the team grid ignores the team filter, and the daily chart dims days outside the timeframe.
- [ ] Data Feed: stadium options read `Stadium · TEAM · City, ST`, and choosing one filters to games at that venue for both teams.
- [ ] Data Feed: any filter change resets the feed to 40 items; "Show 40 more" appends.
- [ ] At a ~920px pane width the feed stays in the right column; below ~776px it stacks under the analysis.
- [ ] No odds, edge, or betting language anywhere.
