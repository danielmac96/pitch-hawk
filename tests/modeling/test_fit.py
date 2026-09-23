"""Fitting, especially the recency-decay weighting."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from modeling.fit import HALF_LIVES, decay_weights, fit
from modeling.spec import get_spec


def test_half_lives_include_no_decay():
    assert None in HALF_LIVES, "the sweep must be able to choose no decay"


def test_decay_none_returns_raw_counts():
    seasons = np.array([2020, 2024])
    n = np.array([10.0, 10.0])
    assert np.allclose(decay_weights(seasons, n, None), n)


def test_decay_halves_at_one_half_life():
    """A season one half-life older gets exactly half the weight."""
    seasons = np.array([2025, 2024])
    n = np.array([100.0, 100.0])
    w = decay_weights(seasons, n, half_life=1.0)
    assert w[0] == pytest.approx(100.0)
    assert w[1] == pytest.approx(50.0)


def test_decay_is_monotonic_in_age():
    seasons = np.array([2026, 2024, 2020, 2015])
    n = np.ones(4) * 100
    w = decay_weights(seasons, n, half_life=2.0)
    assert list(w) == sorted(w, reverse=True)


def test_decay_never_zero():
    """An 11-season-old cell must still contribute something."""
    w = decay_weights(np.array([2015]), np.array([100.0]), half_life=1.0)
    assert w[0] > 0.0


def _cells() -> pd.DataFrame:
    """Synthetic cells where strikes strongly predict strike_foul."""
    rows = []
    for season in (2023, 2024):
        for strikes in (0, 1, 2):
            for outcome, base in (("strike_foul", 30), ("ball", 30),
                                  ("in_play", 20)):
                n = base + (25 * strikes if outcome == "strike_foul" else 0)
                rows.append({"season": season, "balls": 0, "strikes": strikes,
                             "outcome": outcome, "n": float(n),
                             "career_zone_bucket": 0, "d30_zone_bucket": 0,
                             "d90_zone_bucket": 0})
    return pd.DataFrame(rows)


def test_fit_returns_coef_per_class():
    spec = get_spec("pitch_result")
    result = fit(spec, _cells(), form_window="career", half_life=None)
    assert result.family == "multinomial_logistic"
    assert len(result.coef) == len(spec.classes)
    assert len(result.intercept) == len(spec.classes)
    assert len(result.coef[0]) == len(spec.feature_names)


def test_fit_learns_the_planted_signal():
    spec = get_spec("pitch_result")
    result = fit(spec, _cells(), form_window="career", half_life=None)
    strike_class = spec.classes.index("strike_foul")
    strikes_feat = spec.feature_names.index("strikes")
    assert result.coef[strike_class][strikes_feat] > 0, \
        "more strikes should raise P(strike_foul) in the planted data"


def _multi_form_spec():
    """A market carrying pitcher form AND batter form at once."""
    from modeling.spec import FormFeature, MarketSpec

    return MarketSpec(
        market="two_sided",
        family="multinomial_logistic",
        cell_sql="select 1",
        feature_names=("balls", "pitcher_k_delta", "batter_k_delta",
                       "platoon_same"),
        classes=("a", "b"),
        primary_metric="logloss",
        metric_direction="lower",
        form_windows=("career", "d30"),
        to_params=lambda fit, window: {},
        form_features=(
            FormFeature("pitcher_k_delta", "p_k_bucket", 0.035),
            FormFeature("batter_k_delta", "b_k_bucket", 0.04, baseline=0.1),
        ),
        intercept_folded=("platoon_same",),
    )


def _two_sided_cells(n=6):
    """Cells carrying a SEPARATE bucket column per form dimension.

    Named apart from `_cells` above, which is the pitch_result fixture: one
    shadowing the other is how three unrelated tests started failing with a
    KeyError on a column neither of them was about.
    """
    return pd.DataFrame({
        "balls": np.arange(n) % 4,
        "strikes": np.arange(n) % 3,
        "career_p_k_bucket": np.arange(n) - 2,
        "career_b_k_bucket": np.arange(n)[::-1] - 2,
        "d30_p_k_bucket": np.zeros(n, dtype=int),
        "d30_b_k_bucket": np.zeros(n, dtype=int),
    })


def test_design_builds_one_column_per_form_dimension():
    """The engine change step 7 is for.

    Before it, `pitcher_k_delta` and `batter_k_delta` would have read the same
    array and `batter_k_delta` would in fact have been zeros -- so a two-sided
    market was not expressible at all.
    """
    from modeling.fit import _design

    spec = _multi_form_spec()
    X = _design(spec, _two_sided_cells(), "career")

    assert X.shape == (6, 4)
    # Each form column recovered as baseline + index * step, independently.
    np.testing.assert_allclose(X[:, 1], (np.arange(6) - 2) * 0.035)
    np.testing.assert_allclose(X[:, 2], 0.1 + (np.arange(6)[::-1] - 2) * 0.04)
    assert not np.allclose(X[:, 1], X[:, 2]), (
        "the two form columns are identical -- they are aliasing one array")


def test_design_folds_declared_features_to_zero():
    from modeling.fit import _design

    X = _design(_multi_form_spec(), _two_sided_cells(), "career")
    np.testing.assert_allclose(X[:, 3], 0.0)


def test_design_switches_every_form_column_with_the_window():
    """A form-window sweep must move ALL form dimensions together. Moving only
    the first would silently sweep one feature against a frozen other."""
    from modeling.fit import _design

    spec = _multi_form_spec()
    d30 = _design(spec, _two_sided_cells(), "d30")
    np.testing.assert_allclose(d30[:, 1], 0.0)
    np.testing.assert_allclose(d30[:, 2], 0.1)


def test_design_names_the_missing_cell_column():
    """A spec whose cell_sql forgot a bucket column should say which one."""
    from modeling.fit import _design

    spec = _multi_form_spec()
    cells = _two_sided_cells().drop(columns=["career_b_k_bucket"])
    with pytest.raises(ValueError, match="career_b_k_bucket"):
        _design(spec, cells, "career")


def test_design_offers_a_bias_column():
    """model.ts::featureValue returns 1 for `bias`; the engine had no builder
    for it, so a spec naming it would have raised."""
    from modeling.fit import _design
    from modeling.spec import MarketSpec

    spec = MarketSpec(
        market="with_bias", family="multinomial_logistic", cell_sql="select 1",
        feature_names=("bias", "balls"), classes=("a", "b"),
        primary_metric="logloss", metric_direction="lower",
        form_windows=("career",), to_params=lambda f, w: {},
    )
    X = _design(spec, _two_sided_cells(), "career")
    np.testing.assert_allclose(X[:, 0], 1.0)


def test_two_class_fit_matches_sklearn_predict_proba():
    """The binary expansion must reproduce the model that was fitted.

    sklearn returns ONE coefficient row for a two-class problem, meaning
    P(class 1) = sigmoid(z). model.ts scores a softmax over per-class logits,
    and softmax([-z, +z]) is sigmoid(2z) -- so mirroring the row at full
    magnitude ships a model twice as confident as the fit. Splitting z evenly
    is what makes softmax reproduce sigmoid(z).

    Unreachable before the two-class batter markets: every earlier market has
    three or more classes and never took this branch. It was wrong the whole
    time and nothing noticed, which is why this test is worth its length.
    """
    from sklearn.linear_model import LogisticRegression

    from modeling.fit import _design, fit as do_fit
    from modeling.spec import FormFeature, MarketSpec

    rng = np.random.default_rng(7)
    n = 240
    cells = pd.DataFrame({
        "season": 2024,
        "balls": 0,
        "strikes": 0,
        "career_b_bucket": rng.integers(-8, 9, n),
        "career_p_bucket": rng.integers(-6, 7, n),
        "outcome": rng.choice(["yes", "no"], n),
        "n": rng.integers(50, 400, n).astype(float),
    })
    spec = MarketSpec(
        market="binary", family="multinomial_logistic", cell_sql="select 1",
        feature_names=("batter_hr_delta", "pitcher_hr_delta"),
        classes=("no", "yes"), primary_metric="logloss",
        metric_direction="lower", form_windows=("career",),
        to_params=lambda f, w: {},
        form_features=(FormFeature("batter_hr_delta", "b_bucket", 0.005),
                       FormFeature("pitcher_hr_delta", "p_bucket", 0.004)),
    )

    result = do_fit(spec, cells, form_window="career", half_life=None)

    X = _design(spec, cells, "career")
    y = np.array([spec.classes.index(o) for o in cells["outcome"]])
    w = cells["n"].to_numpy(float)
    reference = LogisticRegression(max_iter=5000, C=10.0)
    reference.fit(X, y, sample_weight=w)
    want = reference.predict_proba(X)[:, 1]

    # Score the expanded params exactly as model.ts does: softmax over logits.
    coef = np.array(result.coef)
    logits = np.array(result.intercept) + X @ coef.T
    shifted = logits - logits.max(axis=1, keepdims=True)
    exp = np.exp(shifted)
    got = (exp / exp.sum(axis=1, keepdims=True))[:, 1]

    np.testing.assert_allclose(got, want, atol=1e-9)


def test_two_class_fit_is_calibrated_in_the_large():
    """The symptom the halving bug showed up as.

    A logistic fit with an unpenalised intercept reproduces the base rate on
    average. Doubling every logit destroys that, which is what the calibration
    gate would have caught at promotion -- and what it should never have to.
    """
    from modeling.fit import _design, fit as do_fit
    from modeling.spec import FormFeature, MarketSpec

    rng = np.random.default_rng(3)
    n = 300
    buckets = rng.integers(-10, 11, n)
    # Positive rate rises with the bucket, so the fit has real signal.
    p = 1 / (1 + np.exp(-(0.25 * buckets)))
    rows = []
    for b, pi in zip(buckets, p):
        total = int(rng.integers(100, 400))
        yes = int(round(total * pi))
        rows.append({"season": 2024, "balls": 0, "strikes": 0,
                     "career_b_bucket": b, "outcome": "yes", "n": float(yes)})
        rows.append({"season": 2024, "balls": 0, "strikes": 0,
                     "career_b_bucket": b, "outcome": "no",
                     "n": float(total - yes)})
    cells = pd.DataFrame(rows)

    spec = MarketSpec(
        market="binary_cal", family="multinomial_logistic", cell_sql="select 1",
        feature_names=("batter_hr_delta",), classes=("no", "yes"),
        primary_metric="logloss", metric_direction="lower",
        form_windows=("career",), to_params=lambda f, w: {},
        form_features=(FormFeature("batter_hr_delta", "b_bucket", 0.5),),
        positive_class="yes", calibration_band=(0.9, 1.1),
    )
    result = do_fit(spec, cells, form_window="career", half_life=None)

    from modeling.validate import evaluate
    ratio = evaluate(spec, result, cells, "career")["calibration_ratio"]
    assert 0.95 <= ratio <= 1.05, (
        f"in-sample calibration ratio {ratio} -- an unpenalised intercept "
        f"should reproduce the base rate")


def test_fit_rejects_unknown_form_window():
    spec = get_spec("pitch_result")
    with pytest.raises(ValueError, match="form_window"):
        fit(spec, _cells(), form_window="d365", half_life=None)
