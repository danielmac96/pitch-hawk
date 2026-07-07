// Odds ingestion from free, no-auth sources:
//   * ESPN scoreboard API — sportsbook consensus moneyline/spread/total.
//   * Kalshi public market data — KXMLBGAME per-game winner contracts,
//     priced in cents (= implied probability directly).
//
// Snapshots land in the `odds` table (append-only; consumers take the latest
// per market+source+outcome). Also publishes pregame moneyline picks when the
// log5 team-strength model disagrees with the market by >= PICK_EDGE.
//
// Requires x-cron-secret. Scheduled every 5 minutes via pg_cron.

import { json, logRun, requireCronSecret, svc } from "../_shared/db.ts";
import { log5HomeProb } from "../_shared/model.ts";
import { americanToProb, teamIdByAbbr, teamIdByText } from "../_shared/vocab.ts";
import { fetchJson } from "../_shared/http.ts";

const ESPN_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard";
const KALSHI_MARKETS = "https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXMLBGAME&status=open&limit=1000";
const PICK_EDGE = 0.05;

interface GameRef {
  game_pk: number; official_date: string | null; status: string | null;
  home_team: string | null; away_team: string | null;
  home_abbr: string | null; away_abbr: string | null;
  home_team_id: number | null; away_team_id: number | null;
  venue_name: string | null; start_ts: string | null;
}

// Index today's games by team_id so odds feeds join on the fixed MLB id rather
// than a fragile nickname substring. gamesByTeam maps a team_id to the game it
// plays in today (a team plays at most one game per slate for our purposes).
function indexGames(games: GameRef[]): {
  byPair: Map<string, GameRef>; byTeam: Map<number, GameRef>;
} {
  const byPair = new Map<string, GameRef>();
  const byTeam = new Map<number, GameRef>();
  for (const g of games) {
    if (g.home_team_id != null && g.away_team_id != null) {
      byPair.set(`${g.away_team_id}:${g.home_team_id}`, g);
    }
    if (g.home_team_id != null) byTeam.set(g.home_team_id, g);
    if (g.away_team_id != null) byTeam.set(g.away_team_id, g);
  }
  return { byPair, byTeam };
}

// Resolve an ESPN competitor to an MLB team_id: abbreviation first, name fallback.
function espnTeamId(team: any): number | null {
  return teamIdByAbbr(team?.abbreviation) ??
    teamIdByText(team?.displayName ?? team?.name ?? null);
}

async function todaysGames(): Promise<GameRef[]> {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await svc().from("games").select(
    "game_pk,official_date,status,home_team,away_team,home_abbr,away_abbr,home_team_id,away_team_id,venue_name,start_ts",
  ).eq("official_date", today);
  return (data ?? []) as GameRef[];
}

