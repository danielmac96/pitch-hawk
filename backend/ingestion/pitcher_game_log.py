"""Per-game pitcher workload tracking for fatigue features.

Called from the live poller each tick: derives pitch_count_in_game,
max/avg velocity, entry inning (is_starter) from the play-by-play
pitches list, and looks up days_rest by checking pitcher_game_log for
the most recent prior game_pk and asking the MLB schedule endpoint for
the calendar dates.
"""

from __future__ import annotations

import asyncio
from datetime import date, datetime

import httpx

from backend.db.client import get_client

MLB_API_BASE = "https://statsapi.mlb.com/api/v1"


def _most_recent_prior_game_pk(pitcher_id: int, current_game_pk: int) -> int | None:
    try:
        rows = (
            get_client().table("pitcher_game_log")
            .select("game_pk")
            .eq("pitcher_id", pitcher_id)
            .neq("game_pk", current_game_pk)
            .order("game_pk", desc=True)
            .limit(1)
            .execute().data
        )
    except Exception as exc:
        print(f"[pitcher_game_log] prior lookup failed pid={pitcher_id}: {exc}")
        return None
    if not rows:
        return None
    return rows[0].get("game_pk")


def _parse_game_date(s: str | None) -> date | None:
    if not s:
        return None
    try:
        # MLB schedule returns "officialDate": "YYYY-MM-DD" or sometimes "gameDate" ISO timestamp.
        if "T" in s:
            return datetime.fromisoformat(s.replace("Z", "+00:00")).date()
        return date.fromisoformat(s[:10])
    except Exception:
        return None


async def _fetch_game_dates(game_pks: list[int]) -> dict[int, date]:
    if not game_pks:
        return {}
    ids_csv = ",".join(str(int(g)) for g in game_pks)
    out: dict[int, date] = {}
    async with httpx.AsyncClient(base_url=MLB_API_BASE, timeout=15.0) as c:
        r = await c.get("/schedule", params={"gamePks": ids_csv, "sportId": 1})
        r.raise_for_status()
        for d in (r.json().get("dates") or []):
            for g in d.get("games") or []:
                gpk = g.get("gamePk")
                gd = _parse_game_date(g.get("officialDate") or g.get("gameDate"))
                if gpk is not None and gd is not None:
                    out[int(gpk)] = gd
    return out


async def get_days_rest(pitcher_id: int, current_game_pk: int) -> int:
    prior = await asyncio.to_thread(_most_recent_prior_game_pk, pitcher_id, current_game_pk)
    if prior is None:
        return 99
    try:
        dates = await _fetch_game_dates([prior, current_game_pk])
    except Exception as exc:
        print(f"[pitcher_game_log] schedule lookup failed pid={pitcher_id}: {exc}")
        return 99
    d_prior = dates.get(int(prior))
    d_cur = dates.get(int(current_game_pk))
    if d_prior is None or d_cur is None:
        return 99
    delta = (d_cur - d_prior).days
    return delta if delta >= 0 else 99


def _upsert_log_row(row: dict) -> None:
    get_client().table("pitcher_game_log").upsert(
        row, on_conflict="game_pk,pitcher_id",
    ).execute()


async def update_pitcher_game_log(
    game_pk: int, pitcher_id: int, pitches: list[dict],
) -> None:
    filtered = [p for p in pitches if p.get("pitcher_id") == pitcher_id]
    if not filtered:
        return
    speeds = [float(p["start_speed"]) for p in filtered if p.get("start_speed") is not None]
    innings = [int(p["inning"]) for p in filtered if p.get("inning") is not None]
    entry_inning = min(innings) if innings else None
    is_starter = entry_inning == 1 if entry_inning is not None else None
    days_rest = await get_days_rest(pitcher_id, game_pk)

    row = {
        "game_pk":             int(game_pk),
        "pitcher_id":          int(pitcher_id),
        "pitch_count_in_game": len(filtered),
        "max_velocity":        max(speeds) if speeds else None,
        "avg_velocity":        (sum(speeds) / len(speeds)) if speeds else None,
        "days_rest":           days_rest,
        "is_starter":          is_starter,
        "entry_inning":        entry_inning,
    }
    try:
        await asyncio.to_thread(_upsert_log_row, row)
    except Exception as exc:
        print(f"[pitcher_game_log] upsert failed game={game_pk} pid={pitcher_id}: {exc}")
