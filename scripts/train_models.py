"""Train v1 models for every market from the backfilled Supabase dataset.

Data comes from the train_*_cells() RPCs (weighted aggregate cells, so this
works over millions of pitches with tiny transfers). Fitted parameters are
written to the model_params table with is_active=true; the live-poll edge
function (supabase/functions/_shared/model.ts) scores with them directly.

Usage:
    SUPABASE_URL=... SUPABASE_KEY=<service-or-anon-key> python scripts/train_models.py

Requires: numpy, scikit-learn (pip install numpy scikit-learn supabase).
"""

from __future__ import annotations

import json
import math
import os
import sys
from datetime import datetime, timezone

import numpy as np
from sklearn.linear_model import LinearRegression, LogisticRegression

from backend.db.client import get_client

VERSION = "v1_" + datetime.now(timezone.utc).strftime("%Y%m%d")

PITCH_CLASSES = ["strike_foul", "ball", "in_play"]
AB_CLASSES = ["strikeout", "walk", "hit", "out"]

PITCH_FEATURES = ["balls", "strikes", "two_strikes", "three_balls",
                  "pitcher_zone_delta", "batter_chase_delta"]
AB_FEATURES = ["balls", "strikes", "pitcher_k_delta", "pitcher_bb_delta",
               "batter_k_delta", "platoon_same"]
SPEED_FEATURES = ["pitcher_velo", "balls", "strikes", "pitch_of_pa"]

ZONE_STEP, CHASE_STEP, K_STEP = 0.03, 0.04, 0.035


def rpc(name: str) -> list[dict]:
    rows = get_client().rpc(name, {}).execute().data or []
    print(f"[train] {name}: {len(rows)} cells")
    return rows


def fit_multinomial(cells: list[dict], classes: list[str],
                    row_features) -> tuple[dict, dict]:
    X, y, w = [], [], []
    for c in cells:
        if c.get("outcome") not in classes:
            continue
        X.append(row_features(c))
        y.append(classes.index(c["outcome"]))
        w.append(float(c["n"]))
    X, y, w = np.asarray(X, float), np.asarray(y), np.asarray(w, float)
    clf = LogisticRegression(max_iter=2000, C=10.0)
    clf.fit(X, y, sample_weight=w)
    # log-loss on the training cells (weighted)
    p = clf.predict_proba(X)
    ll = float(-np.average(np.log(np.clip(p[np.arange(len(y)), y], 1e-12, 1)), weights=w))
    # sklearn orders classes by label index; expand binary-collapsed coefs if needed
    coef = np.zeros((len(classes), X.shape[1]))
    intercept = np.zeros(len(classes))
    for i, cls_idx in enumerate(clf.classes_):
        coef[int(cls_idx)] = clf.coef_[i] if clf.coef_.shape[0] > 1 else (clf.coef_[0] if cls_idx == 1 else -clf.coef_[0])
        intercept[int(cls_idx)] = clf.intercept_[i] if len(clf.intercept_) > 1 else (clf.intercept_[0] if cls_idx == 1 else -clf.intercept_[0])
    params = {
        "type": "multinomial_logistic",
        "classes": classes,
        "coef": [[round(v, 6) for v in row] for row in coef.tolist()],
        "intercept": [round(v, 6) for v in intercept.tolist()],
    }
    metrics = {"weighted_logloss": round(ll, 5), "cells": int(len(y)),
               "rows": int(w.sum())}
    return params, metrics


def train_pitch_result() -> tuple[dict, dict]:
    cells = rpc("train_pitch_result_cells")

    def feats(c: dict) -> list[float]:
        b, s = c["balls"], c["strikes"]
        return [b, s, 1.0 if s >= 2 else 0.0, 1.0 if b >= 3 else 0.0,
                c.get("zone_bucket", 0) * ZONE_STEP,
                c.get("chase_bucket", 0) * CHASE_STEP]

    params, metrics = fit_multinomial(cells, PITCH_CLASSES, feats)
    params["features"] = PITCH_FEATURES
    return params, metrics


