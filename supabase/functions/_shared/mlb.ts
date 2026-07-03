// MLB Stats API client + row flatteners (mirrors backend/ingestion/mlb_api.py).

import { abResultCategory, CALL_CODE_TO_DESCRIPTION, resultCategory } from "./vocab.ts";

export const MLB_BASE = "https://statsapi.mlb.com/api/v1";
const LIVE_STATUSES = new Set(["In Progress", "Live", "Manager challenge"]);

export async function mlbGet(path: string, params: Record<string, string> = {}): Promise<any> {
  const url = new URL(MLB_BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`MLB ${path} -> ${r.status}`);
  return await r.json();
}

export interface GameRow {
  game_pk: number;
  official_date: string | null;
  game_type: string | null;
  season: number | null;
  status: string | null;
  home_team_id: number | null;
  home_team: string | null;
  home_abbr: string | null;
  away_team_id: number | null;
  away_team: string | null;
  away_abbr: string | null;
  venue_id: number | null;
  venue_name: string | null;
  start_ts: string | null;
  home_score: number | null;
  away_score: number | null;
  updated_at: string;
}

export function flattenScheduleGame(g: any): GameRow {
  const home = g?.teams?.home ?? {}, away = g?.teams?.away ?? {};
  return {
    game_pk: g.gamePk,
    official_date: g.officialDate ?? null,
    game_type: g.gameType ?? null,
    season: g.season ? Number(g.season) : null,
    status: g?.status?.detailedState ?? null,
    home_team_id: home?.team?.id ?? null,
    home_team: home?.team?.name ?? null,
    home_abbr: home?.team?.abbreviation ?? null,
    away_team_id: away?.team?.id ?? null,
    away_team: away?.team?.name ?? null,
    away_abbr: away?.team?.abbreviation ?? null,
    venue_id: g?.venue?.id ?? null,
    venue_name: g?.venue?.name ?? null,
    start_ts: g.gameDate ?? null,
    home_score: home?.score ?? null,
    away_score: away?.score ?? null,
    updated_at: new Date().toISOString(),
  };
}

export async function getSchedule(dateISO: string): Promise<GameRow[]> {
  const data = await mlbGet("/schedule", {
    sportId: "1", date: dateISO, hydrate: "team,linescore",
  });
  const out: GameRow[] = [];
  for (const d of data.dates ?? []) {
    for (const g of d.games ?? []) if (g.gamePk) out.push(flattenScheduleGame(g));
  }
  return out;
}

export function isLive(status: string | null | undefined): boolean {
  return !!status && LIVE_STATUSES.has(status);
}

export function isFinal(status: string | null | undefined): boolean {
  return !!status && (status.startsWith("Final") || status === "Game Over" || status === "Completed Early");
}

export interface PitchRow {
  game_pk: number;
  at_bat_index: number | null;
  pitch_number: number | null;
  pitcher_id: number | null;
  batter_id: number | null;
  pitch_type: string | null;
  start_speed: number | null;
  zone: number | null;
  description: string | null;
  result_category: string | null;
  balls: number | null;
  strikes: number | null;
  outs: number | null;
  inning: number | null;
  top_inning: boolean | null;
  pitch_ts: string | null;
}

export interface AtBatRow {
  game_pk: number;
  at_bat_index: number | null;
  pitcher_id: number | null;
  batter_id: number | null;
  pitch_count: number;
  result: string | null;
  result_detail: string | null;
  start_ts: string | null;
  end_ts: string | null;
}

function flattenPitch(gamePk: number, play: any, ev: any): PitchRow {
  const matchup = play.matchup ?? {}, about = play.about ?? {};
  const details = ev.details ?? {}, pd = ev.pitchData ?? {}, count = ev.count ?? {};
  const callCode = details?.call?.code;
  let description = callCode != null ? CALL_CODE_TO_DESCRIPTION[callCode] : undefined;
  if (!description) {
    const raw = (details.description ?? "").toLowerCase().replaceAll(" ", "_");
    description = raw || null;
  }
  return {
    game_pk: gamePk,
    at_bat_index: about.atBatIndex ?? null,
    pitch_number: ev.pitchNumber ?? null,
    pitcher_id: matchup?.pitcher?.id ?? null,
    batter_id: matchup?.batter?.id ?? null,
    pitch_type: details?.type?.code ?? null,
    start_speed: pd.startSpeed ?? null,
    zone: pd.zone ?? null,
    description: description ?? null,
    result_category: resultCategory(description),
    balls: count.balls ?? null,
    strikes: count.strikes ?? null,
    outs: count.outs ?? null,
    inning: about.inning ?? null,
    top_inning: about.isTopInning ?? null,
    pitch_ts: ev.startTime ?? null,
  };
}

