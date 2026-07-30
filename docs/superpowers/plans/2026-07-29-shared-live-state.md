# Shared Live State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the Data Feed and the Live Board's at-bat history from persisted, server-graded predictions so every user sees the same state, and a mid-game arrival sees everything that already happened.

**Architecture:** Grading logic moves out of `settle` into `_shared/grade.ts` and becomes the single source of truth, consumed by `settle`, `live-poll`, and the new read endpoints. `live-poll` grades each pitch inline as it ingests the next one, so grades are near-instant instead of up to 10 minutes behind. Three new CDN-cached endpoints serve what the frontend currently accumulates in memory, and the client-side accumulation is deleted rather than ported.

**Tech Stack:** Deno / TypeScript (Supabase Edge Functions), vanilla JS frontend, Supabase Postgres 17, `deno test`.

## Global Constraints

- **Supabase project ref:** `gfxpchtyncgsczqdvohr`. Edge functions are Deno; run typechecks with `deno check` and tests with `deno test`.
- **No new grading implementation.** Exactly one copy of the rules may exist, in `supabase/functions/_shared/grade.ts`. Adding a third copy anywhere — including a read endpoint — is a plan violation. The frontend copy is **deleted**, not refactored.
- **`predictions` retention is 21 days** (`prune_predictions`). The feed reaches back 21 days and no further; this must be stated in the UI, never rendered as a blank panel.
- Every new endpoint is registered in the `TTL` map in `supabase/functions/api/index.ts` and served through the existing `cached()` wrapper. **One shared state for all users is a property of the CDN cache** — every client requests the same URL and receives a byte-identical payload.
- Mutating functions require `x-cron-secret` via `requireCronSecret`. Read endpoints on `api` stay public and read-only.
- Frontend has no build step and no framework: vanilla ES2019-compatible JS, `esc()` for all interpolated text, `fetchJson()` for all requests.
- Existing conventions: `svc()` for the service-role client, `logRun()` for job observability, `upsertChunked()` for batch writes.
- Migration filenames: `supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql`.

## Independence from the warehouse plan

This plan shares no code with `2026-07-29-warehouse-and-capacity.md` and can ship before, after, or alongside it.

**One soft dependency:** `GET /accuracy` is better with `market_baselines`, which the warehouse plan's Task 13 creates. Task 6 here builds the endpoint to **degrade gracefully** when that table is absent or empty — it returns accuracy without baselines and sets `"baselines_available": false`. Nothing blocks.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `supabase/functions/_shared/grade.ts` | the only implementation of the grading rules |
| `supabase/functions/_shared/grade_test.ts` | Deno tests for those rules |
| `supabase/functions/_shared/feed.ts` | assemble feed payloads from pitches / at_bats / predictions |
| `supabase/functions/_shared/feed_test.ts` | Deno tests for payload assembly |
| `supabase/migrations/20260801000001_bulk_grading.sql` | `grade_predictions` / `grade_picks` RPCs |

**Modified**

| File | Change |
|---|---|
| `supabase/functions/settle/index.ts` | import from `_shared/grade.ts`; bulk-grade via RPC; raise batch |
| `supabase/functions/live-poll/index.ts` | grade the prior pitch inline each tick |
| `supabase/functions/api/index.ts` | `/feed/{game_pk}`, `/feed/today`, `/accuracy` |
| `frontend/pitchhawk-data.js` | add `loadFeed`; delete grading from `gradedPred` |
| `frontend/pitchhawk.js` | delete client accumulation; hydrate from `/feed` |

---

## Task 1: Extract the grading rules into `_shared/grade.ts`

**Files:**
- Create: `supabase/functions/_shared/grade.ts`, `supabase/functions/_shared/grade_test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface Grade { result: string; profit: number }`
  - `interface GradeRow { market: string; recommendation: string | null; line: number | null; price: number | null; units: number | null; at_bat_index: number | null; pitch_number: number | null }`
  - `interface PitchLike { at_bat_index: number | null; pitch_number: number | null; start_speed: number | null; result_category: string | null }`
  - `interface AtBatLike { at_bat_index: number; result: string | null; pitch_count: number | null }`
  - `winProfit(price: number | null | undefined, units?: number): number`
  - `nextPitch(pitches: PitchLike[], abi: number | null, pn: number | null): PitchLike | null`
  - `gradeRow(row: GradeRow, pitches: PitchLike[], absByIdx: Map<number, AtBatLike>, gameLive: boolean, finalScores: { home: number | null; away: number | null } | null): Grade | null`

This is a **pure extraction**. The logic is copied verbatim from `settle/index.ts:9–81`. Behaviour must not change; Task 2 proves it by leaving `settle`'s output identical.

- [ ] **Step 1: Write the failing test**

Create `supabase/functions/_shared/grade_test.ts`:

```ts
// Deno tests for the grading rules. Run: deno test supabase/functions/_shared/
//
// These rules are the single source of truth for whether a prediction or pick
// won. They are consumed by settle (backstop), live-poll (inline), and the feed
// endpoints (display). A change here changes the public win/loss record.
import { assertEquals } from "jsr:@std/assert";
import { AtBatLike, gradeRow, nextPitch, PitchLike, winProfit } from "./grade.ts";

const P = (abi: number, pn: number, speed: number | null, cat: string | null): PitchLike =>
  ({ at_bat_index: abi, pitch_number: pn, start_speed: speed, result_category: cat });

const abs = (rows: AtBatLike[]) => new Map(rows.map((a) => [a.at_bat_index, a]));

Deno.test("winProfit pays out plus and minus prices correctly", () => {
  assertEquals(winProfit(100), 1);
  assertEquals(winProfit(150), 1.5);
  assertEquals(winProfit(-200), 0.5);
  assertEquals(winProfit(-110), 0.909);
  // No price means a flat even-money unit (ab_result has no real prop price).
  assertEquals(winProfit(null), 1);
  assertEquals(winProfit(null, 2), 2);
});

Deno.test("nextPitch finds the next pitch across an at-bat boundary", () => {
  const pitches = [P(0, 1, 95, "ball"), P(0, 2, 96, "strike_foul"), P(1, 1, 94, "ball")];
  assertEquals(nextPitch(pitches, 0, 1)?.pitch_number, 2);
  // Last pitch of AB 0 -> first pitch of AB 1.
  assertEquals(nextPitch(pitches, 0, 2)?.at_bat_index, 1);
  assertEquals(nextPitch(pitches, 1, 1), null);
});

Deno.test("nextPitch treats a null position as before everything", () => {
  const pitches = [P(0, 1, 95, "ball")];
  assertEquals(nextPitch(pitches, null, null)?.pitch_number, 1);
});

Deno.test("a row with no recommendation is void", () => {
  const g = gradeRow(
    { market: "pitch_result", recommendation: null, line: null, price: null,
      units: 1, at_bat_index: 0, pitch_number: 0 },
    [], abs([]), false, null);
  assertEquals(g, { result: "void", profit: 0 });
});

Deno.test("pitch_result grades against the next pitch's category", () => {
  const pitches = [P(0, 1, 95, "ball")];
  const row = { market: "pitch_result", recommendation: "ball", line: null,
                price: null, units: 1, at_bat_index: 0, pitch_number: 0 };
  assertEquals(gradeRow(row, pitches, abs([]), true, null),
               { result: "win", profit: 1 });
  assertEquals(gradeRow({ ...row, recommendation: "strike_foul" }, pitches,
                        abs([]), true, null),
               { result: "loss", profit: -1 });
});

Deno.test("pitch_speed_ou grades over/under against the next pitch's speed", () => {
  const pitches = [P(0, 1, 96.4, "ball")];
  const row = { market: "pitch_speed_ou", recommendation: "over", line: 94.5,
                price: 100, units: 1, at_bat_index: 0, pitch_number: 0 };
  assertEquals(gradeRow(row, pitches, abs([]), true, null),
               { result: "win", profit: 1 });
  assertEquals(gradeRow({ ...row, recommendation: "under" }, pitches,
                        abs([]), true, null),
               { result: "loss", profit: -1 });
});

Deno.test("a pending pitch market stays ungraded while the game is live", () => {
  const row = { market: "pitch_result", recommendation: "ball", line: null,
                price: null, units: 1, at_bat_index: 5, pitch_number: 3 };
  // No later pitch exists yet -> null means "come back later".
  assertEquals(gradeRow(row, [], abs([]), true, null), null);
  // Same row once the game is final -> void, because it never resolved.
  assertEquals(gradeRow(row, [], abs([]), false, null),
               { result: "void", profit: 0 });
});

Deno.test("ab_result grades against the at-bat's result", () => {
  const a = abs([{ at_bat_index: 4, result: "strikeout", pitch_count: 5 }]);
  const row = { market: "ab_result", recommendation: "strikeout", line: null,
                price: null, units: 1, at_bat_index: 4, pitch_number: null };
  assertEquals(gradeRow(row, [], a, true, null), { result: "win", profit: 1 });
  assertEquals(gradeRow({ ...row, recommendation: "walk" }, [], a, true, null),
               { result: "loss", profit: -1 });
});

Deno.test("ab_pitches_ou pushes when the count lands exactly on the line", () => {
  const a = abs([{ at_bat_index: 4, result: "hit", pitch_count: 5 }]);
  const row = { market: "ab_pitches_ou", recommendation: "over", line: 5,
                price: 100, units: 1, at_bat_index: 4, pitch_number: null };
  assertEquals(gradeRow(row, [], a, true, null), { result: "push", profit: 0 });
  assertEquals(gradeRow({ ...row, line: 4.5 }, [], a, true, null),
               { result: "win", profit: 1 });
  assertEquals(gradeRow({ ...row, line: 5.5 }, [], a, true, null),
               { result: "loss", profit: -1 });
});

Deno.test("game_moneyline needs final scores and pushes on a tie", () => {
  const row = { market: "game_moneyline", recommendation: "home", line: null,
                price: -150, units: 1, at_bat_index: null, pitch_number: null };
  assertEquals(gradeRow(row, [], abs([]), true, null), null);
  assertEquals(gradeRow(row, [], abs([]), false, { home: 5, away: 3 }),
               { result: "win", profit: 0.667 });
  assertEquals(gradeRow(row, [], abs([]), false, { home: 3, away: 5 }),
               { result: "loss", profit: -1 });
  assertEquals(gradeRow(row, [], abs([]), false, { home: 4, away: 4 }),
               { result: "push", profit: 0 });
});

Deno.test("a missing speed or line voids a pitch_speed_ou row", () => {
  const row = { market: "pitch_speed_ou", recommendation: "over", line: null,
                price: 100, units: 1, at_bat_index: 0, pitch_number: 0 };
  assertEquals(gradeRow(row, [P(0, 1, 95, "ball")], abs([]), true, null),
               { result: "void", profit: 0 });
  assertEquals(gradeRow({ ...row, line: 94.5 },
                        [P(0, 1, null, "ball")], abs([]), true, null),
               { result: "void", profit: 0 });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno test supabase/functions/_shared/grade_test.ts`
