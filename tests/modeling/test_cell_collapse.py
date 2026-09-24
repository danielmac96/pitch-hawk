"""Regrouping cells onto the form window the fit actually uses.

`cell_sql` emits career, d30 and d90 buckets for both sides in one pass, which
is what makes the form-window sweep free of extra R2 reads. `_design` then
reads ONE window, so the other four bucket columns split rows the design matrix
cannot tell apart -- a grid three times finer than the one being fitted, with a
median cell size of 1.

That was harmless until a market wanted a sample floor. Applied to the emitted
grid, batter_hr's MIN_OBS=200 kept 21 cells and 0.69% of its plate appearances,
all from one season, and batter_hit's 60 kept 0.41%.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from modeling.fit import _design, collapse_to_window, fit
from modeling.spec import FormFeature, MarketSpec, get_spec


def _spec(min_cell_obs: int) -> MarketSpec:
    return MarketSpec(
        market="t_collapse",
        family="multinomial_logistic",
        cell_sql="",
        feature_names=("batter_hr_delta", "pitcher_hr_delta"),
        classes=("yes", "no"),
        primary_metric="logloss",
        metric_direction="lower",
        positive_class="yes",
        form_windows=("career", "d30"),
        to_params=lambda fit, w: {},
        form_features=(FormFeature("batter_hr_delta", "bat_bucket", 0.005),
                       FormFeature("pitcher_hr_delta", "pit_bucket", 0.004)),
        min_cell_obs=min_cell_obs,
    )


def _cells() -> pd.DataFrame:
    """Two rows that the career grid cannot tell apart, split only by d30."""
    return pd.DataFrame([
        # same career buckets, different d30 -> one career cell of n=150
        {"season": 2024, "balls": 0, "strikes": 0, "outcome": "yes",
         "career_bat_bucket": 1, "career_pit_bucket": -2,
         "d30_bat_bucket": 1, "d30_pit_bucket": -2, "n": 100},
        {"season": 2024, "balls": 0, "strikes": 0, "outcome": "yes",
         "career_bat_bucket": 1, "career_pit_bucket": -2,
         "d30_bat_bucket": 7, "d30_pit_bucket": -9, "n": 50},
        # a genuinely separate career cell, below any threshold above 10
        {"season": 2024, "balls": 0, "strikes": 0, "outcome": "no",
         "career_bat_bucket": 4, "career_pit_bucket": 4,
         "d30_bat_bucket": 4, "d30_pit_bucket": 4, "n": 10},
    ])


def test_rows_differing_only_by_another_window_merge():
    out = collapse_to_window(_spec(1), _cells(), "career", apply_min_obs=True)
    merged = out[(out["career_bat_bucket"] == 1) & (out["outcome"] == "yes")]
    assert len(merged) == 1
    assert merged["n"].iloc[0] == 150
    assert "d30_bat_bucket" not in out.columns


def test_the_selected_window_is_the_one_kept():
    out = collapse_to_window(_spec(1), _cells(), "d30", apply_min_obs=True)
    assert "d30_bat_bucket" in out.columns
    assert "career_bat_bucket" not in out.columns
    # On the d30 grid those same two rows are genuinely different cells.
    assert len(out) == 3


def test_min_cell_obs_applies_to_the_collapsed_grid():
    """The whole point: 150 clears a threshold that neither 100 nor 50 would
    have cleared on the emitted grid."""
    out = collapse_to_window(_spec(120), _cells(), "career", apply_min_obs=True)
    assert list(out["n"]) == [150]


def test_evaluation_keeps_every_cell():
    """apply_min_obs=False still collapses, so fit and evaluate share a grid,
    but scores the sparse cells too -- the model is served on those."""
    out = collapse_to_window(_spec(120), _cells(), "career", apply_min_obs=False)
    assert sorted(out["n"]) == [10, 150]


def test_a_spec_without_a_floor_is_untouched():
    """The five markets written before this existed must see the exact frame
    they saw before, including the columns of the windows they do not use."""
    cells = _cells()
    out = collapse_to_window(_spec(0), cells, "career", apply_min_obs=True)
    assert out is cells


def test_unknown_columns_survive_as_grouping_keys():
    """Anything this function does not recognise stays a key rather than being
    aggregated away -- the linear family's var_speed is the reason."""
    cells = _cells()
    cells["var_speed"] = [1.0, 2.0, 3.0]
    out = collapse_to_window(_spec(1), cells, "career", apply_min_obs=True)
    assert "var_speed" in out.columns
    # The two career-identical rows differ in var_speed, so they stay split.
    assert len(out) == 3


