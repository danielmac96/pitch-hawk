// walkGame() must derive the same per-pitch state as the warehouse flattener
// the v4 models were trained on (tests/fixtures/v4_walk_golden.json, written
// by tests/modeling/test_v4_walk_golden.py).

import { assertEquals } from "jsr:@std/assert@1";
import { walkGame } from "../_shared/v4live.ts";

const FIX = (f: string) => new URL(`../../../tests/fixtures/${f}`, import.meta.url);

Deno.test("v4 live state walk matches warehouse/mlb.py", async () => {
  const pbp = JSON.parse(await Deno.readTextFile(FIX("playbyplay_sample.json")));
  const { pitches: want } = JSON.parse(await Deno.readTextFile(FIX("v4_walk_golden.json")));
  const got = walkGame(pbp.allPlays).pitches;
  assertEquals(got.length, want.length);
  got.forEach((p, i) => {
    for (const k of Object.keys(want[i])) {
      assertEquals((p as any)[k] ?? null, want[i][k] ?? null, `pitch ${i} field ${k}`);
    }
  });
});
