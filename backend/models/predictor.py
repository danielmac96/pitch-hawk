"""Frequency-blended PitchPredictor (freq_v2).

Builds on freq_v1's pitcher-vs-league blend + count-situation deltas, and
layers in Phase 2 signals:
  * pitcher rolling stats (zone_rate, fastball velo, sample bump)
  * batter rolling stats (chase rate, hard-hit, k_rate)
  * per-game pitcher workload (fatigue, days_rest)
  * game context (weather; umpire branch wired but no data this phase)
  * static player_info (handedness for platoon)
  * matchup_history (pitcher x batter career rates)

Every prediction returns features_used: list[str] enumerating which data
sources actually contributed. The freq_v1 baseline must always succeed —
each new feature is wrapped so a missing or broken source degrades to the
prior behavior without crashing the prediction.
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

_MODEL_VERSION = "freq_v2"


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

_PITCH_RESULT_DELTAS = {
    (3, 0): {"ball": 0.08, "strike_foul": -0.05, "in_play": -0.03},
    (3, 1): {"ball": 0.04, "strike_foul": -0.02, "in_play": -0.02},
    (0, 2): {"strike_foul": 0.10, "ball": -0.07, "in_play": -0.03},
    (1, 2): {"strike_foul": 0.06, "ball": -0.04, "in_play": -0.02},
    (2, 2): {"strike_foul": 0.03, "ball": -0.02, "in_play": -0.01},
}

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


def _safe(fn, feature_name: str):
    """Call a no-arg fn and swallow any error after logging."""
    try:
        return fn()
    except Exception as exc:
        print(f"[predictor] {feature_name} skipped: {exc}")
        return None


def _lookup_umpire_zone_rate(umpire_id: int) -> float | None:
    """Direct query into umpire_stats. Returns None if table is empty (the
    expected state this phase) or the row is missing zone_rate."""
    from backend.db.client import get_client
    rows = (
        get_client().table("umpire_stats")
        .select("zone_rate").eq("umpire_id", int(umpire_id))
        .limit(1).execute().data
        or []
    )
    if not rows:
        return None
    zr = rows[0].get("zone_rate")
    return float(zr) if zr is not None else None


def _platoon_label(p_hand: str | None, b_side: str | None) -> str | None:
    """Return 'same' / 'opposite' / None. Switch hitters always bat opposite."""
    if not p_hand or not b_side:
        return None
    p = p_hand.upper()[:1]
    b = b_side.upper()[:1]
    if b == "S":
        return "opposite"
    if p in ("L", "R") and b in ("L", "R"):
        return "same" if p == b else "opposite"
    return None


class PitchPredictor:
    model_version: str = _MODEL_VERSION

    # ---------- pitch speed O/U ----------------------------------------
    def predict_pitch_speed(self, context: dict) -> dict:
        cache = get_cache()
        pitcher_id = context.get("pitcher_id")
        game_pk = context.get("game_pk")

        stats = cache.get_pitch_stats(pitcher_id)
        n = stats.sample_pitches if stats else 0
        pitcher_speed = stats.avg_speed if stats else LEAGUE_AVG_SPEED
        features = ["pitcher_freq"] if stats else ["league_avg"]

        rolling = _safe(lambda: cache.get_pitcher_rolling(pitcher_id), "pitcher_rolling")
        if rolling is not None and rolling.avg_fastball_velo is not None:
            pitcher_speed = rolling.avg_fastball_velo
            n = max(n, rolling.sample_pitches or 0)
            features.append("pitcher_rolling")

        blended = _blend(pitcher_speed, LEAGUE_AVG_SPEED, n)

        log = _safe(lambda: cache.get_pitcher_game_log(game_pk, pitcher_id), "pitcher_game_log") if game_pk is not None else None
        if log is not None:
            pc = log.get("pitch_count_in_game") or 0
            if pc > 100:
                blended -= 1.2; features.append("fatigue")
            elif pc > 80:
                blended -= 0.7; features.append("fatigue")
            elif pc > 60:
                blended -= 0.3; features.append("fatigue")
            dr = log.get("days_rest")
            if dr == 0:
                blended -= 0.5; features.append("days_rest")

        ctx = _safe(lambda: cache.get_game_context(game_pk), "game_context") if game_pk is not None else None
        if ctx is not None and not ctx.get("is_dome"):
            temp = ctx.get("temperature_f")
            if temp is not None:
                t = float(temp)
                if t < 40:
                    blended -= 1.4; features.append("weather")
                elif t < 50:
                    blended -= 0.8; features.append("weather")

        blended += _SPEED_DELTAS.get(_count_key(context), 0.0)

        return {
            "market": "pitch_speed_ou",
            "predicted_mph": round(float(blended), 2),
            "confidence": round(_confidence(n, k=300.0), 3),
            "sample_size": n,
            "model_version": _MODEL_VERSION,
            "features_used": features,
        }

    # ---------- pitch result -------------------------------------------
    def predict_pitch_result(self, context: dict) -> dict:
        cache = get_cache()
        pitcher_id = context.get("pitcher_id")
        batter_id = context.get("batter_id")
        game_pk = context.get("game_pk")

        stats = cache.get_pitch_stats(pitcher_id)
        n = stats.sample_pitches if stats else 0
        if stats is not None:
            probs = {
                "strike_foul": _blend(stats.strike_foul_rate, LEAGUE_PITCH_RESULT["strike_foul"], n),
                "ball":        _blend(stats.ball_rate,        LEAGUE_PITCH_RESULT["ball"],        n),
                "in_play":     _blend(stats.in_play_rate,     LEAGUE_PITCH_RESULT["in_play"],     n),
            }
            features = ["pitcher_freq"]
        else:
            probs = dict(LEAGUE_PITCH_RESULT)
            features = ["league_avg"]

        probs = _normalize(probs)

        rolling = _safe(lambda: cache.get_pitcher_rolling(pitcher_id), "pitcher_rolling")
        if rolling is not None and rolling.zone_rate is not None:
            zr = rolling.zone_rate
            applied = False
            if zr > 0.55:
                probs["strike_foul"] = probs.get("strike_foul", 0.0) + 0.04
                applied = True
            elif zr < 0.42:
                probs["ball"] = probs.get("ball", 0.0) + 0.06
                applied = True
            if applied:
                probs = _normalize(probs)
                features.append("pitcher_rolling")
            n = max(n, rolling.sample_pitches or 0)

        b_roll = _safe(lambda: cache.get_batter_rolling(batter_id), "batter_rolling")
        if b_roll is not None and b_roll.chase_rate is not None:
            cr = b_roll.chase_rate
            applied = False
            if cr > 0.33:
                probs["strike_foul"] = probs.get("strike_foul", 0.0) + 0.05
                applied = True
            elif cr < 0.22:
                probs["ball"] = probs.get("ball", 0.0) + 0.03
                applied = True
            if applied:
                probs = _normalize(probs)
                features.append("batter_rolling")

        # Umpire branch: umpire_stats table is created but not populated this
        # phase, so _lookup_umpire_zone_rate returns None and the branch
        # never fires. Keeping the structure means we just need to populate
        # the table to enable it.
        if game_pk is not None:
            ctx = _safe(lambda: cache.get_game_context(game_pk), "game_context")
            ump_id = (ctx or {}).get("umpire_id") if ctx else None
            if ump_id is not None:
                ump_zone = _safe(lambda: _lookup_umpire_zone_rate(ump_id), "umpire_stats")
                if ump_zone is not None and ump_zone > 0.92:
                    probs["strike_foul"] = probs.get("strike_foul", 0.0) + 0.03
                    probs = _normalize(probs)
                    features.append("umpire")

        delta = _PITCH_RESULT_DELTAS.get(_count_key(context))
        if delta:
            probs = _apply_delta(probs, delta)

        return {
            "market": "pitch_result",
            "probs": {k: round(v, 4) for k, v in probs.items()},
            "confidence": round(_confidence(n, k=400.0), 3),
            "sample_size": n,
            "model_version": _MODEL_VERSION,
            "features_used": features,
        }

    # ---------- at-bat result ------------------------------------------
    def predict_at_bat_result(self, context: dict) -> dict:
        cache = get_cache()
        pitcher_id = context.get("pitcher_id")
        batter_id = context.get("batter_id")

        stats = cache.get_ab_stats(pitcher_id)
        n = stats.sample_abs if stats else 0
        if stats is not None:
            probs = {
                "strikeout": _blend(stats.so_rate,  LEAGUE_AB_RESULT["strikeout"], n),
                "walk":      _blend(stats.bb_rate,  LEAGUE_AB_RESULT["walk"],      n),
                "hit":       _blend(stats.hit_rate, LEAGUE_AB_RESULT["hit"],       n),
                "out":       _blend(stats.out_rate, LEAGUE_AB_RESULT["out"],       n),
            }
            features = ["pitcher_freq"]
        else:
            probs = dict(LEAGUE_AB_RESULT)
            features = ["league_avg"]
        probs = _normalize(probs)

        # Platoon: needs both pitcher pitch_hand and batter bat_side.
        p_info = _safe(lambda: cache.get_player_info(pitcher_id), "player_info_pitcher")
        b_info = _safe(lambda: cache.get_player_info(batter_id), "player_info_batter")
        plat = _platoon_label(
            (p_info or {}).get("pitch_hand"),
            (b_info or {}).get("bat_side"),
        )
        if plat == "same":
            probs["strikeout"] = probs.get("strikeout", 0.0) + 0.03
            probs["walk"]      = max(0.0, probs.get("walk", 0.0) - 0.01)
            probs = _normalize(probs)
            features.append("platoon")
        elif plat == "opposite":
            probs["strikeout"] = max(0.0, probs.get("strikeout", 0.0) - 0.02)
            probs["walk"]      = probs.get("walk", 0.0) + 0.015
            probs = _normalize(probs)
            features.append("platoon")

        # Career matchup blend.
        m = _safe(lambda: cache.get_matchup_history(pitcher_id, batter_id), "matchup_history")
        if m is not None and (m.get("pa_count") or 0) >= 10:
            pa = float(m["pa_count"])
            so_c = (m.get("so_count") or 0) / pa
            bb_c = (m.get("bb_count") or 0) / pa
            h_c  = (m.get("h_count")  or 0) / pa
            out_c = max(0.0, 1.0 - so_c - bb_c - h_c)
            career = {"strikeout": so_c, "walk": bb_c, "hit": h_c, "out": out_c}
            probs = {k: 0.7 * probs.get(k, 0.0) + 0.3 * career[k] for k in career}
            probs = _normalize(probs)
            features.append("matchup")

        # Batter hot/cold.
        b_roll = _safe(lambda: cache.get_batter_rolling(batter_id), "batter_rolling")
        if b_roll is not None:
            touched = False
            if b_roll.hard_hit_rate is not None and b_roll.hard_hit_rate > 0.40:
                probs["hit"] = probs.get("hit", 0.0) + 0.03
                touched = True
            if b_roll.k_rate is not None and b_roll.k_rate > 0.30:
                probs["strikeout"] = probs.get("strikeout", 0.0) + 0.025
                touched = True
            if touched:
                probs = _normalize(probs)
                features.append("batter_rolling")

        delta = _AB_RESULT_DELTAS.get(_count_key(context))
        if delta:
            probs = _apply_delta(probs, delta)

        return {
            "market": "ab_result",
            "probs": {k: round(v, 4) for k, v in probs.items()},
            "confidence": round(_confidence(n, k=150.0), 3),
            "sample_size": n,
            "model_version": _MODEL_VERSION,
            "features_used": features,
        }

    # ---------- at-bat pitches O/U -------------------------------------
    def predict_at_bat_pitches(self, context: dict) -> dict:
        cache = get_cache()
        pitcher_id = context.get("pitcher_id")
        batter_id = context.get("batter_id")

        stats = cache.get_ab_stats(pitcher_id)
        n = stats.sample_abs if stats else 0
        pitcher_avg = stats.avg_pitches if stats else LEAGUE_AVG_PITCHES_PA
        baseline = _blend(pitcher_avg, LEAGUE_AVG_PITCHES_PA, n)
        features = ["pitcher_freq"] if stats else ["league_avg"]

        rolling = _safe(lambda: cache.get_pitcher_rolling(pitcher_id), "pitcher_rolling")
        if rolling is not None and rolling.zone_rate is not None and rolling.zone_rate < 0.45:
            baseline += 0.4
            features.append("pitcher_rolling")

        b_roll = _safe(lambda: cache.get_batter_rolling(batter_id), "batter_rolling")
        if b_roll is not None and b_roll.chase_rate is not None and b_roll.chase_rate < 0.25:
            baseline += 0.3
            features.append("batter_rolling")

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
            "features_used": features,
        }
