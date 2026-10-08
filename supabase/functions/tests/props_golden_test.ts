// Guards tests/fixtures/props_golden.json -- the contract between props.ts and
// modeling/serve.py (tests/modeling/test_props_parity.py).
//
// Verifies by default; regenerate after an intentional change to props.ts:
//
//   UPDATE_GOLDEN=1 deno test --allow-write --allow-read --allow-env \
//     supabase/functions/tests/props_golden_test.ts
//
// The bundle and inputs are deterministic pseudo-random (a fixed LCG), so the
// fixture exercises every coefficient and every branch without anyone having
// to hand-write a 7x34 coefficient matrix.

import { assert } from "jsr:@std/assert@1";
import {
  batterDists, batterMarkets, batterValue, type Bundle, gameMarkets, paDist,
  paPmf, starterMarkets, teamMu, workload,
} from "../_shared/props.ts";

const PATH = new URL("../../../tests/fixtures/props_golden.json", import.meta.url);
const TOL = 1e-9;

let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const round = (v: number, d = 6) => Math.round(v * 10 ** d) / 10 ** d;
const BASE = [0.22, 0.085, 0.14, 0.045, 0.004, 0.031, 0.475];
const rate = (spread: number) => {
  const r = BASE.map((b) => b * Math.exp((rnd() - 0.5) * spread));
  const s = r.reduce((a, v) => a + v, 0);
  return r.map((v) => round(v / s, 8));
};

function bundle(): Bundle {
  const nf = 33;
  const coef = Array.from({ length: 7 }, (_, k) =>
    Array.from({ length: nf }, (_, j) => k === 6 ? 0 : round((j % 7 === k ? 0.9 : 0.06) * (rnd() - 0.3), 6)));
  const residual = (lo: number, hi: number) => {
    const o: Record<string, number> = {};
    let s = 0;
    for (let r = lo; r <= hi; r++) { o[String(r)] = Math.exp(-0.5 * (r / 3.2) ** 2); s += o[String(r)]; }
    for (const k in o) o[k] = round(o[k] / s, 6);
    return o;
  };
  const paPmfTable: Record<string, number[]> = {};
  for (let slot = 1; slot <= 9; slot++) {
    for (const side of ["H", "A"]) {
      const m = 4.6 - 0.12 * slot - (side === "H" ? 0.1 : 0);
      const p = Array.from({ length: 9 }, (_, k) => Math.exp(-0.5 * ((k - m) / 0.7) ** 2));
      const s = p.reduce((a, v) => a + v, 0);
      paPmfTable[`${slot}${side}`] = p.map((v) => round(v / s, 6));
    }
  }
  const feats = ["own_mean", "team_leash", "pitches_mean", "rest", "first_start", "quality"];
  return {
    pa_outcome: { coef, intercept: [0.4, -1.1, -1.2, -2.3, -4.6, -2.7, 0].map((v) => round(v, 6)) },
    workload: {
      pen_left_share: 0.31,
      workload_priors: { p_outs: { prior: 16 }, p_bf: { prior: 23 }, p_pitches: { prior: 88 } },
      team_leash: { prior: 16 },
      outs: { features: feats, coef: [0.55, 0.3, 0.02, 0.05, -1.2, 9.0], intercept: 1.5, residual_pmf: residual(-12, 8) },
      bf: { features: feats, coef: [0.7, 0.35, 0.03, 0.06, -1.5, 4.0], intercept: 2.0, residual_pmf: residual(-14, 9) },
      pa_pmf: paPmfTable,
    },
    batter_hit: { cal: { a: -0.05, b: 0.93 } },
    batter_hr: { cal: { a: -0.12, b: 0.88 } },
    batter_tb15: { cal: { a: 0.02, b: 0.97 } },
    batter_hrr: { cal: { a: -0.3, b: 0.8, w: { e_onbase: 0.25, top_order: 0.1, log_team_value: 0.2 } } },
    pitcher_k: { cal: { a: 0.01, b: 0.95 } },
    pitcher_bb: { cal: { a: -0.02, b: 0.9 } },
    pitcher_hits: { cal: { a: 0.0, b: 0.97 } },
    pitcher_outs: { cal: { a: 0.03, b: 0.92 } },
    pitcher_er: { cal: { a: -0.04, b: 0.9 }, er_glm: { intercept: -1.1, coef: [0.95, 0.85], alpha: 0.18 } },
    team_runs: { features: ["log_value", "home", "temp_c", "wind_out"], coef: [0.95, 0.03, 0.004, 0.006], intercept: -1.0, alpha: 0.12, extra_home: 0.52 },
    game_moneyline: { cal: { a: 0.02, b: 0.96 } },
  };
}

