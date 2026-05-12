"""GET /odds/{game_pk} — passthrough to odds_stub."""

from fastapi import APIRouter

from backend.ingestion.odds_stub import get_odds

router = APIRouter(prefix="/odds", tags=["odds"])


@router.get("/{game_pk}")
async def get_odds_route(game_pk: int) -> list[dict]:
    return get_odds(game_pk)
