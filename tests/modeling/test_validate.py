"""Walk-forward mechanics: fold boundaries, holdout isolation, selection."""

from __future__ import annotations

import pandas as pd

from modeling.spec import get_spec
from modeling.validate import (EXCLUDE_FROM_AGGREGATE, HOLDOUT_SEASON,
                               WALK_FORWARD_SEASONS, SweepResult, aggregate,
                               best, sweep, walk_forward)


def _cells(seasons=range(2015, 2027)) -> pd.DataFrame:
    rows = []
    for season in seasons:
        for strikes in (0, 1, 2):
            for outcome, base in (("strike_foul", 30), ("ball", 30),
                                  ("in_play", 20)):
                n = base + (25 * strikes if outcome == "strike_foul" else 0)
                rows.append({"season": season, "balls": 0, "strikes": strikes,
                             "outcome": outcome, "n": float(n),
                             "career_zone_bucket": 0, "d30_zone_bucket": 0,
                             "d90_zone_bucket": 0})
    return pd.DataFrame(rows)


def test_ten_walk_forward_folds():
    assert WALK_FORWARD_SEASONS == tuple(range(2016, 2026))
    assert len(WALK_FORWARD_SEASONS) == 10


def test_2015_is_not_a_test_season():
    """2015 has no prior season to train on."""
    assert 2015 not in WALK_FORWARD_SEASONS


def test_holdout_is_never_a_fold():
    assert HOLDOUT_SEASON == 2026
    assert HOLDOUT_SEASON not in WALK_FORWARD_SEASONS


def test_folds_train_only_on_earlier_seasons():
    spec = get_spec("pitch_result")
    folds = walk_forward(spec, _cells(), form_window="career", half_life=None)
    assert [f.test_season for f in folds] == list(WALK_FORWARD_SEASONS)
    # Train weight must grow monotonically as the window expands.
    weights = [f.n_train for f in folds]
    assert weights == sorted(weights)


def test_holdout_rows_never_enter_training():
    """The strongest guarantee in the file: 2026 must not be trained on."""
    spec = get_spec("pitch_result")
    with_2026 = _cells()
    without_2026 = _cells(seasons=range(2015, 2026))
    a = walk_forward(spec, with_2026, form_window="career", half_life=None)
    b = walk_forward(spec, without_2026, form_window="career", half_life=None)
    assert [f.n_train for f in a] == [f.n_train for f in b], \
        "adding 2026 changed a training set -- the holdout is leaking"


def test_aggregate_excludes_2020_by_default():
    assert EXCLUDE_FROM_AGGREGATE == (2020,)
    spec = get_spec("pitch_result")
    folds = walk_forward(spec, _cells(), form_window="career", half_life=None)
    agg = aggregate(folds)
    assert agg["folds_used"] == len(WALK_FORWARD_SEASONS) - 1
    assert 2020 in agg["folds_excluded"]


def test_aggregate_can_include_2020():
    spec = get_spec("pitch_result")
    folds = walk_forward(spec, _cells(), form_window="career", half_life=None)
    assert aggregate(folds, exclude=())["folds_used"] == len(WALK_FORWARD_SEASONS)


def test_sweep_covers_windows_times_half_lives():
    spec = get_spec("pitch_result")
    results = sweep(spec, _cells())
    assert len(results) == len(spec.form_windows) * 4  # 4 half-lives
    assert all(isinstance(r, SweepResult) for r in results)


def test_best_picks_lowest_for_lower_is_better():
    spec = get_spec("pitch_result")
    made = [
        SweepResult("career", None, [], {"logloss": 0.90}),
        SweepResult("d30", 2.0, [], {"logloss": 0.50}),
        SweepResult("d90", 1.0, [], {"logloss": 0.70}),
    ]
    assert best(made, spec).oos["logloss"] == 0.50
