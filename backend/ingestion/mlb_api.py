"""MLB Stats API client (async).

Endpoints (base: https://statsapi.mlb.com/api/v1):
  /schedule?sportId=1&gameType=R&hydrate=linescore
  /game/{game_pk}/linescore
  /game/{game_pk}/playByPlay
"""

import asyncio
import os
from typing import AsyncGenerator

import httpx
from dotenv import load_dotenv

load_dotenv()

MLB_API_BASE = os.environ.get("MLB_API_BASE", "https://statsapi.mlb.com/api/v1")
LIVE_STATUSES = {"In Progress", "Live"}

# Map MLB Stats API call codes -> Statcast-style description strings, so live and
# historical pitches share one vocabulary downstream.
CALL_CODE_TO_DESCRIPTION = {
    "B": "ball",
    "*B": "blocked_ball",
    "V": "automatic_ball",
    "I": "intent_ball",
    "P": "pitchout",
    "C": "called_strike",
    "S": "swinging_strike",
    "W": "swinging_strike_blocked",
    "M": "missed_bunt",
    "Q": "swinging_pitchout",
    "F": "foul",
    "T": "foul_tip",
    "L": "foul_bunt",
    "R": "foul_pitchout",
    "X": "hit_into_play",
    "D": "hit_into_play",
    "E": "hit_into_play",
    "H": "hit_by_pitch",
    "Z": "called_strike",
}

_STRIKE_FOUL = {
    "called_strike", "swinging_strike", "swinging_strike_blocked",
    "foul", "foul_tip", "foul_bunt", "missed_bunt",
}
_BALL = {"ball", "blocked_ball", "automatic_ball", "intent_ball"}
_IN_PLAY = {"hit_into_play"}


def _result_category(description: str | None) -> str:
    if description in _STRIKE_FOUL:
        return "strike_foul"
    if description in _BALL:
        return "ball"
    if description in _IN_PLAY:
        return "in_play"
    return "other"


def _flatten_pitch(game_pk: int, play: dict, event: dict) -> dict:
    matchup = play.get("matchup") or {}
    about = play.get("about") or {}
    details = event.get("details") or {}
    pitch_data = event.get("pitchData") or {}
    count = event.get("count") or {}
    call_code = (details.get("call") or {}).get("code")
    description = CALL_CODE_TO_DESCRIPTION.get(call_code)
    if description is None:
        raw = (details.get("description") or "").lower().replace(" ", "_")
        description = raw or None
    return {
        "game_pk": game_pk,
        "at_bat_index": about.get("atBatIndex"),
        "pitch_number": event.get("pitchNumber"),
        "pitcher_id": (matchup.get("pitcher") or {}).get("id"),
        "batter_id": (matchup.get("batter") or {}).get("id"),
        "pitch_type": (details.get("type") or {}).get("code"),
        "start_speed": pitch_data.get("startSpeed"),
        "zone": pitch_data.get("zone"),
        "description": description,
        "result_category": _result_category(description),
        "balls": count.get("balls"),
        "strikes": count.get("strikes"),
        "outs": count.get("outs"),
        "inning": about.get("inning"),
        "top_inning": about.get("isTopInning"),
        "pitch_ts": event.get("startTime"),
        "raw_json": event,
    }


async def get_live_games() -> list[dict]:
    async with httpx.AsyncClient(base_url=MLB_API_BASE, timeout=15.0) as client:
        r = await client.get(
            "/schedule",
            params={"sportId": 1, "gameType": "R", "hydrate": "linescore"},
        )
        r.raise_for_status()
        data = r.json()
    out: list[dict] = []
    for date in data.get("dates", []):
        for g in date.get("games", []):
            status = (g.get("status") or {}).get("detailedState")
            if status in LIVE_STATUSES:
                teams = g.get("teams") or {}
                out.append({
                    "game_pk": g.get("gamePk"),
                    "status": status,
                    "home_team": ((teams.get("home") or {}).get("team") or {}).get("name"),
                    "away_team": ((teams.get("away") or {}).get("team") or {}).get("name"),
                })
    return out


async def get_live_game_state(game_pk: int) -> dict:
    async with httpx.AsyncClient(base_url=MLB_API_BASE, timeout=15.0) as client:
        r = await client.get(f"/game/{game_pk}/linescore")
        r.raise_for_status()
        return r.json()


async def get_play_by_play(game_pk: int) -> list[dict]:
    async with httpx.AsyncClient(base_url=MLB_API_BASE, timeout=15.0) as client:
        r = await client.get(f"/game/{game_pk}/playByPlay")
        r.raise_for_status()
        data = r.json()
    pitches: list[dict] = []
    for play in data.get("allPlays", []):
        for event in play.get("playEvents", []):
            if event.get("type") != "pitch":
                continue
            pitches.append(_flatten_pitch(game_pk, play, event))
    return pitches


async def poll_live_game(
    game_pk: int, interval_seconds: int = 15
) -> AsyncGenerator[dict, None]:
    seen: dict[int, int] = {}  # at_bat_index -> max pitch_number seen
    while True:
        pitches = await get_play_by_play(game_pk)
        for p in pitches:
            ab = p.get("at_bat_index")
            pn = p.get("pitch_number")
            if ab is None or pn is None:
                continue
            if pn > seen.get(ab, 0):
                seen[ab] = pn
                print(
                    f"[PITCH] game={game_pk} pa={ab} p={pn} "
                    f"speed={p.get('start_speed')} desc={p.get('description')}"
                )
                yield p
        await asyncio.sleep(interval_seconds)