def test_collapsing_does_not_change_the_fitted_model():
    """The exactness claim. A weighted fit over cells equals one over the rows
    behind them, so merging rows with the same design vector must move no
    coefficient. Compared against the same cells pre-merged by hand."""
    spec = _spec(1)
    fine = pd.DataFrame([
        {"season": 2024, "balls": 0, "strikes": 0, "outcome": o,
         "career_bat_bucket": b, "career_pit_bucket": 0,
         "d30_bat_bucket": d, "d30_pit_bucket": 0, "n": n}
        for b, o, n, d in [(3, "yes", 60, 1), (3, "yes", 40, 9),
                           (3, "no", 140, 1), (3, "no", 60, 9),
                           (-3, "yes", 20, 2), (-3, "no", 180, 2)]
    ])
    coarse = fine.copy()
    coarse["d30_bat_bucket"] = 0          # already merged on the career grid

    a = fit(spec, fine, form_window="career", half_life=None)
    b = fit(spec, coarse, form_window="career", half_life=None)
    np.testing.assert_allclose(np.array(a.coef), np.array(b.coef), atol=1e-9)
    np.testing.assert_allclose(np.array(a.intercept), np.array(b.intercept),
                               atol=1e-9)


@pytest.mark.parametrize("market,expected", [("batter_hit", 60),
                                             ("batter_hr", 200)])
def test_the_batter_specs_declare_their_floor(market, expected):
    spec = get_spec(market)
    assert spec.min_cell_obs == expected
    assert "having" not in spec.cell_sql.lower()


@pytest.mark.parametrize("market", ["ab_result", "pitch_result",
                                    "pitch_speed_ou", "ab_pitches_ou",
                                    "game_moneyline"])
def test_the_pre_existing_markets_opt_out(market):
    """They have no threshold, so they must not be regrouped at all -- the
    linear and remaining_table families carry columns this cannot aggregate."""
    assert get_spec(market).min_cell_obs == 0


def test_an_impossible_floor_fails_loudly():
    spec = _spec(10_000)
    with pytest.raises(ValueError, match="min_cell_obs"):
        fit(spec, _cells(), form_window="career", half_life=None)


# ── a rare positive class ───────────────────────────────────────────────────

def _rare_cells() -> pd.DataFrame:
    """One matchup cell of 206 PAs, split 6 'yes' / 200 'no'.

    The shape of batter_hr: cells are keyed by outcome as well as by features,
    and at a ~3% rate the positive row is a fraction of its negative twin.
    """
    base = {"season": 2024, "balls": 0, "strikes": 0,
            "career_bat_bucket": 1, "career_pit_bucket": -2,
            "d30_bat_bucket": 1, "d30_pit_bucket": -2}
    return pd.DataFrame([
        {**base, "outcome": "yes", "n": 6},
        {**base, "outcome": "no", "n": 200},
    ])


def test_a_rare_class_row_survives_on_the_cells_total():
    """The threshold is about the matchup, not the outcome row. Applied per
    row, 200 keeps 'no' and drops 'yes' -- which is not a stricter filter, it
    is a corrupted one: the cell's observed rate silently becomes 0."""
    out = collapse_to_window(_spec(200), _rare_cells(), "career",
                             apply_min_obs=True)
    assert sorted(out["outcome"]) == ["no", "yes"]
    assert out["n"].sum() == 206


def test_a_cell_below_the_floor_loses_every_outcome_row():
    """The converse: it clears as a unit or not at all, so a surviving cell
    never has a class quietly missing."""
    out = collapse_to_window(_spec(500), _rare_cells(), "career",
                             apply_min_obs=True)
    assert len(out) == 0


def test_a_rare_class_still_fits_after_the_floor():
    """The regression that caught this. Per-row filtering left sklearn with a
    single class and it refused the fold:
        ValueError: This solver needs samples of at least 2 classes
    """
    spec = _spec(200)
    cells = pd.concat([
        _rare_cells(),
        _rare_cells().assign(career_bat_bucket=-4, d30_bat_bucket=-4,
                             n=[2, 240]),
    ], ignore_index=True)
    result = fit(spec, cells, form_window="career", half_life=None)
    assert np.isfinite(np.array(result.coef)).all()
