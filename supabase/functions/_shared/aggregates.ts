// Read handlers for the Phase 4 display aggregates.
//
// These live outside index.ts on purpose: index.ts calls Deno.serve() at
// module level, so importing it to test a handler would start a server. Each
// function here takes a db client and returns a plain object, which makes it
// directly testable against a stub (see tests/aggregates_test.ts) while
// index.ts keeps ownership of caching, CORS and status codes.
//
// All seven tables are rebuilt nightly by `python -m warehouse publish` and
// carry `updated_at`; /api/health reports their freshness. Nothing here is on
// the live-scoring path — a warehouse outage must degrade a display panel and
// never a prediction.

// deno-lint-ignore no-explicit-any
type Db = any;

export type Found<T> = { found: boolean; data: T };

/** Ordered so the UI can render career → season → d30 without re-sorting. */
const SCOPE_ORDER: Record<string, number> = { career: 0, season: 1, d30: 2 };

// deno-lint-ignore no-explicit-any
function byScope(rows: any[]): any[] {
  return [...(rows ?? [])].sort(
    (a, b) => (SCOPE_ORDER[a.scope] ?? 9) - (SCOPE_ORDER[b.scope] ?? 9),
  );
}

/**
 * Profiles for one player id, from both sides.
 *
 * A player id can legitimately appear in both tables — two-way players, and
 * pitchers who take a plate appearance — so this returns both rather than
 * guessing a role from the id.
 */
export async function playerProfile(db: Db, playerId: number) {
  const [{ data: pitcher }, { data: batter }] = await Promise.all([
    db.from("pitcher_profiles").select("*").eq("player_id", playerId),
    db.from("batter_profiles").select("*").eq("player_id", playerId),
  ]);
  const p = byScope(pitcher ?? []);
  const b = byScope(batter ?? []);
  return {
    found: p.length > 0 || b.length > 0,
    data: { player_id: playerId, pitcher: p, batter: b },
  };
}

/** Base-state x platoon splits, both roles. */
export async function playerSplits(db: Db, playerId: number) {
  const { data } = await db.from("situational_splits").select("*")
    .eq("player_id", playerId)
    .order("role", { ascending: true })
    .order("men_on_base", { ascending: true });
  const rows = data ?? [];
  return {
    found: rows.length > 0,
    data: { player_id: playerId, splits: rows },
  };
}

/**
 * The pitcher's TYPICAL in-game decay curve.
 *
 * Deliberately only half the fatigue story: the current game's trend is
 * computed live from the 35-day hot `pitches` table. That split is why no
 * per-game pitcher log was reinstated after the Phase 3 prune.
 */
export async function playerFatigue(db: Db, pitcherId: number) {
  const { data } = await db.from("pitcher_fatigue_profile").select("*")
    .eq("pitcher_id", pitcherId)
    .order("pitch_bucket", { ascending: true });
  const rows = data ?? [];
  return {
    found: rows.length > 0,
    data: { pitcher_id: pitcherId, buckets: rows },
  };
}

/**
 * Head-to-head history for one pitcher/batter pair.
 *
 * Absent is the common case, not an error: the published table applies a
 * >= 3 PA floor, so most pairs simply are not in it. The frontend renders
 * "no meaningful history" rather than an error for found=false.
 */
export async function matchup(db: Db, pitcherId: number, batterId: number) {
  const { data } = await db.from("matchup_history").select("*")
    .eq("pitcher_id", pitcherId).eq("batter_id", batterId).limit(1);
  const row = (data ?? [])[0] ?? null;
  return {
    found: row !== null,
    data: row ?? { pitcher_id: pitcherId, batter_id: batterId, pa_count: 0 },
  };
}

/** Umpire, park, weather and attendance for one game. */
export async function gameContext(db: Db, gamePk: number) {
  const { data } = await db.from("game_context").select("*")
    .eq("game_pk", gamePk).limit(1);
  const row = (data ?? [])[0] ?? null;
  return { found: row !== null, data: row ?? { game_pk: gamePk } };
}
