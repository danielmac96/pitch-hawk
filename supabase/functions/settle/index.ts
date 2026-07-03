// Settlement — grades pending predictions AND picks against real outcomes.
// Mirrors backend/jobs/settle_predictions.py (that module documents the rules).
// Requires x-cron-secret. Scheduled every 10 minutes via pg_cron.

import { json, logRun, requireCronSecret, svc } from "../_shared/db.ts";

const BATCH = 400;

function winProfit(price: number | null | undefined, units = 1): number {
  if (price == null) return units;
  return price > 0 ? round3((price / 100) * units) : round3((100 / Math.abs(price)) * units);
}

function round3(v: number): number { return Math.round(v * 1000) / 1000; }

interface Grade { result: string; profit: number }

function nextPitch(pitches: any[], abi: number | null, pn: number | null): any | null {
  const a = abi ?? -1, p = pn ?? -1;
  const later = pitches.filter((x) =>
    x.at_bat_index != null && x.pitch_number != null &&
    (x.at_bat_index > a || (x.at_bat_index === a && x.pitch_number > p))
  );
  if (!later.length) return null;
  return later.reduce((m, x) =>
    (x.at_bat_index < m.at_bat_index ||
     (x.at_bat_index === m.at_bat_index && x.pitch_number < m.pitch_number)) ? x : m);
}

function gradeRow(
  row: any, pitches: any[], absByIdx: Map<number, any>, gameLive: boolean,
  finalScores: { home: number | null; away: number | null } | null,
): Grade | null {
  const rec = row.recommendation;
  if (!rec) return { result: "void", profit: 0 };
  const units = Number(row.units ?? 1);

  if (row.market === "game_moneyline") {
    if (!finalScores || finalScores.home == null || finalScores.away == null) return null;
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
      if (nxt.start_speed == null || row.line == null) return { result: "void", profit: 0 };
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
    if (ab.pitch_count == null || row.line == null) return { result: "void", profit: 0 };
    if (Number(ab.pitch_count) === Number(row.line)) return { result: "push", profit: 0 };
    const actual = Number(ab.pitch_count) > Number(row.line) ? "over" : "under";
    return rec === actual
      ? { result: "win", profit: winProfit(row.price, units) }
      : { result: "loss", profit: -units };
  }

  return null;
}

async function settleTable(table: "predictions" | "picks"): Promise<{ graded: number; errors: string[] }> {
  const db = svc();
  const errors: string[] = [];
  const statusCol = table === "picks" ? "status" : "result";
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
    const absByIdx = new Map<number, any>();
    for (const a of abRows ?? []) if (a.at_bat_index != null) absByIdx.set(a.at_bat_index, a);
    const status = game?.status ?? "";
    const isFinal = status.startsWith("Final") || status === "Game Over" || status === "Completed Early";
    const gameLive = !isFinal;
    const finalScores = isFinal ? { home: game?.home_score ?? null, away: game?.away_score ?? null } : null;

    for (const r of rows) {
      const pnRow = table === "picks" ? { ...r, pitch_number: null } : r;
      const grade = gradeRow(pnRow, pitches ?? [], absByIdx, gameLive, finalScores);
      if (!grade) continue;
      const patch: Record<string, unknown> = {
        [statusCol]: grade.result,
        profit_units: grade.profit,
        graded_at: new Date().toISOString(),
      };
      const { error: uerr } = await db.from(table).update(patch).eq("id", r.id);
      if (uerr) errors.push(uerr.message);
      else graded += 1;
    }
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
