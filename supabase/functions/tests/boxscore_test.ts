// Official-line parsing and the grading it feeds.
//
//   deno test supabase/functions/tests/boxscore_test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

import { parseBoxscore, starterSlot } from "../_shared/boxscore.ts";
import { gradeBase } from "../_shared/basemodels.ts";

const BOX = {
  teams: {
    home: {
      players: {
        ID1: {
          person: { id: 1 }, battingOrder: "300",
          stats: {
            batting: {
              plateAppearances: 4, atBats: 3, hits: 1, runs: 1, rbi: 2,
              homeRuns: 1, totalBases: 4, baseOnBalls: 1, strikeOuts: 1, hitByPitch: 0,
            },
            pitching: {},
          },
        },
        ID2: {
          person: { id: 2 }, battingOrder: "301",
          stats: { batting: { plateAppearances: 1, atBats: 1, hits: 0 }, pitching: {} },
        },
      },
    },
    away: {
      players: {
        ID9: {
          person: { id: 9 },
          stats: {
            batting: {},
            pitching: {
              battersFaced: 24, outs: 17, hits: 6, baseOnBalls: 2, strikeOuts: 7,
              earnedRuns: 3, runs: 4, homeRuns: 1, numberOfPitches: 96, gamesStarted: 1,
            },
          },
        },
      },
    },
  },
};

Deno.test("starterSlot: only ?00 orders are starters", () => {
  assertEquals(starterSlot("100"), 1);
  assertEquals(starterSlot("900"), 9);
  assertEquals(starterSlot("301"), null);
  assertEquals(starterSlot(undefined), null);
  assertEquals(starterSlot("000"), null);
});

Deno.test("parseBoxscore: batters and pitchers by id", () => {
  const b = parseBoxscore(BOX);
  assertEquals(b.batters.get(1), {
    pa: 4, ab: 3, h: 1, r: 1, rbi: 2, hr: 1, tb: 4, bb: 1, k: 1, hbp: 0, slot: 3,
  });
  assertEquals(b.batters.get(2)?.slot, null);
  assertEquals(b.pitchers.get(9)?.outs, 17);
  assertEquals(b.pitchers.get(9)?.er, 3);
  assertEquals(b.pitchers.get(9)?.started, true);
  // A position player with an empty pitching block is not a pitcher.
  assertEquals(b.pitchers.has(1), false);
});

Deno.test("parseBoxscore: tolerates a missing payload", () => {
  const b = parseBoxscore(null);
  assertEquals(b.batters.size, 0);
  assertEquals(b.pitchers.size, 0);
});

Deno.test("gradeBase: HRR, outs and ER grade from the official line", () => {
  const box = { official: true, pa: 4, h: 1, r: 1, rbi: 2, bf: 24, outs: 17, er: 3 };
  assertEquals(gradeBase("batter_hrr", 0.5, box).result, "hit");
  assertEquals(gradeBase("batter_hrr", 0.5, box).actual_count, 4);
  assertEquals(gradeBase("pitcher_outs", 16.5, box).result, "hit");
  assertEquals(gradeBase("pitcher_er", 3.5, box).result, "miss");
});

Deno.test("gradeBase: box-only markets void without the official line", () => {
  const atBats = { pa: 4, bf: 24 };
  assertEquals(gradeBase("batter_hrr", 0.5, atBats).result, "void");
  assertEquals(gradeBase("pitcher_outs", 16.5, atBats).result, "void");
  assertEquals(gradeBase("pitcher_er", 2.5, atBats).result, "void");
});

Deno.test("gradeBase: a starter who faced nobody is void, not a miss", () => {
  assertEquals(gradeBase("pitcher_k", 5.5, { official: true, bf: 0, k: 0 }).result, "void");
});
