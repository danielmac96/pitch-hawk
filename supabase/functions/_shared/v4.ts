// v4 serving: one exported model per in-game market, scored here.
//
// The TypeScript twin of modeling/v4/export.py::score. The Python learners
// are exported to JSON (gradient-boosted trees or a GLM, plus the market's
// post-processing and calibrator); this file evaluates that JSON.
// tests/fixtures/v4_trees_golden.json, written by
// tests/modeling/test_v4_golden.py from real fitted learners, pins this file
// to the Python at 1e-9 (supabase/functions/tests/v4_golden_test.ts).
//
// Inputs are rounded to float32 before scoring, because the learners see
// float32 features: a tree threshold sits between two float32 values, and a
// float64 input can fall on the other side of it.
//
// Exported models live in `v4_models` (one row per market + version), not in
// model_params.params: loadActiveModels() reads every active params blob on
// every 15-second poll, and a tree ensemble is hundreds of kilobytes.
// The active model_params row for a v4 market carries {type: "v4",
// serving: "trees" | "offline", fallback: <previous params>}.

import { svc } from "./db.ts";

export type V4Kind = "binary" | "multiclass" | "count" | "gaussian";

interface Tree { f: number[]; t: number[]; l: number[]; r: number[]; m: number[]; v: number[] }
interface HgbNode { op: "hgb"; trees: Tree[][]; baseline: number[]; link: string }
interface GlmNode {
  op: "glm"; coef: number[][]; intercept: number[]; median: number[];
  mean: number[]; scale: number[]; link: string;
}
type Node = HgbNode | GlmNode;

export interface V4Spec {
  kind: V4Kind;
  market: string;
  features: string[];
  classes: string[];
  cap: number;
  line: number | null;
  model: Node;
  post: Record<string, any> | null;
  calibrator: Record<string, number> | null;
}

/** P(class), a count pmf, P(y=1), or [mu, sigma]. */
export type V4Output = number[] | number;

// ── evaluation ──────────────────────────────────────────────────────────────

function rawHgb(node: HgbNode, x: number[]): number[] {
  const out = node.baseline.slice();
  for (const it of node.trees) {
    for (let k = 0; k < it.length; k += 1) {
      const t = it[k];
      let j = 0;
      while (t.f[j] >= 0) {
        const v = x[t.f[j]];
        if (v !== v) j = t.m[j] ? t.l[j] : t.r[j];
        else if (v <= t.t[j]) j = t.l[j];
        else j = t.r[j];
      }
      out[k] += t.v[j];
    }
  }
  return out;
}

function rawGlm(node: GlmNode, x: number[]): number[] {
  const z = x.map((v, j) => ((v !== v ? node.median[j] : v) - node.mean[j]) / node.scale[j]);
  return node.coef.map((row, k) => {
    let s = 0;
    for (let j = 0; j < row.length; j += 1) s += z[j] * row[j];
    return s + node.intercept[k];
  });
}

function link(node: Node, raw: number[]): number | number[] {
  switch (node.link) {
    case "sigmoid": return 1 / (1 + Math.exp(-raw[0]));
    case "softmax": {
      const m = Math.max(...raw);
      const e = raw.map((v) => Math.exp(v - m));
      const s = e.reduce((a, b) => a + b, 0);
      return e.map((v) => v / s);
    }
    case "exp": return Math.exp(raw[0]);
    default: return raw[0];
  }
}

function evalNode(node: Node, x: number[]): number | number[] {
  return link(node, node.op === "hgb" ? rawHgb(node, x) : rawGlm(node as GlmNode, x));
}

/** modeling/v4/learners.nb_pmf: NB2 recurrence (= props.ts negbinPmf), tail last. */
export function nbPmf(mu: number, alpha: number, cap: number): number[] {
  const m = Math.max(mu, 1e-6);
  const body = new Array(cap).fill(0);
  if (alpha < 1e-6) {
    // lgamma(k + 1) = log(k!), accumulated; agrees with math.lgamma to ~1e-14.
    let lg = 0;
    for (let k = 0; k < cap; k += 1) {
      if (k > 0) lg += Math.log(k);
      body[k] = Math.exp(-m + k * Math.log(m) - lg);
    }
  } else {
    const r = 1 / alpha, p = r / (r + m);
    let v = Math.pow(p, r);
    for (let k = 0; k < cap; k += 1) { body[k] = v; v = v * ((k + r) / (k + 1) * (1 - p)); }
  }
  const tail = Math.min(Math.max(1 - body.reduce((a, b) => a + b, 0), 0), 1);
  return [...body, tail];
}

/** Score one row. `values` maps feature name -> number (null/undefined = missing). */
export function scoreSpec(spec: V4Spec, values: Record<string, number | null | undefined>): V4Output {
  const x = spec.features.map((f) => {
    const v = values[f];
    return v == null || !Number.isFinite(v) ? NaN : Math.fround(v);
  });
  let out = evalNode(spec.model, x);
  const post = spec.post;
  if (post && (post.op === "classes" || post.op === "count_classes")) {
    const K = post.op === "classes" ? spec.classes.length : spec.cap + 1;
    const floor = post.op === "classes" ? 1e-6 : 1e-5;
    const full = new Array(K).fill(floor);
    (post.classes as number[]).forEach((c, i) => { full[c] = (out as number[])[i]; });
    const s = full.reduce((a, b) => a + b, 0);
    out = full.map((v) => v / s);
  } else if (post && post.op === "nb") {
    out = nbPmf(out as number, post.alpha, spec.cap);
  } else if (post && post.op === "gauss") {
    const sd = Math.sqrt(Math.exp(evalNode(post.var as Node, x) as number)) * post.scale;
    out = [out as number, Math.min(Math.max(sd, post.lo), post.hi)];
  } else if (post && post.op === "const_sigma") {
    out = [out as number, post.sigma];
  }
  const c = spec.calibrator;
  if (c) {
    if ("a" in c) {
      const p = Math.min(Math.max(out as number, 1e-6), 1 - 1e-6);
      out = 1 / (1 + Math.exp(-(c.a + c.b * Math.log(p / (1 - p)))));
    } else if ("sigma_scale" in c) {
      const o = out as number[];
      out = [o[0], o[1] * c.sigma_scale];
    } else {
      const q = (out as number[]).map((v) => Math.exp(Math.log(Math.min(Math.max(v, 1e-9), 1)) / c.temperature));
      const s = q.reduce((a, b) => a + b, 0);
      out = q.map((v) => v / s);
    }
  }
  return out;
}