export async function getPlayByPlay(gamePk: number): Promise<{ pitches: PitchRow[]; atBats: AtBatRow[] }> {
  const data = await mlbGet(`/game/${gamePk}/playByPlay`);
  const pitches: PitchRow[] = [];
  const atBats: AtBatRow[] = [];
  for (const play of data.allPlays ?? []) {
    const evs = (play.playEvents ?? []).filter((e: any) => e.type === "pitch");
    for (const ev of evs) pitches.push(flattenPitch(gamePk, play, ev));
    const eventType = play?.result?.eventType;
    if (eventType) {
      atBats.push({
        game_pk: gamePk,
        at_bat_index: play?.about?.atBatIndex ?? null,
        pitcher_id: play?.matchup?.pitcher?.id ?? null,
        batter_id: play?.matchup?.batter?.id ?? null,
        pitch_count: evs.length,
        result: abResultCategory(eventType),
        result_detail: eventType,
        start_ts: evs[0]?.startTime ?? null,
        end_ts: evs[evs.length - 1]?.startTime ?? null,
      });
    }
  }
  return { pitches, atBats };
}

export function deriveLiveState(gamePk: number, pitches: PitchRow[]): Record<string, unknown> | null {
  const indexed = pitches.filter((p) => p.at_bat_index != null);
  if (!indexed.length) return null;
  const latestAb = Math.max(...indexed.map((p) => p.at_bat_index!));
  const pa = indexed.filter((p) => p.at_bat_index === latestAb)
    .sort((a, b) => (a.pitch_number ?? 0) - (b.pitch_number ?? 0));
  const last = pa[pa.length - 1];
  return {
    game_pk: gamePk,
    status: "live",
    inning: last.inning,
    top_inning: last.top_inning,
    batter_id: last.batter_id,
    pitcher_id: last.pitcher_id,
    balls: last.balls,
    strikes: last.strikes,
    outs: last.outs,
    pitch_count_pa: pa.length,
    last_pitch_ts: last.pitch_ts,
    updated_at: new Date().toISOString(),
  };
}

// Current-PA pitch list in the shape the frontend board renders.
export function currentPaPitches(pitches: PitchRow[]): Record<string, unknown>[] {
  const indexed = pitches.filter((p) => p.at_bat_index != null);
  if (!indexed.length) return [];
  const latestAb = Math.max(...indexed.map((p) => p.at_bat_index!));
  return indexed.filter((p) => p.at_bat_index === latestAb)
    .sort((a, b) => (a.pitch_number ?? 0) - (b.pitch_number ?? 0))
    .map((p) => ({
      pitch_number: p.pitch_number, pitch_type: p.pitch_type,
      start_speed: p.start_speed, zone: p.zone, description: p.description,
      result_category: p.result_category, balls: p.balls, strikes: p.strikes,
    }));
}

export async function fetchPlayers(ids: number[]): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    try {
      const data = await mlbGet("/people", { personIds: chunk.join(",") });
      for (const p of data.people ?? []) {
        if (p.id == null) continue;
        out.push({
          player_id: p.id,
          full_name: p.fullName ?? null,
          bat_side: p?.batSide?.code ?? null,
          pitch_hand: p?.pitchHand?.code ?? null,
          position: p?.primaryPosition?.abbreviation ?? null,
          debut_date: p.mlbDebutDate ?? null,
          updated_at: new Date().toISOString(),
        });
      }
    } catch (_e) { /* enrichment only */ }
  }
  return out;
}

// Live home-team win probability (0..1) from MLB's own model, if available.
export async function liveHomeWinProb(gamePk: number): Promise<number | null> {
  try {
    const data = await mlbGet(`/game/${gamePk}/winProbability`);
    if (!Array.isArray(data) || !data.length) return null;
    const last = data[data.length - 1];
    const p = last?.homeTeamWinProbability;
    return typeof p === "number" ? p / 100 : null;
  } catch (_e) {
    return null;
  }
}
