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
