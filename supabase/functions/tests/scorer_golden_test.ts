// Emits tests/fixtures/scorer_golden.json -- the contract between model.ts and
// modeling/score.py. Regenerate whenever model.ts scoring changes:
//   deno test --allow-write --allow-read supabase/functions/tests/scorer_golden_test.ts
//
// tests/modeling/test_parity.py asserts the Python reference scorer matches
// these outputs to 1e-9. Editing model.ts without regenerating turns CI red,
// which is the point.
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

Deno.test("emit golden fixtures", () => {
  Deno.writeTextFileSync(
    "tests/fixtures/scorer_golden.json",
    JSON.stringify({ generated_by: "scorer_golden_test.ts", cases }, null, 2),
  );
});
