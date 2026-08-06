// Public read-only API for the Pitch Hawk frontend. Mirrors the FastAPI
// contract (GET /live, /picks/today, /record, /sportsbooks, /games, /health)
// so the static frontend can point PITCH_EDGE_API at
// https://<ref>.functions.supabase.co/api and work unchanged.
//
// Deployed with verify_jwt=false: everything served here is public data that
// already has an anon read policy. This function is now strictly read-only —
// the POST /track/click click funnel was removed with the bet_clicks table
// (migration 20260728000001), which never recorded a single row.

import { json, svc } from "../_shared/db.ts";
import { mlbToday } from "../_shared/mlb.ts";
import * as aggs from "../_shared/aggregates.ts";

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
  // Warehouse display aggregates. They are rebuilt once nightly, so 300s is
  // deliberately conservative -- it bounds staleness after a publish without
  // making the cache pointless. game/context is immutable once a game is
  // final, hence an hour.
  "player/profile": 300, "player/splits": 300, "player/fatigue": 300,
  "matchup": 300, "game/context": 3600,
  // Board recap is built from graded rows that stop moving once a slate is
  // final; the live section inside it is refreshed by the client's own /live
  // poll, so 60s here does not make the live board stale.
  "board": 60, "feed": 60, "coverage": 300,
};

// In-instance memo so even a CDN miss on a warm instance skips Postgres.
const memo = new Map<string, { expires: number; text: string; status: number }>();

