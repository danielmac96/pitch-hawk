// Live poller — runs every 30s via pg_cron while games are on.
//
// For each in-progress game: ingest new pitches/at_bats, refresh live_state
// (with the current-PA pitch list cached in raw_json for the read API),
// score the four micro-markets + the moneyline, persist prediction rows
// (one batch per new pitch state), and publish threshold-crossing picks.
//
// Requires x-cron-secret.

import { json, logRun, requireCronSecret, svc, upsertChunked } from "../_shared/db.ts";
import { ensurePlayers, upsertGames } from "../_shared/ingest.ts";
import {
  currentPaPitches, deriveLiveState, getPlayByPlay, getSchedule, isLive,
  liveHomeWinProb,
} from "../_shared/mlb.ts";
import {
  loadActiveModels, MarketPrediction, pitchesOverProb, predictAbPitches,
  predictAbResult, predictPitchResult, predictPitchSpeed, ScoreContext,
  speedOverProb,
} from "../_shared/model.ts";
import { americanToProb, probToAmerican } from "../_shared/vocab.ts";

const AB_PICK_MARGIN = 0.08;   // model prob must beat league baseline by this
const ML_PICK_EDGE = 0.04;     // model win prob vs market implied
const LEAGUE_AB = { strikeout: 0.221, walk: 0.087, hit: 0.239, out: 0.453 } as Record<string, number>;

