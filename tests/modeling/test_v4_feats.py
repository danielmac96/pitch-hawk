"""v4 features never see their own day or the future.

The test that matters: change every outcome on day D and after, rebuild, and
no feature on any row dated <= D may move. Then the converse, that a
feature on a later day DOES move, so the first assertion is not passing
because nothing is computed at all.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from modeling.v4 import feats as F
from tests.modeling.synthetic_league import league


@pytest.fixture(scope="module")
def box():
    _, b = league(seasons=(2016, 2017), days=25)
    return b


def _perturb(box: pd.DataFrame, day: int) -> pd.DataFrame:
    b = box.copy()
    m = b["day"] >= day
    for c in ("h", "hr", "tb", "bb", "k", "r", "rbi", "p_k", "p_bb", "p_h", "p_er",
              "p_outs"):
        if c in b:
            b.loc[m, c] = b.loc[m, c] * 3 + 1
    return b


@pytest.mark.parametrize("builder,role", [
    (F.batter_form, "bat"), (F.starter_form, "sp")])
def test_no_feature_sees_its_own_day(box, builder, role):
    rows = box[box["pa"].notna()] if role == "bat" else \
        box[box["p_started"].fillna(False).astype(bool)]
    rows = rows.reset_index(drop=True)
    D = int(np.sort(rows["day"].unique())[len(rows["day"].unique()) // 2])
    a = builder(rows, box)
    b = builder(rows, _perturb(box, D))
    early = (rows["day"] <= D).to_numpy()
    pd.testing.assert_frame_equal(a[early].reset_index(drop=True),
                                  b[early].reset_index(drop=True))
    late = (rows["day"] > D).to_numpy()
    assert not np.allclose(a[late].fillna(0).to_numpy(), b[late].fillna(0).to_numpy())


def test_season_to_date_resets_each_season(box):
    rows = box[box["pa"].notna()].reset_index(drop=True)
    f = F.batter_form(rows, box)
    first_day = rows.groupby("season")["day"].transform("min") == rows["day"]
    # No history this season: the season rate is the prior, exactly.
    assert np.allclose(f.loc[first_day, "bf_h_szn"], F.BAT_PRIOR["h"])
    # But the 50-game window does carry last season.
    later_season = first_day & (rows["season"] == 2017)
    assert not np.allclose(f.loc[later_season, "bf_h_g50"], F.BAT_PRIOR["h"])


def test_asof_prior_is_strict():
    table = pd.DataFrame({"k": [1, 1, 1], "day": [10, 20, 30], "season": 2016,
                          "v": [1.0, 2.0, 3.0]})
    frame = pd.DataFrame({"k": [1, 1, 1, 2], "day": [10, 21, 30, 30], "season": 2016})
    got = F.asof_prior(frame, table, "k", "k", ["v"])["v"].to_list()
    assert np.isnan(got[0]) and got[1] == 2.0 and got[2] == 2.0 and np.isnan(got[3])


def test_rolling_window_counts_game_days():
    d = pd.DataFrame({"k": 1, "day": [1, 2, 5, 9], "season": 2016, "x": [1.0, 1, 1, 1]})
    r = F.rolling(d, "k", ["x"], {"w2": 2, "szn": None})
    assert r["x_w2"].to_list() == [1, 2, 2, 2]
    assert r["x_szn"].to_list() == [1, 2, 3, 4]
