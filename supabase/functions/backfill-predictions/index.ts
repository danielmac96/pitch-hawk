// Reconstruct the per-pitch predictions the old poller never wrote.
//
// live-poll used to score one batch per 30-second tick rather than one per
// pitch, so stored history is full of holes: 4,062 pitches on 2026-08-14 with
// only 2,459 predicted into (60.5%), 93 at-bats with nothing at all, and 212
// missing their first-pitch call. The poller no longer opens those holes; this
// closes the ones already there.
//
// Everything needed is in `pitches`, which carries balls/strikes POST-pitch —
// so the count faced going into each position is recoverable and no MLB call is
// made here. The enumeration is the same `pendingAtBats` the poller runs, so
// the two cannot drift.
//
// IMPORTANT — these rows are not equivalent to live calls, and they are stamped
// `backfilled_at` to say so. The features carry no look-ahead (the count is the
// one that stood before the pitch), but the rolling stats used to score them
// are TODAY'S trailing-30-day snapshot, not the ones that stood on the day. A
// backfilled row is the call the model would make now about a past pitch. See
// migration 20260815000001 for the full note.
//
// POST /backfill-predictions { "date": "YYYY-MM-DD" }
//                            { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }
// Requires x-cron-secret.

import { json, logRun, requireCronSecret, svc } from "../_shared/db.ts";
import { pendingAtBats, posKey } from "../_shared/livepitch.ts";
import { latestOdds, ouJoin } from "../_shared/market.ts";
import {
  loadActiveModels, pitchesOverProb, predictAbPitches, predictAbResult,
  predictPitchResult, predictPitchSpeed, ScoreContext, speedOverProb,
} from "../_shared/model.ts";

// Edge functions get a wall-clock budget; leave room to write what we scored.
const TIME_BUDGET_MS = 45_000;
// A plate appearance never legitimately runs past this, and the sweep is
// unbounded here (unlike the poller's 4-at-bat lookback) because the whole
// point is to reach every hole in a finished game.
const PA_CAP = 25;

