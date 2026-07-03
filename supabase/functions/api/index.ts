// Public read-only API for the NextPitch frontend. Mirrors the FastAPI
// contract (GET /live, /picks/today, /record, /sportsbooks, /games, /health,
// POST /track/click) so the static frontend can point PITCH_EDGE_API at
// https://<ref>.functions.supabase.co/api and work unchanged.
//
// Deployed with verify_jwt=false: everything served here is public data that
// already has an anon read policy; the only write is the click funnel.

import { json, svc } from "../_shared/db.ts";

const MARKET_LABELS: Record<string, string> = {
  ab_result: "At-Bat Result",
  ab_pitches_ou: "Pitches in AB",
  pitch_speed_ou: "Next Pitch Speed",
  pitch_result: "Next Pitch Result",
  game_moneyline: "Moneyline",
  game_total: "Game Total",
};

const BOOKS = [
  { key: "draftkings", name: "DraftKings", short: "DK", url: "https://sportsbook.draftkings.com/leagues/baseball/mlb", affiliate_configured: false },
  { key: "fanduel", name: "FanDuel", short: "FD", url: "https://sportsbook.fanduel.com/navigation/mlb", affiliate_configured: false },
  { key: "kalshi", name: "Kalshi", short: "KLS", url: "https://kalshi.com", affiliate_configured: false },
  { key: "caesars", name: "Caesars", short: "CZR", url: "https://sportsbook.caesars.com/us/bet/baseball", affiliate_configured: false },
];

const DISCLAIMER =
  "21+ and present in a state where betting is legal. Odds change constantly — " +
  "confirm the live price before wagering. Not financial advice. " +
  "Problem gambling? Call 1-800-GAMBLER.";

async function health(): Promise<Response> {
  const db = svc();
  const [{ count: pitchCount }, { data: lastRun }, { data: model }] = await Promise.all([
    db.from("pitches").select("id", { count: "exact", head: true }),
    db.from("ingest_runs").select("job,finished_at,ok").order("id", { ascending: false }).limit(1),
    db.from("model_params").select("market,version").eq("is_active", true),
  ]);
  return json({
    status: "ok",
    timestamp: new Date().toISOString(),
    pitches_rows: pitchCount ?? 0,
    last_job: lastRun?.[0] ?? null,
    active_models: model ?? [],
  });
}

async function games(): Promise<Response> {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await svc().from("games")
    .select("game_pk,status,home_team,away_team,home_abbr,away_abbr,start_ts")
    .eq("official_date", today).order("start_ts");
  return json(data ?? []);
}

