"""Form-spine correctness, especially the leakage rule.

A trailing window that includes the current game leaks the outcome into its own
feature. The model then looks brilliant offline and is worthless live. The
window bound must be `interval 1 day preceding` -- exclusive of today.
"""

from __future__ import annotations

import datetime

import duckdb
import pytest

from modeling.features import FORM_SPINE_AB_SQL, FORM_SPINE_SQL


@pytest.fixture()
def con():
    c = duckdb.connect()
    c.execute("set enable_progress_bar = false")
    # Three days for one pitcher. Day 3 is a total outlier: if any rolling
    # feature for day 3 reflects day 3, the leak is visible as a changed value.
    c.execute("""
        create table pitches as
        select * from (values
            (1, date '2024-04-01', 1, 100.0),
            (1, date '2024-04-01', 1, 100.0),
            (1, date '2024-04-02', 1, 100.0),
            (1, date '2024-04-02', 1, 100.0),
            (1, date '2024-04-03', 0,   1.0),
            (1, date '2024-04-03', 0,   1.0)
        ) as t(pitcher_id, game_date, in_zone, start_speed)
    """)
    return c


def _spine(con):
    con.execute(f"create table spine as {FORM_SPINE_SQL}")
    return {r[0]: r for r in con.execute(
        "select game_date, career_zone_rate, career_velo, career_n "
        "from spine order by game_date").fetchall()}


def test_first_day_has_no_prior_history(con):
    rows = _spine(con)
    first = rows[datetime.date(2024, 4, 1)]
    assert first[3] == 0 or first[1] is None, \
        "day 1 must have no prior rows -- there is no history before it"


def test_window_excludes_the_current_day(con):
    rows = _spine(con)
    day3 = rows[datetime.date(2024, 4, 3)]
    # Days 1-2 were all in-zone at 100 mph. Day 3 is 0% in-zone at 1 mph.
    # If day 3 leaked into its own feature these would be pulled toward 0.
    assert day3[1] == pytest.approx(1.0), \
        f"day 3 zone_rate {day3[1]} reflects day 3 -- LEAK"
    assert day3[2] == pytest.approx(100.0), \
        f"day 3 velo {day3[2]} reflects day 3 -- LEAK"
    assert day3[3] == 4, "day 3 should see exactly the 4 prior pitches"


def _window_clauses(sql: str) -> str:
    """The `window ... as (...)` tail, whitespace-normalised."""
    return " ".join(sql.rsplit("\nwindow\n", 1)[1].split())


def test_both_spines_share_one_leakage_bound():
    """The pitch and plate-appearance spines must not drift apart.

    They are separate SQL strings over different tables, so nothing but this
    test stops someone relaxing `interval 1 day preceding` in one of them. A
    leak in either is a leak in the markets built on it.
    """
    assert _window_clauses(FORM_SPINE_SQL) == _window_clauses(FORM_SPINE_AB_SQL)
    assert _window_clauses(FORM_SPINE_SQL).count("interval 1 day preceding") == 3


def test_ab_spine_excludes_the_current_day():
    c = duckdb.connect()
    c.execute("""
        create table at_bats as
        select * from (values
            (1, date '2024-04-01', 'strikeout'),
            (1, date '2024-04-02', 'strikeout'),
            (1, date '2024-04-03', 'hit'),
            (1, date '2024-04-03', 'hit')
        ) as t(pitcher_id, game_date, result)
    """)
    c.execute(f"create table spine as {FORM_SPINE_AB_SQL}")
    row = c.execute("select career_k_rate, career_n from spine "
                    "where game_date = date '2024-04-03'").fetchone()
    assert row[0] == pytest.approx(1.0), \
        f"day 3 k_rate {row[0]} reflects day 3's hits -- LEAK"
    assert row[1] == 2


def test_trailing_window_is_bounded(con):
    """d30 must not reach back further than 30 days."""
    con.execute("""
        insert into pitches values
            (1, date '2024-01-01', 0, 1.0),
            (1, date '2024-01-01', 0, 1.0)
    """)
    con.execute(f"create table spine as {FORM_SPINE_SQL}")
    row = con.execute(
        "select d30_n, career_n from spine where game_date = date '2024-04-03'"
    ).fetchone()
    assert row[0] == 4, "d30 must exclude the January rows"
    assert row[1] == 6, "career must include them"