// ── loading ─────────────────────────────────────────────────────────────────

const cache = new Map<string, V4Spec>();

/** True when this active model_params row is a v4 model scored here. */
export function isV4Trees(row: any): boolean {
  return row?.type === "v4" && row?.serving === "trees";
}

/** True for any v4 row (offline-published or scored here). */
export function isV4(row: any): boolean {
  return row?.type === "v4";
}

/**
 * The exported model for each active v4 market scored here, cached per
 * version for the life of the isolate. Missing or failing -> absent, and the
 * caller falls back to the row's `fallback` params.
 */
export async function loadV4Specs(models: Record<string, any>): Promise<Record<string, V4Spec>> {
  const want = Object.entries(models).filter(([, r]) => isV4Trees(r))
    .map(([market, r]) => ({ market, version: String(r.version) }));
  const out: Record<string, V4Spec> = {};
  const missing = want.filter((w) => {
    const hit = cache.get(`${w.market}@${w.version}`);
    if (hit) out[w.market] = hit;
    return !hit;
  });
  if (!missing.length) return out;
  const { data } = await svc().from("v4_models").select("market,version,spec")
    .in("market", missing.map((m) => m.market));
  for (const row of data ?? []) {
    const w = missing.find((m) => m.market === row.market && m.version === row.version);
    if (!w || !row.spec) continue;
    cache.set(`${w.market}@${w.version}`, row.spec as V4Spec);
    out[w.market] = row.spec as V4Spec;
  }
  return out;
}

/** Active models with every v4 row replaced by the params it superseded. */
export function legacyModels(models: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [m, r] of Object.entries(models)) {
    if (!isV4(r)) { out[m] = r; continue; }
    if (r.fallback) out[m] = { ...r.fallback, version: r.fallback_version ?? r.fallback.version };
  }
  return out;
}

// ── market helpers ──────────────────────────────────────────────────────────

/** P(X > line) from a pmf whose last bucket is "cap or more". */
export function pmfOver(pmf: number[], line: number): number {
  let s = 0;
  for (let k = Math.floor(line) + 1; k < pmf.length; k += 1) s += pmf[k];
  return s;
}

/** A pmf over runs still to come as one over the final total: `now` runs
 * already scored move every mass point up (nothing is truncated). */
export function shiftPmf(pmf: number[], now: number): number[] {
  const n = Math.max(0, Math.round(now));
  return [...new Array(n).fill(0), ...pmf];
}

export function pmfMean(pmf: number[]): number {
  return pmf.reduce((a, p, k) => a + p * k, 0);
}

/** Standard normal CDF (Abramowitz-Stegun 26.2.17), for P(speed > line). */
export function normCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 +
    t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

// ── as MarketPrediction, for the existing writers ──────────────────────────

export interface V4Prediction {
  market: string;
  predicted_value: number | null;
  confidence: number | null;
  probs: Record<string, number> | null;
  model_version: string;
  sample_size: number;
}

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

/** pitch_result / ab_result: class probabilities keyed like the v2 rows. */
export function v4Classes(spec: V4Spec, version: string, feats: Record<string, number | null>): V4Prediction {
  const p = scoreSpec(spec, feats) as number[];
  const probs: Record<string, number> = {};
  spec.classes.forEach((c, i) => { probs[c] = r4(p[i]); });
  const top = Math.max(...p);
  return { market: spec.market, predicted_value: r4(top), confidence: r4(top), probs,
           model_version: version, sample_size: 0 };
}

/** pitch_speed_ou: mean and sigma, and P(speed > line) from N(mu, sigma). */
export function v4Speed(spec: V4Spec, version: string, feats: Record<string, number | null>) {
  const [mu, sigma] = scoreSpec(spec, feats) as number[];
  return {
    pred: { market: spec.market, predicted_value: Math.round(mu * 100) / 100, confidence: null,
            probs: { sigma: r4(sigma) }, model_version: version, sample_size: 0 } as V4Prediction,
    overProb: (line: number) => 1 - normCdf((line - mu) / sigma),
  };
}

/** ab_pitches_ou at position k: total = k + remaining, remaining ~ the pmf. */
export function v4AbPitches(spec: V4Spec, version: string, feats: Record<string, number | null>, k: number) {
  const pmf = scoreSpec(spec, feats) as number[];
  return {
    pred: { market: spec.market, predicted_value: Math.round((k + pmfMean(pmf)) * 100) / 100,
            confidence: null, probs: null, model_version: version, sample_size: 0 } as V4Prediction,
    overProb: (line: number) => pmfOver(pmf, line - k),
  };
}
