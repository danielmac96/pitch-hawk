// v3 serving: plate-appearance outcome model -> every player and game market.
//
// The TypeScript twin of modeling/serve.py (per-entity scoring), with the
// math of modeling/derive.py and the design matrix of
// modeling/pa_model.pa_features. tests/modeling/test_props_parity.py pins the
// Python to the outputs this file emits into tests/fixtures/props_golden.json
// (see supabase/functions/tests/props_golden_test.ts). If the two disagree,
// THIS file is what users see.
//
// Inputs are the active model_params rows (one per market) and the nightly
// model_ratings rows -- the same ratings training was fitted on, computed by
// the same function (modeling/ratings.py). Nothing here reads the 30-day
// rolling-stat tables: that train/serve mismatch is what ran the batter
// markets 1.25-1.37x hot.
//
// Class order everywhere: K, BB(+HBP), 1B, 2B, 3B, HR, OUT.

export const NC = 7;
const K = 0, BB = 1, HR = 5, OUT = 6;
const TB_OF = [0, 0, 1, 2, 3, 4, 0];
export const RUN_WEIGHTS = [0.0, 0.70, 0.89, 1.27, 1.62, 2.10, 0.0];
export const MAX_PA = 8;
export const MAX_BF = 45;
export const MAX_OUTS = 27;

export type Vec = number[];
export type Params = Record<string, any>;
export type Bundle = Record<string, Params | undefined>;

// ── the PA model ─────────────────────────────────────────────────────────────

function logit(p: number): number {
  const q = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
  return Math.log(q / (1 - q));
}

/** pa_model.pa_features, column order = params.features. */
export function paFeatures(
  rb: Vec, rp: Vec, pk: Vec, L: Vec,
  ctx: { same: number; left: number; home: number; reliever: number; tto: number },
): number[] {
  const lL = L.map(logit);
  const tto = Number.isFinite(ctx.tto) ? ctx.tto : 1;
  return [
    ...rb.map((v, c) => logit(v) - lL[c]),
    ...rp.map((v, c) => logit(v) - lL[c]),
    ...pk.map((v) => Math.log(Math.min(Math.max(v, 0.2), 5.0))),
    ...lL,
    ctx.same, ctx.left, ctx.home, ctx.reliever,
    tto === 2 ? 1 : 0, tto >= 3 ? 1 : 0,
  ];
}

export function paDist(
  pa: Params, rb: Vec, rp: Vec, pk: Vec, L: Vec,
  ctx: { same: number; left: number; home: number; reliever: number; tto: number },
): Vec {
  const x = paFeatures(rb, rp, pk, L, ctx);
  const z = (pa.coef as number[][]).map((row, k) => {
    let s = pa.intercept[k];
    for (let j = 0; j < x.length; j++) s += row[j] * x[j];
    return s;
  });
  const m = Math.max(...z);
  const e = z.map((v) => Math.exp(v - m));
  const t = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / t);
}

function hands(batSide: string, pitHand: string): [number, number] {
  return [batSide === pitHand && batSide !== "S" ? 1 : 0, pitHand === "L" ? 1 : 0];
}

// ── distributions ───────────────────────────────────────────────────────────

const LG: number[] = (() => {
  // lgamma at the integers 0..255, as derive._LG.
  const out = [0];
  let acc = 0; // lgamma(1) = 0
  out.push(0);
  for (let i = 2; i < 256; i++) { acc += Math.log(i - 1); out.push(acc); }
  return out;
})();

/** P(X = x) for X = round(mu + R), R from an empirical residual pmf. */
export function shiftPmf(mu: number, residual: Record<string, number>, lo: number, hi: number): Vec {
  const out = new Array(hi - lo + 1).fill(0);
  for (const [r, w] of Object.entries(residual)) {
    const x = Math.floor(mu + Number(r) + 0.5);
    out[Math.min(hi, Math.max(lo, x)) - lo] += Number(w);
  }
  const s = out.reduce((a, b) => a + b, 0);
  return s > 0 ? out.map((v) => v / s) : out;
}

