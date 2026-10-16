// v4 in-game features: the live twin of the training frames.
//
// walkGame() carries pre-pitch state through a game's play-by-play exactly as
// warehouse/mlb.py:flatten_play_by_play does when it builds the warehouse
// the models were trained on: pre-pitch count and outs (non-pitch events
// included), pre-play score and base occupancy, the pitcher's cumulative
// pitch count, times through the order. tests/fixtures/v4_walk_golden.json
// (written by tests/modeling/test_v4_walk_golden.py from the Python
// flattener) pins it: a feature computed differently live than in training
// is a model scored on inputs it never saw.
//
// The feature builders then name every input exactly as the frames do
// (modeling/v4/micro.py, modeling/v4/frames.py), joining the live state with
// the pregame snapshot published to v4_serve_features.

export interface WalkPitch {
  at_bat_index: number;
  pitch_number: number;
  pitcher_id: number | null;
  batter_id: number | null;
  balls: number;
  strikes: number;
  outs: number;
  inning: number | null;
  top_inning: boolean | null;
  on_first: number | null;
  on_second: number | null;
  on_third: number | null;
  home_score: number;
  away_score: number;
  pitch_of_game: number | null;
  times_through_order: number | null;
  bat_side: string | null;
  pitch_hand: string | null;
  pitch_type: string | null;
  description: string | null;
  start_speed: number | null;
}

/** Pre-play state of a plate appearance, for a PA with no pitch yet. */
export interface WalkPa {
  at_bat_index: number;
  pitcher_id: number | null;
  batter_id: number | null;
  inning: number | null;
  top_inning: boolean | null;
  outs: number;
  on_first: number | null;
  on_second: number | null;
  on_third: number | null;
  home_score: number;
  away_score: number;
  times_through_order: number | null;
  bat_side: string | null;
  pitch_hand: string | null;
  pitcher_count_before: number;
}

const CALL: Record<string, string> = {
  B: "ball", "*B": "ball", I: "ball", P: "ball", V: "ball", H: "hit_by_pitch",
  C: "called_strike", A: "called_strike", S: "swinging_strike", W: "swinging_strike",
  M: "swinging_strike", Q: "swinging_strike", F: "foul", T: "foul", L: "foul", O: "foul",
  R: "foul", X: "in_play", D: "in_play", E: "in_play", J: "in_play",
};

const int = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
};

export function walkGame(allPlays: any[]): { pitches: WalkPitch[]; pas: WalkPa[] } {
  const pitches: WalkPitch[] = [];
  const pas: WalkPa[] = [];
  let home = 0, away = 0, outs = 0;
  let on1: number | null = null, on2: number | null = null, on3: number | null = null;
  let lastHalf = "";
  const pitcherCount = new Map<number, number>();
  const faced = new Map<string, number>();

  for (const play of allPlays ?? []) {
    const about = play.about ?? {}, matchup = play.matchup ?? {}, result = play.result ?? {};
    const inning = int(about.inning);
    const top = about.isTopInning ?? null;
    const half = `${inning}:${top}`;
    if (half !== lastHalf) { on1 = on2 = on3 = null; outs = 0; lastHalf = half; }
    const pitcherId = int(matchup.pitcher?.id), batterId = int(matchup.batter?.id);
    let tto: number | null = null;
    if (pitcherId != null && batterId != null) {
      const k = `${pitcherId}:${batterId}`;
      tto = (faced.get(k) ?? 0) + 1;
      faced.set(k, tto);
    }
    const preHome = home, preAway = away;
    const abi = int(about.atBatIndex) ?? -1;
    pas.push({
      at_bat_index: abi, pitcher_id: pitcherId, batter_id: batterId, inning, top_inning: top,
      outs, on_first: on1, on_second: on2, on_third: on3, home_score: preHome,
      away_score: preAway, times_through_order: tto,
      bat_side: matchup.batSide?.code ?? null, pitch_hand: matchup.pitchHand?.code ?? null,
      pitcher_count_before: pitcherId != null ? (pitcherCount.get(pitcherId) ?? 0) : 0,
    });
    let balls = 0, strikes = 0;
    for (const ev of play.playEvents ?? []) {
      if (ev.type !== "pitch") {
        const o = int(ev.count?.outs);
        if (o != null) outs = o;
        continue;
      }
      const d = ev.details ?? {}, pd = ev.pitchData ?? {};
      const code = d.call?.code;
      let desc: string | null = code ? (CALL[code] ?? null) : null;
      if (!desc) desc = String(d.description ?? "").toLowerCase().replaceAll(" ", "_") || null;
      if (pitcherId != null) pitcherCount.set(pitcherId, (pitcherCount.get(pitcherId) ?? 0) + 1);
      pitches.push({
        at_bat_index: abi, pitch_number: int(ev.pitchNumber) ?? 0,
        pitcher_id: pitcherId, batter_id: batterId, balls, strikes, outs,
        inning, top_inning: top, on_first: on1, on_second: on2, on_third: on3,
        home_score: preHome, away_score: preAway,
        pitch_of_game: pitcherId != null ? pitcherCount.get(pitcherId)! : null,
        times_through_order: tto,
        bat_side: matchup.batSide?.code ?? null, pitch_hand: matchup.pitchHand?.code ?? null,
        pitch_type: d.type?.code ?? null, description: desc,
        start_speed: pd.startSpeed != null ? Number(pd.startSpeed) : null,
      });
      balls = int(ev.count?.balls) ?? 0;
      strikes = int(ev.count?.strikes) ?? 0;
      const o = int(ev.count?.outs);
      if (o != null) outs = o;
    }
    const po = int(play.count?.outs);
    if (po != null) outs = po;
    if (result.homeScore != null) { home = int(result.homeScore) ?? 0; away = int(result.awayScore) ?? 0; }
    on1 = int(matchup.postOnFirst?.id);
    on2 = int(matchup.postOnSecond?.id);
    on3 = int(matchup.postOnThird?.id);
  }
  return { pitches, pas };
}

