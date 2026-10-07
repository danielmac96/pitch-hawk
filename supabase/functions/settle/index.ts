// Settlement — grades pending predictions AND picks against real outcomes.
// Grades pending predictions and picks against the next pitch, the finished
// at-bat, or the final score. Chained from live-poll whenever a game advanced;
// np-settle-sweep at 03:00 ET catches anything a failed chain left behind.
// Requires x-cron-secret. Scheduled every 10 minutes via pg_cron.

import { json, logRun, requireCronSecret, svc } from "../_shared/db.ts";
import { gradeProjection } from "../_shared/batterprojection.ts";
import { gradeBase } from "../_shared/basemodels.ts";
import { type BoxLines, parseBoxscore } from "../_shared/boxscore.ts";
import { ingestGame, upsertGames } from "../_shared/ingest.ts";
import { getSchedule, isFinal, mlbGet, mlbToday } from "../_shared/mlb.ts";
import { isStale, isVoidStatus, walkQueue } from "../_shared/settlequeue.ts";

const BATCH = 400;
// predictions/picks: pages walked per run. A page the run cannot grade (a game
// still live, or one waiting on a refresh) is skipped, not re-read forever.
const MAX_PAGES = 5;
// Stale games re-read from MLB per run, each a schedule call and possibly a
// full re-ingest -- bounded so one bad night cannot blow the run's budget.
const STALE_REFRESH_LIMIT = 4;
// Finished games whose projection rows are graded per run (~80 rows each).
const PROJ_GAMES_PER_RUN = 20;

// ── games, per run ──────────────────────────────────────────────────────────
// Every grading path asks "is this game over?" through here. A game whose
// stored status cannot be true any more (not final, yet its Eastern date has
// passed -- see settlequeue.ts) is re-read from MLB; if MLB now says Final the
// row is updated and the game re-ingested, because live-poll stopped following
// it at the date change and its late pitches and at-bats are missing too.
type GameState = { status: string; home_score: number | null; away_score: number | null } | null;
function gameLoader(db: ReturnType<typeof svc>, errors: string[]) {
  const cache = new Map<number, GameState>();
  const schedules = new Map<string, Awaited<ReturnType<typeof getSchedule>>>();
  const today = mlbToday();
  let refreshes = 0;
  return async (gamePk: number): Promise<GameState> => {
    if (cache.has(gamePk)) return cache.get(gamePk)!;
    const { data: game } = await db.from("games")
      .select("status,home_score,away_score,official_date").eq("game_pk", gamePk).maybeSingle();
    let state: GameState = game
      ? { status: game.status ?? "", home_score: game.home_score, away_score: game.away_score }
      : null;
    if (game && isStale(game, today) && refreshes < STALE_REFRESH_LIMIT) {
      refreshes += 1;
      try {
        if (!schedules.has(game.official_date)) {
          schedules.set(game.official_date, await getSchedule(game.official_date));
        }
        const fresh = schedules.get(game.official_date)!.find((g) => g.game_pk === gamePk);
        if (fresh) {
          await upsertGames([fresh]);
          if (isFinal(fresh.status)) await ingestGame(gamePk);
          state = { status: fresh.status ?? "", home_score: fresh.home_score, away_score: fresh.away_score };
        }
      } catch (e) {
        // Stays stale; the next run tries again.
        errors.push(`refresh ${gamePk}: ${String(e).slice(0, 120)}`);
      }
    }
    cache.set(gamePk, state);
    return state;
  };
}

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

async function settleTable(
  table: "predictions" | "picks", loadGame: ReturnType<typeof gameLoader>,
): Promise<{ graded: number; errors: string[] }> {
  const db = svc();
  const errors: string[] = [];
  const statusCol = table === "picks" ? "status" : "result";
  const sel = table === "picks"
    ? "id,game_pk,at_bat_index,market,recommendation,line,price,units,status"
    : "id,game_pk,at_bat_index,pitch_number,market,recommendation,line,price,units,result";

  // Oldest first, but a page that cannot grade is passed over rather than
  // re-read every run -- see settlequeue.ts for the stall this prevents.
  const fetchPage = async (after: number, limit: number) => {
    let q = db.from(table).select(sel).gt("id", after).order("id").limit(limit);
    q = table === "picks" ? q.eq("status", "pending") : q.is("result", "null");
    const { data, error } = await q;
    if (error) { errors.push(error.message); return []; }
    return (data ?? []) as any[];
  };
  const { graded } = await walkQueue(
    fetchPage,
    (rows) => gradeRows(table, statusCol, rows, loadGame, errors),
    { pageSize: BATCH, target: BATCH, maxPages: MAX_PAGES },
  );
  return { graded, errors };
}

