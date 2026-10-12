"""The promotion rule and the lab doc's generated blocks (modeling/report.py).

The metric dicts are the ones the 2026-10-08 markets_v3 run recorded, so the
rule is pinned to the judgements already made by hand on that run: everything
promotable except pitcher_bb.
"""

from __future__ import annotations

import pandas as pd
import pytest

from modeling import report as R

BATTER_HR = {
    "oos": {"logloss": 0.353725, "uncalibrated_logloss": 0.353617,
            "slot_baseline_logloss": 0.360107, "calibration": 0.986448},
    "hold": {"logloss": 0.349099, "uncalibrated_logloss": 0.349233,
             "slot_baseline_logloss": 0.355039, "calibration": 0.9723,
             "uncalibrated_calibration": 0.9568, "base_rate": 0.1156},
}
PITCHER_BB = {
    "oos": {"logloss": 0.670412, "uncalibrated_logloss": 0.676197,
            "mae_expected": 1.06332, "mae_train_mean": 1.056168},
    "hold": {"logloss": 0.684526, "mae_expected": 1.0278,
             "mae_train_mean": 1.0534, "calibration": 0.9022,
             "base_rate": 0.4951},
}
MONEYLINE = {
    "oos": {"logloss": 0.675029, "uncalibrated_logloss": 0.677025,
            "production_log5_logloss": 0.70844,
            "home_rate_baseline_logloss": 0.691306},
    "hold": {"logloss": 0.682139, "uncalibrated_logloss": 0.683676,
             "production_log5_logloss": 0.717861,
             "home_rate_baseline_logloss": 0.691555, "calibration": 1.0012,
             "base_rate": 0.5285},
}
PA_OUTCOME = {
    "oos": {"logloss": 1.435881, "league_only": 1.46163, "log5": 1.438274},
    "hold": {"logloss": 1.431526, "hit_calibration": 1.000545,
             "hr_calibration": 0.961185, "k_calibration": 0.999699,
             "bb_calibration": 0.948079},
}


def test_the_2026_10_08_run_is_judged_as_it_was_by_hand():
    assert R.verdict(BATTER_HR["oos"], BATTER_HR["hold"])["ok"]
    assert R.verdict(MONEYLINE["oos"], MONEYLINE["hold"])["ok"]

    bb = R.verdict(PITCHER_BB["oos"], PITCHER_BB["hold"])
    assert not bb["ok"]
    assert bb["reasons"] == ["validation mae_expected 1.0633 does not beat "
                             "pitcher's training-season mean 1.0562"]

    pa = R.verdict(PA_OUTCOME["oos"], PA_OUTCOME["hold"])
    assert pa["ok"] and pa["notes"] == ["test baseline not recorded"]


def test_a_dropped_calibrator_is_judged_on_what_ships():
    """batter_hr ships without its calibrator, so its 2026 calibration is the
    raw 0.957, not the 0.972 recorded under the plain key."""
    assert R._shipped(BATTER_HR["oos"], BATTER_HR["hold"]) == (0.349233, 0.9568)
    assert R._shipped(MONEYLINE["oos"], MONEYLINE["hold"]) == (0.682139, 1.0012)


def test_a_market_must_beat_its_best_baseline():
    oos = dict(MONEYLINE["oos"], logloss=0.70, uncalibrated_logloss=0.71)
    v = R.verdict(oos, MONEYLINE["hold"])       # beats log5, loses to home rate
    assert not v["ok"] and "0.6913" in v["reasons"][0]


def test_calibration_band_is_wider_for_a_rare_event():
    hold = dict(BATTER_HR["hold"], uncalibrated_calibration=0.87)
    assert R.verdict(BATTER_HR["oos"], hold)["ok"]            # rare: +/-0.15
    hold = dict(MONEYLINE["hold"], calibration=0.87)
    v = R.verdict(MONEYLINE["oos"], hold)                     # common: +/-0.10
    assert v["reasons"] == ["test calibration 0.870 outside 1 ± 0.10"]
    hold = dict(PA_OUTCOME["hold"], k_calibration=0.88, bb_calibration=0.88)
    v = R.verdict(PA_OUTCOME["oos"], hold)
    assert v["reasons"] == ["test k_calibration 0.880 outside 1 ± 0.10"]


def test_missing_test_and_regression_against_the_champion_are_refused():
    assert R.verdict(MONEYLINE["oos"], None)["reasons"] == \
        ["no 2026 test recorded"]
    champ = dict(MONEYLINE["oos"], logloss=0.650)
    v = R.verdict(MONEYLINE["oos"], MONEYLINE["hold"], champion_oos=champ)
    assert not v["ok"] and "worse than the champion" in v["reasons"][0]
    near = dict(MONEYLINE["oos"], logloss=0.670)
    assert R.verdict(MONEYLINE["oos"], MONEYLINE["hold"], champion_oos=near)["ok"]


