// Tests for the per-pitch graded feed.
//
// This endpoint replaces the Data Feed's in-browser `gradedLog`, so the case
// that matters most is `same_result_regardless_of_when_you_ask`: the old
// implementation returned whatever pitches the tab had observed, which meant
// the answer depended on when you opened the page. The server does not have
// that property and these tests are what keep it that way.
//
//   deno test supabase/functions/tests/

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import { pitchFeed } from "../_shared/pitchfeed.ts";

/** Stand-in for the postgrest builder chain, with the operators this uses. */
function stubDb(tables: Record<string, Record<string, unknown>[]>) {
  return {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const q = {
        select: () => q,
        eq: (col: string, val: unknown) => {
          rows = rows.filter((r) => r[col] === val);
          return q;
        },
        in: (col: string, vals: unknown[]) => {
          rows = rows.filter((r) => vals.includes(r[col]));
          return q;
        },
        not: (col: string, _op: string, _val: unknown) => {
          rows = rows.filter((r) => r[col] != null);
          return q;
        },
        order: (col: string, opts?: { ascending?: boolean }) => {
          const dir = opts?.ascending === false ? -1 : 1;
          rows.sort((a, b) => (Number(a[col]) - Number(b[col])) * dir);
          return q;
        },
        range: (from: number, to: number) => {
          rows = rows.slice(from, to + 1);
          return q;
        },
        limit: (n: number) => {
          rows = rows.slice(0, n);
          return q;
        },
        then: (resolve: (v: { data: Record<string, unknown>[] }) => void) =>
          resolve({ data: rows }),
      };
      return q;
    },
  };
}

const DAY = "2026-08-06";

const GAMES = [
  { game_pk: 1, home_abbr: "BOS", away_abbr: "NYY", official_date: DAY },
  { game_pk: 2, home_abbr: "LAD", away_abbr: "SF", official_date: DAY },
];

const AT_BATS = [
  { game_pk: 1, at_bat_index: 3, pitcher_id: 600, batter_id: 700 },
  { game_pk: 2, at_bat_index: 1, pitcher_id: 601, batter_id: 701 },
];

const PLAYERS = [
  { player_id: 600, full_name: "Ada Pitcher" },
  { player_id: 700, full_name: "Bo Batter" },
  { player_id: 601, full_name: "Cy Pitcher" },
  { player_id: 701, full_name: "Dee Batter" },
];

function pred(over: Record<string, unknown> = {}) {
  return {
    id: 1, game_pk: 1, at_bat_index: 3, pitch_number: 2,
    market: "pitch_speed_ou", recommendation: "over",
    predicted_value: 94.2, line: 93.5, confidence: 0.61,
    result: "win", actual_value: 93.1, actual_label: "under",
    profit_units: 0.91, model_version: "v1_20260707",
    created_at: "2026-08-06T23:05:00+00:00",
    graded_at: "2026-08-06T23:06:00+00:00",
    ...over,
  };
}

// Pitch 2 is the one already thrown (its post-pitch count is what the model
// predicted into); pitch 3 is what was actually thrown next.
const PITCHES = [
  {
    game_pk: 1, at_bat_index: 3, pitch_number: 2, balls: 1, strikes: 2,
    outs: 1, inning: 4, top_inning: true, pitch_type: "SL",
  },
  {
    game_pk: 1, at_bat_index: 3, pitch_number: 3, balls: 1, strikes: 3,
    outs: 1, inning: 4, top_inning: true, pitch_type: "FF",
  },
];

function db(preds: Record<string, unknown>[]) {
  return stubDb({
    games: GAMES, at_bats: AT_BATS, player_info: PLAYERS,
    pitches: PITCHES, predictions: preds,
  });
}

Deno.test("returns every prediction for the day's slate, newest first", async () => {
  const res = await pitchFeed(
    db([pred({ id: 1 }), pred({ id: 2 }), pred({ id: 3, game_pk: 2, at_bat_index: 1 })]),
    { date: DAY },
  );
  assertEquals(res.rows.map((r) => r.id), [3, 2, 1]);
  assertEquals(res.summary.n, 3);
  assertEquals(res.summary.games, 2);
});

Deno.test("the same query gives the same answer regardless of when it is asked", async () => {
  // The whole point of the endpoint. The old client-side log returned only the
  // pitches that tab had seen, so a user arriving late saw a shorter table.
  const rows = [pred({ id: 1 }), pred({ id: 2 })];
  const a = await pitchFeed(db(rows), { date: DAY });
  const b = await pitchFeed(db(rows), { date: DAY });
  assertEquals(a.rows, b.rows);
  assertEquals(a.summary, b.summary);
});

Deno.test("computes the signed miss so every client renders it identically", async () => {
  const res = await pitchFeed(db([pred()]), { date: DAY });
  // predicted 94.2, actual 93.1
  assertEquals(res.rows[0].error, 1.1);
});

Deno.test("a row with no recorded actual has a null error, not a zero", async () => {
  // Rows graded before 20260808000002 carry no actual. Rendering that as 0.0
  // would read as a perfect prediction.
  const res = await pitchFeed(
    db([pred({ actual_value: null, actual_label: null })]), { date: DAY },
  );
  assertEquals(res.rows[0].actual_value, null);
  assertEquals(res.rows[0].error, null);
});

