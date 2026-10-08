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
import { getGameConditions, isRoofClosed, mlbToday } from "../_shared/mlb.ts";
import { winProbSeries } from "../_shared/winprob.ts";
import { resolveSlate } from "../_shared/slate.ts";
import * as aggs from "../_shared/aggregates.ts";
import { DEFAULT_LIMIT, MAX_LIMIT, pitchFeed } from "../_shared/pitchfeed.ts";
import { gradingHealth } from "../_shared/settlequeue.ts";
import { liveTotal, remainingOuts, remainingPa, restOfGame } from "../_shared/basemodels.ts";
import { convolve, negbinPmf, overProb } from "../_shared/props.ts";

// Active model versions for the live base-model markets, cached per instance:
// /live is the hottest route and these change only when a model is promoted.
const LIVE_BASE_MARKETS = ["batter_hit_rog", "batter_hr_rog", "game_total_live"];
let liveModelsCache: { expires: number; versions: Record<string, string> } = { expires: 0, versions: {} };
async function liveModelVersions(): Promise<Record<string, string>> {
  if (liveModelsCache.expires > Date.now()) return liveModelsCache.versions;
  const { data } = await svc().from("model_params").select("market,version")
    .eq("is_active", true).in("market", LIVE_BASE_MARKETS);
  const versions: Record<string, string> = {};
  for (const r of data ?? []) versions[r.market] = r.version;
  liveModelsCache = { expires: Date.now() + 300_000, versions };
  return versions;
}

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
  // game/context was an hour when it only ever read the nightly boxscore
  // table; it now falls back to MLB's pregame readings for games that table
  // does not have yet, and those move (crews and forecasts are posted late).
  "matchup": 300, "game/context": 900,
  // Per-at-bat win-probability history: grows by one point an at-bat.
  "game/winprob": 15,
  // A team's next game only changes when the schedule does.
  "team/next": 300,
  // Board recap is built from graded rows that stop moving once a slate is
  // final; the live section inside it is refreshed by the client's own /live
  // poll, so 60s here does not make the live board stale.
  "board": 60, "feed": 60, "coverage": 300,
  // Permanent per-day accuracy rollup, rewritten once a night by
  // rollup_prediction_accuracy. Nothing about it moves during a slate.
  "accuracy": 300,
  // Same source cadence: player_prediction_daily is rebuilt by the nightly
  // rollup, so a slate in progress cannot move a trend.
  "trends": 300,
  // Batter projections are rewritten by every game-predict pass, and the
  // lineups that drive them land a few hours before first pitch -- so a
  // long cache would serve "no lineup yet" well past the point it is true.
  "projections": 60,
  // Per-pitch graded history. 15s matches /edge: during a live game new rows
  // land every 30s and the Data Feed is the surface watching them arrive, so a
  // 60s cache would make it visibly lag the board it sits next to.
  "pitches": 15,
  // Data Feed reads. graded_read is rebuilt every 15 minutes, so nothing here
  // moves faster than that; the venue list only grows when a new park appears.
  "graded": 60, "graded/summary": 120, "graded/venues": 3600,
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
  const [
    { count: pitchCount }, { data: runs }, { data: model }, { data: bf }, { data: aggRows },
    { data: oldPred }, { data: oldGame }, { data: oldProj },
  ] = await Promise.all([
      db.from("pitches").select("id", { count: "exact", head: true }),
      db.from("ingest_runs").select("job,finished_at,ok").order("id", { ascending: false }).limit(200),
      db.from("model_params").select("market,version").eq("is_active", true),
      db.from("backfill_progress").select("cursor_date,start_date,done,updated_at").eq("id", 1).maybeSingle(),
      db.rpc("aggregate_freshness"),
      // The oldest ungraded row of each grading queue. Each is a partial-index
      // probe (~1ms), so this stays cheap at the board's poll rate.
      db.from("predictions").select("created_at").is("result", null).order("id").limit(1),
      db.from("game_predictions").select("official_date").is("result", null)
        .order("official_date").limit(1),
      db.from("player_game_projections").select("official_date").is("result", null)
        .order("official_date").limit(1),
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

  // Settle jams are silent -- it keeps running, logs ok, and grades nothing
  // (2026-09-11 to 10-01). Read the queues directly instead of the job log.
  const grading = gradingHealth({
    predictionsOldest: oldPred?.[0]?.created_at ?? null,
    gameOldestDate: oldGame?.[0]?.official_date ?? null,
    projectionsOldestDate: oldProj?.[0]?.official_date ?? null,
  }, now, mlbToday());

  return json({
    status: "ok",
    timestamp: new Date().toISOString(),
    grading,
    grading_jammed: grading.jammed,
    // NOTE: this is the 35-day hot window since the Phase 3 swap, not all of
    // history. It fell 1,217,858 -> ~126,000 on 2026-08-03 by design; the rest
    // lives in R2. See docs/DATA-PIPELINE.md §5.
    pitches_rows: pitchCount ?? 0,
    jobs,
    data_fresh: dataFresh,
    backfill: bf ?? null,
    active_models: model ?? [],
    aggregates,
    aggregates_stale: aggregates.some((a: AggFreshness) => a.stale),
  });
}

// The schedule for the slate the board shows: today, or -- on an off day --
// the next date with games (see _shared/slate.ts). `is_today` is what lets the
// Home tab say "Next slate" instead of presenting tomorrow's games as today's.
async function games(): Promise<Response> {
  const db = svc();
  const slate = await resolveSlate(db);
  const { data } = await db.from("games")
    .select("game_pk,status,home_team,away_team,home_abbr,away_abbr,start_ts,home_score,away_score,venue_name")
    .eq("official_date", slate.date).order("start_ts");
  return json({ date: slate.date, is_today: slate.isToday, games: data ?? [] });
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
      "home_team_id,away_team_id,home_score,away_score,venue_name,game_type")
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
  const [
    { data: playerRowsP }, { data: predRows }, { data: paPredRows }, { data: abpRows },
    { data: projRows }, liveVersions,
  ] = await Promise.all([
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
    // Frozen pregame per-PA rates and lineup slots, for the live
    // rest-of-game base model. Live games only.
    livePks.length
      ? db.from("player_game_projections")
        .select("game_pk,player_id,market,per_pa_probability,lineup_slot,is_home")
        .in("game_pk", livePks).in("market", ["batter_hit", "batter_hr"])
      : Promise.resolve(empty),
    livePks.length ? liveModelVersions() : Promise.resolve({} as Record<string, string>),
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

  // The SAME markets, frozen at the pregame call. `gpBy` above prefers the live
  // row, which is right for "what does the model say now" and wrong for "what
  // did it say before a pitch was thrown" — and for game_moneyline those are
  // different numbers, because live-poll overwrites the log5 call with an MLB
  // live win probability every poll. Both are served so the board can show the
  // live read next to the call it opened with.
  const gpPre = new Map<number, Map<string, any>>();
  for (const r of gpRows ?? []) {
    if (r.phase !== "pregame") continue;
    let m = gpPre.get(r.game_pk);
    if (!m) { m = new Map(); gpPre.set(r.game_pk, m); }
    if (!m.has(r.market)) m.set(r.market, r);
  }

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

    // Live base models (_shared/basemodels.ts), only for a game in progress
    // and only while each market has an active model row.
    let liveModels: any = null;
    if (isLive && ls.inning != null) {
      const sit = { inning: Number(ls.inning), top: !!ls.top_inning, outs: Number(ls.outs ?? 0) };
      liveModels = {};
      const preTotal = gpPre.get(g.game_pk)?.get("game_total");
      const v3Mu = preTotal?.probs?.mu_home != null && preTotal?.probs?.mu_away != null;
      if (v3Mu && preTotal?.line != null) {
        // v3: the pregame team-run means, scaled to the outs each side has
        // left, as negative binomials -- the same family the pregame total
        // was priced from, so the live number starts where the pregame one
        // did and converges to the score as outs run out.
        const now = Number(ls.home_score ?? 0) + Number(ls.away_score ?? 0);
        const a = Number(preTotal.probs.alpha ?? 0);
        const muH = Number(preTotal.probs.mu_home) * remainingOuts(sit, "home") / 27;
        const muA = Number(preTotal.probs.mu_away) * remainingOuts(sit, "away") / 27;
        const line = Number(preTotal.line);
        const rest = convolve(negbinPmf(muH, a, 30), negbinPmf(muA, a, 30));
        liveModels.total = {
          projected: Math.round((now + muH + muA) * 1e4) / 1e4, line,
          p_over: now > line ? 1 : Math.round(overProb(rest, line - now) * 1e4) / 1e4,
          model_version: `${preTotal.model_version}:live`,
        };
      } else if (liveVersions["game_total_live"] && preTotal?.line != null) {
        liveModels.total = {
          ...liveTotal({ ...sit, home: Number(ls.home_score ?? 0), away: Number(ls.away_score ?? 0) },
            Number(preTotal.line)),
          model_version: liveVersions["game_total_live"],
        };
      }
      const v3Rog = (projRows ?? []).some((r: any) => r.game_pk === g.game_pk &&
        String(r.model_version ?? "").startsWith("v3") && r.per_pa_probability != null);
      if (liveVersions["batter_hit_rog"] || liveVersions["batter_hr_rog"] || v3Rog) {
        const by = new Map<number, any>();
        for (const r of projRows ?? []) {
          if (r.game_pk !== g.game_pk) continue;
          const b = by.get(r.player_id) ?? { player_id: r.player_id, slot: r.lineup_slot, is_home: r.is_home };
          b[r.market] = r.per_pa_probability != null ? Number(r.per_pa_probability) : null;
          by.set(r.player_id, b);
        }
        // The batting side's current slot, from the batter at the plate.
        const battingHome = !ls.top_inning;
        const atPlate = by.get(ls.batter_id);
        const currentSlot = atPlate?.slot ?? null;
        liveModels.rest_of_game = [...by.values()].filter((b) => b.slot != null).map((b) => {
          const side = b.is_home ? "home" : "away";
          const rem = remainingPa({
            ...sit, side, slot: b.slot,
            currentSlot: b.is_home === battingHome ? currentSlot : null,
          });
          return {
            player_id: b.player_id, side, slot: b.slot, remaining_pa: rem,
            hit: (liveVersions["batter_hit_rog"] || v3Rog) && b.batter_hit != null ? restOfGame(b.batter_hit, rem) : null,
            hr: (liveVersions["batter_hr_rog"] || v3Rog) && b.batter_hr != null ? restOfGame(b.batter_hr, rem) : null,
          };
        });
        liveModels.rest_of_game_version = v3Rog ? "v3_pa_outcome"
          : liveVersions["batter_hit_rog"] ?? liveVersions["batter_hr_rog"];
      }
    }

    return {
      game_pk: g.game_pk,
      status: g.status,
      phase,
      start_ts: g.start_ts,
      game_label: `${g.away_team ?? "Away"} @ ${g.home_team ?? "Home"}`,
      away_abbr: g.away_abbr ?? null,
      home_abbr: g.home_abbr ?? null,
      // The slate pill names the park. games.venue_name has always been
      // populated by the schedule ingest; nothing served it, so the board had
      // to wait for the nightly game_context publish to learn where a game
      // being played right now was being played.
      venue: g.venue_name ?? null,
      // R regular season; F/D/L/W the postseason rounds. The batter models
      // are fitted on regular-season games, so the board says so on these.
      game_type: g.game_type ?? null,
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
          // Written by live-poll from the play-by-play (raw_json); null on
          // a state stored before those fields existed.
          bases: raw.bases ?? null,
          pitcher_pitch_count: raw.pitcher_pitch_count ?? null,
        }
        : {
          inning: null, half: null, count: null, outs: null,
          pitcher_id: null, batter_id: null, pitch_count_pa: null,
          last_pitch_ts: null,
          home_score: g.home_score ?? null,
          away_score: g.away_score ?? null,
        },
      // Pregame game-level calls, always, regardless of phase. Empty before
      // game-predict has run for the slate.
      markets_pregame: [...(gpPre.get(g.game_pk)?.values() ?? [])].map(marketOut),
      // Live base models: projected total vs the pregame line, and each
      // projected batter's rest-of-game 1+ hit / HR. null unless live.
      live_models: liveModels,
      current_pa_pitches: isLive ? (raw.current_pa_pitches ?? []) : [],
      // The batter at the plate's line so far today: { pa, h, hr, bb, k }.
      batter_today: isLive ? (raw.batter_today ?? null) : null,
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

// The whole slate, not just live games -- and on an off day the NEXT slate,
// because the Home tab renders from this. Stays a bare array: the slate's date
// rides on /games.
async function live(): Promise<Response> {
  return json(await slatePayloads((await resolveSlate(svc())).date));
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

// GET /projections?date=YYYY-MM-DD&market=batter_hr — per-batter P(hit) and
// P(home run) for a slate.
//
// An ANALYTICS surface, not a price. Every row is `model_fair`: there is no
// prop source for these markets, so there is no edge figure. The response says
// `book` explicitly rather than leaving a reader to assume a line exists.
//
// `result` is the settle job's grade: 'hit' | 'miss' | 'void', null while the
// game is unsettled. `void` is a batter who did not bat (DNP) and is not a
// miss; null is pending and is not a miss either.
//
// Ordered by probability so the interesting rows arrive first; a slate is
// ~270 rows per market, which is one page.
async function projections(url: URL): Promise<Response> {
  const date = parseDate(url.searchParams.get("date")) ?? (await resolveSlate(svc())).date;
  const market = url.searchParams.get("market");
  const valid = [
    "batter_hit", "batter_hr", "batter_tb15", "batter_hrr",
    "pitcher_k", "pitcher_bb", "pitcher_hits", "pitcher_outs", "pitcher_er",
  ];
  if (market && !valid.includes(market)) {
    return json({ error: `market must be one of ${valid.join(", ")}` }, 400);
  }
  // role=pitcher returns every starter prop at once (~10 rows a game); a whole
  // slate across all markets would pass the 1,000-row page cap.
  const role = url.searchParams.get("role");
  if (role && role !== "batter" && role !== "pitcher") {
    return json({ error: "role must be batter or pitcher" }, 400);
  }

  let q = svc().from("player_game_projections")
    .select("game_pk,player_id,market,team_id,opponent_id,is_home," +
            "lineup_slot,opposing_pitcher_id,probability,per_pa_probability," +
            "expected_pa,model_version,book,updated_at," +
            "result,actual_count,plate_appearances,role,line,expected_value")
    .eq("official_date", date);
  if (market) q = q.eq("market", market);
  if (role) q = q.eq("role", role);
  const { data } = await q.order("probability", { ascending: false }).limit(1000);

  const rows = data ?? [];
  const isPitcherRow = (r: any) => (r.role ?? "batter") === "pitcher";
  const batterIds = [...new Set(rows.filter((r: any) => !isPitcherRow(r)).map((r: any) => r.player_id))];
  const pitcherIds = [...new Set([
    ...rows.filter(isPitcherRow).map((r: any) => r.player_id),
    ...rows.map((r: any) => r.opposing_pitcher_id).filter(Boolean),
  ])];
  const [names, form] = await Promise.all([
    playerNames([
      ...rows.map((r: any) => r.player_id),
      ...rows.map((r: any) => r.opposing_pitcher_id).filter(Boolean),
    ]),
    rollingForm(batterIds as number[], pitcherIds as number[]),
  ]);
  return json({
    date,
    market: market ?? "all",
    // Stated so a consumer cannot mistake these for priced picks.
    priced: false,
    rows: rows.map((r: any) => ({
      game_pk: r.game_pk,
      player_id: r.player_id,
      player: names.get(r.player_id) ?? null,
      market: r.market,
      team_id: r.team_id,
      opponent_id: r.opponent_id,
      is_home: r.is_home,
      lineup_slot: r.lineup_slot,
      opposing_pitcher_id: r.opposing_pitcher_id,
      opposing_pitcher: names.get(r.opposing_pitcher_id) ?? null,
      probability: r.probability != null ? Number(r.probability) : null,
      per_pa_probability: r.per_pa_probability != null
        ? Number(r.per_pa_probability) : null,
      expected_pa: r.expected_pa != null ? Number(r.expected_pa) : null,
      model_version: r.model_version,
      book: r.book,
      updated_at: r.updated_at,
      result: r.result ?? null,
      actual_count: r.actual_count ?? null,
      plate_appearances: r.plate_appearances ?? null,
      // Base-model markets: role is batter | pitcher; pitcher_* rows are a
      // line and P(over) (probability), expected_value the projected count.
      role: r.role ?? "batter",
      line: r.line != null ? Number(r.line) : null,
      expected_value: r.expected_value != null ? Number(r.expected_value) : null,
      // 30-day per-PA form from the rolling-stats tables the live scorer
      // reads: the player's own, and for a batter, the opposing starter's
      // rates allowed. null when the player has no row (too few PAs).
      form_30d: isPitcherRow(r)
        ? (form.pitchers.get(r.player_id) ?? null)
        : (form.batters.get(r.player_id) ?? null),
      opp_form_30d: r.opposing_pitcher_id != null
        ? (form.pitchers.get(r.opposing_pitcher_id) ?? null) : null,
    })),
  });
}

// 30-day per-PA hit and home-run rates, batters and pitchers, keyed by id.
// These are the same rows model.ts reads for the *_hit_delta / *_hr_delta
// features, so the "why" a reader sees is the input the model used.
type Form30 = { pa: number; hit_rate: number | null; hr_rate: number | null };
async function rollingForm(batterIds: number[], pitcherIds: number[]) {
  const num = (v: unknown) => (v == null ? null : Number(v));
  const empty = { data: [] as any[] };
  const [{ data: b }, { data: p }] = await Promise.all([
    batterIds.length
      ? svc().from("batter_rolling_stats").select("batter_id,sample_pas,hit_rate,hr_rate")
        .in("batter_id", batterIds)
      : Promise.resolve(empty),
    pitcherIds.length
      ? svc().from("pitcher_rolling_stats").select("pitcher_id,sample_abs,hit_rate,hr_rate")
        .in("pitcher_id", pitcherIds)
      : Promise.resolve(empty),
  ]);
  const batters = new Map<number, Form30>();
  for (const r of b ?? []) {
    batters.set(r.batter_id, { pa: Number(r.sample_pas ?? 0), hit_rate: num(r.hit_rate), hr_rate: num(r.hr_rate) });
  }
  const pitchers = new Map<number, Form30>();
  for (const r of p ?? []) {
    pitchers.set(r.pitcher_id, { pa: Number(r.sample_abs ?? 0), hit_rate: num(r.hit_rate), hr_rate: num(r.hr_rate) });
  }
  return { batters, pitchers };
}

// ── /api/graded, /api/graded/summary, /api/graded/venues ─────────────────
// The Data Feed: every resolved read, one row each, graded once at the
// probability it carried when its market locked. Rows live in graded_read,
// rebuilt every 15 minutes by refresh_graded_reads() (see the migration for
// what counts as a read). `result` is hit | miss | void — never pending, so an
// unsettled read cannot be counted as a miss.
//
// Both routes take the same filters. hand and side exist only for batter,
// at-bat and pitch reads; filtering on them drops win prob and totals.
const GRADED_MARKETS = [
  "batter_hit", "batter_hr", "batter_hrr", "game_moneyline", "game_total", "ab_result", "pitch_result",
];
// The widest window a graded request may ask for. Pitch and at-bat reads
// only go back as far as the predictions hot window (35 days); batter and
// game reads go back to when graded_read began, so the Data Feed's "Season"
// window asks for 120 days and gets whatever each market has.
const GRADED_MAX_DAYS = 120;
function gradedFilters(sp: URLSearchParams) {
  const market = sp.get("market");
  const team = (sp.get("team") ?? "").toUpperCase();
  const hand = (sp.get("hand") ?? "").toUpperCase();
  const side = (sp.get("side") ?? "").toLowerCase();
  return {
    market: market && GRADED_MARKETS.includes(market) ? market : null,
    team: /^[A-Z]{2,3}$/.test(team) ? team : null,
    venue: posInt(sp.get("venue")),
    hand: hand === "L" || hand === "R" ? hand : null,
    side: side === "home" || side === "away" ? side : null,
  };
}

async function graded(url: URL): Promise<Response> {
  const sp = url.searchParams;
  const { from, to } = windowParams(url, GRADED_MAX_DAYS);
  const f = gradedFilters(sp);
  const limit = Math.min(Math.max(posInt(sp.get("limit")) ?? 40, 1), 200);
  const cursor = Number(sp.get("cursor")) > 0 ? Number(sp.get("cursor")) : 0;

  let q = svc().from("graded_read")
    .select("id,resolved_at,official_date,market,game_pk,away_abbr,home_abbr," +
            "venue_id,venue_name,team_abbrs,subject,probability,result,actual_label," +
            "opp_pitcher_hand,batting_side,lineup_slot,batter_id,pitcher_id,batter_team",
            { count: "exact" })
    .gte("official_date", from).lte("official_date", to);
  if (f.market) q = q.eq("market", f.market);
  if (f.team) q = q.contains("team_abbrs", [f.team]);
  if (f.venue) q = q.eq("venue_id", f.venue);
  if (f.hand) q = q.eq("opp_pitcher_hand", f.hand);
  if (f.side) q = q.eq("batting_side", f.side);
  const { data, error, count } = await q
    .order("resolved_at", { ascending: false }).order("id", { ascending: false })
    .range(cursor, cursor + limit - 1);
  if (error) return json({ error: error.message }, 500);

  // deno-lint-ignore no-explicit-any
  const rows = (data ?? []) as any[];
  const names = await playerNames([
    ...rows.map((r) => r.batter_id), ...rows.map((r) => r.pitcher_id),
  ].filter(Boolean));
  const total = count ?? rows.length;
  return json({
    from, to, filters: f, total,
    next_cursor: cursor + rows.length < total ? cursor + rows.length : null,
    rows: rows.map((r) => ({
      id: r.id, resolved_at: r.resolved_at, official_date: r.official_date,
      market: r.market, game_pk: r.game_pk,
      away_abbr: r.away_abbr, home_abbr: r.home_abbr,
      venue_id: r.venue_id, venue_name: r.venue_name, team_abbrs: r.team_abbrs,
      // Batter markets store no subject: the subject is the batter.
      subject: r.subject ?? names.get(r.batter_id) ?? null,
      probability: Number(r.probability),
      result: r.result, actual_label: r.actual_label,
      opp_pitcher_hand: r.opp_pitcher_hand, batting_side: r.batting_side,
      lineup_slot: r.lineup_slot, batter_team: r.batter_team,
      batter_name: names.get(r.batter_id) ?? null,
      pitcher_name: names.get(r.pitcher_id) ?? null,
    })),
  });
}

async function gradedSummary(url: URL): Promise<Response> {
  const { from, to } = windowParams(url, GRADED_MAX_DAYS);
  const f = gradedFilters(url.searchParams);
  const { data, error } = await svc().rpc("graded_summary", {
    p_from: from, p_to: to, p_market: f.market, p_team: f.team,
    p_venue: f.venue, p_hand: f.hand, p_side: f.side,
  });
  if (error) return json({ error: error.message }, 500);
  return json({ from, to, filters: f, ...(data ?? {}) });
}

async function gradedVenues(): Promise<Response> {
  const { data, error } = await svc().rpc("graded_venues");
  if (error) return json({ error: error.message }, 500);
  return json({ venues: data ?? [] });
}

async function playerNames(ids: number[]): Promise<Map<number, string>> {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return new Map();
  const { data } = await svc().from("player_info")
    .select("player_id,full_name").in("player_id", uniq);
  return new Map((data ?? []).map((r: any) => [r.player_id, r.full_name]));
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

// How far back a streak looks. The raw calls it has to order are pruned at 21
// days, but the binding constraint is cost, not retention: each (player, role)
// is an index probe into at_bats plus a walk of that player's calls, measured
// at ~75ms over 20 days and ~25ms over 7. A player gets roughly 30 settled
// calls a game, so 7 days is about 200 calls deep — past any real run, and a
// third of the work. Reported to the client as streak_horizon_days.
const STREAK_DAYS = 7;
// And a hard cap on how many players are asked about at once, independent of
// `limit`. Streaks are the only part of this route that scales with the page
// size; the panel shows a dozen rows, so a caller asking for 200 must not turn
// one cached response into a 30-second query.
const STREAK_MAX_PLAYERS = 25;
// player_prediction_daily gained its `side` column on 2026-08-25; rows rolled
// up before then cannot be split home/away, because the raw calls they came
// from are already past the 21-day prune. Reported so a client can scope the
// split honestly rather than presenting a partial one as complete.
const SIDE_FROM = "2026-08-04";

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
  const db = svc();
  // Two different questions, and the second is the one that used to be
  // unanswerable. prediction_coverage() asks "did this game get all six
  // markets at least once" — a game scored in the 3rd inning and never again
  // still passes it. prediction_coverage_pitch() asks "did every pitch thrown
  // get a velocity and a result call", which is what actually broke while the
  // per-game number read as healthy. See 20260814000001_pitch_coverage.sql.
  const [{ data, error }, pitchCov] = await Promise.all([
    db.rpc("prediction_coverage", { p_from: from, p_to: to }),
    db.rpc("prediction_coverage_pitch", { p_from: from, p_to: to }),
  ]);
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

  // Non-fatal: a failure here must not take down the per-game numbers, which
  // are what the QA dashboard has always read.
  const pitchDays = (pitchCov.error ? [] : pitchCov.data ?? []).map((d: any) => ({
    date: d.official_date,
    games: Number(d.games),
    pitches_thrown: Number(d.pitches_thrown),
    velo_called: Number(d.velo_called),
    result_called: Number(d.result_called),
    both_called: Number(d.both_called),
    uncalled: Number(d.uncalled),
    both_rate: d.both_rate != null ? Number(d.both_rate) : null,
  }));
  const pSum = (k: string) => pitchDays.reduce((a: number, d: any) => a + (d[k] ?? 0), 0);
  const thrown = pSum("pitches_thrown");

  return json({
    from, to, markets_expected: ALL_MARKETS.length, days,
    // The window is clamped server-side to the 21-day raw-prediction
    // retention horizon: past it the calls are pruned and every day would
    // read as a total failure rather than as unmeasurable.
    per_pitch: {
      days: pitchDays,
      error: pitchCov.error ? pitchCov.error.message : null,
      totals: {
        pitches_thrown: thrown,
        velo_called: pSum("velo_called"),
        result_called: pSum("result_called"),
        both_called: pSum("both_called"),
        uncalled: pSum("uncalled"),
        // The headline: fraction of pitches actually thrown carrying both a
        // velocity and a result call.
        both_rate: thrown ? Math.round((pSum("both_called") / thrown) * 1000) / 1000 : null,
      },
    },
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

// ── /api/accuracy ──────────────────────────────────────────────────────────
// Per-day, per-market grading — the series behind "accuracy over time by
// market" on the Data Feed.
//
// `prediction_accuracy_daily` has been filled nightly by
// `rollup_prediction_accuracy()` since 20260728000002 and is never pruned, so
// it outlives the 21-day raw-prediction horizon `/api/pitches` is bounded by.
// It is the only place a day older than the prune can still be scored — and
// until now nothing served it, so the permanent accuracy record was
// unreachable from the product that exists to report it.
//
// Rows are keyed `(day, market, model_version)`. The version split is summed
// here rather than in the browser: every client then draws the same series,
// and a mid-window promotion shows as one day rather than two half-height bars.
async function accuracy(url: URL): Promise<Response> {
  // Wider than /feed's 30: this table is never pruned, and the point of the
  // chart is the trend, which a month cannot show.
  const { from, to } = windowParams(url, 120);
  const marketRaw = url.searchParams.get("market");
  const market = marketRaw && ALL_MARKETS.includes(marketRaw) ? marketRaw : null;

  const db = svc();
  let q = db.from("prediction_accuracy_daily")
    .select("day,market,model_version,n,n_graded,wins,losses,pushes," +
      "mean_confidence,mean_profit_units,mean_abs_error")
    .gte("day", from).lte("day", to)
    .order("day", { ascending: true });
  if (market) q = q.eq("market", market);
  const { data, error } = await q;
  if (error) return json({ error: error.message }, 500);

  // deno-lint-ignore no-explicit-any
  const by = new Map<string, any>();
  // deno-lint-ignore no-explicit-any
  for (const r of (data ?? []) as any[]) {
    const key = `${r.day}|${r.market}`;
    let e = by.get(key);
    if (!e) {
      e = {
        day: r.day, market: r.market, versions: [] as string[],
        n: 0, n_graded: 0, wins: 0, losses: 0, pushes: 0, _conf: 0, _units: 0,
        _mae: 0, _maeN: 0,
      };
      by.set(key, e);
    }
    const g = Number(r.n_graded ?? 0);
    e.n += Number(r.n ?? 0);
    e.n_graded += g;
    e.wins += Number(r.wins ?? 0);
    e.losses += Number(r.losses ?? 0);
    e.pushes += Number(r.pushes ?? 0);
    // Weighted by graded count. A version that served four calls must not pull
    // the day's mean as hard as one that served four hundred.
    e._conf += Number(r.mean_confidence ?? 0) * g;
    e._units += Number(r.mean_profit_units ?? 0) * g;
    // Only the regression markets (pitch_speed_ou, ab_pitches_ou) carry an
    // error. Weighted by graded count over the rows that have one, the same
    // rule as the trends baseline, so a null never drags the mean to zero.
    if (r.mean_abs_error != null) {
      e._mae += Number(r.mean_abs_error) * g;
      e._maeN += g;
    }
    // Which model was serving is the first question anyone asks about a day
    // whose accuracy moved, so it travels with the day rather than being
    // summed away.
    if (r.model_version && !e.versions.includes(r.model_version)) {
      e.versions.push(r.model_version);
    }
  }

  const days = [...by.values()].map((e) => {
    // Pushes leave the denominator — a push is not a loss. Same rule as
    // summarize().
    const decided = e.wins + e.losses;
    return {
      day: e.day, market: e.market, versions: e.versions,
      n: e.n, n_graded: e.n_graded,
      wins: e.wins, losses: e.losses, pushes: e.pushes,
      win_rate: decided ? Math.round((e.wins / decided) * 1000) / 1000 : null,
      mean_confidence: e.n_graded
        ? Math.round((e._conf / e.n_graded) * 10000) / 10000
        : null,
      mean_profit_units: e.n_graded
        ? Math.round((e._units / e.n_graded) * 10000) / 10000
        : null,
      mean_abs_error: e._maeN
        ? Math.round((e._mae / e._maeN) * 10000) / 10000
        : null,
      mae_n: e._maeN,
    };
  }).sort((a, b) =>
    a.day < b.day ? -1 : a.day > b.day ? 1 : a.market < b.market ? -1 : 1
  );

  return json({
    from, to,
    markets: [...new Set(days.map((d) => d.market))].sort(),
    days,
  });
}

// ── /api/trends ────────────────────────────────────────────────────────────
// Players the model has read better — or worse — than its own baseline over the
// same window, under the same filters.
//
// Reads player_prediction_daily, which is per (day, player, role, market, side)
// and kept for 90 days. The aggregation happens in Postgres rather than here:
// a 90-day window is tens of thousands of daily rows and PostgREST would have
// to page every one of them across the wire to sum six columns.
//
// The baseline travels once at the top level rather than repeated per row, for
// the same reason /accuracy sums the model_version split server-side — every
// client then draws the same comparison.
async function trends(url: URL): Promise<Response> {
  const sp = url.searchParams;
  // 90 days: the player rollup's retention. The streak below reaches back only
  // as far as the raw predictions do, which is far less.
  const { from, to } = windowParams(url, 90);
  const marketRaw = sp.get("market");
  const market = marketRaw && ALL_MARKETS.includes(marketRaw) ? marketRaw : null;
  const roleRaw = sp.get("role");
  const role = roleRaw === "pitcher" || roleRaw === "batter" ? roleRaw : null;
  const sideRaw = sp.get("side");
  const side = sideRaw === "home" || sideRaw === "away" ? sideRaw : null;
  const teamRaw = sp.get("team");
  const teamIdParam = posInt(teamRaw);
  const teamAbbr = teamIdParam ? null : safeAbbr(teamRaw);
  // The sample floor is a parameter rather than a constant so it is visible and
  // tunable, but it can never be removed: at 0 a 4-for-5 stretch outranks a
  // 60-call edge, which is the exact failure this table invites.
  const minGraded = Math.min(Math.max(posInt(sp.get("min_graded")) ?? 20, 1), 1000);
  const limit = Math.min(Math.max(posInt(sp.get("limit")) ?? 50, 1), 200);
  const orderRaw = sp.get("order");
  const order = orderRaw === "units" || orderRaw === "win_rate" ? orderRaw : "edge";

  const db = svc();

  // There is no teams table, so an abbreviation is resolved through the
  // schedule. A filter naming a team that played no game in the window selects
  // nothing — answering it from the unfiltered table would be a wrong answer
  // rather than an empty one.
  let teamId = teamIdParam;
  if (!teamId && teamAbbr) {
    const { data } = await db.from("games")
      .select("home_team_id,home_abbr,away_team_id,away_abbr")
      .or(`home_abbr.eq.${teamAbbr},away_abbr.eq.${teamAbbr}`)
      .limit(1);
    const g = (data ?? [])[0];
    if (g) teamId = g.home_abbr === teamAbbr ? g.home_team_id : g.away_team_id;
    if (!teamId) {
      return json({
        from, to,
        filters: { market, role, side, team: teamAbbr, min_graded: minGraded, order },
        baseline: null, streak_horizon_days: STREAK_DAYS, players: [],
      });
    }
  }

  const args = {
    p_from: from, p_to: to, p_market: market, p_role: role,
    p_side: side, p_team_id: teamId ?? null,
  };
  const [{ data: rows, error: e1 }, { data: baseRows, error: e2 }] = await Promise.all([
    db.rpc("player_trends", {
      ...args, p_min_graded: minGraded, p_limit: limit, p_order: order,
    }),
    db.rpc("player_trends_baseline", args),
  ]);
  if (e1) return json({ error: e1.message }, 500);
  if (e2) return json({ error: e2.message }, 500);

  // deno-lint-ignore no-explicit-any
  const list: any[] = rows ?? [];
  // deno-lint-ignore no-explicit-any
  const baseline: any = (baseRows ?? [])[0] ?? null;
  const baseRate = baseline?.win_rate != null ? Number(baseline.win_rate) : null;

  // Streaks, only for the players about to be returned. Asked for the whole
  // table this would fan every prediction out to both participants; bounded to
  // a page it is an at_bats probe.
  const streakBy = new Map<string, number>();
  const streakFloor = isoDate(new Date(Date.now() - (STREAK_DAYS - 1) * DAY_MS));
  const streakFrom = from > streakFloor ? from : streakFloor;
  const ids = [...new Set(list.map((r) => r.player_id))].slice(0, STREAK_MAX_PLAYERS);
  // Non-fatal, and reported rather than swallowed: a streak is one column of
  // this panel, so losing it must not lose the ranking — but a silent null is
  // indistinguishable from "no settled calls", which is a different claim.
  // Same treatment /coverage gives its per-pitch block.
  let streaksError: string | null = null;
  if (ids.length) {
    const { data: st, error: e3 } = await db.rpc("player_streaks", {
      p_from: streakFrom, p_to: to, p_player_ids: ids,
    });
    if (e3) streaksError = e3.message;
    // deno-lint-ignore no-explicit-any
    for (const r of (st ?? []) as any[]) {
      streakBy.set(`${r.player_id}:${r.role}`, Number(r.streak));
    }
  }

  // team_id -> abbreviation, from the same schedule rows.
  const abbrBy = new Map<number, string>();
  const teamIds = [...new Set(list.map((r) => r.team_id).filter(Boolean))];
  if (teamIds.length) {
    const { data: gs } = await db.from("games")
      .select("home_team_id,home_abbr,away_team_id,away_abbr")
      .gte("official_date", from).lte("official_date", to);
    // deno-lint-ignore no-explicit-any
    for (const g of (gs ?? []) as any[]) {
      if (g.home_team_id && g.home_abbr) abbrBy.set(g.home_team_id, g.home_abbr);
      if (g.away_team_id && g.away_abbr) abbrBy.set(g.away_team_id, g.away_abbr);
    }
  }

  const num = (v: unknown) => (v == null ? null : Number(v));
  const players = list.map((r) => {
    const rate = num(r.win_rate);
    const split = (graded: unknown, wins: unknown, rt: unknown) => ({
      n_graded: Number(graded ?? 0), wins: Number(wins ?? 0), win_rate: num(rt),
    });
    return {
      player_id: r.player_id,
      name: r.name ?? null,
      role: r.role,
      team_id: r.team_id ?? null,
      team: r.team_id != null ? abbrBy.get(r.team_id) ?? null : null,
      n: Number(r.n ?? 0),
      n_graded: Number(r.n_graded ?? 0),
      wins: Number(r.wins ?? 0),
      losses: Number(r.losses ?? 0),
      pushes: Number(r.pushes ?? 0),
      win_rate: rate,
      // Percentage POINTS against the window baseline, not a ratio: "+11.4 pt"
      // is the number the panel shows and the one a reader can add back.
      edge_pt: rate != null && baseRate != null
        ? Math.round((rate - baseRate) * 1000) / 10
        : null,
      profit_units: num(r.profit_units),
      mean_abs_error: num(r.mean_abs_error),
      // null, not 0: a player with no settled call in the streak horizon has no
      // streak, which is not the same as a streak of length zero.
      streak: streakBy.has(`${r.player_id}:${r.role}`)
        ? streakBy.get(`${r.player_id}:${r.role}`)
        : null,
      splits: {
        home: split(r.home_graded, r.home_wins, r.home_win_rate),
        away: split(r.away_graded, r.away_wins, r.away_win_rate),
      },
    };
  });

  return json({
    from, to,
    filters: {
      market, role, side, team: teamAbbr ?? teamId ?? null,
      min_graded: minGraded, order,
    },
    baseline: baseline
      ? {
        n_graded: Number(baseline.n_graded ?? 0),
        wins: Number(baseline.wins ?? 0),
        losses: Number(baseline.losses ?? 0),
        win_rate: num(baseline.win_rate),
        profit_units: num(baseline.profit_units),
      }
      : null,
    // How far back a streak can see. The daily rollup keeps 90 days but the raw
    // calls it would have to order are pruned at 21, so a streak is null past
    // this rather than silently truncated at the horizon.
    streak_horizon_days: STREAK_DAYS,
    streaks_error: streaksError,
    // The split cannot cover rows rolled up before side existed as a column.
    // Named here so a client can say so instead of showing a short split as if
    // it were the whole record.
    split_from: SIDE_FROM,
    players,
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

// Every prediction made for one day's slate, per pitch, paginated.
//
// This is what makes the Data Feed the same for everybody. It used to be built
// in the browser from whatever pitches that tab happened to observe, so the
// table depended on when you opened the page.
async function pitches(url: URL): Promise<Response> {
  const sp = url.searchParams;
  // Comma-separated, and every name is validated against the known markets —
  // an unrecognised one is dropped rather than passed through to the query.
  const markets = (sp.get("market") ?? "")
    .split(",").map((m) => m.trim()).filter((m) => ALL_MARKETS.includes(m));
  try {
    return json(await pitchFeed(svc(), {
      date: parseDate(sp.get("date")) ?? mlbToday(),
      gamePk: posInt(sp.get("game_pk")),
      markets,
      status: sp.get("status"),
      cursor: Number(sp.get("cursor")) > 0 ? Number(sp.get("cursor")) : 0,
      limit: Math.min(posInt(sp.get("limit")) ?? DEFAULT_LIMIT, MAX_LIMIT),
    }));
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
}

async function board(url: URL): Promise<Response> {
  // An explicit ?date= is a history request and is served as asked. With none,
  // the board is the slate: today, or the next day with games.
  const asked = parseDate(url.searchParams.get("date"));
  const slate = asked
    ? { date: asked, isToday: asked === mlbToday() }
    : await resolveSlate(svc());
  const date = slate.date;
  const [payloads, recap] = await Promise.all([slatePayloads(date), recapFor(date)]);
  return json({
    date,
    is_today: slate.isToday,
    recap,
    live: payloads.filter((p) => p.phase === "live"),
    upcoming: payloads.filter((p) => p.phase === "pregame"),
    final: payloads.filter((p) => p.phase === "final"),
  });
}

// Context for one game: the nightly boxscore row when the warehouse has
// published it, otherwise MLB's own pregame readings (weather is posted before
// first pitch, the umpire crew once assigned) — the warehouse only ever covers
// FINISHED games, which left every pill a reader opens today blank. Plus the
// park's home-run factor, which is per venue-season and always available.
async function gameContextFull(pk: number): Promise<Record<string, unknown>> {
  const db = svc();
  const [ctx, { data: g }] = await Promise.all([
    aggs.gameContext(db, pk),
    db.from("games").select("venue_id,venue_name,season").eq("game_pk", pk).maybeSingle(),
  ]);
  const out: Record<string, any> = { ...ctx.data, found: ctx.found, source: ctx.found ? "boxscore" : null };
  if (ctx.found && out.roof_closed == null && out.weather_condition != null) {
    out.roof_closed = isRoofClosed(out.weather_condition);
  }
  if (!ctx.found) {
    try {
      const c = await getGameConditions(pk);
      if (c && (c.weather_condition != null || c.hp_umpire != null)) {
        Object.assign(out, c, { found: true, source: "schedule" });
      }
    } catch (_e) { /* MLB unreachable: the warehouse answer (absent) stands */ }
  }
  const venueId = out.venue_id ?? g?.venue_id ?? null;
  if (venueId != null) {
    let q = db.from("park_hr_factors").select("season,hr_factor").eq("venue_id", venueId);
    if (g?.season != null) q = q.lte("season", g.season);
    const { data: pf } = await q.order("season", { ascending: false }).limit(1);
    out.park_hr_factor = pf?.[0]?.hr_factor != null ? Number(pf[0].hr_factor) : null;
    out.park_hr_factor_season = pf?.[0]?.season ?? null;
  }
  out.venue_name = out.venue_name ?? g?.venue_name ?? null;
  return out;
}

async function winProb(pk: number): Promise<Record<string, unknown>> {
  const db = svc();
  const [{ data: rows }, { data: pre }, { data: firsts }] = await Promise.all([
    db.from("predictions").select("id,at_bat_index,probs")
      .eq("game_pk", pk).eq("market", "game_moneyline").order("id").limit(3000),
    db.from("game_predictions").select("probs")
      .eq("game_pk", pk).eq("market", "game_moneyline").eq("phase", "pregame").limit(1),
    db.from("pitches").select("at_bat_index,inning,top_inning")
      .eq("game_pk", pk).eq("pitch_number", 1),
  ]);
  const innings = new Map<number, { inning: number | null; top_inning: boolean | null }>();
  for (const f of firsts ?? []) innings.set(f.at_bat_index, { inning: f.inning, top_inning: f.top_inning });
  const p0: any = pre?.[0]?.probs ?? null;
  return {
    game_pk: pk,
    pregame_home: p0?.home != null ? Number(p0.home) : p0?.away != null ? 1 - Number(p0.away) : null,
    points: winProbSeries(rows ?? [], innings),
  };
}

// A team's next game (or the one in progress), for a reader whose team is not
// on the slate being shown.
async function teamNext(abbr: string): Promise<Record<string, unknown>> {
  const since = new Date(Date.now() - 5 * 3600_000).toISOString();
  const { data } = await svc().from("games")
    .select("game_pk,official_date,start_ts,status,away_abbr,home_abbr,venue_name")
    .or(`home_abbr.eq.${abbr},away_abbr.eq.${abbr}`)
    .gte("start_ts", since).order("start_ts").limit(1);
  const g = (data ?? [])[0] ?? null;
  return { team: abbr, found: g != null, game: g };
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
      // 200 even when absent: a 404 logged a browser console error on every
      // load during a live game, and `cached()` only memoises 200s.
      return await hit(`game/${pk}/context`, TTL["game/context"],
        async () => json(await gameContextFull(pk)));
    }

    const wm = route.match(/^game\/(\d+)\/winprob$/);
    if (wm) {
      const pk = Number(wm[1]);
      return await hit(`game/${pk}/winprob`, TTL["game/winprob"], async () => json(await winProb(pk)));
    }

    const tm = route.match(/^team\/([A-Za-z]{2,3})\/next$/);
    if (tm) {
      const abbr = tm[1].toUpperCase();
      return await hit(`team/${abbr}/next`, TTL["team/next"], async () => json(await teamNext(abbr)));
    }
    switch (route) {
      case "health": case "": return await hit(route, TTL[route] ?? 0, health);
      case "games": return await hit("games", TTL["games"], games);
      case "live": return await hit("live", TTL["live"], live);
      case "board": return await hit("board", TTL["board"], () => board(url));
      case "feed": return await hit("feed", TTL["feed"], () => feed(url));
      case "coverage": return await hit("coverage", TTL["coverage"], () => coverage(url));
      case "accuracy": return await hit("accuracy", TTL["accuracy"], () => accuracy(url));
      case "trends": return await hit("trends", TTL["trends"], () => trends(url));
      case "pitches": return await hit("pitches", TTL["pitches"], () => pitches(url));
      case "picks/today": return await hit("picks/today", TTL["picks/today"], picksToday);
      case "odds/today": return await hit("odds/today", TTL["odds/today"], oddsToday);
      case "projections":
        return await hit(`projections:${url.search}`, TTL["projections"], () => projections(url));
      case "graded": return await hit("graded", TTL["graded"], () => graded(url));
      case "graded/summary":
        return await hit("graded/summary", TTL["graded/summary"], () => gradedSummary(url));
      case "graded/venues": return await hit("graded/venues", TTL["graded/venues"], gradedVenues);
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
