"""Shared helpers for collapsing prediction shapes and writing to the audit log."""

from __future__ import annotations

from backend.db.client import get_client


def scalar(pred: dict) -> tuple[float, float]:
    """Collapse a market-specific prediction into (predicted_value, confidence).

    The predictions table stores one scalar per row; probabilistic markets are
    collapsed to argmax probability for the audit-log entry.
    """
    if "predicted_mph" in pred:
        return float(pred["predicted_mph"]), float(pred["confidence"])
    if "predicted_count" in pred:
        return float(pred["predicted_count"]), float(pred["confidence"])
    if "probs" in pred:
        m = max(pred["probs"].values())
        return float(m), float(pred.get("confidence", m))
    raise ValueError(f"unknown prediction shape: {pred}")


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
    preds: list[dict],
) -> None:
    rows = []
    for p in preds:
        v, c = scalar(p)
        rows.append({
            "game_pk": game_pk,
            "at_bat_index": at_bat_index,
            "pitch_number": pitch_number,
            "market": p["market"],
            "predicted_value": v,
            "confidence": c,
            "model_version": p["model_version"],
        })
    get_client().table("predictions").insert(rows).execute()
