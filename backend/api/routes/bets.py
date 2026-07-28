"""Affiliate 'Bet this' endpoints.

GET  /sportsbooks   — affiliate-resolved book list + compliance disclaimer

POST /track/click was removed in 2026-07 along with the `bet_clicks` table
(migration 20260728000001). The funnel recorded zero rows over its lifetime —
no affiliate deals exist to negotiate on, and the frontend never called it.
"""

from __future__ import annotations

from fastapi import APIRouter

from backend.ingestion.sportsbooks import registry

router = APIRouter(tags=["bets"])


@router.get("/sportsbooks")
async def get_sportsbooks() -> dict:
    return registry()