async function gradeRows(
  table: "predictions" | "picks", statusCol: string, pending: any[],
  loadGame: ReturnType<typeof gameLoader>, errors: string[],
): Promise<number> {
  const db = svc();
  let graded = 0;
  const gamePks = [...new Set(pending.map((r: any) => r.game_pk).filter(Boolean))];
  for (const gamePk of gamePks) {
    const rows = pending.filter((r: any) => r.game_pk === gamePk);
    const game = await loadGame(gamePk);
    const [{ data: pitches }, { data: abRows }] = await Promise.all([
      db.from("pitches").select("at_bat_index,pitch_number,start_speed,result_category")
        .eq("game_pk", gamePk).order("at_bat_index").order("pitch_number").limit(5000),
      db.from("at_bats").select("at_bat_index,result,pitch_count").eq("game_pk", gamePk).limit(500),
    ]);
    const absByIdx = new Map<number, any>();
    for (const a of abRows ?? []) if (a.at_bat_index != null) absByIdx.set(a.at_bat_index, a);
    const status = game?.status ?? "";
    const final = isFinal(status);
    const gameLive = !final;
    const finalScores = final ? { home: game?.home_score ?? null, away: game?.away_score ?? null } : null;
    // A game that never happened voids its calls instead of leaving them
    // pending for good.
    const voided = isVoidStatus(status);

    for (const r of rows as any[]) {
      const pnRow = table === "picks" ? { ...r, pitch_number: null } : r;
      const grade: Grade | null = voided ? { result: "void", profit: 0 }
        : gradeRow(pnRow, pitches ?? [], absByIdx, gameLive, finalScores);
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
  return graded;
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

async function settleGamePredictions(
  loadGame: ReturnType<typeof gameLoader>,
): Promise<{ graded: number; errors: string[] }> {
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
    const game = await loadGame(gamePk);
    const status = game?.status ?? "";
    if (isVoidStatus(status)) {
      for (const r of pending.filter((x: any) => x.game_pk === gamePk) as any[]) {
        const { error: uerr } = await db.from("game_predictions").update({
          result: "void", profit_units: 0, graded_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("game_pk", r.game_pk).eq("market", r.market).eq("phase", r.phase);
        if (uerr) errors.push(uerr.message); else graded += 1;
      }
      continue;
    }
    if (!isFinal(status)) continue; // still in progress; try again next run

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

/**
 * Grade the batter projections against what the batter actually did.
 *
 * OUTCOME ONLY -- no price, no units, no profit. These rows are `model_fair`:
 * there is no prop line behind them, so a P&L here would be a betting record
 * invented out of even money. What grading buys is REALISED calibration, the
 * production counterpart of the offline gate's `calibration_ratio` and the
 * only way to learn that a model which passed its metrics still runs hot.
 * `ab_result` did exactly that, and graded picks are how it was found.
 *
 * A projected batter who did not bat grades `void`, not `miss`. Lineups change
 * after they are posted, and a late scratch is not a failed prediction --
 * counting it as one would drag every measured rate down by however often
 * clubs change their minds.
 */
async function settleProjections(
  loadGame: ReturnType<typeof gameLoader>,
): Promise<{ graded: number; errors: string[] }> {
  const db = svc();
  const errors: string[] = [];
  // Game by game, oldest first. With the base-model markets a slate carries
  // ~1,200 projection rows, so "the newest N ungraded rows" would be today's
  // unfinished games and never reach yesterday's finished ones -- the same
  // shape of jam as the 2026-09-11 predictions stall. Unfinished games are
  // skipped; a stale status is re-read from MLB by loadGame.
  const { data: pendingRows, error } = await db.from("player_game_projections")
    .select("game_pk")
    .is("result", null)
    .lte("official_date", mlbToday())
    .order("official_date", { ascending: true })
    .limit(5000);
  if (error) return { graded: 0, errors: [error.message] };
  const gamePks = [...new Set((pendingRows ?? []).map((r: any) => r.game_pk))].slice(0, PROJ_GAMES_PER_RUN);

  let graded = 0;
  for (const gamePk of gamePks) {
    const game = await loadGame(gamePk);
    const status = game?.status ?? "";
    // A postponed or cancelled game: nobody played, so every row grades void
    // (zero plate appearances / batters faced).
    const voided = isVoidStatus(status);
    if (!isFinal(status) && !voided) continue; // still in progress; try again next run

    const [{ data: rows }, { data: abRows }] = await Promise.all([
      db.from("player_game_projections").select("game_pk,player_id,market,line")
        .eq("game_pk", gamePk).is("result", null),
      voided ? Promise.resolve({ data: [] as any[] })
        : db.from("at_bats").select("batter_id,pitcher_id,result,result_detail")
          .eq("game_pk", gamePk).limit(500),
    ]);

    // Every plate appearance in the game, by batter and by pitcher.
    const pa = new Map<number, number>(), hits = new Map<number, number>();
    const homers = new Map<number, number>(), tb = new Map<number, number>();
    const bf = new Map<number, number>(), ks = new Map<number, number>();
    const bbs = new Map<number, number>(), hitsAllowed = new Map<number, number>();
    const bump = (m: Map<number, number>, id: number, n = 1) => m.set(id, (m.get(id) ?? 0) + n);
    const TB: Record<string, number> = { single: 1, double: 2, triple: 3, home_run: 4 };
    for (const a of abRows ?? []) {
      if (a.batter_id != null) {
        bump(pa, a.batter_id);
        if (a.result === "hit") bump(hits, a.batter_id);
        if (a.result_detail === "home_run") bump(homers, a.batter_id);
        bump(tb, a.batter_id, TB[a.result_detail] ?? 0);
      }
      if (a.pitcher_id != null) {
        bump(bf, a.pitcher_id);
        if (a.result === "strikeout") bump(ks, a.pitcher_id);
        if (a.result === "walk") bump(bbs, a.pitcher_id);
        if (a.result === "hit") bump(hitsAllowed, a.pitcher_id);
      }
    }

    // The official line, when MLB will give it to us. Runs, outs recorded and
    // earned runs exist nowhere else (see _shared/boxscore.ts); for the rest
    // it agrees with at_bats and is preferred because it is what a book
    // grades against. A fetch failure falls back to at_bats rather than
    // failing the game -- the box-only markets then void.
    let box: BoxLines | null = null;
    if (!voided) {
      try {
        box = parseBoxscore(await mlbGet(`/game/${gamePk}/boxscore`));
      } catch (e) {
        errors.push(`boxscore ${gamePk}: ${String(e).slice(0, 120)}`);
      }
    }

    for (const r of (rows ?? []) as any[]) {
      const id = r.player_id;
      const bl = box?.batters.get(id);
      const pl = box?.pitchers.get(id);
      const g = r.market === "batter_hit" || r.market === "batter_hr"
        ? (bl
          ? gradeProjection(r.market, bl.pa, bl.h, bl.hr)
          : gradeProjection(r.market, pa.get(id) ?? 0, hits.get(id) ?? 0, homers.get(id) ?? 0))
        : gradeBase(r.market, r.line == null ? null : Number(r.line), box
          ? {
            official: true,
            pa: bl?.pa ?? 0, tb: bl?.tb ?? 0, h: bl?.h ?? 0, r: bl?.r ?? 0, rbi: bl?.rbi ?? 0,
            bf: pl?.bf ?? 0, k: pl?.k ?? 0, bb: pl?.bb ?? 0, hits: pl?.h ?? 0,
            outs: pl?.outs ?? 0, er: pl?.er ?? 0,
          }
          : {
            pa: pa.get(id) ?? 0, tb: tb.get(id) ?? 0,
            bf: bf.get(id) ?? 0, k: ks.get(id) ?? 0, bb: bbs.get(id) ?? 0, hits: hitsAllowed.get(id) ?? 0,
          });
      const { error: uerr } = await db.from("player_game_projections").update({
        result: g.result,
        actual_count: g.actual_count,
        plate_appearances: g.plate_appearances,
        graded_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("game_pk", r.game_pk).eq("player_id", r.player_id).eq("market", r.market);
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
  const refreshErrors: string[] = [];
  const loadGame = gameLoader(svc(), refreshErrors);
  const preds = await settleTable("predictions", loadGame);
  const picks = await settleTable("picks", loadGame);
  const gamePreds = await settleGamePredictions(loadGame);
  // Isolated: a failure here must not stop predictions and picks being graded,
  // which is what the record and the board depend on.
  let projections = { graded: 0, errors: [] as string[] };
  try {
    projections = await settleProjections(loadGame);
  } catch (e) {
    projections.errors = [`projections: ${String(e)}`];
  }
  const detail = {
    predictions_graded: preds.graded,
    picks_graded: picks.graded,
    game_predictions_graded: gamePreds.graded,
    projections_graded: projections.graded,
    errors: [...preds.errors, ...picks.errors, ...gamePreds.errors,
             ...projections.errors, ...refreshErrors].slice(0, 10),
  };
  await logRun("settle", startedAt, detail.errors.length === 0, detail);
  return json(detail);
});
