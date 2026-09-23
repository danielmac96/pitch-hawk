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
import { mlbToday } from "../_shared/mlb.ts";
import { log5HomeProb } from "../_shared/model.ts";
import { americanToProb, teamIdByAbbr, teamIdByText } from "../_shared/vocab.ts";
import { fetchJson } from "../_shared/http.ts";
import {
  applyNovig,
  indexPlayersByName,
  normalizeName,
  round4,
} from "../_shared/novig.ts";

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
  const today = mlbToday();
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

// The Odds API — real sportsbook lines (DraftKings/FanDuel/…). Ships dark:
// only runs when app_secrets.the_odds_api_key is set. Free tier is 500 req/mo,
// so the caller polls it far less often than the free ESPN/Kalshi feeds. Each
// bookmaker becomes its own `source` so the frontend can line-shop.
const THE_ODDS_API = "https://api.the-odds-api.com/v4/sports/baseball_mlb/odds";

async function ingestTheOddsApi(
  apiKey: string, idx: ReturnType<typeof indexGames>, unmatched: string[],
): Promise<{ rows: any[]; matched: number }> {
  const url = new URL(THE_ODDS_API);
  url.searchParams.set("apiKey", apiKey);
  url.searchParams.set("regions", "us");
  url.searchParams.set("markets", "h2h,totals");
  url.searchParams.set("oddsFormat", "american");
  const data = await fetchJson<any[]>(url, { timeoutMs: 10_000, retries: 2 });
  const rows: any[] = [];
  const matchedGames = new Set<number>();
  const now = new Date().toISOString();
  for (const ev of data ?? []) {
    const homeId = teamIdByText(ev.home_team);
    const awayId = teamIdByText(ev.away_team);
    const g = homeId != null && awayId != null
      ? idx.byPair.get(`${awayId}:${homeId}`)
      : undefined;
    if (!g) {
      if ((ev.bookmakers?.length ?? 0) > 0) unmatched.push(`oddsapi:${ev.away_team}@${ev.home_team}`);
      continue;
    }
    for (const bk of ev.bookmakers ?? []) {
      const source = bk.key ?? "the_odds_api";
      for (const mk of bk.markets ?? []) {
        if (mk.key === "h2h") {
          for (const o of mk.outcomes ?? []) {
            const oid = teamIdByText(o.name);
            const outcome = oid === g.home_team_id ? "home" : oid === g.away_team_id ? "away" : null;
            if (!outcome || o.price == null) continue;
            matchedGames.add(g.game_pk);
            rows.push({
              game_pk: g.game_pk, market: "game_moneyline", outcome,
              price_american: o.price, implied_prob: round4(americanToProb(o.price)),
              source, meta: { book: bk.title }, fetched_at: now,
            });
          }
        } else if (mk.key === "totals") {
          for (const o of mk.outcomes ?? []) {
            const outcome = String(o.name ?? "").toLowerCase(); // "over" / "under"
            if ((outcome !== "over" && outcome !== "under") || o.price == null) continue;
            matchedGames.add(g.game_pk);
            rows.push({
              game_pk: g.game_pk, market: "game_total", outcome,
              line: o.point ?? null, price_american: o.price,
              implied_prob: round4(americanToProb(o.price)),
              source, meta: { book: bk.title }, fetched_at: now,
            });
          }
        }
      }
    }
  }
  return { rows, matched: matchedGames.size };
}

// ── player props ───────────────────────────────────────────────────────────
//
// Batter hit and home-run lines, the real prices behind `batter_hit` /
// `batter_hr`. Also ships dark behind app_secrets.the_odds_api_key.
//
// COSTS N+1 REQUESTS PER SLATE, which is why it is gated separately from the
// game-level call above. Player props are not available on the bulk odds
// endpoint -- The Odds API serves them one event at a time -- so a 15-game
// slate is 1 events call plus 15 odds calls. Against a 500 req/mo free tier
// that is roughly one slate a day and nothing left over, so this stays off
// until `the_odds_api_props` is set as well. Two keys, because "we have a key"
// and "we can afford 16 calls a slate" are different decisions.
const THE_ODDS_EVENTS =
  "https://api.the-odds-api.com/v4/sports/baseball_mlb/events";

// Provider market key -> our internal market name. We store OUR name so a
// prop line joins to the model that priced it; the provider's key rides in
// `meta` so the mapping stays visible in the data.
const PROP_MARKETS: Record<string, string> = {
  batter_hits: "batter_hit",
  batter_home_runs: "batter_hr",
};