Expected: FAIL — `Module not found "./grade.ts"`

- [ ] **Step 3: Write the implementation**

Create `supabase/functions/_shared/grade.ts`:

```ts
// The grading rules — the single source of truth for whether a prediction or a
// pick won, and by how much.
//
// Extracted verbatim from settle/index.ts. Three consumers now share it:
//   settle     — backstop for game-end markets and anything live-poll missed
//   live-poll  — grades each pitch inline as the next one arrives
//   api /feed  — resolves the actual outcome for display
//
// There must never be a second implementation. A copy of these rules used to
// live in the frontend (gradedPred in pitchhawk-data.js) and drifted from the
// server's answer; that copy was deleted rather than ported.

export interface Grade {
  result: string;
  profit: number;
}

export interface GradeRow {
  market: string;
  recommendation: string | null;
  line: number | null;
  price: number | null;
  units: number | null;
  at_bat_index: number | null;
  pitch_number: number | null;
}

export interface PitchLike {
  at_bat_index: number | null;
  pitch_number: number | null;
  start_speed: number | null;
  result_category: string | null;
}

export interface AtBatLike {
  at_bat_index: number;
  result: string | null;
  pitch_count: number | null;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

// A null price grades flat even-money (±1 unit): ab_result picks have no real
// prop price, so "beats the league base rate" is not enough — see the
// AB_PICK_MIN_PROB note in live-poll.
export function winProfit(price: number | null | undefined, units = 1): number {
  if (price == null) return units;
  return price > 0
    ? round3((price / 100) * units)
    : round3((100 / Math.abs(price)) * units);
}

// The next pitch after position (abi, pn) in game order. A null position sorts
// before everything, so it returns the game's first pitch.
export function nextPitch(
  pitches: PitchLike[], abi: number | null, pn: number | null,
): PitchLike | null {
  const a = abi ?? -1, p = pn ?? -1;
  const later = pitches.filter((x) =>
    x.at_bat_index != null && x.pitch_number != null &&
    (x.at_bat_index > a || (x.at_bat_index === a && x.pitch_number > p))
  );
  if (!later.length) return null;
  return later.reduce((m, x) =>
    (x.at_bat_index! < m.at_bat_index! ||
     (x.at_bat_index === m.at_bat_index && x.pitch_number! < m.pitch_number!))
      ? x
      : m
  );
}

// Returns null for "not resolvable yet" — the caller leaves the row pending and
// tries again later. Any non-null Grade is final.
export function gradeRow(
  row: GradeRow,
  pitches: PitchLike[],
  absByIdx: Map<number, AtBatLike>,
  gameLive: boolean,
  finalScores: { home: number | null; away: number | null } | null,
): Grade | null {
  const rec = row.recommendation;
  if (!rec) return { result: "void", profit: 0 };
  const units = Number(row.units ?? 1);

  if (row.market === "game_moneyline") {
    if (!finalScores || finalScores.home == null || finalScores.away == null) {
      return null;
    }
    if (finalScores.home === finalScores.away) return { result: "push", profit: 0 };
    const winner = finalScores.home > finalScores.away ? "home" : "away";
    return rec === winner
      ? { result: "win", profit: winProfit(row.price, units) }
      : { result: "loss", profit: -units };
  }

  if (row.market === "pitch_speed_ou" || row.market === "pitch_result") {
    const nxt = nextPitch(pitches, row.at_bat_index, row.pitch_number);
    if (!nxt) return gameLive ? null : { result: "void", profit: 0 };
    let actual: string | null;
    if (row.market === "pitch_speed_ou") {
      if (nxt.start_speed == null || row.line == null) {
        return { result: "void", profit: 0 };
      }
      actual = Number(nxt.start_speed) > Number(row.line) ? "over" : "under";
    } else {
      actual = nxt.result_category;
      if (!actual) return { result: "void", profit: 0 };
    }
    return rec === actual
      ? { result: "win", profit: winProfit(row.price, units) }
      : { result: "loss", profit: -units };
  }

  if (row.market === "ab_result" || row.market === "ab_pitches_ou") {
    const ab = absByIdx.get(row.at_bat_index ?? 0);
    if (!ab) return gameLive ? null : { result: "void", profit: 0 };
    if (row.market === "ab_result") {
      if (!ab.result) return { result: "void", profit: 0 };
      return rec === ab.result
        ? { result: "win", profit: winProfit(row.price, units) }
        : { result: "loss", profit: -units };
    }
    if (ab.pitch_count == null || row.line == null) {
      return { result: "void", profit: 0 };
    }
    if (Number(ab.pitch_count) === Number(row.line)) {
      return { result: "push", profit: 0 };
    }
    const actual = Number(ab.pitch_count) > Number(row.line) ? "over" : "under";
    return rec === actual
      ? { result: "win", profit: winProfit(row.price, units) }
      : { result: "loss", profit: -units };
  }

  return null;
}

// Terminal game status. Mirrors isFinal() in mlb.ts; duplicated here so the
// grading module has no import beyond itself.
export function isFinalStatus(status: string | null | undefined): boolean {
  return !!status &&
    (status.startsWith("Final") || status === "Game Over" ||
     status === "Completed Early");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `deno test supabase/functions/_shared/grade_test.ts`
Expected: PASS, 11 tests

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/grade.ts supabase/functions/_shared/grade_test.ts
git commit -m "feat(edge): extract grading rules into _shared/grade.ts with tests"
```

---

## Task 2: `settle` uses the shared module and grades in bulk

**Files:**
- Create: `supabase/migrations/20260801000001_bulk_grading.sql`
- Modify: `supabase/functions/settle/index.ts`

**Interfaces:**
- Consumes: `_shared/grade.ts`
- Produces: SQL functions `grade_predictions(p jsonb) -> int` and `grade_picks(p jsonb) -> int`

The current bottleneck is not `BATCH = 400` — it is **one `UPDATE` round trip per row**. 92,398 ungraded rows at one request each is the reason the backlog crawls.

- [ ] **Step 1: Write the bulk grading migration**

Create `supabase/migrations/20260801000001_bulk_grading.sql`:

```sql
-- Bulk grading for the settle job.
--
-- settle previously issued one UPDATE per row. At 92,398 ungraded predictions
-- (measured 2026-07-29) that is 92,398 round trips, which is why the backlog
-- drained at a crawl rather than because the 400-row batch was too small.
--
-- These take the whole batch as a jsonb array and apply it in one statement.

create or replace function grade_predictions(p jsonb)
returns int language plpgsql security definer
set search_path = public, pg_temp as $$
declare n int;
begin
    update predictions t
    set result = g.result,
        profit_units = g.profit,
        graded_at = now()
    from jsonb_to_recordset(p) as g(id bigint, result text, profit numeric)
    where t.id = g.id;
    get diagnostics n = row_count;
    return n;
end $$;

create or replace function grade_picks(p jsonb)
returns int language plpgsql security definer
set search_path = public, pg_temp as $$
declare n int;
begin
    update picks t
    set status = g.result,
        profit_units = g.profit,
        graded_at = now()
    from jsonb_to_recordset(p) as g(id bigint, result text, profit numeric)
    where t.id = g.id;
    get diagnostics n = row_count;
    return n;
end $$;

-- Grading writes the public win/loss record; nothing public may call these.
revoke execute on function grade_predictions(jsonb) from anon, authenticated, public;
revoke execute on function grade_picks(jsonb) from anon, authenticated, public;
```