// ── pregame snapshot ────────────────────────────────────────────────────────

export interface Snapshot {
  pitcher: Map<number, Record<string, number | null>>;
  batter: Map<number, Record<string, number | null>>;
  game: Map<number, Record<string, number | null>>;
  batterGame: Map<string, Record<string, number | null>>;
}

/** The latest v4_serve_features rows for these subjects, as of `date`. */
export async function loadSnapshot(
  db: any, date: string,
  ids: { pitchers?: number[]; batters?: number[]; games?: number[]; batterGames?: string[] },
): Promise<Snapshot> {
  const snap: Snapshot = { pitcher: new Map(), batter: new Map(), game: new Map(), batterGame: new Map() };
  const want: Array<[string, string[], Map<any, any>, (k: string) => any]> = [
    ["pitcher", (ids.pitchers ?? []).map(String), snap.pitcher, Number],
    ["batter", (ids.batters ?? []).map(String), snap.batter, Number],
    ["game", (ids.games ?? []).map(String), snap.game, Number],
    ["batter_game", ids.batterGames ?? [], snap.batterGame, String],
  ];
  await Promise.all(want.map(async ([kind, keys, into, conv]) => {
    if (!keys.length) return;
    const { data } = await db.from("v4_serve_features").select("key,as_of,features")
      .eq("kind", kind).in("key", keys).lte("as_of", date).order("as_of", { ascending: true });
    for (const r of data ?? []) into.set(conv(r.key), r.features ?? {});
  }));
  return snap;
}

// ── features ────────────────────────────────────────────────────────────────

const FB = new Set(["FF", "FT", "SI", "FA"]);
const BR = new Set(["SL", "CU", "KC", "SV", "ST", "CS", "SC"]);
const OS = new Set(["CH", "FS", "FO", "KN", "EP"]);
const num = (v: unknown): number | null => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const bool = (v: boolean | null | undefined): number | null => (v == null ? null : v ? 1 : 0);

function bucket(balls: number, strikes: number): "ahead" | "behind" | "even" {
  return strikes > balls ? "ahead" : balls > strikes ? "behind" : "even";
}

/** The state a pitch would be thrown in: an observed pitch, or (for the open
 * position of the live PA) the PA's state carried to the live count. */
export interface PitchState {
  at_bat_index: number; pitch_number: number; balls: number; strikes: number; outs: number;
  inning: number | null; top_inning: boolean | null; on_first: number | null;
  on_second: number | null; on_third: number | null; home_score: number; away_score: number;
  pitch_of_game: number | null; times_through_order: number | null; bat_side: string | null;
  pitch_hand: string | null; pitcher_id: number | null; batter_id: number | null;
}

/** State before pitch `k + 1` of at-bat `abi` (k pitches already thrown). */
export function stateAt(
  walk: { pitches: WalkPitch[]; pas: WalkPa[] }, abi: number, k: number,
  live?: { balls: number; strikes: number; outs: number } | null,
): PitchState | null {
  const ab = walk.pitches.filter((p) => p.at_bat_index === abi)
    .sort((a, b) => a.pitch_number - b.pitch_number);
  if (k < ab.length) return { ...ab[k] };
  const pa = walk.pas.find((p) => p.at_bat_index === abi);
  if (!pa) return null;
  const last = ab[ab.length - 1];
  return {
    at_bat_index: abi, pitch_number: k + 1,
    balls: live?.balls ?? 0, strikes: live?.strikes ?? 0,
    outs: live?.outs ?? last?.outs ?? pa.outs,
    inning: pa.inning, top_inning: pa.top_inning, on_first: pa.on_first,
    on_second: pa.on_second, on_third: pa.on_third, home_score: pa.home_score,
    away_score: pa.away_score,
    pitch_of_game: (last?.pitch_of_game ?? pa.pitcher_count_before) + 1,
    times_through_order: pa.times_through_order, bat_side: pa.bat_side,
    pitch_hand: pa.pitch_hand, pitcher_id: pa.pitcher_id, batter_id: pa.batter_id,
  };
}

