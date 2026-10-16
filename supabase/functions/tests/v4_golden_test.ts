// Guards tests/fixtures/v4_trees_golden.json -- the contract between
// _shared/v4.ts and modeling/v4/export.py::score. The fixture is written by
// Python from real fitted learners (tests/modeling/test_v4_golden.py);
// this side must reproduce every row to 1e-9.

import { assert } from "jsr:@std/assert@1";
import { scoreSpec, type V4Spec } from "../_shared/v4.ts";

const PATH = new URL("../../../tests/fixtures/v4_trees_golden.json", import.meta.url);
const TOL = 1e-9;

Deno.test("v4 exported models score identically in TypeScript", async () => {
  const { cases } = JSON.parse(await Deno.readTextFile(PATH));
  assert(cases.length >= 9, "fixture holds every learner kind");
  let worst = 0;
  for (const c of cases) {
    const spec = c.spec as V4Spec;
    c.rows.forEach((row: Record<string, number | null>, i: number) => {
      const got = scoreSpec(spec, row);
      const want = c.expected[i];
      const g = Array.isArray(got) ? got : [got];
      const w = Array.isArray(want) ? want : [want];
      assert(g.length === w.length, `${spec.market}: shape ${g.length} vs ${w.length}`);
      for (let k = 0; k < g.length; k += 1) {
        const d = Math.abs(g[k] - w[k]);
        worst = Math.max(worst, d);
        assert(d <= TOL, `${spec.market} (${spec.kind}) row ${i} [${k}]: ${g[k]} vs ${w[k]}`);
      }
    });
  }
  console.log(`worst abs diff ${worst}`);
});
