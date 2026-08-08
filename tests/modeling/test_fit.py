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


def test_fit_rejects_unknown_form_window():
    spec = get_spec("pitch_result")
    with pytest.raises(ValueError, match="form_window"):
        fit(spec, _cells(), form_window="d365", half_life=None)
