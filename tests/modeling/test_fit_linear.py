"""The linear family, and the sigma that turns it into a probability."""

from __future__ import annotations

import pandas as pd

from modeling.fit import fit
from modeling.spec import get_spec


def _cells() -> pd.DataFrame:
    rows = []
    for season in (2023, 2024):
        for strikes in (0, 1, 2):
            rows.append({"season": season, "balls": 0, "strikes": strikes,
                         "mean_speed": 92.0 + strikes, "var_speed": 4.0,
                         "n": 1000.0, "career_velo_bucket": 0,
                         "d30_velo_bucket": 0, "d90_velo_bucket": 0,
                         "pitch_of_pa": 1})
    return pd.DataFrame(rows)


def test_linear_fit_produces_sigma():
    spec = get_spec("pitch_speed_ou")
    result = fit(spec, _cells(), form_window="career", half_life=None)
    assert result.family == "linear"
    assert result.sigma is not None and result.sigma > 0


def test_sigma_includes_within_cell_variance():
    """Cells are aggregates: sigma must combine between- and within-cell spread.

    Using only the residuals of the cell means would understate sigma badly,
    and an understated sigma produces confidently wrong P(over).
    """
    spec = get_spec("pitch_speed_ou")
    result = fit(spec, _cells(), form_window="career", half_life=None)
    assert result.sigma >= 2.0, \
        "sigma must be at least sqrt(within-cell var)=2.0 from var_speed=4.0"
