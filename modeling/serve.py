"""The serving computation, in Python -- the reference props.ts must match.

Everything production does to turn model_params + model_ratings into a
published number, for one batter, one starter or one game. Training
(markets.py) computes the same quantities in bulk; this module is the
per-entity form the edge functions run, and tests/modeling/test_props_parity.py
pins supabase/functions/_shared/props.ts to it through golden fixtures the
TypeScript emits. If they disagree, props.ts is what users see -- fix this
file, or fix both on purpose.

`bundle` is {market: params} for the active rows: pa_outcome, workload,
team_runs, game_moneyline and the per-market calibrator rows.

Rating vectors are length-7 lists in class order K, BB, 1B, 2B, 3B, HR, OUT.
"""

from __future__ import annotations

import math

import numpy as np

from modeling import derive as D
from modeling import pa_model as P

RUN_WEIGHTS = (0.0, 0.70, 0.89, 1.27, 1.62, 2.10, 0.0)   # == games.RUN_WEIGHTS


def pa_dist(pa_params: dict, rb, rp, pk, L, *, same: float, left: float,  # noqa: ANN001
            home: float, reliever: float, tto: float) -> np.ndarray:
    X = P.pa_features(np.asarray([rb], float), np.asarray([rp], float),
                      np.asarray([pk], float), np.asarray([L], float),
                      np.array([same]), np.array([left]), np.array([home]),
                      np.array([reliever]), np.array([tto]))
    return P.predict(pa_params, X)[0]


def workload(bundle: dict, *, own_outs: float | None,
             pitches: float | None, team_leash: float | None,
             rest_days: float | None, rp, L) -> tuple[np.ndarray, np.ndarray]:  # noqa: ANN001
    """(outs pmf, batters-faced pmf) for a starter.

    Both location models read the same features -- including the pitcher's
    decayed OUTS per start as `own_mean` -- exactly as games.workload_frame
    builds them for training.
    """
    wl = bundle["workload"]
    pri = wl["workload_priors"]
    rest_raw = 60.0 if rest_days is None else float(rest_days)
    quality = (rp[0] + rp[6]) - (L[0] + L[6])

    def feats(own):
        return {"own_mean": own, "team_leash": team_leash if team_leash is not None
                else wl["team_leash"]["prior"],
                "pitches_mean": pitches if pitches is not None
                else pri["p_pitches"]["prior"],
                "rest": min(max(rest_raw, 0.0), 15.0),
                "first_start": 1.0 if rest_raw > 30 else 0.0,
                "quality": quality}

    f = feats(own_outs if own_outs is not None else pri["p_outs"]["prior"])

    def mu(model):
        return float(sum(c * f[n] for c, n in zip(model["coef"], model["features"]))
                     + model["intercept"])
    o = mu(wl["outs"])
    b = mu(wl["bf"])
    return (D.shift_pmf(o, wl["outs"]["residual_pmf"], 0, D.MAX_OUTS),
            D.shift_pmf(b, wl["bf"]["residual_pmf"], 0, D.MAX_BF))


def _hands(bat_side: str, pit_hand: str) -> tuple[float, float]:
    return (1.0 if (bat_side == pit_hand and bat_side != "S") else 0.0,
            1.0 if pit_hand == "L" else 0.0)


def batter_dists(bundle: dict, *, rb, bat_side: str, slot: int, is_home: bool,  # noqa: ANN001
                 sp_r, sp_hand: str, pen_r, pk, L, bf_pmf) -> np.ndarray:
    pa = bundle["pa_outcome"]
    left_share = bundle["workload"]["pen_left_share"]
    same, left = _hands(bat_side, sp_hand)
    home = 1.0 if is_home else 0.0
    ps = [pa_dist(pa, rb, sp_r, pk, L, same=same, left=left, home=home,
                  reliever=0.0, tto=t) for t in (1, 2, 3)]
    pen_same = 0.0 if bat_side == "S" else (left_share if bat_side == "L"
                                           else 1 - left_share)
    pp = pa_dist(pa, rb, pen_r, pk, L, same=pen_same, left=left_share,
                 home=home, reliever=1.0, tto=1.0)
    q = D.vs_starter_prob(slot, D.MAX_PA, bf_pmf)
    return np.stack([q[i] * ps[min(i, 2)] + (1 - q[i]) * pp
                     for i in range(D.MAX_PA)])


def pa_pmf(bundle: dict, slot: int, is_home: bool) -> np.ndarray:
    t = bundle["workload"]["pa_pmf"]
    return np.asarray(t.get(f"{slot}{'H' if is_home else 'A'}") or t[f"{slot}H"], float)


