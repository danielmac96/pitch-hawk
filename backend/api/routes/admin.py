"""GET /admin/tables/preview — latest 10 rows, all columns, for every known
Supabase table. Read-only debugging aid for the frontend's raw data feed;
a missing/renamed table degrades to an `error` entry rather than failing
the whole response.
"""

from __future__ import annotations

from fastapi import APIRouter

from backend.db.client import get_client

router = APIRouter(prefix="/admin", tags=["admin"])

# table -> column to sort newest-first on. Falls back to unordered if the
# column doesn't exist (e.g. schema drift) so one bad guess can't 500 the rest.
_TABLES: dict[str, str] = {
    "pitches": "id",
    "at_bats": "id",
    "live_state": "updated_at",
    "odds": "fetched_at",
    "predictions": "created_at",
    "bet_clicks": "clicked_at",
    "game_context": "updated_at",
    "pitcher_game_log": "updated_at",
    "player_info": "updated_at",
    "umpire_stats": "updated_at",
    "pitcher_rolling_stats": "updated_at",
    "batter_rolling_stats": "updated_at",
    "matchup_history": "updated_at",
}


def _latest_rows(table: str, order_col: str, limit: int = 10) -> dict:
    client = get_client()
    try:
        rows = (
            client.table(table).select("*")
            .order(order_col, desc=True).limit(limit).execute().data or []
        )
    except Exception:
        try:
            rows = client.table(table).select("*").limit(limit).execute().data or []
        except Exception as exc:
            return {"error": str(exc), "columns": [], "rows": []}
    columns = list(rows[0].keys()) if rows else []
    return {"columns": columns, "rows": rows}


@router.get("/tables/preview")
async def preview_tables() -> dict:
    return {table: _latest_rows(table, col) for table, col in _TABLES.items()}
