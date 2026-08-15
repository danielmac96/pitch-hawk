// Which pitch positions in an at-bat still need a prediction, and the count
// each one was faced with.
//
// A prediction is a call made INTO a position: position k means "k pitches
// have been thrown in this plate appearance, here is the call on the next
// one". Until 2026-08-14 live-poll wrote exactly one batch per poll, at
// whatever position the state happened to be sitting on when it ran. The poll
// is every 30 seconds and pitches are routinely 15-20 apart, so any time two
// landed inside one interval the intermediate position was ingested into
// `pitches` and never scored. Nothing surfaced it: coverage is measured per
// game and per market, never per pitch.
//
// The play-by-play carries the whole at-bat, so the missed positions are
// reconstructable. This is the pure part of that reconstruction; it lives here
// rather than in live-poll/index.ts because that module calls Deno.serve() at
// import time, so a test that imported it would start a server. Same
// arrangement as _shared/pitchfeed.ts and _shared/aggregates.ts.

/** A pitch already thrown in the at-bat, as stored. */
export interface AbPitch {
  pitch_number?: number | null;
  /** Balls AFTER this pitch — see `countInto` below. */
  balls?: number | null;
  /** Strikes AFTER this pitch. */
  strikes?: number | null;
}

/** A pitch anywhere in the game, for the cross-at-bat sweep below. */
export interface GamePitch extends AbPitch {
  at_bat_index?: number | null;
  pitcher_id?: number | null;
  batter_id?: number | null;
}

export interface PitchPosition {
  /** Pitches thrown before the one being predicted. */
  k: number;
  balls: number;
  strikes: number;
}

export interface PositionParams {
  /** Pitches of the at-bat being scored, any order. */
  abPitches: AbPitch[];
  /** Pitches thrown so far, from the in-progress play. */
  curK: number;
  /** Positions in this at-bat that already carry a prediction. */
  done: Set<number>;
  /** Live count at `curK`, which currentPlay reports authoritatively. */
  curBalls?: number | null;
  curStrikes?: number | null;
  /**
   * How far back to reconstruct. Bounds the work when a game is picked up
   * after an outage; a plate appearance never legitimately runs past 20.
   */
  cap?: number;
}

const int = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * The count a pitcher faced going into position `k`.
 *
 * MLB — and this schema after it — stores balls/strikes POST-pitch, so the
 * count left by pitch number `k` is exactly the count faced going into
 * position `k`. Pitch numbers are 1-based, positions are 0-based, which is why
 * these line up without an offset. Position 0 is always 0-0.
 *
 * The same join backs the Data Feed's situation columns (_shared/pitchfeed.ts),
 * deliberately: a call and the situation it was made into must agree across
 * both surfaces or the model's record is unreadable.
 */
export function countInto(abPitches: AbPitch[], k: number): { balls: number; strikes: number } {
  if (k <= 0) return { balls: 0, strikes: 0 };
  const prior = abPitches.find((p) => int(p.pitch_number, -1) === k);
  return { balls: int(prior?.balls), strikes: int(prior?.strikes) };
}

/**
 * Every position from `curK` back to the cap that has no prediction yet,
 * oldest first so rows land in the order the pitches did.
 *
 * Returns the live position too when it is unscored, so the caller has one
 * list rather than a special case. An empty result means everything this
 * at-bat needs is already stored — the poll ran with nothing new to do.
 */
export function pendingPositions(p: PositionParams): PitchPosition[] {
  const cap = p.cap ?? 20;
  const curK = Math.max(int(p.curK), 0);
  const out: PitchPosition[] = [];
  for (let k = Math.max(curK - cap, 0); k <= curK; k += 1) {
    if (p.done.has(k)) continue;
    // currentPlay is authoritative for the live position; earlier ones are
    // reconstructed from the pitch that produced them.
    out.push(k === curK && (p.curBalls != null || p.curStrikes != null)
      ? { k, balls: int(p.curBalls), strikes: int(p.curStrikes) }
      : { k, ...countInto(p.abPitches, k) });
  }
  return out;
}

