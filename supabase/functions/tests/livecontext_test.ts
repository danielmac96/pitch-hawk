// Display context the Live tab and the game pill read: who is on base, the
// pitcher's count, the batter's line today, pregame conditions, and the
// win-probability history behind the sparkline.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type AtBatRow, basesFromPlays, batterLineToday, parseGameConditions, type PitchRow,
  pitcherPitchCount,
} from "../_shared/mlb.ts";
import { winProbSeries } from "../_shared/winprob.ts";

const play = (inning: number, top: boolean, moves: [string | null, string | null, boolean?][]) => ({
  about: { inning, isTopInning: top },
  runners: moves.map(([start, end, isOut]) => ({ movement: { start, end, isOut: !!isOut } })),
});

Deno.test("bases start empty and fill from runner movements", () => {
  assertEquals(basesFromPlays([]), { first: false, second: false, third: false });
  const plays = [play(3, true, [[null, "1B"]])];
  assertEquals(basesFromPlays(plays), { first: true, second: false, third: false });
});

Deno.test("a runner advancing vacates the base he left, removals before additions", () => {
  const plays = [
    play(3, true, [[null, "1B"]]),
    play(3, true, [[null, "2B"]]),
    // single: runner on 2B to 3B, runner on 1B to 2B, batter to 1B
    play(3, true, [["2B", "3B"], ["1B", "2B"], [null, "1B"]]),
  ];
  assertEquals(basesFromPlays(plays), { first: true, second: true, third: true });
});

Deno.test("scores and outs leave the base empty", () => {
  const plays = [
    play(5, false, [[null, "2B"]]),
    play(5, false, [["2B", "score"], [null, "1B"]]),
    play(5, false, [["1B", "2B", true], [null, "1B"]]),
  ];
  assertEquals(basesFromPlays(plays), { first: true, second: false, third: false });
});

Deno.test("a new half-inning starts with the bases empty", () => {
  const plays = [
    play(4, true, [[null, "1B"], [null, "3B"]]),
    play(4, false, []),
  ];
  assertEquals(basesFromPlays(plays), { first: false, second: false, third: false });
});

const ab = (batter: number, result: string, detail: string): AtBatRow => ({
  game_pk: 1, at_bat_index: 0, pitcher_id: 9, batter_id: batter, pitch_count: 4,
  result, result_detail: detail, start_ts: null, end_ts: null,
});

Deno.test("batter line counts only that batter's completed at-bats", () => {
  const abs = [
    ab(7, "hit", "single"), ab(7, "hit", "home_run"), ab(7, "strikeout", "strikeout"),
    ab(7, "walk", "walk"), ab(8, "hit", "double"),
  ];
  assertEquals(batterLineToday(abs, 7), { pa: 4, h: 2, hr: 1, bb: 1, k: 1 });
  assertEquals(batterLineToday(abs, 99), { pa: 0, h: 0, hr: 0, bb: 0, k: 0 });
  assertEquals(batterLineToday(abs, null), null);
});

Deno.test("pitch count is every pitch that pitcher threw in the game", () => {
  const p = (pitcher: number) => ({ pitcher_id: pitcher } as PitchRow);
  assertEquals(pitcherPitchCount([p(1), p(1), p(2), p(1)], 1), 3);
  assertEquals(pitcherPitchCount([p(1)], null), null);
});

Deno.test("game conditions read weather, roof and the home-plate umpire", () => {
  const c = parseGameConditions({
    venue: { name: "Petco Park" },
    weather: { condition: "Partly Cloudy", temp: "68", wind: "9 mph, Out To CF" },
    officials: [
      { official: { fullName: "A Base" }, officialType: "First Base" },
      { official: { fullName: "Pat Hoberg" }, officialType: "Home Plate" },
    ],
  });
  assertEquals(c, {
    venue_name: "Petco Park", weather_condition: "Partly Cloudy", temp_f: 68,
    wind_mph: 9, wind_direction: "Out To CF", roof_closed: false, hp_umpire: "Pat Hoberg",
  });
  const dome = parseGameConditions({ weather: { condition: "Roof Closed", temp: "72", wind: "0 mph, None" } });
  assertEquals(dome.roof_closed, true);
  // No forecast posted yet: unknown, not "open".
  assertEquals(parseGameConditions({}).roof_closed, null);
  assertEquals(parseGameConditions({}).hp_umpire, null);
});

Deno.test("win-prob series keeps the newest row per at-bat, in at-bat order", () => {
  const rows = [
    { id: 1, at_bat_index: 0, probs: { home: 0.5, away: 0.5 } },
    { id: 3, at_bat_index: 1, probs: { home: 0.55 } },
    { id: 2, at_bat_index: 0, probs: { home: 0.52 } },
    { id: 4, at_bat_index: 2, probs: { away: 0.3 } },
    { id: 5, at_bat_index: null, probs: { home: 0.9 } },
    { id: 6, at_bat_index: 3, probs: null },
  ];
  const innings = new Map([[0, { inning: 1, top_inning: true }], [1, { inning: 1, top_inning: false }]]);
  assertEquals(winProbSeries(rows, innings), [
    { abi: 0, inning: 1, half: "▲", home: 0.52 },
    { abi: 1, inning: 1, half: "▼", home: 0.55 },
    { abi: 2, inning: null, half: null, home: 0.7 },
  ]);
});
