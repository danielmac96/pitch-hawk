// Per-pitch graded prediction history — the durable replacement for the
// Data Feed's in-browser log.
//
// Until 2026-08-08 the Data Feed built its graded table client-side: it walked
// each /live poll, graded the pitches it saw, and pushed them onto a
// `gradedLog` array capped at 400 entries. That meant two users watching the
// same slate saw different tables, a refresh wiped it, and anyone arriving at
// 21:00 saw nothing from the 13:00 games. The predictions had been made and
// graded on the server all along — nothing served them.
//
// This does. One shared, paginated view of every prediction for a day.
//
// Lives outside index.ts because index.ts calls Deno.serve() at module level,
// so importing it to test a handler would start a server. Same arrangement as
// _shared/aggregates.ts.

// deno-lint-ignore no-explicit-any
type Db = any;

// A full slate is ~11,000 prediction rows, so this is always paginated.
export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 1000;

export interface PitchFeedParams {
  date: string;
  gamePk?: number | null;
  /**
   * Zero or more markets. A page of 300 unfiltered rows measured only 138
   * per-pitch rows on 2026-08-06 — the rest are at-bat and game level and get
   * discarded by the caller. Filtering server-side stops us shipping them.
   */
  markets?: string[] | null;
  /** 'graded' drops rows still pending a result. */
  status?: string | null;
  cursor?: number;
  limit?: number;
}

export interface PitchFeedRow {
  id: number;
  game_pk: number;
  game_label: string | null;
  at_bat_index: number | null;
  pitch_number: number | null;
  market: string;
  recommendation: string | null;
  predicted_value: number | null;
  line: number | null;
  confidence: number | null;
  result: string | null;
  actual_value: number | null;
  actual_label: string | null;
  error: number | null;
  profit_units: number | null;
  pitcher_id: number | null;
  pitcher_name: string | null;
  batter_id: number | null;
  batter_name: string | null;
  /** The situation the prediction was made INTO — see the pitch join below. */
  inning: number | null;
  half: string | null;
  count: string | null;
  outs: number | null;
  /** What was actually thrown next, where the pitch is known. */
  actual_pitch_type: string | null;
  model_version: string | null;
  created_at: string | null;
  graded_at: string | null;
}

const num = (v: unknown): number | null =>
  v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v);

/**
 * Every prediction made for one day's slate, newest first.
 *
 * `predictions` carries no date column, so the day is resolved through
 * `games.official_date` — the same join the R2 export uses, and for the same
 * reason: a prediction written at 23:30 ET belongs to that night's slate but
 * carries the next day's UTC timestamp.
 */
