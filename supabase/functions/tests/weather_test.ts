// Pregame weather: parsing MLB's schedule strings, and what the game_total
// multiplier does with them.
//
// The parsers mirror warehouse/mlb.py:flatten_game, so a pregame reading and
// the boxscore reading the warehouse later stores for the same game parse to
// the same shape. If you change one, change both.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isRoofClosed, parseWind } from "../_shared/mlb.ts";
import { type GameTotalContext, predictGameTotal } from "../_shared/model.ts";

Deno.test("parseWind splits speed from direction", () => {
  assertEquals(parseWind("10 mph, In From RF"), [10, "In From RF"]);
  assertEquals(parseWind("7 mph, Out To LF."), [7, "Out To LF"]);
  assertEquals(parseWind("5 mph, L To R"), [5, "L To R"]);
});

Deno.test("parseWind treats Calm and None as no direction", () => {
  // Both are populated strings that are not directions. Left as-is they read
  // as a known direction that simply matches neither "out" nor "in" — true by
  // accident today, and silently wrong the moment the match widens.
  assertEquals(parseWind("7 mph, Calm"), [7, null]);
  assertEquals(parseWind("0 mph, None"), [0, null]);
});

Deno.test("parseWind survives missing and malformed input", () => {
  assertEquals(parseWind(null), [null, null]);
  assertEquals(parseWind(""), [null, null]);
  assertEquals(parseWind("Indoors"), [null, null]);
});

Deno.test("isRoofClosed reads the condition string, not the roof type", () => {
  assertEquals(isRoofClosed("Dome"), true);
  assertEquals(isRoofClosed("Roof Closed"), true);
  assertEquals(isRoofClosed("Partly Cloudy"), false);
  assertEquals(isRoofClosed(null), false);
  // "Retractable" is a roofType, never a condition. A park that HAS a roof is
  // not a park that CLOSED it, and conflating the two mutes weather for 7
  // parks on every open-roof night they play.
  assertEquals(isRoofClosed("Retractable"), false);
});

function ctx(over: Partial<GameTotalContext> = {}): GameTotalContext {
  return {
    home_runs_scored_pg: 4.5, home_runs_allowed_pg: 4.5,
    away_runs_scored_pg: 4.5, away_runs_allowed_pg: 4.5,
    home_starter: null, away_starter: null,
    park_factor: 1, temp_f: null, wind_mph: null, wind_direction: null,
    sample_games: 100, ...over,
  };
}

Deno.test("wind blowing out raises the total, blowing in lowers it", () => {
  const base = predictGameTotal(ctx()).predicted_value!;
  const out = predictGameTotal(
    ctx({ wind_mph: 15, wind_direction: "Out To LF" })).predicted_value!;
  const into = predictGameTotal(
    ctx({ wind_mph: 15, wind_direction: "In From RF" })).predicted_value!;
  if (!(out > base)) throw new Error(`out ${out} should exceed base ${base}`);
  if (!(into < base)) throw new Error(`in ${into} should be under base ${base}`);
});

Deno.test("a closed roof is neutral, not merely windless", () => {
  // The thermostat reads ~72F under a shut roof. Without the roof check that
  // is a real (if small) warm-air bump applied to a game with no air to warm.
  const closed = predictGameTotal(
    ctx({ temp_f: 72, wind_mph: 0, wind_direction: null, roof_closed: true }));
  const neutral = predictGameTotal(ctx());
  assertEquals(closed.predicted_value, neutral.predicted_value);

  const openSameReading = predictGameTotal(
    ctx({ temp_f: 72, wind_mph: 0, wind_direction: null }));
  if (openSameReading.predicted_value === closed.predicted_value) {
    throw new Error("roof_closed changed nothing — the 72F bump still applied");
  }
});

Deno.test("omitting roof_closed preserves the previous behaviour", () => {
  // The field is optional so callers predating pregame weather keep compiling.
  // They must also keep scoring identically.
  const withField = predictGameTotal(ctx({ temp_f: 85, roof_closed: false }));
  const without = predictGameTotal(ctx({ temp_f: 85 }));
  assertEquals(withField.predicted_value, without.predicted_value);
});
