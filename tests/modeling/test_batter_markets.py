"""The batter markets, end to end on a synthetic corpus.

Builds real spines and runs the real `cell_sql` in local DuckDB, then fits the
result -- no R2, no network. This is the closest thing to `python -m modeling
build` that runs without credentials, and it is what says the SQL, the spec
and the engine agree with each other.

What it does NOT say is whether either model is any good. That needs the real
11-season corpus and the walk-forward gate, which needs R2.

The planted signal is deliberate: batters 300-303 have wildly different home
run rates, so a fit that cannot recover a positive coefficient on
`batter_hr_delta` is broken rather than merely uninformative.
"""

from __future__ import annotations

import os
import tempfile
from datetime import date, timedelta

import duckdb
import pytest

from modeling import features
from modeling.fit import _design, fit
from modeling.spec import get_spec
from warehouse.ingest import to_parquet

pytest.importorskip("duckdb")

SEASON = 2024
DAYS = 40
BATTERS = (300, 301, 302, 303)
PITCHERS = (400, 401)

# Home runs per plate appearance, planted per batter. Spans a far wider range
# than reality so the signal is unmistakable in 40 days of data.
HR_RATE = {300: 0.40, 301: 0.20, 302: 0.05, 303: 0.00}
HIT_RATE = {300: 0.50, 301: 0.35, 302: 0.20, 303: 0.10}


def _corpus():
    """One at-bat row per batter-pitcher pair per day, repeated."""
    rows, abi = [], 0
    start = date(SEASON, 5, 1)
    for d in range(DAYS):
        gd = start + timedelta(days=d)
        for pitcher in PITCHERS:
            for batter in BATTERS:
                for rep in range(10):
                    # Deterministic, so the planted rate is exact.
                    is_hr = rep < round(HR_RATE[batter] * 10)
                    is_hit = rep < round(HIT_RATE[batter] * 10)
                    detail = ("home_run" if is_hr
                              else "single" if is_hit else "field_out")
                    rows.append({
                        "game_pk": 900000 + d, "at_bat_index": abi,
                        "pitcher_id": pitcher, "batter_id": batter,
                        "game_date": gd, "inning": 1, "top_inning": True,
                        "pitch_count": 4,
                        "result": "hit" if is_hit else "out",
                        "result_detail": detail, "event": detail,
                        "rbi": 0, "is_scoring_play": False,
                        "men_on_base": "Empty", "home_score": 0,
                        "away_score": 0, "times_through_order": 1,
                        # Batter 300 is a lefty; the rest bat right. Pitchers
                        # throw right, so 300 is the only platoon mismatch.
                        "bat_side": "L" if batter == 300 else "R",
                        "pitch_hand": "R",
                    })
                    abi += 1
    return rows


def _con_for(rows):
    """A connection holding `at_bats` plus both spines the markets join."""
    d = tempfile.mkdtemp()
    path = os.path.join(d, "at_bats.parquet").replace("\\", "/")
    with open(path, "wb") as f:
        f.write(to_parquet(rows, "at_bats"))

    c = duckdb.connect()
    c.execute("set enable_progress_bar = false")
    # DuckDB refuses prepared parameters inside CREATE VIEW.
    c.execute(f"create view at_bats as select * from read_parquet('{path}')")
    c.execute(f"create table form_spine_ab as {features.FORM_SPINE_AB_SQL}")
    c.execute(
        f"create table form_spine_bat_ab as {features.FORM_SPINE_BAT_AB_SQL}")
    return c


@pytest.fixture(scope="module")
def con():
    c = _con_for(_corpus())
    yield c
    c.close()


def _cells(con, market):
    spec = get_spec(market)
    return con.execute(spec.cell_sql).df()


# ── the cell SQL runs and means what it says ────────────────────────────────

@pytest.mark.parametrize("market", ["batter_hr", "batter_hit"])
def test_cell_sql_builds_non_empty_cells(con, market):
    """The failure `build_cells` refuses to continue past.

    An empty cell table is the shape a silent partial train takes, which is
    what froze the v1 trainer -- so it is worth asserting before anything
    downstream is trusted.
    """
    cells = _cells(con, market)
    assert len(cells) > 0, f"{market}: cell_sql produced nothing"
    assert cells["n"].sum() > 0


@pytest.mark.parametrize("market", ["batter_hr", "batter_hit"])
def test_cells_carry_a_bucket_column_per_window_and_dimension(con, market):
    """Six bucket columns: two form dimensions x three windows.

    `_design` reads `{window}_{bucket_col}`, so a missing one is a build-time
    failure on a sweep step rather than at construction.
    """
    spec = get_spec(market)
    cells = _cells(con, market)
    for window in spec.form_windows:
        for ff in spec.form_features:
            assert ff.column(window) in cells.columns, (
                f"{market}: cell_sql did not emit {ff.column(window)}")


@pytest.mark.parametrize("market,classes", [
    ("batter_hr", {"home_run", "other"}),
    ("batter_hit", {"hit", "other"}),
])
def test_outcomes_are_exactly_the_declared_classes(con, market, classes):
    """A class in the cells that the spec does not list is silently dropped by
    the fit; one the spec lists but the cells never produce makes a column of
    zeros. Either is a model that does not do what its name says."""
    cells = _cells(con, market)
    assert set(cells["outcome"]) == classes