async function ingestPlayerProps(
  apiKey: string, idx: ReturnType<typeof indexGames>, unmatched: string[],
): Promise<{ rows: any[]; matched: number }> {
  const evUrl = new URL(THE_ODDS_EVENTS);
  evUrl.searchParams.set("apiKey", apiKey);
  const events = await fetchJson<any[]>(evUrl, { timeoutMs: 10_000, retries: 2 });

  // Only events we can resolve to one of today's games. An unresolvable event
  // is one we would spend a request on and then throw away.
  const targets: { id: string; game: any }[] = [];
  for (const ev of events ?? []) {
    const homeId = teamIdByText(ev.home_team);
    const awayId = teamIdByText(ev.away_team);
    const g = homeId != null && awayId != null
      ? idx.byPair.get(`${awayId}:${homeId}`)
      : undefined;
    if (g && ev.id) targets.push({ id: ev.id, game: g });
  }
  if (!targets.length) return { rows: [], matched: 0 };

  // Resolve sportsbook player names once for the whole slate.
  const { data: people } = await svc().from("player_info")
    .select("player_id,full_name").limit(5000);
  const { byName, collisions } = indexPlayersByName(people ?? []);
  // Ambiguous names are reported rather than resolved: a prop attributed to
  // the wrong player is not a missing row, it is a wrong one.
  for (const c of collisions.slice(0, 5)) unmatched.push(`props:ambiguous:${c}`);

  const rows: any[] = [];
  const matchedGames = new Set<number>();
  const now = new Date().toISOString();
  for (const t of targets) {
    const url = new URL(`${THE_ODDS_EVENTS}/${t.id}/odds`);
    url.searchParams.set("apiKey", apiKey);
    url.searchParams.set("regions", "us");
    url.searchParams.set("markets", Object.keys(PROP_MARKETS).join(","));
    url.searchParams.set("oddsFormat", "american");
    let data: any;
    try {
      data = await fetchJson<any>(url, { timeoutMs: 10_000, retries: 1 });
    } catch (e) {
      // One event failing must not cost the rest of the slate its lines.
      unmatched.push(`props:${t.id}:${String(e).slice(0, 60)}`);
      continue;
    }
    for (const bk of data?.bookmakers ?? []) {
      const source = bk.key ?? "the_odds_api";
      for (const mk of bk.markets ?? []) {
        const market = PROP_MARKETS[mk.key];
        if (!market) continue;
        for (const o of mk.outcomes ?? []) {
          const outcome = String(o.name ?? "").toLowerCase();
          if (outcome !== "over" && outcome !== "under") continue;
          if (o.price == null) continue;
          // `description` is the player on a player-prop outcome.
          const playerId = byName.get(normalizeName(o.description));
          if (playerId == null) {
            unmatched.push(`props:player:${o.description}`);
            continue;
          }
          matchedGames.add(t.game.game_pk);
          rows.push({
            game_pk: t.game.game_pk,
            player_id: playerId,
            market,
            outcome,
            line: o.point ?? null,
            price_american: o.price,
            implied_prob: round4(americanToProb(o.price)),
            source,
            meta: { book: bk.title, provider_market: mk.key,
                    player: o.description },
            fetched_at: now,
          });
        }
      }
    }
  }
  return { rows, matched: matchedGames.size };
}

// De-vig: for each (game, market, source) with a complete two-sided pair
// (home+away or over+under), normalize implied probs to sum to 1 so the book's
// margin is removed. Single-sided quotes keep novig = implied. Mutates rows.

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

    // Pluggable providers. ESPN + Kalshi are free/no-auth and always run; The
    // Odds API activates only when its key is configured in app_secrets.
    const { data: keyRow } = await svc().from("app_secrets")
      .select("value").eq("key", "the_odds_api_key").maybeSingle();
    const providers: { name: string; run: () => Promise<{ rows: any[]; matched: number }> }[] = [
      { name: "espn", run: () => ingestEspn(idx, unmatched) },
      { name: "kalshi", run: () => ingestKalshi(idx, unmatched) },
    ];
    if (keyRow?.value) {
      providers.push({ name: "the_odds_api", run: () => ingestTheOddsApi(keyRow.value, idx, unmatched) });
    }
    // Player props need their OWN switch, not just a key. They cost one
    // request per game on top of the slate call, so a 15-game day is ~16
    // requests against a 500/month free tier -- about one slate a day with
    // nothing spare. "We have a key" and "we can afford that" are separate
    // decisions, so they get separate flags.
    const { data: propRow } = await svc().from("app_secrets")
      .select("value").eq("key", "the_odds_api_props").maybeSingle();
    if (keyRow?.value && propRow?.value === "true") {
      providers.push({
        name: "player_props",
        run: () => ingestPlayerProps(keyRow.value, idx, unmatched),
      });
    }

    let rows: any[] = [];
    for (const p of providers) {
      try {
        const res = await p.run();
        rows = rows.concat(res.rows);
        detail[p.name] = { rows: res.rows.length, matched: res.matched };
      } catch (e) { errors.push(`${p.name}: ${String(e).slice(0, 120)}`); }
    }

    // De-vig every two-sided pair before persisting/using for edges.
    applyNovig(rows);

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
        // Edge vs the de-vigged market prob (falls back to raw implied).
        const marketProb = (q: any) => Number(q.novig_prob ?? q.implied_prob);
        const qs = quotes.filter((q) => q.outcome === side && (q.novig_prob ?? q.implied_prob) != null);
        if (!qs.length) continue;
        const best = qs.reduce((a, b) => (marketProb(a) < marketProb(b) ? a : b));
        const edge = round4(pSide - marketProb(best));
        if (edge != null && edge >= PICK_EDGE) {
          const label = `${side === "home" ? g.home_team : g.away_team} ML`;
          const { error } = await svc().from("picks").upsert({
            pick_date: g.official_date ?? mlbToday(),
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
                `Best de-vigged market price implies ${(marketProb(best) * 100).toFixed(1)}% (${best.source}).`,
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