def batter_value(dists: np.ndarray, pmf: np.ndarray) -> float:
    """Expected offensive value over the game -- the team-runs input."""
    surv = np.cumsum(pmf[::-1])[::-1][1:]
    return float(np.dot(surv, dists[: len(surv)] @ np.asarray(RUN_WEIGHTS)))


def batter_markets(bundle: dict, dists: np.ndarray, pmf: np.ndarray, *,
                   slot: int, team_value: float) -> dict:
    s = D.batter_structural(dists, pmf)
    out = {}
    for mkt, key in (("batter_hit", "hit"), ("batter_hr", "hr"),
                     ("batter_tb15", "tb2"), ("batter_hrr", "hit")):
        cal = (bundle.get(mkt) or {}).get("cal")
        x = None
        if mkt == "batter_hrr":
            x = {"e_onbase": s["e_onbase"], "top_order": 1.0 if slot <= 5 else 0.0,
                 "log_team_value": math.log(max(team_value, 1e-3))}
        out[mkt] = D.calibrate(s[key], cal, x)
    out["_structural"] = s
    return out


def starter_markets(bundle: dict, *, sp_r, sp_hand: str, lineup: list[tuple],  # noqa: ANN001
                    batting_home: bool, pk, L, outs_pmf, bf_pmf) -> dict:
    """lineup: nine (rb, bat_side) in batting order, the side he faces."""
    pa = bundle["pa_outcome"]
    home = 1.0 if batting_home else 0.0
    by_tto = []
    for t in (1, 2, 3):
        acc = np.zeros(7)
        for rb, side in lineup:
            same, left = _hands(side, sp_hand)
            acc += pa_dist(pa, rb, sp_r, pk, L, same=same, left=left, home=home,
                           reliever=0.0, tto=t)
        by_tto.append(acc / len(lineup))
    bf = np.arange(len(bf_pmf))
    w = np.array([np.dot(bf_pmf, np.minimum(bf, 9)),
                  np.dot(bf_pmf, np.clip(bf - 9, 0, 9)),
                  np.dot(bf_pmf, np.maximum(bf - 18, 0))])
    w = w / max(w.sum(), 1e-9)
    p_avg = sum(w[i] * by_tto[i] for i in range(3))
    cnt = D.starter_counts(p_avg, outs_pmf)
    e_outs = float(np.dot(np.arange(len(outs_pmf)), outs_pmf))
    rpo = float(p_avg @ np.asarray(RUN_WEIGHTS)) / float(p_avg[0] + p_avg[6])
    out = {}
    for mkt, pmf in (("pitcher_k", cnt["k"]), ("pitcher_bb", cnt["bb"]),
                     ("pitcher_hits", cnt["h"]), ("pitcher_outs", cnt["outs"]),
                     ("pitcher_er", None)):
        prm = bundle.get(mkt) or {}
        if mkt == "pitcher_er":
            g = prm.get("er_glm")
            if not g:
                continue
            z = g["intercept"] + g["coef"][0] * math.log(max(e_outs, 1.0)) \
                + g["coef"][1] * math.log(max(rpo, 1e-3))
            pmf = D.negbin_pmf(math.exp(z), g["alpha"], 30)
        line = D.median_line(pmf)
        out[mkt] = {"line": line,
                    "p_over": D.calibrate(D.over_prob(pmf, line), prm.get("cal")),
                    "expected": float(np.dot(np.arange(len(pmf)), pmf))}
    return out


def team_mu(bundle: dict, *, value: float, is_home: bool, temp_c: float,
            wind_out: float) -> float:
    m = bundle["team_runs"]
    x = {"log_value": math.log(max(value, 1e-3)), "home": 1.0 if is_home else 0.0,
         "temp_c": temp_c, "wind_out": wind_out}
    return math.exp(m["intercept"] + sum(c * x[f] for c, f in zip(m["coef"], m["features"])))


def game_markets(bundle: dict, *, mu_home: float, mu_away: float) -> dict:
    m = bundle["team_runs"]
    h = D.negbin_pmf(mu_home, m["alpha"], 30)
    a = D.negbin_pmf(mu_away, m["alpha"], 30)
    p_home = D.calibrate(D.home_win_prob(h, a, m["extra_home"]),
                         (bundle.get("game_moneyline") or {}).get("cal"))
    tot = D.convolve_total(h, a)
    line = D.median_line(tot)
    return {"p_home": p_home, "total_line": line,
            "p_over": D.over_prob(tot, line),
            "mu_total": mu_home + mu_away}
