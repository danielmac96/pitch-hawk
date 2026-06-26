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

from backend.ingestion.vocab import (
    CALL_CODE_TO_DESCRIPTION,
    ab_result_category,
    result_category,
)

load_dotenv()

MLB_API_BASE = os.environ.get("MLB_API_BASE", "https://statsapi.mlb.com/api/v1")
LIVE_STATUSES = {"In Progress", "Live"}

_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            base_url=MLB_API_BASE,
            timeout=10.0,
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=20),
        )
    return _client


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
        "result_category": result_category(description),
        "balls": count.get("balls"),
        "strikes": count.get("strikes"),
        "outs": count.get("outs"),
        "inning": about.get("inning"),
        "top_inning": about.get("isTopInning"),
        "pitch_ts": event.get("startTime"),
        "raw_json": event,
    }


def _flatten_at_bat_result(game_pk: int, play: dict) -> dict | None:
    """A completed-at-bat row, or None if this play hasn't ended yet.

    `play.result.eventType` is only populated once the at-bat is over, so
    this doubles as the "is this AB complete" check the live poller needs to
    grade ab_result/ab_pitches_ou predictions without waiting for a Savant
    backfill.
    """
    result = play.get("result") or {}
    event_type = result.get("eventType")
    if not event_type:
        return None
    about = play.get("about") or {}
    matchup = play.get("matchup") or {}
    pitch_events = [e for e in play.get("playEvents") or [] if e.get("type") == "pitch"]
    return {
        "game_pk": game_pk,
        "at_bat_index": about.get("atBatIndex"),
        "pitcher_id": (matchup.get("pitcher") or {}).get("id"),
        "batter_id": (matchup.get("batter") or {}).get("id"),
        "pitch_count": len(pitch_events),
        "result": ab_result_category(event_type),
        "result_detail": event_type,
        "start_ts": pitch_events[0].get("startTime") if pitch_events else None,
        "end_ts": pitch_events[-1].get("startTime") if pitch_events else None,
    }


async def get_live_games() -> list[dict]:
    r = await _get_client().get(
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
    r = await _get_client().get(f"/game/{game_pk}/linescore")
    r.raise_for_status()
    return r.json()


async def get_play_by_play_with_at_bats(game_pk: int) -> tuple[list[dict], list[dict]]:
    """Pitches + completed at-bats from a single playByPlay fetch.

    Used by the live poller so at_bats gets populated as games progress,
    instead of only ever via the historical Savant backfill — needed so
    ab_result/ab_pitches_ou predictions can be graded same-day.
    """
    r = await _get_client().get(f"/game/{game_pk}/playByPlay")
    r.raise_for_status()
    data = r.json()
    pitches: list[dict] = []
    at_bats: list[dict] = []
    for play in data.get("allPlays", []):
        for event in play.get("playEvents", []):
            if event.get("type") != "pitch":
                continue
            pitches.append(_flatten_pitch(game_pk, play, event))
        ab = _flatten_at_bat_result(game_pk, play)
        if ab is not None:
            at_bats.append(ab)
    return pitches, at_bats


async def get_play_by_play(game_pk: int) -> list[dict]:
    pitches, _ = await get_play_by_play_with_at_bats(game_pk)
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
