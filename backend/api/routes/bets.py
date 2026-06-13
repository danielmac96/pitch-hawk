"""Affiliate 'Bet this' endpoints.

GET  /sportsbooks   — affiliate-resolved book list + compliance disclaimer
POST /track/click   — log a bet-CTA click (fire-and-forget; the funnel data that
                      affiliate deals are negotiated and optimized on)

The click write degrades gracefully: it never blocks the response and never
raises if Supabase or the bet_clicks table is unavailable — it just logs.
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter
from pydantic import BaseModel

from backend.db.client import get_client
from backend.ingestion.sportsbooks import registry

router = APIRouter(tags=["bets"])

# Strong refs so fire-and-forget click writes aren't GC'd mid-flight.
_BG_TASKS: set[asyncio.Task] = set()


class ClickIn(BaseModel):
    game_pk: int | None = None
    market: str | None = None
    side: str | None = None
    book: str | None = None
    edge: float | None = None
    affiliate_configured: bool | None = None


@router.get("/sportsbooks")
async def get_sportsbooks() -> dict:
    return registry()


def _insert_click(row: dict) -> None:
    get_client().table("bet_clicks").insert(row).execute()


async def _track_async(row: dict) -> None:
    try:
        await asyncio.to_thread(_insert_click, row)
    except Exception as exc:
        # Table may not exist yet, or Supabase may be down — never fatal.
        print(f"[bets] click track failed: {exc}")


@router.post("/track/click")
async def track_click(click: ClickIn) -> dict:
    row = click.model_dump()
    task = asyncio.create_task(_track_async(row))
    _BG_TASKS.add(task)
    task.add_done_callback(_BG_TASKS.discard)
    return {"ok": True}
