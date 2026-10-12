"""Tests for the Models page's judgement layer (dashboard/utils/models.py).

The page's job is to say what production serves and whether a validated run
ever reached it. Both went wrong quietly before: live versions were read from
`predictions` only, so every prop and game market showed as drifted, and a v3
run recorded as "completed" was indistinguishable from one being served.
Rows here are in the shapes the two pipelines actually write to `model_runs`.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd
import pytest

DASHBOARD = Path(__file__).resolve().parents[2] / "dashboard"
if str(DASHBOARD) not in sys.path:
    sys.path.insert(0, str(DASHBOARD))

M = pytest.importorskip("utils.models")


def _params() -> pd.DataFrame:
    return pd.DataFrame([
        {"market": "pitch_result", "version": "v2_20260809", "is_active": True,
         "type": "multinomial_logistic"},
        {"market": "pitch_result", "version": "v1_20260707", "is_active": False,
         "type": "multinomial_logistic"},
        {"market": "batter_hit", "version": "v2_20260924", "is_active": True,
         "type": "multinomial_logistic"},
        {"market": "pitcher_k", "version": "base_v1", "is_active": True,
         "type": "base_rate"},
        {"market": "game_moneyline", "version": "v1_20260707", "is_active": True,
         "type": "log5"},
        {"market": "batter_hr_rog", "version": "base_v1", "is_active": True,
         "type": "base_rate"},
    ])


def _runs() -> pd.DataFrame:
    return pd.DataFrame([
        {"market": "pitch_result", "created_at": "2026-08-09T14:15:36",
         "status": "promoted", "version": "v2_20260809", "config": {},
         "oos_metrics": {"logloss": 1.0161}, "holdout_metrics": {"logloss": 1.0178},
         "folds": [{"test_season": 2016, "metrics": {"logloss": 1.02}}]},
        {"market": "batter_hit", "created_at": "2026-09-24T23:08:06",
         "status": "promoted", "version": "v2_20260924", "config": {},
         "oos_metrics": {"logloss": 0.5238},
         "holdout_metrics": {"logloss": 0.5212, "calibration_ratio": 1.0116}},
        {"market": "batter_hit", "created_at": "2026-10-08T05:13:17",
         "status": "completed", "version": None,
         "config": {"pipeline": "markets_v3"},
         "oos_metrics": {"logloss": 0.6555, "slot_baseline_logloss": 0.6609},
         "holdout_metrics": {"logloss": 0.6623, "slot_baseline_logloss": 0.6667,
                             "calibration": 0.99}},
        {"market": "pitcher_bb", "created_at": "2026-10-08T05:13:18",
         "status": "completed", "version": None,
         "config": {"pipeline": "markets_v3"},
         "oos_metrics": {"logloss": 0.6704, "mae_expected": 1.0633,
                         "mae_train_mean": 1.0562},
         "holdout_metrics": {"logloss": 0.6845, "mae_expected": 1.0278,
                             "mae_train_mean": 1.0534, "calibration": 0.9022}},
        {"market": "workload", "created_at": "2026-10-08T05:13:19",
         "status": "completed", "version": None,
         "config": {"pipeline": "markets_v3"}, "oos_metrics": {},
         "holdout_metrics": None},
    ])


def test_live_stamps_takes_the_newest_row_per_market_across_tables():
    stamps = M.live_stamps(
        [{"market": "pitch_result", "model_version": "v2_20260809"},
         {"market": "pitch_result", "model_version": "v1_20260707"}],
        [{"market": "batter_hit", "model_version": "v2_20260924"}],
        [{"market": "pitch_result", "model_version": "stale"},
         {"market": "game_total", "model_version": "total_v1"}])
    assert stamps == {"pitch_result": "v2_20260809",
                      "batter_hit": "v2_20260924", "game_total": "total_v1"}


def test_production_separates_match_drift_inert_and_unscored():
    stamps = {"pitch_result": "v2_20260809", "batter_hit": "v2_20260924",
              "pitcher_k": "v3_20261008", "game_moneyline": "log5_v1"}
    state = M.production(_params(), stamps).set_index("market")["state"]
    assert state["pitch_result"] == "✅ match"
    assert state["batter_hit"] == "✅ match"   # stamped in projections, not predictions
    assert state["pitcher_k"] == "⚠️ drift"
    assert state["game_moneyline"] == "🚫 not read"
    assert state["batter_hr_rog"] == "— no live rows"
    assert len(state) == 5                     # the inactive v1 row is not listed


def test_scorecard_keeps_pipelines_apart_and_marks_what_is_served():
    card = M.scorecard(_runs(), _params()).set_index(["market", "pipeline"])
    assert ("workload", "markets_v3") not in card.index   # component, no metric

    v2, v3 = card.loc[("batter_hit", "v2")], card.loc[("batter_hit", "markets_v3")]
    assert v2["served"] == "yes" and v3["served"] == "no"
    assert v3["validation"] == 0.6555 and v3["val_baseline"] == 0.6609
    assert v3["test_2026"] == 0.6623 and v3["beats_baseline"] is True
    assert v2["test_calibration"] == 1.0116 and v2["beats_baseline"] is None


def test_scorecard_judges_starter_props_on_mae_not_logloss():
    bb = M.scorecard(_runs(), _params()).set_index("market").loc["pitcher_bb"]
    assert bb["metric"] == "mae_expected"
    assert bb["validation"] == 1.0633 and bb["val_baseline"] == 1.0562
    assert bb["beats_baseline"] is True        # on the holdout; validation lost


def test_scorecard_reports_v3_served_once_a_v3_row_is_active():
    params = pd.concat([_params(), pd.DataFrame([
        {"market": "pitcher_bb", "version": "v3_20261008", "is_active": True,
         "type": "starter_count"}])], ignore_index=True)
    bb = M.scorecard(_runs(), params).set_index("market").loc["pitcher_bb"]
    assert bb["served"] == "yes"


def test_unstaged_v3_lists_runs_that_never_reached_the_registry():
    assert M.unstaged_v3(_runs(), _params()) == ["batter_hit", "pitcher_bb",
                                                 "workload"]
    staged = pd.concat([_params(), pd.DataFrame([
        {"market": "batter_hit", "version": "v3_20261008", "is_active": False,
         "type": "batter_game"}])], ignore_index=True)
    assert M.unstaged_v3(_runs(), staged) == ["pitcher_bb", "workload"]


def test_fold_frame_reads_both_fold_shapes():
    v2 = M.fold_frame([{"test_season": 2016, "metrics": {"logloss": 1.02}}])
    assert v2.to_dict("records") == [
        {"season": 2016, "metric": "logloss", "model": 1.02, "baseline": None}]
    v3 = M.fold_frame([{"season": 2018, "logloss": 0.647,
                        "slot_baseline_logloss": 0.654}])
    assert v3.to_dict("records") == [
        {"season": 2018, "metric": "logloss", "model": 0.647, "baseline": 0.654}]
    assert M.fold_frame(None).empty and M.fold_frame([{"season": 2018}]).empty


def test_live_calibration_is_predicted_over_observed_and_ignores_voids():
    rows = ([{"market": "batter_hr", "model_version": "v2", "probability": "0.12",
              "result": "hit"}]
            + [{"market": "batter_hr", "model_version": "v2", "probability": 0.12,
                "result": "miss"}] * 9
            + [{"market": "batter_hr", "model_version": "v2", "probability": 0.9,
                "result": "void"}])
    out = M.live_calibration(rows).iloc[0]
    assert out["n"] == 10 and out["observed"] == 0.1
    assert out["mean_predicted"] == 0.12 and out["ratio"] == 1.2
    assert M.live_calibration([]).empty
    assert M.live_calibration([{"market": "m", "model_version": "v",
                                "probability": 0.5, "result": "void"}]).empty