export function vsStarterProb(slot: number, nPa: number, bfPmf: Vec): Vec {
  const sf = new Array(bfPmf.length + 1).fill(0);
  for (let b = bfPmf.length - 1; b >= 0; b--) sf[b] = sf[b + 1] + bfPmf[b];
  const out: number[] = [];
  for (let i = 1; i <= nPa; i++) {
    const b = slot + 9 * (i - 1);
    out.push(b < sf.length ? sf[b] : 0);
  }
  return out;
}

function pAtLeastOne(perPa: Vec, paPmf: Vec): number {
  let none = 1, out = 0;
  for (let k = 0; k < paPmf.length; k++) {
    if (k > 0) none *= 1 - perPa[k - 1];
    out += paPmf[k] * (1 - none);
  }
  return out;
}

function pTotalBases2(dists: Vec[], paPmf: Vec): number {
  let state = [1, 0, 0];
  let out = 0;
  for (let i = 1; i < paPmf.length; i++) {
    const d = dists[i - 1];
    const nxt = [0, 0, 0];
    for (let have = 0; have < 3; have++) {
      if (state[have] === 0) continue;
      for (let c = 0; c < NC; c++) nxt[Math.min(2, have + TB_OF[c])] += state[have] * d[c];
    }
    state = nxt;
    out += paPmf[i] * state[2];
  }
  return out;
}

export interface Structural {
  hit: number; hr: number; tb2: number;
  e_hits: number; e_tb: number; e_pa: number; e_onbase: number;
}

export function batterStructural(dists: Vec[], paPmf: Vec): Structural {
  const k = paPmf.length;
  const surv: number[] = [];                // P(N >= i), i = 1..k-1
  let acc = 0;
  const tail = new Array(k).fill(0);
  for (let i = k - 1; i >= 0; i--) { acc += paPmf[i]; tail[i] = acc; }
  for (let i = 1; i < k; i++) surv.push(tail[i]);
  const hit = dists.map((d) => d[2] + d[3] + d[4] + d[5]);
  const hr = dists.map((d) => d[HR]);
  let eHits = 0, eTb = 0, eOn = 0;
  for (let i = 0; i < k - 1; i++) {
    eHits += surv[i] * hit[i];
    eTb += surv[i] * dists[i].reduce((a, v, c) => a + v * TB_OF[c], 0);
    eOn += surv[i] * (1 - dists[i][K] - dists[i][OUT]);
  }
  return {
    hit: pAtLeastOne(hit, paPmf), hr: pAtLeastOne(hr, paPmf),
    tb2: pTotalBases2(dists, paPmf),
    e_hits: eHits, e_tb: eTb, e_onbase: eOn,
    e_pa: paPmf.reduce((a, v, i) => a + v * i, 0),
  };
}

function binomRow(n: number, p: number, nMax: number): Vec {
  const q = Math.min(Math.max(p, 1e-12), 1 - 1e-12);
  const out = new Array(nMax + 1).fill(0);
  for (let k = 0; k <= Math.min(n, nMax); k++) {
    out[k] = Math.exp(LG[n + 1] - LG[k + 1] - LG[n - k + 1] + k * Math.log(q) + (n - k) * Math.log(1 - q));
  }
  return out;
}

function negbinFailuresRow(o: number, pOut: number, nMax: number): Vec {
  const out = new Array(nMax + 1).fill(0);
  if (o === 0) { out[0] = 1; return out; }
  const p = Math.min(Math.max(pOut, 1e-9), 1 - 1e-12);
  for (let f = 0; f <= nMax; f++) {
    out[f] = Math.exp(LG[f + o] - LG[f + 1] - LG[o] + o * Math.log(p) + f * Math.log(1 - p));
  }
  return out;
}

