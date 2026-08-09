"""Metrics, verified against hand-computable cases.

Every one of these has a known closed-form answer, so a wrong implementation
cannot hide behind a plausible-looking number.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from modeling.metrics import (brier, calibration_bins, ece, logloss, rmse,
                              sigma_coverage, sigma_coverage_cells)


def test_logloss_perfect_prediction_is_zero():
    y = np.array([0, 1])
    p = np.array([[1.0, 0.0], [0.0, 1.0]])
    assert logloss(y, p, np.ones(2)) == pytest.approx(0.0, abs=1e-9)


def test_logloss_uniform_two_class_is_ln2():
    y = np.array([0, 1])
    p = np.array([[0.5, 0.5], [0.5, 0.5]])
    assert logloss(y, p, np.ones(2)) == pytest.approx(math.log(2), abs=1e-9)


def test_logloss_respects_weights():
    """A heavily weighted confident-correct row must pull the mean down."""
    y = np.array([0, 0])
    p = np.array([[0.5, 0.5], [1.0, 0.0]])
    unweighted = logloss(y, p, np.array([1.0, 1.0]))
    weighted = logloss(y, p, np.array([1.0, 99.0]))
    assert weighted < unweighted


def test_logloss_clips_zero_probability():
    """A confident wrong answer must be finite, not inf."""
    y = np.array([1])
    p = np.array([[1.0, 0.0]])
    assert math.isfinite(logloss(y, p, np.ones(1)))


def test_brier_perfect_is_zero():
    y = np.array([0, 1])
    p = np.array([[1.0, 0.0], [0.0, 1.0]])
    assert brier(y, p, np.ones(2)) == pytest.approx(0.0, abs=1e-9)


def test_rmse_known_value():
    y = np.array([1.0, 2.0, 3.0])
    yhat = np.array([2.0, 2.0, 2.0])
    # residuals 1, 0, 1 -> mean square 2/3 -> sqrt
    assert rmse(y, yhat, np.ones(3)) == pytest.approx(math.sqrt(2 / 3))


def test_sigma_coverage_normal_is_about_68_percent():
    rng = np.random.default_rng(0)
    y = rng.normal(0.0, 5.0, 20000)
    yhat = np.zeros(20000)
    cov = sigma_coverage(y, yhat, 5.0, np.ones(20000))
    assert 0.66 < cov < 0.70


def test_sigma_coverage_detects_understated_sigma():
    """The failure this metric exists to catch: good RMSE, wrong sigma."""
    rng = np.random.default_rng(0)
    y = rng.normal(0.0, 5.0, 20000)
    cov = sigma_coverage(y, np.zeros(20000), 1.0, np.ones(20000))
    assert cov < 0.30, "an understated sigma must show as low coverage"


def test_cell_sigma_coverage_matches_the_row_grain_answer():
    """Aggregating rows into cells must not change the coverage number.

    Same 20k draws, once as raw rows and once summarised as (mean, var, n)
    cells. If the cell-grain formula is right the two agree closely.
    """
    rng = np.random.default_rng(0)
    y = rng.normal(92.0, 5.0, 20000)
    rows = sigma_coverage(y, np.full(20000, 92.0), 5.0, np.ones(20000))

    cells = sigma_coverage_cells(
        cell_mean=np.array([y.mean()]), cell_var=np.array([y.var()]),
        yhat=np.array([92.0]), sigma=5.0, w=np.array([20000.0]))
    assert cells == pytest.approx(rows, abs=0.01)
    assert 0.66 < cells < 0.70


def test_cell_sigma_coverage_still_detects_understated_sigma():
    """The veto must keep working at cell grain, or it is decoration.

    A pitch-level sd of 5 with sigma claimed as 1 has to read far below the
    [0.63, 0.73] band -- this is the exact case a naive cell-grain coverage
    misses, because the cell MEAN sits right on the prediction.
    """
    cov = sigma_coverage_cells(
        cell_mean=np.array([92.0]), cell_var=np.array([25.0]),
        yhat=np.array([92.0]), sigma=1.0, w=np.array([20000.0]))
    assert cov < 0.30, f"understated sigma read as {cov} -- veto is blind"


def test_naive_row_metric_on_cell_means_would_be_blind():
    """Documents why sigma_coverage_cells exists at all.

    Applied to cell means, the row-grain metric reports ~1.0 for a sigma that
    is five times too large -- indistinguishable from a correct one.
    """
    means = np.array([92.0, 93.0, 91.0])
    blind = sigma_coverage(means, np.full(3, 92.0), 25.0, np.ones(3))
    assert blind == pytest.approx(1.0)


def test_ece_perfectly_calibrated_is_near_zero():
    rng = np.random.default_rng(0)
    p1 = rng.uniform(0, 1, 50000)
    y = (rng.uniform(0, 1, 50000) < p1).astype(int)
    p = np.column_stack([1 - p1, p1])
    assert ece(y, p, np.ones(50000)) < 0.02


def test_calibration_bins_shape():
    rng = np.random.default_rng(0)
    p1 = rng.uniform(0, 1, 1000)
    y = (rng.uniform(0, 1, 1000) < p1).astype(int)
    p = np.column_stack([1 - p1, p1])
    bins = calibration_bins(y, p, np.ones(1000), bins=10)
    assert len(bins) == 10
    assert set(bins[0]) == {"bin_lo", "bin_hi", "n", "mean_pred", "observed"}