- [ ] **Step 2: Verify the migration replays on a clean Postgres**

Run: `git add supabase/migrations/20260801000001_bulk_grading.sql && git commit -m "feat(db): bulk grading RPCs" && git push`
Expected: the `migrations` job in `ci.yml` passes.

- [ ] **Step 3: Apply to production**

Apply via the Supabase MCP `apply_migration`, name `bulk_grading`.

Confirm:

```sql
select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and proname in ('grade_predictions', 'grade_picks');
```

Expected: two rows.

- [ ] **Step 4: Rewrite `settle/index.ts`**

Replace the whole file with:

```ts
// Settlement — grades pending predictions AND picks against real outcomes.
// The rules live in _shared/grade.ts and are shared with live-poll and the feed
// endpoints; this job is the backstop for game-end markets and for anything
// live-poll did not catch inline.
// Requires x-cron-secret. Scheduled every 10 minutes via pg_cron.

import { json, logRun, requireCronSecret, svc } from "../_shared/db.ts";
import {
  AtBatLike, gradeRow, isFinalStatus, PitchLike,
} from "../_shared/grade.ts";

// Raised from 400 now that grading is one round trip per game rather than per
// row. The bound that matters is the edge function's wall-clock budget.
const BATCH = 2000;

async function settleTable(
  table: "predictions" | "picks",
): Promise<{ graded: number; errors: string[] }> {
  const db = svc();
  const errors: string[] = [];
  const sel = table === "picks"
    ? "id,game_pk,at_bat_index,market,recommendation,line,price,units,status"
    : "id,game_pk,at_bat_index,pitch_number,market,recommendation,line,price,units,result";
  let q = db.from(table).select(sel).order("id").limit(BATCH);
  q = table === "picks" ? q.eq("status", "pending") : q.is("result", "null");
  const { data: pending, error } = await q;
  if (error) return { graded: 0, errors: [error.message] };
  if (!pending?.length) return { graded: 0, errors: [] };

  let graded = 0;
  const gamePks = [...new Set(pending.map((r: any) => r.game_pk).filter(Boolean))];
  for (const gamePk of gamePks) {
    const rows = pending.filter((r: any) => r.game_pk === gamePk);
    const [{ data: pitches }, { data: abRows }, { data: game }] = await Promise.all([
      db.from("pitches").select("at_bat_index,pitch_number,start_speed,result_category")
        .eq("game_pk", gamePk).order("at_bat_index").order("pitch_number").limit(5000),
      db.from("at_bats").select("at_bat_index,result,pitch_count").eq("game_pk", gamePk).limit(500),
      db.from("games").select("status,home_score,away_score").eq("game_pk", gamePk).maybeSingle(),
    ]);
    const absByIdx = new Map<number, AtBatLike>();
    for (const a of abRows ?? []) {
      if (a.at_bat_index != null) absByIdx.set(a.at_bat_index, a as AtBatLike);
    }
    const isFinal = isFinalStatus(game?.status);
    const finalScores = isFinal
      ? { home: game?.home_score ?? null, away: game?.away_score ?? null }
      : null;

    // Build the whole batch, then apply it in one statement.
    const batch: { id: number; result: string; profit: number }[] = [];
    for (const r of rows as any[]) {
      const pnRow = table === "picks" ? { ...r, pitch_number: null } : r;
      const grade = gradeRow(pnRow, (pitches ?? []) as PitchLike[], absByIdx,
                             !isFinal, finalScores);
      if (!grade) continue;
      batch.push({ id: r.id, result: grade.result, profit: grade.profit });
    }
    if (!batch.length) continue;

    const rpc = table === "picks" ? "grade_picks" : "grade_predictions";
    const { data: n, error: gerr } = await db.rpc(rpc, { p: batch });
    if (gerr) errors.push(`${rpc} ${gamePk}: ${gerr.message}`);
    else graded += Number(n ?? 0);
  }
  return { graded, errors };
}

Deno.serve(async (req) => {
  const denied = await requireCronSecret(req);
  if (denied) return denied;
  const startedAt = new Date().toISOString();
  const preds = await settleTable("predictions");
  const picks = await settleTable("picks");
  const detail = {
    predictions_graded: preds.graded,
    picks_graded: picks.graded,
    errors: [...preds.errors, ...picks.errors].slice(0, 10),
  };
  await logRun("settle", startedAt, detail.errors.length === 0, detail);
  return json(detail);
});
```

- [ ] **Step 5: Typecheck**

Run: `deno check supabase/functions/settle/index.ts`
Expected: no errors.

- [ ] **Step 6: Record the backlog, deploy, then confirm it drains faster**

Before:

```sql
select count(*) filter (where result is null) as ungraded from predictions;
```

Deploy `settle` via the Supabase MCP `deploy_edge_function`.

After two cron ticks (~20 minutes), re-run the query.

**Acceptance:** the ungraded count falls by more than 2,000 across two ticks.
The old code could grade at most 400 per tick per table; if the drop is ≤800,
the bulk path is not being taken — check `ingest_runs` for `grade_predictions`
errors:

```sql
select detail from ingest_runs where job = 'settle'
order by id desc limit 3;
```

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/settle/index.ts
git commit -m "perf(settle): bulk grading via RPC, shared rules from _shared/grade.ts

Replaces one UPDATE per row with one statement per game. Batch raised 400 ->
2000 now that round trips are no longer the bound."
```

---

## Task 3: `live-poll` grades the prior pitch inline

**Files:**
- Modify: `supabase/functions/live-poll/index.ts`

`live-poll` already fetches the full play-by-play for every live game each tick. Grading the predictions it wrote at earlier positions needs no extra MLB or pitch fetch — only the ungraded prediction rows for that game.

- [ ] **Step 1: Add the import**

In `supabase/functions/live-poll/index.ts`, add to the existing import block:

```ts
import {
  AtBatLike, gradeRow, PitchLike,
} from "../_shared/grade.ts";
```

- [ ] **Step 2: Add the inline grading helper**

Add near the bottom of the file, beside `publishPick`:

```ts
// Grade the predictions this game already has, using the play-by-play we just
// fetched. Without this the board waits up to 10 minutes for the settle cron,
// which is the difference between a live feed and a delayed one.
//
// The game is treated as live (gameLive=true), so anything not yet resolvable
// stays pending rather than being voided — settle finalises it once the game
// ends.
async function gradeInline(
  gamePk: number, pitches: PitchLike[], atBats: AtBatLike[],
): Promise<number> {
  const db = svc();
  const { data: pending } = await db.from("predictions")
    .select("id,game_pk,at_bat_index,pitch_number,market,recommendation,line,price,units")
    .eq("game_pk", gamePk).is("result", "null").limit(500);
  if (!pending?.length) return 0;

  const absByIdx = new Map<number, AtBatLike>();
  for (const a of atBats) {
    if (a.at_bat_index != null) absByIdx.set(a.at_bat_index, a);
  }

  const batch: { id: number; result: string; profit: number }[] = [];
  for (const row of pending as any[]) {
    const grade = gradeRow(row, pitches, absByIdx, true, null);
    if (!grade) continue;
    batch.push({ id: row.id, result: grade.result, profit: grade.profit });
  }
  if (!batch.length) return 0;

  const { data: n, error } = await db.rpc("grade_predictions", { p: batch });
  if (error) throw new Error(`grade_predictions: ${error.message}`);
  return Number(n ?? 0);
}
```

- [ ] **Step 3: Call it once per game and count the result**

In the `Deno.serve` handler, add a counter next to the existing ones
(currently `let newPitchStates = 0, predictionsWritten = 0, picksWritten = 0;`):

```ts
    let newPitchStates = 0, predictionsWritten = 0, picksWritten = 0, gradedInline = 0;
```

Then, inside the `for (const g of liveGames)` loop, immediately **after** the
`upsertChunked("at_bats", …)` call and **before** the
`if (currentPlay?.is_complete) continue;` early exit — so grading still happens
on a tick where the at-bat has just ended:

```ts
        // Grade earlier predictions for this game from the play-by-play in hand.
        // Placed before the is_complete early-return so the last pitch of a
        // completed at-bat still grades on this tick.
        try {
          gradedInline += await gradeInline(
            g.game_pk, pitchRows as PitchLike[], atBats as AtBatLike[]);
        } catch (e) {
          errors.push(`grade ${g.game_pk}: ${String(e).slice(0, 120)}`);
        }
```

And add to the `detail` object beside the other counters:

```ts
    detail.graded_inline = gradedInline;