/** derive.starter_counts: K, BB, H and BF pmfs given an outs pmf. */
export function starterCounts(pAvg: Vec, outsPmf: Vec, nMax = 30): Record<string, Vec> {
  const pk = pAvg[K], pout = pAvg[OUT], pO = pk + pout;
  const ph = pAvg[2] + pAvg[3] + pAvg[4] + pAvg[5], pbb = pAvg[BB];
  const k = new Array(nMax + 1).fill(0);
  const fMarg = new Array(nMax + 1).fill(0);
  const bf = new Array(MAX_BF + 1).fill(0);
  for (let o = 0; o < outsPmf.length; o++) {
    const w = outsPmf[o];
    const kb = binomRow(o, pk / pO, nMax);
    const nb = negbinFailuresRow(o, pO, nMax);
    for (let j = 0; j <= nMax; j++) {
      k[j] += w * kb[j];
      fMarg[j] += w * nb[j];
      bf[Math.min(MAX_BF, o + j)] += w * nb[j];
    }
  }
  const share = ph / Math.max(ph + pbb, 1e-12);
  const h = new Array(nMax + 1).fill(0);
  const bb = new Array(nMax + 1).fill(0);
  for (let f = 0; f <= nMax; f++) {
    if (!(fMarg[f] > 0)) continue;
    const hb = binomRow(f, share, nMax);
    for (let j = 0; j <= f; j++) {
      h[j] += fMarg[f] * hb[j];
      bb[j] += fMarg[f] * hb[f - j];
    }
  }
  return { k, h, bb, bf, outs: outsPmf.slice() };
}

export function overProb(pmf: Vec, line: number): number {
  let s = 0;
  for (let i = Math.floor(line) + 1; i < pmf.length; i++) s += pmf[i];
  return s;
}

/** The half-point line closest to an even split -- the model-fair line. */
export function medianLine(pmf: Vec): number {
  let best = Infinity, line = 0.5;
  for (let k = 0; k < pmf.length; k++) {
    const d = Math.abs(overProb(pmf, k + 0.5) - 0.5);
    if (d < best) { best = d; line = k + 0.5; }
  }
  return line;
}

export function negbinPmf(mu: number, alpha: number, nMax = 30): Vec {
  const m = Math.max(mu, 1e-6);
  const out = new Array(nMax + 1).fill(0);
  if (alpha < 1e-6) {
    for (let k = 0; k <= nMax; k++) out[k] = Math.exp(-m + k * Math.log(m) - LG[k + 1]);
    return out;
  }
  const r = 1 / alpha, p = r / (r + m);
  let v = Math.pow(p, r);
  for (let k = 0; k <= nMax; k++) { out[k] = v; v *= (k + r) / (k + 1) * (1 - p); }
  return out;
}

export function convolve(a: Vec, b: Vec): Vec {
  const out = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) out[i + j] += a[i] * b[j];
  return out;
}

export function homeWinProb(home: Vec, away: Vec, extraHome = 0.52): number {
  let cdf = 0, win = 0;
  const cdfAway: number[] = away.map((v) => (cdf += v));
  for (let h = 1; h < home.length; h++) win += home[h] * cdfAway[h - 1];
  let tie = 0;
  for (let i = 0; i < Math.min(home.length, away.length); i++) tie += home[i] * away[i];
  return win + tie * extraHome;
}

/** sigmoid(a + b logit(p) + sum w_j x_j); identity without a calibrator. */
export function calibrate(p: number, cal: Params | undefined, x?: Record<string, number>): number {
  if (!cal) return p;
  let z = cal.a + cal.b * logit(p);
  for (const [name, w] of Object.entries(cal.w ?? {})) z += Number(w) * (x?.[name] ?? 0);
  return 1 / (1 + Math.exp(-z));
}

// ── per-entity scoring (modeling/serve.py) ──────────────────────────────────

export interface WorkloadInputs {
  own_outs: number | null; pitches: number | null; team_leash: number | null;
  rest_days: number | null; rp: Vec; L: Vec;
}

