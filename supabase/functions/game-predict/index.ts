// Full-slate pregame scoring — the job that makes the board non-empty.
//
// Until 2026-08-06 the only writer of predictions was live-poll, which pg_cron
// gates to [start_ts, start_ts + 4h). A user loading the site in the morning got
// nothing, because nothing had been computed yet. This runs on the slate itself:
// every scheduled game, all six markets, hours before first pitch.
//
// Pregame rows are written once and never updated. That is deliberate — the
// frozen row is the model's honest pre-game call and the only one that can be
// fairly graded as a track record. In-game movement lives in the phase='live'
// row that live-poll upserts.
//
// Requires x-cron-secret.

import { json, logRun, requireCronSecret, svc } from "../_shared/db.ts";
import { ensurePlayers } from "../_shared/ingest.ts";
import { getProbables, mlbToday } from "../_shared/mlb.ts";
import { latestOdds, ouJoin } from "../_shared/market.ts";
import {
  GameTotalContext, loadActiveModels, log5HomeProb, MarketPrediction,
  pitchesOverProb, predictAbPitches, predictAbResult, predictGameTotal,
  predictPitchResult, predictPitchSpeed, ScoreContext, speedOverProb,
  totalOverProb,
} from "../_shared/model.ts";
import { probToAmerican } from "../_shared/vocab.ts";

// A game that has started, finished, or been called is not something we can make
// a pregame call on.
const NOT_SCOREABLE =
  /^(Final|Game Over|Completed|Postponed|Cancelled|Canceled|Suspended|In Progress|Live|Manager challenge)/i;

function topClass(probs: Record<string, number> | null): string | null {
  if (!probs) return null;
  let best: string | null = null, bv = -Infinity;
  for (const [k, v] of Object.entries(probs)) if (v > bv) { bv = v; best = k; }
  return best;
}

// The pregame micro-market read is a property of the game, not of one pitcher,
// so both probable starters are scored against a league-average batter and the
// two distributions averaged. Scoring only the home starter would report a
// number for half the game.
function meanProbs(
  a: Record<string, number> | null, b: Record<string, number> | null,
): Record<string, number> | null {
  if (!a) return b;
  if (!b) return a;
  const out: Record<string, number> = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    out[k] = Math.round((((a[k] ?? 0) + (b[k] ?? 0)) / 2) * 10000) / 10000;
  }
  return out;
}
const meanNum = (a: number | null, b: number | null) =>
  a == null ? b : b == null ? a : Math.round(((a + b) / 2) * 100) / 100;

