"""Stub PitchPredictor — returns dummy values to lock the API contract.

Each method returns a market-specific dict; the real model swap-in is post-MVP.
Context dict keys consumed: pitcher_id, batter_id, balls, strikes, pitch_count_pa, inning.
"""

from __future__ import annotations

from functools import lru_cache

from backend.db.client import get_client

_FALLBACK_SPEED = 92.5
_MODEL_VERSION = "stub_v0"


class PitchPredictor:
    model_version: str = _MODEL_VERSION

    def predict_pitch_speed(self, context: dict) -> dict:
        pitcher_id = context.get("pitcher_id")
        avg = _pitcher_avg_speed(pitcher_id) if pitcher_id else None
        return {
            "market": "pitch_speed_ou",
            "predicted_mph": float(avg) if avg is not None else _FALLBACK_SPEED,
            "confidence": 0.55,
            "model_version": _MODEL_VERSION,
        }

    def predict_pitch_result(self, context: dict) -> dict:
        return {
            "market": "pitch_result",
            "probs": {"strike_foul": 0.45, "ball": 0.35, "in_play": 0.20},
            "model_version": _MODEL_VERSION,
        }

    def predict_at_bat_result(self, context: dict) -> dict:
        return {
            "market": "ab_result",
            "probs": {"strikeout": 0.22, "walk": 0.09, "hit": 0.24, "out": 0.45},
            "model_version": _MODEL_VERSION,
        }

    def predict_at_bat_pitches(self, context: dict) -> dict:
        return {
            "market": "ab_pitches_ou",
            "predicted_count": 3.8,
            "confidence": 0.52,
            "model_version": _MODEL_VERSION,
        }


@lru_cache(maxsize=1024)
def _pitcher_avg_speed(pitcher_id: int) -> float | None:
    """Average start_speed for a pitcher across all pitches table rows.

    Returns None if pitcher has no rows; caller falls back to _FALLBACK_SPEED.
    """
    rows = (
        get_client()
        .table("pitches")
        .select("start_speed")
        .eq("pitcher_id", pitcher_id)
        .limit(2000)
        .execute()
        .data
    )
    speeds = [r["start_speed"] for r in rows if r.get("start_speed") is not None]
    if not speeds:
        return None
    return sum(speeds) / len(speeds)
