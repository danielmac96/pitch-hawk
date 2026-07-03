// Shared game-ingestion helpers used by backfill, daily-ingest and live-poll.

import { svc, upsertChunked } from "./db.ts";
import { fetchPlayers, GameRow, getPlayByPlay } from "./mlb.ts";

export interface IngestResult {
  game_pk: number;
  pitches: number;
  at_bats: number;
}

// Fetch + upsert one game's play-by-play. Safe to re-run (conflict keys).
export async function ingestGame(gamePk: number): Promise<IngestResult> {
  const { pitches, atBats } = await getPlayByPlay(gamePk);
  const pitchRows = pitches.filter((p) => p.at_bat_index != null && p.pitch_number != null);
  await upsertChunked("pitches", pitchRows as any, "game_pk,at_bat_index,pitch_number");
  const abRows = atBats.filter((a) => a.at_bat_index != null);
  await upsertChunked("at_bats", abRows as any, "game_pk,at_bat_index");
  return { game_pk: gamePk, pitches: pitchRows.length, at_bats: abRows.length };
}

export async function upsertGames(rows: GameRow[]): Promise<number> {
  if (!rows.length) return 0;
  return await upsertChunked("games", rows as any, "game_pk");
}

// Upsert player_info for ids we haven't stored yet.
export async function ensurePlayers(ids: number[]): Promise<number> {
  const uniq = [...new Set(ids.filter((x) => x != null))];
  if (!uniq.length) return 0;
  const { data } = await svc().from("player_info").select("player_id").in("player_id", uniq);
  const have = new Set((data ?? []).map((r: any) => r.player_id));
  const missing = uniq.filter((id) => !have.has(id));
  if (!missing.length) return 0;
  const rows = await fetchPlayers(missing);
  if (rows.length) await upsertChunked("player_info", rows, "player_id");
  return rows.length;
}
