// Tests for the per-pitch position reconstruction.
//
// The behaviour under test is the one live-poll got wrong from the start:
// scoring once per poll rather than once per pitch. `two_pitches_in_one_poll`
// is the case that motivated the change — it is what happens whenever two
// pitches land inside a single 30-second interval, which at 15-20 seconds
// between pitches is routine rather than exceptional.
//
//   deno test supabase/functions/tests/

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  countInto, pendingAtBats, pendingPositions, posKey,
} from "../_shared/livepitch.ts";

/** An at-bat's pitches, with the count each one LEFT behind. */
const ab = (...counts: [number, number][]) =>
  counts.map(([balls, strikes], i) => ({ pitch_number: i + 1, balls, strikes }));

/** The same, stamped into a game at `abi`. */
const gameAb = (
  abi: number,
  counts: [number, number][],
  ids: { pitcher?: number; batter?: number } = {},
) =>
  ab(...counts).map((p) => ({
    ...p,
    at_bat_index: abi,
    pitcher_id: ids.pitcher ?? 100,
    batter_id: ids.batter ?? 200 + abi,
  }));

// ── countInto ─────────────────────────────────────────────────────────────

Deno.test("countInto: position 0 is always 0-0", () => {
  assertEquals(countInto(ab([1, 0], [1, 1]), 0), { balls: 0, strikes: 0 });
});

Deno.test("countInto: position k is the count pitch k left behind", () => {
  // ball, then called strike: going into pitch 3 the count is 1-1.
  const pitches = ab([1, 0], [1, 1]);
  assertEquals(countInto(pitches, 1), { balls: 1, strikes: 0 });
  assertEquals(countInto(pitches, 2), { balls: 1, strikes: 1 });
});

Deno.test("countInto: unknown pitch reads 0-0, never a fabricated count", () => {
  assertEquals(countInto(ab([1, 0]), 7), { balls: 0, strikes: 0 });
});

Deno.test("countInto: pitch order in the input does not matter", () => {
  const forward = ab([1, 0], [1, 1], [2, 1]);
  const shuffled = [forward[2], forward[0], forward[1]];
  assertEquals(countInto(shuffled, 2), countInto(forward, 2));
});

// ── pendingPositions ──────────────────────────────────────────────────────

Deno.test("pendingPositions: fresh at-bat yields only the first position", () => {
  const out = pendingPositions({ abPitches: [], curK: 0, done: new Set() });
  assertEquals(out, [{ k: 0, balls: 0, strikes: 0 }]);
});

Deno.test("two_pitches_in_one_poll: the skipped position is recovered", () => {
  // Poll A saw position 0 and scored it. Two pitches then landed inside one
  // 30s interval, so poll B sees curK=2. The old writer produced a single
  // batch at position 2 and position 1 was never scored at all.
  const out = pendingPositions({
    abPitches: ab([1, 0], [1, 1]),
    curK: 2,
    done: new Set([0]),
    curBalls: 1,
    curStrikes: 1,
  });
  assertEquals(out.map((p) => p.k), [1, 2]);
  // Position 1 was faced at 1-0 — the count pitch 1 left behind.
  assertEquals(out[0], { k: 1, balls: 1, strikes: 0 });
  assertEquals(out[1], { k: 2, balls: 1, strikes: 1 });
});

Deno.test("pendingPositions: nothing new to score returns empty", () => {
  const out = pendingPositions({
    abPitches: ab([1, 0], [1, 1]),
    curK: 2,
    done: new Set([0, 1, 2]),
  });
  assertEquals(out, []);
});

Deno.test("pendingPositions: oldest first, so rows land in pitch order", () => {
  const out = pendingPositions({
    abPitches: ab([0, 1], [0, 2], [1, 2]),
    curK: 3,
    done: new Set(),
  });
  assertEquals(out.map((p) => p.k), [0, 1, 2, 3]);
});

Deno.test("pendingPositions: the live position uses currentPlay's count", () => {
  // currentPlay is authoritative for now; the pitch rows may lag it.
  const out = pendingPositions({
    abPitches: ab([1, 0]),
    curK: 1,
    done: new Set(),
    curBalls: 2,
    curStrikes: 1,
  });
  assertEquals(out[out.length - 1], { k: 1, balls: 2, strikes: 1 });
});

