"""batted_ball_profile and park_hr_factors.

Runs the REAL builder SQL against a small synthetic corpus in local DuckDB.
Separate from test_aggregates.py, which shares one warehouse fixture across
every builder: both of these need contact placed in specific parts of the
field, or specific clubs hosting specific games, and bending the shared
fixture to that would make it serve nothing well.

The two things here that are conventions rather than logic, and would be
silently wrong rather than loud:

    pull vs oppo       positive pull angle is always "toward this batter's
                       pull side", which means a ball to LEFT field is pulled
                       for a right-hander and opposite-field for a lefty
    the park factor    paired home-vs-away, NOT a venue rate against the
                       league mean, because the latter confounds the park
                       with the club that plays in it
"""

from __future__ import annotations

import os
import tempfile
from datetime import date

import duckdb
import pytest

from warehouse import aggregates as agg
from warehouse.ingest import to_parquet

pytest.importorskip("duckdb")

SEASON = 2024


def approx4(x):
    """Every rate in these builders is round(..., 4) in SQL.

    pytest.approx defaults to a 1e-6 relative tolerance, which is finer than
    the stored precision -- 2/3 comes back as 0.6667 and fails against
    0.666666... Compare at the precision the column actually has.
    """
    return pytest.approx(x, abs=1e-4)

# Field coordinates, read off the spray origin (125.42, 198.27).
TO_LF = (60.0, 120.0)
TO_CF = (125.42, 100.0)
TO_RF = (190.0, 120.0)


def _pitch(abi, *, batter=200, pitcher=100, traj="fly_ball", coords=TO_CF,
           side="R", ev=100.0, la=25.0, game_pk=1, day=date(SEASON, 6, 1)):
    x, y = coords
    return {
        "game_pk": game_pk, "at_bat_index": abi, "pitch_number": 1,
        "pitcher_id": pitcher, "batter_id": batter, "game_date": day,
        "result_category": "in_play", "bat_side": side,
        "trajectory": traj, "launch_speed": ev, "launch_angle": la,
        "hit_coord_x": x, "hit_coord_y": y,
    }


def _ab(abi, *, detail="field_out", game_pk=1, day=date(SEASON, 6, 1),
        top=True):
    return {
        "game_pk": game_pk, "at_bat_index": abi, "pitcher_id": 100,
        "batter_id": 200, "game_date": day, "top_inning": top,
        "result": "hit" if detail in ("single", "double", "triple",
                                      "home_run") else "out",
        "result_detail": detail,
    }


def _game(game_pk, *, home=1, away=2, venue=9, day=date(SEASON, 6, 1)):
    return {"game_pk": game_pk, "game_date": day, "season": SEASON,
            "game_type": "R", "status": "Final", "home_team_id": home,
            "away_team_id": away, "venue_id": venue,
            "venue_name": f"Park {venue}", "home_score": 1, "away_score": 0}


def _con(pitches=(), at_bats=(), games=()):
    """Register a synthetic corpus and hand back a connection.

    `_scoped` in aggregates.py derives its windows from max(game_date) in the
    data itself, so a single-day corpus lands in all three scopes at once --
    which is why the assertions below pick a scope explicitly.
    """
    d = tempfile.mkdtemp()
    con = duckdb.connect()
    for name, rows in (("pitches", pitches), ("at_bats", at_bats),
                       ("games", games)):
        pth = os.path.join(d, f"{name}.parquet").replace("\\", "/")
        with open(pth, "wb") as f:
            f.write(to_parquet(list(rows), name))
        # DuckDB refuses prepared parameters inside CREATE VIEW.
        con.execute(f"create view {name} as select * from read_parquet('{pth}')")
    return con


def _bb(pitches, scope="career", role="batter"):
    rows = agg.batted_ball_profile(_con(pitches=pitches), SEASON).to_pylist()
    return [r for r in rows if r["scope"] == scope and r["role"] == role]


# ── batted-ball rates ───────────────────────────────────────────────────────

def test_trajectory_rates_sum_to_one():
    """The invariant that proves nothing falls outside every category.

    Verified on the live feed too: every batter row summed to exactly 1.000.
    """
    trajs = ["ground_ball"] * 10 + ["fly_ball"] * 6 + ["line_drive"] * 5 + \
            ["popup"] * 4
    rows = _bb([_pitch(i, traj=t) for i, t in enumerate(trajs)])
    r = rows[0]
    total = r["gb_rate"] + r["fb_rate"] + r["ld_rate"] + r["popup_rate"]
    assert total == approx4(1.0)
    assert r["gb_rate"] == approx4(10 / 25)
    assert r["fb_rate"] == approx4(6 / 25)


