"""The contact-quality lookup: P(hit) / P(HR) given how a ball was struck.

Runs the REAL SQL against a small synthetic corpus in local DuckDB. No R2, no
network. Synthetic rather than a fixture because the point of most of these is
a known answer -- a cell built from four hand-placed balls has an arithmetically
certain P(hit), which a recorded game does not.

Two things here are conventions rather than logic, and both would be silently
wrong rather than loud if inverted:

    the spray sign      negative toward the left-field line
    the pull flip       positive is always "toward the batter's pull side"

`test_spray_sign_follows_the_field` and `test_pull_flips_for_right_handers`
are the pins on those. They were validated against the live feed before being
written down -- see the module docstring in warehouse/contact.py.
"""

from __future__ import annotations

import io
import os
import tempfile
from datetime import date

import duckdb
import pyarrow.parquet as pq
import pytest

import warehouse.contact as C
from warehouse.config import CONTACT_SCHEMA
from warehouse.ingest import to_parquet

# Gameday coordinates that land in known parts of the field, read off the
# origin the spray formula uses (125.42, 198.27).
DEAD_CENTER = (125.42, 100.0)
TOWARD_LF = (60.0, 120.0)
TOWARD_RF = (190.0, 120.0)


def _ball(idx, *, ev=100.0, la=25.0, coords=DEAD_CENTER, side="R",
          detail="home_run"):
    """One ball in play plus the at-bat it ended, as a (pitch, at_bat) pair."""
    x, y = coords
    pitch = {
        "game_pk": 1, "at_bat_index": idx, "pitch_number": 1,
        "pitcher_id": 100, "batter_id": 200, "game_date": date(2024, 6, 1),
        "result_category": "in_play", "bat_side": side,
        "launch_speed": ev, "launch_angle": la,
        "hit_coord_x": x, "hit_coord_y": y,
    }
    at_bat = {
        "game_pk": 1, "at_bat_index": idx, "pitcher_id": 100,
        "batter_id": 200, "game_date": date(2024, 6, 1),
        "result": "hit" if detail in ("single", "double", "triple",
                                      "home_run") else "out",
        "result_detail": detail, "bat_side": side,
    }
    return pitch, at_bat


def _run(pairs, season_floor=2017):
    """Write the corpus to Parquet, register it, run the real SQL."""
    pitches = [p for p, _ in pairs]
    at_bats = [a for _, a in pairs]
    d = tempfile.mkdtemp()
    pp = os.path.join(d, "p.parquet").replace("\\", "/")
    ap = os.path.join(d, "a.parquet").replace("\\", "/")
    with open(pp, "wb") as f:
        f.write(to_parquet(pitches, "pitches"))
    with open(ap, "wb") as f:
        f.write(to_parquet(at_bats, "at_bats"))
    con = duckdb.connect()
    # DuckDB refuses prepared parameters inside CREATE VIEW, so the paths are
    # inlined -- the same constraint modeling/features.py documents.
    con.execute(f"create view pitches as select * from read_parquet('{pp}')")
    con.execute(f"create view at_bats as select * from read_parquet('{ap}')")
    try:
        return C.build(con, season_floor).to_pylist()
    finally:
        con.close()


def _cell(rows, grain, **kw):
    for r in rows:
        if r["grain"] == grain and all(r[k] == v for k, v in kw.items()):
            return r
    return None


# ── the rates ───────────────────────────────────────────────────────────────

def test_rates_are_counted_over_balls_in_play():
    rows = _run([_ball(i, detail=d) for i, d in enumerate(
        ["home_run", "single", "field_out", "field_out"])])
    c = _cell(rows, "ev_la", ev_bucket=100, la_bucket=25)
    assert c["n"] == 4
    assert c["hits"] == 2 and c["hr"] == 1
    assert c["p_hit"] == pytest.approx(0.5)
    assert c["p_hr"] == pytest.approx(0.25)


def test_expected_total_bases_weights_by_base_value():
    rows = _run([_ball(i, detail=d) for i, d in enumerate(
        ["single", "double", "triple", "home_run"])])
    c = _cell(rows, "ev_la", ev_bucket=100, la_bucket=25)
    assert c["total_bases"] == 1 + 2 + 3 + 4
    assert c["xtb"] == pytest.approx(2.5)
    assert c["p_xbh"] == pytest.approx(0.75)   # double, triple, HR


def test_strikeouts_and_walks_are_not_in_the_denominator():
    """Every rate is conditional on CONTACT.

    A plate appearance with no ball in play has no launch speed and no
    `in_play` pitch, so it must not reach the table at all. Treating these
    rates as per-PA would overstate a hitter by roughly a third.
    """
    pairs = [_ball(0, detail="single")]
    k_pitch, k_ab = _ball(1, detail="strikeout")
    k_pitch["result_category"] = "strike_foul"
    k_pitch["launch_speed"] = None
    k_pitch["launch_angle"] = None
    pairs.append((k_pitch, k_ab))

    rows = _run(pairs)
    assert sum(r["n"] for r in rows if r["grain"] == "ev_la") == 1