function topClass(probs: Record<string, number> | null): string | null {
  if (!probs) return null;
  return Object.entries(probs).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function dayList(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${from}T12:00:00Z`); d <= new Date(`${to}T12:00:00Z`);) {
    out.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() + 864e5);
  }
  // Newest first: the most recent slate is the one anyone is looking at.
  return out.reverse();
}

Deno.serve(async (req) => {
  const denied = await requireCronSecret(req);
  if (denied) return denied;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const db = svc();

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_e) { /* allow empty */ }

  const single = body.date as string | undefined;
  const from = (body.from as string | undefined) ?? single;
  const to = (body.to as string | undefined) ?? single;
  if (!from || !to) {
    return json({ error: "pass { date } or { from, to } as YYYY-MM-DD" }, 400);
  }

  const models = await loadActiveModels();
  const errors: string[] = [];
  const detail: Record<string, unknown> = { from, to };
  let gamesTouched = 0, positionsWritten = 0, rowsWritten = 0;
  let budgetHit = false;

  outer:
  for (const date of dayList(from, to)) {
    const { data: gameRows } = await db.from("games")
      .select("game_pk").eq("official_date", date);
    for (const g of gameRows ?? []) {
      if (Date.now() - t0 > TIME_BUDGET_MS) { budgetHit = true; break outer; }
      try {
        // Stored pitches are the whole source. Ordered so a game longer than
        // one page still reconstructs in pitch order.
        const { data: pitchRows } = await db.from("pitches")
          .select("at_bat_index,pitch_number,balls,strikes,pitcher_id,batter_id")
          .eq("game_pk", g.game_pk)
          .order("at_bat_index", { ascending: true })
          .order("pitch_number", { ascending: true })
          .limit(2000);
        if (!pitchRows?.length) continue;

        const { data: havePos } = await db.from("predictions")
          .select("at_bat_index,pitch_number")
          .eq("game_pk", g.game_pk).eq("market", "pitch_result");
        const done = new Set<string>(
          (havePos ?? [])
            .filter((r: any) => r.at_bat_index != null && r.pitch_number != null)
            .map((r: any) => posKey(Number(r.at_bat_index), Number(r.pitch_number))),
        );

        // openAbi is null: every at-bat in a stored game is finished, so every
        // position is a call about a pitch that was actually thrown and none of
        // them get a forward slot.
        const work = pendingAtBats({
          pitches: pitchRows as any,
          openAbi: null,
          done,
          lookback: Number.MAX_SAFE_INTEGER,
          cap: PA_CAP,
        });
        if (!work.length) continue;

        const { data: abpHave } = await db.from("predictions")
          .select("at_bat_index")
          .eq("game_pk", g.game_pk).eq("market", "ab_pitches_ou");
        const abpDone = new Set((abpHave ?? []).map((r: any) => Number(r.at_bat_index)));

        // Historical odds are pruned at 14 days, so this is usually empty and
        // ouJoin falls back to the model's own fair line — the same thing the
        // live poller does when no book is quoting.
        const odds = await latestOdds(g.game_pk);

        const statsCache = new Map<string, any>();
        const statsFor = async (pid: number | null, bid: number | null) => {
          const ck = `${pid ?? 0}:${bid ?? 0}`;
          const hit = statsCache.get(ck);
          if (hit) return hit;
          const [pRoll, bRoll, pInfo, bInfo] = await Promise.all([
            pid ? db.from("pitcher_rolling_stats").select("*").eq("pitcher_id", pid).maybeSingle() : Promise.resolve({ data: null }),
            bid ? db.from("batter_rolling_stats").select("*").eq("batter_id", bid).maybeSingle() : Promise.resolve({ data: null }),
            pid ? db.from("player_info").select("*").eq("player_id", pid).maybeSingle() : Promise.resolve({ data: null }),
            bid ? db.from("player_info").select("*").eq("player_id", bid).maybeSingle() : Promise.resolve({ data: null }),
          ]);
          const val = {
            pitcher: (pRoll as any).data, batter: (bRoll as any).data,
            pitcher_info: (pInfo as any).data, batter_info: (bInfo as any).data,
          };
          statsCache.set(ck, val);
          return val;
        };

        const nowIso = new Date().toISOString();
        const rows: Record<string, unknown>[] = [];

        for (const w of work) {
          const stats = await statsFor(w.pitcher_id, w.batter_id);
          const ctxAt = (pos: { k: number; balls: number; strikes: number }): ScoreContext => ({
            balls: pos.balls, strikes: pos.strikes, pitch_count_pa: pos.k,
            pitcher: stats.pitcher, batter: stats.batter,
            pitcher_info: stats.pitcher_info, batter_info: stats.batter_info,
          });

          for (const pos of w.positions) {
            const c = ctxAt(pos);
            const speed = predictPitchSpeed(models, c);
            const pres = predictPitchResult(models, c);
            const abr = predictAbResult(models, c);
            const marketRows: any[] = [
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
            ];
            // One pre-at-bat call per PA, at the earliest position written.
            if (pos.k === w.positions[0].k && !abpDone.has(w.at_bat_index)) {
              const abp = predictAbPitches(models, c);
              marketRows.push(ouJoin(
                abp,
                (line) => pitchesOverProb(c.pitch_count_pa, abp.dist, abp.predicted_value!, line),
                odds["ab_pitches_ou"], true,
              ));
            }
            for (const m of marketRows) {
              rows.push({
                game_pk: g.game_pk, at_bat_index: w.at_bat_index,
                pitch_number: pos.k, backfilled_at: nowIso, ...m,
              });
            }
            positionsWritten += 1;
          }
        }

        // No picks are published here, at all. A pick is a wager that was
        // available at a moment in time; there was no such moment for any of
        // these, and inventing one would put bets in the record that nobody
        // could have made. game_predictions is likewise untouched — its live
        // row described the game as it stood.
        if (rows.length) {
          for (let i = 0; i < rows.length; i += 500) {
            const { error } = await db.from("predictions").insert(rows.slice(i, i + 500));
            if (error) { errors.push(`game ${g.game_pk}: ${error.message}`); break; }
            rowsWritten += Math.min(500, rows.length - i);
          }
          gamesTouched += 1;
        }
      } catch (e) {
        errors.push(`game ${g.game_pk}: ${String(e).slice(0, 160)}`);
      }
    }
  }

  detail.games = gamesTouched;
  detail.positions = positionsWritten;
  detail.rows = rowsWritten;
  // Re-invoke with the same range until this is false: the budget stops the
  // pass mid-range, and the existence probe makes a repeat run skip whatever
  // already landed.
  detail.budget_exhausted = budgetHit;
  detail.errors = errors.slice(0, 10);
  await logRun("backfill-predictions", startedAt, errors.length === 0, detail);
  return json(detail);
});
