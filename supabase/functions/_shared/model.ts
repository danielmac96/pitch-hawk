// v1 model scoring. Parameters live in the model_params table (one active row
// per market, written by scripts/train_models.py). Every market degrades to a
// calibrated league-average heuristic when no trained row exists, so the
// pipeline works on day zero and gets sharper as soon as training runs.

import { svc } from "./db.ts";

export const LEAGUE = {
  avg_speed: 92.8,
  pitch_result: { strike_foul: 0.455, ball: 0.352, in_play: 0.193 },
  ab_result: { strikeout: 0.221, walk: 0.087, hit: 0.239, out: 0.453 },
  avg_pitches_pa: 3.85,
  speed_sigma: 5.4,
};

export interface ScoreContext {
  balls: number;
  strikes: number;
  pitch_count_pa: number;
  pitcher: Record<string, any> | null; // pitcher_rolling_stats row
  batter: Record<string, any> | null;  // batter_rolling_stats row
  pitcher_info?: Record<string, any> | null; // player_info row
  batter_info?: Record<string, any> | null;
}

export interface MarketPrediction {
  market: string;
  predicted_value: number | null;
  confidence: number | null;
  probs: Record<string, number> | null;
  model_version: string;
  sample_size: number;
}

type Params = Record<string, any>;

export async function loadActiveModels(): Promise<Record<string, Params & { version: string }>> {
  const { data } = await svc()
    .from("model_params").select("market,version,params").eq("is_active", true);
  const out: Record<string, Params & { version: string }> = {};
  for (const r of data ?? []) out[r.market] = { ...(r.params ?? {}), version: r.version };
  return out;
}

function softmax(zs: number[]): number[] {
  const m = Math.max(...zs);
  const exps = zs.map((z) => Math.exp(z - m));
  const s = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / s);
}

function normalize(p: Record<string, number>): Record<string, number> {
  const s = Object.values(p).reduce((a, b) => a + Math.max(0, b), 0);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(p)) out[k] = s > 0 ? Math.max(0, v) / s : v;
  return out;
}

function blend(v: number | null | undefined, league: number, n: number, k = 500): number {
  if (v == null) return league;
  const w = 0.85 * (1 - Math.exp(-n / k));
  return v * w + league * (1 - w);
}

function normCdf(x: number): number {
  // Abramowitz-Stegun approximation; plenty for O/U probabilities.
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (x > 0) p = 1 - p;
  return p;
}

function featureValue(name: string, ctx: ScoreContext): number {
  const p = ctx.pitcher ?? {}, b = ctx.batter ?? {};
  const pl = LEAGUE.pitch_result, al = LEAGUE.ab_result;
  switch (name) {
    case "bias": return 1;
    case "balls": return ctx.balls;
    case "strikes": return ctx.strikes;
    case "two_strikes": return ctx.strikes >= 2 ? 1 : 0;
    case "three_balls": return ctx.balls >= 3 ? 1 : 0;
    case "pitch_of_pa": return ctx.pitch_count_pa + 1;
    case "pitcher_velo": {
      const v = p.avg_fastball_velo != null ? Number(p.avg_fastball_velo) : null;
      return blend(v, LEAGUE.avg_speed, Number(p.sample_pitches ?? 0), 300);
    }
    case "pitcher_zone_delta": return p.zone_rate != null ? Number(p.zone_rate) - 0.48 : 0;
    case "pitcher_whiff_delta": return p.whiff_rate != null ? Number(p.whiff_rate) - 0.24 : 0;
    case "pitcher_k_delta": return p.k_rate != null ? Number(p.k_rate) - al.strikeout : 0;
    case "pitcher_bb_delta": return p.bb_rate != null ? Number(p.bb_rate) - al.walk : 0;
    case "batter_k_delta": return b.k_rate != null ? Number(b.k_rate) - al.strikeout : 0;
    case "batter_bb_delta": return b.bb_rate != null ? Number(b.bb_rate) - al.walk : 0;
    case "batter_chase_delta": return b.chase_rate != null ? Number(b.chase_rate) - 0.28 : 0;
    case "batter_contact_delta": return b.contact_rate != null ? Number(b.contact_rate) - 0.77 : 0;
    case "platoon_same": {
      const ph = ctx.pitcher_info?.pitch_hand, bs = ctx.batter_info?.bat_side;
      if (!ph || !bs || bs === "S") return 0;
      return ph === bs ? 1 : 0;
    }
    default: return 0;
  }
}