def test_components_pass_with_a_note():
    assert R.verdict({}, None) == {"ok": True, "reasons": [],
                                   "notes": ["component; no market metric"]}


def test_scorecard_by_proposal_keeps_challengers_beside_the_champion():
    def run(created, proposal, ll):
        cfg = {"pipeline": "markets_v3"}
        if proposal:
            cfg["proposal"] = proposal
        return {"market": "batter_hr", "created_at": created, "status": "completed",
                "version": None, "config": cfg,
                "oos_metrics": dict(BATTER_HR["oos"], logloss=ll),
                "holdout_metrics": BATTER_HR["hold"]}

    runs = pd.DataFrame([run("2026-10-08", None, 0.353725),
                         run("2026-10-20", "P-006", 0.3400),
                         run("2026-10-21", "P-006", 0.3390)])
    card = R.scorecard(runs, pd.DataFrame(), by_proposal=True)
    assert card[["proposal", "run"]].values.tolist() == \
        [["", "2026-10-08"], ["P-006", "2026-10-21"]]
    assert card["promotable"].tolist() == ["yes", "yes"]
    assert len(R.scorecard(runs, pd.DataFrame())) == 1


def test_fetch_all_pages_past_the_1000_row_response_cap():
    class Query:
        def __init__(self, n):
            self.n = n

        def range(self, a, b):
            self.a, self.b = a, b
            return self

        def execute(self):
            rows = [{"i": i} for i in range(self.a, min(self.b + 1, self.n))]
            return type("Resp", (), {"data": rows})()

    assert len(R.fetch_all(lambda: Query(2350))) == 2350
    assert len(R.fetch_all(lambda: Query(1000))) == 1000
    assert R.fetch_all(lambda: Query(0)) == []
    assert len(R.fetch_all(lambda: Query(9000), cap=3000)) == 3000


def test_replace_block_only_touches_its_own_markers():
    doc = ("# Lab\nhand\n<!-- lab:begin leaderboard -->\nold\n"
           "<!-- lab:end leaderboard -->\nkeep\n"
           "<!-- lab:begin readiness -->\nr\n<!-- lab:end readiness -->\n")
    out = R.replace_block(doc, "leaderboard", "| a |\n|---|\n")
    assert out == doc.replace("old\n", "| a |\n|---|\n")
    assert R.replace_block(out, "leaderboard", "| a |\n|---|") == out   # idempotent
    with pytest.raises(ValueError):
        R.replace_block(doc, "missing", "x")


def test_leaderboard_renders_serving_runs_and_live_record():
    params = pd.DataFrame([{"market": "batter_hr", "version": "v2_20260924",
                            "is_active": True, "type": "multinomial_logistic"}])
    runs = pd.DataFrame([{"market": "batter_hr", "created_at": "2026-10-08",
                          "status": "completed", "version": None,
                          "config": {"pipeline": "markets_v3"},
                          "oos_metrics": BATTER_HR["oos"],
                          "holdout_metrics": BATTER_HR["hold"]}])
    graded = ([{"market": "batter_hr", "model_version": "v2_20260924",
                "probability": 0.12, "result": "hit"}]
              + [{"market": "batter_hr", "model_version": "v2_20260924",
                  "probability": 0.12, "result": "miss"}] * 9)
    games = [{"market": "game_total", "model_version": "total_v1",
              "confidence": 0.51, "result": "win"},
             {"market": "game_total", "model_version": "total_v1",
              "confidence": 0.51, "result": "loss"},
             {"market": "game_total", "model_version": "total_v1",
              "confidence": 0.51, "result": "push"}]
    md = R.render_leaderboard(params, runs,
                              R.live_stamps(graded, games), graded, games,
                              "2026-10-12")
    assert "| batter_hr | v2_20260924 | v2_20260924 | ✅ match |" in md
    assert "Scored with no registry row: `game_total` → `total_v1`." in md
    assert "Validated v3 runs not staged: `batter_hr`." in md
    assert "| batter_hr | markets_v3 |  | 2026-10-08 | logloss | 0.3536 | " \
           "0.3601 | 0.3492 | 0.3550 | 0.9568 | yes | no |" in md
    assert "| batter_hr | v2_20260924 | 10 | 0.1200 | 0.1000 | 1.2000 |" in md
    assert "| game_total | total_v1 | 2 | 0.5100 | 0.5000 |" in md
