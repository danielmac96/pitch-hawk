// Tests for the Phase 4 aggregate read handlers.
//
// The plan asked for these in tests/api/test_routes.py against the pytest
// fake_client. That harness exercises the FastAPI app under backend/, which is
// a parallel dev implementation -- these routes ship in the Deno edge function
// that actually serves production, so pytest cannot reach them. Same three
// cases the plan specified (happy path, unknown id, empty table), against a
// stub db, run by `deno test` in the edge-functions CI job.
//
//   deno test supabase/functions/tests/

import {
  assertEquals,
  assertFalse,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  gameContext,
  matchup,
  playerFatigue,
  playerProfile,
  playerSplits,
} from "../_shared/aggregates.ts";

/** Minimal stand-in for the postgrest builder chain the handlers use. */
function stubDb(tables: Record<string, Record<string, unknown>[]>) {
  return {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const q = {
        select: () => q,
        limit: (n: number) => {
          rows = rows.slice(0, n);
          return q;
        },
        order: () => q,
        eq: (col: string, val: unknown) => {
          rows = rows.filter((r) => r[col] === val);
          return q;
        },
        then: (resolve: (v: { data: Record<string, unknown>[] }) => void) =>
          resolve({ data: rows }),
      };
      return q;
    },
  };
}

const PROFILES = {
  pitcher_profiles: [
    { player_id: 100, scope: "d30", pitches: 300, k_rate: 0.28 },
    { player_id: 100, scope: "career", pitches: 4268, k_rate: 0.2 },
    { player_id: 100, scope: "season", pitches: 1500, k_rate: 0.24 },
    { player_id: 999, scope: "career", pitches: 50, k_rate: 0.1 },
  ],
  batter_profiles: [
    { player_id: 100, scope: "career", pitches: 40, k_rate: 0.3 },
  ],
};

Deno.test("playerProfile returns both roles, scopes ordered career-first", async () => {
  const r = await playerProfile(stubDb(PROFILES), 100);
  assertEquals(r.found, true);
  // A two-way player must not have one side silently dropped.
  assertEquals(r.data.pitcher.map((p: { scope: string }) => p.scope),
    ["career", "season", "d30"]);
  assertEquals(r.data.batter.length, 1);
});

Deno.test("playerProfile reports found:false for an unknown player", async () => {
  const r = await playerProfile(stubDb(PROFILES), 424242);
  assertFalse(r.found);
  assertEquals(r.data.pitcher, []);
  assertEquals(r.data.batter, []);
  // The id still comes back, so the caller can label the empty panel.
  assertEquals(r.data.player_id, 424242);
});

Deno.test("playerProfile survives an entirely empty aggregate table", async () => {
  // What the frontend sees between the migration landing and the first
  // successful nightly publish.
  const r = await playerProfile(stubDb({}), 100);
  assertFalse(r.found);
  assertEquals(r.data.pitcher, []);
});

Deno.test("playerSplits returns only the requested player", async () => {
  const db = stubDb({
    situational_splits: [
      { player_id: 100, role: "pitcher", men_on_base: "RISP", pa: 40 },
      { player_id: 100, role: "batter", men_on_base: "Empty", pa: 90 },
      { player_id: 101, role: "pitcher", men_on_base: "RISP", pa: 12 },
    ],
  });
  const r = await playerSplits(db, 100);
  assertEquals(r.found, true);
  assertEquals(r.data.splits.length, 2);
});

Deno.test("playerSplits on an empty table is found:false, not a throw", async () => {
  const r = await playerSplits(stubDb({ situational_splits: [] }), 100);
  assertFalse(r.found);
  assertEquals(r.data.splits, []);
});

Deno.test("playerFatigue returns the pitcher's bucket curve", async () => {
  const db = stubDb({
    pitcher_fatigue_profile: [
      { pitcher_id: 100, pitch_bucket: 0, mean_velo: 88.2 },
      { pitcher_id: 100, pitch_bucket: 4, mean_velo: 87.7 },
      { pitcher_id: 101, pitch_bucket: 0, mean_velo: 95.0 },
    ],
  });
  const r = await playerFatigue(db, 100);
  assertEquals(r.found, true);
  assertEquals(r.data.buckets.length, 2);
});

Deno.test("playerFatigue for an unknown pitcher is found:false", async () => {
  const r = await playerFatigue(stubDb({ pitcher_fatigue_profile: [] }), 7);
  assertFalse(r.found);
  assertEquals(r.data.buckets, []);
});

Deno.test("matchup returns the pair row when it exists", async () => {
  const db = stubDb({
    matchup_history: [
      { pitcher_id: 100, batter_id: 200, pa_count: 9, so_count: 3 },
      { pitcher_id: 100, batter_id: 201, pa_count: 4, so_count: 1 },
    ],
  });
  const r = await matchup(db, 100, 200);
  assertEquals(r.found, true);
  assertEquals(r.data.pa_count, 9);
});

Deno.test("matchup below the 3-PA floor degrades to a zero row, not an error", async () => {
  // Most pairs are legitimately absent -- the published table applies a >=3 PA
  // floor -- so the caller needs a usable shape rather than a failure.
  const r = await matchup(stubDb({ matchup_history: [] }), 100, 999);
  assertFalse(r.found);
  assertEquals(r.data.pa_count, 0);
  assertEquals(r.data.pitcher_id, 100);
  assertEquals(r.data.batter_id, 999);
});

Deno.test("gameContext returns the game row", async () => {
  const db = stubDb({
    game_context: [
      { game_pk: 900001, venue_name: "Test Park", hp_umpire: "Ump", temp_f: 70 },
    ],
  });
  const r = await gameContext(db, 900001);
  assertEquals(r.found, true);
  assertEquals(r.data.venue_name, "Test Park");
});

Deno.test("gameContext for an unknown game keeps the id for labelling", async () => {
  const r = await gameContext(stubDb({ game_context: [] }), 12345);
  assertFalse(r.found);
  assertEquals(r.data.game_pk, 12345);
});
