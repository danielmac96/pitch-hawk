// v3 slate scoring: ratings + active model rows -> every pregame player and
// game market, through props.ts.
//
// Used by game-predict when the v3 rows are active (pa_outcome, workload,
// team_runs). With any of them missing it returns null and game-predict keeps
// its previous formulas, so promoting v3 is a model_params change, not a
// redeploy, and rolling it back is the same.
//
// Inputs are read from `model_ratings` (published nightly by
// `python -m modeling publish-ratings` with the active pa_outcome row's own
// rating hyperparameters). An id with no ratings row -- a debut, a call-up --
// reads as the league prior, which is exactly what training saw for a player
// with no history.

import { svc } from "./db.ts";
import {
  batterDists, batterMarkets, batterValue, type Bundle, convolve, gameMarkets,
  negbinPmf, overProb, paPmf, starterMarkets, type StarterProp, tempC, teamMu,
  type Vec, windOut, workload,
} from "./props.ts";

/** P(total runs > line) from the two team-run distributions. */
export function totalOver(muHome: number, muAway: number, alpha: number, line: number): number {
  return overProb(convolve(negbinPmf(muHome, alpha, 30), negbinPmf(muAway, alpha, 30)), line);
}

/** Days since 2015-01-01 -- modeling/ratings.day_index. */
export function dayIndex(isoDate: string): number {
  return Math.round((Date.parse(`${isoDate}T00:00:00Z`) - Date.parse("2015-01-01T00:00:00Z")) / 86_400_000);
}

export function v3Bundle(models: Record<string, any>): Bundle | null {
  const pa = models["pa_outcome"], wl = models["workload"], tr = models["team_runs"];
  if (pa?.type !== "pa_multinomial" || wl?.type !== "workload" || tr?.type !== "team_runs") {
    return null;
  }
  return models as Bundle;
}

interface RatingRow { kind: string; id: number; c: Vec; n: number; extra: Record<string, any> }

export interface Ratings {
  L: Vec;
  get(kind: "bat" | "pit" | "pen", id: number | null | undefined): Vec;
  park(venueId: number | null | undefined): Vec;
  extra(kind: string, id: number | null | undefined): Record<string, any>;
}

const PARK_NEUTRAL: Vec = [1, 1, 1, 1, 1, 1, 1];

export async function loadRatings(
  ids: { bat: number[]; pit: number[]; teams: number[]; venues: number[] },
): Promise<Ratings | null> {
  const db = svc();
  const want: Array<[string, number[]]> = [
    ["league", [0]], ["bat", ids.bat], ["pit", ids.pit], ["pen", ids.teams],
    ["team", ids.teams], ["park", ids.venues],
  ];
  const rows: RatingRow[] = [];
  await Promise.all(want.map(async ([kind, list]) => {
    const uniq = [...new Set(list.filter((v) => v != null))];
    for (let i = 0; i < uniq.length; i += 300) {
      const { data, error } = await db.from("model_ratings")
        .select("kind,id,n_eff,c0,c1,c2,c3,c4,c5,c6,extra")
        .eq("kind", kind).in("id", uniq.slice(i, i + 300));
      if (error) throw new Error(`model_ratings: ${error.message}`);
      for (const r of data ?? []) {
        rows.push({
          kind: r.kind, id: Number(r.id), n: Number(r.n_eff ?? 0), extra: r.extra ?? {},
          c: [r.c0, r.c1, r.c2, r.c3, r.c4, r.c5, r.c6].map((v: any) => v == null ? NaN : Number(v)),
        });
      }
    }
  }));
  const by = new Map(rows.map((r) => [`${r.kind}:${r.id}`, r]));
  const league = by.get("league:0");
  if (!league) return null;
  const L = league.c;
  return {
    L,
    get: (kind, id) => {
      const r = id == null ? undefined : by.get(`${kind}:${id}`);
      return r && r.c.every(Number.isFinite) ? r.c : L;
    },
    park: (venueId) => {
      const r = venueId == null ? undefined : by.get(`park:${venueId}`);
      return r && r.c.every(Number.isFinite) ? r.c : PARK_NEUTRAL;
    },
    extra: (kind, id) => (id == null ? {} : by.get(`${kind}:${id}`)?.extra ?? {}),
  };
}

/**
 * Each team's most recent batting order we scored, for games whose lineup is
 * not posted yet. The game markets need a lineup to build team offence from;
 * yesterday's order is a far better guess than nine league-average hitters.
 */
export async function lastLineups(teamIds: number[], before: string): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>();
  if (!teamIds.length) return out;
  const { data } = await svc().from("player_game_projections")
    .select("team_id,game_pk,official_date,lineup_slot,player_id")
    .in("team_id", teamIds).eq("market", "batter_hit").not("lineup_slot", "is", null)
    .lt("official_date", before).order("official_date", { ascending: false }).limit(2000);
  const latest = new Map<number, number>();
  for (const r of data ?? []) {
    if (!latest.has(r.team_id)) latest.set(r.team_id, r.game_pk);
  }
  for (const [team, pk] of latest) {
    const rows = (data ?? []).filter((r: any) => r.team_id === team && r.game_pk === pk)
      .sort((a: any, b: any) => a.lineup_slot - b.lineup_slot);
    if (rows.length === 9) out.set(team, rows.map((r: any) => r.player_id));
  }
  return out;
}

export interface SideInputs {
  teamId: number;
  lineup: number[];          // nine ids in batting order
  posted: boolean;           // a real posted lineup (batter props are only published then)
  starterId: number | null;  // THIS side's starter (pitches to the other side)
}