```

- [ ] **Step 4: Typecheck**

Run: `deno check supabase/functions/live-poll/index.ts`
Expected: no errors.

- [ ] **Step 5: Deploy and verify during a live game**

Deploy `live-poll` via the Supabase MCP `deploy_edge_function`.

During a game window:

```sql
select detail from ingest_runs where job = 'live-poll'
order by id desc limit 5;
```

Expected: `graded_inline` present and non-zero on ticks where pitches landed.

Then confirm the lag is gone:

```sql
select market,
  count(*) as graded_last_10m,
  round(avg(extract(epoch from (graded_at - created_at)))) as mean_lag_seconds
from predictions
where graded_at > now() - interval '10 minutes'
group by market order by market;
```

**Acceptance:** `mean_lag_seconds` for `pitch_result` and `pitch_speed_ou` is
well under 120. Before this change it averaged toward 300 (half of the
10-minute cron interval).

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/live-poll/index.ts
git commit -m "feat(live-poll): grade predictions inline from the play-by-play in hand

Removes the up-to-10-minute settle lag on pitch_result and pitch_speed_ou.
settle remains the backstop for game-end markets."
```

---

## Task 4: Feed payload assembly

**Files:**
- Create: `supabase/functions/_shared/feed.ts`, `supabase/functions/_shared/feed_test.ts`

**Interfaces:**
- Consumes: `_shared/grade.ts` (`nextPitch`, `PitchLike`)
- Produces:
  - `buildGameFeed(args: { gamePk: number; pitches: PitchLike[]; atBats: AtBatFeedRow[]; predictions: PredictionFeedRow[]; players: Map<number, PlayerRow>; limit: number }) -> GameFeed`
  - `buildTodayLog(args: { predictions: PredictionFeedRow[]; pitchesByGame: Map<number, PitchLike[]>; labels: Map<number, string>; limit: number }) -> LogRow[]`

Assembly is pure and separated from the queries so it can be unit-tested with
no database.

- [ ] **Step 1: Write the failing test**

Create `supabase/functions/_shared/feed_test.ts`:

```ts
// Deno tests for feed payload assembly. Run: deno test supabase/functions/_shared/
import { assertEquals } from "jsr:@std/assert";
import { buildGameFeed, buildTodayLog } from "./feed.ts";

const pitch = (abi: number, pn: number, speed: number, cat: string) => ({
  at_bat_index: abi, pitch_number: pn, start_speed: speed, result_category: cat,
  pitch_type: "FF", zone: 5, description: cat === "ball" ? "ball" : "called_strike",
  balls: 0, strikes: 0,
});

const pred = (id: number, abi: number, pn: number | null, market: string,
              rec: string, result: string | null) => ({
  id, game_pk: 1, at_bat_index: abi, pitch_number: pn, market,
  recommendation: rec, confidence: 0.6, line: 94.5, predicted_value: 96,
  probs: null, result, model_version: "v1_20260707",
  created_at: "2026-07-28T19:05:00Z",
});

const atBat = (abi: number, result: string) => ({
  at_bat_index: abi, pitcher_id: 100, batter_id: 200, result,
  result_detail: result, pitch_count: 2, inning: 3, top_inning: true,
  end_ts: "2026-07-28T19:10:00Z",
});

const players = new Map([
  [100, { player_id: 100, full_name: "P One", pitch_hand: "R", bat_side: "R" }],
  [200, { player_id: 200, full_name: "B Two", pitch_hand: "R", bat_side: "L" }],
]);

Deno.test("buildGameFeed groups pitches and predictions under their at-bat", () => {
  const feed = buildGameFeed({
    gamePk: 1,
    pitches: [pitch(0, 1, 96, "ball"), pitch(0, 2, 95, "strike_foul")],
    atBats: [atBat(0, "hit")],
    predictions: [pred(1, 0, 0, "pitch_result", "ball", "win")],
    players, limit: 50,
  });
  assertEquals(feed.game_pk, 1);
  assertEquals(feed.at_bats.length, 1);
  assertEquals(feed.at_bats[0].pitches.length, 2);
  assertEquals(feed.at_bats[0].predictions.length, 1);
});

Deno.test("buildGameFeed resolves player names", () => {
  const feed = buildGameFeed({
    gamePk: 1, pitches: [], atBats: [atBat(0, "hit")], predictions: [],
    players, limit: 50,
  });
  assertEquals(feed.at_bats[0].pitcher, "P One");
  assertEquals(feed.at_bats[0].batter, "B Two");
});

Deno.test("buildGameFeed orders at-bats newest first", () => {
  const feed = buildGameFeed({
    gamePk: 1, pitches: [], atBats: [atBat(0, "hit"), atBat(2, "walk"), atBat(1, "out")],
    predictions: [], players, limit: 50,
  });
  assertEquals(feed.at_bats.map((a) => a.at_bat_index), [2, 1, 0]);
});

Deno.test("buildGameFeed honours the limit after ordering", () => {
  const feed = buildGameFeed({
    gamePk: 1, pitches: [], atBats: [atBat(0, "hit"), atBat(1, "out"), atBat(2, "walk")],
    predictions: [], players, limit: 2,
  });
  // Newest two, not the first two encountered.
  assertEquals(feed.at_bats.map((a) => a.at_bat_index), [2, 1]);
});

Deno.test("buildGameFeed totals graded predictions and wins", () => {
  const feed = buildGameFeed({
    gamePk: 1, pitches: [], atBats: [atBat(0, "hit")],
    predictions: [
      pred(1, 0, 0, "pitch_result", "ball", "win"),
      pred(2, 0, 1, "pitch_result", "ball", "loss"),
      pred(3, 0, 1, "pitch_speed_ou", "over", null),
    ],
    players, limit: 50,
  });
  assertEquals(feed.totals.graded, 2);
  assertEquals(feed.totals.correct, 1);
  assertEquals(feed.totals.by_market["pitch_result"].graded, 2);
  assertEquals(feed.totals.by_market["pitch_result"].correct, 1);
  // An ungraded row contributes to neither.
  assertEquals(feed.totals.by_market["pitch_speed_ou"].graded, 0);
});

Deno.test("buildGameFeed omits null fields to keep the payload small", () => {
  const feed = buildGameFeed({
    gamePk: 1, pitches: [], atBats: [atBat(0, "hit")],
    predictions: [{ ...pred(1, 0, 0, "pitch_result", "ball", "win"),
                    line: null, predicted_value: null }],
    players, limit: 50,
  });
  const p = feed.at_bats[0].predictions[0] as Record<string, unknown>;
  assertEquals("line" in p, false);
  assertEquals("predicted_value" in p, false);
  assertEquals("recommendation" in p, true);
});

Deno.test("buildTodayLog attaches the actual pitch that resolved each call", () => {
  const rows = buildTodayLog({
    predictions: [pred(1, 0, 0, "pitch_speed_ou", "over", "win")],
    pitchesByGame: new Map([[1, [pitch(0, 1, 96.4, "ball")]]]),
    labels: new Map([[1, "NYY @ BOS"]]),
    limit: 100,
  });
  assertEquals(rows.length, 1);
  assertEquals(rows[0].game_label, "NYY @ BOS");
  assertEquals(rows[0].actual_speed, 96.4);
  assertEquals(rows[0].actual_category, "ball");
});

Deno.test("buildTodayLog leaves actuals absent when no next pitch exists", () => {
  const rows = buildTodayLog({
    predictions: [pred(1, 9, 5, "pitch_result", "ball", null)],
    pitchesByGame: new Map([[1, [pitch(0, 1, 96, "ball")]]]),
    labels: new Map([[1, "NYY @ BOS"]]),
    limit: 100,
  });
  assertEquals(rows[0].actual_speed, undefined);
  assertEquals(rows[0].actual_category, undefined);
});

Deno.test("buildTodayLog respects the limit", () => {
  const preds = [1, 2, 3, 4, 5].map((i) =>
    pred(i, 0, i, "pitch_result", "ball", "win"));
  const rows = buildTodayLog({
    predictions: preds, pitchesByGame: new Map(), labels: new Map(), limit: 3,
  });
  assertEquals(rows.length, 3);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno test supabase/functions/_shared/feed_test.ts`
Expected: FAIL — `Module not found "./feed.ts"`

- [ ] **Step 3: Write the implementation**

Create `supabase/functions/_shared/feed.ts`:

```ts
// Feed payload assembly.
//
// Turns rows already stored in Postgres into the shape the Data Feed and the
// Live Board's "earlier at-bats" strip render. Nothing here computes a grade:
// predictions.result is written by live-poll (inline) and settle (backstop),
// and this module only reports it. The actual pitch is resolved through
// nextPitch() from grade.ts so "what the model said" and "what happened" are
// paired by exactly the rule that graded them.
//
// Pure functions, no database — the queries live in api/index.ts.

import { nextPitch, PitchLike } from "./grade.ts";

export interface PlayerRow {
  player_id: number;
  full_name: string | null;
  pitch_hand?: string | null;
  bat_side?: string | null;
}

export interface AtBatFeedRow {
  at_bat_index: number;
  pitcher_id: number | null;
  batter_id: number | null;
  result: string | null;
  result_detail: string | null;
  pitch_count: number | null;
  inning?: number | null;
  top_inning?: boolean | null;
  end_ts?: string | null;
}

export interface PredictionFeedRow {
  id: number;
  game_pk: number;
  at_bat_index: number | null;
  pitch_number: number | null;
  market: string;
  recommendation: string | null;
  confidence: number | null;
  line: number | null;
  predicted_value: number | null;
  probs: Record<string, number> | null;
  result: string | null;
  model_version: string | null;
  created_at: string | null;
}

export interface FeedPitch extends PitchLike {
  pitch_type?: string | null;
  zone?: number | null;
  description?: string | null;
  balls?: number | null;
  strikes?: number | null;
}

export interface MarketTotals {
  graded: number;
  correct: number;
}

export interface GameFeed {
  game_pk: number;
  at_bats: unknown[];
  totals: {
    graded: number;
    correct: number;
    by_market: Record<string, MarketTotals>;
  };
}

export interface LogRow {
  id: number;
  game_pk: number;
  game_label: string;
  at_bat_index: number | null;
  pitch_number: number | null;
  market: string;
  recommendation: string | null;
  confidence?: number;
  line?: number;
  predicted_value?: number;
  result: string | null;
  actual_speed?: number;
  actual_category?: string;
  model_version: string | null;
  created_at: string | null;
}

// Drop null/undefined keys. A full game is ~300 pitches and ~76 at-bats; the
// sparse columns are most of the byte count.
function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

const num = (v: unknown): number | undefined =>
  v == null ? undefined : Number(v);

export function buildGameFeed(args: {
  gamePk: number;
  pitches: FeedPitch[];
  atBats: AtBatFeedRow[];
  predictions: PredictionFeedRow[];
  players: Map<number, PlayerRow>;
  limit: number;
}): GameFeed {
  const { gamePk, pitches, atBats, predictions, players, limit } = args;

  const pitchesByAb = new Map<number, FeedPitch[]>();
  for (const p of pitches) {
    if (p.at_bat_index == null) continue;
    const list = pitchesByAb.get(p.at_bat_index) ?? [];
    list.push(p);
    pitchesByAb.set(p.at_bat_index, list);
  }
  for (const list of pitchesByAb.values()) {
    list.sort((a, b) => (a.pitch_number ?? 0) - (b.pitch_number ?? 0));
  }

  const predsByAb = new Map<number, PredictionFeedRow[]>();
  const byMarket: Record<string, MarketTotals> = {};
  let graded = 0, correct = 0;
  for (const p of predictions) {
    const totals = byMarket[p.market] ?? { graded: 0, correct: 0 };
    if (p.result === "win" || p.result === "loss") {
      totals.graded += 1;
      graded += 1;
      if (p.result === "win") {
        totals.correct += 1;
        correct += 1;
      }
    }
    byMarket[p.market] = totals;
    if (p.at_bat_index == null) continue;
    const list = predsByAb.get(p.at_bat_index) ?? [];
    list.push(p);
    predsByAb.set(p.at_bat_index, list);
  }

  const ordered = [...atBats].sort((a, b) => b.at_bat_index - a.at_bat_index)
    .slice(0, limit);

  const at_bats = ordered.map((ab) => compact({
    at_bat_index: ab.at_bat_index,
    inning: ab.inning ?? undefined,
    half: ab.top_inning == null ? undefined : (ab.top_inning ? "▲" : "▼"),
    pitcher: ab.pitcher_id != null
      ? players.get(ab.pitcher_id)?.full_name ?? undefined
      : undefined,
    batter: ab.batter_id != null
      ? players.get(ab.batter_id)?.full_name ?? undefined
      : undefined,
    result: ab.result ?? undefined,
    result_detail: ab.result_detail ?? undefined,
    pitch_count: ab.pitch_count ?? undefined,
    end_ts: ab.end_ts ?? undefined,
    pitches: (pitchesByAb.get(ab.at_bat_index) ?? []).map((p) => compact({
      pitch_number: p.pitch_number,
      type: p.pitch_type ?? undefined,
      speed: num(p.start_speed),
      zone: p.zone ?? undefined,
      description: p.description ?? undefined,
      result_category: p.result_category ?? undefined,
      balls: p.balls ?? undefined,
      strikes: p.strikes ?? undefined,
    })),
    predictions: (predsByAb.get(ab.at_bat_index) ?? []).map((p) => compact({
      market: p.market,
      pitch_number: p.pitch_number ?? undefined,
      recommendation: p.recommendation ?? undefined,
      confidence: num(p.confidence),
      line: num(p.line),
      predicted_value: num(p.predicted_value),
      probs: p.probs ?? undefined,
      result: p.result ?? undefined,
      model_version: p.model_version ?? undefined,
    })),
  }));

  return { game_pk: gamePk, at_bats, totals: { graded, correct, by_market: byMarket } };
}

export function buildTodayLog(args: {
  predictions: PredictionFeedRow[];
  pitchesByGame: Map<number, PitchLike[]>;
  labels: Map<number, string>;
  limit: number;
}): LogRow[] {
  const { predictions, pitchesByGame, labels, limit } = args;
  return predictions.slice(0, limit).map((p) => {
    const nxt = nextPitch(pitchesByGame.get(p.game_pk) ?? [],
                          p.at_bat_index, p.pitch_number);
    return compact({
      id: p.id,
      game_pk: p.game_pk,
      game_label: labels.get(p.game_pk) ?? "",
      at_bat_index: p.at_bat_index ?? undefined,
      pitch_number: p.pitch_number ?? undefined,
      market: p.market,
      recommendation: p.recommendation ?? undefined,
      confidence: num(p.confidence),
      line: num(p.line),
      predicted_value: num(p.predicted_value),
      result: p.result ?? undefined,
      actual_speed: nxt ? num(nxt.start_speed) : undefined,
      actual_category: nxt?.result_category ?? undefined,
      model_version: p.model_version ?? undefined,
      created_at: p.created_at ?? undefined,
    }) as LogRow;
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `deno test supabase/functions/_shared/feed_test.ts`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/feed.ts supabase/functions/_shared/feed_test.ts
git commit -m "feat(edge): pure feed payload assembly with tests"
```

---

## Task 5: `GET /feed/{game_pk}` and `GET /feed/today`

**Files:**
- Modify: `supabase/functions/api/index.ts`

- [ ] **Step 1: Add the imports and TTLs**

Add to the import block at the top of `supabase/functions/api/index.ts`:

```ts
import { buildGameFeed, buildTodayLog, PredictionFeedRow } from "../_shared/feed.ts";
import { PitchLike } from "../_shared/grade.ts";
```

Add to the `TTL` map:

```ts
  "feed": 10, "feed/today": 15, "accuracy": 300,
```

- [ ] **Step 2: Add the two handlers**

Add after the existing `live()` function:

```ts
// GET /feed/{game_pk} — every completed at-bat for that game with the model's
// calls and their graded outcomes.
//
// This is what makes the board stateless for the client: a user arriving in the
// 7th inning gets the same payload as one who has been watching since the 1st,
// because both request the same URL and hit the same cached response. The data
// was always in the database; nothing served it.
//
// Bounded by the `predictions` 21-day retention — older games return at-bats
// with no predictions attached.
async function feedGame(gamePk: number, limit: number): Promise<Response> {
  const db = svc();
  const [{ data: abRows }, { data: pitchRows }, { data: predRows }] = await Promise.all([
    db.from("at_bats")
      .select("at_bat_index,pitcher_id,batter_id,result,result_detail,pitch_count,end_ts")
      .eq("game_pk", gamePk).order("at_bat_index", { ascending: false }).limit(200),
    db.from("pitches")
      .select("at_bat_index,pitch_number,start_speed,result_category,pitch_type,zone,description,balls,strikes")
      .eq("game_pk", gamePk).order("at_bat_index").order("pitch_number").limit(5000),
    db.from("predictions")
      .select("id,game_pk,at_bat_index,pitch_number,market,recommendation,confidence,line,predicted_value,probs,result,model_version,created_at")
      .eq("game_pk", gamePk).order("id", { ascending: false }).limit(3000),
  ]);

  const playerIds = [...new Set((abRows ?? [])
    .flatMap((a: any) => [a.pitcher_id, a.batter_id]).filter(Boolean))];
  const { data: playerRows } = playerIds.length
    ? await db.from("player_info").select("player_id,full_name,pitch_hand,bat_side")
        .in("player_id", playerIds)
    : { data: [] };

  return json(buildGameFeed({
    gamePk,
    pitches: (pitchRows ?? []) as any[],
    atBats: (abRows ?? []) as any[],
    predictions: (predRows ?? []) as PredictionFeedRow[],
    players: new Map((playerRows ?? []).map((p: any) => [p.player_id, p])),
    limit,
  }));
}

// GET /feed/today — the cross-game graded prediction log behind the Data Feed
// table. Keyset-paginated on predictions.id (descending), which is monotonic
// with insertion order.
async function feedToday(limit: number, cursor: number | null): Promise<Response> {
  const db = svc();
  const today = mlbToday();
  const { data: gameRows } = await db.from("games")
    .select("game_pk,home_abbr,away_abbr,home_team,away_team")
    .eq("official_date", today);
  const gamePks = (gameRows ?? []).map((g: any) => g.game_pk);
  if (!gamePks.length) return json({ rows: [], next_cursor: null });

  let q = db.from("predictions")
    .select("id,game_pk,at_bat_index,pitch_number,market,recommendation,confidence,line,predicted_value,probs,result,model_version,created_at")
    .in("game_pk", gamePks).order("id", { ascending: false }).limit(limit);
  if (cursor != null) q = q.lt("id", cursor);
  const { data: predRows } = await q;

  // One pitch fetch covers every game on the slate; at ~300 pitches per game
  // this is a few thousand rows, and the 15s CDN cache collapses it to one
  // origin query per tick regardless of how many users are watching.
  const { data: pitchRows } = await db.from("pitches")
    .select("game_pk,at_bat_index,pitch_number,start_speed,result_category")
    .in("game_pk", gamePks).order("at_bat_index").order("pitch_number").limit(8000);

  const pitchesByGame = new Map<number, PitchLike[]>();
  for (const p of pitchRows ?? []) {
    const list = pitchesByGame.get(p.game_pk) ?? [];
    list.push(p as PitchLike);
    pitchesByGame.set(p.game_pk, list);
  }
  const labels = new Map((gameRows ?? []).map((g: any) =>
    [g.game_pk, `${g.away_abbr ?? g.away_team} @ ${g.home_abbr ?? g.home_team}`]));

  const rows = buildTodayLog({
    predictions: (predRows ?? []) as PredictionFeedRow[],
    pitchesByGame, labels, limit,
  });
  const nextCursor = rows.length === limit ? rows[rows.length - 1].id : null;
  return json({ rows, next_cursor: nextCursor });
}
```

