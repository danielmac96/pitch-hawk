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

// ── Edge/CDN cache TTLs (seconds). Data only changes at the poll cadence, so
// caching collapses ~500 req/s at 1000 users into a handful of origin hits.
const TTL: Record<string, number> = {
  "": 10, "health": 10, // staleness threshold is 120s, so 10s cache is safe
  "live": 10, "edge": 15, "odds/today": 30,
  "picks/today": 60, "record": 60, "games": 60,
  "sportsbooks": 3600,
};

// In-instance memo so even a CDN miss on a warm instance skips Postgres.
const memo = new Map<string, { expires: number; text: string; status: number }>();

// CORS allowlist from app_secrets.allowed_origins (comma-separated); falls back
// to "*" until configured. localhost is always allowed for dev.
let originsCache: { expires: number; list: string[] | null } = { expires: 0, list: null };
async function allowedOrigins(): Promise<string[] | null> {
  if (originsCache.expires > Date.now()) return originsCache.list;
  const { data } = await svc().from("app_secrets").select("value").eq("key", "allowed_origins").maybeSingle();
  const list = data?.value ? data.value.split(",").map((s: string) => s.trim()).filter(Boolean) : null;
  originsCache = { expires: Date.now() + 300_000, list };
  return list;
}
function pickOrigin(list: string[] | null, reqOrigin: string | null): string {
  if (!list || !list.length) return "*";
  if (reqOrigin && list.includes(reqOrigin)) return reqOrigin;
  if (reqOrigin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(reqOrigin)) return reqOrigin;
  return list[0]; // any non-allowed browser origin won't match -> blocked
}

function corsHeaders(origin: string, cacheTtl?: number): Record<string, string> {
  const h: Record<string, string> = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
  };
  if (cacheTtl && cacheTtl > 0) {
    h["Cache-Control"] = `public, s-maxage=${cacheTtl}, stale-while-revalidate=${cacheTtl}`;
  }
  return h;
}

// Wrap a JSON-returning handler with the in-instance memo + cache/CORS headers.
async function cached(key: string, ttl: number, origin: string, fn: () => Promise<Response>): Promise<Response> {
  const now = Date.now();
  const hit = memo.get(key);
  let text: string, status: number;
  if (hit && hit.expires > now) {
    text = hit.text; status = hit.status;
  } else {
    const resp = await fn();
    text = await resp.text();
    status = resp.status;
    if (status === 200 && ttl > 0) memo.set(key, { expires: now + ttl * 1000, text, status });
  }
  return new Response(text, { status, headers: { "Content-Type": "application/json", ...corsHeaders(origin, ttl) } });
}

// Per-IP in-memory rate limit for the public click funnel (10/min).
const clickHits = new Map<string, { count: number; resetAt: number }>();
function clickRateLimited(ip: string): boolean {
  const now = Date.now();
  if (clickHits.size > 5_000) {
    for (const [k, v] of clickHits) if (v.resetAt < now) clickHits.delete(k);
  }
  const e = clickHits.get(ip);
  if (!e || e.resetAt < now) { clickHits.set(ip, { count: 1, resetAt: now + 60_000 }); return false; }
  e.count += 1;
  return e.count > 10;
}