Deno.test("joins pitcher and batter identity from at_bats", async () => {
  const res = await pitchFeed(db([pred()]), { date: DAY });
  assertEquals(res.rows[0].pitcher_name, "Ada Pitcher");
  assertEquals(res.rows[0].batter_name, "Bo Batter");
  assertEquals(res.rows[0].game_label, "NYY @ BOS");
});

Deno.test("carries the situation the prediction was made into", async () => {
  // Supabase stores balls/strikes POST-pitch, so the count on the pitch
  // already thrown (pitch_number 2) is the one the pitcher faced for the pitch
  // being predicted. Reading the next pitch's count instead would report 1-3.
  const res = await pitchFeed(db([pred()]), { date: DAY });
  assertEquals(res.rows[0].count, "1-2");
  assertEquals(res.rows[0].outs, 1);
  assertEquals(res.rows[0].inning, 4);
  assertEquals(res.rows[0].half, "▲");
  // ...and the pitch actually thrown next is the one at pitch_number + 1.
  assertEquals(res.rows[0].actual_pitch_type, "FF");
});

Deno.test("an unknown pitch leaves the count null rather than inventing 0-0", async () => {
  const res = await pitchFeed(
    db([pred({ at_bat_index: 99 })]), { date: DAY },
  );
  assertEquals(res.rows[0].count, null);
  assertEquals(res.rows[0].outs, null);
  assertEquals(res.rows[0].actual_pitch_type, null);
});

Deno.test("game_pk filters to that game", async () => {
  const res = await pitchFeed(
    db([pred({ id: 1 }), pred({ id: 2, game_pk: 2, at_bat_index: 1 })]),
    { date: DAY, gamePk: 2 },
  );
  assertEquals(res.rows.length, 1);
  assertEquals(res.rows[0].game_pk, 2);
});

Deno.test("a game_pk not on this date returns empty, not another day's rows", async () => {
  const res = await pitchFeed(db([pred()]), { date: DAY, gamePk: 999 });
  assertEquals(res.rows, []);
  assertEquals(res.summary.n, 0);
});

Deno.test("filters to the requested markets", async () => {
  const res = await pitchFeed(
    db([
      pred({ id: 1, market: "pitch_speed_ou" }),
      pred({ id: 2, market: "pitch_result" }),
      pred({ id: 3, market: "ab_result" }),
      pred({ id: 4, market: "game_moneyline" }),
    ]),
    { date: DAY, markets: ["pitch_speed_ou", "pitch_result"] },
  );
  assertEquals(res.rows.map((r) => r.id), [2, 1]);
});

Deno.test("no market filter returns every market", async () => {
  const res = await pitchFeed(
    db([pred({ id: 1, market: "pitch_speed_ou" }), pred({ id: 2, market: "ab_result" })]),
    { date: DAY },
  );
  assertEquals(res.rows.length, 2);
});

Deno.test("status=graded drops rows still pending", async () => {
  const res = await pitchFeed(
    db([pred({ id: 1 }), pred({ id: 2, result: null })]),
    { date: DAY, status: "graded" },
  );
  assertEquals(res.rows.length, 1);
  assertEquals(res.rows[0].id, 1);
});

Deno.test("paginates with a cursor and stops at the end", async () => {
  const rows = [1, 2, 3, 4, 5].map((id) => pred({ id }));
  const p1 = await pitchFeed(db(rows), { date: DAY, limit: 2 });
  assertEquals(p1.rows.map((r) => r.id), [5, 4]);
  assertEquals(p1.next_cursor, 2);

  const p2 = await pitchFeed(db(rows), { date: DAY, limit: 2, cursor: 2 });
  assertEquals(p2.rows.map((r) => r.id), [3, 2]);

  // A short page is the end of the range.
  const p3 = await pitchFeed(db(rows), { date: DAY, limit: 2, cursor: 4 });
  assertEquals(p3.rows.map((r) => r.id), [1]);
  assertEquals(p3.next_cursor, null);
});

Deno.test("a day with no games returns an empty feed rather than erroring", async () => {
  const res = await pitchFeed(db([pred()]), { date: "2026-01-01" });
  assertEquals(res.rows, []);
  assertEquals(res.summary.games, 0);
});

Deno.test("summary counts graded outcomes", async () => {
  const res = await pitchFeed(
    db([
      pred({ id: 1, result: "win" }),
      pred({ id: 2, result: "loss" }),
      pred({ id: 3, result: "push" }),
      pred({ id: 4, result: null }),
    ]),
    { date: DAY },
  );
  assertEquals(res.summary.n, 4);
  assertEquals(res.summary.graded, 3);
  assertEquals(res.summary.wins, 1);
  assertEquals(res.summary.losses, 1);
  assertEquals(res.summary.pushes, 1);
});

Deno.test("limit is clamped so one request cannot pull the whole day", async () => {
  const rows = Array.from({ length: 50 }, (_, i) => pred({ id: i + 1 }));
  const res = await pitchFeed(db(rows), { date: DAY, limit: 10_000 });
  assert(res.rows.length <= 1000);
});