def test_balls_in_play_without_tracking_are_excluded():
    """An untracked ball is unknown, not average. Including it as a null cell
    would quietly dilute whichever bucket it fell into."""
    p, a = _ball(1, detail="home_run")
    p["launch_speed"] = None
    rows = _run([_ball(0, detail="single"), (p, a)])
    assert sum(r["n"] for r in rows if r["grain"] == "ev_la") == 1


# ── bucketing ───────────────────────────────────────────────────────────────

def test_buckets_carry_their_lower_edge_in_real_units():
    """So a consumer recovers the value without knowing the step."""
    rows = _run([_ball(i, ev=101.9, la=27.4) for i in range(2)])
    c = _cell(rows, "ev_la", ev_bucket=100, la_bucket=25)
    assert c is not None and c["n"] == 2


def test_values_beyond_the_clamps_collect_in_the_edge_bucket():
    """Deliberate. A 70-degree pop-up is an out at whichever exact degree, and
    splitting the tail produces cells too thin to mean anything."""
    rows = _run([_ball(i, la=85.0) for i in range(2)])
    assert _cell(rows, "ev_la", ev_bucket=100, la_bucket=C.LA_MAX) is not None


def test_integer_division_does_not_leak_fractional_buckets():
    """DuckDB's `/` is float division; a fractional bucket would produce one
    row per distinct fraction instead of one per bucket."""
    rows = _run([_ball(i, ev=100.0 + i * 0.1) for i in range(6)])
    ev_cells = {r["ev_bucket"] for r in rows if r["grain"] == "ev_la"}
    assert ev_cells == {100}
    assert all(isinstance(b, int) for b in ev_cells)


# ── the two conventions ─────────────────────────────────────────────────────

def test_spray_sign_follows_the_field():
    """Negative toward the left-field line, positive toward right.

    Validated against `hit_location` over 842 batted balls before being pinned
    here: 3B -35.2, LF -29.3, SS -15.8, CF +1.1, 2B +22.3, RF +30.8, 1B +48.8.

    Read through a LEFT-handed batter on purpose: for a lefty the pull flip is
    the identity, so the emitted bucket is the raw spray sign and the flip
    cannot mask an error in the formula.
    """
    lf = _run([_ball(i, coords=TOWARD_LF, side="L") for i in range(C.MIN_OBS)])
    rf = _run([_ball(i, coords=TOWARD_RF, side="L") for i in range(C.MIN_OBS)])
    lf_b = [r["pull_bucket"] for r in lf if r["grain"] == "ev_la_pull"]
    rf_b = [r["pull_bucket"] for r in rf if r["grain"] == "ev_la_pull"]
    assert len(lf_b) == 1 and len(rf_b) == 1
    assert lf_b[0] < 0, f"a ball to left field must spray negative, got {lf_b}"
    assert rf_b[0] >= 0, f"a ball to right field must spray positive, got {rf_b}"


def test_dead_center_sprays_near_zero():
    """The calibration check on HOME_X / HOME_Y.

    Against the live feed, balls fielded by the centre fielder averaged +1.1
    degrees. If the origin constants drift, this is what catches it.
    """
    rows = _run([_ball(i, coords=DEAD_CENTER, side="L")
                 for i in range(C.MIN_OBS)])
    b = [r["pull_bucket"] for r in rows if r["grain"] == "ev_la_pull"]
    assert b == [0], f"dead centre should land in the zero bucket, got {b}"


def test_pull_flips_for_right_handers():
    """A right-hander pulls to LEFT field, a left-hander to RIGHT.

    The flip is what makes the table handedness-agnostic. Without it the same
    physical outcome would land in opposite buckets for the two sides and each
    cell would carry half the sample it should.
    """
    sql = C.contact_quality_sql(2017)
    assert "case when bat_side = 'R' then -spray else spray end" in sql, (
        "the pull flip is the convention this table rests on")

    # Same field location, opposite handedness -> opposite pull sign.
    rows = _run([_ball(i, coords=TOWARD_LF, side="R") for i in range(30)]
                + [_ball(30 + i, coords=TOWARD_LF, side="L")
                   for i in range(30)])
    fine = [r for r in rows if r["grain"] == "ev_la_pull"]
    buckets = sorted(r["pull_bucket"] for r in fine)
    assert len(buckets) == 2, f"expected two pull cells, got {buckets}"
    assert buckets[0] < 0 < buckets[1], (
        f"a ball to left field must be PULLED for the RHB and OPPO for the "
        f"LHB; got {buckets}")


# ── the two grains ──────────────────────────────────────────────────────────

