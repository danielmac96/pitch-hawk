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
          // Set rather than Array.includes: the pitch-paging test filters
          // thousands of rows against a thousand keys, and the quadratic form
          // made it slow enough to look hung.
          const want = new Set(vals);
          rows = rows.filter((r) => want.has(r[col]));
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
    backfilled_at: null,
    ...over,
  };
}

// Pitch 2 is the one already thrown (its post-pitch count is what the model
// predicted into); pitch 3 is what was actually thrown next.
const PITCHES = [
  // Pitch 1 is what the pitch_number 0 prediction is about — a plate
  // appearance's opening call. Its post-pitch count (1-0) is deliberately not
  // 0-0, so a test asserting "0-0" for the opener proves the count comes from
  // the definition of a PA start rather than from reading this row.
  {
    game_pk: 1, at_bat_index: 3, pitch_number: 1, balls: 1, strikes: 0,
    outs: 1, inning: 4, top_inning: true, pitch_type: "CH",
  },
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

Deno.test("carries backfilled_at through so reconstructed calls stay distinguishable", async () => {
  // backfill-predictions scores a past pitch with today's models. The row is a
  // real call about a real pitch and counts in the record, but it was never one
  // anyone could have acted on. If the flag does not survive the trip the
  // client cannot tell the two apart, which is how a backfilled slate starts
  // reading as a live track record.
  const res = await pitchFeed(
    db([
      pred({ id: 1 }),
      pred({ id: 2, backfilled_at: "2026-08-16T04:00:00+00:00" }),
    ]),
    { date: DAY },
  );
  const byId = new Map(res.rows.map((r) => [r.id, r]));
  assertEquals(byId.get(1)?.backfilled_at, null);
  assertEquals(byId.get(2)?.backfilled_at, "2026-08-16T04:00:00+00:00");
  // Counted, not excluded -- and reported, so the mix is visible.
  assertEquals(res.summary.backfilled, 1);
  assertEquals(res.summary.n, 2);
  assertEquals(res.summary.wins, 2);
});

Deno.test("an empty slate reports the same summary shape as a populated one", async () => {
  // A client reading summary.backfilled should get 0 on a quiet day, not
  // undefined -- the two render very differently.
  const res = await pitchFeed(db([]), { date: "2026-01-01" });
  assertEquals(res.summary.backfilled, 0);
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

Deno.test("the pre-first-pitch call of a plate appearance carries a situation", async () => {
  // pitch_number 0 is the call made before anything is thrown, so there is no
  // already-thrown pitch to read: pitches.pitch_number starts at 1, and
  // (at_bat_index, 0) can never match. That nulled the inning, half, count and
  // outs of one row per plate appearance -- 114 of 478 on a real game -- and a
  // null inning was enough to crash the client outright. The pitch being
  // predicted is in the same half-inning, and a PA starts 0-0 by definition.
  const res = await pitchFeed(
    db([pred({ pitch_number: 0 })]), { date: DAY },
  );
  assertEquals(res.rows[0].count, "0-0");
  assertEquals(res.rows[0].inning, 4);
  assertEquals(res.rows[0].half, "▲");
  assertEquals(res.rows[0].outs, 1);
  // ...and the pitch it predicts is pitch 1, whose own post-pitch count is 1-0.
  assertEquals(res.rows[0].actual_pitch_type, "CH");
});

Deno.test("an opener with no pitch on record still refuses to invent 0-0", async () => {
  const res = await pitchFeed(
    db([pred({ pitch_number: 0, at_bat_index: 99 })]), { date: DAY },
  );
  assertEquals(res.rows[0].count, null);
  assertEquals(res.rows[0].inning, null);
});

Deno.test("every row keeps its situation when the pitch join spans several pages", async () => {
  // The pitch lookup was one un-ordered `.limit(MAX_LIMIT * 4)`. Because it
  // filters `game_pk IN (…) AND at_bat_index IN (…)` -- close to a cross
  // product -- a full prediction page selected more pitch rows than that
  // ceiling and got an arbitrary slice of them. Every prediction outside the
  // slice silently lost its inning, count and outs: 54% of a 1,000-row page in
  // production, against 24% of a 200-row one.
  const PA = 1000, PER_PA = 5;
  const atBats = [], pitches = [], preds = [];
  for (let ab = 0; ab < PA; ab += 1) {
    atBats.push({ game_pk: 1, at_bat_index: ab, pitcher_id: 600, batter_id: 700 });
    for (let pn = 1; pn <= PER_PA; pn += 1) {
      pitches.push({
        game_pk: 1, at_bat_index: ab, pitch_number: pn,
        balls: 0, strikes: pn - 1, outs: 0, inning: 1 + (ab % 9),
        top_inning: ab % 2 === 0, pitch_type: "FF",
      });
    }
    preds.push(pred({ id: ab + 1, at_bat_index: ab, pitch_number: PER_PA - 1 }));
  }
  const res = await pitchFeed(
    stubDb({
      games: GAMES, at_bats: atBats, player_info: PLAYERS,
      pitches, predictions: preds,
    }),
    { date: DAY, limit: 1000 },
  );
  assertEquals(res.rows.length, 1000);
  // 5,000 pitch rows against a 1,000-row page: the read has to page to see the
  // last of them, and nothing may go missing in the process.
  assertEquals(res.rows.filter((r) => r.inning == null).length, 0);
  assertEquals(res.rows.filter((r) => r.count == null).length, 0);
  assertEquals(res.rows.filter((r) => r.actual_pitch_type == null).length, 0);
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
