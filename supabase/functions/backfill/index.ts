// Historical backfill, driven entirely on Supabase.
//
// Walks backwards from backfill_progress.cursor_date to start_date, one date
// per pass, ingesting every final game's play-by-play into pitches/at_bats
// and the schedule into games. Bounded to ~TIME_BUDGET_MS per invocation so
// it fits edge-function limits; pg_cron re-invokes it every minute until
// done=true, after which each call is a fast no-op.
//
// POST /backfill  { "start_date"?: "YYYY-MM-DD", "end_date"?: "YYYY-MM-DD", "reset"?: bool }
// Requires x-cron-secret.

import { json, logRun, requireCronSecret, svc } from "../_shared/db.ts";
import { ensurePlayers, ingestGame, upsertGames } from "../_shared/ingest.ts";
import { getSchedule, isFinal } from "../_shared/mlb.ts";

const TIME_BUDGET_MS = 45_000;

function prevDay(iso: string): string {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

Deno.serve(async (req) => {
  const denied = await requireCronSecret(req);
  if (denied) return denied;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_e) { /* cron sends empty body */ }

  const db = svc();
  let { data: prog } = await db.from("backfill_progress").select("*").eq("id", 1).maybeSingle();

  if (!prog || body.reset) {
    const end = (body.end_date as string) ?? prevDay(new Date().toISOString().slice(0, 10));
    const start = (body.start_date as string) ?? "2025-03-27";
    const row = {
      id: 1, start_date: start, end_date: end, cursor_date: end,
      games_done: 0, pitches_done: 0, done: false, updated_at: new Date().toISOString(),
    };
    await db.from("backfill_progress").upsert(row);
    prog = row;
  }

  if (prog.done) return json({ status: "done", progress: prog });

  let cursor: string = prog.cursor_date;
  let gamesDone = 0, pitchesDone = 0;
  const errors: string[] = [];

  while (Date.now() - t0 < TIME_BUDGET_MS && cursor >= prog.start_date) {
    try {
      const sched = await getSchedule(cursor);
      const regular = sched.filter((g) => g.game_type === "R" || g.game_type === "P" || g.game_type === "F" || g.game_type === "D" || g.game_type === "L" || g.game_type === "W");
      await upsertGames(regular);
      const finals = regular.filter((g) => isFinal(g.status));
      for (const g of finals) {
        if (Date.now() - t0 > TIME_BUDGET_MS) break;
        // Skip games already fully ingested (cheap existence probe).
        const { count } = await svc().from("pitches")
          .select("id", { count: "exact", head: true })
          .eq("game_pk", g.game_pk).limit(1);
        if ((count ?? 0) > 200) continue;
        try {
          const res = await ingestGame(g.game_pk);
          gamesDone += 1;
          pitchesDone += res.pitches;
        } catch (e) {
          errors.push(`game ${g.game_pk}: ${String(e).slice(0, 120)}`);
        }
      }
      // Only advance the cursor when the whole date fit in the budget.
      if (Date.now() - t0 <= TIME_BUDGET_MS) {
        // Enrich players sparsely: once per date, from at_bats of that slate.
        const ids = new Set<number>();
        for (const g of finals) {
          const { data } = await svc().from("at_bats")
            .select("pitcher_id,batter_id").eq("game_pk", g.game_pk).limit(200);
          for (const r of data ?? []) {
            if (r.pitcher_id) ids.add(r.pitcher_id);
            if (r.batter_id) ids.add(r.batter_id);
          }
        }
        try { await ensurePlayers([...ids]); } catch (_e) { /* enrichment only */ }
        cursor = prevDay(cursor);
      }
    } catch (e) {
      errors.push(`date ${cursor}: ${String(e).slice(0, 160)}`);
      cursor = prevDay(cursor); // don't wedge on a bad date
    }
  }

  const done = cursor < prog.start_date;
  await db.from("backfill_progress").update({
    cursor_date: done ? prog.start_date : cursor,
    games_done: (prog.games_done ?? 0) + gamesDone,
    pitches_done: (prog.pitches_done ?? 0) + pitchesDone,
    done,
    updated_at: new Date().toISOString(),
  }).eq("id", 1);

  const detail = { cursor, done, games: gamesDone, pitches: pitchesDone, errors: errors.slice(0, 10) };
  await logRun("backfill", startedAt, errors.length === 0, detail);
  return json(detail);
});