async function ingestEspn(
  idx: ReturnType<typeof indexGames>, unmatched: string[],
): Promise<{ rows: any[]; matched: number }> {
  const data = await fetchJson(ESPN_SCOREBOARD, { timeoutMs: 10_000, retries: 2 });
  const rows: any[] = [];
  let matched = 0;
  for (const ev of data.events ?? []) {
    const comp = ev.competitions?.[0];
    if (!comp) continue;
    const homeC = (comp.competitors ?? []).find((c: any) => c.homeAway === "home");
    const awayC = (comp.competitors ?? []).find((c: any) => c.homeAway === "away");
    const homeId = espnTeamId(homeC?.team);
    const awayId = espnTeamId(awayC?.team);
    const g = homeId != null && awayId != null
      ? idx.byPair.get(`${awayId}:${homeId}`)
      : undefined;
    if (!g) {
      const label = `${awayC?.team?.abbreviation ?? "?"}@${homeC?.team?.abbreviation ?? "?"}`;
      if ((comp.odds?.length ?? 0) > 0) unmatched.push(`espn:${label}`);
      continue;
    }
    const odds = comp.odds?.[0];
    if (!odds) continue;
    matched += 1;
    const now = new Date().toISOString();
    const provider = odds.provider?.name ?? "espn";
    const homeMl = odds.homeTeamOdds?.moneyLine ?? null;
    const awayMl = odds.awayTeamOdds?.moneyLine ?? null;
    if (homeMl != null) {
      rows.push({
        game_pk: g.game_pk, market: "game_moneyline", outcome: "home",
        price_american: homeMl, implied_prob: round4(americanToProb(homeMl)),
        source: "espn", meta: { provider }, fetched_at: now,
      });
    }
    if (awayMl != null) {
      rows.push({
        game_pk: g.game_pk, market: "game_moneyline", outcome: "away",
        price_american: awayMl, implied_prob: round4(americanToProb(awayMl)),
        source: "espn", meta: { provider }, fetched_at: now,
      });
    }
    const total = odds.overUnder ?? null;
    if (total != null) {
      rows.push({
        game_pk: g.game_pk, market: "game_total", outcome: "over",
        line: total, price_american: odds.overOdds ?? null,
        implied_prob: round4(americanToProb(odds.overOdds)), source: "espn",
        meta: { provider }, fetched_at: now,
      });
      rows.push({
        game_pk: g.game_pk, market: "game_total", outcome: "under",
        line: total, price_american: odds.underOdds ?? null,
        implied_prob: round4(americanToProb(odds.underOdds)), source: "espn",
        meta: { provider }, fetched_at: now,
      });
    }
  }
  return { rows, matched };
}

async function ingestKalshi(
  idx: ReturnType<typeof indexGames>, unmatched: string[],
): Promise<{ rows: any[]; matched: number }> {
  const data = await fetchJson(KALSHI_MARKETS, { timeoutMs: 10_000, retries: 2 });
  const markets = data.markets ?? [];
  const rows: any[] = [];
  const matchedGames = new Set<number>();
  const now = new Date().toISOString();
  for (const m of markets) {
    const teamBlob = String(m.yes_sub_title ?? m.title ?? "");
    if (!teamBlob) continue;
    const teamId = teamIdByText(teamBlob);
    const g = teamId != null ? idx.byTeam.get(teamId) : undefined;
    if (!g) {
      const bid = m.yes_bid, ask = m.yes_ask;
      if ((bid != null && ask != null && (bid || ask)) || m.last_price) {
        unmatched.push(`kalshi:${teamBlob.slice(0, 40)}`);
      }
      continue;
    }
    const outcome = teamId === g.home_team_id ? "home" : "away";
    const bid = m.yes_bid, ask = m.yes_ask;
    let prob: number | null = null;
    if (bid != null && ask != null && (bid || ask)) prob = (bid + ask) / 200;
    else if (m.last_price) prob = m.last_price / 100;
    if (prob == null || prob <= 0 || prob >= 1) continue;
    matchedGames.add(g.game_pk);
    rows.push({
      game_pk: g.game_pk, market: "game_moneyline", outcome,
      implied_prob: round4(prob),
      price_american: prob >= 0.5 ? -Math.round((prob / (1 - prob)) * 100) : Math.round(((1 - prob) / prob) * 100),
      source: "kalshi",
      meta: { ticker: m.ticker, yes_bid: bid, yes_ask: ask, volume: m.volume },
      fetched_at: now,
    });
  }
  return { rows, matched: matchedGames.size };
}

