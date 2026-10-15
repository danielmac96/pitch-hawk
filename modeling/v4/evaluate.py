"""Metrics for every v4 prediction kind, one function per kind.

A prediction is always a numpy array whose shape depends on the kind:

    binary      (n,)        P(y = 1)
    multiclass  (n, K)      class probabilities, rows sum to 1
    count       (n, cap+1)  pmf on 0..cap, the last bucket meaning "cap or more"
    gaussian    (n, 2)      columns (mu, sigma)

Every metric is lower-is-better except where the name says otherwise
(`auc`, `accuracy`, `sigma_coverage` -- reported, never selected on).
`PRIMARY` names the one each kind is selected and gated on.
"""

from __future__ import annotations

import math

import numpy as np

from modeling import metrics as M

PRIMARY = {"binary": "logloss", "multiclass": "logloss", "count": "rps",
           "gaussian": "gauss_nll"}
EPS = 1e-6


def _r(x: float, nd: int = 6) -> float:
    return round(float(x), nd)


def _auc(y: np.ndarray, p: np.ndarray) -> float | None:
    pos = y == 1
    n1, n0 = int(pos.sum()), int((~pos).sum())
    if not n1 or not n0:
        return None
    order = np.argsort(p, kind="mergesort")
    ranks = np.empty(len(p))
    ranks[order] = np.arange(1, len(p) + 1)
    # Ties share their mean rank.
    _, inv, cnt = np.unique(p, return_inverse=True, return_counts=True)
    sums = np.bincount(inv, weights=ranks)
    ranks = (sums / cnt)[inv]
    return _r((ranks[pos].sum() - n1 * (n1 + 1) / 2) / (n1 * n0), 5)


def reliability(y: np.ndarray, p: np.ndarray, bins: int = 10) -> list[dict]:
    """Quantile-binned reliability curve: equal-count bins survive rare events
    where uniform bins put nearly everything in one."""
    if not len(p):
        return []
    edges = np.unique(np.quantile(p, np.linspace(0, 1, bins + 1)))
    idx = np.clip(np.searchsorted(edges, p, side="right") - 1, 0, len(edges) - 2) \
        if len(edges) > 1 else np.zeros(len(p), int)
    out = []
    for b in range(max(len(edges) - 1, 1)):
        m = idx == b
        if m.any():
            out.append({"pred": _r(p[m].mean(), 5), "obs": _r(y[m].mean(), 5),
                        "n": int(m.sum())})
    return out


def binary(p: np.ndarray, y: np.ndarray) -> dict:
    p = np.clip(np.asarray(p, float), EPS, 1 - EPS)
    y = np.asarray(y, float)
    w = np.ones(len(y))
    return {
        "n": int(len(y)),
        "logloss": _r(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p))),
        "brier": _r(np.mean((p - y) ** 2)),
        "calibration": _r(p.mean() / max(y.mean(), 1e-9), 4),
        "ece": _r(M.ece(y, p, w), 5),
        "auc": _auc(y, p),
        "accuracy": _r(np.mean((p >= 0.5) == (y == 1)), 4),
        "base_rate": _r(y.mean(), 4),
        "mean_pred": _r(p.mean(), 5),
    }


def multiclass(P: np.ndarray, y: np.ndarray, classes: tuple[str, ...]) -> dict:
    P = np.clip(np.asarray(P, float), EPS, 1)
    P = P / P.sum(axis=1, keepdims=True)
    y = np.asarray(y, int)
    n, K = P.shape
    onehot = np.eye(K)[y]
    out = {
        "n": int(n),
        "logloss": _r(-np.mean(np.log(P[np.arange(n), y]))),
        "brier": _r(np.mean(((P - onehot) ** 2).sum(axis=1))),
        "accuracy": _r(np.mean(P.argmax(axis=1) == y), 4),
    }
    for k, c in enumerate(classes):
        obs = onehot[:, k].mean()
        out[f"{c}_calibration"] = _r(P[:, k].mean() / max(obs, 1e-9), 4)
        out[f"{c}_rate"] = _r(obs, 4)
    return out


