"""The v4 dashboard's judgements, on rows the recorder actually writes."""

from __future__ import annotations

import pandas as pd
import pytest

from modeling.v4 import ladder as LD
from modeling.v4 import record as REC
from modeling.v4 import report as V

from .test_v4_ladder import _frame, _md


@pytest.fixture(scope="module")
def recorded():
    md = _md("binary")
    lad, res = LD.run_market(md, _frame("binary", n_per=800),
                             test_seasons=(2018, 2019, 2020, 2026),
                             iterations=["i0_baseline", "i1_incumbent", "i2_glm", "i3_gbm"])
    rows = REC.runs_for(lad, res, git_sha="abc", version="v4_t")
    t0 = pd.Timestamp("2026-10-15T12:00:00Z")
    for i, r in enumerate(rows):
        r["created_at"] = t0 + pd.Timedelta(seconds=i)
    # A second, later batch with a different sha: the iteration history.
    rows2 = REC.runs_for(lad, res, git_sha="def", version="v4_u")
    for i, r in enumerate(rows2):
        r["created_at"] = t0 + pd.Timedelta(hours=3, seconds=i)
    bf = REC.backfill_frame(lad, res, run_id="r", version="v4_t")
    return md, pd.DataFrame(rows + rows2), REC.daily_rollup(md, bf)


def test_overview_one_row_per_market_from_latest_batch(recorded):
    md, runs, _ = recorded
    ov = V.overview(V.v4_runs(runs))
    assert list(ov["market"]) == [md.name]
    assert ov["batches"].iat[0] == 2 and ov["rungs tried"].iat[0] == 4
    assert ov["validation"].iat[0] < ov["val baseline"].iat[0]


def test_ladder_and_history(recorded):
    md, runs, _ = recorded
    df = V.v4_runs(runs)
    lad = V.ladder(df, md.name)
    assert list(lad["rung"]) == ["i0_baseline", "i1_incumbent", "i2_glm", "i3_gbm"]
    assert (lad["chosen"] == "★").sum() == 1
    hist = V.history(df, md.name)
    assert len(hist) == 2 and list(hist["git"]) == ["abc", "def"]


def test_fold_reliability_importance_frames(recorded):
    md, runs, _ = recorded
    df = V.v4_runs(runs)
    row = df[df["chosen"]].iloc[0]
    fl = V.folds_long(row)
    assert set(fl["series"]) == {"v4 model", "baseline", "incumbent"}
    assert set(fl["season"]) == {2018, 2019, 2020, 2026}
    assert not V.reliability(row).empty
    imp, kind = V.importance(row)
    assert len(imp) > 0 and kind


def test_daily_tracking(recorded):
    md, _, daily = recorded
    dl = V.daily_long(daily.assign(day=pd.to_datetime(daily["day"])), 7)
    assert set(dl["series"]) == {"v4 model", "incumbent", "baseline"}
    ss = V.season_summary(daily)
    assert ss["rows"].sum() == daily["n"].sum()