Deno.test("pendingPositions: a game picked up mid-PA scores the whole at-bat", () => {
  const out = pendingPositions({
    abPitches: ab([1, 0], [1, 1], [2, 1], [2, 2]),
    curK: 4,
    done: new Set(),
  });
  assertEquals(out.map((p) => p.k), [0, 1, 2, 3, 4]);
});

Deno.test("pendingPositions: the cap bounds a post-outage pickup", () => {
  const out = pendingPositions({
    abPitches: [], curK: 500, done: new Set(), cap: 20,
  });
  assertEquals(out.length, 21);
  assertEquals(out[0].k, 480);
  assertEquals(out[out.length - 1].k, 500);
});

Deno.test("pendingPositions: idempotent — a re-poll writes nothing twice", () => {
  const params = {
    abPitches: ab([1, 0], [1, 1]),
    curK: 2,
    done: new Set<number>(),
  };
  const first = pendingPositions(params);
  assert(first.length > 0);
  // Feed the first pass's output back in as stored, as live-poll does.
  const second = pendingPositions({
    ...params, done: new Set(first.map((p) => p.k)),
  });
  assertEquals(second, []);
});

Deno.test("pendingPositions: a non-numeric pitch count degrades to position 0", () => {
  const out = pendingPositions({
    abPitches: [], curK: NaN as unknown as number, done: new Set(),
  });
  assertEquals(out.map((p) => p.k), [0]);
});

// ── pendingAtBats ─────────────────────────────────────────────────────────
//
// pendingPositions only ever looked at the at-bat currently batting, and
// live-poll skipped the poll outright when the last play was complete. These
// cover the two holes that left: a PA's last position, and a PA that began and
// ended between two polls.

const seq = (work: ReturnType<typeof pendingAtBats>) =>
  work.flatMap((w) => w.positions.map((p) => `${w.at_bat_index}:${p.k}`));

Deno.test("pendingAtBats: a completed at-bat stops at its last thrown pitch", () => {
  // 3 pitches means positions 0,1,2 — each a call about a pitch that landed.
  // There is no position 3: the PA is over, so no next pitch exists to predict.
  const work = pendingAtBats({
    pitches: gameAb(4, [[1, 0], [1, 1], [1, 2]]),
    openAbi: null,
    done: new Set(),
  });
  assertEquals(seq(work), ["4:0", "4:1", "4:2"]);
  assertEquals(work[0].open, false);
});

Deno.test("pendingAtBats: the open at-bat keeps its forward position", () => {
  const work = pendingAtBats({
    pitches: gameAb(4, [[1, 0], [1, 1]]),
    openAbi: 4,
    openBalls: 1,
    openStrikes: 1,
    done: new Set(),
  });
  // Position 2 is the live read on the pitch not yet thrown.
  assertEquals(seq(work), ["4:0", "4:1", "4:2"]);
  assertEquals(work[0].open, true);
  assertEquals(work[0].positions[2], { k: 2, balls: 1, strikes: 1 });
});

Deno.test("last_position_of_a_finished_pa: recovered once the PA completes", () => {
  // The hole this closes. A 3-pitch PA where polls landed at positions 0 and 1
  // only; the PA then ended, so the old code returned early on is_complete and
  // position 2 — the call about the pitch that ended the at-bat — was never
  // written. 38.8% of last positions were missing on 2026-08-14.
  const work = pendingAtBats({
    pitches: gameAb(9, [[0, 1], [0, 2], [0, 2]]),
    openAbi: 10,
    done: new Set([posKey(9, 0), posKey(9, 1)]),
  });
  const ab9 = work.find((w) => w.at_bat_index === 9);
  assertEquals(ab9?.positions.map((p) => p.k), [2]);
  // Faced 0-2, the count pitch 2 left behind.
  assertEquals(ab9?.positions[0], { k: 2, balls: 0, strikes: 2 });
});

