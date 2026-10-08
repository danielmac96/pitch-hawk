"""The ratings layer: as-of arithmetic, leakage, and train/serve agreement."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from modeling import ratings as R


def _pa(n=400, players=5, days=60, seed=0):
    rng = np.random.default_rng(seed)
    return pd.DataFrame({
        "pid": rng.integers(0, players, n),
        "day": rng.integers(0, days, n).astype(float),
        "y": rng.integers(0, R.NC, n),
    })


def _brute(pa, pid, day, tau):
    prior = pa[(pa["pid"] == pid) & (pa["day"] < day)]
    w = np.exp(-(day - prior["day"].to_numpy()) / tau)
    S = np.array([w[prior["y"].to_numpy() == c].sum() for c in range(R.NC)])
    return S, w.sum()


def test_decayed_asof_matches_brute_force():
    pa = _pa()
    tau = 20.0
    s = R.decayed_asof(pa, "pid", tau)
    for _, row in s.sample(25, random_state=1).iterrows():
        S, n = _brute(pa, row["pid"], row["day"], tau)
        got = row[[f"S_{c}" for c in range(R.NC)]].to_numpy(float)
        np.testing.assert_allclose(got, S, rtol=1e-9, atol=1e-9)
        assert row["S_n"] == pytest.approx(n, rel=1e-9, abs=1e-9)


def test_same_day_is_excluded():
    """The leakage rule: a player's own game day never informs that day."""
    pa = pd.DataFrame({"pid": [1, 1, 1], "day": [5.0, 5.0, 6.0], "y": [0, 0, 1]})
    s = R.decayed_asof(pa, "pid", 30.0).set_index("day")
    assert s.loc[5.0, "S_n"] == 0.0
    assert s.loc[6.0, "S_0"] == pytest.approx(2 * np.exp(-1 / 30))


def test_serving_equals_training_asof():
    """ratings_current(at_day=d) must equal ratings_asof's row for day d.

    This is the whole point of the module: the number a model was fitted on
    and the number production reads are the same function of the history.
    """
    pa = _pa(n=800, players=6, days=90, seed=3)
    league = R.league_asof(pa)
    cfg = R.RatingConfig(tau=40.0, k=(50, 100, 200, 400, 800, 150, 300))
    asof = R.ratings_asof(pa, "pid", league, cfg)
    d = float(pa["day"].max())
    L_now = league.set_index("day").loc[d].to_numpy()
    cur = R.ratings_current(pa, "pid", L_now, cfg, at_day=d).set_index("pid")
    rows = asof[asof["day"] == d].set_index("pid")
    assert len(rows)
    for pid, row in rows.iterrows():
        np.testing.assert_allclose(
            cur.loc[pid, [f"r_{c}" for c in range(R.NC)]].to_numpy(float),
            row[[f"r_{c}" for c in range(R.NC)]].to_numpy(float), rtol=1e-9)


def test_shrink_is_a_distribution_and_prior_at_zero_n():
    L = np.full((1, R.NC), 1 / R.NC)
    r = R.shrink(np.zeros((1, R.NC)), np.zeros(1), L, np.full(R.NC, 100.0))
    np.testing.assert_allclose(r, L)
    r2 = R.shrink(np.eye(R.NC)[:1] * 50, np.array([50.0]), L, np.full(R.NC, 10.0))
    assert r2.sum() == pytest.approx(1.0)
    assert r2[0, 0] > L[0, 0]


def test_tune_recovers_a_real_signal():
    """Players with genuinely different K rates: tuning must beat the league."""
    rng = np.random.default_rng(7)
    rows = []
    for pid, pk in enumerate(np.linspace(0.1, 0.4, 20)):
        for d in range(200):
            y = 0 if rng.random() < pk else int(rng.integers(1, R.NC))
            rows.append((pid, float(d), y))
    pa = pd.DataFrame(rows, columns=["pid", "day", "y"])
    league = R.league_asof(pa)
    mask = (pa["day"] >= 100).to_numpy()
    cfg = R.tune(pa, "pid", league, eval_mask=mask, taus=(60.0, 365.0),
                 ks=(10.0, 50.0, 400.0), verbose=False)
    assert cfg.logloss["rating"]["K"] < cfg.logloss["league"]["K"]
    assert R.RatingConfig.from_json(cfg.to_json()) == cfg


def test_event_vocabulary_covers_the_live_feed():
    """Every PA-ending event seen in production maps to a class or is excluded
    on purpose; a new eventType must be a decision, not a silent drop."""
    seen = ["field_out", "strikeout", "single", "walk", "double", "home_run",
            "force_out", "grounded_into_double_play", "hit_by_pitch", "sac_fly",
            "field_error", "sac_bunt", "triple", "intent_walk",
            "fielders_choice", "double_play", "fielders_choice_out",
            "strikeout_double_play", "other_out", "sac_fly_double_play",
            "triple_play"]
    excluded = {"caught_stealing_2b", "pickoff_1b", "catcher_interf",
                "wild_pitch", "mound_visit", "game_advisory"}
    for ev in seen:
        assert ev in R.EVENT_CLASS, ev
    assert not excluded & set(R.EVENT_CLASS)
