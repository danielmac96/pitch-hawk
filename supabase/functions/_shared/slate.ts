// The slate the board shows: today, or the next day with games.
//
// A thin wrapper over the `slate_date()` SQL function (migration
// 20261002000002), which the game-predict cron gate also reads -- one
// definition, so the API and the scorer can never disagree about which slate
// is "the" slate.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { mlbToday } from "./mlb.ts";

export interface Slate {
  date: string;      // YYYY-MM-DD, America/New_York
  isToday: boolean;  // false = today has no games and this is the next slate
}

// Falls back to today on any error. Showing today's (possibly empty) slate is
// the old behaviour; a resolver failure must never hide a day that has games.
export async function resolveSlate(db: SupabaseClient): Promise<Slate> {
  const today = mlbToday();
  try {
    const { data, error } = await db.rpc("slate_date", { p_today: today });
    const row = Array.isArray(data) ? data[0] : data;
    if (error || !row?.slate) return { date: today, isToday: true };
    return { date: String(row.slate), isToday: !!row.is_today };
  } catch (_e) {
    return { date: today, isToday: true };
  }
}