- [ ] **Step 3: Register the routes**

In the `Deno.serve` handler, add before the `switch (route)` block, beside the
existing `edge/(\d+)` match:

```ts
    const fm = route.match(/^feed\/(\d+)$/);
    if (fm) {
      const limit = Math.min(200, Number(url.searchParams.get("limit") ?? 50) || 50);
      return await cached(`feed/${fm[1]}:${limit}`, TTL["feed"], origin,
                          () => feedGame(Number(fm[1]), limit));
    }
```

And add to the `switch`:

```ts
      case "feed/today": {
        const limit = Math.min(500, Number(url.searchParams.get("limit") ?? 200) || 200);
        const rawCursor = url.searchParams.get("cursor");
        const cursor = rawCursor ? Number(rawCursor) : null;
        return await cached(`feed/today:${limit}:${cursor ?? ""}`,
                            TTL["feed/today"], origin,
                            () => feedToday(limit, cursor));
      }
```

Note the cache keys include the query parameters — omitting them would serve one
limit's response for every limit.

- [ ] **Step 4: Typecheck**

Run: `deno check supabase/functions/api/index.ts`
Expected: no errors.

- [ ] **Step 5: Deploy and verify against a real game**

Deploy `api` via the Supabase MCP `deploy_edge_function`.

Find a game with predictions:

```sql
select game_pk, count(*) from predictions
where created_at > now() - interval '2 days'
group by game_pk order by count(*) desc limit 1;
```

Then:

```bash
BASE=https://gfxpchtyncgsczqdvohr.functions.supabase.co/api
curl -s "$BASE/feed/<game_pk>" | python -c "
import json,sys
d = json.load(sys.stdin)
print('at_bats', len(d['at_bats']))
print('totals', d['totals'])
ab = d['at_bats'][0]
print('newest AB', ab['at_bat_index'], 'pitches', len(ab.get('pitches',[])),
      'preds', len(ab.get('predictions',[])))
"
```

**Acceptance:** `at_bats` non-empty, `totals.graded > 0`, and the newest at-bat
carries both pitches and predictions.

```bash
curl -s "$BASE/feed/today?limit=5" | python -m json.tool | head -40
```

**Acceptance:** five rows, each with `game_label`, `market`, `result`, and —
for resolved pitch markets — `actual_speed` or `actual_category`.

- [ ] **Step 6: Verify the payload is not oversized**

```bash
curl -s "$BASE/feed/<game_pk>" | wc -c
```

**Acceptance:** under 400,000 bytes for a complete game. If larger, lower the
default `limit` from 50 to 25 — the `compact()` helper already drops nulls.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/api/index.ts
git commit -m "feat(api): GET /feed/{game_pk} and GET /feed/today

Serves the graded prediction history that already existed in the database and
was previously rebuilt in browser memory every session."
```

---

## Task 6: `GET /accuracy`

**Files:**
- Modify: `supabase/functions/api/index.ts`

`prediction_accuracy_daily` holds 106 permanent day/market rows and **nothing serves it**. This endpoint exposes it with the trivial-guess baseline alongside, so a 52.5% win rate reads as +6.1 points rather than as a coin flip.

**Graceful degradation:** `market_baselines` is created by the warehouse plan. When it is missing or empty this returns `"baselines_available": false` and omits the comparison rather than failing.

- [ ] **Step 1: Add the handler**

Add after `feedToday` in `supabase/functions/api/index.ts`:

```ts
// GET /accuracy?days=30 — model performance over time, against the honest
// denominator.
//
// Raw win rates mislead because the markets have different outcome counts. The
// baseline is "always guess the most common outcome", published by the nightly
// warehouse job into market_baselines. When that table is absent (the warehouse
// has not shipped yet) this degrades to accuracy without baselines rather than
// erroring — the endpoint is useful either way.
async function accuracy(days: number): Promise<Response> {
  const db = svc();
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);

  const [{ data: daily }, baselineRes] = await Promise.all([
    db.from("prediction_accuracy_daily")
      .select("day,market,model_version,n,n_graded,wins,losses,pushes,mean_confidence,mean_profit_units")
      .gte("day", since).order("day", { ascending: false }),
    db.from("market_baselines")
      .select("market,baseline_outcome,baseline_rate,n")
      .then((r) => r, () => ({ data: null, error: true })),
  ]);

  const baselineRows = (baselineRes as any)?.data ?? null;
  const baselines = new Map<string, any>(
    (baselineRows ?? []).map((b: any) => [b.market, b]));

  // Totals per market across the window, so the client does not have to sum.
  const byMarket = new Map<string, any>();
  for (const row of daily ?? []) {
    const m = byMarket.get(row.market) ?? {
      market: row.market, label: MARKET_LABELS[row.market] ?? row.market,
      n: 0, n_graded: 0, wins: 0, losses: 0, pushes: 0,
    };
    m.n += Number(row.n ?? 0);
    m.n_graded += Number(row.n_graded ?? 0);
    m.wins += Number(row.wins ?? 0);
    m.losses += Number(row.losses ?? 0);
    m.pushes += Number(row.pushes ?? 0);
    byMarket.set(row.market, m);
  }

  const markets = [...byMarket.values()].map((m) => {
    const decided = m.wins + m.losses;
    const winRate = decided ? Math.round((m.wins / decided) * 10000) / 10000 : null;
    const base = baselines.get(m.market);
    const baseRate = base?.baseline_rate != null ? Number(base.baseline_rate) : null;
    return {
      ...m,
      win_rate: winRate,
      baseline_outcome: base?.baseline_outcome ?? null,
      baseline_rate: baseRate,
      // The number that matters: points above always-guessing.
      edge_vs_baseline: winRate != null && baseRate != null
        ? Math.round((winRate - baseRate) * 10000) / 10000
        : null,
    };
  });
  markets.sort((a, b) => (b.edge_vs_baseline ?? -9) - (a.edge_vs_baseline ?? -9));

  return json({
    since,
    days,
    baselines_available: !!(baselineRows && baselineRows.length),
    markets,
    daily: daily ?? [],
  });
}
```

- [ ] **Step 2: Register the route**

Add to the `switch`:

```ts
      case "accuracy": {
        const days = Math.min(120, Number(url.searchParams.get("days") ?? 30) || 30);
        return await cached(`accuracy:${days}`, TTL["accuracy"], origin,
                            () => accuracy(days));
      }
```

- [ ] **Step 3: Typecheck**

Run: `deno check supabase/functions/api/index.ts`
Expected: no errors.

- [ ] **Step 4: Deploy and verify both branches**

Deploy `api`.

```bash
curl -s "https://gfxpchtyncgsczqdvohr.functions.supabase.co/api/accuracy?days=30" \
  | python -m json.tool | head -40
```

**Acceptance:** `markets` non-empty with a `win_rate` per market.
`baselines_available` is `false` until the warehouse plan's Task 13 has run, and
`true` after — **verify both states** if the warehouse plan has already landed.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/api/index.ts
git commit -m "feat(api): GET /accuracy exposing prediction_accuracy_daily

106 permanent day/market rows had no route to them. Reports win rate against
the always-guess baseline, degrading gracefully when market_baselines is absent."
```

---

## Task 7: Frontend feed client

**Files:**
- Modify: `frontend/pitchhawk-data.js`

