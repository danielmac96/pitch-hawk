// Guards tests/fixtures/scorer_golden.json -- the contract between model.ts and
// modeling/score.py.
//
// By default this VERIFIES that the committed fixtures still match what
// model.ts computes, and fails if they do not. To regenerate after an
// intentional scoring change:
//
//   UPDATE_GOLDEN=1 deno test --allow-write --allow-read --allow-env \
//     supabase/functions/tests/scorer_golden_test.ts
//
// tests/modeling/test_parity.py asserts the Python reference scorer matches
// these outputs to 1e-9. Editing model.ts without regenerating turns CI red,
// which is the point. Probabilities are compared to GOLDEN_TOL rather than
// bit-for-bit -- see the note on that constant for why exact equality was the
// wrong contract.
//
// Two things the plan's sketch of this file got wrong about the real model.ts,
// both corrected here because the TypeScript is the production truth:
//
//   1. It scores through scoreMultinomial(params, ctx), not
//      predictPitchResult(ctx, params). predictPitchResult takes a *map* of
//      market -> params, and round4()s its output -- which would cap parity at
//      1e-4 and hide exactly the small numeric drift this test exists to find.
//   2. ScoreContext is not flat. featureValue() reads deltas out of nested
//      pitcher/batter rolling-stat rows and subtracts hardcoded league
//      constants (zone 0.48, chase 0.28), so the fixtures have to build a real
//      context and let the TypeScript compute the deltas itself.

import { scoreMultinomial } from "../_shared/model.ts";

const params = {
  type: "multinomial_logistic",
  classes: ["strike_foul", "ball", "in_play"],
  features: ["balls", "strikes", "two_strikes", "three_balls",
             "pitcher_zone_delta", "batter_chase_delta"],
  coef: [
    [0.10, 0.35, 0.20, -0.05, 0.80, -0.10],
    [-0.20, -0.30, -0.15, 0.40, -0.60, 0.05],
    [0.05, -0.02, -0.03, -0.01, 0.10, 0.15],
  ],
  intercept: [0.15, -0.10, -0.05],
};

// The league constants featureValue() subtracts. Adding the delta back on top
// makes the intended delta the value the TypeScript actually computes.
const ZONE_BASELINE = 0.48;
const CHASE_BASELINE = 0.28;

const cases: Array<Record<string, unknown>> = [];
for (const balls of [0, 1, 2, 3]) {
  for (const strikes of [0, 1, 2]) {
    for (const zone of [-0.06, 0.0, 0.06]) {
      const ctx = {
        balls,
        strikes,
        pitch_count_pa: balls + strikes,
        pitcher: { zone_rate: ZONE_BASELINE + zone },
        batter: { chase_rate: CHASE_BASELINE + 0.0 },
        pitcher_info: null,
        batter_info: null,
      };
      cases.push({
        params,
        context: ctx,
        expected: scoreMultinomial(params, ctx),
      });
    }
  }
}

// Resolved from this file, not the process cwd, so the check behaves the same
// from the repo root and from supabase/functions/.
const GOLDEN = new URL("../../../tests/fixtures/scorer_golden.json", import.meta.url);

// These fixtures pin scoring *behaviour*, not the last bit of a double.
// ECMAScript does not require Math.exp() to be correctly rounded, and V8 has
// changed its result by 1 ULP between versions: fixtures generated under one
// Deno and verified under another drifted on 4 of these 36 cases by ~5.5e-17,
// all in softmax's `ball` class. CI tracks `deno-version: v2.x` -- a moving
// target -- so an exact comparison goes red on an engine bump that changed no
// scoring code at all, and red for any contributor whose Deno differs from
// whoever last regenerated.
//
// So: inputs are compared exactly, probabilities within GOLDEN_TOL. 1e-12 is
// three orders tighter than the 1e-9 tests/modeling/test_parity.py pins the
// Python scorer to -- any real scoring change still fails here first -- and
// four orders looser than the ~1e-16 engine noise this exists to ignore.
const GOLDEN_TOL = 1e-12;