/** One at-bat's outstanding work. */
export interface AtBatWork {
  at_bat_index: number;
  pitcher_id: number | null;
  batter_id: number | null;
  /** True for the plate appearance still in progress. */
  open: boolean;
  positions: PitchPosition[];
}

export interface SweepParams {
  /** Every pitch of the game, any order. */
  pitches: GamePitch[];
  /** The at-bat still in progress, or null when the last play is complete. */
  openAbi?: number | null;
  /** Live count in the open at-bat, which currentPlay reports authoritatively. */
  openBalls?: number | null;
  openStrikes?: number | null;
  /** Positions already stored, keyed `at_bat_index:k`. */
  done: Set<string>;
  /**
   * How many at-bats back to sweep, counting from the newest. Bounds the work
   * per poll; anything older is the backfill's job, not the poller's.
   */
  lookback?: number;
  /** Per-at-bat position cap, passed through to pendingPositions. */
  cap?: number;
}

/** Key for a position in `SweepParams.done`. */
export const posKey = (abi: number, k: number) => `${abi}:${k}`;

/**
 * Outstanding positions across the recent at-bats, oldest at-bat first.
 *
 * pendingPositions() alone only ever looked at the at-bat currently batting,
 * and live-poll skipped the poll entirely when the last play was complete. Two
 * holes survived that:
 *
 *   - A plate appearance's LAST position. It is only reachable while the PA is
 *     live, so it needs a poll landing between the second-to-last and last
 *     pitch. On 2026-08-14 38.8% of last positions had no call — and last
 *     positions are 22.6% of all of them.
 *   - A plate appearance that began and ended between two polls. Nothing ever
 *     looked at it again, so all of its positions stayed empty: 93 at-bats on
 *     2026-08-14 carried no prediction at all.
 *
 * A completed at-bat is scored to `pitchCount - 1`, not `pitchCount`: every
 * position must be a call about a pitch that was actually thrown, and a
 * completed PA has no next pitch. The open at-bat keeps its forward position,
 * which is the live read the board displays.
 */
export function pendingAtBats(p: SweepParams): AtBatWork[] {
  const lookback = p.lookback ?? 4;
  const byAb = new Map<number, GamePitch[]>();
  for (const pitch of p.pitches) {
    const abi = Number(pitch.at_bat_index);
    if (!Number.isFinite(abi) || pitch.pitch_number == null) continue;
    const arr = byAb.get(abi);
    if (arr) arr.push(pitch);
    else byAb.set(abi, [pitch]);
  }

  // The open at-bat may have no pitches yet: MLB posts the next play (count
  // 0-0, new matchup) before its first pitch, and that is exactly when the
  // first-pitch call for the new batter is supposed to be made.
  if (p.openAbi != null && !byAb.has(p.openAbi)) byAb.set(p.openAbi, []);

  const newest = Math.max(...[...byAb.keys()], p.openAbi ?? -1);
  const out: AtBatWork[] = [];

  for (const abi of [...byAb.keys()].sort((a, b) => a - b)) {
    if (abi <= newest - lookback) continue;
    const abPitches = byAb.get(abi)!;
    const open = p.openAbi != null && abi === p.openAbi;
    // An open PA is scored through its forward position; a finished one stops
    // at the last pitch it actually threw.
    const curK = open ? abPitches.length : abPitches.length - 1;
    if (curK < 0) continue;

    const done = new Set<number>();
    for (let k = 0; k <= curK; k += 1) if (p.done.has(posKey(abi, k))) done.add(k);

    const positions = pendingPositions({
      abPitches,
      curK,
      done,
      // The live count is only authoritative for the at-bat actually batting.
      curBalls: open ? p.openBalls : null,
      curStrikes: open ? p.openStrikes : null,
      cap: p.cap,
    });
    if (!positions.length) continue;

    const first = abPitches.find((x) => Number(x.pitch_number) === 1) ?? abPitches[0];
    out.push({
      at_bat_index: abi,
      pitcher_id: first?.pitcher_id ?? null,
      batter_id: first?.batter_id ?? null,
      open,
      positions,
    });
  }
  return out;
}
