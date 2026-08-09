"""Rebuilding a FitResult from stored params, for `modeling baseline`.

These tests exist because the first version of this silently produced a
*plausible* number instead of failing. It dropped `table` for remaining_table,
so every held-out probability looked up as 0.0, clipped to 1e-12, and the
baseline recorded as logloss 27.63. Any new model beats 27.63, so the
promotion gate -- the whole safety mechanism -- would have waved anything
through. Loud failure is the requirement here, not best effort.
"""

from __future__ import annotations

import dataclasses

import pytest

from modeling.fit import from_params
from modeling.spec import get_spec


def test_multinomial_round_trips():
    spec = get_spec("pitch_result")
    params = {"type": "multinomial_logistic", "classes": ["a", "b"],
              "features": ["balls"], "coef": [[0.1], [0.2]],
              "intercept": [0.0, 0.1]}
    got = from_params(params, spec)
    assert got.family == "multinomial_logistic"
    assert got.classes == ("a", "b")
    assert got.coef == [[0.1], [0.2]]


def test_remaining_table_keeps_the_table():
    """The exact field whose loss produced the 27.63 baseline."""
    spec = get_spec("ab_pitches_ou")
    table = {"0-0": {"mean": 3.9, "dist": {"3": 1.0}}}
    got = from_params({"type": "remaining_table", "table": table}, spec)
    assert got.table == table


def test_log5_reads_home_adv_not_intercept():
    """log5 stores its one parameter under a different key than it fits it."""
    spec = get_spec("game_moneyline")
    got = from_params({"type": "log5", "home_adv": 0.542}, spec)
    assert got.intercept == 0.542


def test_linear_keeps_sigma():
    spec = get_spec("pitch_speed_ou")
    got = from_params({"type": "linear", "features": ["balls"], "coef": [1.0],
                       "intercept": 92.0, "sigma": 5.4}, spec)
    assert got.sigma == 5.4


@pytest.mark.parametrize("params", [
    {"type": "remaining_table"},                      # no table
    {"type": "log5"},                                 # no home_adv
    {"type": "linear", "coef": [1.0]},                # no intercept
    {"type": "multinomial_logistic", "coef": [[1.0]]},  # no classes
])
def test_incomplete_params_raise_rather_than_score(params):
    spec = get_spec("pitch_result")
    with pytest.raises(ValueError, match="missing"):
        from_params(params, spec)


def test_unknown_type_raises():
    spec = get_spec("pitch_result")
    with pytest.raises(ValueError, match="no family here can score|type="):
        from_params({"type": "random_forest"}, spec)


def test_round_trip_through_to_params_is_faithful():
    """to_params -> from_params must preserve everything the evaluator reads."""
    spec = get_spec("game_moneyline")
    fitted = dataclasses.replace(
        from_params({"type": "log5", "home_adv": 0.5359}, spec))
    again = from_params(spec.to_params(fitted, "career"), spec)
    assert again.intercept == pytest.approx(0.5359)
