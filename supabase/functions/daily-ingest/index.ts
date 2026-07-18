// Daily refresh — the "database updated daily with all MLB data" job.
//
// 1. Re-ingest yesterday's (and the day before's, for late finishes) final
//    games: schedule rows, pitches, at_bats, player_info.
// 2. Upsert today's schedule so the app knows the upcoming slate.
// 3. Refresh rolling stats + matchup history aggregates.
//
// Scheduled via pg_cron (see migration 20260703000002). Requires x-cron-secret.

import { json, logRun, requireCronSecret, svc } from "../_shared/db.ts";
import { ensurePlayers, ingestGame, upsertGames } from "../_shared/ingest.ts";
import { getSchedule, isFinal, mlbToday } from "../_shared/mlb.ts";

function dayOffset(offset: number): string {
  return mlbToday(offset);
}

Deno.serve(async (req) => {
  const denied = await requireCronSecret(req);
  if (denied) return denied;
  const startedAt = new Date().toISOString();
  const detail: Record<string, unknown> = {};
  const errors: string[] = [];

  try {
    let games = 0, pitches = 0, atBats = 0;
    const playerIds = new Set<number>();
    for (const offset of [-2, -1]) {
      const date = dayOffset(offset);
      const sched = await getSchedule(date);
      await upsertGames(sched);
      for (const g of sched.filter((x) => isFinal(x.status))) {
        try {
          const res = await ingestGame(g.game_pk);
          games += 1; pitches += res.pitches; atBats += res.at_bats;
        } catch (e) {
          errors.push(`game ${g.game_pk}: ${String(e).slice(0, 120)}`);
        }
      }
    }
    detail.finals = { games, pitches, at_bats: atBats };

    // Today + tomorrow's slate for the frontend / pregame picks.
    for (const offset of [0, 1]) {
      const sched = await getSchedule(dayOffset(offset));
      await upsertGames(sched);
    }

    // Enrich any players seen in the last 2 days of at_bats.
    const { data: abPlayers } = await svc()
      .from("at_bats").select("pitcher_id,batter_id")
      .gte("end_ts", new Date(Date.now() - 2 * 864e5).toISOString()).limit(3000);
    for (const r of abPlayers ?? []) {
      if (r.pitcher_id) playerIds.add(r.pitcher_id);
      if (r.batter_id) playerIds.add(r.batter_id);
    }
    detail.players_added = await ensurePlayers([...playerIds]);

    // Aggregates the live scorer reads.
    const { data: n1, error: e1 } = await svc().rpc("refresh_pitcher_rolling_stats");
    const { data: n2, error: e2 } = await svc().rpc("refresh_batter_rolling_stats");
    const { data: n3, error: e3 } = await svc().rpc("refresh_matchup_history");
    for (const e of [e1, e2, e3]) if (e) errors.push(`rpc: ${e.message}`);
    detail.rolling = { pitchers: n1, batters: n2, matchups: n3 };

    // Retention: bound the bookkeeping tables (ingest_runs 30d, odds 14d).
    const { data: pr, error: e4 } = await svc().rpc("prune_ingest_runs");
    const { data: po, error: e5 } = await svc().rpc("prune_odds");
    for (const e of [e4, e5]) if (e) errors.push(`prune: ${e.message}`);
    detail.pruned = { ingest_runs: pr, odds: po };

    detail.errors = errors.slice(0, 10);
    await logRun("daily-ingest", startedAt, errors.length === 0, detail);
    return json(detail);
  } catch (e) {
    detail.fatal = String(e);
    await logRun("daily-ingest", startedAt, false, detail);
    return json(detail, 500);
  }
});
