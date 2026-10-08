"""publish_ratings.build on a synthetic league: kinds, shapes, train = serve."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from modeling import games as G
from modeling import pa_model as P
from modeling import publish_ratings as PR
from modeling import ratings as R

from .synthetic_league import league


@pytest.fixture(scope="module")
def built():
    pa, box = league(seasons=(2016, 2017), days=30)
    mp = pytest.MonkeyPatch()
    mp.setattr(P, "load_pa", lambda store: pa.copy())
    mp.setattr(G, "load_box", lambda store: box.copy())
    _, cfg = P.attach_ratings(pa.copy(), tune=False, configs={
        "batter": R.RatingConfig(365.0, (50,) * 7),
        "pitcher": R.RatingConfig(365.0, (80,) * 7),
        "park": {"tau": 1095.0, "k": 800.0}})
    params = {"ratings": {k: (v.to_json() if hasattr(v, "to_json") else v)
                          for k, v in cfg.items()}}
    today = (pd.Timestamp("2017-04-01") + pd.Timedelta(days=29)).date()
    df = PR.build(None, params, today=today)
    mp.undo()
    return pa, df, params, today


def test_every_kind_is_published(built):
    _, df, _, _ = built
    assert set(df["kind"]) == {"league", "bat", "pit", "park", "pen", "team"}
    rates = df[df["kind"].isin(["bat", "pit", "pen", "league"])][
        [f"c{c}" for c in range(R.NC)]].to_numpy()
    np.testing.assert_allclose(rates.sum(axis=1), 1.0, atol=1e-9)
    pit = df[df["kind"] == "pit"].iloc[0]["extra"]
    assert "p_outs_mean" in pit and "pitch_hand" in pit


def test_published_batter_equals_training_asof(built):
    pa, df, params, today = built
    at = float(R.day_index([pd.Timestamp(today)])[0])
    cb = R.RatingConfig.from_json(params["ratings"]["batter"])
    # Training's as-of value for a batter who plays on `today`.
    league = R.league_asof(pa)
    asof = R.ratings_asof(pa, "batter_id", league, cb)
    row = asof[asof["day"] == at].iloc[0]
    pub = df[(df["kind"] == "bat") & (df["id"] == row["batter_id"])].iloc[0]
    # The nightly publish and the training frame are the same function of
    # the history -- the property the whole ratings layer exists for.
    np.testing.assert_allclose(
        pub[[f"c{c}" for c in range(R.NC)]].to_numpy(float),
        row[[f"r_{c}" for c in range(R.NC)]].to_numpy(float), rtol=1e-6)
