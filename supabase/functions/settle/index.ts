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

// `value` and `label` are what actually happened, carried out of grading
// rather than discarded. gradeRow already had to compute both to decide
// win/loss; persisting them is what lets the Data Feed render
// "predicted 94.2, actual 93.1" from the table instead of rebuilding it in
// browser memory, and what puts actuals in the R2 holdout export.
interface Grade {
  result: string;
  profit: number;
  value?: number | null;
  label?: string | null;
}

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

  // Every branch below carries the actual out with it. `value` is the measured
  // quantity where one exists, `label` the categorical outcome — see the
  // column comments in 20260808000002.
  const decide = (
    actual: string | null, value: number | null, label: string | null,
  ): Grade =>
    rec === actual
      ? { result: "win", profit: winProfit(row.price, units), value, label }
      : { result: "loss", profit: -units, value, label };

  if (row.market === "game_moneyline") {
    if (!finalScores || finalScores.home == null || finalScores.away == null) return null;
    const margin = finalScores.home - finalScores.away;
    if (finalScores.home === finalScores.away) {
      return { result: "push", profit: 0, value: 0, label: "tie" };
    }
    const winner = margin > 0 ? "home" : "away";
    return decide(winner, margin, winner);
  }

  if (row.market === "pitch_speed_ou" || row.market === "pitch_result") {
    const nxt = nextPitch(pitches, row.at_bat_index, row.pitch_number);
    if (!nxt) return gameLive ? null : { result: "void", profit: 0 };
    if (row.market === "pitch_speed_ou") {
      if (nxt.start_speed == null || row.line == null) return { result: "void", profit: 0 };
      const speed = Number(nxt.start_speed);
      const side = speed > Number(row.line) ? "over" : "under";
      // value is the speed itself, not the over/under side: the Data Feed
      // shows the miss in mph, which the side alone cannot express.
      return decide(side, speed, side);
    }
    const cat = nxt.result_category;
    if (!cat) return { result: "void", profit: 0 };
    return decide(cat, null, cat);
  }

  if (row.market === "ab_result" || row.market === "ab_pitches_ou") {
    const ab = absByIdx.get(row.at_bat_index ?? 0);
    if (!ab) return gameLive ? null : { result: "void", profit: 0 };
    if (row.market === "ab_result") {
      if (!ab.result) return { result: "void", profit: 0 };
      return decide(ab.result, null, ab.result);
    }
    if (ab.pitch_count == null || row.line == null) return { result: "void", profit: 0 };
    const n = Number(ab.pitch_count);
    if (n === Number(row.line)) {
      return { result: "push", profit: 0, value: n, label: "push" };
    }
    const side = n > Number(row.line) ? "over" : "under";
    return decide(side, n, side);
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

    for (const r of rows as any[]) {
      const pnRow = table === "picks" ? { ...r, pitch_number: null } : r;
      const grade = gradeRow(pnRow, pitches ?? [], absByIdx, gameLive, finalScores);
      if (!grade) continue;
      const patch: Record<string, unknown> = {
        [statusCol]: grade.result,
        profit_units: grade.profit,
        graded_at: new Date().toISOString(),
      };
      // Only `predictions` carries the actuals; `picks` has no such columns.
      if (table === "predictions") {
        patch.actual_value = grade.value ?? null;
        patch.actual_label = grade.label ?? null;
      }
      const { error: uerr } = await db.from(table).update(patch).eq("id", r.id);
      if (uerr) errors.push(uerr.message);
      else graded += 1;
    }
  }
  return { graded, errors };
}

// ── game-level grading ─────────────────────────────────────────────────────
// game_predictions rows have no at_bat_index or pitch_number: they are a call
// about the whole game, so they grade against the game's realized aggregates
// rather than against the next pitch.
//
// Only Final games are graded. A row for a game that finished with no pitch data
// in the hot window is voided rather than left pending forever.

