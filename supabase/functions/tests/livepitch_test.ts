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

import { countInto, pendingPositions } from "../_shared/livepitch.ts";

/** An at-bat's pitches, with the count each one LEFT behind. */
const ab = (...counts: [number, number][]) =>
  counts.map(([balls, strikes], i) => ({ pitch_number: i + 1, balls, strikes }));

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
