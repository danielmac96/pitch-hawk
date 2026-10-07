// Per-player game lines from the official MLB boxscore.
//
// Why the boxscore and not our own at_bats: three of the player markets ask
// about things at_bats cannot say. Runs scored (H+R+RBI) belong to whoever
// crossed the plate, not to the batter at the plate; outs recorded include
// pickoffs and caught stealing; earned runs need the official scorer's
// earned/unearned call and inherited-runner attribution. The boxscore carries
// all three as the official record, which is also what any sportsbook grades
// a prop against.
//
// warehouse/mlb.py flattens the same payload for training labels
// (`flatten_player_box`), so the number a model is fitted on and the number it
// is graded on come from one source.

export interface BatterBox {
  pa: number; ab: number; h: number; r: number; rbi: number;
  hr: number; tb: number; bb: number; k: number; hbp: number;
  /** 1-9 for a starter, null for a substitute or a pitcher who never batted. */
  slot: number | null;
}

export interface PitcherBox {
  bf: number; outs: number; h: number; bb: number; k: number;
  er: number; r: number; hr: number; pitches: number; started: boolean;
}

export interface BoxLines {
  batters: Map<number, BatterBox>;
  pitchers: Map<number, PitcherBox>;
}

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/**
 * battingOrder is "100" for the leadoff starter, "101" for the first
 * substitute in that slot, and so on. Only a "?00" value is a starter.
 */
export function starterSlot(order: unknown): number | null {
  const s = String(order ?? "");
  if (!/^\d{3}$/.test(s) || !s.endsWith("00")) return null;
  const slot = Number(s[0]);
  return slot >= 1 && slot <= 9 ? slot : null;
}

export function parseBoxscore(box: any): BoxLines {
  const batters = new Map<number, BatterBox>();
  const pitchers = new Map<number, PitcherBox>();
  for (const side of ["home", "away"]) {
    const players = box?.teams?.[side]?.players ?? {};
    for (const p of Object.values(players) as any[]) {
      const id = Number(p?.person?.id);
      if (!Number.isFinite(id)) continue;
      const bat = p?.stats?.batting ?? {};
      const pit = p?.stats?.pitching ?? {};
      if (Object.keys(bat).length) {
        batters.set(id, {
          pa: n(bat.plateAppearances), ab: n(bat.atBats), h: n(bat.hits),
          r: n(bat.runs), rbi: n(bat.rbi), hr: n(bat.homeRuns),
          // baseOnBalls already includes intentional walks.
          tb: n(bat.totalBases), bb: n(bat.baseOnBalls),
          k: n(bat.strikeOuts), hbp: n(bat.hitByPitch),
          slot: starterSlot(p?.battingOrder),
        });
      }
      if (Object.keys(pit).length && n(pit.battersFaced) + n(pit.outs) > 0) {
        pitchers.set(id, {
          bf: n(pit.battersFaced), outs: n(pit.outs), h: n(pit.hits),
          bb: n(pit.baseOnBalls), k: n(pit.strikeOuts), er: n(pit.earnedRuns),
          r: n(pit.runs), hr: n(pit.homeRuns), pitches: n(pit.numberOfPitches),
          started: n(pit.gamesStarted) > 0,
        });
      }
    }
  }
  return { batters, pitchers };
}
