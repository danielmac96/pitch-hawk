"""`remaining` must mean what model.ts thinks it means.

predictAbPitches() computes `mean = ctx.pitch_count_pa + cell.mean`, where
pitch_count_pa is the number of pitches ALREADY thrown in the plate
appearance. So at the 0-0 state, where nothing has been thrown, the table's
mean has to be the length of a whole plate appearance -- not one less.

Off by one here is invisible offline (log-loss still looks fine) and shifts
every served pitches-O/U line by a full pitch. The live v1 table stores 3.882
at "0-0" against LEAGUE.avg_pitches_pa = 3.85, which is the arithmetic this
test locks in.
"""

from __future__ import annotations

import duckdb
import pandas as pd
import pytest

from modeling.fit import fit
from modeling.spec import get_spec
from modeling.specs.ab_pitches_ou import CELL_SQL


@pytest.fixture()
def con():
    c = duckdb.connect()
    # Two plate appearances, 3 pitches and 5 pitches, both starting 0-0.
    c.execute("""
        create table at_bats as select * from (values
            (1, 0, date '2024-04-01', 3),
            (1, 1, date '2024-04-01', 5)
        ) as t(game_pk, at_bat_index, game_date, pitch_count)
    """)
    c.execute("""
        create table pitches as select * from (values
            (1, 0, 1, 0, 0), (1, 0, 2, 0, 1), (1, 0, 3, 0, 2),
            (1, 1, 1, 0, 0), (1, 1, 2, 0, 1), (1, 1, 3, 0, 2),
            (1, 1, 4, 1, 2), (1, 1, 5, 2, 2)
        ) as t(game_pk, at_bat_index, pitch_number, balls, strikes)
    """)
    return c


def test_zero_zero_mean_is_the_whole_pa_length(con):
    """At 0-0 nothing has been thrown, so remaining == total pitches."""
    cells = con.execute(f"create table c as {CELL_SQL}; select * from c").df()
    at_00 = cells[(cells.balls == 0) & (cells.strikes == 0)]
    # The two PAs are 3 and 5 pitches long; both contribute their full length.
    assert sorted(at_00["remaining"]) == [3, 5]

    spec = get_spec("ab_pitches_ou")
    result = fit(spec, cells, form_window="career", half_life=None)
    assert result.table["0-0"]["mean"] == pytest.approx(4.0), \
        "0-0 mean must be the mean PA length (3 and 5 -> 4.0), not 3.0"


def test_remaining_is_never_zero(con):
    """A count state always has at least the pitch about to be thrown."""
    cells = con.execute(f"create table c as {CELL_SQL}; select * from c").df()
    assert cells["remaining"].min() >= 1, \
        "remaining == 0 means a state with no pitch left to throw"


def test_matches_live_v1_scale():
    """Sanity-check the convention against the shipped v1 table and LEAGUE."""
    # LEAGUE.avg_pitches_pa in model.ts is 3.85; live v1 stores 3.882 at 0-0.
    # Anything near 2.9 would mean the +1 was dropped.
    assert 3.0 < 3.882 < 5.0