export function workload(b: Bundle, w: WorkloadInputs): { outs: Vec; bf: Vec; mu_outs: number } {
  const wl = b.workload!;
  const pri = wl.workload_priors;
  const restRaw = w.rest_days == null ? 60 : w.rest_days;
  const f: Record<string, number> = {
    own_mean: w.own_outs ?? pri.p_outs.prior,
    team_leash: w.team_leash ?? wl.team_leash.prior,
    pitches_mean: w.pitches ?? pri.p_pitches.prior,
    rest: Math.min(Math.max(restRaw, 0), 15),
    first_start: restRaw > 30 ? 1 : 0,
    quality: (w.rp[0] + w.rp[6]) - (w.L[0] + w.L[6]),
  };
  const mu = (m: Params) =>
    (m.features as string[]).reduce((a, n, i) => a + m.coef[i] * f[n], m.intercept);
  const mo = mu(wl.outs);
  return {
    outs: shiftPmf(mo, wl.outs.residual_pmf, 0, MAX_OUTS),
    bf: shiftPmf(mu(wl.bf), wl.bf.residual_pmf, 0, MAX_BF),
    mu_outs: mo,
  };
}

export interface BatterInputs {
  rb: Vec; bat_side: string; slot: number; is_home: boolean;
  sp_r: Vec; sp_hand: string; pen_r: Vec; pk: Vec; L: Vec; bf_pmf: Vec;
}

export function batterDists(b: Bundle, x: BatterInputs): Vec[] {
  const pa = b.pa_outcome!;
  const leftShare = Number(b.workload!.pen_left_share);
  const [same, left] = hands(x.bat_side, x.sp_hand);
  const home = x.is_home ? 1 : 0;
  const ps = [1, 2, 3].map((t) =>
    paDist(pa, x.rb, x.sp_r, x.pk, x.L, { same, left, home, reliever: 0, tto: t }));
  const penSame = x.bat_side === "S" ? 0 : x.bat_side === "L" ? leftShare : 1 - leftShare;
  const pp = paDist(pa, x.rb, x.pen_r, x.pk, x.L,
    { same: penSame, left: leftShare, home, reliever: 1, tto: 1 });
  const q = vsStarterProb(x.slot, MAX_PA, x.bf_pmf);
  return q.map((qi, i) => ps[Math.min(i, 2)].map((v, c) => qi * v + (1 - qi) * pp[c]));
}

export function paPmf(b: Bundle, slot: number, isHome: boolean): Vec {
  const t = b.workload!.pa_pmf;
  return (t[`${slot}${isHome ? "H" : "A"}`] ?? t[`${slot}H`]).map(Number);
}

export function batterValue(dists: Vec[], pmf: Vec): number {
  let acc = 0, v = 0;
  const tail = new Array(pmf.length).fill(0);
  for (let i = pmf.length - 1; i >= 0; i--) { acc += pmf[i]; tail[i] = acc; }
  for (let i = 1; i < pmf.length; i++) {
    v += tail[i] * dists[i - 1].reduce((a, p, c) => a + p * RUN_WEIGHTS[c], 0);
  }
  return v;
}

export interface BatterMarketProbs {
  batter_hit: number; batter_hr: number; batter_tb15: number; batter_hrr: number;
  structural: Structural;
}

export function batterMarkets(
  b: Bundle, dists: Vec[], pmf: Vec, slot: number, teamValue: number,
): BatterMarketProbs {
  const s = batterStructural(dists, pmf);
  const pick: Array<[string, keyof Structural]> = [
    ["batter_hit", "hit"], ["batter_hr", "hr"], ["batter_tb15", "tb2"], ["batter_hrr", "hit"],
  ];
  const probs: Record<string, number> = {};
  for (const [mkt, key] of pick) {
    const x = mkt === "batter_hrr"
      ? { e_onbase: s.e_onbase, top_order: slot <= 5 ? 1 : 0,
          log_team_value: Math.log(Math.max(teamValue, 1e-3)) }
      : undefined;
    probs[mkt] = calibrate(s[key], b[mkt]?.cal, x);
  }
  return {
    batter_hit: probs.batter_hit, batter_hr: probs.batter_hr,
    batter_tb15: probs.batter_tb15, batter_hrr: probs.batter_hrr, structural: s,
  };
}

export interface StarterProp { line: number; p_over: number; expected: number }