interface GoldenCase {
  params: unknown;
  context: unknown;
  expected: Record<string, number>;
}

function differences(got: { cases: GoldenCase[] }, want: { cases: GoldenCase[] }): string[] {
  const out: string[] = [];
  if (got.cases.length !== want.cases.length) {
    return [`case count: generated ${got.cases.length}, committed ${want.cases.length}`];
  }
  for (let i = 0; i < got.cases.length; i++) {
    const g = got.cases[i], w = want.cases[i];
    // The inputs are the contract's identity, so they must match exactly: a
    // changed case grid or context is a changed contract, not numeric drift.
    for (const field of ["params", "context"] as const) {
      const a = JSON.stringify(g[field]), b = JSON.stringify(w[field]);
      if (a !== b) out.push(`case ${i} ${field}:\n      generated ${a}\n      committed ${b}`);
    }
    const gk = Object.keys(g.expected), wk = Object.keys(w.expected);
    if (JSON.stringify(gk) !== JSON.stringify(wk)) {
      out.push(`case ${i} classes: generated [${gk}], committed [${wk}]`);
      continue;
    }
    for (const k of gk) {
      // Negated so a NaN on either side is a failure rather than a pass.
      const d = Math.abs(g.expected[k] - w.expected[k]);
      if (!(d <= GOLDEN_TOL)) {
        out.push(
          `case ${i} ${k}: generated ${g.expected[k]}, committed ${w.expected[k]} ` +
            `(|delta| ${d.toExponential(3)} > ${GOLDEN_TOL})`,
        );
      }
    }
  }
  return out;
}
const payload = JSON.stringify(
  { generated_by: "scorer_golden_test.ts", cases },
  null,
  2,
);

// Two modes, deliberately:
//
//   default        VERIFY the committed fixtures still match what model.ts
//                  computes. Read-only, so CI needs no write permission.
//   UPDATE_GOLDEN=1  rewrite them (needs --allow-write).
//
// The first version of this file only ever wrote, which meant CI regenerated
// the fixtures it was supposed to be checking against -- a change to model.ts
// scoring would have silently rewritten the contract instead of failing. It
// also broke CI outright, because `deno test --allow-net` grants no write
// access. Verifying by default is what makes the comment at the top of this
// file true.
Deno.test("golden fixtures match model.ts", () => {
  if (Deno.env.get("UPDATE_GOLDEN") === "1") {
    Deno.writeTextFileSync(GOLDEN, payload);
    console.log(`wrote ${cases.length} cases to ${GOLDEN.pathname}`);
    return;
  }

  let committed: string;
  try {
    committed = Deno.readTextFileSync(GOLDEN);
  } catch {
    throw new Error(
      `${GOLDEN.pathname} is missing. Regenerate it with:\n` +
        `  UPDATE_GOLDEN=1 deno test --allow-write --allow-read --allow-env ` +
        `supabase/functions/tests/scorer_golden_test.ts`,
    );
  }

  // Compare parsed, not raw text: line endings differ between platforms and a
  // CRLF checkout must not read as a scoring change.
  const got = JSON.parse(payload);
  const want = JSON.parse(committed);
  const problems = differences(got, want);
  if (problems.length > 0) {
    const shown = problems.slice(0, 10).map((p) => `  - ${p}`).join("\n");
    const rest = problems.length > 10 ? `\n  ... and ${problems.length - 10} more` : "";
    throw new Error(
      `model.ts scoring no longer matches tests/fixtures/scorer_golden.json ` +
        `(beyond the ${GOLDEN_TOL} tolerance):\n${shown}${rest}\n` +
        "If the change to model.ts was intended, regenerate the fixtures:\n" +
        "  UPDATE_GOLDEN=1 deno test --allow-write --allow-read --allow-env " +
        "supabase/functions/tests/scorer_golden_test.ts\n" +
        "then re-run tests/modeling/test_parity.py, which pins the Python " +
        "reference scorer to these same numbers.",
    );
  }
});
