// Line ladders (props.ts ladder / batterCountPmf, basemodels.ts
// poissonLadder / binomLadder): every half-point line of a count
// distribution, which the board reads to show 2+ hits, 7+ Ks, outs 17.5...
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import {
  batterCountPmf, batterLadders, batterStructural, COUNT_OF, ladder, negbinPmf, overProb,
} from "../_shared/props.ts";
import { binomLadder, gradeBase, poissonLadder, poissonOver } from "../_shared/basemodels.ts";

const D = [0.22, 0.085, 0.14, 0.045, 0.004, 0.031, 0.475];
const dists = Array.from({ length: 8 }, () => D.slice());
const paPmf = [0, 0, 0.05, 0.25, 0.45, 0.22, 0.03, 0, 0];

const nonIncreasing = (l: { p_over: number }[]) => l.every((r, i) => i === 0 || r.p_over <= l[i - 1].p_over);

Deno.test("batterCountPmf is a distribution and P(>=1) matches the structural roll-up", () => {
  const s = batterStructural(dists, paPmf);
  for (const [key, want] of [["hits", s.hit], ["hr", s.hr]] as const) {
    const pmf = batterCountPmf(dists, paPmf, COUNT_OF[key]);
    assertAlmostEquals(pmf.reduce((a, v) => a + v, 0), 1, 1e-12);
    assertAlmostEquals(overProb(pmf, 0.5), want, 1e-12);
  }
  assertAlmostEquals(overProb(batterCountPmf(dists, paPmf, COUNT_OF.tb), 1.5), s.tb2, 1e-12);
});

Deno.test("ladder: consecutive half-point lines, non-increasing, only lines still in doubt", () => {
  const l = ladder(negbinPmf(5.2, 0.1, 30));
  assert(l.every((r, i) => i === 0 || r.line === l[i - 1].line + 1));
  assert(nonIncreasing(l));
  assert(l.every((r) => r.p_over >= 0.005 - 1e-12 && r.p_over <= 0.995 + 1e-12));
});

Deno.test("ladder: a high-mean count (outs) reaches the lines around its median", () => {
  const pmf = negbinPmf(16.8, 0.02, 60);
  const l = ladder(pmf, undefined, 0.005, 16);
  assert(l.some((r) => r.line === 16.5), JSON.stringify(l.map((r) => r.line)));
  assert(l[0].line > 0.5);
});

Deno.test("ladder: a calibrator is applied per rung and keeps the ladder ordered", () => {
  const pmf = negbinPmf(4.4, 0.05, 30);
  const cal = { a: 0.1, b: 0.9 };
  const raw = ladder(pmf), c = ladder(pmf, cal);
  assert(nonIncreasing(c));
  assert(c.some((r, i) => Math.abs(r.p_over - raw[i].p_over) > 1e-6));
});

Deno.test("batterLadders: the 1+ rung of hit and HR equals the calibrated structural read", () => {
  const b = { batter_hit: { cal: { a: -0.05, b: 0.93 } }, batter_hr: { cal: { a: -0.1, b: 0.9 } } };
  const { ladders, e_k } = batterLadders(b, dists, paPmf);
  const s = batterStructural(dists, paPmf);
  const cal = (p: number, c: { a: number; b: number }) => 1 / (1 + Math.exp(-(c.a + c.b * Math.log(p / (1 - p)))));
  assertAlmostEquals(ladders.batter_hit[0].p_over, cal(s.hit, b.batter_hit.cal), 1e-12);
  assertAlmostEquals(ladders.batter_hr[0].p_over, cal(s.hr, b.batter_hr.cal), 1e-12);
  assert(ladders.batter_k.length >= 2 && e_k > 0.5 && e_k < 2);
});

Deno.test("poissonLadder matches poissonOver at every line", () => {
  const l = poissonLadder(5.7);
  l.forEach((r) => assertAlmostEquals(r.p_over, Math.round(poissonOver(r.line, 5.7) * 1e4) / 1e4, 1e-9));
  assert(nonIncreasing(l));
});

Deno.test("binomLadder: 1+ rung is 1-(1-p)^n mixed over fractional PAs", () => {
  const l = binomLadder(0.25, 4.5);
  const want = 0.5 * (1 - 0.75 ** 4) + 0.5 * (1 - 0.75 ** 5);
  assertAlmostEquals(l[0].p_over, Math.round(want * 1e4) / 1e4, 1e-9);
  assert(nonIncreasing(l));
});

Deno.test("gradeBase batter_k: strikeouts over the line, void without a PA", () => {
  assertEquals(gradeBase("batter_k", 0.5, { pa: 4, so: 2 }).result, "hit");
  assertEquals(gradeBase("batter_k", 1.5, { pa: 4, so: 1 }).result, "miss");
  assertEquals(gradeBase("batter_k", 0.5, { pa: 0, so: 0 }).result, "void");
  assertEquals(gradeBase("batter_k", 0.5, { pa: 4, so: 2 }).actual_count, 2);
});