export interface GameInputs {
  gamePk: number; dayIndex: number; venueId: number | null;
  home: SideInputs; away: SideInputs;
  temp_f: number | null; wind_mph: number | null; wind_direction: string | null;
  roof_closed: boolean;
  batSide: (id: number) => string;
  pitchHand: (id: number | null) => string;
}

export interface BatterOut {
  player_id: number; slot: number; is_home: boolean; team_id: number; opp_team: number;
  opp_sp: number | null; probs: Record<string, number>; expected_pa: number; e_tb: number;
  /** Mean per-PA hit / HR probability over his expected trips (live rest-of-game input). */
  per_pa: { batter_hit: number; batter_hr: number };
}

function perPa(d: Vec[], pmf: Vec): { batter_hit: number; batter_hr: number } {
  let tail = 0, w = 0, h = 0, hr = 0;
  const surv = new Array(pmf.length).fill(0);
  for (let i = pmf.length - 1; i >= 0; i--) { tail += pmf[i]; surv[i] = tail; }
  for (let i = 1; i < pmf.length; i++) {
    w += surv[i];
    h += surv[i] * (d[i - 1][2] + d[i - 1][3] + d[i - 1][4] + d[i - 1][5]);
    hr += surv[i] * d[i - 1][5];
  }
  return w > 0 ? { batter_hit: h / w, batter_hr: hr / w } : { batter_hit: 0, batter_hr: 0 };
}

export interface GameOut {
  mu_home: number; mu_away: number; alpha: number;
  p_home: number; total_line: number; p_over: number; mu_total: number;
  batters: BatterOut[];
  starters: Array<{ player_id: number; team_id: number; opp_team: number; is_home: boolean;
                    props: Record<string, StarterProp> }>;
}

function starterWorkload(b: Bundle, r: Ratings, sp: number | null, teamId: number, day: number) {
  const ex = r.extra("pit", sp);
  const rest = ex.last_app_day != null ? day - Number(ex.last_app_day) : null;
  return workload(b, {
    own_outs: ex.p_outs_mean ?? null, pitches: ex.p_pitches_mean ?? null,
    team_leash: r.extra("team", teamId).outs_mean ?? null,
    rest_days: rest, rp: r.get("pit", sp), L: r.L,
  });
}

export function scoreGame(b: Bundle, r: Ratings, g: GameInputs): GameOut {
  const pk = r.park(g.venueId);
  const wl = {
    home: starterWorkload(b, r, g.home.starterId, g.home.teamId, g.dayIndex),
    away: starterWorkload(b, r, g.away.starterId, g.away.teamId, g.dayIndex),
  };
  const batters: BatterOut[] = [];
  const value = { home: 0, away: 0 };
  for (const side of ["home", "away"] as const) {
    const bat = g[side], opp = g[side === "home" ? "away" : "home"];
    const oppWl = wl[side === "home" ? "away" : "home"];
    const isHome = side === "home";
    const rows = bat.lineup.map((id, i) => {
      const d = batterDists(b, {
        rb: r.get("bat", id), bat_side: g.batSide(id), slot: i + 1, is_home: isHome,
        sp_r: r.get("pit", opp.starterId), sp_hand: g.pitchHand(opp.starterId),
        pen_r: r.get("pen", opp.teamId), pk, L: r.L, bf_pmf: oppWl.bf,
      });
      const pmf = paPmf(b, i + 1, isHome);
      return { id, slot: i + 1, d, pmf, v: batterValue(d, pmf) };
    });
    value[side] = rows.reduce((a, x) => a + x.v, 0);
    if (bat.posted) {
      for (const x of rows) {
        const m = batterMarkets(b, x.d, x.pmf, x.slot, value[side]);
        batters.push({
          player_id: x.id, slot: x.slot, is_home: isHome, team_id: bat.teamId,
          opp_team: opp.teamId, opp_sp: opp.starterId,
          probs: { batter_hit: m.batter_hit, batter_hr: m.batter_hr,
                   batter_tb15: m.batter_tb15, batter_hrr: m.batter_hrr },
          expected_pa: m.structural.e_pa, e_tb: m.structural.e_tb,
          per_pa: perPa(x.d, x.pmf),
        });
      }
    }
  }
  const tc = tempC(g.temp_f, g.roof_closed);
  const wo = windOut(g.wind_mph, g.wind_direction, g.roof_closed);
  const muH = teamMu(b, { value: value.home, is_home: true, temp_c: tc, wind_out: wo });
  const muA = teamMu(b, { value: value.away, is_home: false, temp_c: tc, wind_out: wo });
  const gm = gameMarkets(b, muH, muA);

  const starters: GameOut["starters"] = [];
  for (const side of ["home", "away"] as const) {
    const sp = g[side].starterId;
    if (sp == null) continue;
    const opp = g[side === "home" ? "away" : "home"];
    starters.push({
      player_id: sp, team_id: g[side].teamId, opp_team: opp.teamId, is_home: side === "home",
      props: starterMarkets(b, {
        sp_r: r.get("pit", sp), sp_hand: g.pitchHand(sp),
        lineup: opp.lineup.map((id) => [r.get("bat", id), g.batSide(id)] as [Vec, string]),
        batting_home: side !== "home", pk, L: r.L,
        outs_pmf: wl[side].outs, bf_pmf: wl[side].bf,
      }),
    });
  }
  return {
    mu_home: muH, mu_away: muA, alpha: Number(b.team_runs!.alpha), ...gm,
    batters, starters,
  };
}