export async function pitchFeed(
  db: Db, p: PitchFeedParams,
): Promise<{
  date: string;
  rows: PitchFeedRow[];
  next_cursor: number | null;
  summary: Record<string, unknown>;
}> {
  const limit = Math.min(Math.max(p.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const cursor = Math.max(p.cursor ?? 0, 0);

  const { data: gameRows } = await db.from("games")
    .select("game_pk,home_abbr,away_abbr,home_team,away_team")
    .eq("official_date", p.date);
  const slate = gameRows ?? [];
  const empty = {
    date: p.date, rows: [], next_cursor: null,
    summary: { n: 0, graded: 0, wins: 0, losses: 0, pushes: 0, games: 0 },
  };
  if (!slate.length) return empty;

  // deno-lint-ignore no-explicit-any
  const labelBy = new Map<number, string>(slate.map((g: any) => [
    g.game_pk,
    `${g.away_abbr ?? g.away_team ?? "Away"} @ ${g.home_abbr ?? g.home_team ?? "Home"}`,
  ]));

  // deno-lint-ignore no-explicit-any
  let pks = slate.map((g: any) => g.game_pk);
  if (p.gamePk) {
    // A game_pk not on this date has no rows on this date. Returning empty is
    // correct and avoids leaking another day's predictions through the filter.
    if (!pks.includes(p.gamePk)) return empty;
    pks = [p.gamePk];
  }

  let q = db.from("predictions")
    .select("id,game_pk,at_bat_index,pitch_number,market,recommendation," +
      "predicted_value,line,confidence,result,actual_value,actual_label," +
      "profit_units,model_version,created_at,graded_at")
    .in("game_pk", pks)
    .order("id", { ascending: false })
    .range(cursor, cursor + limit - 1);
  if (p.markets && p.markets.length) q = q.in("market", p.markets);
  if (p.status === "graded") q = q.not("result", "is", null);

  const { data: predRows, error } = await q;
  if (error) throw new Error(error.message);
  const preds = predRows ?? [];
  if (!preds.length) {
    return { ...empty, summary: { ...empty.summary, games: slate.length } };
  }

  // Identity comes from at_bats: `predictions` stores no player ids, and the
  // feed is unreadable without "who was pitching to whom". Scoped to the
  // at-bats this page actually references rather than the whole day.
  const abKeys = [...new Set(
    preds.filter((r: PitchFeedRow) => r.at_bat_index != null)
      .map((r: PitchFeedRow) => `${r.game_pk}:${r.at_bat_index}`),
  )];
  // deno-lint-ignore no-explicit-any
  let abRows: any[] = [];
  if (abKeys.length) {
    const { data } = await db.from("at_bats")
      .select("game_pk,at_bat_index,pitcher_id,batter_id")
      .in("game_pk", [...new Set(preds.map((r: PitchFeedRow) => r.game_pk))]);
    abRows = data ?? [];
  }
  const abBy = new Map<string, { pitcher_id: number; batter_id: number }>(
    // deno-lint-ignore no-explicit-any
    abRows.map((a: any) => [`${a.game_pk}:${a.at_bat_index}`, a]),
  );

  const playerIds = [...new Set(
    abRows.flatMap((a) => [a.pitcher_id, a.batter_id]).filter(Boolean),
  )];
  // deno-lint-ignore no-explicit-any
  let playerRows: any[] = [];
  if (playerIds.length) {
    const { data } = await db.from("player_info")
      .select("player_id,full_name").in("player_id", playerIds);
    playerRows = data ?? [];
  }
  const nameBy = new Map<number, string>(
    // deno-lint-ignore no-explicit-any
    playerRows.map((r: any) => [r.player_id, r.full_name]),
  );

  // Situation, from `pitches`. Two different rows are involved and conflating
  // them would misreport the model:
  //
  //   (at_bat_index, pitch_number)      the pitch ALREADY thrown. Supabase
  //                                     stores balls/strikes post-pitch, so
  //                                     this row's count is the one the
  //                                     pitcher faced for the next pitch —
  //                                     i.e. the situation predicted INTO.
  //   (at_bat_index, pitch_number + 1)  the pitch actually thrown next, which
  //                                     is what the prediction was about.
  //
  // Scoped to the at-bats on this page, not the whole day.
  const abIdx = [...new Set(
    preds.map((r: PitchFeedRow) => r.at_bat_index).filter((v: number | null) => v != null),
  )];
  // deno-lint-ignore no-explicit-any
  let pitchRows: any[] = [];
  if (abIdx.length) {
    const { data } = await db.from("pitches")
      .select("game_pk,at_bat_index,pitch_number,balls,strikes,outs,inning," +
        "top_inning,pitch_type")
      .in("game_pk", [...new Set(preds.map((r: PitchFeedRow) => r.game_pk))])
      .in("at_bat_index", abIdx)
      .limit(MAX_LIMIT * 4);
    pitchRows = data ?? [];
  }
  const pitchBy = new Map<string, Record<string, number | string | boolean>>(
    // deno-lint-ignore no-explicit-any
    pitchRows.map((p: any) => [`${p.game_pk}:${p.at_bat_index}:${p.pitch_number}`, p]),
  );

  const rows: PitchFeedRow[] = preds.map((r: PitchFeedRow) => {
    const ab = abBy.get(`${r.game_pk}:${r.at_bat_index}`);
    const predicted = num(r.predicted_value);
    const actual = num(r.actual_value);
    // deno-lint-ignore no-explicit-any
    const at: any = pitchBy.get(`${r.game_pk}:${r.at_bat_index}:${r.pitch_number}`);
    // deno-lint-ignore no-explicit-any
    const next: any = pitchBy.get(
      `${r.game_pk}:${r.at_bat_index}:${(r.pitch_number ?? 0) + 1}`,
    );
    return {
      id: r.id,
      game_pk: r.game_pk,
      game_label: labelBy.get(r.game_pk) ?? null,
      at_bat_index: r.at_bat_index,
      pitch_number: r.pitch_number,
      market: r.market,
      recommendation: r.recommendation,
      predicted_value: predicted,
      line: num(r.line),
      confidence: num(r.confidence),
      result: r.result ?? null,
      actual_value: actual,
      actual_label: r.actual_label ?? null,
      // Signed miss, computed once here so every client renders it the same
      // way. Null whenever either side is absent — including for rows graded
      // before 20260808000002, which have no actual at all.
      error: predicted != null && actual != null
        ? Math.round((predicted - actual) * 100) / 100
        : null,
      profit_units: num(r.profit_units),
      pitcher_id: ab?.pitcher_id ?? null,
      pitcher_name: ab?.pitcher_id ? nameBy.get(ab.pitcher_id) ?? null : null,
      batter_id: ab?.batter_id ?? null,
      batter_name: ab?.batter_id ? nameBy.get(ab.batter_id) ?? null : null,
      inning: at?.inning ?? null,
      half: at ? (at.top_inning ? "▲" : "▼") : null,
      // Null, never "0-0", when the pitch is unknown: a fabricated count reads
      // as a real one.
      count: at ? `${at.balls ?? 0}-${at.strikes ?? 0}` : null,
      outs: at?.outs ?? null,
      actual_pitch_type: next?.pitch_type ?? null,
      model_version: r.model_version ?? null,
      created_at: r.created_at ?? null,
      graded_at: r.graded_at ?? null,
    };
  });

  // A short page means the end of the range; a full one may not, so the cursor
  // advances and the client asks again.
  const next = rows.length === limit ? cursor + limit : null;

  const graded = rows.filter((r) => r.result != null);
  return {
    date: p.date,
    rows,
    next_cursor: next,
    summary: {
      n: rows.length,
      graded: graded.length,
      wins: graded.filter((r) => r.result === "win").length,
      losses: graded.filter((r) => r.result === "loss").length,
      pushes: graded.filter((r) => r.result === "push").length,
      games: slate.length,
    },
  };
}
