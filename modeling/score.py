"""Python mirror of supabase/functions/_shared/model.ts.

This file exists so offline validation measures what production computes. It is
a MIRROR, not an improvement: where this and model.ts disagree, model.ts is
right and this is a bug. Do not "fix" a difference by changing the TypeScript.

Pinned by tests/modeling/test_parity.py against golden fixtures the TypeScript
itself emits.

The context shape is model.ts's ScoreContext, which is NOT flat: featureValue()
reads rolling-stat rows out of ctx["pitcher"] / ctx["batter"] and subtracts
league constants itself. Passing a pre-computed "pitcher_zone_delta" here would
silently score as 0.0, the same way an unknown feature name does in production.
"""

from __future__ import annotations

import math

# Mirrors the LEAGUE object at the top of model.ts.
LEAGUE = {
    "avg_speed": 92.8,
    "pitch_result": {"strike_foul": 0.455, "ball": 0.352, "in_play": 0.193},
    "ab_result": {"strikeout": 0.221, "walk": 0.087, "hit": 0.239,
                  "out": 0.453},
    "avg_pitches_pa": 3.85,
    "speed_sigma": 5.4,
    "avg_runs_per_team": 4.4,
}

# Baselines featureValue() subtracts inline rather than reading from LEAGUE.
ZONE_BASELINE = 0.48
WHIFF_BASELINE = 0.24
CHASE_BASELINE = 0.28
CONTACT_BASELINE = 0.77


def _num_or_none(v):
    return None if v is None else float(v)


def _blend(v, league: float, n: float, k: float = 500.0) -> float:
    """Mirror of blend() in model.ts: shrink a sparse rate toward the league."""
    if v is None:
        return league
    w = 0.85 * (1 - math.exp(-n / k))
    return v * w + league * (1 - w)


def _delta(row: dict, key: str, baseline: float) -> float:
    """`row.key != null ? Number(row.key) - baseline : 0`, as model.ts writes it."""
    v = row.get(key)
    return float(v) - baseline if v is not None else 0.0


def feature_value(name: str, ctx: dict, _missing=0.0) -> float:
    """Mirror of featureValue() in model.ts.

    Unknown names return 0.0 -- matching the TypeScript's `default: return 0`,
    which is why MarketSpec validates feature names at construction time
    instead. `_missing` is a test seam: tests/modeling/test_parity.py passes a
    sentinel to assert every `case` in the real switch is mirrored here.
    """
    p = ctx.get("pitcher") or {}
    b = ctx.get("batter") or {}
    al = LEAGUE["ab_result"]
    balls = float(ctx.get("balls", 0))
    strikes = float(ctx.get("strikes", 0))

    if name == "bias":
        return 1.0
    if name == "balls":
        return balls
    if name == "strikes":
        return strikes
    if name == "two_strikes":
        return 1.0 if strikes >= 2 else 0.0
    if name == "three_balls":
        return 1.0 if balls >= 3 else 0.0
    if name == "pitch_of_pa":
        return float(ctx.get("pitch_count_pa", 0)) + 1.0
    if name == "pitcher_velo":
        return _blend(_num_or_none(p.get("avg_fastball_velo")),
                      LEAGUE["avg_speed"], float(p.get("sample_pitches") or 0),
                      300.0)
    if name == "pitcher_zone_delta":
        return _delta(p, "zone_rate", ZONE_BASELINE)
    if name == "pitcher_whiff_delta":
        return _delta(p, "whiff_rate", WHIFF_BASELINE)
    if name == "pitcher_k_delta":
        return _delta(p, "k_rate", al["strikeout"])
    if name == "pitcher_bb_delta":
        return _delta(p, "bb_rate", al["walk"])
    if name == "batter_k_delta":
        return _delta(b, "k_rate", al["strikeout"])
    if name == "batter_bb_delta":
        return _delta(b, "bb_rate", al["walk"])
    if name == "batter_chase_delta":
        return _delta(b, "chase_rate", CHASE_BASELINE)
    if name == "batter_contact_delta":
        return _delta(b, "contact_rate", CONTACT_BASELINE)
    if name == "platoon_same":
        ph = (ctx.get("pitcher_info") or {}).get("pitch_hand")
        bs = (ctx.get("batter_info") or {}).get("bat_side")
        if not ph or not bs or bs == "S":
            return 0.0
        return 1.0 if ph == bs else 0.0
    return _missing


def _softmax(logits: list[float]) -> list[float]:
    top = max(logits)
    exps = [math.exp(v - top) for v in logits]
    total = sum(exps)
    return [v / total for v in exps]


def _multinomial(params: dict, ctx: dict) -> dict:
    """Mirror of scoreMultinomial(). Missing coef entries read as 0, as in TS."""
    features = params.get("features") or []
    values = [feature_value(f, ctx) for f in features]
    logits = []
    for k, _cls in enumerate(params["classes"]):
        row = (params.get("coef") or [])[k] if k < len(params.get("coef") or []) else []
        z = (params.get("intercept") or [0.0] * len(params["classes"]))[k] or 0.0
        for j, v in enumerate(values):
            z += (row[j] if j < len(row) else 0.0) * v
        logits.append(z)
    return dict(zip(params["classes"], _softmax(logits)))


def _linear(params: dict, ctx: dict) -> float:
    """Mirror of scoreLinear()."""
    features = params.get("features") or []
    coef = params.get("coef") or []
    y = float(params.get("intercept") or 0.0)
    for j, f in enumerate(features):
        y += (coef[j] if j < len(coef) else 0.0) * feature_value(f, ctx)
    return y


def norm_cdf(x: float) -> float:
    """Abramowitz-Stegun approximation, exactly as model.ts writes it.

    NOT scipy.stats.norm: a different approximation is a different number, and
    the O/U probabilities production serves come from this one.
    """
    t = 1 / (1 + 0.2316419 * abs(x))
    d = 0.3989423 * math.exp(-x * x / 2)
    p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))))
    if x > 0:
        p = 1 - p
    return p


def speed_over_prob(mu: float, sigma: float, line: float) -> float:
    return 1 - norm_cdf((line - mu) / sigma)


def score(params: dict, ctx: dict):
    kind = params.get("type")
    if kind == "multinomial_logistic":
        return _multinomial(params, ctx)
    if kind == "linear":
        return _linear(params, ctx)
    if kind == "remaining_table":
        cell = (params.get("table") or {}).get(
            f"{int(ctx.get('balls', 0))}-{int(ctx.get('strikes', 0))}")
        return cell
    raise NotImplementedError(
        f"no reference scorer for params.type={kind!r}. model.ts has no "
        f"default branch either -- an unknown type is a silent production bug.")
