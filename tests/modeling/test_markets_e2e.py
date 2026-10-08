"""markets.run end to end on a synthetic league -- shapes, joins and folds."""

from __future__ import annotations

import numpy as np
import pytest

from modeling import games as G
from modeling import markets as M
from modeling import pa_model as P

from .synthetic_league import league


@pytest.fixture(scope="module")
def result():
    pa, box = league()
    mp = pytest.MonkeyPatch()
    mp.setattr(P, "load_pa", lambda store: pa.copy())
    mp.setattr(G, "load_box", lambda store: box.copy())
    mp.setattr(P, "WALK_FORWARD", (2018, 2019))
    mp.setattr(P, "HOLDOUT", 2019)
    mp.setattr(M, "SEASONS", (2016, 2017, 2018, 2019))
    mp.setattr(M, "TEST_SEASONS", (2018, 2019))
    out = M.run(store=None, record=False)
    mp.undo()
    return out


def test_every_market_reports_and_ships_params(result):
    rep, final = result["report"], result["final"]
    for m in M.BATTER_MARKETS + M.STARTER_MARKETS + ("game_moneyline", "game_total"):
        assert m in rep, m
        assert rep[m]["folds"], m
    for m in M.BATTER_MARKETS + M.STARTER_MARKETS + (
            "pa_outcome", "workload", "team_runs", "game_moneyline"):
        assert m in final, m
    assert "ratings" in final["pa_outcome"]


def test_batter_probabilities_are_sane(result):
    for m in M.BATTER_MARKETS:
        f = result["report"][m]["folds"][-1]
        assert 0.0 < f["logloss"] < 1.0, (m, f)
        assert 0.5 < f["calibration"] < 1.6, (m, f)


def test_workload_params_shape(result):
    wl = result["final"]["workload"]
    assert set(wl["outs"]) >= {"coef", "intercept", "residual_pmf", "features"}
    assert abs(sum(wl["outs"]["residual_pmf"].values()) - 1) < 1e-3
    assert "1H" in wl["pa_pmf"] and len(wl["pa_pmf"]["1H"]) == 9