**Interfaces:**
- Produces on `window.PITCHHAWK`: `loadGameFeed(apiBase, gamePk, fetchImpl?) -> Promise<GameFeed|null>`, `loadTodayLog(apiBase, limit, fetchImpl?) -> Promise<{rows, next_cursor}>`, `feedLogRow(row) -> object`

`feedLogRow` maps a server row into the shape `dfRows`/`dfStats` already
consume, so the Data Feed's rendering code is untouched.

- [ ] **Step 1: Add the loaders**

In `frontend/pitchhawk-data.js`, add before the `loadLive` function:

```js
  // ── durable feed (replaces session accumulation) ────────────────────────
  // The board used to rebuild its at-bat history and graded log in memory
  // every session, so a reload lost everything and two users watching the same
  // game saw different content. Both are now served by /feed, which reads the
  // predictions the backend has always been storing and grading.
  async function loadGameFeed(apiBase, gamePk, fetchImpl) {
    const f = fetchImpl || ((...a) => fetch(...a));
    const res = await f(`${apiBase}/feed/${gamePk}`);
    if (!res.ok) return null;
    return await res.json();
  }

  async function loadTodayLog(apiBase, limit, fetchImpl) {
    const f = fetchImpl || ((...a) => fetch(...a));
    const n = limit || 200;
    const res = await f(`${apiBase}/feed/today?limit=${n}`);
    if (!res.ok) return { rows: [], next_cursor: null };
    return await res.json();
  }

  // Map one server log row into the row shape the Data Feed table renders.
  // Grading is NOT recomputed here — `result` comes from the server, which is
  // the only place the rules live now.
  function feedLogRow(r) {
    const isSpeed = r.market === "pitch_speed_ou";
    const base = {
      id: String(r.id), t: r.created_at ? Date.parse(r.created_at) : Date.now(),
      pk: r.game_pk, game: r.game_label || "",
      matchup: r.game_label || "", count: "", outs: null,
      model: r.model_version || "—",
      result: r.result || null,
      hit: r.result === "win",
      band: r.result === "win" ? "good" : r.result === "loss" ? "bad" : null,
    };
    if (isSpeed) {
      const pred = r.predicted_value != null ? +r.predicted_value : null;
      const actual = r.actual_speed != null ? +r.actual_speed : null;
      const err = pred != null && actual != null ? pred - actual : null;
      return Object.assign(base, {
        mkt: "VELO",
        pred: pred != null ? `${pred.toFixed(1)} mph` : "—",
        predRaw: pred != null ? pred.toFixed(1) : "—",
        actual: actual != null ? actual.toFixed(1) : "—",
        actualRaw: actual != null ? actual.toFixed(1) : "—",
        err: err == null ? "—" : (err >= 0 ? "+" : "−") + Math.abs(err).toFixed(1),
        errAbs: err == null ? null : Math.abs(err),
        speed: actual,
      });
    }
    return Object.assign(base, {
      mkt: "CLASS",
      pred: OUTCOME_LABEL[r.recommendation] || r.recommendation || "—",
      predRaw: `${r.recommendation || "?"} ${
        r.confidence != null ? Math.round(r.confidence * 100) + "%" : ""}`.trim(),
      conf: r.confidence != null ? +r.confidence : null,
      actual: OUTCOME_LABEL[r.actual_category] || r.actual_category || "—",
      actualRaw: r.actual_category || "—",
      err: r.result == null ? "ungraded" : r.result === "win" ? "correct" : "miss",
    });
  }
```

- [ ] **Step 2: Export them**

In the returned object at the bottom of the IIFE, add to the existing exports:

```js
    loadGameFeed, loadTodayLog, feedLogRow,
```

- [ ] **Step 3: Delete the client-side grading from `gradedPred`**

`gradedPred` currently recomputes whether each call was right — a third copy of
rules that now live only in `_shared/grade.ts`. Replace the function with a
shaper that carries the server's answer:

```js
  // Shape one position's prediction pair for rendering. Grading is NOT done
  // here: `result` is written server-side by live-poll and settle via
  // _shared/grade.ts, and is the single source of truth. This function used to
  // re-derive resultOk/speedOk in the browser, which could disagree with the
  // published record.
  function gradedPred(slot, _actual) {
    if (!slot || (!slot.result && !slot.speed)) return null;
    const rp = slot.result, sp = slot.speed;
    const okOf = (r) => (r == null ? null : r === "win");
    return {
      resultCat: rp ? rp.recommendation : null,
      resultProb: rp && rp.probs && rp.recommendation != null &&
        rp.probs[rp.recommendation] != null
        ? +rp.probs[rp.recommendation]
        : (rp && rp.confidence != null ? +rp.confidence : null),
      resultOk: okOf(rp ? rp.result : null),
      speed: sp && sp.predicted_value != null ? +sp.predicted_value : null,
      speedRec: sp ? sp.recommendation : null,
      speedLine: sp && sp.line != null ? +sp.line : null,
      speedOk: okOf(sp ? sp.result : null),
    };
  }
```

`/live`'s `pa_predictions` already selects `result`, so no API change is needed
for this.

- [ ] **Step 4: Verify the file still parses**

Run: `node --check frontend/pitchhawk-data.js`
Expected: no output (success).

- [ ] **Step 5: Commit**

```bash
git add frontend/pitchhawk-data.js
git commit -m "feat(frontend): feed loaders; grading comes from the server

gradedPred no longer re-derives win/loss in the browser — it carries the
server's predictions.result, so the UI can never disagree with the published
record."
```

---

## Task 8: Replace the client accumulation with feed hydration

**Files:**
- Modify: `frontend/pitchhawk.js`

This is the deletion task. Everything removed here existed only because no
endpoint served the data.

- [ ] **Step 1: Replace the accumulation state in the constructor**

In `frontend/pitchhawk.js`, replace lines 83–89:

```js
      // Client-side plate-appearance history (see trackAtBats): /live only
      // carries the current PA, so finished at-bats are archived here.
      this.paHist = {};
      this.paWatch = {};
      // Session-graded prediction log powering the Data Feed (see trackGradedLog).
      this.gradedLog = [];
      this._seenPitch = {};
```

with:

```js
      // Durable feed, served by GET /feed/{game_pk} and GET /feed/today. This
      // replaced the in-memory accumulation the board used to rebuild every
      // session: a reload lost all of it, and two users watching the same game
      // saw different content. The backend was storing and grading these
      // predictions the whole time; nothing served them.
      this.feed = { atBats: {}, log: [], loadedAt: 0 };
      this._feedInFlight = {};
```

- [ ] **Step 2: Delete `trackAtBats` and `summarizePa`**

Delete lines 214–268 in the original numbering — the
`// ── at-bat history (accumulated client-side) ──` comment block, the whole
`trackAtBats` method, and the whole `summarizePa` method.

- [ ] **Step 3: Delete `trackGradedLog` and repoint `dfRows`**

Delete the `// ══ GRADED LOG (session-accumulated…` comment block and the whole
`trackGradedLog` method (original lines 923–966).

Replace `dfRows` with:

```js
    dfRows() {
      const scope = this.state.dfGame;
      const rows = this.feed.log || [];
      return scope === "all" ? rows : rows.filter((r) => r.pk === scope);
    }
```

`dfStats` is unchanged — `feedLogRow` produces the same `mkt` / `errAbs` /
`hit` / `band` fields it already reads.

- [ ] **Step 4: Repoint `earlierRows` at the feed**

In `earlierRows`, replace:

```js
      const hist = this.paHist[g.gamePk] || [];
```

with:

```js
      const hist = this.feed.atBats[g.gamePk] || [];
```

And in the desktop branch that reads `hist.length` (original line 911), replace
the empty-state text so it no longer describes a limitation that has been fixed:

```js
                ${hist.length ? this.earlierRows(g, false) : `<div style="padding:14px;font-size:12.5px;color:${C.faint};font-style:italic;">No completed at-bats yet in this game.</div>`}
```

- [ ] **Step 5: Update the Data Feed empty states**

Replace the `logEmpty` string (original line 1092):

```js
      const logEmpty = `<div style="padding:16px 14px;font-size:12.5px;color:${C.faint};font-style:italic;line-height:1.55;">No graded predictions yet today. Rows appear as pitches are thrown and the model's calls resolve. History reaches back 21 days.</div>`;
```

And the no-live-games message (original line 991):

```js
        return `<div style="padding:2.5rem 14px;text-align:center;color:${C.faint};">No live games right now — today's graded predictions are shown below when the slate starts.</div>`;
