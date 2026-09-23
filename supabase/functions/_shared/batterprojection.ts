// Per-batter, per-game P(hit) and P(home run), from the per-plate-appearance
// batter markets.
//
// Two steps, and the second is the one worth reading:
//
//   1. Score `batter_hit` / `batter_hr` for the matchup. Both are ordinary
//      two-class multinomial models, so `scoreMultinomial` handles them with
//      no new branch.
//   2. Roll a PER-PLATE-APPEARANCE probability up to a PER-GAME one. These are
//      different questions and conflating them is the easy mistake: a 3.2%
//      chance of a home run in one trip is a ~13% chance of one somewhere in
//      four.
//
// The roll-up assumes plate appearances are independent, which they are not
// quite -- a batter in a big inning gets an extra trip, and the same offence
// that produces the extra trip produced the hits. The bias is upward and
// small at these rates. It is written down rather than corrected because a
// correction we cannot measure is worse than a bias we can name.
//
// NOT A PRICE. Every number here is published as `model_fair`. There is no
// prop source for these markets, so any "edge" would be against even money.

import {
  LEAGUE,
  type Params,
  scoreMultinomial,
  type ScoreContext,
} from "./model.ts";

// Plate appearances per game by batting-order slot, for a STARTER.
//
// Measured over 176 games x 2 sides across six 2025 dates, counting only
// starters who actually batted. Totals 36.3 per side, which is correctly
// below the league's ~37-38: substitutes take the remainder, and the batter
// we are projecting is the one who started.
const PA_BY_SLOT: readonly number[] = [
  4.49, 4.35, 4.26, 4.22, 4.11, 3.97, 3.83, 3.64, 3.45,
];

// Used when the lineup has not been posted yet. The mean of the nine slots,
// which is the honest answer to "we do not know where he bats".
const PA_UNKNOWN_SLOT = 4.04;

export interface BatterProjection {
  market: string;
  per_pa_probability: number;
  expected_pa: number;
  probability: number;
  model_version: string;
}

/** Expected plate appearances for a starter in `slot` (1-9). */
export function expectedPa(slot: number | null): number {
  if (slot == null || !Number.isFinite(slot)) return PA_UNKNOWN_SLOT;
  const i = Math.round(slot) - 1;
  return i >= 0 && i < PA_BY_SLOT.length ? PA_BY_SLOT[i] : PA_UNKNOWN_SLOT;
}

/**
 * P(at least one) across `pa` independent trips at probability `p`.
 *
 * Fractional plate appearances are meaningful here: 4.49 is an expectation
 * over games, not a count, and `1 - (1-p)^4.49` is the natural continuous
 * reading of it.
 */
export function atLeastOnce(p: number, pa: number): number {
  if (!(p > 0)) return 0;
  if (p >= 1) return 1;
  if (!(pa > 0)) return 0;
  return 1 - Math.pow(1 - p, pa);
}

/**
 * Score one batter against one pitcher for one market.
 *
 * Returns null when no trained model is active. There is deliberately NO
 * heuristic fallback: the other markets fall back to a league-average
 * constant, which is reasonable for a board that must always render
 * something, but a per-player projection that silently shows every batter the
 * league rate is worse than showing nothing. An absent row is legible; a
 * uniform column of 0.032 is not.
 */
export function projectBatter(
  market: string,
  models: Record<string, Params>,
  ctx: ScoreContext,
  slot: number | null,
): BatterProjection | null {
  const params = models[market];
  if (!params || params.type !== "multinomial_logistic") return null;

  const probs = scoreMultinomial(params, ctx);
  const positive = market === "batter_hr" ? "home_run" : "hit";
  const perPa = probs[positive];
  if (perPa == null || !Number.isFinite(perPa)) return null;

  const pa = expectedPa(slot);
  // Round FIRST, then roll up. The published row stores per_pa_probability
  // and expected_pa so a reader can reproduce `probability` -- which only
  // holds if the roll-up used the value that was published rather than the
  // full-precision one behind it. The difference is ~1e-4; the difference
  // between a reproducible row and a nearly-reproducible one is not.
  const rounded = round4(perPa);
  return {
    market,
    per_pa_probability: rounded,
    expected_pa: pa,
    probability: round4(atLeastOnce(rounded, pa)),
    model_version: String((params as { version?: unknown }).version ?? "active"),
  };
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/**
 * A sanity band on a published probability.
 *
 * Not a substitute for the promotion gate -- that runs offline against
 * out-of-sample metrics and is where a miscalibrated model should be caught.
 * This is the last line before a number reaches a page: a per-game home-run
 * probability above 40% or a hit probability above 95% is not a bold call, it
 * is a broken one, and publishing it costs more credibility than omitting the
 * row.
 */
export function isPlausible(market: string, probability: number): boolean {
  if (!Number.isFinite(probability) || probability < 0) return false;
  const ceiling = market === "batter_hr" ? 0.40 : 0.95;
  return probability <= ceiling;
}

/** The league base rate for a market, per plate appearance. */
export function leagueRate(market: string): number {
  return market === "batter_hr" ? LEAGUE.hr_rate : LEAGUE.ab_result.hit;
}

export interface Grade {
  result: "hit" | "miss" | "void";
  actual_count: number;
  plate_appearances: number;
}

/**
 * Grade one published projection against what the batter actually did.
 *
 * Three outcomes, and the third is the one that matters:
 *
 *   hit    the event happened at least once
 *   miss   he batted and it did not
 *   void   HE DID NOT BAT
 *
 * A projected batter who never came to the plate is a late scratch or a
 * lineup that changed after we scored it. That is not a failed prediction,
 * and grading it as a miss would drag every measured rate downward by however
 * often clubs change their minds -- which would then read as an
 * over-confident model rather than as roster churn.
 *
 * `projection_calibration` excludes voids from both the predicted and the
 * observed side for the same reason.
 */
export function gradeProjection(
  market: string,
  plateAppearances: number,
  hitCount: number,
  homeRunCount: number,
): Grade {
  const actual = market === "batter_hr" ? homeRunCount : hitCount;
  return {
    result: plateAppearances === 0 ? "void" : (actual > 0 ? "hit" : "miss"),
    actual_count: actual,
    plate_appearances: plateAppearances,
  };
}