async function live(): Promise<Response> {
  const db = svc();
  const { data: states } = await db.from("live_state").select("*")
    .eq("status", "live")
    .gte("updated_at", new Date(Date.now() - 30 * 60_000).toISOString());
  if (!states?.length) return json([]);

  const gamePks = states.map((s: any) => s.game_pk);
  const [{ data: gameRows }, { data: playerRowsP }, { data: predRows }] = await Promise.all([
    db.from("games").select("game_pk,home_team,away_team,home_abbr,away_abbr").in("game_pk", gamePks),
    db.from("player_info").select("player_id,full_name,pitch_hand,bat_side")
      .in("player_id", [
        ...new Set(states.flatMap((s: any) => [s.pitcher_id, s.batter_id]).filter(Boolean)),
      ]),
    db.from("predictions").select("*").in("game_pk", gamePks)
      .order("id", { ascending: false }).limit(gamePks.length * 24),
  ]);
  const gamesBy = new Map((gameRows ?? []).map((g: any) => [g.game_pk, g]));
  const playersBy = new Map((playerRowsP ?? []).map((p: any) => [p.player_id, p]));

  const payloads = states.map((ls: any) => {
    const g: any = gamesBy.get(ls.game_pk) ?? {};
    const raw = ls.raw_json ?? {};
    // newest prediction row per market for this game
    const markets: any[] = [];
    const seen = new Set<string>();
    for (const p of predRows ?? []) {
      if (p.game_pk !== ls.game_pk || seen.has(p.market)) continue;
      seen.add(p.market);
      markets.push({
        market: p.market,
        predicted_value: p.predicted_value != null ? Number(p.predicted_value) : null,
        recommendation: p.recommendation,
        line: p.line != null ? Number(p.line) : null,
        price: p.price,
        edge: p.edge != null ? Number(p.edge) : null,
        confidence: p.confidence != null ? Number(p.confidence) : null,
        probs: p.probs,
        model_version: p.model_version,
        features_used: [],
        sample_size: 0,
      });
    }
    markets.sort((a, b) => (b.edge ?? -9) - (a.edge ?? -9));
    const edges = markets.map((m) => m.edge).filter((e) => e != null) as number[];
    const topEdge = edges.length ? Math.max(...edges) : 0;
    const pitcher: any = playersBy.get(ls.pitcher_id);
    const batter: any = playersBy.get(ls.batter_id);
    return {
      game_pk: ls.game_pk,
      game_label: `${g.away_team ?? raw.away_team ?? "Away"} @ ${g.home_team ?? raw.home_team ?? "Home"}`,
      away_abbr: g.away_abbr ?? raw.away_abbr ?? null,
      home_abbr: g.home_abbr ?? raw.home_abbr ?? null,
      pitcher_name: pitcher?.full_name ?? null,
      pitcher_hand: pitcher?.pitch_hand ?? null,
      batter_name: batter?.full_name ?? null,
      batter_hand: batter?.bat_side ?? null,
      situation: {
        inning: ls.inning,
        half: ls.top_inning ? "▲" : "▼",
        count: `${ls.balls ?? 0}-${ls.strikes ?? 0}`,
        outs: ls.outs,
        pitcher_id: ls.pitcher_id,
        batter_id: ls.batter_id,
        pitch_count_pa: ls.pitch_count_pa,
        last_pitch_ts: ls.last_pitch_ts,
        home_score: ls.home_score,
        away_score: ls.away_score,
      },
      current_pa_pitches: raw.current_pa_pitches ?? [],
      markets,
      has_edge: topEdge > 0.05,
      top_edge: topEdge,
      model_version: markets[0]?.model_version ?? "heuristic_v0",
    };
  });
  payloads.sort((a: any, b: any) => b.top_edge - a.top_edge);
  return json(payloads);
}

function pickOut(row: any): any {
  const payload = row.payload ?? {};
  return {
    id: String(row.id),
    market: row.market,
    pick: row.label ?? row.recommendation,
    line: row.line != null ? Number(row.line) : null,
    price: row.price,
    confidence: row.confidence != null ? Number(row.confidence) : null,
    edge: row.edge != null ? Number(row.edge) : null,
    units: Number(row.units ?? 1),
    book: row.book,
    status: row.status ?? "pending",
    game: payload.game ?? {},
    pitcher: payload.pitcher ?? {},
    batter: payload.batter ?? {},
    bullets: payload.bullets ?? [],
  };
}

async function picksToday(): Promise<Response> {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await svc().from("picks").select("*")
    .eq("pick_date", today).order("edge", { ascending: false }).limit(50);
  return json((data ?? []).map(pickOut));
}

function bucket() { return { wins: 0, losses: 0, pushes: 0, units: 0, risked: 0, picks: 0 }; }
function tally(b: any, r: any) {
  const units = Number(r.units ?? 1), profit = Number(r.profit_units ?? 0);
  b.picks += 1; b.risked += units; b.units += profit;
  if (r.status === "win") b.wins += 1;
  else if (r.status === "loss") b.losses += 1;
  else if (r.status === "push") b.pushes += 1;
}
function finish(b: any) {
  const { risked, ...rest } = b;
  rest.units = Math.round(rest.units * 100) / 100;
  rest.roi = risked ? Math.round((1000 * rest.units) / risked) / 10 : 0;
  return rest;
}

async function record(): Promise<Response> {
  const { data } = await svc().from("picks")
    .select("pick_date,market,label,recommendation,price,units,status,profit_units,payload,graded_at")
    .in("status", ["win", "loss", "push"])
    .order("graded_at", { ascending: false }).limit(5000);
  const rows = data ?? [];
  const overall = bucket(), last30 = bucket();
  const byMarket: Record<string, any> = {};
  const cutoff = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  for (const r of rows) {
    tally(overall, r);
    (byMarket[r.market ?? "other"] ??= bucket());
    tally(byMarket[r.market ?? "other"], r);
    if ((r.pick_date ?? "") >= cutoff) tally(last30, r);
  }
  return json({
    updated: new Date().toISOString().slice(0, 10),
    overall: finish(overall),
    last30: finish(last30),
    byMarket: Object.entries(byMarket).map(([m, b]) => ({
      market: m, label: MARKET_LABELS[m] ?? m, ...finish(b),
    })),
    recent: rows.slice(0, 12).map((r: any) => ({
      date: r.pick_date,
      matchup: r.payload?.game?.matchup ?? `${r.payload?.game?.away ?? "?"} @ ${r.payload?.game?.home ?? "?"}`,
      pick: r.label ?? r.recommendation,
      market: r.market,
      price: r.price,
      units: Number(r.units ?? 1),
      result: r.status,
    })),
  });
}

