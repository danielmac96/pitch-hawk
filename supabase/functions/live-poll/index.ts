// Live poller — runs every 30s via pg_cron while games are on.
//
// For each in-progress game: ingest new pitches/at_bats, refresh live_state
// (with the current-PA pitch list cached in raw_json for the read API),
// score the four micro-markets + the moneyline, persist prediction rows
// (one batch per new pitch state), and publish threshold-crossing picks.
//
// Requires x-cron-secret.

import {
  invokeFunction, json, logRun, requireCronSecret, svc, upsertChunked,
} from "../_shared/db.ts";
import { ensurePlayers, upsertGames } from "../_shared/ingest.ts";
import { pendingAtBats, posKey } from "../_shared/livepitch.ts";
import {
  currentPaPitches, deriveLiveState, getPlayByPlay, getSchedule, isLive,
  liveHomeWinProb, mlbToday,
} from "../_shared/mlb.ts";
import {
  loadActiveModels, pitchesOverProb, predictAbPitches,
  predictAbResult, predictPitchResult, predictPitchSpeed, ScoreContext,
  speedOverProb,
} from "../_shared/model.ts";
// latestOdds/ouJoin moved to _shared/market.ts so game-predict scores its
// pregame rows against the identical line-join and model_fair convention.
import { latestOdds, ouJoin } from "../_shared/market.ts";
import { americanToProb, probToAmerican } from "../_shared/vocab.ts";

// ab_result picks have no real prop price, so settle grades them flat even-money
// (±1 unit). Only a win prob above the break-even is +EV — "beats the league base
// rate" is not (a 30% strikeout still loses at even money). Gate on the calibrated
// prob clearing 0.5 with a small buffer. See docs/MODELS.md.
const AB_PICK_MIN_PROB = 0.52;
const ML_PICK_EDGE = 0.04;     // model win prob vs market implied

// How many at-bats back each poll sweeps for unscored positions. A plate
// appearance runs ~90 seconds, so four covers any gap the poll cadence can open
// (including a completed PA whose last position is only reachable after the
// fact) while bounding the work per tick. Anything older than this is a job for
// the backfill, not the poller.
const AB_LOOKBACK = 4;

