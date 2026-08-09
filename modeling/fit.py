"""Model families. One function per params.type that model.ts can score.

Recency decay multiplies each cell's weight by 0.5 ** (age_in_seasons /
half_life). It is a sweep dimension, not a constant, because the right value is
an empirical question: the pitch clock and shift ban both landed in 2023, so
how fast pre-2023 baseball should decay is exactly the kind of thing the
walk-forward should answer rather than the author guessing.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

# Swept by validate.sweep(). None means no decay -- weight purely by count.
HALF_LIVES: tuple[float | None, ...] = (1.0, 2.0, 3.0, None)


@dataclass(frozen=True)
class FitResult:
    family: str
    feature_names: tuple[str, ...]
    classes: tuple[str, ...] | None = None
    coef: list | None = None
    intercept: list | float | None = None
    sigma: float | None = None
    table: dict | None = None


def decay_weights(seasons: np.ndarray, n: np.ndarray,
                  half_life: float | None) -> np.ndarray:
    """Cell counts scaled by exponential recency decay."""
    if half_life is None:
        return np.asarray(n, dtype=float)
    age = float(np.max(seasons)) - np.asarray(seasons, dtype=float)
    return np.asarray(n, dtype=float) * (0.5 ** (age / float(half_life)))


def _design(spec, cells: pd.DataFrame, form_window: str) -> np.ndarray:  # noqa: ANN001
    """Feature matrix in spec.feature_names order.

    The bucket column for the selected form window is chosen here -- this is
    the entire cost of a form-window sweep step, because build_cells emitted
    all three windows in the single R2 pass.
    """
    if form_window not in spec.form_windows:
        raise ValueError(
            f"unknown form_window {form_window!r}; "
            f"{spec.market} emits {spec.form_windows}")
    # One generic form column per market, recovered from the bucket index as
    # `baseline + index * step`. Which column, which step and which centre all
    # come off the spec, which is what keeps this function free of market names.
    form = (spec.bucket_baseline
            + cells[f"{form_window}_{spec.bucket_col}"].to_numpy(float)
            * spec.bucket_step)
    balls = cells["balls"].to_numpy(float)
    strikes = cells["strikes"].to_numpy(float)
    zeros = np.zeros(len(cells))
    columns = {
        "balls": balls,
        "strikes": strikes,
        "two_strikes": (strikes >= 2).astype(float),
        "three_balls": (balls >= 3).astype(float),
        "pitch_of_pa": (cells["pitch_of_pa"].to_numpy(float)
                        if "pitch_of_pa" in cells else zeros),
        "pitcher_zone_delta": form,
        "pitcher_k_delta": form,
        "pitcher_velo": form,
        # Features the cell grain does not carry are folded into the intercept
        # as zero, exactly as the v1 trainer did for pitcher_bb_delta. Adding
        # one is a spec change (a new bucket column), not an engine change.
        "batter_chase_delta": zeros,
        "pitcher_bb_delta": zeros,
        "batter_k_delta": zeros,
        "platoon_same": zeros,
    }
    missing = [f for f in spec.feature_names if f not in columns]
    if missing:
        raise ValueError(f"{spec.market}: no column built for {missing}")
    return np.column_stack([columns[f] for f in spec.feature_names])


def _fit_multinomial(spec, cells, form_window, half_life) -> FitResult:  # noqa: ANN001
    from sklearn.linear_model import LogisticRegression

    cells = cells[cells["outcome"].isin(spec.classes)]
    X = _design(spec, cells, form_window)
    y = np.array([spec.classes.index(o) for o in cells["outcome"]])
    w = decay_weights(cells["season"].to_numpy(), cells["n"].to_numpy(), half_life)

    clf = LogisticRegression(max_iter=5000, C=10.0)
    clf.fit(X, y, sample_weight=w)

    # sklearn collapses a two-class problem to a single coefficient row.
    # model.ts always expects one row per class, so expand it here.
    coef = np.zeros((len(spec.classes), X.shape[1]))
    intercept = np.zeros(len(spec.classes))
    for i, cls in enumerate(clf.classes_):
        k = int(cls)
        if clf.coef_.shape[0] > 1:
            coef[k], intercept[k] = clf.coef_[i], clf.intercept_[i]
        else:
            sign = 1.0 if k == 1 else -1.0
            coef[k], intercept[k] = sign * clf.coef_[0], sign * clf.intercept_[0]

    return FitResult(
        family="multinomial_logistic",
        feature_names=spec.feature_names,
        classes=spec.classes,
        coef=coef.tolist(),
        intercept=intercept.tolist(),
    )


def _fit_linear(spec, cells, form_window, half_life) -> FitResult:  # noqa: ANN001
    """Weighted least squares, with sigma combining both variance components.

    Cells are aggregates, so total variance = between-cell (residuals of the
    cell means) + within-cell (the var_speed each cell carries). Using only the
    first understates sigma, and pitch_speed_ou converts sigma to P(over)
    through a normal CDF -- an understated sigma is confidently wrong output.
    """
    from sklearn.linear_model import LinearRegression

    X = _design(spec, cells, form_window)
    y = cells["mean_speed"].to_numpy(float)
    w = decay_weights(cells["season"].to_numpy(), cells["n"].to_numpy(), half_life)

    reg = LinearRegression()
    reg.fit(X, y, sample_weight=w)

    resid = y - reg.predict(X)
    between = float(np.average(resid ** 2, weights=w))
    within = float(np.average(cells["var_speed"].fillna(0.0).to_numpy(float),
                              weights=w))
    return FitResult(
        family="linear",
        feature_names=spec.feature_names,
        coef=[float(v) for v in reg.coef_],
        intercept=float(reg.intercept_),
        sigma=float(np.sqrt(between + within)),
    )


def _fit_remaining_table(spec, cells, form_window, half_life) -> FitResult:  # noqa: ANN001
    """Empirical distribution of REMAINING pitches, keyed 'balls-strikes'.

    No coefficients -- this family is a weighted histogram. Recency decay still
    applies, so recent seasons shape the distribution more.
    """
    w = decay_weights(cells["season"].to_numpy(), cells["n"].to_numpy(), half_life)
    grouped: dict[str, dict[int, float]] = {}
    for (balls, strikes, remaining), weight in zip(
            zip(cells["balls"], cells["strikes"], cells["remaining"]), w):
        state = f"{int(balls)}-{int(strikes)}"
        dist = grouped.setdefault(state, {})
        key = int(remaining)
        dist[key] = dist.get(key, 0.0) + float(weight)

    table = {}
    for state, dist in grouped.items():
        total = sum(dist.values())
        table[state] = {
            "mean": round(sum(k * v for k, v in dist.items()) / total, 3),
            "dist": {str(k): round(v / total, 5) for k, v in sorted(dist.items())},
        }
    return FitResult(family="remaining_table",
                     feature_names=spec.feature_names, table=table)


def _fit_log5(spec, cells, form_window, half_life) -> FitResult:  # noqa: ANN001
    """Home-field advantage as a single weighted rate.

    One parameter. It is in the workbench anyway so every market goes through
    the same validation, recording and promotion path -- a market that skips
    the loop is a market whose regressions nobody notices.
    """
    w = decay_weights(cells["season"].to_numpy(), cells["n"].to_numpy(), half_life)
    home_adv = float(np.average(cells["home_win"].to_numpy(float), weights=w))
    return FitResult(family="log5", feature_names=(), intercept=home_adv)


_FITTERS = {
    "multinomial_logistic": _fit_multinomial,
    "linear": _fit_linear,
    "remaining_table": _fit_remaining_table,
    "log5": _fit_log5,
}


def fit(spec, cells: pd.DataFrame, *, form_window: str,  # noqa: ANN001
        half_life: float | None) -> FitResult:
    if len(cells) == 0:
        raise ValueError(
            f"{spec.market}: no cells to fit. This means the season filter "
            f"excluded everything -- check the fold boundaries.")
    if spec.family not in _FITTERS:
        raise NotImplementedError(
            f"no fitter for family {spec.family!r} (market {spec.market!r})")
    return _FITTERS[spec.family](spec, cells, form_window, half_life)
