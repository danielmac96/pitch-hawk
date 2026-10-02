// The parts of settle that decide WHICH rows get graded, kept out of
// settle/index.ts (which starts a server on import) so they can be tested.
//
// Why this exists: settle used to grade "the 400 oldest ungraded rows" and
// nothing else. On 2026-09-11 four games crossed midnight still in progress,
// live-poll stopped following them at the Eastern date change, and the
// next-day re-ingest that would have marked them Final did not run. Their 400
// live win-prob rows could never grade, every run selected exactly those 400
// again, and pitch/at-bat grading stopped for 19 days with no error logged.
//
// Two defences:
//   walkQueue  pages past rows that cannot grade yet, so one stuck game can
//              never hold back the rows behind it;
//   isStale    names a game whose stored status cannot be true any more (not
//              final, yet its Eastern date has passed) so settle re-reads it
//              from MLB instead of waiting on it forever.

import { isFinal } from "./mlb.ts";

export interface QueueOpts {
  pageSize: number;   // rows fetched per page
  target: number;     // stop once this many rows are graded
  maxPages: number;   // hard bound on work per run, graded or not
}

// Pages through a queue ordered by id. `fetchPage(after, n)` returns up to n
// rows with id > after; `gradePage` grades what it can and returns how many.
export async function walkQueue<T extends { id: number }>(
  fetchPage: (afterId: number, limit: number) => Promise<T[]>,
  gradePage: (rows: T[]) => Promise<number>,
  opts: QueueOpts,
): Promise<{ graded: number; pages: number; lastId: number }> {
  let after = 0, graded = 0, pages = 0;
  while (pages < opts.maxPages && graded < opts.target) {
    const rows = await fetchPage(after, opts.pageSize);
    pages += 1;
    if (!rows.length) break;
    graded += await gradePage(rows);
    after = rows[rows.length - 1].id;
    if (rows.length < opts.pageSize) break;   // reached the end of the queue
  }
  return { graded, pages, lastId: after };
}

// A game that never happened: its calls are void, not pending forever.
// Suspended games are deliberately NOT here -- they resume and finish.
export function isVoidStatus(status: string | null | undefined): boolean {
  return status === "Postponed" || status === "Cancelled";
}

// Stored as not final, but its Eastern date is already over. live-poll only
// follows today's slate, so nothing will update this row by itself.
export function isStale(
  game: { status?: string | null; official_date?: string | null } | null,
  todayET: string,
): boolean {
  if (!game || !game.official_date) return false;
  if (isFinal(game.status) || isVoidStatus(game.status)) return false;
  return game.official_date < todayET;
}