// GET /edge/{game_pk} — latest prediction per market with a per-source odds
// breakdown, in the shape the live board's edge tab consumes.
async function edge(gamePk: number): Promise<Response> {
  const db = svc();
  const [{ data: preds }, { data: oddsRows }] = await Promise.all([
    db.from("predictions").select("*").eq("game_pk", gamePk)
      .order("id", { ascending: false }).limit(30),
    db.from("odds")
      .select("market,outcome,line,over_price,under_price,price_american,implied_prob,source,fetched_at")
      .eq("game_pk", gamePk)
      .gte("fetched_at", new Date(Date.now() - 45 * 60_000).toISOString())
      .order("fetched_at", { ascending: false }).limit(80),
  ]);

  // newest odds row per (market, source, outcome)
  const latest: any[] = [];
  const seenQ = new Set<string>();
  for (const r of oddsRows ?? []) {
    const k = `${r.market}:${r.source}:${r.outcome ?? ""}`;
    if (seenQ.has(k)) continue;
    seenQ.add(k);
    latest.push(r);
  }

  const rows: any[] = [];
  const seenM = new Set<string>();
  for (const p of preds ?? []) {
    if (seenM.has(p.market)) continue;
    seenM.add(p.market);
    const quotes = latest.filter((q) => q.market === p.market);
    const sources = quotes.map((q) => {
      const implied = q.implied_prob != null ? Number(q.implied_prob) : null;
      const conf = p.confidence != null ? Number(p.confidence) : null;
      return {
        source: q.source,
        outcome: q.outcome,
        recommendation: p.recommendation,
        line: q.line != null ? Number(q.line) : null,
        price: q.price_american ?? (p.recommendation === "over" ? q.over_price : q.under_price),
        implied_prob: implied,
        edge: implied != null && conf != null && q.outcome === p.recommendation
          ? Math.round((conf - implied) * 10000) / 10000
          : null,
      };
    });
    const priced = sources.filter((s) => s.edge != null);
    const best = priced.length ? priced.reduce((a, b) => (a.edge! > b.edge! ? a : b)) : null;
    rows.push({
      market: p.market,
      recommendation: p.recommendation,
      line: p.line != null ? Number(p.line) : null,
      price: p.price,
      edge: p.edge != null ? Number(p.edge) : null,
      confidence: p.confidence != null ? Number(p.confidence) : null,
      predicted_value: p.predicted_value != null ? Number(p.predicted_value) : null,
      probs: p.probs,
      sources,
      best_source: best?.source ?? null,
      model_version: p.model_version,
    });
  }
  rows.sort((a, b) => (b.edge ?? -9) - (a.edge ?? -9));
  return json(rows);
}

async function trackClick(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    await svc().from("bet_clicks").insert({
      game_pk: body.game_pk ?? null, market: body.market ?? null,
      side: body.side ?? null, book: body.book ?? null,
      edge: body.edge ?? null,
      affiliate_configured: body.affiliate_configured ?? null,
    });
  } catch (_e) { /* fire-and-forget */ }
  return json({ ok: true });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  const url = new URL(req.url);
  // Path arrives as /api/<route...>
  const route = url.pathname.replace(/^\/api\/?/, "").replace(/\/+$/, "");
  try {
    if (req.method === "POST" && route === "track/click") return await trackClick(req);
    switch (route) {
      case "health": case "": return await health();
      case "games": return await games();
      case "live": return await live();
      case "picks/today": return await picksToday();
      case "record": return await record();
      case "sportsbooks": return json({ disclaimer: DISCLAIMER, books: BOOKS });
      default: {
        const em = route.match(/^edge\/(\d+)$/);
        if (em) return await edge(Number(em[1]));
        return json({ error: `no route: ${route}` }, 404);
      }
    }
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