def test_fine_cells_below_the_floor_are_not_emitted():
    rows = _run([_ball(i, coords=TOWARD_LF) for i in range(C.MIN_OBS - 1)])
    assert [r for r in rows if r["grain"] == "ev_la_pull"] == []
    assert _cell(rows, "ev_la", ev_bucket=100, la_bucket=25)["n"] == C.MIN_OBS - 1


def test_fine_cells_at_the_floor_are_emitted():
    rows = _run([_ball(i, coords=TOWARD_LF) for i in range(C.MIN_OBS)])
    assert len([r for r in rows if r["grain"] == "ev_la_pull"]) == 1


def test_the_coarse_grain_is_always_populated():
    """It is the back-off target, so it carries no floor by design."""
    rows = _run([_ball(0)])
    assert [r for r in rows if r["grain"] == "ev_la"]


def test_the_two_grains_agree_on_totals():
    """Marginalising over spray must not lose or duplicate a ball."""
    rows = _run([_ball(i, coords=TOWARD_LF) for i in range(C.MIN_OBS)])
    coarse = sum(r["n"] for r in rows if r["grain"] == "ev_la")
    fine = sum(r["n"] for r in rows if r["grain"] == "ev_la_pull")
    assert coarse == fine == C.MIN_OBS


def test_a_ball_with_no_coordinates_still_reaches_the_coarse_grain():
    """Spray is missing more often than launch speed. Dropping the ball
    entirely would bias the coarse grain toward tracked-spray contact."""
    p, a = _ball(0, detail="single")
    p["hit_coord_x"] = p["hit_coord_y"] = None
    rows = _run([(p, a)])
    assert _cell(rows, "ev_la", ev_bucket=100, la_bucket=25)["n"] == 1
    assert [r for r in rows if r["grain"] == "ev_la_pull"] == []


# ── the season floor ────────────────────────────────────────────────────────

def test_seasons_before_the_floor_are_excluded():
    """Pre-2017 launch_speed covers 87% of balls in play, so an earlier cell
    measures tracking coverage rather than contact."""
    old_p, old_a = _ball(1, detail="home_run")
    old_p["game_date"] = old_a["game_date"] = date(2015, 6, 1)
    rows = _run([_ball(0, detail="single"), (old_p, old_a)])
    assert sum(r["n"] for r in rows if r["grain"] == "ev_la") == 1


def test_season_floor_is_stamped_on_every_row():
    """`scope='career'` means "everything in the window", not everything ever.
    The stamp is what stops a reader assuming 2015."""
    rows = _run([_ball(0)], season_floor=2019)
    assert {r["season_floor"] for r in rows} == {2019}


# ── the output contract ─────────────────────────────────────────────────────

def test_rows_match_the_declared_schema():
    rows = _run([_ball(i, coords=TOWARD_LF) for i in range(C.MIN_OBS)])
    tbl = pq.read_table(io.BytesIO(to_parquet(rows, "contact_quality")))
    assert tbl.schema.equals(CONTACT_SCHEMA)


def test_builder_emits_a_key_for_every_schema_column():
    rows = _run([_ball(0)])
    declared = {f.name for f in CONTACT_SCHEMA}
    assert declared - set(rows[0]) == set()
    assert set(rows[0]) - declared == set()


# ── the back-off ────────────────────────────────────────────────────────────

def test_lookup_prefers_the_fine_grain():
    rows = _run([_ball(i, coords=TOWARD_LF, side="R")
                 for i in range(C.MIN_OBS)])
    fine = [r for r in rows if r["grain"] == "ev_la_pull"][0]
    hit = C.lookup(rows, 100.0, 25.0, float(fine["pull_bucket"]))
    assert hit is not None and hit["grain"] == "ev_la_pull"
    assert hit["n"] == C.MIN_OBS


def test_lookup_backs_off_when_spray_is_unknown():
    rows = _run([_ball(i, coords=TOWARD_LF, side="R")
                 for i in range(C.MIN_OBS)])
    assert C.lookup(rows, 100.0, 25.0, None)["grain"] == "ev_la"


def test_lookup_backs_off_when_the_fine_cell_is_missing():
    """The reason both grains ship in one table: the fall-through is by
    construction, not by the consumer remembering to write it."""
    rows = _run([_ball(i, coords=TOWARD_LF, side="R")
                 for i in range(C.MIN_OBS)])
    # A pull angle in a bucket no fine cell covers.
    fine = [r for r in rows if r["grain"] == "ev_la_pull"][0]
    away = float(fine["pull_bucket"]) - 2 * C.PULL_STEP
    assert C.lookup(rows, 100.0, 25.0, away)["grain"] == "ev_la"


def test_lookup_returns_none_without_tracking():
    rows = _run([_ball(0)])
    assert C.lookup(rows, None, 25.0, 0.0) is None
    assert C.lookup(rows, 100.0, None, 0.0) is None