def train_ab_result() -> tuple[dict, dict]:
    cells = rpc("train_ab_result_cells")

    def feats(c: dict) -> list[float]:
        return [c["balls"], c["strikes"],
                c.get("pk_bucket", 0) * K_STEP,
                0.0,  # pitcher_bb_delta folded into intercept for v1 cells
                c.get("bk_bucket", 0) * K_STEP,
                float(c.get("platoon_same", 0))]

    params, metrics = fit_multinomial(cells, AB_CLASSES, feats)
    params["features"] = AB_FEATURES
    return params, metrics


def train_pitch_speed() -> tuple[dict, dict]:
    cells = rpc("train_pitch_speed_cells")
    X = np.asarray([[float(c["velo_bucket"]), c["balls"], c["strikes"],
                     c["pitch_of_pa"]] for c in cells], float)
    y = np.asarray([float(c["mean_speed"]) for c in cells], float)
    w = np.asarray([float(c["n"]) for c in cells], float)
    reg = LinearRegression()
    reg.fit(X, y, sample_weight=w)
    resid = y - reg.predict(X)
    between_var = float(np.average(resid ** 2, weights=w))
    within_var = float(np.average(
        [float(c["var_speed"] or 0.0) for c in cells], weights=w))
    sigma = math.sqrt(between_var + within_var)
    params = {
        "type": "linear",
        "features": SPEED_FEATURES,
        "coef": [round(float(v), 6) for v in reg.coef_],
        "intercept": round(float(reg.intercept_), 4),
        "sigma": round(sigma, 3),
    }
    r2 = reg.score(X, y, sample_weight=w)
    return params, {"r2_cells": round(float(r2), 4), "sigma": round(sigma, 3),
                    "rows": int(w.sum())}


def train_ab_pitches() -> tuple[dict, dict]:
    cells = rpc("train_ab_pitches_cells")
    table: dict[str, dict] = {}
    grouped: dict[str, dict[int, float]] = {}
    for c in cells:
        key = f"{c['balls']}-{c['strikes']}"
        grouped.setdefault(key, {})[int(c["remaining"])] = float(c["n"])
    total_rows = 0
    for key, dist in grouped.items():
        n = sum(dist.values())
        total_rows += n
        mean = sum(k * v for k, v in dist.items()) / n
        table[key] = {
            "mean": round(mean, 3),
            "dist": {str(k): round(v / n, 5) for k, v in sorted(dist.items())},
        }
    params = {"type": "remaining_table", "table": table}
    return params, {"states": len(table), "rows": int(total_rows)}


def train_moneyline() -> tuple[dict, dict]:
    rows = rpc("train_home_advantage")
    games = int(rows[0]["games"]) if rows else 0
    hw = float(rows[0]["home_win_rate"]) if rows and rows[0]["home_win_rate"] else 0.54
    params = {"type": "log5", "home_adv": round(hw, 4)}
    return params, {"games": games, "home_win_rate": round(hw, 4)}


def save(market: str, params: dict, metrics: dict) -> None:
    client = get_client()
    client.table("model_params").update({"is_active": False}) \
        .eq("market", market).eq("is_active", True).execute()
    client.table("model_params").upsert({
        "market": market, "version": VERSION, "params": params,
        "metrics": metrics, "training_rows": metrics.get("rows") or metrics.get("games"),
        "is_active": True,
    }, on_conflict="market,version").execute()
    print(f"[train] saved {market} {VERSION} metrics={json.dumps(metrics)}")


def main() -> int:
    trainers = {
        "pitch_result": train_pitch_result,
        "ab_result": train_ab_result,
        "pitch_speed_ou": train_pitch_speed,
        "ab_pitches_ou": train_ab_pitches,
        "game_moneyline": train_moneyline,
    }
    failed = 0
    for market, fn in trainers.items():
        try:
            params, metrics = fn()
            save(market, params, metrics)
        except Exception as exc:
            failed += 1
            print(f"[train] {market} FAILED: {exc}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