function scoreMultinomial(params: Params, ctx: ScoreContext): Record<string, number> {
  const feats: string[] = params.features ?? [];
  const x = feats.map((f) => featureValue(f, ctx));
  const zs = (params.classes as string[]).map((_c: string, i: number) => {
    const coef: number[] = params.coef[i] ?? [];
    let z = (params.intercept?.[i] ?? 0);
    for (let j = 0; j < x.length; j++) z += (coef[j] ?? 0) * x[j];
    return z;
  });
  const ps = softmax(zs);
  const out: Record<string, number> = {};
  (params.classes as string[]).forEach((c: string, i: number) => out[c] = ps[i]);
  return out;
}

function scoreLinear(params: Params, ctx: ScoreContext): number {
  const feats: string[] = params.features ?? [];
  let y = params.intercept ?? 0;
  feats.forEach((f, j) => y += (params.coef?.[j] ?? 0) * featureValue(f, ctx));
  return y;
}

// ── per-market predictors ─────────────────────────────────────────────────

const COUNT_PITCH_DELTAS: Record<string, Record<string, number>> = {
  "3-0": { ball: 0.08, strike_foul: -0.05, in_play: -0.03 },
  "3-1": { ball: 0.04, strike_foul: -0.02, in_play: -0.02 },
  "0-2": { strike_foul: 0.10, ball: -0.07, in_play: -0.03 },
  "1-2": { strike_foul: 0.06, ball: -0.04, in_play: -0.02 },
  "2-2": { strike_foul: 0.03, ball: -0.02, in_play: -0.01 },
};

export function predictPitchResult(models: Record<string, Params>, ctx: ScoreContext): MarketPrediction {
  const m = models["pitch_result"];
  let probs: Record<string, number>;
  let version = "heuristic_v0";
  if (m && m.type === "multinomial_logistic") {
    probs = scoreMultinomial(m, ctx);
    version = m.version;
  } else {
    probs = { ...LEAGUE.pitch_result };
    const delta = COUNT_PITCH_DELTAS[`${ctx.balls}-${ctx.strikes}`];
    if (delta) for (const [k, dv] of Object.entries(delta)) probs[k] = Math.max(0, (probs[k] ?? 0) + dv);
    if (ctx.pitcher?.zone_rate != null) {
      const zr = Number(ctx.pitcher.zone_rate);
      if (zr > 0.52) probs.strike_foul += 0.03;
      else if (zr < 0.44) probs.ball += 0.04;
    }
    probs = normalize(probs);
  }
  const top = Math.max(...Object.values(probs));
  return {
    market: "pitch_result",
    predicted_value: top,
    confidence: top,
    probs: round4(probs),
    model_version: version,
    sample_size: Number(ctx.pitcher?.sample_pitches ?? 0),
  };
}

export function predictAbResult(models: Record<string, Params>, ctx: ScoreContext): MarketPrediction {
  const m = models["ab_result"];
  let probs: Record<string, number>;
  let version = "heuristic_v0";
  if (m && m.type === "multinomial_logistic") {
    probs = scoreMultinomial(m, ctx);
    version = m.version;
  } else {
    const al = LEAGUE.ab_result;
    const n = Number(ctx.pitcher?.sample_abs ?? 0);
    probs = {
      strikeout: blend(numOrNull(ctx.pitcher?.k_rate), al.strikeout, n, 150),
      walk: blend(numOrNull(ctx.pitcher?.bb_rate), al.walk, n, 150),
      hit: al.hit,
      out: al.out,
    };
    if (ctx.batter?.k_rate != null) probs.strikeout = (probs.strikeout + blend(Number(ctx.batter.k_rate), al.strikeout, Number(ctx.batter.sample_pas ?? 0), 150)) / 2;
    if (ctx.strikes >= 2) { probs.strikeout += 0.08; probs.hit -= 0.04; probs.out -= 0.04; }
    if (ctx.balls >= 3) { probs.walk += 0.12; probs.out -= 0.06; }
    probs = normalize(probs);
  }
  const top = Math.max(...Object.values(probs));
  return {
    market: "ab_result",
    predicted_value: top,
    confidence: top,
    probs: round4(probs),
    model_version: version,
    sample_size: Number(ctx.pitcher?.sample_abs ?? 0),
  };
}