/** modeling/v4/micro.py PITCH_SQL + _pitch_features, for one position. */
export function pitchFeatures(
  walk: { pitches: WalkPitch[]; pas: WalkPa[] }, st: PitchState, snap: Snapshot, gamePk: number,
): Record<string, number | null> {
  const ab = walk.pitches.filter((p) => p.at_bat_index === st.at_bat_index)
    .sort((a, b) => a.pitch_number - b.pitch_number);
  const prev = ab.filter((p) => p.pitch_number < st.pitch_number).pop() ?? null;
  // Pitcher's fastballs earlier in the game (micro.py's game_fb_velo window).
  const earlier = walk.pitches.filter((p) => p.pitcher_id === st.pitcher_id &&
    p.pitch_of_game != null && st.pitch_of_game != null && p.pitch_of_game < st.pitch_of_game &&
    p.pitch_type != null && FB.has(p.pitch_type) && p.start_speed != null);
  const gameFb = earlier.length ? earlier.reduce((a, p) => a + p.start_speed!, 0) / earlier.length : null;
  const ps = (st.pitcher_id != null ? snap.pitcher.get(st.pitcher_id) : null) ?? {};
  const bd = (st.batter_id != null ? snap.batter.get(st.batter_id) : null) ?? {};
  const gm = snap.game.get(gamePk) ?? {};
  const b = bucket(st.balls, st.strikes);
  const pv = num(ps.ps_velo);
  const top = st.top_inning;
  const t = prev?.pitch_type ?? "";
  const d = prev?.description ?? "";
  return {
    balls: st.balls, strikes: st.strikes, outs: st.outs, inning: st.inning,
    top_inning: bool(top), on_1b: st.on_first != null ? 1 : 0, on_2b: st.on_second != null ? 1 : 0,
    on_3b: st.on_third != null ? 1 : 0,
    score_diff: top ? st.away_score - st.home_score : st.home_score - st.away_score,
    pitch_of_game: st.pitch_of_game, pitch_of_pa: st.pitch_number, tto: st.times_through_order,
    same_hand: st.bat_side != null && st.pitch_hand != null ? (st.bat_side === st.pitch_hand ? 1 : 0) : null,
    p_left: st.pitch_hand != null ? (st.pitch_hand === "L" ? 1 : 0) : null,
    prev_type_fb: FB.has(t) ? 1 : 0, prev_type_br: BR.has(t) ? 1 : 0, prev_type_os: OS.has(t) ? 1 : 0,
    prev_result_ball: d === "ball" ? 1 : 0,
    prev_result_strike: d === "called_strike" || d === "swinging_strike" ? 1 : 0,
    prev_result_foul: d === "foul" ? 1 : 0,
    prev_speed: prev?.start_speed ?? null,
    game_velo_delta: gameFb != null && pv != null ? gameFb - pv : null,
    p_velo: pv, p_velo_all: num(ps.ps_speed_mean), p_velo_sd: num(ps.ps_speed_sd),
    p_ff_share: num(ps.ps_ff_share), p_br_share: num(ps.ps_br_share), p_os_share: num(ps.ps_os_share),
    p_zone: num(ps.ps_zone), p_whiff: num(ps.ps_whiff), p_chase: num(ps.ps_chase),
    p_ball_rate: num(ps.ps_ball_rate), p_inplay_rate: num(ps.ps_inplay_rate), p_n: num(ps.ps_n) ?? 0,
    p_cnt_ball_rate: num(ps[`ps_${b}_ball_rate`]), p_cnt_inplay_rate: num(ps[`ps_${b}_inplay_rate`]),
    p_cnt_ff_share: num(ps[`ps_${b}_ff_share`]),
    b_swing: num(bd.bd_swing), b_whiff: num(bd.bd_whiff), b_chase: num(bd.bd_chase),
    b_inplay_rate: num(bd.bd_inplay_rate), b_ball_rate: num(bd.bd_ball_rate), b_n: num(bd.bd_n) ?? 0,
    b_cnt_swing: num(bd[`bd_${b}_swing`]),
    ump_called_strike: num(gm.ump_called_strike), day_of_season: num(gm.day_of_season),
  };
}

