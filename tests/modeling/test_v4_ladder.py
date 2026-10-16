"""The v4 ladder end to end on small synthetic frames, one per kind.

Each frame has a real signal in `x1` (and a stacked 'v3' column that knows
part of it), so a working ladder must: run every candidate on every fold,
choose a model that beats the baseline, never let 2026 into the choice,
and produce a backfill whose per-row losses average to the fold metrics.
"""

from __future__ import annotations

import dataclasses

import numpy as np
import pandas as pd
import pytest

from modeling.v4 import catalog as C
from modeling.v4 import evaluate as E
from modeling.v4 import ladder as LD
from modeling.v4 import record as REC
from modeling.v4 import storage as S
from warehouse.store import LocalStore

SEASONS = (2016, 2017, 2018, 2019, 2020, 2026)


def _frame(kind: str, n_per: int = 1500, seed: int = 0) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    rows = []
    for s in SEASONS:
        x1, x2 = rng.normal(size=n_per), rng.normal(size=n_per)
        grp = rng.integers(1, 10, n_per)
        z = 0.9 * x1 + 0.3 * np.sin(3 * x2) + 0.05 * grp
        df = pd.DataFrame({"season": s, "x1": x1, "x2": x2, "grp": grp,
                           "game_pk": np.arange(n_per) + s * 10_000,
                           "player_id": grp,
                           "day": (s - 2015) * 400 + rng.integers(0, 180, n_per)})
        df["game_date"] = pd.Timestamp("2015-01-01") + pd.to_timedelta(df["day"], "D")
        if kind == "binary":
            p = 1 / (1 + np.exp(-(z - 0.4)))
            df["y"] = (rng.random(n_per) < p).astype(int)
            df["v3"] = 1 / (1 + np.exp(-(0.6 * x1 - 0.4)))
        elif kind == "multiclass":
            logits = np.column_stack([z, -z, 0.3 * x2])
            P = np.exp(logits) / np.exp(logits).sum(1, keepdims=True)
            df["y"] = [rng.choice(3, p=q) for q in P]
            df["v3"] = 0.5 * x1
        elif kind == "count":
            df["y"] = rng.poisson(np.exp(1.2 + 0.4 * z))
            df["v3"] = np.exp(1.2 + 0.3 * x1)
            for k in range(13):
                from scipy import stats
                df[f"v3pmf_{k}"] = stats.poisson.pmf(k, df["v3"]) if k < 12 else \
                    1 - stats.poisson.cdf(11, df["v3"])
        else:
            df["y"] = 90 + 2 * z + rng.normal(0, 1 + 0.5 * (x2 > 0), n_per)
            df["v3"] = 90 + 1.5 * x1
        df["is_post"] = 0
        # The last 10% of each season's rows play as its postseason.
        df.loc[df.index[-n_per // 10:], "is_post"] = 1
        rows.append(df)
    return pd.concat(rows, ignore_index=True)


def _md(kind: str) -> C.MarketDef:
    inc = {"binary": C.Incumbent("prob", ("v3",), "toy v3"),
           "count": C.Incumbent("pmf", ("v3pmf_",), "toy v3 pmf"),
           "gaussian": C.Incumbent("gauss", ("v3",), "toy v3 mean"),
           "multiclass": None}[kind]
    return C.MarketDef(
        name=f"toy_{kind}", grain="toy", kind=kind, target="y", outcome="toy",
        keys=("game_pk", "player_id"), features=("x1", "x2", "grp", "missing_col"),
        stack=("v3",), classes=("a", "b", "c") if kind == "multiclass" else (),
        cap=12 if kind == "count" else 0, line=3.5 if kind == "count" else None,
        baseline_group="grp" if kind != "gaussian" else None, incumbent=inc,
        max_train_rows=4000, tune_rows=2000)


@pytest.fixture(scope="module", params=["binary", "multiclass", "count", "gaussian"])
def ran(request):
    kind = request.param
    md, fr = _md(kind), _frame(kind)
    lad, res = LD.run_market(md, fr, test_seasons=(2018, 2019, 2020, 2026))
    return kind, md, lad, res


def test_every_candidate_scores_every_fold(ran):
    kind, md, lad, res = ran
    R = res["results"]
    expected = {"i0_baseline", "i2_glm", "i3_gbm", "i4_gbm_stack", "i5_tuned",
                "i6_calibrated"}
    if md.incumbent:
        expected.add("i1_incumbent")
    if kind == "count":
        expected.add("i3m_gbm_multiclass")
    assert expected <= set(R), set(R)
    for it, c in R.items():
        assert [f["season"] for f in c.folds] == [2018, 2019, 2020, 2026], it
        assert c.oos["folds_used"] == 2, it  # 2020 and 2026 excluded
        assert c.holdout is not None and c.holdout["season"] == 2026


def test_declared_but_missing_features_are_dropped(ran):
    _, _, lad, _ = ran
    assert "missing_col" not in lad.feats and "x1" in lad.feats


def test_chosen_model_beats_the_baseline(ran):
    kind, md, lad, res = ran
    R = res["results"]
    chosen = R[res["chosen"]]
    assert res["chosen"] in LD.MODEL_ITERATIONS
    assert chosen.primary < R["i0_baseline"].primary, (kind, chosen.primary)


def test_choice_ignores_the_2026_test(ran):
    """Rewriting every candidate's 2026 numbers must not change the choice."""
    kind, md, lad, res = ran
    before = res["chosen"]
    for c in lad.results.values():
        c.holdout = {**(c.holdout or {}), "primary": -1e9}
    assert lad.select()["chosen"] == before


def test_backfill_losses_average_to_the_fold_metric(ran, tmp_path):
    kind, md, lad, res = ran
    bf = REC.backfill_frame(lad, res, run_id="r1", version="v4_test")
    c = res["results"][res["chosen"]]
    for f in c.folds:
        got = float(bf.loc[(bf["season"] == f["season"])
                           & (bf["source"] != "postseason"), "loss"].mean())
        assert got == pytest.approx(f["primary"], rel=1e-3, abs=1e-4), (kind, f["season"])
    assert set(bf["source"]) == {"walk_forward", "test_2026", "postseason"}
    post = bf[bf["source"] == "postseason"]
    assert len(post) == len(lad.post_frame[lad.post_frame["season"].isin(lad.seasons)])
    assert post["loss"].mean() == pytest.approx(c.post["primary"], rel=1e-3, abs=1e-4)
    daily = REC.daily_rollup(md, bf)
    assert daily["n"].sum() == len(bf)
    if md.incumbent:
        assert "incumbent_loss" in daily


def test_runs_record_every_candidate_with_one_chosen(ran):
    kind, md, lad, res = ran
    rows = REC.runs_for(lad, res, git_sha="abc", artifact_key="k", version="v4_x")
    assert len(rows) == len(res["results"])
    chosen = [r for r in rows if r["config"]["chosen"]]
    assert len(chosen) == 1 and chosen[0]["status"] in ("stageable", "held")
    assert chosen[0]["version"] == "v4_x" and chosen[0]["params"]["artifact"] == "k"
    for r in rows:
        assert r["config"]["pipeline"] == "v4"
        assert r["oos_metrics"]["primary"] is not None
        assert r["oos_metrics"]["baseline_primary"] is not None


def test_persist_writes_backfill_and_artifact(ran, tmp_path):
    kind, md, lad, res = ran
    store = LocalStore(tmp_path)
    out = REC.persist(store, lad, res, record=False, publish=False)
    assert out["backfill_rows"] == len(S.get_backfill(store, md.name))
    model, meta = S.get_artifact(store, md.name)
    te = lad.frame[lad.season == 2026]
    pred = model.predict(te)
    assert len(pred) == len(te)
    assert meta["iteration"] == res["chosen"]


def test_gate_holds_a_model_that_loses_to_the_incumbent():
    from modeling.v4 import gate
    md = _md("binary")
    mk = lambda v, t: {"oos": {"logloss": v}, "holdout": {"logloss": t, "calibration": 1.0,  # noqa: E731
                                                           "base_rate": 0.4},
                       "folds": [{"season": 2018, "logloss": v}]}
    v = gate.judge(md, mk(0.60, 0.60), mk(0.70, 0.70), mk(0.59, 0.59))
    assert not v["ok"] and any("incumbent" in r for r in v["reasons"])
    assert gate.judge(md, mk(0.58, 0.58), mk(0.70, 0.70), mk(0.59, 0.59))["ok"]


def test_evaluate_count_rps_matches_row_losses():
    rng = np.random.default_rng(1)
    pmf = rng.dirichlet(np.ones(6), 200)
    y = rng.integers(0, 6, 200)
    assert E.count(pmf, y)["rps"] == pytest.approx(
        REC.row_loss("count", pmf, y).mean(), rel=1e-6)


def test_catalogue_covers_every_served_market():
    served = {"batter_hit", "batter_hr", "batter_tb15", "batter_hrr", "pitcher_k",
              "pitcher_bb", "pitcher_hits", "pitcher_outs", "pitcher_er",
              "game_moneyline", "game_total", "pitch_result", "pitch_speed_ou",
              "ab_result", "ab_pitches_ou", "batter_hit_rog", "batter_hr_rog",
              "game_total_live"}
    assert served <= set(C.MARKETS)
    for m in C.MARKETS.values():
        assert dataclasses.asdict(m)["kind"] in E.PRIMARY
        if m.kind == "count":
            assert m.cap > 0 and m.line is not None
        if m.kind == "multiclass":
            assert len(m.classes) >= 3


def test_postseason_is_scored_never_trained(ran):
    kind, md, lad, res = ran
    assert len(lad.post_frame) and not lad.frame["is_post"].any()
    for it, c in res["results"].items():
        assert c.post["seasons"] == [2018, 2019, 2020, 2026], it
        assert [f["season"] for f in c.post_folds] == [2018, 2019, 2020, 2026]
    rows = REC.runs_for(lad, res, git_sha=None)
    ch = next(r for r in rows if r["config"]["chosen"])
    assert ch["oos_metrics"]["postseason"]["primary"] is not None
    assert ch["calibration"]["postseason_by_season"]