Deno.serve(async (req) => {
  const denied = await requireCronSecret(req);
  if (denied) return denied;
  const startedAt = new Date().toISOString();
  const db = svc();
  const detail: Record<string, unknown> = {};
  const errors: string[] = [];

  try {
    const today = mlbToday();
    const sched = await getSchedule(today);
    await upsertGames(sched);
    const liveGames = sched.filter((g) => isLive(g.status));
    detail.live_games = liveGames.length;
    if (!liveGames.length) {
      // Mark stale live_state rows finished so the board empties out.
      const { data: closed } = await db.from("live_state").update({ status: "final" })
        .eq("status", "live")
        .lt("updated_at", new Date(Date.now() - 20 * 60_000).toISOString())
        .select("game_pk");

      // A game leaving the board is the moment its final-score markets become
      // gradable, and this is the LAST live-poll cycle that will run today --
      // pg_cron stops calling us once no game is in its window and no
      // live_state row reads 'live'. Without this chain, every game-level
      // prediction would sit ungraded until the 03:00 ET sweep.
      if (closed?.length) {
        const r = await invokeFunction("settle");
        detail.closed_games = closed.length;
        detail.settle_invoked = r.ok;
        if (!r.ok) detail.settle_error = r.error;
        // Worth a row: this fires at most once per slate, unlike the bare tick.
        await logRun("live-poll", startedAt, r.ok, detail);
      }
      // The empty tick is deliberately NOT logged to ingest_runs. It fires
      // every 30s for the whole of every game window in which nothing is live,
      // and it was producing ~90% of the table's rows — 46,972 rows on
      // 2026-07-28, of which the last 200 were all `{"live_games": 0}`. The
      // tick is still recorded in cron.job_run_details if it ever needs
      // auditing.
      return json(detail);
    }

    const models = await loadActiveModels();
    let newPitchStates = 0, predictionsWritten = 0, picksWritten = 0;
    // Positions recovered that a single-batch-per-poll writer would have
    // dropped. Non-zero is normal and expected — it is the size of the hole
    // this writer closes, and worth watching rather than hiding.
    let pitchesBackfilled = 0;

    for (const g of liveGames) {
      try {
        const { pitches, atBats, currentPlay } = await getPlayByPlay(g.game_pk);
        const state = deriveLiveState(g.game_pk, pitches, currentPlay);
        if (!state) continue;

        // Skip DB writes when nothing new happened since the stored state.
        const { data: prevLs } = await db.from("live_state")
          .select("last_pitch_ts,pitch_count_pa,batter_id").eq("game_pk", g.game_pk).maybeSingle();
        // Compare as epoch ms: Postgres returns "…11.04+00:00" while MLB sends
        // "…11.040Z" — string equality never holds and every poll looks new.
        const prevTs = prevLs?.last_pitch_ts ? Date.parse(prevLs.last_pitch_ts) : NaN;
        const curTs = state.last_pitch_ts ? Date.parse(String(state.last_pitch_ts)) : NaN;
        // Both-NaN (no pitch thrown yet on either side) is NOT a change, or the
        // pre-first-pitch window would write a duplicate batch every poll.
        const tsChanged = isNaN(prevTs) || isNaN(curTs)
          ? !(isNaN(prevTs) && isNaN(curTs))
          : prevTs !== curTs;
        // A state is also "new" when the PA rolls without a pitch: the next
        // batter's play appears (pitch_count_pa resets, batter changes) and the
        // first-pitch prediction for the new PA must be written then.
        const changed = !prevLs || tsChanged ||
          prevLs.pitch_count_pa !== state.pitch_count_pa ||
          prevLs.batter_id !== state.batter_id;

        const paPitches = currentPaPitches(pitches);
        const lsRow = {
          ...state,
          home_score: g.home_score, away_score: g.away_score,
          raw_json: {
            current_pa_pitches: paPitches,
            current_pa_abi: latestAbIndex(pitches),
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

        const odds = await latestOdds(g.game_pk);
        // Predictions belong to the PA the state describes — after a roll
        // that is the NEW batter's at-bat (which may have no pitches yet).
        const abi = currentPlay?.at_bat_index ?? latestAbIndex(pitches);

        // ── every pitch, not every poll ────────────────────────────────────
        //
        // See _shared/livepitch.ts for what this recovers and why. Short
        // version: one batch per poll meant any pitch that shared a 30-second
        // interval with another was ingested and never scored.
        //
        // The sweep spans at-bats rather than only the one batting, because
        // scoping it to the live PA left two holes it could not reach: a PA's
        // LAST position (only visible while the PA is live, so it needed a poll
        // between the final two pitches — 38.8% of them had no call on
        // 2026-08-14) and a PA that began and ended inside one interval, which
        // nothing ever looked at again (93 at-bats that day).
        //
        // A completed at-bat is still worth scoring: every one of its positions
        // is a call about a pitch that was actually thrown. Only picks are
        // withheld from it — see below.
        const openAbi = currentPlay && !currentPlay.is_complete
          ? currentPlay.at_bat_index
          : null;
        const minAbi = Math.max((abi ?? 0) - AB_LOOKBACK, 0);

        // What this game already has, so a re-poll, a retry, or a game picked
        // up mid-PA never writes a position twice. pitch_result is the probe
        // because it is written at every position, unconditionally.
        const { data: havePos } = await db.from("predictions")
          .select("at_bat_index,pitch_number")
          .eq("game_pk", g.game_pk).eq("market", "pitch_result")
          .gte("at_bat_index", minAbi);
        const done = new Set<string>(
          (havePos ?? [])
            .filter((r: any) => r.at_bat_index != null && r.pitch_number != null)
            .map((r: any) => posKey(Number(r.at_bat_index), Number(r.pitch_number))),
        );

        const work = pendingAtBats({
          pitches: pitches as any,
          openAbi,
          openBalls: currentPlay?.balls ?? (state.balls as number | null),
          openStrikes: currentPlay?.strikes ?? (state.strikes as number | null),
          done,
          lookback: AB_LOOKBACK,
        });
        // Everything this game needs is already stored: nothing new to do.
        if (!work.length) continue;

        // ab_pitches_ou is a pre-at-bat call, one per PA. Probed for the whole
        // lookback window in one query rather than per at-bat.
        const { data: abpHave } = await db.from("predictions")
          .select("at_bat_index")
          .eq("game_pk", g.game_pk).eq("market", "ab_pitches_ou")
          .gte("at_bat_index", minAbi);
        const abpDone = new Set(
          (abpHave ?? []).map((r: any) => Number(r.at_bat_index)),
        );

        await ensurePlayers(
          work.flatMap((w) => [
            w.pitcher_id ?? currentPlay?.pitcher_id ?? null,
            w.batter_id ?? currentPlay?.batter_id ?? null,
          ]).filter(Boolean) as number[],
        );

        // Rolling stats and player_info are constant across a plate
        // appearance, so they are fetched once per matchup rather than once
        // per position: a 7-pitch catch-up costs 4 queries, not 28.
        const statsCache = new Map<string, {
          pitcher: any; batter: any; pitcher_info: any; batter_info: any;
        }>();
        const statsFor = async (pitcherId: number | null, batterId: number | null) => {
          const ck = `${pitcherId ?? 0}:${batterId ?? 0}`;
          const hit = statsCache.get(ck);
          if (hit) return hit;
          const [pRoll, bRoll, pInfo, bInfo] = await Promise.all([
            pitcherId ? db.from("pitcher_rolling_stats").select("*").eq("pitcher_id", pitcherId).maybeSingle() : Promise.resolve({ data: null }),
            batterId ? db.from("batter_rolling_stats").select("*").eq("batter_id", batterId).maybeSingle() : Promise.resolve({ data: null }),
            pitcherId ? db.from("player_info").select("*").eq("player_id", pitcherId).maybeSingle() : Promise.resolve({ data: null }),
            batterId ? db.from("player_info").select("*").eq("player_id", batterId).maybeSingle() : Promise.resolve({ data: null }),
          ]);
          const val = {
            pitcher: (pRoll as any).data, batter: (bRoll as any).data,
            pitcher_info: (pInfo as any).data, batter_info: (bInfo as any).data,
          };
          statsCache.set(ck, val);
          return val;
        };

        // The three markets that are genuinely per-pitch. ab_pitches_ou and
        // game_moneyline are not, and are handled once, below.
        const perPitchMarkets = (c: ScoreContext) => {
          const speed = predictPitchSpeed(models, c);
          const pres = predictPitchResult(models, c);
          const abr = predictAbResult(models, c);
          return {
            abr,
            rows: [
              ouJoin(speed, (line) => speedOverProb(speed.predicted_value!, speed.sigma, line), odds["pitch_speed_ou"], true),
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
            ],
          };
        };

        // Score every outstanding position, oldest at-bat first so rows land in
        // the order the pitches did.
        const predRows: Record<string, unknown>[] = [];
        let liveBatch:
          | { abi: number; ctx: ScoreContext; abr: any; rows: any[]; k: number; stats: any }
          | null = null;

        for (const w of work) {
          const stats = await statsFor(
            w.pitcher_id ?? currentPlay?.pitcher_id ?? null,
            w.batter_id ?? currentPlay?.batter_id ?? null,
          );
          const ctxAt = (pos: { k: number; balls: number; strikes: number }): ScoreContext => ({
            balls: pos.balls, strikes: pos.strikes, pitch_count_pa: pos.k,
            pitcher: stats.pitcher, batter: stats.batter,
            pitcher_info: stats.pitcher_info, batter_info: stats.batter_info,
          });

          const scored = w.positions.map((pos) => ({ k: pos.k, ...perPitchMarkets(ctxAt(pos)) }));
          // Positions recovered beyond the one a single-batch writer would have
          // produced for this at-bat.
          pitchesBackfilled += Math.max(scored.length - 1, 0);

          // Total-pitches is a PRE-at-bat call: written once per PA so the
          // projection shown during the at-bat never drifts from the call made
          // before it. Priced from the earliest position we are writing, which
          // is where the row is stamped.
          if (!abpDone.has(w.at_bat_index)) {
            const abpCtx = ctxAt(w.positions[0]);
            const abp = predictAbPitches(models, abpCtx);
            scored[0].rows.push(ouJoin(
              abp,
              (line) => pitchesOverProb(abpCtx.pitch_count_pa, abp.dist, abp.predicted_value!, line),
              odds["ab_pitches_ou"], true,
            ));
          }

          for (const sc of scored) {
            for (const m of sc.rows) {
              predRows.push({
                game_pk: g.game_pk, at_bat_index: w.at_bat_index,
                pitch_number: sc.k, ...m,
              });
            }
          }

          // The live batch drives the game-level mirror, the picks and the
          // game-wide markets: those describe now, not a pitch already thrown.
          // Only the open at-bat qualifies — a call reconstructed after its
          // pitch landed is not something anyone could have bet.
          if (w.open) {
            const last = scored[scored.length - 1];
            liveBatch = {
              abi: w.at_bat_index, k: last.k, stats,
              ctx: ctxAt(w.positions[w.positions.length - 1]),
              abr: last.abr, rows: last.rows,
            };
          }
        }

        // Game-wide markets and picks hang off the live batch. On a poll that
        // only recovered finished at-bats there is no live position, so they
        // are correctly skipped this tick.
        const marketRows = liveBatch?.rows ?? [];

        // Moneyline: MLB live win prob vs freshest market quote. Game-wide
        // rather than per-pitch, so it is written once per poll at the live
        // position instead of at every position recovered above.
        if (liveBatch) {
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
            const mlRow = {
              market: "game_moneyline",
              predicted_value: Math.round(homeProb * 10000) / 10000,
              confidence: Math.round(pSide * 10000) / 10000,
              probs: { home: Math.round(homeProb * 10000) / 10000, away: Math.round((1 - homeProb) * 10000) / 10000 },
              recommendation: side, line: null,
              price: q?.price_american ?? probToAmerican(implied),
              edge, model_version: "mlb_winprob_v1",
            };
            marketRows.push(mlRow);
            predRows.push({
              game_pk: g.game_pk, at_bat_index: liveBatch.abi,
              pitch_number: liveBatch.k, ...mlRow,
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
        }

        // Persist every position scored above, each stamped with the pitch it
        // is a call about. Keep 0 (`|| null` would drop it): position 0 = the
        // call on a PA's first pitch, which the board matches by exact
        // position.
        const { error: predErr } = await db.from("predictions").insert(predRows);
        if (predErr) errors.push(`pred ${g.game_pk}: ${predErr.message}`);
        else predictionsWritten += predRows.length;

        // Mirror the batch to the game-level table at phase='live'.
        //
        // This is an UPSERT, not an insert: it is bounded at one row per market
        // per game no matter how many times the poller runs, so a 4-hour game at
        // 30s intervals still leaves 6 rows. The per-pitch rows above are
        // untouched and remain the live board's source; these are what survives
        // the 21-day prune and backs the 30-day feed.
        //
        // Mirrors the LIVE batch only. A poll that recovered nothing but
        // finished at-bats has no "now" to mirror, and stamping one of those
        // reconstructed calls here would make the game-level row describe a
        // pitch already thrown.
        if (liveBatch && marketRows.length) {
          const nowIso = new Date().toISOString();
          const liveGameRows = marketRows.map((m) => ({
            game_pk: g.game_pk,
            // official_date is NOT NULL on the table; the schedule always
            // supplies it, but a null here would fail the whole batch.
            official_date: g.official_date ?? mlbToday(),
            phase: "live",
            home_team_id: g.home_team_id ?? null,
            away_team_id: g.away_team_id ?? null,
            home_abbr: g.home_abbr ?? null,
            away_abbr: g.away_abbr ?? null,
            n_pitch_predictions: liveBatch.k,
            updated_at: nowIso,
            ...m,
          }));
          const { error: gpErr } = await db.from("game_predictions")
            .upsert(liveGameRows, { onConflict: "game_pk,market,phase" });
          // Non-fatal: the per-pitch write above already succeeded, and the live
          // board reads that. A failure here costs feed history, not the board.
          if (gpErr) errors.push(`game_pred ${g.game_pk}: ${gpErr.message}`);
        }

        // ── picks ──────────────────────────────────────────────────────────
        //
        // Picks come from the LIVE position only. Every position recovered by
        // the sweep above is a legitimate prediction — it was scored from the
        // count as it stood, with no knowledge of the pitch that followed — but
        // it is written after that pitch landed, so it is not something anyone
        // could have wagered on. Publishing it would put bets into the record
        // that were never available, which is the one way this change could
        // corrupt the track record.
        if (liveBatch) {
          const info = liveBatch.stats;
          // Publish an at-bat pick once, at the start of the PA (first pitch just
          // landed — the earliest live_state we ever observe for a new batter),
          // when the calibrated win prob clears the even-money break-even (these
          // grade flat ±1 with no real prop price). The unique constraint on
          // (date, game, market, at_bat_index, rec) dedupes. edge is vs the 0.5
          // implied of an even-money bet, matching every other market's edge.
          const abProbs = liveBatch.abr.probs ?? {};
          for (const cls of ["strikeout", "walk", "hit"]) {
            const p = abProbs[cls];
            if (p != null && p >= AB_PICK_MIN_PROB && liveBatch.ctx.pitch_count_pa <= 1) {
              const batterName = info.batter_info?.full_name ?? "Batter";
              picksWritten += await publishPick(g, {
                market: "ab_result", recommendation: cls,
                label: `${batterName} — ${cls[0].toUpperCase()}${cls.slice(1)}`,
                price: null, confidence: p,
                edge: Math.round((p - 0.5) * 10000) / 10000,
                source: "model", model_version: liveBatch.abr.model_version,
                at_bat_index: liveBatch.abi,
                extraPayload: {
                  pitcher: { name: info.pitcher_info?.full_name, hand: info.pitcher_info?.pitch_hand },
                  batter: { name: batterName, hand: info.batter_info?.bat_side },
                },
              });
            }
          }

          // Model-fair micro-market picks (pitch speed / AB pitches): even money
          // vs the model's own fair line, tagged book "model_fair" so the record
          // never reads as beating a real sportsbook. Published only when the
          // model is meaningfully off a coin flip.
          for (const mr of marketRows) {
            const mkt = mr.market as string;
            if ((mkt === "pitch_speed_ou" || mkt === "ab_pitches_ou") &&
                mr.book === "model_fair" && mr.recommendation != null &&
                Number(mr.confidence) >= 0.58) {
              const isSpeed = mkt === "pitch_speed_ou";
              const side = String(mr.recommendation);
              picksWritten += await publishPick(g, {
                market: mkt, recommendation: side,
                label: `${isSpeed ? "Next pitch" : "AB pitches"} ${side} ${mr.line} ${isSpeed ? "mph" : ""}`.trim(),
                line: mr.line as number, price: 100,
                confidence: Number(mr.confidence),
                edge: mr.edge != null ? Number(mr.edge) : null,
                source: "model_fair", model_version: String(mr.model_version),
                at_bat_index: liveBatch.abi,
              });
            }
          }
        }
      } catch (e) {
        errors.push(`game ${g.game_pk}: ${String(e).slice(0, 160)}`);
      }
    }

    // Score against the result we just ingested, rather than waiting for a
    // timer. Only when something actually landed -- on a cycle where no game
    // advanced there is nothing new to grade, and settle would scan for
    // pending rows it already looked at 30 seconds ago.
    if (newPitchStates > 0) {
      const r = await invokeFunction("settle");
      detail.settle_invoked = r.ok;
      // Non-fatal by design: the pitch is already stored, and the 03:00 ET
      // sweep grades anything a failed chain left behind.
      if (!r.ok) errors.push(`settle: ${r.error}`);
    }

    detail.new_pitch_states = newPitchStates;
    detail.predictions = predictionsWritten;
    detail.pitches_backfilled = pitchesBackfilled;
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
  model_version: string; at_bat_index: number | null; line?: number | null;
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
    pick_date: mlbToday(),
    game_pk: g.game_pk, at_bat_index: p.at_bat_index,
    market: p.market, recommendation: p.recommendation, label: p.label,
    line: p.line ?? null,
    price: p.price, confidence: Math.round(p.confidence * 10000) / 10000,
    edge: p.edge, units: 1, book: p.source, source: p.source ?? "model",
    model_version: p.model_version, status: "pending", payload,
  }, { onConflict: "pick_date,game_pk,market,at_bat_index,recommendation", ignoreDuplicates: true });
  return error ? 0 : 1;
}
