# Data contract: what each screen reads

Sources: `docs/DATA-MAP-FOR-DESIGN.md` and `supabase/functions/api/index.ts`. Rule: a value that doesn't exist renders `—` with a tag. It never renders as `0` or a guess.

## Home / Live / Predictions (existing routes)
| UI element | Field(s) | Route |
|---|---|---|
| Slate, status bar counts | `phase`, teams, `start_ts`, scores, `venue_name` | `GET /live` (whole slate) |
| Situation, count, outs, batter/pitcher | `situation{inning, half, count, outs}`, `batter_name/hand`, `pitcher_name/hand` | `/live` |
| Next pitch / at-bat distributions | `markets[]` → `pitch_result`, `ab_result`, `pitch_speed_ou`, `ab_pitches_ou` | `/live` |
| Pitch log | `current_pa_pitches[]`, `pa_predictions[]` | `/live` |
| Win prob (pregame → now) | `game_moneyline` in `markets_pregame[]` / `markets[]` | `/live` |
| Total | `game_total` (pregame, frozen) | `/live` |
| Probable starters | `probable_home/away_pitcher` | `/live` |
| 1+ Hit / 1+ HR cells | `probability, per_pa_probability, expected_pa, lineup_slot, opposing_pitcher, updated_at` | `GET /projections?date&market=batter_hit|batter_hr` |
| 30D H/PA, HR/PA | `batter_rolling_stats.hit_rate, hr_rate` | not routed per slate; needs joining |
| Starter K%, whiff, HR/PA, FB velo | `pitcher_rolling_stats` | not routed per slate |
| Fatigue | `pitcher_fatigue_profile.velo_delta_vs_bucket0` (75–99 bucket) | `/player/{id}/fatigue` |
| H2H | `matchup_history` (`found:false` under 3 PA) | `/matchup/{p}/{b}` |
| Result chips (final games) | `player_game_projections.result` (hit/miss/void) | `/projections` |
| At-bat accuracy (other live games) | graded `predictions` for the game | `/pitches?game_pk` |
| Stadium / weather meta | `game_context` covers completed games only | `/game/{pk}/context` → `—` today |

**Not served (keep the tags):** runners on base, weather for today, TODAY H/HR/PA, live pitch count, rest-of-game P(hit/HR), win-prob history (sparklines), and every pitcher prop and H+R+RBI / TB market.

## Data Feed

### What it needs: one graded row per resolved read
```ts
type GradedRead = {
  id: string;
  resolved_at: string;      // ISO; sort key for the feed
  official_date: string;    // group key
  market: 'batter_hit'|'batter_hr'|'game_moneyline'|'game_total'|'ab_result'|'pitch_result';
  game_pk: number; away_abbr: string; home_abbr: string;
  venue_id: number; venue_name: string;   // stadium filter
  team_ids: number[];       // batter's team for batter markets; both teams for game/pitch/at-bat markets
  subject: string;          // "Aaron Judge" | "PHI to win" | "Over 8.5" | "Ball"
  probability: number;      // at lock time
  result: 'hit'|'miss'|'void';   // UI shows LANDED / MISS / DNP
  actual_label?: string;    // for pitch/at-bat misses: "strike_foul", "walk"…
  opp_pitcher_hand?: 'L'|'R'; // null for game-level markets
  batting_side?: 'home'|'away'; // null for game-level markets
  lineup_slot?: number;     // batter markets only
  meta?: string;            // prebuilt second line, or build it client-side
};
```

### Where each part lives today
| Market | Table | Hand / side / slot available? |
|---|---|---|
| batter_hit, batter_hr | `player_game_projections` | `opposing_pitcher_id` → hand via `player_info`; `is_home`; `lineup_slot` ✅ |
| game_moneyline, game_total | `game_predictions` (phase = pregame) | n/a |
| ab_result, pitch_result | `predictions` | batter/pitcher via `at_bats` / `pitches` join; 21-day retention ⚠️ |
| venue | `games.venue_id, venue_name` | ✅ |

### Proposed routes (confirm with backend)
1. `GET /graded?from&to&market&team&venue&hand&side&limit&cursor` returns `GradedRead[]`, newest first, with cursor pagination. It feeds the right-hand feed ("Show 40 more" means the next cursor).
2. `GET /graded/summary?from&to&market&team&venue&hand&side` returns the aggregates below, so the client doesn't need every row:
```ts
{
  overall: Stat,
  bins: Stat[10],                    // by probability decile
  daily: {date: string, stat: Stat}[],   // ignores timeframe; client dims days outside it
  by_market: {market, stat}[],       // ignores the market filter
  by_team: {team_abbr, stat}[],      // ignores the team filter
  splits: {group:'PITCHER'|'SIDE'|'ORDER', label, stat}[]
}
type Stat = { n: number; exp: number; act: number; brier: number }; // gap and skill derived client-side
```
The "ignores X filter" rules matter. The by-market table and team grid show every market or team so they can act as filters, and the daily chart always spans enough days to give context.

Alternative: if the row volume in a 30-day window is small enough (under ~20k), `/graded` alone can serve everything and the client computes aggregates exactly as `dataVals()` does in the prototype.

### Existing routes that overlap
- `/accuracy?from&to&market`: per-day, per-market accuracy. It can back the daily chart and by-market table when no team, venue, hand or side filter is set.
- `/trends`: per-player accuracy. Not used in this design.
- `/feed?from&to`: game-level history (win prob, totals only).

### Stadium list
Build it from `games.venue_id/venue_name` joined to the home team's abbreviation, plus a city lookup (the prototype hard-codes 24 parks in `PARKS`). The label format is `Stadium · TEAM · City, ST`. Include neutral sites if they appear in `games`.