async function latestOdds(gamePk: number): Promise<Record<string, any[]>> {
  const { data } = await svc().from("odds")
    .select("market,outcome,line,over_price,under_price,price_american,implied_prob,source,fetched_at")
    .eq("game_pk", gamePk)
    .gte("fetched_at", new Date(Date.now() - 30 * 60_000).toISOString())
    .order("fetched_at", { ascending: false }).limit(60);
  const byMarket: Record<string, any[]> = {};
  const seen = new Set<string>();
  for (const r of data ?? []) {
    const key = `${r.market}:${r.source}:${r.outcome ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    (byMarket[r.market] ??= []).push(r);
  }
  return byMarket;
}

function ouJoin(
  pred: MarketPrediction, overProb: (line: number) => number, odds: any[] | undefined,
): Record<string, unknown> {
  const row: Record<string, unknown> = {
    market: pred.market, predicted_value: pred.predicted_value,
    confidence: pred.confidence, probs: pred.probs, recommendation: null,
    line: null, price: null, edge: null, model_version: pred.model_version,
  };
  const quote = (odds ?? []).find((o) => o.line != null);
  if (!quote || pred.predicted_value == null) return row;
  const line = Number(quote.line);
  const pOver = overProb(line);
  const side = pOver >= 0.5 ? "over" : "under";
  const pSide = side === "over" ? pOver : 1 - pOver;
  const price = side === "over" ? quote.over_price : quote.under_price;
  const implied = americanToProb(price);
  row.recommendation = side;
  row.line = line;
  row.price = price;
  row.confidence = Math.round(pSide * 10000) / 10000;
  row.edge = implied != null ? Math.round((pSide - implied) * 10000) / 10000 : null;
  return row;
}

Deno.serve(async (req) => {
  const denied = await requireCronSecret(req);
  if (denied) return denied;
  const startedAt = new Date().toISOString();
  const db = svc();
  const detail: Record<string, unknown> = {};
  const errors: string[] = [];

  try {
    const today = new Date().toISOString().slice(0, 10);
    const sched = await getSchedule(today);
    await upsertGames(sched);
    const liveGames = sched.filter((g) => isLive(g.status));
    detail.live_games = liveGames.length;
    if (!liveGames.length) {
      // Mark stale live_state rows finished so the board empties out.
      await db.from("live_state").update({ status: "final" })
        .eq("status", "live")
        .lt("updated_at", new Date(Date.now() - 20 * 60_000).toISOString());
      await logRun("live-poll", startedAt, true, detail);
      return json(detail);
    }

    const models = await loadActiveModels();
    let newPitchStates = 0, predictionsWritten = 0, picksWritten = 0;

    for (const g of liveGames) {
      try {
        const { pitches, atBats } = await getPlayByPlay(g.game_pk);
        const state = deriveLiveState(g.game_pk, pitches);
        if (!state) continue;

        // Skip DB writes when nothing new happened since the stored state.
        const { data: prevLs } = await db.from("live_state")
          .select("last_pitch_ts,pitch_count_pa").eq("game_pk", g.game_pk).maybeSingle();
        const changed = !prevLs || prevLs.last_pitch_ts !== state.last_pitch_ts;

        const paPitches = currentPaPitches(pitches);
        const lsRow = {
          ...state,
          home_score: g.home_score, away_score: g.away_score,
          raw_json: {
            current_pa_pitches: paPitches,
            away_team: g.away_team, home_team: g.home_team,
            away_abbr: g.away_abbr, home_abbr: g.home_abbr,
          },
        };
        await db.from("live_state").upsert(lsRow, { onConflict: "game_pk" });

        if (!changed) continue;
        newPitchStates += 1;

        const pitchRows = pitches.filter((p) => p.at_bat_index != null && p.pitch_number != null);
        await upsertChunked("pitches", pitchRows as any, "game_pk,at_bat_index,pitch_number");
        await upsertChunked("at_bats", atBats.filter((a) => a.at_bat_index != null) as any, "game_pk,at_bat_index");

        const pitcherId = state.pitcher_id as number | null;
        const batterId = state.batter_id as number | null;
        await ensurePlayers([pitcherId, batterId].filter(Boolean) as number[]);

        const [pRoll, bRoll, pInfo, bInfo] = await Promise.all([
          pitcherId ? db.from("pitcher_rolling_stats").select("*").eq("pitcher_id", pitcherId).maybeSingle() : Promise.resolve({ data: null }),
          batterId ? db.from("batter_rolling_stats").select("*").eq("batter_id", batterId).maybeSingle() : Promise.resolve({ data: null }),
          pitcherId ? db.from("player_info").select("*").eq("player_id", pitcherId).maybeSingle() : Promise.resolve({ data: null }),
          batterId ? db.from("player_info").select("*").eq("player_id", batterId).maybeSingle() : Promise.resolve({ data: null }),
        ]);

        const ctx: ScoreContext = {
          balls: Number(state.balls ?? 0), strikes: Number(state.strikes ?? 0),
          pitch_count_pa: Number(state.pitch_count_pa ?? 0),
          pitcher: (pRoll as any).data, batter: (bRoll as any).data,
          pitcher_info: (pInfo as any).data, batter_info: (bInfo as any).data,
        };

        const odds = await latestOdds(g.game_pk);
        const speed = predictPitchSpeed(models, ctx);
        const abp = predictAbPitches(models, ctx);
        const pres = predictPitchResult(models, ctx);
        const abr = predictAbResult(models, ctx);

        const marketRows = [
          ouJoin(speed, (line) => speedOverProb(speed.predicted_value!, speed.sigma, line), odds["pitch_speed_ou"]),
          {
            market: "pitch_result", predicted_value: pres.predicted_value,
            confidence: pres.confidence, probs: pres.probs,
            recommendation: topClass(pres.probs), line: null, price: null,
            edge: null, model_version: pres.model_version,
          },
          {
            market: "ab_result", predicted_value: abr.predicted_value,
            confidence: abr.confidence, probs: abr.probs,
            recommendation: topClass(abr.probs), line: null, price: null,
            edge: null, model_version: abr.model_version,
          },
          ouJoin(abp, (line) => pitchesOverProb(ctx.pitch_count_pa, abp.dist, abp.predicted_value!, line), odds["ab_pitches_ou"]),
        ];

        // Moneyline: MLB live win prob vs freshest market quote.
        const homeProb = await liveHomeWinProb(g.game_pk);
        if (homeProb != null) {
          const mlQuotes = odds["game_moneyline"] ?? [];
          const homeQ = mlQuotes.find((q) => q.outcome === "home");
          const awayQ = mlQuotes.find((q) => q.outcome === "away");
          const side = homeProb >= 0.5 ? "home" : "away";
          const pSide = side === "home" ? homeProb : 1 - homeProb;
          const q = side === "home" ? homeQ : awayQ;
          const implied = q?.implied_prob != null ? Number(q.implied_prob) : americanToProb(q?.price_american);
          const edge = implied != null ? Math.round((pSide - implied) * 10000) / 10000 : null;
          marketRows.push({
            market: "game_moneyline",
            predicted_value: Math.round(homeProb * 10000) / 10000,
            confidence: Math.round(pSide * 10000) / 10000,
            probs: { home: Math.round(homeProb * 10000) / 10000, away: Math.round((1 - homeProb) * 10000) / 10000 },
            recommendation: side, line: null,
            price: q?.price_american ?? probToAmerican(implied),
            edge, model_version: "mlb_winprob_v1",
          });

          if (edge != null && edge >= ML_PICK_EDGE) {
            picksWritten += await publishPick(g, {
              market: "game_moneyline", recommendation: side,
              label: `${side === "home" ? g.home_team : g.away_team} ML (live)`,
              price: q?.price_american ?? null, confidence: pSide, edge,
              source: q?.source ?? null, model_version: "mlb_winprob_v1",
              at_bat_index: null,
            });
          }
        }

        // Persist the prediction batch at this PA position.
        const abi = latestAbIndex(pitches);
        const pn = Number(state.pitch_count_pa ?? 0) || null;
        const predRows = marketRows.map((m) => ({
          game_pk: g.game_pk, at_bat_index: abi, pitch_number: pn, ...m,
        }));
        const { error: predErr } = await db.from("predictions").insert(predRows);
        if (predErr) errors.push(`pred ${g.game_pk}: ${predErr.message}`);
        else predictionsWritten += predRows.length;

        // Publish an at-bat pick when the model strongly beats league base.
        const abProbs = abr.probs ?? {};
        for (const cls of ["strikeout", "walk", "hit"]) {
          const p = abProbs[cls];
          if (p != null && p - LEAGUE_AB[cls] >= AB_PICK_MARGIN && ctx.pitch_count_pa === 0) {
            const batterName = (bInfo as any).data?.full_name ?? "Batter";
            picksWritten += await publishPick(g, {
              market: "ab_result", recommendation: cls,
              label: `${batterName} — ${cls[0].toUpperCase()}${cls.slice(1)}`,
              price: null, confidence: p,
              edge: Math.round((p - LEAGUE_AB[cls]) * 10000) / 10000,
              source: "model", model_version: abr.model_version,
              at_bat_index: abi,
              extraPayload: {
                pitcher: { name: (pInfo as any).data?.full_name, hand: (pInfo as any).data?.pitch_hand },
                batter: { name: batterName, hand: (bInfo as any).data?.bat_side },
              },
            });
          }
        }
      } catch (e) {
        errors.push(`game ${g.game_pk}: ${String(e).slice(0, 160)}`);
      }
    }

    detail.new_pitch_states = newPitchStates;
    detail.predictions = predictionsWritten;
    detail.picks = picksWritten;
    detail.errors = errors.slice(0, 10);
    await logRun("live-poll", startedAt, errors.length === 0, detail);
    return json(detail);
  } catch (e) {
    detail.fatal = String(e);
    await logRun("live-poll", startedAt, false, detail);
    return json(detail, 500);
  }
});

function topClass(probs: Record<string, number> | null): string | null {
  if (!probs) return null;
  return Object.entries(probs).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function latestAbIndex(pitches: { at_bat_index: number | null }[]): number | null {
  const idx = pitches.map((p) => p.at_bat_index).filter((x): x is number => x != null);
  return idx.length ? Math.max(...idx) : null;
}

async function publishPick(g: any, p: {
  market: string; recommendation: string; label: string; price: number | null;
  confidence: number; edge: number | null; source: string | null;
  model_version: string; at_bat_index: number | null;
  extraPayload?: Record<string, unknown>;
}): Promise<number> {
  const payload = {
    game: {
      away: g.away_abbr ?? g.away_team, home: g.home_abbr ?? g.home_team,
      matchup: `${g.away_abbr ?? g.away_team} @ ${g.home_abbr ?? g.home_team}`,
      venue: g.venue_name, first_pitch: g.start_ts,
    },
    bullets: [],
    ...(p.extraPayload ?? {}),
  };
  const { error } = await svc().from("picks").upsert({
    pick_date: new Date().toISOString().slice(0, 10),
    game_pk: g.game_pk, at_bat_index: p.at_bat_index,
    market: p.market, recommendation: p.recommendation, label: p.label,
    price: p.price, confidence: Math.round(p.confidence * 10000) / 10000,
    edge: p.edge, units: 1, book: p.source, source: p.source ?? "model",
    model_version: p.model_version, status: "pending", payload,
  }, { onConflict: "pick_date,game_pk,market,at_bat_index,recommendation", ignoreDuplicates: true });
  return error ? 0 : 1;
}