// Team season win% from the games table (for the pregame log5 model).
async function seasonWinPct(teamId: number | null): Promise<number | null> {
  if (teamId == null) return null;
  const season = new Date().getUTCFullYear();
  const { data } = await svc().from("games")
    .select("home_team_id,away_team_id,home_score,away_score")
    .eq("season", season).like("status", "Final%")
    .or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`)
    .limit(200);
  const rows = (data ?? []).filter((g: any) => g.home_score != null && g.away_score != null);
  if (rows.length < 10) return null;
  let w = 0;
  for (const g of rows) {
    const won = g.home_team_id === teamId
      ? g.home_score > g.away_score
      : g.away_score > g.home_score;
    if (won) w += 1;
  }
  return w / rows.length;
}

Deno.serve(async (req) => {
  const denied = await requireCronSecret(req);
  if (denied) return denied;
  const startedAt = new Date().toISOString();
  const detail: Record<string, unknown> = {};
  const errors: string[] = [];

  try {
    const games = await todaysGames();
    detail.games_today = games.length;
    const idx = indexGames(games);
    const unmatched: string[] = [];
    let rows: any[] = [];

    try {
      const espn = await ingestEspn(idx, unmatched);
      rows = rows.concat(espn.rows);
      detail.espn = { rows: espn.rows.length, matched: espn.matched };
    } catch (e) { errors.push(`espn: ${String(e).slice(0, 120)}`); }

    try {
      const kalshi = await ingestKalshi(idx, unmatched);
      rows = rows.concat(kalshi.rows);
      detail.kalshi = { rows: kalshi.rows.length, matched: kalshi.matched };
    } catch (e) { errors.push(`kalshi: ${String(e).slice(0, 120)}`); }

    // Surface silent drops so a broken match rule is visible in ingest_runs.
    if (unmatched.length) detail.unmatched = unmatched.slice(0, 20);

    if (rows.length) {
      const { error } = await svc().from("odds").insert(rows);
      if (error) errors.push(`insert: ${error.message}`);
    }

    // Pregame moneyline picks: log5 model vs best available implied prob.
    let picks = 0;
    for (const g of games.filter((x) => x.status === "Scheduled" || x.status === "Pre-Game" || x.status === "Warmup")) {
      const quotes = rows.filter((r) => r.game_pk === g.game_pk && r.market === "game_moneyline");
      if (!quotes.length) continue;
      const [hPct, aPct] = await Promise.all([
        seasonWinPct(g.home_team_id), seasonWinPct(g.away_team_id),
      ]);
      if (hPct == null || aPct == null) continue;
      const pHome = log5HomeProb(hPct, aPct);
      for (const side of ["home", "away"] as const) {
        const pSide = side === "home" ? pHome : 1 - pHome;
        const qs = quotes.filter((q) => q.outcome === side && q.implied_prob != null);
        if (!qs.length) continue;
        const best = qs.reduce((a, b) => (a.implied_prob < b.implied_prob ? a : b));
        const edge = round4(pSide - Number(best.implied_prob));
        if (edge != null && edge >= PICK_EDGE) {
          const label = `${side === "home" ? g.home_team : g.away_team} ML`;
          const { error } = await svc().from("picks").upsert({
            pick_date: g.official_date ?? new Date().toISOString().slice(0, 10),
            game_pk: g.game_pk, at_bat_index: null,
            market: "game_moneyline", recommendation: side, label,
            price: best.price_american, confidence: round4(pSide), edge,
            units: 1, book: best.source, source: best.source,
            model_version: "log5_v1", status: "pending",
            payload: {
              game: {
                away: g.away_abbr ?? g.away_team, home: g.home_abbr ?? g.home_team,
                matchup: `${g.away_abbr ?? g.away_team} @ ${g.home_abbr ?? g.home_team}`,
                venue: g.venue_name, first_pitch: g.start_ts,
              },
              bullets: [
                `Season strength model gives ${label} a ${(pSide * 100).toFixed(1)}% win probability.`,
                `Best market price implies ${(Number(best.implied_prob) * 100).toFixed(1)}% (${best.source}).`,
              ],
            },
          }, { onConflict: "pick_date,game_pk,market,at_bat_index,recommendation", ignoreDuplicates: true });
          if (!error) picks += 1;
        }
      }
    }
    detail.pregame_picks = picks;
    detail.errors = errors.slice(0, 10);
    await logRun("odds-ingest", startedAt, errors.length === 0, detail);
    return json(detail);
  } catch (e) {
    detail.fatal = String(e);
    await logRun("odds-ingest", startedAt, false, detail);
    return json(detail, 500);
  }
});

function round4(v: number | null | undefined): number | null {
  return v == null ? null : Math.round(v * 10000) / 10000;
}
