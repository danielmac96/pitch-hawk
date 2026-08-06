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
    // Both look back 30 days, which fits inside the 35-day hot window the
    // Phase 3 swap leaves behind (20260802000003).
    const { data: n1, error: e1 } = await svc().rpc("refresh_pitcher_rolling_stats");
    const { data: n2, error: e2 } = await svc().rpc("refresh_batter_rolling_stats");
    for (const e of [e1, e2]) if (e) errors.push(`rpc: ${e.message}`);
    // refresh_matchup_history was called here until 2026-08-02 and is dropped
    // in 20260802000002. It read at_bats with no time filter and upserted the
    // result over the stored career counts, so against a 35-day at_bats it
    // would have overwritten head-to-head history with 35-day figures on the
    // first run after the swap -- silently, and within hours of it.
    // matchup_history is rebuilt from the warehouse in Phase 4 (Task 4.2).
    detail.rolling = { pitchers: n1, batters: n2 };

    // Retention. Roll predictions up into prediction_accuracy_daily BEFORE
    // pruning them — the rollup is the permanent accuracy record and the raw
    // rows are the thing being deleted. Order matters here.
    const { data: ra, error: e3b } = await svc().rpc("rollup_prediction_accuracy");
    if (e3b) errors.push(`rollup: ${e3b.message}`);
    detail.accuracy_rollup = ra;

    // Per-player rollup, same ordering guarantee: predictions carry no player
    // id, so this is the ONLY chance to derive per-pitcher/per-batter history
    // before the raw rows are deleted. It joins at_bats, which is on a 35-day
    // hot window and so still covers the 21-day prune horizon.
    const { data: rp, error: e3c } = await svc().rpc("rollup_player_predictions");
    if (e3c) errors.push(`rollup_player: ${e3c.message}`);
    detail.player_rollup = rp;

    // Bound the bookkeeping tables (ingest_runs 7d, odds 14d, predictions 21d,
    // game_predictions 35d, player_prediction_daily 90d).
    const { data: pr, error: e4 } = await svc().rpc("prune_ingest_runs");
    const { data: po, error: e5 } = await svc().rpc("prune_odds");
    // Skip the prune if EITHER rollup failed, so a bad rollup can't silently
    // destroy predictions we have no aggregate for.
    const { data: pp, error: e6 } = (e3b || e3c)
      ? { data: null, error: null }
      : await svc().rpc("prune_predictions");
    // These two are independent of the raw predictions rollup — they are the
    // aggregates, not the source.
    const { data: pg, error: e7 } = await svc().rpc("prune_game_predictions");
    const { data: pd, error: e8 } = await svc().rpc("prune_player_prediction_daily");
    for (const e of [e4, e5, e6, e7, e8]) if (e) errors.push(`prune: ${e.message}`);
    detail.pruned = {
      ingest_runs: pr, odds: po, predictions: pp,
      game_predictions: pg, player_prediction_daily: pd,
    };

    detail.errors = errors.slice(0, 10);
    await logRun("daily-ingest", startedAt, errors.length === 0, detail);
    return json(detail);
  } catch (e) {
    detail.fatal = String(e);
    await logRun("daily-ingest", startedAt, false, detail);
    return json(detail, 500);
  }
});
