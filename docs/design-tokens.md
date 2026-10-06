# Pitch Hawk design tokens & thesis

## Thesis

Pitch Hawk is a **second-screen live companion for the sports analytics
enthusiast** — a fan watching the game on TV with their phone in hand,
checking what the model says about the next pitch. That dictates three
things: the phone layout is the primary layout (desktop is the
enhancement), every glanceable number is set in the data face so it reads
like a broadcast overlay, and green is reserved for exactly one meaning —
live/model signal — so the eye can find "what's happening now" instantly.

The identity **evolves the existing look** rather than replacing it: navy
ink on calm cool-gray surfaces with a single deep-green accent already
reads "credible analytics tool" — deliberately not casino-coded (no felt
green fields, no gold, no red/black), and not an AI-default look either.

## Tokens

The palette lives as CSS custom properties on `.ph-root`
(`frontend/pitchhawk.css`); `[data-theme="dark"]` flips the whole board via
one attribute. Values below are the light theme (dark equivalents in the
stylesheet).

### Color

| Token | Value | Role |
| --- | --- | --- |
| `--bg` | `#f5f7fb` | page background |
| `--surface` / `--surface-2` | `#ffffff` / `#f6f8fc` | cards / inset panels |
| `--border` / `--border-2` | `#e6eaf1` / `#d6deea` | hairlines / interactive borders |
| `--text` / `--text-2` | `#11203a` / `#44546e` | primary / secondary ink |
| `--muted` / `--faint` | `#7a879c` / `#9aa6b8` | captions / de-emphasized |
| `--accent` | `#15824c` | THE signal color: live status, model calls, CTAs |
| `--good-strong` / `--good-bg` | `#0f7a44` / `#f2f8f4` | correct calls, live chips |
| `--bad` / `--bad-bg` | `#c23b34` / `#fbecea` | wrong calls |
| `--amber`, `--blue`, `--purple` | `#b07d12`, `#2563c9`, `#7c5cd6` | pitch-type / categorical coding only |
| `--bc-bg` / `--bc-inner` | `#0f1b2d` / `#16263d` | "broadcast" dark panels |

Rules: `--accent` green never decorates — if it's green, it's live or it's
the model's call. Red/amber/blue/purple encode data categories (pitch
types, results), never brand.

### Type

| Face | Role |
| --- | --- |
| Hanken Grotesk 400–800 | display + body; weight 800 with `-.02em` tracking for headings |
| IBM Plex Mono 400–600 | every number a fan compares: scores, velo, counts, percentages |

Fluid sizes via `clamp()` on headings (e.g. hero
`clamp(1.9rem, 4vw, 3rem)`); body 1rem, captions ≥ .72rem.

### Space & shape

Spacing in rem on a loose 4px rhythm (.35/.5/.7/.9/1.2/1.4…). Radii: 999px
pills for controls, 12–14px cards, 18px hero panels. Shadows: two-layer
soft (`0 1px 2px` + `0 6px 16px` at ≤ 9% opacity) — lift, not chrome.

### Signature element

The pulsing green live dot (`ph-pulse`) next to the ◆ wordmark, echoed by
the green "next pitch" accent bar in the feed — the brand gesture is "the
board is alive." Disabled under `prefers-reduced-motion`.

## Responsive system (mobile-first)

Two lines matter. **1024px** is the phone/desktop layout switch: below it
`Board.mob()` is true and `pitchhawk.js` renders the phone variants, while
`@media (max-width: 1023.98px)` blocks in `pitchhawk.css` reflow the rest.
The four-tab redesign's desktop grids need about 1,000px, so tablets in
portrait get the phone layout too. **768px** moves the tab bar from a
fixed bottom bar into the header. Verified at 360 / 390 / 768 / 1024 / 1440
with `scripts/dev_mock_api.py` (see `FRONTEND.md`).

- **Tables become cards on a phone.** Every wide table row (Home pill
  batters and starters, the three Predictions tables, the Data Feed's
  by-market table) renders through `mCardHtml()`: a head line, the two
  numbers a reader compares, and the rest behind a ▸ chevron. Expansion
  lives in `state.mOpen`, never the DOM, because `render()` replaces the
  tree on every poll. Starter values come from `starterStatPairs()`, so the
  desktop row and the phone card cannot disagree.
- **Filters collapse.** On a phone the Predictions and Data Feed filter bars
  keep the primary chips in one sideways-scrolling row and put the rest
  behind a `Filters` toggle that counts the active filters.
- **No hover on touch.** Chart tooltips (calibration bands, daily gap) are
  tap-to-select on a phone, with the reading printed under the chart.
- **No `backdrop-filter` on the header below 768px.** It makes the header
  the containing block for its fixed children, which pinned the phone tab
  bar to the top of the screen. The header is opaque there instead.

- `.ph-nav`: fixed bottom tab bar under 768px (48px targets,
  `safe-area-inset-bottom`); header pill row above.
- `.ph-hero` is the Live tab's green hero panel (2026-09 redesign); the old Home hero/promo split is gone.
- Wide tables scroll inside their card — the page itself never scrolls
  horizontally (fixed-width grids are guarded with
  `minmax(min(Npx, 100%), 1fr)`). The board builds these inline in
  `pitchhawk.js`; the `.ph-table` / `.ph-scroll` / `.ph-chip` class system
  that once backed them was never used by the markup and was removed in
  2026-08.
- `viewport-fit=cover` + `env(safe-area-inset-*)` on nav and footer.