// Cache keys MUST include the query string.
//
// The CDN keys on the full URL and was always fine, but this in-instance memo
// keyed on the route alone. That was harmless while every route was a literal
// path with no parameters; the moment a filterable route exists it means the
// first caller's `?team=NYM` response is served to the next caller asking for
// `?team=BOS` on the same warm instance. Sorting the pairs makes the key stable
// regardless of the order the client happened to write them in.
function normalizedQuery(url: URL): string {
  const pairs = [...url.searchParams.entries()].filter(([k]) => k);
  if (!pairs.length) return "";
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return "?" + pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

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
// `fn` may be sync or async: the `sportsbooks` route hands us `() => json(...)`,
// which builds a Response without awaiting anything. `await fn()` below handles
// both, so the signature admits both rather than forcing pointless `async`.
async function cached(key: string, ttl: number, origin: string, fn: () => Response | Promise<Response>): Promise<Response> {
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

async function health(): Promise<Response> {
  const db = svc();
  const [{ count: pitchCount }, { data: runs }, { data: model }, { data: bf }, { data: aggRows }] =
    await Promise.all([
      db.from("pitches").select("id", { count: "exact", head: true }),
      db.from("ingest_runs").select("job,finished_at,ok").order("id", { ascending: false }).limit(200),
      db.from("model_params").select("market,version").eq("is_active", true),
      db.from("backfill_progress").select("cursor_date,start_date,done,updated_at").eq("id", 1).maybeSingle(),
      db.rpc("aggregate_freshness"),
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

  // Warehouse display aggregates (Phase 4). Reported per table rather than
  // rolled up, so one stalled aggregate is visible instead of averaged away.
  // `stale` is generous: the publisher runs nightly, so 36h allows a single
  // missed run without crying wolf.
  type AggFreshness = {
    table: string;
    rows: number;
    updated_at: string | null;
    age_hours: number | null;
    stale: boolean;
  };
  // Annotated explicitly: `aggRows` comes back as `any` from rpc(), so an
  // inferred `.map()` result would leave `a` implicitly any and fail
  // `deno check` (TS7006) even though it runs fine.
  const aggregates: AggFreshness[] = (aggRows ?? []).map((r: {
    table_name: string; rows: number; updated_at: string | null;
  }) => {
    const ageHours = r.updated_at
      ? Math.round((now - new Date(r.updated_at).getTime()) / 3600_000)
      : null;
    return {
      table: r.table_name,
      rows: Number(r.rows ?? 0),
      updated_at: r.updated_at,
      age_hours: ageHours,
      stale: ageHours == null || ageHours > 36,
    };
  });

  return json({
    status: "ok",
    timestamp: new Date().toISOString(),
    // NOTE: this is the 35-day hot window since the Phase 3 swap, not all of
    // history. It fell 1,217,858 -> ~126,000 on 2026-08-03 by design; the rest
    // lives in R2. See docs/plans/data-pipeline-2026-08-02.md.
    pitches_rows: pitchCount ?? 0,
    jobs,
    data_fresh: dataFresh,
    backfill: bf ?? null,
    active_models: model ?? [],
    aggregates,
    aggregates_stale: aggregates.some((a: AggFreshness) => a.stale),
  });
}

async function games(): Promise<Response> {
  const today = mlbToday();
  const { data } = await svc().from("games")
    .select("game_pk,status,home_team,away_team,home_abbr,away_abbr,start_ts,home_score,away_score")
    .eq("official_date", today).order("start_ts");
  return json(data ?? []);
}

// Every market a fully-covered game carries. Coverage is reported against this
// list so a missing market is a number the UI can show, not an absence it has to
// infer.
const ALL_MARKETS = [
  "pitch_result", "pitch_speed_ou", "ab_result",
  "ab_pitches_ou", "game_moneyline", "game_total",
];

function isFinalStatus(s: string | null | undefined): boolean {
  return !!s && /^(Final|Game Over|Completed)/i.test(s);
}

// Build the whole slate for a date, not just the games that happen to be live.
//
// Until 2026-08-06 this filtered to live_state.status='live' updated within 30
// minutes, so a user who loaded the site before first pitch got `[]` -- an empty
// board on a day with a full schedule. Scheduled and finished games now come
// back too, carrying their game_predictions rows.
async function slatePayloads(date: string): Promise<any[]> {
  const db = svc();
  const { data: gameRows } = await db.from("games")
    .select("game_pk,status,start_ts,home_team,away_team,home_abbr,away_abbr," +
      "home_team_id,away_team_id,home_score,away_score")
    .eq("official_date", date).order("start_ts");
  const slate = gameRows ?? [];
  if (!slate.length) return [];
  const gamePks = slate.map((g: any) => g.game_pk);

  const [{ data: allStates }, { data: gpRows }] = await Promise.all([
    db.from("live_state").select("*").in("game_pk", gamePks),
    db.from("game_predictions").select("*").in("game_pk", gamePks),
  ]);

  // A state is only authoritative for the per-pitch board while it is fresh;
  // beyond 30 minutes the game is treated as not-live and falls back to its
  // stored game-level rows.
  const freshCutoff = Date.now() - 30 * 60_000;
  const stateBy = new Map((allStates ?? []).map((s: any) => [s.game_pk, s]));
  const states = (allStates ?? []).filter((s: any) =>
    s.status === "live" && new Date(s.updated_at).getTime() >= freshCutoff
  );
  const livePks = states.map((s: any) => s.game_pk);

  const playerIds = [...new Set([
    ...(allStates ?? []).flatMap((s: any) => [s.pitcher_id, s.batter_id]),
    ...(gpRows ?? []).flatMap((r: any) => [r.home_pitcher_id, r.away_pitcher_id]),
  ].filter(Boolean))];

  // Per-pitch rows are only needed for the games actually live right now.
  const empty = { data: [] as any[] };
  const [{ data: playerRowsP }, { data: predRows }, { data: paPredRows }, { data: abpRows }] = await Promise.all([
    playerIds.length
      ? db.from("player_info").select("player_id,full_name,pitch_hand,bat_side").in("player_id", playerIds)
      : Promise.resolve(empty),
    livePks.length
      ? db.from("predictions").select("*").in("game_pk", livePks)
        .order("id", { ascending: false }).limit(livePks.length * 24)
      : Promise.resolve(empty),
    // Per-pitch prediction history for the current PA: one pitch_result +
    // pitch_speed_ou row per pitch state, so the board can show what the model
    // called before each pitch and grade it against what actually happened.
    livePks.length
      ? db.from("predictions")
        .select("game_pk,at_bat_index,pitch_number,market,predicted_value,recommendation,line,confidence,probs,result")
        .in("game_pk", livePks).in("market", ["pitch_result", "pitch_speed_ou"])
        .order("id", { ascending: false }).limit(livePks.length * 40)
      : Promise.resolve(empty),
    // ab_pitches_ou is written once per at-bat (pre-AB call) — in a long PA it
    // falls outside the newest-rows window above, so fetch it directly.
    livePks.length
      ? db.from("predictions").select("*").in("game_pk", livePks)
        .eq("market", "ab_pitches_ou")
        .order("id", { ascending: false }).limit(livePks.length * 3)
      : Promise.resolve(empty),
  ]);
  const playersBy = new Map((playerRowsP ?? []).map((p: any) => [p.player_id, p]));

  // Game-level rows, pregame preferred: the pregame call is the frozen one, and
  // it is what a scheduled game has to show. The live row supersedes it for
  // display once the game is under way.
  const gpBy = new Map<number, Map<string, any>>();
  for (const r of gpRows ?? []) {
    let m = gpBy.get(r.game_pk);
    if (!m) { m = new Map(); gpBy.set(r.game_pk, m); }
    const prev = m.get(r.market);
    if (!prev || (prev.phase === "pregame" && r.phase === "live")) m.set(r.market, r);
  }

  const marketOut = (p: any) => ({
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

  const livePkSet = new Set(livePks);

  const payloads = slate.map((g: any) => {
    const ls: any = stateBy.get(g.game_pk) ?? {};
    const isLive = livePkSet.has(g.game_pk);
    const raw = isLive ? (ls.raw_json ?? {}) : {};
    const phase = isLive ? "live" : isFinalStatus(g.status) ? "final" : "pregame";
    const gpMarkets = gpBy.get(g.game_pk);

    // Markets. A live game reads the freshest per-pitch row — exactly what the
    // board has always shown. Everything else reads its stored game-level row,
    // which is what makes a scheduled game non-empty.
    const markets: any[] = [];
    const seen = new Set<string>();
    if (isLive) {
      for (const p of predRows ?? []) {
        if (p.game_pk !== g.game_pk || seen.has(p.market)) continue;
        seen.add(p.market);
        markets.push(marketOut(p));
      }
      if (!seen.has("ab_pitches_ou")) {
        const abp = (abpRows ?? []).find((p: any) => p.game_pk === g.game_pk);
        if (abp) { seen.add("ab_pitches_ou"); markets.push(marketOut(abp)); }
      }
    }
    // Fill whatever the per-pitch rows did not cover from the game-level table.
    // game_moneyline and game_total in particular only ever exist there before
    // first pitch.
    for (const [market, row] of gpMarkets ?? []) {
      if (seen.has(market)) continue;
      seen.add(market);
      markets.push(marketOut(row));
    }
    markets.sort((a, b) => (b.edge ?? -9) - (a.edge ?? -9));

    // Per-pitch history only exists for a game in progress.
    const paPredictions: any[] = [];
    if (isLive) {
      // Prediction history for the PA the pitch feed displays (raw.current_pa_abi):
      // newest row per (market, pitch position). pitch_number is the pitches-
      // thrown count when the row was scored, i.e. it predicts pitch_number + 1.
      const gamePreds = (paPredRows ?? []).filter((p: any) => p.game_pk === g.game_pk && p.at_bat_index != null);
      const maxAbi = gamePreds.length ? Math.max(...gamePreds.map((p: any) => p.at_bat_index)) : null;
      const displayedAbi = raw.current_pa_abi ?? maxAbi;
      const paPitchCount = (raw.current_pa_pitches ?? []).length;
      const seenPos = new Set<string>();
      const pushPred = (p: any, pos: number) => {
        const k = `${p.market}:${pos}`;
        if (seenPos.has(k)) return; // rows are newest-first; keep the freshest per position
        seenPos.add(k);
        paPredictions.push({
          market: p.market,
          pitch_number: pos,
          predicted_value: p.predicted_value != null ? Number(p.predicted_value) : null,
          recommendation: p.recommendation,
          line: p.line != null ? Number(p.line) : null,
          confidence: p.confidence != null ? Number(p.confidence) : null,
          probs: p.probs,
          result: p.result ?? null,
        });
      };
      // Rows for the displayed PA, at their own pitch positions.
      for (const p of gamePreds) {
        if (p.at_bat_index === displayedAbi) pushPred(p, p.pitch_number ?? 0);
      }
      // The displayed PA has ended and the model already reads the NEXT batter's
      // first pitch (rows keyed to the next at-bat, position 0) — surface those
      // at the board's "next pitch" slot (= pitches thrown in the displayed PA).
      for (const p of gamePreds) {
        if (displayedAbi != null && p.at_bat_index === displayedAbi + 1) pushPred(p, paPitchCount);
      }
      // Legacy rows (pre-roll data model): the call that predicted this PA's
      // first pitch was keyed under the PREVIOUS at-bat — surface as position 0
      // so pitch #1 still grades.
      for (const p of gamePreds) {
        if (displayedAbi != null && p.at_bat_index < displayedAbi) pushPred(p, 0);
      }
      paPredictions.sort((a, b) => a.pitch_number - b.pitch_number);
    }

    const edges = markets.map((m) => m.edge).filter((e) => e != null) as number[];
    const topEdge = edges.length ? Math.max(...edges) : 0;
    const pitcher: any = isLive ? playersBy.get(ls.pitcher_id) : null;
    const batter: any = isLive ? playersBy.get(ls.batter_id) : null;
    // Probable starters come off any game-level row; they are the same on all
    // six, and they are what an upcoming game shows instead of a live matchup.
    const anyGp: any = gpMarkets ? [...gpMarkets.values()][0] : null;
    const probable = (id: number | null) =>
      id == null ? null : { id, name: playersBy.get(id)?.full_name ?? null };

    return {
      game_pk: g.game_pk,
      status: g.status,
      phase,
      start_ts: g.start_ts,
      game_label: `${g.away_team ?? "Away"} @ ${g.home_team ?? "Home"}`,
      away_abbr: g.away_abbr ?? null,
      home_abbr: g.home_abbr ?? null,
      home_team_id: g.home_team_id ?? null,
      away_team_id: g.away_team_id ?? null,
      // Ids are additive (Phase 5) and exist so the Data Feed can look the
      // pair up in the warehouse aggregates, which are keyed on player id.
      // The live board itself renders names only and ignores these.
      pitcher_id: isLive ? (ls.pitcher_id ?? null) : null,
      pitcher_name: pitcher?.full_name ?? null,
      pitcher_hand: pitcher?.pitch_hand ?? null,
      batter_id: isLive ? (ls.batter_id ?? null) : null,
      batter_name: batter?.full_name ?? null,
      batter_hand: batter?.bat_side ?? null,
      probable_home_pitcher: probable(anyGp?.home_pitcher_id ?? null),
      probable_away_pitcher: probable(anyGp?.away_pitcher_id ?? null),
      situation: isLive
        ? {
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
        }
        : {
          inning: null, half: null, count: null, outs: null,
          pitcher_id: null, batter_id: null, pitch_count_pa: null,
          last_pitch_ts: null,
          home_score: g.home_score ?? null,
          away_score: g.away_score ?? null,
        },
      current_pa_pitches: isLive ? (raw.current_pa_pitches ?? []) : [],
      pa_predictions: paPredictions,
      markets,
      // Explicit coverage, so the client never has to infer "missing" from a
      // zero. A market absent from `markets` is absent because it was not
      // scored, and this says so.
      coverage: {
        phase,
        markets_covered: seen.size,
        markets_total: ALL_MARKETS.length,
        missing: ALL_MARKETS.filter((m) => !seen.has(m)),
      },
      has_edge: topEdge > 0.05,
      top_edge: topEdge,
      model_version: markets[0]?.model_version ?? null,
    };
  });

  // Live first, then upcoming by edge and start time, finals last.
  const rank = (p: any) => (p.phase === "live" ? 0 : p.phase === "pregame" ? 1 : 2);
  payloads.sort((a: any, b: any) =>
    rank(a) - rank(b) ||
    (b.top_edge - a.top_edge) ||
    String(a.start_ts ?? "").localeCompare(String(b.start_ts ?? ""))
  );
  return payloads;
}

async function live(): Promise<Response> {
  return json(await slatePayloads(mlbToday()));
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
  const today = mlbToday();
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
    updated: mlbToday(),
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
  const [{ data: preds }, { data: abpPreds }, { data: oddsRows }] = await Promise.all([
    db.from("predictions").select("*").eq("game_pk", gamePk)
      .order("id", { ascending: false }).limit(30),
    // ab_pitches_ou is written once per at-bat (pre-AB call) and can fall
    // outside the newest-30 window during a long PA — fetch it directly.
    db.from("predictions").select("*").eq("game_pk", gamePk)
      .eq("market", "ab_pitches_ou").order("id", { ascending: false }).limit(1),
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
  for (const p of [...(preds ?? []), ...(abpPreds ?? [])]) {
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

// ── Rolling-window helpers ─────────────────────────────────────────────────
const DAY_MS = 864e5;
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const parseDate = (s: string | null) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);

// Resolve [from, to] and clamp the span. The clamp is what keeps an unbounded
// `?from=2015-01-01` from turning the feed into a full-table scan; the indexes
// on game_predictions all lead with official_date on the assumption the window
// is bounded.
function windowParams(url: URL, maxDays: number): { from: string; to: string } {
  const to = parseDate(url.searchParams.get("to")) ?? mlbToday();
  const floor = isoDate(new Date(Date.parse(`${to}T00:00:00Z`) - (maxDays - 1) * DAY_MS));
  let from = parseDate(url.searchParams.get("from")) ?? floor;
  if (from < floor) from = floor;
  if (from > to) from = to;
  return { from, to };
}

const posInt = (s: string | null) => {
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : null;
};
// Team abbreviations go into a PostgREST `or=` filter string, which is not
// parameterised — anything not matching this shape is dropped rather than
// escaped.
const safeAbbr = (s: string | null) => (s && /^[A-Za-z]{2,4}$/.test(s) ? s.toUpperCase() : null);

function summarize(rows: any[]): Record<string, unknown> {
  const graded = rows.filter((r) => r.result != null);
  const wins = graded.filter((r) => r.result === "win").length;
  const losses = graded.filter((r) => r.result === "loss").length;
  const pushes = graded.filter((r) => r.result === "push").length;
  const edges = rows.map((r) => (r.edge != null ? Number(r.edge) : null))
    .filter((e): e is number => e != null);
  const units = graded.reduce((a, r) => a + Number(r.profit_units ?? 0), 0);
  const decided = wins + losses;
  return {
    n: rows.length,
    n_graded: graded.length,
    wins, losses, pushes,
    // Pushes are excluded from the denominator — a push is not a loss.
    win_rate: decided ? Math.round((wins / decided) * 1000) / 1000 : null,
    mean_edge: edges.length
      ? Math.round((edges.reduce((a, b) => a + b, 0) / edges.length) * 10000) / 10000
      : null,
    profit_units: Math.round(units * 100) / 100,
  };
}

// ── /api/coverage ──────────────────────────────────────────────────────────
async function coverage(url: URL): Promise<Response> {
  const { from, to } = windowParams(url, 60);
  const { data, error } = await svc().rpc("prediction_coverage", { p_from: from, p_to: to });
  if (error) return json({ error: error.message }, 500);
  const days = (data ?? []).map((d: any) => ({
    date: d.official_date,
    games: Number(d.games),
    full: Number(d.full_cov),
    partial: Number(d.partial_cov),
    zero: Number(d.zero_cov),
    pregame_full: Number(d.pregame_full),
    avg_markets: d.avg_markets != null ? Number(d.avg_markets) : null,
  }));
  const sum = (k: string) => days.reduce((a: number, d: any) => a + (d[k] ?? 0), 0);
  const games = sum("games");
  return json({
    from, to, markets_expected: ALL_MARKETS.length, days,
    totals: {
      games,
      full: sum("full"),
      zero: sum("zero"),
      pregame_full: sum("pregame_full"),
      // The headline number: what fraction of games were fully scored BEFORE
      // first pitch. Coverage achieved only in hindsight still means an empty
      // board that morning.
      pregame_full_rate: games ? Math.round((sum("pregame_full") / games) * 1000) / 1000 : null,
    },
  });
}

// ── /api/feed ──────────────────────────────────────────────────────────────
// The 30-day rolling window. Game-level rows for date/game/team/pitcher scoping;
// player rollups for pitcher/batter scoping, because per-pitch predictions carry
// no player id and are pruned at 21 days anyway.
async function feed(url: URL): Promise<Response> {
  const sp = url.searchParams;
  const { from, to } = windowParams(url, 30);
  const limit = Math.min(Math.max(posInt(sp.get("limit")) ?? 200, 1), 1000);
  const cursor = Number(sp.get("cursor")) > 0 ? Number(sp.get("cursor")) : 0;
  const db = svc();

  const gamePk = posInt(sp.get("game_pk"));
  const pitcherId = posInt(sp.get("pitcher_id"));
  const batterId = posInt(sp.get("batter_id"));
  const marketRaw = sp.get("market");
  const market = marketRaw && ALL_MARKETS.includes(marketRaw) ? marketRaw : null;
  const phaseRaw = sp.get("phase");
  const phase = phaseRaw === "pregame" || phaseRaw === "live" ? phaseRaw : null;
  const teamRaw = sp.get("team");
  const teamId = posInt(teamRaw);
  const teamAbbr = teamId ? null : safeAbbr(teamRaw);

  // A batter never appears on a game-level row, so a batter-only query has no
  // game rows to return — it is answered entirely from the player rollup.
  const wantGames = !(batterId && !gamePk && !teamId && !teamAbbr && !pitcherId);

  let games: any[] = [];
  if (wantGames) {
    let q = db.from("game_predictions").select("*")
      .gte("official_date", from).lte("official_date", to)
      .order("official_date", { ascending: false })
      .order("game_pk", { ascending: false })
      .range(cursor, cursor + limit - 1);
    if (gamePk) q = q.eq("game_pk", gamePk);
    if (market) q = q.eq("market", market);
    if (phase) q = q.eq("phase", phase);
    if (teamId) q = q.or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`);
    else if (teamAbbr) q = q.or(`home_abbr.eq.${teamAbbr},away_abbr.eq.${teamAbbr}`);
    if (pitcherId) q = q.or(`home_pitcher_id.eq.${pitcherId},away_pitcher_id.eq.${pitcherId}`);
    const { data, error } = await q;
    if (error) return json({ error: error.message }, 500);
    games = data ?? [];
  }

  let players: any[] = [];
  if (pitcherId || batterId) {
    let pq = db.from("player_prediction_daily").select("*")
      .gte("day", from).lte("day", to)
      .order("day", { ascending: false }).limit(limit);
    pq = pitcherId
      ? pq.eq("player_id", pitcherId).eq("role", "pitcher")
      : pq.eq("player_id", batterId!).eq("role", "batter");
    if (market) pq = pq.eq("market", market);
    const { data, error } = await pq;
    if (error) return json({ error: error.message }, 500);
    players = data ?? [];
  }

  return json({
    from, to,
    filters: {
      game_pk: gamePk, team: teamId ?? teamAbbr, pitcher_id: pitcherId,
      batter_id: batterId, market, phase,
    },
    games,
    players,
    // Batter-only queries have no game rows, so their headline numbers come
    // from the per-pitch rollup instead.
    summary: games.length || !players.length
      ? summarize(games)
      : {
        n: players.reduce((a, p) => a + Number(p.n ?? 0), 0),
        n_graded: players.reduce((a, p) => a + Number(p.n_graded ?? 0), 0),
        wins: players.reduce((a, p) => a + Number(p.wins ?? 0), 0),
        losses: players.reduce((a, p) => a + Number(p.losses ?? 0), 0),
        pushes: players.reduce((a, p) => a + Number(p.pushes ?? 0), 0),
        win_rate: null, mean_edge: null,
        profit_units: Math.round(
          players.reduce((a, p) => a + Number(p.mean_profit_units ?? 0) * Number(p.n_graded ?? 0), 0) * 100,
        ) / 100,
      },
    next_cursor: games.length === limit ? cursor + limit : null,
  });
}

// ── /api/board ─────────────────────────────────────────────────────────────
// The recap of the last completed slate. This is what fills the screen when
// nothing has started yet, and it is the reason the board no longer has an
// empty state.
async function recapFor(date: string): Promise<Record<string, unknown> | null> {
  const db = svc();
  const from = isoDate(new Date(Date.parse(`${date}T00:00:00Z`) - 10 * DAY_MS));
  const { data: gs } = await db.from("games")
    .select("game_pk,official_date,status,home_abbr,away_abbr,home_team,away_team,home_score,away_score")
    .gte("official_date", from).lt("official_date", date);
  if (!gs?.length) return null;

  const byDate = new Map<string, any[]>();
  for (const g of gs) {
    const arr = byDate.get(g.official_date) ?? [];
    arr.push(g);
    byDate.set(g.official_date, arr);
  }
  // Most recent day where every scheduled game actually finished. A day with a
  // suspended or postponed game is skipped rather than shown half-complete.
  const recapDate = [...byDate.keys()].sort().reverse()
    .find((d) => byDate.get(d)!.every((r) => isFinalStatus(r.status))) ?? null;
  if (!recapDate) return null;

  const dayGames = byDate.get(recapDate)!;
  const { data: gp } = await db.from("game_predictions").select("*")
    .in("game_pk", dayGames.map((g) => g.game_pk));

  // Pregame rows are the track record: they were fixed before a pitch was
  // thrown. The live row is only a fallback for a game that predates
  // game-predict.
  const preferred = new Map<number, Map<string, any>>();
  for (const r of gp ?? []) {
    let m = preferred.get(r.game_pk);
    if (!m) { m = new Map(); preferred.set(r.game_pk, m); }
    const prev = m.get(r.market);
    if (!prev || (prev.phase === "live" && r.phase === "pregame")) m.set(r.market, r);
  }

  const all: any[] = [];
  const games = dayGames.map((g) => {
    const rows = [...(preferred.get(g.game_pk)?.values() ?? [])];
    all.push(...rows);
    return {
      game_pk: g.game_pk,
      game_label: `${g.away_team ?? "Away"} @ ${g.home_team ?? "Home"}`,
      away_abbr: g.away_abbr, home_abbr: g.home_abbr,
      away_score: g.away_score, home_score: g.home_score,
      markets: rows.map((r) => ({
        market: r.market,
        recommendation: r.recommendation,
        predicted_value: r.predicted_value != null ? Number(r.predicted_value) : null,
        line: r.line != null ? Number(r.line) : null,
        actual_value: r.actual_value != null ? Number(r.actual_value) : null,
        edge: r.edge != null ? Number(r.edge) : null,
        result: r.result ?? null,
        profit_units: r.profit_units != null ? Number(r.profit_units) : null,
        model_version: r.model_version,
      })),
      coverage: {
        markets_covered: rows.length,
        markets_total: ALL_MARKETS.length,
        missing: ALL_MARKETS.filter((m) => !rows.some((r) => r.market === m)),
      },
    };
  });

  const byMarket: Record<string, unknown> = {};
  for (const m of ALL_MARKETS) {
    const rows = all.filter((r) => r.market === m);
    if (rows.length) byMarket[m] = summarize(rows);
  }
  const graded = all.filter((r) => r.result != null && r.profit_units != null);
  const bestWorst = [...graded].sort(
    (a, b) => Number(b.profit_units) - Number(a.profit_units),
  );

  return {
    date: recapDate,
    games,
    totals: {
      ...summarize(all),
      games: dayGames.length,
      by_market: byMarket,
      best: bestWorst[0] ?? null,
      worst: bestWorst.length > 1 ? bestWorst[bestWorst.length - 1] : null,
    },
  };
}

async function board(url: URL): Promise<Response> {
  const date = parseDate(url.searchParams.get("date")) ?? mlbToday();
  const [payloads, recap] = await Promise.all([slatePayloads(date), recapFor(date)]);
  return json({
    date,
    recap,
    live: payloads.filter((p) => p.phase === "live"),
    upcoming: payloads.filter((p) => p.phase === "pregame"),
    final: payloads.filter((p) => p.phase === "final"),
  });
}

function jsonWith(body: unknown, origin: string, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  // Path arrives as /api/<route...>
  const route = url.pathname.replace(/^\/api\/?/, "").replace(/\/+$/, "");
  const origin = pickOrigin(await allowedOrigins(), req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });

  // Every cache key goes through here, so a route added later cannot forget to
  // include its query string (see normalizedQuery above for why that matters).
  const qs = normalizedQuery(url);
  const hit = (key: string, ttl: number, fn: () => Response | Promise<Response>) =>
    cached(key + qs, ttl, origin, fn);

  try {
    const em = route.match(/^edge\/(\d+)$/);
    if (em) return await hit(`edge/${em[1]}`, TTL["edge"], () => edge(Number(em[1])));

    // Parameterised aggregate routes. These follow the `edge/(\d+)` pattern
    // rather than the switch below, which only matches literal paths.
    // A player or game with no published rows is a 404 with found:false, so
    // the Data Feed can render an empty panel with a note instead of
    // mistaking absence for breakage.
    const pm = route.match(/^player\/(\d+)\/(profile|splits|fatigue)$/);
    if (pm) {
      const id = Number(pm[1]);
      const kind = pm[2];
      const fn = kind === "profile"
        ? () => aggs.playerProfile(svc(), id)
        : kind === "splits"
        ? () => aggs.playerSplits(svc(), id)
        : () => aggs.playerFatigue(svc(), id);
      return await hit(`player/${id}/${kind}`, TTL[`player/${kind}`],
        async () => {
          const r = await fn();
          return json({ found: r.found, ...r.data }, r.found ? 200 : 404);
        });
    }

    const mm = route.match(/^matchup\/(\d+)\/(\d+)$/);
    if (mm) {
      const [p, b] = [Number(mm[1]), Number(mm[2])];
      return await hit(`matchup/${p}/${b}`, TTL["matchup"],
        async () => {
          const r = await aggs.matchup(svc(), p, b);
          // found:false here means "fewer than 3 career meetings", which is
          // the norm, not an error -- still 200.
          return json({ found: r.found, ...r.data });
        });
    }

    const gm = route.match(/^game\/(\d+)\/context$/);
    if (gm) {
      const pk = Number(gm[1]);
      return await hit(`game/${pk}/context`, TTL["game/context"],
        async () => {
          const r = await aggs.gameContext(svc(), pk);
          // 200 even when absent. Context is written by the nightly warehouse
          // publish, so every in-progress game is legitimately missing until
          // tomorrow -- the overwhelmingly common case. A 404 here logged a
          // browser console error on every Data Feed load during a live game,
          // and `cached()` only memoises 200s, so it also re-hit the origin
          // on every batter change.
          return json({ found: r.found, ...r.data });
        });
    }
    switch (route) {
      case "health": case "": return await hit(route, TTL[route] ?? 0, health);
      case "games": return await hit("games", TTL["games"], games);
      case "live": return await hit("live", TTL["live"], live);
      case "board": return await hit("board", TTL["board"], () => board(url));
      case "feed": return await hit("feed", TTL["feed"], () => feed(url));
      case "coverage": return await hit("coverage", TTL["coverage"], () => coverage(url));
      case "picks/today": return await hit("picks/today", TTL["picks/today"], picksToday);
      case "odds/today": return await hit("odds/today", TTL["odds/today"], oddsToday);
      case "record": return await hit("record", TTL["record"], record);
      case "sportsbooks":
        return await hit("sportsbooks", TTL["sportsbooks"],
          () => json({ disclaimer: DISCLAIMER, books: BOOKS }));
      default:
        return jsonWith({ error: `no route: ${route}` }, origin, 404);
    }
  } catch (e) {
    return jsonWith({ error: String(e) }, origin, 500);
  }
});
