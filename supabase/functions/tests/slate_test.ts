// resolveSlate: the board's "which day" answer. The date logic itself is SQL
// (slate_date(), migration 20261002000002); what lives here is the contract
// that a failed lookup falls back to today and never hides a day with games.
import { assertEquals } from "jsr:@std/assert@1";
import { resolveSlate } from "../_shared/slate.ts";
import { mlbToday } from "../_shared/mlb.ts";

// deno-lint-ignore no-explicit-any
const fakeDb = (rpc: () => Promise<{ data: any; error: any }>) => ({ rpc }) as any;

Deno.test("an off day resolves to the next slate", async () => {
  const s = await resolveSlate(fakeDb(() =>
    Promise.resolve({ data: [{ slate: "2026-10-03", is_today: false }], error: null })
  ));
  assertEquals(s, { date: "2026-10-03", isToday: false });
});

Deno.test("a game day resolves to today", async () => {
  const today = mlbToday();
  const s = await resolveSlate(fakeDb(() =>
    Promise.resolve({ data: [{ slate: today, is_today: true }], error: null })
  ));
  assertEquals(s, { date: today, isToday: true });
});

Deno.test("an rpc error falls back to today", async () => {
  const s = await resolveSlate(fakeDb(() =>
    Promise.resolve({ data: null, error: { message: "function slate_date does not exist" } })
  ));
  assertEquals(s, { date: mlbToday(), isToday: true });
});

Deno.test("a thrown rpc (network) falls back to today", async () => {
  const s = await resolveSlate(fakeDb(() => Promise.reject(new Error("fetch failed"))));
  assertEquals(s, { date: mlbToday(), isToday: true });
});

Deno.test("an empty result falls back to today", async () => {
  const s = await resolveSlate(fakeDb(() => Promise.resolve({ data: [], error: null })));
  assertEquals(s, { date: mlbToday(), isToday: true });
});
