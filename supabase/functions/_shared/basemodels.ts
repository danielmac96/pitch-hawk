// Base models for the markets the board had no model for at all.
//
// These are deliberately simple: league rates scaled by a player's 30-day
// rolling rates (shrunk toward league on thin samples), rolled up over an
// expected volume. They exist so every market publishes a number from day
// one and has a model_params row (version "base_v1") that a trained model
// can later replace -- NOT because they are well calibrated. Every constant
// below has a default here and can be overridden from that row's `params`
// without a code change.
//
//   batter_tb15      P(total bases >= 2)        pregame, per batter
//   batter_hrr       P(hits + runs + RBI >= 1)  pregame, per batter
//   pitcher_k|bb|hits|outs|er   line + P(over)  pregame, per probable starter
//   rest of game 1+ hit / HR                    live, per batter (remainingPa)
//   game total, live                            live, per game (liveTotal)
//
// NOT A PRICE. Published as model_fair, like every projection on the board.

import { LEAGUE } from "./model.ts";

export const BASE_VERSION = "base_v1";

// Defaults. Per plate appearance (batters) or per batter faced (pitchers).
export const BASE_DEFAULTS = {
  // Share of non-HR hits that are singles / doubles / triples. MLB 2023-25.
  single_share: 0.775,
  double_share: 0.21,
  triple_share: 0.015,
  // Per-PA chance of a run or RBI WITHOUT a hit (walk then scored, sac fly,
  // RBI groundout...). Rough; it only shifts H+R+RBI upward a little.
  run_or_rbi_without_hit: 0.06,
  // Batters faced by a starter, and hit-by-pitch rate per BF.
  starter_bf: 22.5,
  hbp_rate: 0.011,
  // Earned runs per out recorded (league ERA ~4.1 over 27 outs).
  er_per_out: 4.1 / 27,
  // Team plate appearances per out (~38 PA over 27 outs).
  team_pa_per_out: 38.2 / 27,
  // Runs per team per out, for the live total (LEAGUE.avg_runs_per_team / 27).
  runs_per_team_out: LEAGUE.avg_runs_per_team / 27,
  // Shrinkage half-samples: how many PA / BF before a player's own rate
  // carries most of the weight.
  batter_shrink_pa: 150,
  pitcher_shrink_bf: 200,
};
export type BaseParams = Partial<typeof BASE_DEFAULTS>;
const P = (o?: BaseParams) => ({ ...BASE_DEFAULTS, ...(o ?? {}) });

// Toward league on thin samples: weight = n / (n + k).
function shrink(v: number | null | undefined, league: number, n: number, k: number): number {
  if (v == null || !Number.isFinite(v) || !(n > 0)) return league;
  const w = n / (n + k);
  return v * w + league * (1 - w);
}

// Integer-PA formula evaluated at a fractional expectation by mixing floor and
// ceil, so 4.49 PA means "4 most of the time, 5 sometimes".
function mixPa(pa: number, f: (n: number) => number): number {
  if (!(pa > 0)) return f(0);
  const lo = Math.floor(pa), w = pa - lo;
  return w === 0 ? f(lo) : (1 - w) * f(lo) + w * f(lo + 1);
}

/** P(X > line) for X ~ Poisson(mean). */
export function poissonOver(line: number, mean: number): number {
  if (line < 0) return 1;
  if (!(mean > 0)) return 0;
  const k = Math.floor(line);           // over k.5 means X >= k+1
  let term = Math.exp(-mean), cdf = term;
  for (let i = 1; i <= k; i += 1) { term *= mean / i; cdf += term; }
  return Math.min(1, Math.max(0, 1 - cdf));
}

const r4 = (v: number) => Math.round(v * 10000) / 10000;

export interface BatterInputs { hitRate: number | null; hrRate: number | null; samplePa: number }

function batterRates(b: BatterInputs, p: ReturnType<typeof P>) {
  const hit = shrink(b.hitRate, LEAGUE.ab_result.hit, b.samplePa, p.batter_shrink_pa);
  const hr = Math.min(hit, shrink(b.hrRate, LEAGUE.hr_rate, b.samplePa, p.batter_shrink_pa));
  return { hit, hr };
}

/** P(total bases >= 2) over `pa` plate appearances. */
export function batterTb15(b: BatterInputs, pa: number, params?: BaseParams) {
  const p = P(params);
  const { hit, hr } = batterRates(b, p);
  const single = (hit - hr) * p.single_share;
  // Fewer than two total bases: no hits at all, or exactly one single.
  const under = (n: number) => (n <= 0 ? 1 : Math.pow(1 - hit, n) + n * single * Math.pow(1 - hit, n - 1));
  const probability = Math.min(1, Math.max(0, 1 - mixPa(pa, under)));
  // Expected total bases, for the expected_value column.
  const tbPerPa = single + (hit - hr) * (2 * p.double_share + 3 * p.triple_share) + 4 * hr;
  return { probability: r4(probability), expected_value: r4(tbPerPa * Math.max(0, pa)), per_pa: r4(tbPerPa) };
}

/** P(hits + runs + RBI >= 1) over `pa` plate appearances. */
export function batterHrr(b: BatterInputs, pa: number, params?: BaseParams) {
  const p = P(params);
  const { hit } = batterRates(b, p);
  const perPa = hit + p.run_or_rbi_without_hit * (1 - hit);
  const probability = pa > 0 ? 1 - Math.pow(1 - perPa, pa) : 0;
  return { probability: r4(probability), per_pa: r4(perPa), hit_rate_used: hit };
}