function mode(values: (string | null)[]): { value: string | null; rate: number } {
  const counts = new Map<string, number>();
  let n = 0;
  for (const v of values) {
    if (!v) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
    n += 1;
  }
  let best: string | null = null, bv = 0;
  for (const [k, c] of counts) if (c > bv) { bv = c; best = k; }
  return { value: best, rate: n ? bv / n : 0 };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

interface GameGrade extends Grade { actual: number | null }

function gradeGameRow(
  row: any,
  agg: {
    home: number | null; away: number | null;
    speeds: number[]; pitchCats: (string | null)[];
    abResults: (string | null)[]; abPitchCounts: number[];
  },
): GameGrade | null {
  const rec = row.recommendation;
  if (!rec) return { result: "void", profit: 0, actual: null };
  const units = 1;
  const win = (actual: number | null) => ({ result: "win", profit: winProfit(row.price, units), actual });
  const loss = (actual: number | null) => ({ result: "loss", profit: -units, actual });
  const ou = (actual: number | null) => {
    if (actual == null || row.line == null) return { result: "void", profit: 0, actual };
    if (actual === Number(row.line)) return { result: "push", profit: 0, actual };
    return rec === (actual > Number(row.line) ? "over" : "under") ? win(actual) : loss(actual);
  };

  switch (row.market) {
    case "game_moneyline": {
      if (agg.home == null || agg.away == null) return { result: "void", profit: 0, actual: null };
      if (agg.home === agg.away) return { result: "push", profit: 0, actual: null };
      const homeWon = agg.home > agg.away;
      return rec === (homeWon ? "home" : "away") ? win(homeWon ? 1 : 0) : loss(homeWon ? 1 : 0);
    }
    case "game_total": {
      if (agg.home == null || agg.away == null) return { result: "void", profit: 0, actual: null };
      return ou(agg.home + agg.away);
    }
    case "pitch_speed_ou": {
      const m = mean(agg.speeds);
      return ou(m == null ? null : Math.round(m * 100) / 100);
    }
    case "ab_pitches_ou": {
      const m = mean(agg.abPitchCounts);
      return ou(m == null ? null : Math.round(m * 100) / 100);
    }
    // The classification markets predict the game's most common outcome. That
    // is a genuine call but an easy one -- `out` and `strike_foul` win most
    // nights -- so actual_value records the realized RATE of the recommended
    // class, not just the hit/miss. Calibration is the number worth reading
    // here; the win column alone would flatter the model.
    case "pitch_result": {
      const m = mode(agg.pitchCats);
      if (!m.value) return { result: "void", profit: 0, actual: null };
      const rate = Math.round(
        (agg.pitchCats.filter((c) => c === rec).length / Math.max(1, agg.pitchCats.filter(Boolean).length)) * 10000,
      ) / 10000;
      return rec === m.value ? win(rate) : loss(rate);
    }
    case "ab_result": {
      const m = mode(agg.abResults);
      if (!m.value) return { result: "void", profit: 0, actual: null };
      const rate = Math.round(
        (agg.abResults.filter((c) => c === rec).length / Math.max(1, agg.abResults.filter(Boolean).length)) * 10000,
      ) / 10000;
      return rec === m.value ? win(rate) : loss(rate);
    }
    default:
      return null;
  }
}

async function settleGamePredictions(): Promise<{ graded: number; errors: string[] }> {
  const db = svc();
  const errors: string[] = [];
  const { data: pending, error } = await db.from("game_predictions")
    .select("game_pk,market,phase,recommendation,line,price")
    .is("result", "null")
    .order("official_date", { ascending: false })
    .limit(BATCH);
  if (error) return { graded: 0, errors: [error.message] };
  if (!pending?.length) return { graded: 0, errors: [] };

  let graded = 0;
  const gamePks = [...new Set(pending.map((r: any) => r.game_pk).filter(Boolean))];
  for (const gamePk of gamePks) {
    const { data: game } = await db.from("games")
      .select("status,home_score,away_score").eq("game_pk", gamePk).maybeSingle();
    const status = game?.status ?? "";
    const isFinal = status.startsWith("Final") || status === "Game Over" || status === "Completed Early";
    if (!isFinal) continue; // still in progress; try again next run

    const [{ data: pitches }, { data: abRows }] = await Promise.all([
      db.from("pitches").select("start_speed,result_category").eq("game_pk", gamePk).limit(5000),
      db.from("at_bats").select("result,pitch_count").eq("game_pk", gamePk).limit(500),
    ]);
    const agg = {
      home: game?.home_score ?? null,
      away: game?.away_score ?? null,
      speeds: (pitches ?? []).map((p: any) => Number(p.start_speed)).filter((v: number) => Number.isFinite(v)),
      pitchCats: (pitches ?? []).map((p: any) => p.result_category ?? null),
      abResults: (abRows ?? []).map((a: any) => a.result ?? null),
      abPitchCounts: (abRows ?? []).map((a: any) => Number(a.pitch_count)).filter((v: number) => Number.isFinite(v)),
    };

    for (const r of pending.filter((x: any) => x.game_pk === gamePk) as any[]) {
      const grade = gradeGameRow(r, agg);
      if (!grade) continue;
      const { error: uerr } = await db.from("game_predictions").update({
        result: grade.result,
        profit_units: grade.profit,
        actual_value: grade.actual,
        graded_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("game_pk", r.game_pk).eq("market", r.market).eq("phase", r.phase);
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
  const gamePreds = await settleGamePredictions();
  const detail = {
    predictions_graded: preds.graded,
    picks_graded: picks.graded,
    game_predictions_graded: gamePreds.graded,
    errors: [...preds.errors, ...picks.errors, ...gamePreds.errors].slice(0, 10),
  };
  await logRun("settle", startedAt, detail.errors.length === 0, detail);
  return json(detail);
});