Deno.test("at_bat_between_polls: a PA that began and ended unseen is recovered", () => {
  // 93 at-bats on 2026-08-14 carried no prediction at all because nothing ever
  // looked at them again. A one-pitch PA is the common shape.
  const work = pendingAtBats({
    pitches: [...gameAb(11, [[0, 0]]), ...gameAb(12, [[1, 0]])],
    openAbi: 12,
    openBalls: 1,
    openStrikes: 0,
    done: new Set([posKey(12, 0)]),
  });
  assertEquals(seq(work), ["11:0", "12:1"]);
});

Deno.test("pendingAtBats: at-bats come back oldest first", () => {
  const work = pendingAtBats({
    pitches: [
      ...gameAb(7, [[1, 0]]),
      ...gameAb(5, [[0, 1], [0, 2]]),
      ...gameAb(6, [[1, 0], [2, 0]]),
    ],
    openAbi: 7,
    done: new Set(),
  });
  assertEquals(seq(work), ["5:0", "5:1", "6:0", "6:1", "7:0", "7:1"]);
});

Deno.test("pendingAtBats: lookback bounds how far back a poll sweeps", () => {
  const pitches = [0, 1, 2, 3, 4, 5, 6].flatMap((i) => gameAb(i, [[1, 0]]));
  const work = pendingAtBats({ pitches, openAbi: 6, done: new Set(), lookback: 3 });
  // Newest is 6, so only 4, 5 and 6 are swept. Older holes are the backfill's.
  assertEquals([...new Set(work.map((w) => w.at_bat_index))], [4, 5, 6]);
});

Deno.test("pendingAtBats: a rolled PA with no pitches still gets its first call", () => {
  // MLB posts the next play before its first pitch — the moment the first-pitch
  // call is supposed to be made.
  const work = pendingAtBats({
    pitches: gameAb(2, [[1, 0], [1, 1]]),
    openAbi: 3,
    done: new Set([posKey(2, 0), posKey(2, 1)]),
  });
  assertEquals(seq(work), ["3:0"]);
  assertEquals(work[0].open, true);
  // No pitch has been thrown to this batter yet, so identity must come from
  // currentPlay — the sweep reports null rather than guessing.
  assertEquals(work[0].batter_id, null);
});

Deno.test("pendingAtBats: identity comes from the at-bat's own first pitch", () => {
  const work = pendingAtBats({
    pitches: [
      ...gameAb(1, [[1, 0]], { pitcher: 11, batter: 21 }),
      ...gameAb(2, [[1, 0]], { pitcher: 11, batter: 22 }),
    ],
    openAbi: 2,
    done: new Set(),
  });
  assertEquals(work.map((w) => w.batter_id), [21, 22]);
  assert(work.every((w) => w.pitcher_id === 11));
});

Deno.test("pendingAtBats: idempotent — a re-poll writes nothing twice", () => {
  const params = {
    pitches: [...gameAb(3, [[1, 0], [1, 1]]), ...gameAb(4, [[0, 1]])],
    openAbi: 4,
    done: new Set<string>(),
  };
  const first = pendingAtBats(params);
  assert(first.length > 0);
  const done = new Set(
    first.flatMap((w) => w.positions.map((p) => posKey(w.at_bat_index, p.k))),
  );
  assertEquals(pendingAtBats({ ...params, done }), []);
});

Deno.test("every_thrown_pitch_gets_a_position: full sweep of a clean game", () => {
  // The end-to-end invariant. Coverage was 60.5% on 2026-08-14; the sweep is
  // what makes it total, independent of when the polls happened to land.
  const shape: [number, [number, number][]][] = [
    [0, [[1, 0], [1, 1], [1, 2]]],
    [1, [[0, 1]]],
    [2, [[1, 0], [2, 0], [2, 1], [2, 2]]],
  ];
  const pitches = shape.flatMap(([abi, counts]) => gameAb(abi, counts));
  const work = pendingAtBats({ pitches, openAbi: null, done: new Set(), lookback: 99 });
  const positions = work.reduce((n, w) => n + w.positions.length, 0);
  assertEquals(positions, pitches.length);
});
