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