def test_bunt_variants_fold_into_their_base_trajectory():
    """`bunt_grounder` and friends are ~0.8% of balls in play. Matching the
    exact string would drop them out of every rate and the four would stop
    summing to one."""
    trajs = ["ground_ball"] * 10 + ["bunt_grounder"] * 5 + ["fly_ball"] * 10
    rows = _bb([_pitch(i, traj=t) for i, t in enumerate(trajs)])
    r = rows[0]
    assert r["gb_rate"] == approx4(15 / 25), "bunt grounders were dropped"
    assert (r["gb_rate"] + r["fb_rate"] + r["ld_rate"]
            + r["popup_rate"]) == approx4(1.0)


def test_pull_is_left_field_for_a_right_hander():
    rows = _bb([_pitch(i, coords=TO_LF, side="R") for i in range(25)])
    assert rows[0]["pull_rate"] == approx4(1.0)
    assert rows[0]["oppo_rate"] == approx4(0.0)


def test_pull_is_right_field_for_a_left_hander():
    """The flip. Without it the same physical ball would count as pulled for
    one handedness and opposite-field for the other."""
    rows = _bb([_pitch(i, coords=TO_RF, side="L") for i in range(25)])
    assert rows[0]["pull_rate"] == approx4(1.0)

    oppo = _bb([_pitch(i, coords=TO_LF, side="L") for i in range(25)])
    assert oppo[0]["oppo_rate"] == approx4(1.0)


def test_straightaway_contact_is_neither_pulled_nor_opposite():
    rows = _bb([_pitch(i, coords=TO_CF) for i in range(25)])
    assert rows[0]["pull_rate"] == approx4(0.0)
    assert rows[0]["oppo_rate"] == approx4(0.0)


def test_pull_air_rate_requires_both_pulled_and_airborne():
    """The column the build is for. A pull hitter who beats everything into
    the ground and one who lifts it have the same pull_rate and the same
    fb_rate is not enough either -- only the conjunction separates them."""
    pulled_air = [_pitch(i, coords=TO_LF, traj="fly_ball") for i in range(10)]
    pulled_gb = [_pitch(10 + i, coords=TO_LF, traj="ground_ball")
                 for i in range(10)]
    oppo_air = [_pitch(20 + i, coords=TO_RF, traj="fly_ball")
                for i in range(10)]
    r = _bb(pulled_air + pulled_gb + oppo_air)[0]

    assert r["pull_rate"] == approx4(20 / 30)
    assert r["fb_rate"] == approx4(20 / 30)
    assert r["pull_air_rate"] == approx4(10 / 30), (
        "pull_air_rate must count only balls that are BOTH pulled and in the air")


def test_line_drives_count_as_airborne():
    r = _bb([_pitch(i, coords=TO_LF, traj="line_drive")
             for i in range(25)])[0]
    assert r["pull_air_rate"] == approx4(1.0)


def test_hard_hit_uses_the_95_mph_threshold():
    hard = [_pitch(i, ev=95.0) for i in range(10)]
    soft = [_pitch(10 + i, ev=94.9) for i in range(15)]
    r = _bb(hard + soft)[0]
    assert r["hard_hit_rate"] == approx4(10 / 25)


def test_untracked_balls_leave_the_denominator_of_their_own_rate():
    """A ball with no launch speed is unknown, not slow. It still counts as a
    ball in play -- it had a trajectory -- but must not dilute hard_hit_rate.
    """
    tracked = [_pitch(i, ev=100.0) for i in range(10)]
    untracked = [_pitch(10 + i, ev=None) for i in range(15)]
    r = _bb(tracked + untracked)[0]
    assert r["bip"] == 25
    assert r["hard_hit_rate"] == approx4(1.0), (
        "untracked balls must not appear in the hard-hit denominator")


def test_the_pitcher_side_is_built_too():
    """A pitcher's batted-ball profile is a real scouting fact and has no
    place in batter_power_profile, which is why this table carries a role."""
    pitches = [_pitch(i, coords=TO_LF) for i in range(25)]
    rows = agg.batted_ball_profile(_con(pitches=pitches), SEASON).to_pylist()
    roles = {r["role"] for r in rows}
    assert roles == {"batter", "pitcher"}
    p = [r for r in rows if r["role"] == "pitcher" and r["scope"] == "career"]
    assert p and p[0]["bip"] == 25


def test_the_minimum_balls_in_play_floor_applies():
    assert _bb([_pitch(i) for i in range(agg.MIN_BIP - 1)]) == []
    assert len(_bb([_pitch(i) for i in range(agg.MIN_BIP)])) == 1


def test_season_floor_is_stamped():
    rows = _bb([_pitch(i) for i in range(25)])
    assert rows[0]["season_floor"] == SEASON


