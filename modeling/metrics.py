"""Weighted metrics for cell-based training.

Every function takes `w`, the cell weights (count(*) from the cell table), so
metrics computed on aggregated cells equal metrics computed on the underlying
rows. Dropping the weights would silently make a cell representing 50,000
pitches count the same as one representing 3.

sigma_coverage exists because pitch_speed_ou converts sigma to P(over) through
a normal CDF. A well-fit mean with a mis-scaled sigma has good RMSE and
produces confidently wrong probabilities -- RMSE alone cannot see it.
"""

from __future__ import annotations

import numpy as np

_EPS = 1e-12


def logloss(y: np.ndarray, p: np.ndarray, w: np.ndarray) -> float:
    picked = p[np.arange(len(y)), y]
    return float(-np.average(np.log(np.clip(picked, _EPS, 1.0)), weights=w))


def brier(y: np.ndarray, p: np.ndarray, w: np.ndarray) -> float:
    onehot = np.zeros_like(p)
    onehot[np.arange(len(y)), y] = 1.0
    return float(np.average(((p - onehot) ** 2).sum(axis=1), weights=w))


def rmse(y: np.ndarray, yhat: np.ndarray, w: np.ndarray) -> float:
    return float(np.sqrt(np.average((y - yhat) ** 2, weights=w)))


def sigma_coverage(y: np.ndarray, yhat: np.ndarray, sigma: float,
                   w: np.ndarray) -> float:
    """Fraction of actuals within +/-1 sigma. Should be ~0.68 if sigma is right."""
    inside = (np.abs(y - yhat) <= sigma).astype(float)
    return float(np.average(inside, weights=w))


def _std_normal_cdf(x: np.ndarray) -> np.ndarray:
    """Abramowitz-Stegun normal CDF, vectorised.

    The same approximation normCdf() uses in model.ts -- kept identical so a
    coverage number here means the same thing as the O/U probabilities
    production serves. Accurate to ~7.5e-8, far tighter than a diagnostic
    needs, and it avoids taking a scipy dependency for one function.
    """
    x = np.asarray(x, dtype=float)
    t = 1.0 / (1.0 + 0.2316419 * np.abs(x))
    d = 0.3989423 * np.exp(-x * x / 2.0)
    p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478
                 + t * (-1.821256 + t * 1.330274))))
    return np.where(x > 0, 1.0 - p, p)


def sigma_coverage_cells(cell_mean: np.ndarray, cell_var: np.ndarray,
                         yhat: np.ndarray, sigma: float,
                         w: np.ndarray) -> float:
    """Fraction of INDIVIDUAL rows within +/-1 sigma, from aggregated cells.

    sigma_coverage() above answers the question at row grain. Applying it
    directly to a cell table silently answers a different question: a cell's
    `mean_speed` is an average over thousands of pitches, so its residuals are
    ~3x tighter than a single pitch's, and coverage against a pitch-level sigma
    reads ~0.98 no matter how badly scaled sigma is. That is not a sigma the
    band [0.63, 0.73] can police -- it is the wrong measurement.

    Modelling each cell's pitches as N(cell_mean, cell_var) recovers the row
    grain analytically:

        P(|X - yhat| <= sigma), X ~ N(mean, var)

    which is what the promotion veto in modeling/registry.py needs to see.
    """
    sd = np.sqrt(np.maximum(np.asarray(cell_var, dtype=float), 1e-12))
    hi = (yhat + sigma - cell_mean) / sd
    lo = (yhat - sigma - cell_mean) / sd
    inside = _std_normal_cdf(hi) - _std_normal_cdf(lo)
    return float(np.average(inside, weights=w))


def calibration_bins(y: np.ndarray, p: np.ndarray, w: np.ndarray,
                     bins: int = 10, positive_class: int = 1) -> list[dict]:
    """Reliability curve for one class: predicted vs observed, per bin."""
    pred = p[:, positive_class]
    hit = (y == positive_class).astype(float)
    edges = np.linspace(0.0, 1.0, bins + 1)
    out = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (pred >= lo) & (pred < hi if hi < 1.0 else pred <= hi)
        wm = w[m]
        total = float(wm.sum())
        out.append({
            "bin_lo": round(float(lo), 3),
            "bin_hi": round(float(hi), 3),
            "n": total,
            "mean_pred": round(float(np.average(pred[m], weights=wm)), 5)
                         if total > 0 else None,
            "observed": round(float(np.average(hit[m], weights=wm)), 5)
                        if total > 0 else None,
        })
    return out


def ece(y: np.ndarray, p: np.ndarray, w: np.ndarray, bins: int = 10) -> float:
    """Expected calibration error: weighted mean |predicted - observed|."""
    rows = calibration_bins(y, p, w, bins=bins)
    total = sum(r["n"] for r in rows) or 1.0
    return float(sum(
        r["n"] / total * abs(r["mean_pred"] - r["observed"])
        for r in rows if r["n"] > 0 and r["mean_pred"] is not None))
