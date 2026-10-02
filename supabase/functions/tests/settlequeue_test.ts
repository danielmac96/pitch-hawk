// settle's queue: one game that can never grade must not stop every row
// behind it from grading. Regression for the 2026-09-11 stall, when 400
// live win-prob rows from four games stuck "In Progress" filled every batch
// and pitch/at-bat grading stopped for 19 days.
import { assertEquals } from "jsr:@std/assert@1";
import { isStale, isVoidStatus, walkQueue } from "../_shared/settlequeue.ts";

type Row = { id: number; gradable: boolean };

// A table of pending rows, oldest first, and a grader that grades only the
// gradable ones -- the shape settleTable has.
function fixture(rows: Row[]) {
  const pending = rows.slice();
  const fetchPage = (after: number, limit: number) =>
    Promise.resolve(pending.filter((r) => r.id > after).slice(0, limit));
  const gradePage = (page: Row[]) => {
    const ok = page.filter((r) => r.gradable);
    for (const r of ok) pending.splice(pending.indexOf(r), 1);
    return Promise.resolve(ok.length);
  };
  return { pending, fetchPage, gradePage };
}

Deno.test("walkQueue: a full page of ungradeable rows does not block the rows behind it", async () => {
  const rows: Row[] = [
    ...Array.from({ length: 4 }, (_, i) => ({ id: i + 1, gradable: false })),    // the stuck head
    ...Array.from({ length: 6 }, (_, i) => ({ id: i + 5, gradable: true })),
  ];
  const f = fixture(rows);
  const res = await walkQueue(f.fetchPage, f.gradePage, { pageSize: 4, target: 400, maxPages: 5 });
  assertEquals(res.graded, 6);
  assertEquals(f.pending.map((r) => r.id), [1, 2, 3, 4]);
});

Deno.test("walkQueue: stops at the target", async () => {
  const f = fixture(Array.from({ length: 20 }, (_, i) => ({ id: i + 1, gradable: true })));
  const res = await walkQueue(f.fetchPage, f.gradePage, { pageSize: 4, target: 8, maxPages: 10 });
  assertEquals(res.graded, 8);
  assertEquals(res.pages, 2);
});

Deno.test("walkQueue: stops after maxPages even if nothing grades", async () => {
  const f = fixture(Array.from({ length: 100 }, (_, i) => ({ id: i + 1, gradable: false })));
  const res = await walkQueue(f.fetchPage, f.gradePage, { pageSize: 4, target: 400, maxPages: 3 });
  assertEquals(res.graded, 0);
  assertEquals(res.pages, 3);
});

Deno.test("walkQueue: an empty queue costs one page", async () => {
  const f = fixture([]);
  const res = await walkQueue(f.fetchPage, f.gradePage, { pageSize: 4, target: 400, maxPages: 5 });
  assertEquals(res, { graded: 0, pages: 1, lastId: 0 });
});

Deno.test("isStale: not final after its Eastern date has passed", () => {
  assertEquals(isStale({ status: "In Progress", official_date: "2026-09-11" }, "2026-09-12"), true);
  assertEquals(isStale({ status: "Pre-Game", official_date: "2026-09-11" }, "2026-09-12"), true);
});

Deno.test("isStale: today's live game, finished games and void statuses are not stale", () => {
  assertEquals(isStale({ status: "In Progress", official_date: "2026-09-12" }, "2026-09-12"), false);
  assertEquals(isStale({ status: "Final", official_date: "2026-09-11" }, "2026-09-12"), false);
  assertEquals(isStale({ status: "Game Over", official_date: "2026-09-11" }, "2026-09-12"), false);
  assertEquals(isStale({ status: "Postponed", official_date: "2026-09-11" }, "2026-09-12"), false);
  assertEquals(isStale(null, "2026-09-12"), false);
});

Deno.test("isVoidStatus: postponed and cancelled games void their calls", () => {
  assertEquals(isVoidStatus("Postponed"), true);
  assertEquals(isVoidStatus("Cancelled"), true);
  assertEquals(isVoidStatus("Suspended: Rain"), false);   // resumes later; still gradable
  assertEquals(isVoidStatus("In Progress"), false);
});
