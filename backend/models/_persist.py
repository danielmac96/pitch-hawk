"""Shared helpers for collapsing prediction shapes and writing to the audit log."""

from __future__ import annotations

from backend.db.client import get_client


def current_pa_position(game_pk: int) -> tuple[int | None, int | None]:
    rows = (
        get_client().table("pitches")
        .select("at_bat_index,pitch_number")
        .eq("game_pk", game_pk)
        .order("at_bat_index", desc=True)
        .order("pitch_number", desc=True)
        .limit(1)
        .execute().data
    )
    if not rows:
        return None, None
    return rows[0]["at_bat_index"], rows[0]["pitch_number"]


def insert_predictions(
    game_pk: int,
    at_bat_index: int | None,
    pitch_number: int | None,
    markets: list[dict],
) -> None:
    """markets: odds-joined rows from backend.models.market_rows.build_markets.

    Persists the full prediction — including the probability distribution
    (`probs`) and the recommendation/line/price snapshot used to make the
    pick — so it can be backtested and graded later, not just a scalar
    collapse of the argmax outcome.
    """
    rows = []
    for m in markets:
        rows.append({
            "game_pk": game_pk,
            "at_bat_index": at_bat_index,
            "pitch_number": pitch_number,
            "market": m["market"],
            "predicted_value": m.get("predicted_value"),
            "confidence": m.get("confidence"),
            "probs": m.get("probs"),
            "recommendation": m.get("recommendation"),
            "line": m.get("line"),
            "price": m.get("price"),
            "edge": m.get("edge"),
            "model_version": m["model_version"],
        })
    get_client().table("predictions").insert(rows).execute()
