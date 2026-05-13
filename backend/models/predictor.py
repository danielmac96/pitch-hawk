"""Frequency-blended PitchPredictor (freq_v1).

For each rate/value, blends pitcher historical with league average via a
sample-size-weighted mix: w = 0.85 * (1 - exp(-n / 500)). Adds small additive
count-situation deltas (3-0 grooves, 0-2 nibbles, etc.) and reports
sample_size + confidence so the frontend can flag low-data predictions.
"""

from __future__ import annotations

import math

from backend.models.stats_cache import (
    LEAGUE_AB_RESULT,
    LEAGUE_AVG_PITCHES_PA,
    LEAGUE_AVG_SPEED,
    LEAGUE_PITCH_RESULT,
    get_cache,
)

_MODEL_VERSION = "freq_v1"


def _blend_weight(n: int) -> float:
    return 0.85 * (1.0 - math.exp(-n / 500.0))


def _confidence(n: int, k: float) -> float:
    return 0.50 + 0.32 * (1.0 - math.exp(-n / k))


def _blend(pitcher_val: float, league_val: float, n: int) -> float:
    w = _blend_weight(n)
    return pitcher_val * w + league_val * (1.0 - w)


def _normalize(probs: dict[str, float]) -> dict[str, float]:
    total = sum(probs.values())
    if total <= 0:
        return probs
    return {k: v / total for k, v in probs.items()}


def _count_key(context: dict) -> tuple[int, int]:
    return (int(context.get("balls") or 0), int(context.get("strikes") or 0))


# Additive mph deltas per (balls, strikes).
_SPEED_DELTAS = {
    (3, 0): 0.3,
    (0, 2): -0.4,
    (1, 2): -0.2,
}

# Additive probability deltas for pitch_result per (balls, strikes). Applied
# before renormalization. Missing categories default to 0.
_PITCH_RESULT_DELTAS = {
    (3, 0): {"ball": 0.08, "strike_foul": -0.05, "in_play": -0.03},
    (3, 1): {"ball": 0.04, "strike_foul": -0.02, "in_play": -0.02},
    (0, 2): {"strike_foul": 0.10, "ball": -0.07, "in_play": -0.03},
    (1, 2): {"strike_foul": 0.06, "ball": -0.04, "in_play": -0.02},
    (2, 2): {"strike_foul": 0.03, "ball": -0.02, "in_play": -0.01},
}

# Additive probability deltas for ab_result per (balls, strikes).
_AB_RESULT_DELTAS = {
    (0, 2): {"strikeout": 0.08, "hit": -0.04, "out": -0.04},
    (1, 2): {"strikeout": 0.05, "hit": -0.025, "out": -0.025},
    (3, 0): {"walk": 0.15, "out": -0.08, "hit": -0.05, "strikeout": -0.02},
    (3, 1): {"walk": 0.08, "out": -0.04, "hit": -0.03, "strikeout": -0.01},
    (3, 2): {"strikeout": 0.04, "walk": 0.04, "out": -0.05, "hit": -0.03},
}


def _apply_delta(probs: dict[str, float], delta: dict[str, float]) -> dict[str, float]:
    out = dict(probs)
    for k, dv in delta.items():
        out[k] = max(0.0, out.get(k, 0.0) + dv)
    return _normalize(out)


class PitchPredictor:
    model_version: str = _MODEL_VERSION

    def predict_pitch_speed(self, context: dict) -> dict:
        pitcher_id = context.get("pitcher_id")
        stats = get_cache().get_pitch_stats(pitcher_id)
        n = stats.sample_pitches if stats else 0
        pitcher_speed = stats.avg_speed if stats else LEAGUE_AVG_SPEED
        blended = _blend(pitcher_speed, LEAGUE_AVG_SPEED, n)
        blended += _SPEED_DELTAS.get(_count_key(context), 0.0)
        return {
            "market": "pitch_speed_ou",
            "predicted_mph": round(float(blended), 2),
            "confidence": round(_confidence(n, k=300.0), 3),
            "sample_size": n,
            "model_version": _MODEL_VERSION,
        }

    def predict_pitch_result(self, context: dict) -> dict:
        pitcher_id = context.get("pitcher_id")
        stats = get_cache().get_pitch_stats(pitcher_id)
        n = stats.sample_pitches if stats else 0
        if stats is not None:
            probs = {
                "strike_foul": _blend(stats.strike_foul_rate, LEAGUE_PITCH_RESULT["strike_foul"], n),
                "ball":        _blend(stats.ball_rate,        LEAGUE_PITCH_RESULT["ball"],        n),
                "in_play":     _blend(stats.in_play_rate,     LEAGUE_PITCH_RESULT["in_play"],     n),
            }
        else:
            probs = dict(LEAGUE_PITCH_RESULT)
        probs = _normalize(probs)
        delta = _PITCH_RESULT_DELTAS.get(_count_key(context))
        if delta:
            probs = _apply_delta(probs, delta)
        return {
            "market": "pitch_result",
            "probs": {k: round(v, 4) for k, v in probs.items()},
            "confidence": round(_confidence(n, k=400.0), 3),
            "sample_size": n,
            "model_version": _MODEL_VERSION,
        }

    def predict_at_bat_result(self, context: dict) -> dict:
        pitcher_id = context.get("pitcher_id")
        stats = get_cache().get_ab_stats(pitcher_id)
        n = stats.sample_abs if stats else 0
        if stats is not None:
            probs = {
                "strikeout": _blend(stats.so_rate,  LEAGUE_AB_RESULT["strikeout"], n),
                "walk":      _blend(stats.bb_rate,  LEAGUE_AB_RESULT["walk"],      n),
                "hit":       _blend(stats.hit_rate, LEAGUE_AB_RESULT["hit"],       n),
                "out":       _blend(stats.out_rate, LEAGUE_AB_RESULT["out"],       n),
            }
        else:
            probs = dict(LEAGUE_AB_RESULT)
        probs = _normalize(probs)
        delta = _AB_RESULT_DELTAS.get(_count_key(context))
        if delta:
            probs = _apply_delta(probs, delta)
        return {
            "market": "ab_result",
            "probs": {k: round(v, 4) for k, v in probs.items()},
            "confidence": round(_confidence(n, k=150.0), 3),
            "sample_size": n,
            "model_version": _MODEL_VERSION,
        }

    def predict_at_bat_pitches(self, context: dict) -> dict:
        pitcher_id = context.get("pitcher_id")
        stats = get_cache().get_ab_stats(pitcher_id)
        n = stats.sample_abs if stats else 0
        pitcher_avg = stats.avg_pitches if stats else LEAGUE_AVG_PITCHES_PA
        baseline = _blend(pitcher_avg, LEAGUE_AVG_PITCHES_PA, n)
        current = int(context.get("pitch_count_pa") or 0)
        balls, strikes = _count_key(context)
        if current >= baseline:
            if balls == 3 and strikes == 2:
                remaining = 1.2
            elif strikes == 2:
                remaining = 1.3
            else:
                remaining = 1.6
            predicted = current + remaining
        else:
            predicted = baseline
        return {
            "market": "ab_pitches_ou",
            "predicted_count": round(float(predicted), 2),
            "current_pitch_count": current,
            "confidence": round(_confidence(n, k=150.0), 3),
            "sample_size": n,
            "model_version": _MODEL_VERSION,
        }