/** modeling/v4/micro.py PA_STATE_SQL + pa_state_season, at one count. */
export function paFeatures(st: PitchState, snap: Snapshot, gamePk: number): Record<string, number | null> {
  const ps = (st.pitcher_id != null ? snap.pitcher.get(st.pitcher_id) : null) ?? {};
  const bd = (st.batter_id != null ? snap.batter.get(st.batter_id) : null) ?? {};
  const gm = snap.game.get(gamePk) ?? {};
  const top = st.top_inning;
  return {
    balls: st.balls, strikes: st.strikes, outs: st.outs, inning: st.inning,
    on_1b: st.on_first != null ? 1 : 0, on_2b: st.on_second != null ? 1 : 0, on_3b: st.on_third != null ? 1 : 0,
    score_diff: top ? st.away_score - st.home_score : st.home_score - st.away_score,
    tto: st.times_through_order,
    same_hand: st.bat_side != null && st.pitch_hand != null ? (st.bat_side === st.pitch_hand ? 1 : 0) : null,
    p_left: st.pitch_hand != null ? (st.pitch_hand === "L" ? 1 : 0) : null,
    is_home_bat: top == null ? null : top ? 0 : 1, pitch_of_game: st.pitch_of_game,
    p_k_rate: num(ps.p_k_rate), p_bb_rate: num(ps.p_bb_rate), p_h_rate: num(ps.p_h_rate),
    p_pitches_pa: num(ps.p_pitches_pa), p_whiff: num(ps.ps_whiff), p_zone: num(ps.ps_zone),
    p_velo: num(ps.ps_velo), p_n: num(ps.ps_n) ?? 0,
    b_k_rate: num(bd.b_k_rate), b_bb_rate: num(bd.b_bb_rate), b_h_rate: num(bd.b_h_rate),
    b_pitches_pa: num(bd.b_pitches_pa), b_swing: num(bd.bd_swing), b_whiff: num(bd.bd_whiff),
    b_chase: num(bd.bd_chase), b_n: num(bd.bd_n) ?? 0,
    ump_called_strike: num(gm.ump_called_strike), day_of_season: num(gm.day_of_season),
  };
}

const TEAM_PA_PER_OUT = 38.2 / 27;

/** modeling/v4/frames.py rog_frame, for one batter at the live state. */
export function rogFeatures(
  bg: Record<string, number | null>,
  live: { inning: number; outs: number; scoreDiff: number; paSoFar: number; hitsSoFar: number;
          hrSoFar: number; spStillIn: boolean; spPitches: number | null },
): Record<string, number | null> {
  const outsLeft = Math.max((9 - live.inning + 1) * 3 - live.outs, 1);
  const rem = 1 + Math.max(outsLeft * TEAM_PA_PER_OUT - 1, 0) / 9;
  const ePa = Math.max(num(bg.e_pa) ?? 1, 1);
  const per = (s: number | null) => s == null ? null : 1 - Math.pow(1 - Math.min(Math.max(s, 1e-6), 1 - 1e-6), 1 / ePa);
  const ph = per(num(bg.s_hit)), pr = per(num(bg.s_hr));
  return {
    ...bg, pa_k: live.paSoFar + 1, inning: live.inning, outs: live.outs, score_diff: live.scoreDiff,
    hits_so_far: live.hitsSoFar, hr_so_far: live.hrSoFar, pa_so_far: live.paSoFar,
    rem_pa_base: rem, sp_still_in: live.spStillIn ? 1 : 0, sp_pitches: live.spPitches,
    rog_v3_hit: ph == null ? null : 1 - Math.pow(1 - ph, rem),
    rog_v3_hr: pr == null ? null : 1 - Math.pow(1 - pr, rem),
  };
}

/** modeling/v4/frames.py live_total_frame, at the live state. */
export function liveTotalFeatures(
  g: Record<string, number | null>,
  live: { inning: number; top: boolean; outs: number; home: number; away: number;
          homeSpIn: boolean; awaySpIn: boolean },
): Record<string, number | null> {
  // Training rows sit at the start of each half-inning; mid-inning the outs
  // already made come off the batting side's remaining outs.
  const inn = live.inning;
  const awayLeft = (live.top ? (9 - inn + 1) * 3 : (9 - inn) * 3) - (live.top ? live.outs : 0);
  const homeLeft = (9 - inn + 1) * 3 - (live.top ? 0 : live.outs);
  const muh = (num(g.v3_mu_home) ?? 0) * homeLeft / 27, mua = (num(g.v3_mu_away) ?? 0) * awayLeft / 27;
  return {
    ...g, inning: inn, top_inning: live.top ? 1 : 0, runs_now: live.home + live.away,
    home_runs_now: live.home, away_runs_now: live.away, outs_left_home: homeLeft,
    outs_left_away: awayLeft, h_sp_in: live.homeSpIn ? 1 : 0, a_sp_in: live.awaySpIn ? 1 : 0,
    live_v3_mu_rest: muh + mua,
  };
}
