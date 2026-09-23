// De-vigging, and the player-name resolution player props depend on.
//
// Both changed when props landed, and both changed in ways that fail QUIETLY:
// a wrong de-vig is still a plausible probability, and a wrong name match is
// a real line attributed to the wrong hitter.

import { assertAlmostEquals, assertEquals } from
  "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applyNovig,
  indexPlayersByName,
  normalizeName,
  round4,
} from "../_shared/novig.ts";

function row(over: Record<string, unknown>) {
  return { game_pk: 1, source: "dk", ...over } as Record<string, unknown>;
}

Deno.test("a two-sided moneyline is normalised to sum to one", () => {
  const rows = [
    row({ market: "game_moneyline", outcome: "home", implied_prob: 0.55 }),
    row({ market: "game_moneyline", outcome: "away", implied_prob: 0.50 }),
  ];
  applyNovig(rows);
  assertAlmostEquals(
    Number(rows[0].novig_prob) + Number(rows[1].novig_prob), 1.0, 1e-9);
  // The favourite stays the favourite.
  if (!(Number(rows[0].novig_prob) > Number(rows[1].novig_prob))) {
    throw new Error("de-vig inverted the ranking");
  }
});

Deno.test("a player prop is de-vigged over/under, not home/away", () => {
  // The market name is `batter_hr`, not `game_total`. The previous rule
  // branched on the name and sent every prop looking for "home" and "away",
  // found neither, and silently kept the vig.
  const rows = [
    row({ market: "batter_hr", outcome: "over", player_id: 11, implied_prob: 0.30 }),
    row({ market: "batter_hr", outcome: "under", player_id: 11, implied_prob: 0.76 }),
  ];
  applyNovig(rows);
  assertAlmostEquals(
    Number(rows[0].novig_prob) + Number(rows[1].novig_prob), 1.0, 1e-9);
  if (Number(rows[0].novig_prob) === 0.30) {
    throw new Error("the vig was kept -- the pair was never matched");
  }
});

Deno.test("two players in one game are de-vigged separately", () => {
  // THE bug the player key exists for. Without it these four rows share a
  // group and `find(outcome === "over")` picks whichever player came first,
  // pairing one hitter's over with another hitter's under.
  const rows = [
    row({ market: "batter_hr", outcome: "over", player_id: 11, implied_prob: 0.30 }),
    row({ market: "batter_hr", outcome: "under", player_id: 11, implied_prob: 0.76 }),
    row({ market: "batter_hr", outcome: "over", player_id: 22, implied_prob: 0.05 }),
    row({ market: "batter_hr", outcome: "under", player_id: 22, implied_prob: 0.97 }),
  ];
  applyNovig(rows);

  for (const [a, b] of [[0, 1], [2, 3]]) {
    assertAlmostEquals(
      Number(rows[a].novig_prob) + Number(rows[b].novig_prob), 1.0, 1e-9);
  }
  // The slugger and the light hitter must stay far apart. Cross-pairing would
  // drag them toward each other.
  assertAlmostEquals(Number(rows[0].novig_prob), 0.30 / 1.06, 1e-4);
  assertAlmostEquals(Number(rows[2].novig_prob), 0.05 / 1.02, 1e-4);
});

Deno.test("game-level markets group exactly as before", () => {
  // player_id is absent on these rows, so the key gains an empty segment and
  // nothing else. A regression here would silently change every existing
  // moneyline and total.
  const rows = [
    row({ market: "game_total", outcome: "over", implied_prob: 0.52 }),
    row({ market: "game_total", outcome: "under", implied_prob: 0.52 }),
  ];
  applyNovig(rows);
  assertAlmostEquals(Number(rows[0].novig_prob), 0.5, 1e-9);
  assertAlmostEquals(Number(rows[1].novig_prob), 0.5, 1e-9);
});

Deno.test("different books are not de-vigged against each other", () => {
  const rows = [
    row({ market: "batter_hit", outcome: "over", player_id: 11, source: "dk", implied_prob: 0.60 }),
    row({ market: "batter_hit", outcome: "under", player_id: 11, source: "fd", implied_prob: 0.45 }),
  ];
  applyNovig(rows);
  // Each is alone in its group, so each keeps its vig.
  assertEquals(rows[0].novig_prob, 0.60);
  assertEquals(rows[1].novig_prob, 0.45);
});

Deno.test("a single-sided quote keeps its vig rather than inventing a side", () => {
  const rows = [
    row({ market: "batter_hr", outcome: "over", player_id: 11, implied_prob: 0.28 }),
  ];
  applyNovig(rows);
  assertEquals(rows[0].novig_prob, 0.28);
});

Deno.test("normalizeName strips accents, punctuation and case", () => {
  assertEquals(normalizeName("José Ramírez"), "jose ramirez");
  assertEquals(normalizeName("Ronald Acuña Jr."), "ronald acuna jr");
  assertEquals(normalizeName("  Shohei   Ohtani "), "shohei ohtani");
  assertEquals(normalizeName("J.D. Martinez"), "jd martinez");
  assertEquals(normalizeName(null), "");
});

Deno.test("a sportsbook spelling resolves to the roster id", () => {
  const { byName } = indexPlayersByName([
    { player_id: 1, full_name: "José Ramírez" },
    { player_id: 2, full_name: "Ronald Acuña Jr." },
  ]);
  assertEquals(byName.get(normalizeName("Jose Ramirez")), 1);
  assertEquals(byName.get(normalizeName("Ronald Acuna Jr")), 2);
});

Deno.test("an ambiguous name is reported, not guessed", () => {
  // Two real players share a normalised name often enough to matter. A prop
  // attributed to the wrong hitter is worse than a missing one.
  const { byName, collisions } = indexPlayersByName([
    { player_id: 1, full_name: "Will Smith" },
    { player_id: 2, full_name: "Will Smith" },
  ]);
  assertEquals(byName.get("will smith"), 1);
  assertEquals(collisions, ["will smith"]);
});

Deno.test("round4 passes null through", () => {
  assertEquals(round4(null), null);
  assertEquals(round4(undefined), null);
  assertEquals(round4(0.123456), 0.1235);
});
