"""Walk-forward validation, the frozen holdout, and hyperparameter sweeps.

Replaces the in-sample quality gate in the retired scripts/train_models.py,
which compared training-set log-loss and therefore could not see overfitting at
all.

Three rules, each with a test that fails if it is relaxed:

  * Fold N trains strictly on seasons < N.
  * 2026 is never trained on and never selected on.
  * 2020 (60-game COVID season) is reported but excluded from the aggregate,
    because a fold with ~37% of a normal season's rows distorts the mean by
    both sample size and schedule.

evaluate() dispatches on spec.family with no default: a family with no
evaluator raises rather than quietly being scored with the wrong metric.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from modeling import metrics as M
from modeling.fit import HALF_LIVES, FitResult, fit

WALK_FORWARD_SEASONS: tuple[int, ...] = tuple(range(2016, 2026))
HOLDOUT_SEASON = 2026
EXCLUDE_FROM_AGGREGATE: tuple[int, ...] = (2020,)


@dataclass(frozen=True)
class FoldResult:
    test_season: int
    n_train: float
    n_test: float
    metrics: dict


@dataclass(frozen=True)
class SweepResult:
    form_window: str
    half_life: float | None
    folds: list[FoldResult] = field(default_factory=list)
    oos: dict = field(default_factory=dict)


def predict(spec, result: FitResult, cells: pd.DataFrame,  # noqa: ANN001
            form_window: str) -> np.ndarray:
    from modeling.fit import _design

    X = _design(spec, cells, form_window)
    logits = X @ np.asarray(result.coef).T + np.asarray(result.intercept)
    logits -= logits.max(axis=1, keepdims=True)
    exp = np.exp(logits)
    return exp / exp.sum(axis=1, keepdims=True)


def _evaluate_multinomial(spec, result: FitResult, cells: pd.DataFrame,  # noqa: ANN001
                          form_window: str) -> dict:
    cells = cells[cells["outcome"].isin(spec.classes)]
    p = predict(spec, result, cells, form_window)
    y = np.array([spec.classes.index(o) for o in cells["outcome"]])
    w = cells["n"].to_numpy(float)
    return {
        "logloss": round(M.logloss(y, p, w), 6),
        "brier": round(M.brier(y, p, w), 6),
        "ece": round(M.ece(y, p, w), 6),
        "n": float(w.sum()),
    }


_EVALUATORS = {"multinomial_logistic": _evaluate_multinomial}


def evaluate(spec, result: FitResult, cells: pd.DataFrame,  # noqa: ANN001
             form_window: str) -> dict:
    if spec.family not in _EVALUATORS:
        raise NotImplementedError(
            f"no evaluator for family {spec.family!r} (market {spec.market!r})")
    return _EVALUATORS[spec.family](spec, result, cells, form_window)


def walk_forward(spec, cells: pd.DataFrame, *, form_window: str,  # noqa: ANN001
                 half_life: float | None) -> list[FoldResult]:
    out: list[FoldResult] = []
    for season in WALK_FORWARD_SEASONS:
        train = cells[cells["season"] < season]
        test = cells[cells["season"] == season]
        if len(train) == 0 or len(test) == 0:
            continue
        result = fit(spec, train, form_window=form_window, half_life=half_life)
        out.append(FoldResult(
            test_season=season,
            n_train=float(train["n"].sum()),
            n_test=float(test["n"].sum()),
            metrics=evaluate(spec, result, test, form_window),
        ))
    return out


def aggregate(folds: list[FoldResult], *,
              exclude: tuple[int, ...] = EXCLUDE_FROM_AGGREGATE) -> dict:
    used = [f for f in folds if f.test_season not in exclude]
    if not used:
        return {"folds_used": 0, "folds_excluded": list(exclude)}
    keys = [k for k in used[0].metrics if k != "n"]
    weights = np.array([f.metrics["n"] for f in used], dtype=float)
    out = {k: round(float(np.average(
        [f.metrics[k] for f in used], weights=weights)), 6) for k in keys}
    out["folds_used"] = len(used)
    out["folds_excluded"] = [f.test_season for f in folds
                             if f.test_season in exclude]
    out["n"] = float(weights.sum())
    return out


def sweep(spec, cells: pd.DataFrame) -> list[SweepResult]:  # noqa: ANN001
    """Every (form_window, half_life) pair. Pure compute on cached cells."""
    results: list[SweepResult] = []
    for window in spec.form_windows:
        for half_life in HALF_LIVES:
            folds = walk_forward(spec, cells, form_window=window,
                                 half_life=half_life)
            results.append(SweepResult(window, half_life, folds,
                                       aggregate(folds)))
            print(f"[modeling] {spec.market} window={window} "
                  f"half_life={half_life} -> {results[-1].oos}")
    return results


def best(results: list[SweepResult], spec) -> SweepResult:  # noqa: ANN001
    key = spec.primary_metric
    reverse = spec.metric_direction == "higher"
    ranked = sorted((r for r in results if key in r.oos),
                    key=lambda r: r.oos[key], reverse=reverse)
    if not ranked:
        raise ValueError(
            f"{spec.market}: no sweep result carried metric {key!r}")
    return ranked[0]
