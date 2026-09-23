// The per-plate-appearance -> per-game roll-up, and the guards around it.
//
// The roll-up is the part worth testing hard: P(hit in a game) and
// P(hit in a plate appearance) are different questions, and publishing one
// under the other's name is the easy way to ship a number that is wrong by a
// factor of four while looking entirely reasonable.

import { assertAlmostEquals, assertEquals } from
  "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  atLeastOnce,
  expectedPa,
  isPlausible,
  leagueRate,
  projectBatter,
} from "../_shared/batterprojection.ts";
import { LEAGUE } from "../_shared/model.ts";

Deno.test("expectedPa follows the batting order", () => {
  // Measured over 176 games x 2 sides across six 2025 dates.
  assertAlmostEquals(expectedPa(1), 4.49, 1e-9);
  assertAlmostEquals(expectedPa(9), 3.45, 1e-9);
  // Strictly decreasing: the leadoff spot bats more than the nine hole, and
  // an ordering error here would quietly reweight every projection.
  for (let s = 1; s < 9; s++) {
    if (!(expectedPa(s) > expectedPa(s + 1))) {
      throw new Error(`slot ${s} does not bat more than ${s + 1}`);
    }
  }
});

Deno.test("expectedPa falls back to the mean when the slot is unknown", () => {
  // Lineups post a few hours before first pitch, so an early scoring pass has
  // no slot at all. That is an ordinary state, not an error.
  const unknown = expectedPa(null);
  if (!(unknown > expectedPa(9) && unknown < expectedPa(1))) {
    throw new Error(`fallback ${unknown} should sit inside the slot range`);
  }
  assertEquals(expectedPa(0), unknown);
  assertEquals(expectedPa(10), unknown);
});

Deno.test("atLeastOnce compounds across plate appearances", () => {
  // Four independent trips at 25% is 1 - 0.75^4.
  assertAlmostEquals(atLeastOnce(0.25, 4), 1 - Math.pow(0.75, 4), 1e-12);
  // One trip is just the per-PA number.
  assertAlmostEquals(atLeastOnce(0.25, 1), 0.25, 1e-12);
});

Deno.test("a rare per-PA event is much likelier across a game", () => {
  // The number this whole module exists to get right: a 3.2% home run rate
  // per trip is ~13% somewhere in four. Publishing 3.2% as a per-GAME
  // probability would understate it four-fold.
  const perGame = atLeastOnce(LEAGUE.hr_rate, 4.22);
  if (!(perGame > 0.12 && perGame < 0.14)) {
    throw new Error(`league HR rate over a game read ${perGame}`);
  }
});

Deno.test("atLeastOnce handles the degenerate inputs", () => {
  assertEquals(atLeastOnce(0, 4), 0);
  assertEquals(atLeastOnce(0.3, 0), 0);
  assertEquals(atLeastOnce(1, 4), 1);
});

const hrParams = {
  type: "multinomial_logistic",
  classes: ["home_run", "other"],
  features: ["batter_hr_delta", "pitcher_hr_delta", "platoon_same"],
  coef: [[6.0, 4.0, -0.1], [-6.0, -4.0, 0.1]],
  intercept: [-1.7, 1.7],
  version: "v_test",
};

function ctx(batterHr: number | null, pitcherHr: number | null) {
  return {
    balls: 0,
    strikes: 0,
    pitch_count_pa: 0,
    pitcher: pitcherHr == null ? null : { hr_rate: pitcherHr },
    batter: batterHr == null ? null : { hr_rate: batterHr },
    pitcher_info: { pitch_hand: "R" },
    batter_info: { bat_side: "R" },
  };
}

Deno.test("projectBatter returns both the per-PA and per-game numbers", () => {
  const p = projectBatter("batter_hr", { batter_hr: hrParams },
                          ctx(0.06, 0.04), 3)!;
  assertEquals(p.market, "batter_hr");
  assertEquals(p.expected_pa, expectedPa(3));
  // The per-game number is the roll-up of the per-PA one, not a second model.
  assertAlmostEquals(
    p.probability,
    Math.round(atLeastOnce(p.per_pa_probability, p.expected_pa) * 10000) / 10000,
    1e-9,
  );
  if (!(p.probability > p.per_pa_probability)) {
    throw new Error("per-game must exceed per-PA for a repeated trial");
  }
});

Deno.test("a better hitter projects higher", () => {
  const models = { batter_hr: hrParams };
  const weak = projectBatter("batter_hr", models, ctx(0.01, 0.032), 4)!;
  const strong = projectBatter("batter_hr", models, ctx(0.08, 0.032), 4)!;
  if (!(strong.probability > weak.probability)) {
    throw new Error(
      `a 8% HR hitter (${strong.probability}) should beat a 1% one ` +
        `(${weak.probability})`,
    );
  }
});

