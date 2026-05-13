"""Static player_info enrichment via MLB Stats API /people.

Fetches handedness, position, debut date for player IDs we encounter in
live polls. Batched: one /people?personIds=1,2,3 request per chunk (50 ids
max per the MLB API). Results are upserted into player_info and cached in
a module-level dict for the lifetime of the process — players don't change.
"""

from __future__ import annotations

import asyncio
from typing import Iterable

import httpx

from backend.db.client import get_client

MLB_API_BASE = "https://statsapi.mlb.com/api/v1"
_BATCH_SIZE = 50
_INTER_BATCH_SLEEP = 0.5

_player_cache: dict[int, dict] = {}


def _row_from_person(p: dict) -> dict | None:
    pid = p.get("id")
    if pid is None:
        return None
    return {
        "player_id":  int(pid),
        "full_name":  p.get("fullName"),
        "bat_side":   (p.get("batSide")  or {}).get("code"),
        "pitch_hand": (p.get("pitchHand") or {}).get("code"),
        "position":   (p.get("primaryPosition") or {}).get("abbreviation"),
        "debut_date": p.get("mlbDebutDate"),
    }


async def fetch_players_batch(player_ids: list[int]) -> list[dict]:
    if not player_ids:
        return []
    ids_csv = ",".join(str(int(i)) for i in player_ids)
    params = {"personIds": ids_csv, "hydrate": "currentTeam"}
    async with httpx.AsyncClient(base_url=MLB_API_BASE, timeout=15.0) as c:
        r = await c.get("/people", params=params)
        r.raise_for_status()
        people = r.json().get("people") or []
    rows = []
    for p in people:
        row = _row_from_person(p)
        if row is not None:
            rows.append(row)
    return rows


def _upsert_player_rows(rows: list[dict]) -> None:
    if not rows:
        return
    get_client().table("player_info").upsert(rows, on_conflict="player_id").execute()


async def ensure_players(pitcher_ids: Iterable[int], batter_ids: Iterable[int]) -> None:
    wanted: set[int] = set()
    for pid in pitcher_ids:
        if pid is not None:
            wanted.add(int(pid))
    for bid in batter_ids:
        if bid is not None:
            wanted.add(int(bid))
    missing = sorted(wanted - _player_cache.keys())
    if not missing:
        return

    for i in range(0, len(missing), _BATCH_SIZE):
        chunk = missing[i:i + _BATCH_SIZE]
        try:
            rows = await fetch_players_batch(chunk)
        except Exception as exc:
            print(f"[player_info] fetch failed for {len(chunk)} ids: {exc}")
            continue
        try:
            await asyncio.to_thread(_upsert_player_rows, rows)
        except Exception as exc:
            print(f"[player_info] upsert failed for {len(rows)} rows: {exc}")
            continue
        for row in rows:
            _player_cache[row["player_id"]] = row
        if i + _BATCH_SIZE < len(missing):
            await asyncio.sleep(_INTER_BATCH_SLEEP)