export type StarterMarket = "pitcher_k" | "pitcher_bb" | "pitcher_hits" | "pitcher_outs" | "pitcher_er";
export interface StarterInputs { kRate: number | null; bbRate: number | null; hitRate: number | null; sampleBf: number }

/** A starter's line (nearest half-point at or below the mean) and P(over). */
export function starterProp(market: StarterMarket, s: StarterInputs, params?: BaseParams) {
  const p = P(params);
  const k = shrink(s.kRate, LEAGUE.ab_result.strikeout, s.sampleBf, p.pitcher_shrink_bf);
  const bb = shrink(s.bbRate, LEAGUE.ab_result.walk, s.sampleBf, p.pitcher_shrink_bf);
  const hit = shrink(s.hitRate, LEAGUE.ab_result.hit, s.sampleBf, p.pitcher_shrink_bf);
  const bf = p.starter_bf;
  const outs = bf * Math.max(0, 1 - hit - bb - p.hbp_rate);
  const baserunners = (hit + bb) / (LEAGUE.ab_result.hit + LEAGUE.ab_result.walk);
  const mean = market === "pitcher_k" ? bf * k
    : market === "pitcher_bb" ? bf * bb
      : market === "pitcher_hits" ? bf * hit
        : market === "pitcher_outs" ? outs
          : outs * p.er_per_out * baserunners;
  const line = Math.floor(mean) + 0.5;
  return { line, expected_value: r4(mean), probability: r4(poissonOver(line, mean)) };
}

// ── live ────────────────────────────────────────────────────────────────────
export interface LiveSituation { inning: number; top: boolean; outs: number }

/** Outs a team still has to bat with, assuming nine innings are played. */
export function remainingOuts(sit: LiveSituation, side: "home" | "away"): number {
  const i = sit.inning, left = Math.max(0, 3 - (sit.outs ?? 0));
  if (side === "away") return sit.top ? left + 3 * Math.max(0, 9 - i) : 3 * Math.max(0, 9 - i);
  return sit.top ? 3 * Math.max(1, 10 - i) : left + 3 * Math.max(0, 9 - i);
}

/**
 * Expected further plate appearances for a batter, from the outs his team has
 * left and where his slot sits relative to the batter due. `currentSlot` is
 * the slot at the plate when his team is batting, null otherwise (then the
 * next slot due is unknown and every offset is equally likely).
 */
export function remainingPa(
  x: LiveSituation & { side: "home" | "away"; slot: number; currentSlot: number | null },
  params?: BaseParams,
): number {
  const p = P(params);
  const teamPa = remainingOuts(x, x.side) * p.team_pa_per_out;
  if (!(teamPa > 0)) return 0;
  // Trips in n team PAs for a batter k slots from the one due (0 = due now).
  const trips = (n: number, k: number) => (n > k ? Math.floor((n - 1 - k) / 9) + 1 : 0);
  const at = (k: number) => mixPa(teamPa, (n) => trips(n, k));
  if (x.currentSlot == null) {
    let s = 0;
    for (let k = 0; k < 9; k += 1) s += at(k);
    return r4(s / 9);
  }
  return r4(at(((x.slot - x.currentSlot) % 9 + 9) % 9));
}

/** P(at least one more) from a per-PA rate over the remaining trips. */
export function restOfGame(perPa: number, remaining: number): number {
  if (!(perPa > 0) || !(remaining > 0)) return 0;
  return r4(1 - Math.pow(1 - perPa, remaining));
}

/** Projected final total and P(over the pregame line) from the live score. */
export function liveTotal(
  x: LiveSituation & { home: number; away: number }, line: number, params?: BaseParams,
) {
  const p = P(params);
  const now = (x.home ?? 0) + (x.away ?? 0);
  const more = (remainingOuts(x, "away") + remainingOuts(x, "home")) * p.runs_per_team_out;
  const projected = now + more;
  // Already past the line: decided. Otherwise the remaining runs must clear it.
  const p_over = now > line ? 1 : poissonOver(line - now, more);
  return { projected: r4(projected), line, p_over: r4(p_over) };
}

// ── grading ─────────────────────────────────────────────────────────────────
// Exact where the hot tables can say exactly what happened; void otherwise,
// so a market we cannot grade never sits pending (and never trips /health).
//   batter_tb15                    total bases from at_bats.result_detail
//   pitcher_k | pitcher_bb | hits  counted per pitcher from at_bats.result
//   batter_hrr                     void: runs and RBI are not stored
//   pitcher_outs | pitcher_er      void: outs per PA and run attribution
//                                  are not stored
// A batter with no plate appearance, or a starter who faced no batter, is
// void -- a scratch is not a miss.
export interface BaseGradeInputs {
  pa?: number; tb?: number;                          // batter
  bf?: number; k?: number; bb?: number; hits?: number; // pitcher
}
export function gradeBase(market: string, line: number | null, x: BaseGradeInputs) {
  const voidRow = { result: "void" as const, actual_count: null as number | null, plate_appearances: x.pa ?? x.bf ?? 0 };
  const decide = (n: number, played: number, threshold: number) =>
    played > 0
      ? { result: (n > threshold ? "hit" : "miss") as "hit" | "miss", actual_count: n, plate_appearances: played }
      : voidRow;
  switch (market) {
    case "batter_tb15": return decide(x.tb ?? 0, x.pa ?? 0, line ?? 1.5);
    case "pitcher_k": return decide(x.k ?? 0, x.bf ?? 0, line ?? 0);
    case "pitcher_bb": return decide(x.bb ?? 0, x.bf ?? 0, line ?? 0);
    case "pitcher_hits": return decide(x.hits ?? 0, x.bf ?? 0, line ?? 0);
    default: return voidRow;   // batter_hrr, pitcher_outs, pitcher_er
  }
}