function compute() {
  const b = bundle();
  const L = rate(0.0);
  const cases: Record<string, unknown>[] = [];
  for (let i = 0; i < 6; i++) {
    const spR = rate(0.6), penR = rate(0.3), pk = rate(0.0).map(() => round(0.9 + 0.2 * rnd(), 6));
    const wlIn = { own_outs: i === 0 ? null : round(12 + 8 * rnd(), 4),
                   pitches: i === 1 ? null : round(70 + 30 * rnd(), 4),
                   team_leash: round(14 + 4 * rnd(), 4),
                   rest_days: i === 2 ? null : Math.floor(3 + 40 * rnd()), rp: spR, L };
    const wl = workload(b, wlIn);
    const spHand = rnd() < 0.3 ? "L" : "R";
    const lineup: Array<[number[], string]> = Array.from({ length: 9 }, () =>
      [rate(0.7), ["L", "R", "S"][Math.floor(rnd() * 3)]]);
    const isHome = i % 2 === 0;
    const batters = lineup.map(([rb, side], s) => {
      const x = { rb, bat_side: side, slot: s + 1, is_home: isHome, sp_r: spR, sp_hand: spHand,
                  pen_r: penR, pk, L, bf_pmf: wl.bf };
      const d = batterDists(b, x);
      const pmf = paPmf(b, s + 1, isHome);
      return { d, pmf, value: batterValue(d, pmf) };
    });
    const teamValue = batters.reduce((a, v) => a + v.value, 0);
    const bm = batterMarkets(b, batters[2].d, batters[2].pmf, 3, teamValue);
    const sm = starterMarkets(b, { sp_r: spR, sp_hand: spHand, lineup, batting_home: isHome, pk, L,
                                   outs_pmf: wl.outs, bf_pmf: wl.bf });
    const muH = teamMu(b, { value: teamValue, is_home: true, temp_c: 10 * (rnd() - 0.5), wind_out: 6 * (rnd() - 0.5) });
    const muA = teamMu(b, { value: teamValue * (0.9 + 0.2 * rnd()), is_home: false, temp_c: 0, wind_out: 0 });
    const gm = gameMarkets(b, muH, muA);
    const one = paDist(b.pa_outcome!, lineup[0][0], spR, pk, L, { same: 1, left: 0, home: 1, reliever: 0, tto: 2 });
    cases.push({
      inputs: { L, sp_r: spR, pen_r: penR, pk, workload: wlIn, sp_hand: spHand, lineup, is_home: isHome,
                mu_inputs: [muH, muA] },
      outputs: { pa_dist: one, outs_pmf: wl.outs, bf_pmf: wl.bf, team_value: teamValue,
                 batter3: { hit: bm.batter_hit, hr: bm.batter_hr, tb15: bm.batter_tb15, hrr: bm.batter_hrr },
                 starter: sm, mu_home: muH, mu_away: muA, game: gm },
    });
  }
  return { bundle: b, cases };
}

Deno.test("props.ts golden fixtures", async () => {
  const fresh = compute();
  if (Deno.env.get("UPDATE_GOLDEN")) {
    await Deno.writeTextFile(PATH, JSON.stringify(fresh, null, 1) + "\n");
    return;
  }
  const stored = JSON.parse(await Deno.readTextFile(PATH));
  const walk = (a: unknown, b: unknown, path: string) => {
    if (typeof a === "number") {
      assert(Math.abs(a - (b as number)) <= TOL, `${path}: ${a} vs ${b}`);
    } else if (Array.isArray(a)) {
      a.forEach((v, i) => walk(v, (b as unknown[])[i], `${path}[${i}]`));
    } else if (a && typeof a === "object") {
      for (const k of Object.keys(a)) walk((a as any)[k], (b as any)[k], `${path}.${k}`);
    }
  };
  walk(fresh, stored, "$");
});