Deno.test("the batting slot changes the per-game number, not the per-PA one", () => {
  const models = { batter_hr: hrParams };
  const lead = projectBatter("batter_hr", models, ctx(0.05, 0.032), 1)!;
  const ninth = projectBatter("batter_hr", models, ctx(0.05, 0.032), 9)!;
  assertEquals(lead.per_pa_probability, ninth.per_pa_probability);
  if (!(lead.probability > ninth.probability)) {
    throw new Error("more plate appearances must mean a higher game chance");
  }
});

Deno.test("projectBatter returns null with no trained model", () => {
  // Deliberately NO league-average fallback: a per-player column showing
  // every batter the same 3.2% is worse than an empty one, because it looks
  // like a projection.
  assertEquals(projectBatter("batter_hr", {}, ctx(0.05, 0.032), 4), null);
  assertEquals(
    projectBatter("batter_hr", { batter_hr: { type: "linear" } },
                  ctx(0.05, 0.032), 4),
    null,
  );
});

Deno.test("a batter with no rolling stats still scores off the intercept", () => {
  // featureValue returns 0 for a missing rate, so the model falls back to its
  // own baseline rather than dropping the row. A call-up with no history is a
  // normal case on any slate.
  const p = projectBatter("batter_hr", { batter_hr: hrParams },
                          ctx(null, null), 5);
  if (!p || !(p.probability > 0)) throw new Error("expected a scored row");
});

Deno.test("isPlausible rejects what a broken model would emit", () => {
  assertEquals(isPlausible("batter_hr", 0.12), true);
  assertEquals(isPlausible("batter_hr", 0.85), false);
  assertEquals(isPlausible("batter_hit", 0.62), true);
  assertEquals(isPlausible("batter_hit", 0.99), false);
  assertEquals(isPlausible("batter_hr", NaN), false);
  assertEquals(isPlausible("batter_hr", -0.1), false);
});

Deno.test("leagueRate reads the shared constants", () => {
  assertEquals(leagueRate("batter_hr"), LEAGUE.hr_rate);
  assertEquals(leagueRate("batter_hit"), LEAGUE.ab_result.hit);
});

// ── grading ────────────────────────────────────────────────────────────────

import { gradeProjection } from "../_shared/batterprojection.ts";

Deno.test("a batter who did the thing grades hit", () => {
  const g = gradeProjection("batter_hr", 4, 2, 1);
  assertEquals(g.result, "hit");
  assertEquals(g.actual_count, 1);
  assertEquals(g.plate_appearances, 4);
});

Deno.test("a batter who batted and did not grades miss", () => {
  assertEquals(gradeProjection("batter_hr", 4, 2, 0).result, "miss");
  assertEquals(gradeProjection("batter_hit", 3, 0, 0).result, "miss");
});

Deno.test("a batter who never batted grades VOID, not miss", () => {
  // The distinction the whole calibration measurement rests on. Lineups
  // change after they are posted; a late scratch is roster churn, not a
  // failed prediction, and counting it as a miss would drag the observed
  // rate down and make a calibrated model read as over-confident.
  const g = gradeProjection("batter_hr", 0, 0, 0);
  assertEquals(g.result, "void");
  assertEquals(g.plate_appearances, 0);
});

Deno.test("each market counts its own event", () => {
  // Three hits, none of them home runs.
  assertEquals(gradeProjection("batter_hit", 4, 3, 0).actual_count, 3);
  assertEquals(gradeProjection("batter_hit", 4, 3, 0).result, "hit");
  assertEquals(gradeProjection("batter_hr", 4, 3, 0).actual_count, 0);
  assertEquals(gradeProjection("batter_hr", 4, 3, 0).result, "miss");
});

Deno.test("a home run is also a hit, and both markets say so", () => {
  // `result_detail = 'home_run'` implies `result = 'hit'`, so a game with one
  // home run and no other hits grades `hit` for BOTH markets.
  assertEquals(gradeProjection("batter_hit", 4, 1, 1).result, "hit");
  assertEquals(gradeProjection("batter_hr", 4, 1, 1).result, "hit");
});

Deno.test("multiple events still grade as one hit", () => {
  // These are >=1 projections. Two home runs is not two hits on the record;
  // the count is kept alongside so the detail is not lost.
  const g = gradeProjection("batter_hr", 5, 3, 2);
  assertEquals(g.result, "hit");
  assertEquals(g.actual_count, 2);
});
