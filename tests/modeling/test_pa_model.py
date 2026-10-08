"""PA outcome model, end to end on a synthetic league with known talent."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from modeling import pa_model as P
from modeling import ratings as R

BASE = np.array([0.22, 0.09, 0.14, 0.045, 0.004, 0.03, 0.461])


def synthetic(seed=0, batters=40, pitchers=30, seasons=(2016, 2017, 2018, 2019),
              pa_per_day=60):
    rng = np.random.default_rng(seed)
    bt = rng.normal(0, 0.35, (batters, R.NC))
    pt = rng.normal(0, 0.35, (pitchers, R.NC))
    rows = []
    for s in seasons:
        for d in range(0, 150, 2):
            day = (pd.Timestamp(f"{s}-04-01") + pd.Timedelta(days=d))
            for i in range(pa_per_day):
                b, p = rng.integers(batters), rng.integers(pitchers)
                z = np.log(BASE) + bt[b] + pt[p]
                q = np.exp(z) / np.exp(z).sum()
                rows.append({
                    "game_pk": s * 1000 + d, "at_bat_index": i,
                    "game_date": day, "season": s, "batter_id": b,
                    "pitcher_id": 1000 + p, "venue_id": int(rng.integers(3)),
                    "bat_side": "L" if b % 2 else "R",
                    "pitch_hand": "L" if p % 3 == 0 else "R",
                    "tto": int(rng.integers(1, 4)), "top_inning": bool(i % 2),
                    "pit_started": bool(rng.random() < 0.6),
                    "y": int(rng.choice(R.NC, p=q)),
                })
    df = pd.DataFrame(rows)
    df["day"] = R.day_index(df["game_date"])
    df["bat_home"] = (~df["top_inning"]).astype(float)
    df["pit_team"] = df["venue_id"]
    return df


@pytest.fixture(scope="module")
def prepared():
    pa = synthetic()
    pa, cfg = P.attach_ratings(pa, tune=True)
    return pa, cfg, P.design(pa)


def test_design_shape_and_finite(prepared):
    pa, _, X = prepared
    assert X.shape == (len(pa), len(P.FEATURES))
    assert np.isfinite(X).all()


def test_model_beats_league_and_log5_is_sane(prepared):
    pa, cfg, X = prepared
    folds = P.walk_forward(pa, X)
    assert [f["season"] for f in folds] == [2018, 2019]
    for f in folds:
        assert f["logloss"] < f["league_only"]
        assert f["log5"] < f["league_only"]
        assert 0.9 < f["hit_calibration"] < 1.1
    agg = P.aggregate(folds)
    assert agg["folds_used"] == 2


def test_params_roundtrip_predicts_a_distribution(prepared):
    pa, _, X = prepared
    params = P.fit(X[:5000], pa["y"].to_numpy()[:5000])
    p = P.predict(params, X[:10])
    np.testing.assert_allclose(p.sum(axis=1), 1.0)
    assert params["features"] == list(P.FEATURES)
    assert len(params["coef"]) == R.NC


def test_configs_are_serialisable(prepared):
    _, cfg, _ = prepared
    js = P.dumps(cfg)
    assert '"batter"' in js and '"park"' in js
