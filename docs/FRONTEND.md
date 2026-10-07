# Frontend

A vanilla-JS single-page app. No framework, no bundler, no npm dependencies —
`scripts/build_frontend.sh` copies `frontend/` to `dist/` and substitutes two
placeholders into `config.js`. That is the whole build.

| file | what it is |
|---|---|
| `index.html` | shell; mounts `#ph-root` and loads the four scripts in order |
| `config.js` | injects the API base and feature flags at build time |
| `copy.js` | every positioning-sensitive string, in both voices |
| `pitchhawk-data.js` | API adapters and the normalisers that shape rows for the board |
| `pitchhawk.js` | renders the Home / Live Feed / Data Feed tabs |
| `pitchhawk.css` | theme tokens (light/dark) and layout |

Design system and responsive rules: [`design-tokens.md`](design-tokens.md).

## Phone layout

Below 1024px (`Board.mob()`) every tab renders a phone layout: one column,
wide tables as expandable cards, filters behind a toggle. The rules are in
[`design-tokens.md`](design-tokens.md#responsive-system-mobile-first).

## URL state

The tab, the game in view and the filters live in the hash, so a reload keeps
the reader's place, a link can be shared and Back steps between tabs:

```
#/home?open=<pk,...>            #/live/<pk>
#/pred?m=hr&team=NYY,BOS&status=live&lineup=1&min=3&sort=prob-
#/data?tf=14&mk=batter_hit&team=NYY&park=3313&hand=L&side=home
```

`routeOf()` writes it after every render (push on a new tab or game, replace on
a filter change); `routePatch()` reads it on boot and on `popstate`. Unknown
values fall back to the defaults.

## Rendering

`render()` rebuilds `#ph-root` with `innerHTML`, but no longer on every poll:
a poll whose `/live` payload is unchanged only re-stamps the `[data-clock]`
elements in place (a full render still happens at least once a minute, for
countdowns). Focus is captured before a rebuild and restored after it by
`data-act`/`data-arg`, and the Live tab announces score / inning / batter
changes through an `aria-live` region outside the root.

Gaps render as a quiet dash with the reason in a tooltip (`missingHtml`); model
ids live in tooltips, not cells.

## Checking layouts without the live API

`scripts/dev_mock_api.py` serves `dist/` and a canned slate (live, final and
scheduled games, batter and starter projections) on one localhost port. On
localhost the Data Feed falls back to its own labelled dev fixture.

```bash
bash scripts/build_frontend.sh
python3 scripts/dev_mock_api.py        # http://localhost:8787/
```

Every value it serves is invented, and it never ships (`dist/` gets no
`dev/`, and the script lives outside `frontend/`).

## Live data only

The board reads the live API and has **no offline fallback**. With no reachable
API it says it cannot reach the feed. A synthetic demo-fixture generator lived
in `pitchhawk-data.js` until 2026-08, but nothing ever called it — a build with
an empty API URL hung on "Loading today's games…" — so the code and the claim
were removed together rather than leaving a documented mode that did not exist.

The practical consequence: a screenshot taken off-hours, or against a paused
Supabase project, shows an empty state rather than the product.

## The wagering flag

One flag gates every odds/edge/picks surface:
`window.PH_FEATURES.wageringInsights`, default **off**. The pipeline behind it
keeps running; only the UI is hidden.

Two ways to restore it, no code change:

1. **Build time** — `PITCHHAWK_FEATURE_WAGERING=true bash scripts/build_frontend.sh`
   (on Vercel, set the env var).
2. **Runtime** — `localStorage["ph-feature-wagering"] = "true"`, reload.
   `"false"` forces it off; removing the key falls back to the build value.

Turning it on restores: the sportsbook/prediction-market source filter chips,
edge-threshold highlighting, the Edge column in the Data Feed's live at-bats
table, the settled-picks table, the wagering hero and "how it works" copy, the
21+/1-800-GAMBLER compliance lines, and the per-game `/edge/{game_pk}` API
calls.

Both voices live in `copy.js`: the base object positions the product as an
analytics board, and `WAGERING_OVERRIDES` restores the betting framing.

Regression check that the flag-off build stays clean:

```bash
rg -i "sportsbook|parlay|bankroll|\bwager|1-800-GAMBLER" frontend/
```

Hits should only be in `copy.js` (the overrides) and `config.js` (the flag
itself) — never in rendered default copy.
