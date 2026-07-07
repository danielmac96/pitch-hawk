// Deno tests for the odds/team vocabulary. Run: deno test supabase/functions/_shared/
import { assertEquals } from "jsr:@std/assert";
import { americanToProb, probToAmerican, teamIdByAbbr, teamIdByText } from "./vocab.ts";

Deno.test("teamIdByAbbr resolves MLB abbreviations and ESPN aliases", () => {
  assertEquals(teamIdByAbbr("NYY"), 147);
  assertEquals(teamIdByAbbr("AZ"), 109);   // MLB
  assertEquals(teamIdByAbbr("ARI"), 109);  // ESPN alias
  assertEquals(teamIdByAbbr("CHW"), 145);  // ESPN alias for MLB "CWS"
  assertEquals(teamIdByAbbr("cws"), 145);  // case-insensitive
  assertEquals(teamIdByAbbr("ZZ"), null);
  assertEquals(teamIdByAbbr(null), null);
});

Deno.test("teamIdByText prefers the most specific alias", () => {
  assertEquals(teamIdByText("Chicago White Sox"), 145);
  assertEquals(teamIdByText("Chicago Cubs"), 112);
  assertEquals(teamIdByText("Boston Red Sox"), 111);
  assertEquals(teamIdByText("Will the Yankees win?"), 147);
  assertEquals(teamIdByText("no team here"), null);
});

Deno.test("americanToProb / probToAmerican", () => {
  assertEquals(americanToProb(100), 0.5);
  assertEquals(Math.round(americanToProb(-110)! * 10000) / 10000, 0.5238);
  assertEquals(probToAmerican(0.5), -100);
  assertEquals(americanToProb(null), null);
});

Deno.test("de-vig normalizes a two-sided pair to sum ~1", () => {
  const pa = americanToProb(-150)!; // favorite, ~0.60
  const pb = americanToProb(130)!;  // dog, ~0.4348
  const s = pa + pb;                // > 1 by the vig
  const na = pa / s, nb = pb / s;
  assertEquals(Math.round((na + nb) * 1000) / 1000, 1);
  assertEquals(na > nb, true);       // favorite keeps the larger no-vig prob
  assertEquals(na < pa, true);       // de-vig shrinks the raw implied prob
});