def _over(pmf: np.ndarray, line: float) -> np.ndarray:
    k = int(math.floor(line)) + 1
    return pmf[:, k:].sum(axis=1) if k < pmf.shape[1] else np.zeros(len(pmf))


def count(pmf: np.ndarray, y: np.ndarray, *, line: float | None = None) -> dict:
    pmf = np.clip(np.asarray(pmf, float), 0, None)
    pmf = pmf / np.maximum(pmf.sum(axis=1, keepdims=True), 1e-12)
    cap = pmf.shape[1] - 1
    yc = np.minimum(np.asarray(y, int), cap)
    ev = pmf @ np.arange(cap + 1)
    out = {
        "n": int(len(yc)),
        "rps": _r(M.rps(pmf, yc)),
        "count_nll": _r(M.count_nll(pmf, yc)),
        "mae_expected": _r(np.mean(np.abs(ev - yc)), 4),
        "rmse_expected": _r(np.sqrt(np.mean((ev - yc) ** 2)), 4),
        "mean_pred": _r(ev.mean(), 4),
        "mean_obs": _r(yc.mean(), 4),
        "calibration": _r(ev.mean() / max(yc.mean(), 1e-9), 4),
    }
    if line is not None:
        b = binary(_over(pmf, line), (yc > line).astype(int))
        out.update({f"over_{k}": v for k, v in b.items()
                    if k in ("logloss", "brier", "calibration", "base_rate", "auc")})
        out["line"] = line
    return out


def gaussian(pred: np.ndarray, y: np.ndarray) -> dict:
    mu, sd = pred[:, 0], np.maximum(pred[:, 1], 1e-3)
    y = np.asarray(y, float)
    z = (y - mu) / sd
    return {
        "n": int(len(y)),
        "gauss_nll": _r(np.mean(0.5 * z ** 2 + np.log(sd) + 0.5 * math.log(2 * math.pi))),
        "rmse": _r(np.sqrt(np.mean((y - mu) ** 2)), 5),
        "mae": _r(np.mean(np.abs(y - mu)), 5),
        "sigma_coverage": _r(np.mean(np.abs(z) <= 1), 4),
        "mean_sigma": _r(sd.mean(), 4),
        "bias": _r(np.mean(mu - y), 5),
    }


def score(kind: str, pred: np.ndarray, y: np.ndarray, *,
          classes: tuple[str, ...] = (), line: float | None = None) -> dict:
    if kind == "binary":
        return binary(pred, y)
    if kind == "multiclass":
        return multiclass(pred, y, classes)
    if kind == "count":
        return count(pred, y, line=line)
    if kind == "gaussian":
        return gaussian(pred, y)
    raise ValueError(f"unknown kind {kind!r}")


def curve(kind: str, pred: np.ndarray, y: np.ndarray, *,
          line: float | None = None) -> list[dict]:
    """The reliability curve the dashboard plots, for the kind's headline
    probability: P(y=1), P(top class) per class collapsed to the realised
    class, P(over line), or P(y > mu) for a Gaussian (should be ~0.5 flat)."""
    y = np.asarray(y)
    if kind == "binary":
        return reliability(y.astype(float), np.asarray(pred, float))
    if kind == "multiclass":
        k = np.asarray(pred).argmax(axis=1)
        return reliability((y == k).astype(float), np.asarray(pred).max(axis=1))
    if kind == "count" and line is not None:
        cap = pred.shape[1] - 1
        return reliability((np.minimum(y, cap) > line).astype(float), _over(pred, line))
    return []


def aggregate(folds: list[dict], exclude: tuple[int, ...]) -> dict:
    """n-weighted mean of every numeric metric over folds not in `exclude`."""
    used = [f for f in folds if f["season"] not in exclude]
    if not used:
        return {}
    w = np.array([f["n"] for f in used], float)
    keys = [k for k, v in used[0].items()
            if k not in ("n", "season", "line") and isinstance(v, (int, float))
            and not isinstance(v, bool)
            and all(isinstance(f.get(k), (int, float)) for f in used)]
    out = {k: _r(np.average([f[k] for f in used], weights=w)) for k in keys}
    out["n"] = int(w.sum())
    out["folds_used"] = len(used)
    return out