```

- [ ] **Step 6: Add the hydration methods**

Add after `_withoutFinals`:

```js
    // ── feed hydration ────────────────────────────────────────────────────
    // Server-served history, fetched once per game and refreshed on the poll.
    // Both endpoints are CDN-cached, so every client gets the identical
    // payload — "one shared state" is a property of the cache, not of extra
    // infrastructure.
    async loadFeedFor(gamePk) {
      if (!gamePk || this._feedInFlight[gamePk]) return;
      this._feedInFlight[gamePk] = 1;
      try {
        const feed = await PH.loadGameFeed(API_BASE, gamePk);
        if (feed && Array.isArray(feed.at_bats)) {
          this.feed.atBats[gamePk] = feed.at_bats.map((ab) => this.feedAbRow(ab));
        }
      } catch (_e) { /* keep whatever we already have */ }
      finally { delete this._feedInFlight[gamePk]; }
    }

    // Map a server at-bat into the shape earlierRows renders. The accuracy
    // figures are counted from the server's `result` values, never re-derived.
    feedAbRow(ab) {
      const preds = ab.predictions || [];
      const abr = preds.find((p) => p.market === "ab_result");
      const abp = preds.find((p) => p.market === "ab_pitches_ou");
      const pitchCalls = preds.filter((p) =>
        p.market === "pitch_result" && p.result != null);
      const right = pitchCalls.filter((p) => p.result === "win").length;
      const speeds = preds.filter((p) =>
        p.market === "pitch_speed_ou" && p.predicted_value != null);
      const errs = [];
      (ab.pitches || []).forEach((pt) => {
        const call = speeds.find((s) => s.pitch_number === (pt.pitch_number - 1));
        if (call && pt.speed != null) errs.push(call.predicted_value - pt.speed);
      });
      const avgErr = errs.length
        ? errs.reduce((a, b) => a + b, 0) / errs.length : null;
      const ratio = pitchCalls.length ? right / pitchCalls.length : null;
      return {
        batter: ab.batter || "—",
        pitches: (ab.pitches || []).length || ab.pitch_count || 0,
        projPitches: abp && abp.predicted_value != null ? +abp.predicted_value : null,
        pitchBand: abp && abp.predicted_value != null
          ? this.countBand(abp.predicted_value - ((ab.pitches || []).length))
          : null,
        outcomeLabel: ab.result
          ? (PH.OUTCOME_LABEL[ab.result] || ab.result) : "Unresolved",
        call: abr ? abr.recommendation : null,
        callProb: abr && abr.confidence != null ? +abr.confidence : null,
        callOk: abr && abr.result != null ? abr.result === "win" : null,
        avgErr, veloBand: this.veloBand(avgErr),
        right, gradedN: pitchCalls.length,
        pickBand: ratio == null ? null
          : ratio >= 0.6 ? "good" : ratio >= 0.4 ? "amber" : "bad",
      };
    }

    async loadTodayLog() {
      try {
        const res = await PH.loadTodayLog(API_BASE, 200);
        if (res && Array.isArray(res.rows)) {
          this.feed.log = res.rows.map((r) => PH.feedLogRow(r));
          this.feed.loadedAt = Date.now();
        }
      } catch (_e) { /* keep the last-good log */ }
    }
```

- [ ] **Step 7: Rewire `poll()` and `start()`**

Replace the two accumulation calls in `poll()`:

```js
          this.trackAtBats(PH.games);
          this.trackGradedLog(PH.games);
```

with:

```js
          // Refresh the per-game feed for whatever the user is looking at, plus
          // the cross-game log. Both are cached server-side, so this costs one
          // origin query per TTL no matter how many clients are polling.
          const focus = this.state.feedGame || (PH.games[0] && PH.games[0].gamePk);
          await Promise.all([
            this.loadFeedFor(focus),
            this.loadTodayLog(),
          ]);
```

In `start()`, the existing `this.poll()` call now hydrates the feed, so no
change is needed there.

Add a feed load when the user switches games. In `_onClick`, the `feedGame`
case currently reads:

```js
        case "feedGame": return this.setState({ feedGame: Number(arg) });
```

Replace with:

```js
        case "feedGame": {
          const pk = Number(arg);
          this.setState({ feedGame: pk });
          this.loadFeedFor(pk).then(() => this.render());
          return;
        }
```

- [ ] **Step 8: Verify the file parses and no dead references remain**

Run: `node --check frontend/pitchhawk.js`
Expected: no output.

Run: `grep -n "paHist\|paWatch\|gradedLog\|_seenPitch\|trackAtBats\|trackGradedLog\|summarizePa" frontend/pitchhawk.js`
Expected: **no matches.** Any hit is a dangling reference to deleted state.

- [ ] **Step 9: Commit**

```bash
git add frontend/pitchhawk.js
git commit -m "feat(frontend): hydrate the feed from the server, delete session accumulation

Removes trackAtBats, trackGradedLog, summarizePa and the paHist/paWatch/
gradedLog/_seenPitch state. The Data Feed and at-bat history now survive a
reload and are identical for every user."
```

---

## Task 9: End-to-end verification

**Files:** none — this is the acceptance gate for the plan.

Run during a live game window, when there is real data moving.

- [ ] **Step 1: A hard reload preserves the feed**

Open the deployed site, go to the Live Board, wait for at least two completed
at-bats, then hard-reload (Ctrl+Shift+R).

**Acceptance:** the "Earlier at-bats" strip and the Data Feed log are populated
**immediately after the reload**. Before this plan both were empty until new
pitches arrived.

- [ ] **Step 2: Two clients show identical content**

Open the site in two browsers (or a normal and a private window). Select the
same game in both.

**Acceptance:** the at-bat strip and Data Feed rows match. Any difference means
something is still being accumulated client-side.

- [ ] **Step 3: A mid-game arrival sees the whole game**

In a fresh private window, open the site for a game already in the 5th inning
or later.

**Acceptance:** the feed shows at-bats from earlier innings, not just the
current one.

- [ ] **Step 4: The CDN is doing the sharing**

```bash
BASE=https://gfxpchtyncgsczqdvohr.functions.supabase.co/api
for i in 1 2 3; do
  curl -s -o /dev/null -w "%{time_total}s\n" "$BASE/feed/today?limit=200"
done
```

**Acceptance:** the second and third requests are markedly faster than the
first — the shared cached response, not a per-client origin query.

- [ ] **Step 5: The backlog is clear**

```sql
select count(*) filter (where result is null) as ungraded,
       count(*) filter (where result is not null) as graded,
       round(avg(extract(epoch from (graded_at - created_at)))
             filter (where graded_at > now() - interval '1 hour')) as mean_lag_s
from predictions;
```

**Acceptance:** `ungraded` far below the 92,398 measured on 2026-07-29, and
`mean_lag_s` under 120.

- [ ] **Step 6: Nothing else regressed**

```bash
BASE=https://gfxpchtyncgsczqdvohr.functions.supabase.co/api
for route in health games live picks/today record sportsbooks accuracy; do
  printf "%-14s %s\n" "$route" \
    "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/$route")"
done
```

**Acceptance:** every route returns 200.

- [ ] **Step 7: Run every test**

Run: `deno test supabase/functions/_shared/`
Expected: PASS — `grade_test.ts` (11), `feed_test.ts` (9), `vocab_test.ts` (4).

Run: `deno check supabase/functions/api/index.ts supabase/functions/live-poll/index.ts supabase/functions/settle/index.ts`
Expected: no errors.

- [ ] **Step 8: Commit the verification note**

```bash
git commit --allow-empty -m "chore: verify shared live state end to end

Hard reload preserves the feed; two clients render identical content; a
mid-game arrival sees earlier innings. Mean grading lag <n>s, down from ~300s.
Ungraded predictions <n>, down from 92,398."
```

---

## Final acceptance

- [ ] `deno test supabase/functions/_shared/` passes
- [ ] `deno check` clean on `api`, `live-poll`, `settle`
- [ ] `grep` finds no `paHist`, `paWatch`, `gradedLog`, `_seenPitch`, `trackAtBats`, `trackGradedLog`, or `summarizePa` in `frontend/`
- [ ] Exactly one implementation of the grading rules exists, in `_shared/grade.ts`
- [ ] A hard reload mid-game preserves the at-bat strip and Data Feed
- [ ] Two simultaneous clients render identical feed content
- [ ] Mean grading lag under 120 s
- [ ] All existing API routes still return 200

---

## Notes for the implementer

**The one rule that matters.** After Task 1 there is exactly one implementation
of the grading rules. Tasks 2, 3, 4, and 7 all consume it. If you find yourself
writing `recommendation === actual` anywhere outside `_shared/grade.ts`, stop —
the frontend copy that used to exist could disagree with the published win/loss
record, which is why it was deleted rather than ported.

**Task 3 placement is deliberate.** `gradeInline` goes *before* the
`if (currentPlay?.is_complete) continue;` early return. Putting it after means
the final pitch of a completed at-bat never grades on the tick where it lands.

**Cache keys must include query parameters.** Task 5's cache keys are
`feed/${pk}:${limit}` and `feed/today:${limit}:${cursor}`. Dropping the
parameters would serve one limit's response for every limit — a subtle bug that
only shows up when a second caller uses a different `limit`.

**`/accuracy` has a real dependency on the other plan.** `market_baselines`
comes from `2026-07-29-warehouse-and-capacity.md` Task 13. Task 6 here handles
its absence deliberately; do not "fix" that by requiring the table.

**Out of scope, flagged.** The on-deck / Upcoming board derives its numbers by
applying random jitter to the live book (`perturbUpcoming`,
`frontend/pitchhawk-data.js:375`) and presents them in the same visual language
as real model output. This plan does not touch it — it needs a product
decision, recorded in the spec's §12.
