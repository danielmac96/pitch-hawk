// De-vigging a two-sided quote, and the name normalisation player props need
// to resolve a sportsbook's spelling to an MLB id.
//
// Extracted from odds-ingest when player props landed. Both are pure and both
// got subtly harder in ways worth testing directly: the grouping key gained a
// player, and the complementary pair stopped being derivable from the market
// name. odds-ingest/index.ts is a Deno.serve entry point, so importing it to
// test a helper would start a server.

export function round4(v: number | null | undefined): number | null {
  return v == null ? null : Math.round(v * 10000) / 10000;
}

// Complementary outcome pairs, tried in order. Derived from the outcomes
// actually present rather than from the market name.
//
// The previous version branched on `market === "game_total" ? over/under :
// home/away`. Player props are over/under and are NOT `game_total`, so under
// that rule every prop group went looking for "home" and "away", found
// neither, and silently kept the vig.
export const NOVIG_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["over", "under"],
  ["home", "away"],
];

export interface NovigRow {
  game_pk?: number | null;
  market?: string | null;
  source?: string | null;
  outcome?: string | null;
  player_id?: number | null;
  implied_prob?: number | null;
  novig_prob?: number | null;
}

/**
 * Normalise each complete two-sided pair so the book's margin comes out.
 * Mutates the rows. Single-sided quotes keep `novig = implied`.
 */
export function applyNovig(rows: NovigRow[]): void {
  const groups = new Map<string, NovigRow[]>();
  for (const r of rows) {
    // player_id is part of the key. Without it every batter's over and under
    // in one game+market+source share a group, and the de-vig would pair one
    // player's over with a DIFFERENT player's under -- two unrelated prices
    // normalised against each other, producing a confident and meaningless
    // number. Null for the game-level markets, which leaves their grouping
    // exactly as it was.
    const k = `${r.game_pk}:${r.market}:${r.source}:${r.player_id ?? ""}`;
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }

  for (const grp of groups.values()) {
    let done = false;
    for (const [x, y] of NOVIG_PAIRS) {
      const a = grp.find((r) => r.outcome === x && r.implied_prob != null);
      const b = grp.find((r) => r.outcome === y && r.implied_prob != null);
      if (!a || !b) continue;
      const s = Number(a.implied_prob) + Number(b.implied_prob);
      if (s > 0) {
        a.novig_prob = round4(Number(a.implied_prob) / s);
        b.novig_prob = round4(Number(b.implied_prob) / s);
        done = true;
      }
      break;
    }
    if (done) continue;
    // Single-sided: keep the vig rather than invent the other side.
    for (const r of grp) if (r.implied_prob != null) r.novig_prob = r.implied_prob;
  }
}

/**
 * "José Ramírez Jr." -> "jose ramirez jr".
 *
 * Accents, punctuation and case all differ between MLB's roster and a
 * sportsbook's copy of a name, and none of them carry identity.
 */
export function normalizeName(v: unknown): string {
  return String(v ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Build a normalised-name -> player_id index.
 *
 * A duplicate normalised name is genuinely ambiguous, so the first id wins and
 * the collision is reported. Guessing between two players is worse than
 * dropping the line: a prop attributed to the wrong player is not a missing
 * row, it is a wrong one.
 */
export function indexPlayersByName(
  people: Array<{ player_id: number; full_name: string | null }>,
): { byName: Map<string, number>; collisions: string[] } {
  const byName = new Map<string, number>();
  const collisions: string[] = [];
  for (const p of people) {
    const k = normalizeName(p.full_name);
    if (!k) continue;
    if (byName.has(k)) collisions.push(k);
    else byName.set(k, p.player_id);
  }
  return { byName, collisions };
}