async function health(): Promise<Response> {
  const db = svc();
  const [{ count: pitchCount }, { data: runs }, { data: model }, { data: bf }] = await Promise.all([
    db.from("pitches").select("id", { count: "exact", head: true }),
    db.from("ingest_runs").select("job,finished_at,ok").order("id", { ascending: false }).limit(200),
    db.from("model_params").select("market,version").eq("is_active", true),
    db.from("backfill_progress").select("cursor_date,start_date,done,updated_at").eq("id", 1).maybeSingle(),
  ]);
  const now = Date.now();
  // Last SUCCESSFUL finish per job + how stale it is.
  const jobs: Record<string, { last_success: string | null; age_seconds: number | null }> = {};
  for (const r of runs ?? []) {
    if (!r.ok || !r.finished_at || jobs[r.job]) continue;
    jobs[r.job] = {
      last_success: r.finished_at,
      age_seconds: Math.round((now - new Date(r.finished_at).getTime()) / 1000),
    };
  }
  // The live board is "fresh" when live-poll succeeded within the last 2 min.
  const liveAge = jobs["live-poll"]?.age_seconds ?? null;
  const dataFresh = liveAge != null ? liveAge <= 120 : true;
  return json({
    status: "ok",
    timestamp: new Date().toISOString(),
    pitches_rows: pitchCount ?? 0,
    jobs,
    data_fresh: dataFresh,
    backfill: bf ?? null,
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
        book: p.book ?? null,
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

// GET /odds/today — latest snapshot per (game, market, source, outcome) in the
// last hour, grouped by game, incl. de-vigged novig_prob for a line-shop board.
async function oddsToday(): Promise<Response> {
  const { data } = await svc().from("odds")
    .select("game_pk,market,outcome,line,price_american,implied_prob,novig_prob,source,fetched_at")
    .gte("fetched_at", new Date(Date.now() - 60 * 60_000).toISOString())
    .order("fetched_at", { ascending: false }).limit(2000);
  const seen = new Set<string>();
  const byGame = new Map<number, any[]>();
  for (const r of data ?? []) {
    const k = `${r.game_pk}:${r.market}:${r.source}:${r.outcome ?? ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    (byGame.get(r.game_pk) ?? byGame.set(r.game_pk, []).get(r.game_pk)!).push({
      market: r.market, outcome: r.outcome,
      line: r.line != null ? Number(r.line) : null,
      price: r.price_american,
      implied_prob: r.implied_prob != null ? Number(r.implied_prob) : null,
      novig_prob: r.novig_prob != null ? Number(r.novig_prob) : null,
      source: r.source, fetched_at: r.fetched_at,
    });
  }
  return json([...byGame.entries()].map(([game_pk, quotes]) => ({ game_pk, quotes })));
}

// Aggregates come from the pick_record() RPC (single grouped query) instead of
// scanning thousands of rows; only the 12 recent rows are fetched directly.
async function record(): Promise<Response> {
  const db = svc();
  const [{ data: agg }, { data: recentRows }] = await Promise.all([
    db.rpc("pick_record"),
    db.from("picks").select("pick_date,market,label,recommendation,price,units,status,payload")
      .in("status", ["win", "loss", "push"]).order("graded_at", { ascending: false }).limit(12),
  ]);
  const a: any = agg ?? { overall: {}, last30: {}, byMarket: [] };
  return json({
    updated: new Date().toISOString().slice(0, 10),
    overall: a.overall ?? {},
    last30: a.last30 ?? {},
    byMarket: (a.byMarket ?? []).map((b: any) => ({ ...b, label: MARKET_LABELS[b.market] ?? b.market })),
    recent: (recentRows ?? []).map((r: any) => ({
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
      .select("market,outcome,line,over_price,under_price,price_american,implied_prob,novig_prob,source,fetched_at")
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
      // Edge vs the de-vigged prob when available (falls back to raw implied).
      const fair = q.novig_prob != null ? Number(q.novig_prob) : implied;
      const conf = p.confidence != null ? Number(p.confidence) : null;
      return {
        source: q.source,
        outcome: q.outcome,
        recommendation: p.recommendation,
        line: q.line != null ? Number(q.line) : null,
        price: q.price_american ?? (p.recommendation === "over" ? q.over_price : q.under_price),
        implied_prob: implied,
        novig_prob: q.novig_prob != null ? Number(q.novig_prob) : null,
        edge: fair != null && conf != null && q.outcome === p.recommendation
          ? Math.round((conf - fair) * 10000) / 10000
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

function jsonWith(body: unknown, origin: string, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

async function trackClick(req: Request, origin: string): Promise<Response> {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  if (clickRateLimited(ip)) return jsonWith({ ok: false, error: "rate_limited" }, origin, 429);
  try {
    const raw = await req.text();
    if (raw.length > 1024) return jsonWith({ ok: false, error: "payload_too_large" }, origin, 413);
    const body = JSON.parse(raw || "{}");
    const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : null);
    const str = (v: unknown) => (typeof v === "string" ? v.slice(0, 64) : null);
    await svc().from("bet_clicks").insert({
      game_pk: num(body.game_pk), market: str(body.market),
      side: str(body.side), book: str(body.book), edge: num(body.edge),
      affiliate_configured: typeof body.affiliate_configured === "boolean" ? body.affiliate_configured : null,
    });
  } catch (_e) { /* fire-and-forget */ }
  return jsonWith({ ok: true }, origin);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  // Path arrives as /api/<route...>
  const route = url.pathname.replace(/^\/api\/?/, "").replace(/\/+$/, "");
  const origin = pickOrigin(await allowedOrigins(), req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  try {
    if (req.method === "POST" && route === "track/click") return await trackClick(req, origin);
    const em = route.match(/^edge\/(\d+)$/);
    if (em) return await cached(`edge/${em[1]}`, TTL["edge"], origin, () => edge(Number(em[1])));
    switch (route) {
      case "health": case "": return await cached(route, TTL[route] ?? 0, origin, health);
      case "games": return await cached("games", TTL["games"], origin, games);
      case "live": return await cached("live", TTL["live"], origin, live);
      case "picks/today": return await cached("picks/today", TTL["picks/today"], origin, picksToday);
      case "odds/today": return await cached("odds/today", TTL["odds/today"], origin, oddsToday);
      case "record": return await cached("record", TTL["record"], origin, record);
      case "sportsbooks":
        return await cached("sportsbooks", TTL["sportsbooks"], origin,
          () => json({ disclaimer: DISCLAIMER, books: BOOKS }));
      default:
        return jsonWith({ error: `no route: ${route}` }, origin, 404);
    }
  } catch (e) {
    return jsonWith({ error: String(e) }, origin, 500);
  }
});