export function starterMarkets(
  b: Bundle,
  x: { sp_r: Vec; sp_hand: string; lineup: Array<[Vec, string]>; batting_home: boolean;
       pk: Vec; L: Vec; outs_pmf: Vec; bf_pmf: Vec },
): Record<string, StarterProp> {
  const pa = b.pa_outcome!;
  const home = x.batting_home ? 1 : 0;
  const byTto = [1, 2, 3].map((t) => {
    const acc = new Array(NC).fill(0);
    for (const [rb, side] of x.lineup) {
      const [same, left] = hands(side, x.sp_hand);
      paDist(pa, rb, x.sp_r, x.pk, x.L, { same, left, home, reliever: 0, tto: t })
        .forEach((v, c) => acc[c] += v);
    }
    return acc.map((v) => v / x.lineup.length);
  });
  const w = [0, 0, 0];
  x.bf_pmf.forEach((p, bf) => {
    w[0] += p * Math.min(bf, 9);
    w[1] += p * Math.min(Math.max(bf - 9, 0), 9);
    w[2] += p * Math.max(bf - 18, 0);
  });
  const ws = Math.max(w[0] + w[1] + w[2], 1e-9);
  const pAvg = new Array(NC).fill(0).map((_, c) =>
    (w[0] * byTto[0][c] + w[1] * byTto[1][c] + w[2] * byTto[2][c]) / ws);
  const cnt = starterCounts(pAvg, x.outs_pmf);
  const eOuts = x.outs_pmf.reduce((a, v, i) => a + v * i, 0);
  const rpo = pAvg.reduce((a, v, c) => a + v * RUN_WEIGHTS[c], 0) / (pAvg[K] + pAvg[OUT]);
  const out: Record<string, StarterProp> = {};
  const markets: Array<[string, Vec | null]> = [
    ["pitcher_k", cnt.k], ["pitcher_bb", cnt.bb], ["pitcher_hits", cnt.h],
    ["pitcher_outs", cnt.outs], ["pitcher_er", null],
  ];
  for (const [mkt, pmf0] of markets) {
    const prm = b[mkt] ?? {};
    let pmf = pmf0;
    if (mkt === "pitcher_er") {
      const g = prm.er_glm;
      if (!g) continue;
      const z = g.intercept + g.coef[0] * Math.log(Math.max(eOuts, 1)) +
        g.coef[1] * Math.log(Math.max(rpo, 1e-3));
      pmf = negbinPmf(Math.exp(z), g.alpha, 30);
    }
    const line = medianLine(pmf!);
    out[mkt] = {
      line,
      p_over: calibrate(overProb(pmf!, line), prm.cal),
      expected: pmf!.reduce((a, v, i) => a + v * i, 0),
    };
  }
  return out;
}

export function teamMu(
  b: Bundle, x: { value: number; is_home: boolean; temp_c: number; wind_out: number },
): number {
  const m = b.team_runs!;
  const f: Record<string, number> = {
    log_value: Math.log(Math.max(x.value, 1e-3)), home: x.is_home ? 1 : 0,
    temp_c: x.temp_c, wind_out: x.wind_out,
  };
  return Math.exp((m.features as string[]).reduce((a, n, i) => a + m.coef[i] * f[n], m.intercept));
}

export function gameMarkets(b: Bundle, muHome: number, muAway: number) {
  const m = b.team_runs!;
  const h = negbinPmf(muHome, m.alpha, 30), a = negbinPmf(muAway, m.alpha, 30);
  const pHome = calibrate(homeWinProb(h, a, m.extra_home), b.game_moneyline?.cal);
  const tot = convolve(h, a);
  const line = medianLine(tot);
  return { p_home: pHome, total_line: line, p_over: overProb(tot, line), mu_total: muHome + muAway };
}

// ── weather, as modeling/games.py ───────────────────────────────────────────

export function windOut(mph: number | null, dir: string | null, roofClosed: boolean): number {
  if (roofClosed || mph == null || !Number.isFinite(mph)) return 0;
  const d = String(dir ?? "").toLowerCase();
  const f = d.startsWith("out to cf") ? 1 : d.startsWith("out to") ? 0.7
    : d.startsWith("in from cf") ? -1 : d.startsWith("in from") ? -0.7 : 0;
  return mph * f;
}

export function tempC(temp: number | null, roofClosed: boolean): number {
  return roofClosed || temp == null || !Number.isFinite(temp) ? 0 : temp - 70;
}