export function predictPitchSpeed(models: Record<string, Params>, ctx: ScoreContext): MarketPrediction & { sigma: number } {
  const m = models["pitch_speed_ou"];
  let mu: number, sigma: number, version = "heuristic_v0";
  if (m && m.type === "linear") {
    mu = scoreLinear(m, ctx);
    sigma = m.sigma ?? LEAGUE.speed_sigma;
    version = m.version;
  } else {
    mu = featureValue("pitcher_velo", ctx) - 2.2; // arsenal avg sits below FB velo
    if (ctx.strikes === 2) mu -= 0.4;
    if (ctx.balls === 3) mu += 0.3;
    sigma = LEAGUE.speed_sigma;
  }
  return {
    market: "pitch_speed_ou",
    predicted_value: Math.round(mu * 100) / 100,
    confidence: null, // set once joined to a line
    probs: null,
    model_version: version,
    sample_size: Number(ctx.pitcher?.sample_pitches ?? 0),
    sigma,
  };
}

export function predictAbPitches(models: Record<string, Params>, ctx: ScoreContext): MarketPrediction & { dist: Record<string, number> | null } {
  const m = models["ab_pitches_ou"];
  const current = ctx.pitch_count_pa;
  let mean: number, dist: Record<string, number> | null = null, version = "heuristic_v0";
  if (m && m.type === "remaining_table") {
    const cell = m.table?.[`${ctx.balls}-${ctx.strikes}`];
    if (cell) {
      mean = current + Number(cell.mean);
      dist = cell.dist ?? null;
      version = m.version;
    } else {
      mean = Math.max(current + 1, LEAGUE.avg_pitches_pa);
    }
  } else {
    mean = current >= LEAGUE.avg_pitches_pa
      ? current + (ctx.strikes === 2 ? 1.3 : 1.6)
      : LEAGUE.avg_pitches_pa;
  }
  return {
    market: "ab_pitches_ou",
    predicted_value: Math.round(mean * 100) / 100,
    confidence: null,
    probs: null,
    model_version: version,
    sample_size: Number(ctx.pitcher?.sample_abs ?? 0),
    dist,
  };
}

// P(next pitch speed > line) and P(total pitches in AB > line).
export function speedOverProb(mu: number, sigma: number, line: number): number {
  return 1 - normCdf((line - mu) / sigma);
}

export function pitchesOverProb(
  current: number, dist: Record<string, number> | null, mean: number, line: number,
): number {
  if (dist) {
    // dist maps REMAINING pitch counts -> prob. Total = current + remaining.
    let over = 0, total = 0;
    for (const [k, v] of Object.entries(dist)) {
      total += v;
      if (current + Number(k) > line) over += v;
    }
    if (total > 0) return over / total;
  }
  // Geometric-ish tail fallback around the mean.
  return 1 - normCdf((line - mean) / 1.9);
}

function numOrNull(v: unknown): number | null {
  return v == null ? null : Number(v);
}

function round4(p: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(p)) out[k] = Math.round(v * 10000) / 10000;
  return out;
}

// Pregame home win probability: log5 on season win% + home advantage.
export function log5HomeProb(
  homeWinPct: number | null, awayWinPct: number | null, homeAdv = 0.542,
): number {
  const h = homeWinPct ?? 0.5, a = awayWinPct ?? 0.5;
  const raw = (h * (1 - a)) / (h * (1 - a) + (1 - h) * a || 1e-9);
  // shift by home advantage in odds space
  const adv = homeAdv / (1 - homeAdv);
  const shifted = (raw * adv) / (raw * adv + (1 - raw));
  return Math.min(0.95, Math.max(0.05, shifted));
}