def test_a_home_run_is_a_strict_subset_of_a_hit(con):
    """The corpus itself, before any cell floor touches it.

    `result_detail = 'home_run'` implies `result = 'hit'`, so the two markets
    must never disagree about a plate appearance. Asserted against the raw
    at-bats rather than the cells, because MIN_OBS drops thin cells and the
    surviving fractions are therefore NOT the corpus rates -- a distinction
    that cost me a wrong expectation before it was written down.
    """
    pa, hr, hit, both = con.execute("""
        select count(*),
               sum(case when result_detail = 'home_run' then 1 else 0 end),
               sum(case when result = 'hit' then 1 else 0 end),
               sum(case when result_detail = 'home_run' and result = 'hit'
                        then 1 else 0 end)
        from at_bats""").fetchone()
    assert hr == both, "a home run that is not recorded as a hit"
    assert 0 < hr < hit < pa


def test_the_home_run_market_reads_result_detail_not_result(con):
    """The direct test, on a corpus with hits but NO home runs.

    A market reading `result` would label every single a home run. Here that
    shows up as positives appearing where there are none, which no amount of
    cell-floor arithmetic can explain away.
    """
    rows = [dict(r) for r in _corpus()]
    for r in rows:
        if r["result_detail"] == "home_run":
            r["result_detail"] = "single"      # still a hit, no longer a HR
    c = _con_for(rows)
    try:
        hr_cells = c.execute(get_spec("batter_hr").cell_sql).df()
        hit_cells = c.execute(get_spec("batter_hit").cell_sql).df()
        assert (hr_cells["outcome"] == "home_run").sum() == 0, (
            "batter_hr found home runs in a corpus containing none -- it is "
            "reading `result`, which collapses every hit into one bucket")
        assert (hit_cells["outcome"] == "hit").sum() > 0, (
            "the hits are still there; only the home runs were removed")
    finally:
        c.close()


def test_platoon_same_is_zero_for_a_switch_or_unknown_side(con):
    """Batter 300 bats left against right-handed pitching, so it is the only
    mismatch in the corpus; the rest are same-handed."""
    cells = _cells(con, "batter_hr")
    assert set(cells["platoon_same"]) == {0, 1}


# ── the engine accepts them ─────────────────────────────────────────────────

@pytest.mark.parametrize("market", ["batter_hr", "batter_hit"])
def test_design_matrix_builds_from_real_cells(con, market):
    spec = get_spec(market)
    cells = _cells(con, market)
    X = _design(spec, cells, "career")
    assert X.shape == (len(cells), len(spec.feature_names))
    # The two form columns must not be the same array.
    assert not (X[:, 0] == X[:, 1]).all(), (
        f"{market}: batter and pitcher form columns are identical")


@pytest.mark.parametrize("market", ["batter_hr", "batter_hit"])
def test_fit_runs_and_shapes_its_output(con, market):
    spec = get_spec(market)
    result = fit(spec, _cells(con, market), form_window="career",
                 half_life=None)
    assert result.family == "multinomial_logistic"
    assert len(result.coef) == len(spec.classes) == 2
    assert len(result.coef[0]) == len(spec.feature_names)
    params = spec.to_params(result, "career")
    assert params["type"] == "multinomial_logistic"
    assert params["features"] == list(spec.feature_names)


def test_fit_recovers_the_planted_home_run_signal(con):
    """A batter who homers more should raise P(home run).

    Not a claim about the real model -- the corpus is synthetic and the effect
    is planted an order of magnitude larger than reality. It is the check that
    the bucket -> delta -> coefficient path is wired the right way round; a
    sign error here would look like a merely weak model.
    """
    spec = get_spec("batter_hr")
    result = fit(spec, _cells(con, "batter_hr"), form_window="career",
                 half_life=None)
    hr_class = spec.classes.index("home_run")
    bat_feat = spec.feature_names.index("batter_hr_delta")
    assert result.coef[hr_class][bat_feat] > 0, (
        "a higher batter home-run rate must raise P(home run)")


def test_fit_recovers_the_planted_hit_signal(con):
    spec = get_spec("batter_hit")
    result = fit(spec, _cells(con, "batter_hit"), form_window="career",
                 half_life=None)
    hit_class = spec.classes.index("hit")
    bat_feat = spec.feature_names.index("batter_hit_delta")
    assert result.coef[hit_class][bat_feat] > 0


@pytest.mark.parametrize("market", ["batter_hr", "batter_hit"])
def test_every_form_window_is_fittable(con, market):
    """A sweep visits all three. One that errors would surface as a crashed
    sweep rather than a bad score."""
    spec = get_spec(market)
    cells = _cells(con, market)
    for window in spec.form_windows:
        assert fit(spec, cells, form_window=window, half_life=None).coef


# ── the spines they depend on ───────────────────────────────────────────────

def test_declared_spines_are_the_ones_the_sql_joins(con):
    """`spines` drives what `python -m modeling build` materializes. A spec
    that joins a spine it did not declare fails only at build time, against
    R2, which is the slowest possible place to find out."""
    import re

    for market in ("batter_hr", "batter_hit"):
        spec = get_spec(market)
        for name in features.SPINE_BUILDERS:
            # Word boundary, not substring: "join form_spine" is a prefix of
            # "join form_spine_ab", so a plain `in` reports every spine as
            # joined and the assertion passes for the wrong reason.
            joined = re.search(rf"join\s+{name}\b", spec.cell_sql) is not None
            assert joined == (name in spec.spines), (
                f"{market}: {name} joined={joined} declared="
                f"{name in spec.spines}")
