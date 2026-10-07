// Per-at-bat win-probability history for one game, for the board's sparkline.
//
// live-poll writes a `game_moneyline` prediction for every at-bat it scores
// (the MLB live win probability, model_version mlb_winprob_v1), so the history
// has been in `predictions` all along. A position can be scored more than once
// (a re-poll, a backfill), so the LAST row per at-bat is the one kept — the
// same newest-wins rule /live uses for the current at-bat.

export interface WinProbPoint {
  abi: number;
  inning: number | null;
  half: "▲" | "▼" | null;
  home: number;
}

export function winProbSeries(
  rows: { id: number; at_bat_index: number | null; probs: Record<string, unknown> | null }[],
  innings: Map<number, { inning: number | null; top_inning: boolean | null }>,
): WinProbPoint[] {
  const byAb = new Map<number, { id: number; home: number }>();
  for (const r of rows) {
    if (r.at_bat_index == null || !r.probs) continue;
    const h = r.probs.home != null ? Number(r.probs.home)
      : r.probs.away != null ? 1 - Number(r.probs.away) : NaN;
    if (!Number.isFinite(h)) continue;
    const prev = byAb.get(r.at_bat_index);
    if (!prev || r.id > prev.id) byAb.set(r.at_bat_index, { id: r.id, home: h });
  }
  return [...byAb.entries()]
    .sort(([a], [b]) => a - b)
    .map(([abi, v]) => {
      const inn = innings.get(abi);
      return {
        abi,
        inning: inn?.inning ?? null,
        half: inn?.top_inning == null ? null : inn.top_inning ? "▲" : "▼",
        home: Math.round(v.home * 10000) / 10000,
      };
    });
}