Deno.serve(async (req) => {
  const denied = await requireCronSecret(req);
  if (denied) return denied;
  const startedAt = new Date().toISOString();
  const db = svc();
  const detail: Record<string, unknown> = {};
  const errors: string[] = [];

  try {
    let body: any = {};
    try { body = await req.json(); } catch { /* pg_cron posts no body */ }
    const date = typeof body?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
      ? body.date
      : mlbToday();
    detail.date = date;

    const { data: gameRows, error: gErr } = await db.from("games")
      .select("game_pk,season,status,start_ts,venue_id,home_team_id,away_team_id,home_abbr,away_abbr")
      .eq("official_date", date);
    if (gErr) throw new Error(`games: ${gErr.message}`);

    const slate = (gameRows ?? []).filter((g: any) => !NOT_SCOREABLE.test(g.status ?? ""));
    detail.slate = gameRows?.length ?? 0;
    detail.scoreable = slate.length;
    if (!slate.length) {
      await logRun("game-predict", startedAt, true, detail);
      return json(detail);
    }

    // Which rows already exist. Pregame rows are frozen, so a game scored on an
    // earlier run this morning is skipped entirely rather than re-scored.
    const gamePks = slate.map((g: any) => g.game_pk);
    const { data: existing } = await db.from("game_predictions")
      .select("game_pk,market").eq("phase", "pregame").in("game_pk", gamePks);
    const already = new Set((existing ?? []).map((r: any) => `${r.game_pk}:${r.market}`));

    const probables = await getProbables(date);
    const probBy = new Map(probables.map((p) => [p.game_pk, p]));
    const pitcherIds = [...new Set(
      probables.flatMap((p) => [p.home_pitcher_id, p.away_pitcher_id]).filter(Boolean),
    )] as number[];
    // Names have to exist before the board can render "Skenes vs Wheeler".
    detail.players_added = pitcherIds.length ? await ensurePlayers(pitcherIds) : 0;

    const season = slate[0]?.season ?? Number(date.slice(0, 4));
    const noRows = { data: [] as any[] };
    const [
      { data: rollRows }, { data: profRows }, { data: rateRows }, { data: parkRows }, models,
    ] = await Promise.all([
      pitcherIds.length
        ? db.from("pitcher_rolling_stats").select("*").in("pitcher_id", pitcherIds)
        : Promise.resolve(noRows),
      pitcherIds.length
        ? db.from("pitcher_profiles").select("*").in("player_id", pitcherIds)
        : Promise.resolve(noRows),
      db.rpc("team_run_rates", { p_season: season }),
      // Three seasons of park history: enough to be stable, recent enough to
      // reflect current dimensions and humidor rules.
      db.rpc("park_factors", { p_from_season: season - 3 }),
      loadActiveModels(),
    ]);

    const rollBy = new Map((rollRows ?? []).map((r: any) => [r.pitcher_id, r]));
    // Scope preference: season, then d30, then career. Later writes win, so the
    // scopes are applied in ascending order of preference.
    const profBy = new Map<number, any>();
    for (const scope of ["career", "d30", "season"]) {
      for (const r of profRows ?? []) if (r.scope === scope) profBy.set(r.player_id, r);
    }
    const rateBy = new Map((rateRows ?? []).map((r: any) => [r.team_id, r]));
    const parkBy = new Map((parkRows ?? []).map((r: any) => [r.venue_id, Number(r.factor)]));

    const rows: Record<string, unknown>[] = [];
    let skipped = 0;

    for (const g of slate) {
      const prob = probBy.get(g.game_pk);
      const homePid = prob?.home_pitcher_id ?? null;
      const awayPid = prob?.away_pitcher_id ?? null;
      const odds = await latestOdds(g.game_pk);

      const mkCtx = (pitcherId: number | null): ScoreContext => ({
        balls: 0,
        strikes: 0,
        pitch_count_pa: 0,
        pitcher: pitcherId != null ? (rollBy.get(pitcherId) ?? null) : null,
        // League-average batter: a pregame call cannot know who is at the plate,
        // and inventing a lineup would be worse than saying "average hitter".
        batter: null,
        pitcher_info: null,
        batter_info: null,
      });
      const ctxHome = mkCtx(homePid);
      const ctxAway = mkCtx(awayPid);

      const base = {
        game_pk: g.game_pk,
        official_date: date,
        phase: "pregame",
        home_team_id: g.home_team_id ?? null,
        away_team_id: g.away_team_id ?? null,
        home_abbr: g.home_abbr ?? null,
        away_abbr: g.away_abbr ?? null,
        home_pitcher_id: homePid,
        away_pitcher_id: awayPid,
        scored_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const marketRows: Record<string, unknown>[] = [];

      // ── micro-markets, averaged across both probable starters ────────────
      const presH = predictPitchResult(models, ctxHome);
      const presA = predictPitchResult(models, ctxAway);
      const presProbs = meanProbs(presH.probs, presA.probs);
      marketRows.push({
        market: "pitch_result",
        predicted_value: presProbs ? Math.max(...Object.values(presProbs)) : null,
        confidence: presProbs ? Math.max(...Object.values(presProbs)) : null,
        probs: presProbs, recommendation: topClass(presProbs),
        line: null, price: null, edge: null, book: null,
        model_version: presH.model_version,
      });

      const abrH = predictAbResult(models, ctxHome);
      const abrA = predictAbResult(models, ctxAway);
      const abrProbs = meanProbs(abrH.probs, abrA.probs);
      marketRows.push({
        market: "ab_result",
        predicted_value: abrProbs ? Math.max(...Object.values(abrProbs)) : null,
        confidence: abrProbs ? Math.max(...Object.values(abrProbs)) : null,
        probs: abrProbs, recommendation: topClass(abrProbs),
        line: null, price: null, edge: null, book: null,
        model_version: abrH.model_version,
      });

      const spdH = predictPitchSpeed(models, ctxHome);
      const spdA = predictPitchSpeed(models, ctxAway);
      const spd: MarketPrediction & { sigma: number } = {
        ...spdH,
        predicted_value: meanNum(spdH.predicted_value, spdA.predicted_value),
        sigma: (spdH.sigma + spdA.sigma) / 2,
      };
      marketRows.push(ouJoin(
        spd, (line) => speedOverProb(spd.predicted_value!, spd.sigma, line),
        odds["pitch_speed_ou"], true,
      ));

      const abpH = predictAbPitches(models, ctxHome);
      const abpA = predictAbPitches(models, ctxAway);
      const abp = { ...abpH, predicted_value: meanNum(abpH.predicted_value, abpA.predicted_value) };
      marketRows.push(ouJoin(
        abp, (line) => pitchesOverProb(0, abpH.dist, abp.predicted_value!, line),
        odds["ab_pitches_ou"], true,
      ));

      // ── game_moneyline: log5 on season win% ──────────────────────────────
      const homeRate: any = rateBy.get(g.home_team_id);
      const awayRate: any = rateBy.get(g.away_team_id);
      const homeProb = log5HomeProb(
        homeRate?.win_pct != null ? Number(homeRate.win_pct) : null,
        awayRate?.win_pct != null ? Number(awayRate.win_pct) : null,
      );
      const mlQuotes = odds["game_moneyline"] ?? [];
      const side = homeProb >= 0.5 ? "home" : "away";
      const pSide = side === "home" ? homeProb : 1 - homeProb;
      const q = mlQuotes.find((x: any) => x.outcome === side);
      const implied = q?.implied_prob != null ? Number(q.implied_prob) : null;
      marketRows.push({
        market: "game_moneyline",
        predicted_value: Math.round(homeProb * 10000) / 10000,
        confidence: Math.round(pSide * 10000) / 10000,
        probs: {
          home: Math.round(homeProb * 10000) / 10000,
          away: Math.round((1 - homeProb) * 10000) / 10000,
        },
        recommendation: side,
        line: null,
        price: q?.price_american ?? probToAmerican(pSide),
        edge: implied != null ? Math.round((pSide - implied) * 10000) / 10000 : null,
        book: q?.source ?? "model_fair",
        model_version: "log5_v1",
      });

      // ── game_total: projected runs ───────────────────────────────────────
      // Weather is deliberately null here. game_context is published nightly by
      // the warehouse and only covers completed games, so a game starting in six
      // hours has no row in it — the multiplier is 1 and the park factor carries
      // the venue effect. Wiring a forecast in would mean a per-game MLB feed
      // call on every run.
      const totalCtx: GameTotalContext = {
        home_runs_scored_pg: homeRate?.rs_pg != null ? Number(homeRate.rs_pg) : null,
        home_runs_allowed_pg: homeRate?.ra_pg != null ? Number(homeRate.ra_pg) : null,
        away_runs_scored_pg: awayRate?.rs_pg != null ? Number(awayRate.rs_pg) : null,
        away_runs_allowed_pg: awayRate?.ra_pg != null ? Number(awayRate.ra_pg) : null,
        home_starter: homePid != null ? (profBy.get(homePid) ?? null) : null,
        away_starter: awayPid != null ? (profBy.get(awayPid) ?? null) : null,
        park_factor: g.venue_id != null ? (parkBy.get(g.venue_id) ?? null) : null,
        temp_f: null, wind_mph: null, wind_direction: null,
        sample_games: Number(homeRate?.games ?? 0),
      };
      const tot = predictGameTotal(totalCtx);
      marketRows.push(ouJoin(
        tot, (line) => totalOverProb(tot.predicted_value!, tot.sigma, line),
        odds["game_total"], true,
      ));

      for (const m of marketRows) {
        if (already.has(`${g.game_pk}:${m.market}`)) { skipped += 1; continue; }
        rows.push({ ...base, ...m });
      }
    }

    detail.skipped_existing = skipped;
    if (rows.length) {
      // ignoreDuplicates keeps the pregame row frozen: a concurrent run or a
      // retry can never overwrite the call that was already published.
      const { error } = await db.from("game_predictions")
        .upsert(rows, { onConflict: "game_pk,market,phase", ignoreDuplicates: true });
      if (error) throw new Error(`game_predictions: ${error.message}`);
    }
    detail.written = rows.length;
    detail.errors = errors.slice(0, 10);

    await logRun("game-predict", startedAt, errors.length === 0, detail);
    return json(detail);
  } catch (e) {
    detail.fatal = String(e);
    await logRun("game-predict", startedAt, false, detail);
    return json(detail, 500);
  }
});