# ── park home-run factors ───────────────────────────────────────────────────

def _park_corpus(home_hr_every, away_hr_every, n=200):
    """Club 1 hosts at venue 9; club 2 hosts at venue 10.

    `home_hr_every` controls the home-run rate in club 1's park and
    `away_hr_every` the rate in club 2's, so the expected factor for venue 9
    is the ratio of the two.
    """
    at_bats, games = [], []
    for g, (venue, home, away, every) in enumerate((
            (9, 1, 2, home_hr_every), (10, 2, 1, away_hr_every))):
        games.append(_game(g + 1, home=home, away=away, venue=venue))
        for i in range(n):
            at_bats.append(_ab(i, game_pk=g + 1,
                               detail="home_run" if i % every == 0
                               else "field_out"))
    return at_bats, games


def test_park_factor_is_the_ratio_of_home_to_away_rate():
    """Venue 9 yields a home run every 4 PA, venue 10 every 8, so club 1 --
    who hosts at 9 and travels to 10 -- should read about 2.0 raw."""
    at_bats, games = _park_corpus(4, 8)
    rows = agg.park_hr_factors(_con(at_bats=at_bats, games=games),
                               SEASON).to_pylist()
    by_venue = {r["venue_id"]: r for r in rows}
    assert set(by_venue) == {9, 10}
    assert by_venue[9]["raw_factor"] == pytest.approx(2.0, rel=0.02)
    assert by_venue[10]["raw_factor"] == pytest.approx(0.5, rel=0.02)


def test_a_neutral_park_reads_one():
    at_bats, games = _park_corpus(5, 5)
    rows = agg.park_hr_factors(_con(at_bats=at_bats, games=games),
                               SEASON).to_pylist()
    assert all(r["raw_factor"] == pytest.approx(1.0, rel=0.02) for r in rows)
    assert all(r["hr_factor"] == pytest.approx(1.0, rel=0.02) for r in rows)


def test_both_clubs_batting_are_counted_at_the_park():
    """The point of the paired construction. Counting only the home club's own
    home runs would measure the roster, not the park."""
    at_bats, games = _park_corpus(4, 8, n=200)
    rows = agg.park_hr_factors(_con(at_bats=at_bats, games=games),
                               SEASON).to_pylist()
    # 200 PA per game, and each club sees every PA of the game it plays in.
    assert {r["home_pa"] for r in rows} == {200}
    assert {r["away_pa"] for r in rows} == {200}


def test_shrinkage_pulls_a_thin_sample_toward_neutral():
    """A single venue-season is genuinely weak evidence. The raw factor must
    survive untouched beside it so a consumer can shrink differently."""
    # 60 PA at one home run every 4 is 15; every 8 is 8. The ratio is 15/8,
    # not 2.0 -- that only holds when n is a multiple of both.
    at_bats, games = _park_corpus(4, 8, n=60)
    r = [x for x in agg.park_hr_factors(_con(at_bats=at_bats, games=games),
                                        SEASON).to_pylist()
         if x["venue_id"] == 9][0]
    assert r["home_pa"] == 60 and r["home_hr"] == 15
    assert r["away_hr"] == 8
    assert r["raw_factor"] == approx4(15 / 8)
    assert 1.0 < r["hr_factor"] < 1.05, (
        f"60 PA should barely move off neutral, got {r['hr_factor']}")


def test_a_club_that_never_travels_produces_no_row():
    """Not a defect: with no away rate there is no denominator, and emitting
    a factor of 1.0 would assert we measured a neutral park rather than that
    we could not measure one."""
    games = [_game(1, home=1, away=2, venue=9)]
    at_bats = [_ab(i, game_pk=1, detail="home_run" if i % 4 == 0
                   else "field_out") for i in range(200)]
    rows = agg.park_hr_factors(_con(at_bats=at_bats, games=games),
                               SEASON).to_pylist()
    assert rows == []


def test_non_regular_season_games_are_excluded():
    at_bats, games = _park_corpus(4, 8)
    for g in games:
        g["game_type"] = "S"      # spring training
    rows = agg.park_hr_factors(_con(at_bats=at_bats, games=games),
                               SEASON).to_pylist()
    assert rows == []


def test_the_factor_is_keyed_by_season_because_fences_move():
    """Camden Yards reports left_center 410 through 2022 and 376 from 2026.
    One all-history factor would average a park across two shapes."""
    cols = set(agg.park_hr_factors(_con(at_bats=[], games=[]),
                                   SEASON).schema.names)
    assert {"venue_id", "season"} <= cols
    assert {"raw_factor", "hr_factor", "home_pa", "away_pa"} <= cols
