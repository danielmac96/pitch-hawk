"""Tests for the warehouse flatteners.

These cover the derived fields — the ones the MLB feed does not hand you and
that a wrong implementation would silently poison the training data with.
"""

from __future__ import annotations

from datetime import date

import pytest

from warehouse.mlb import (
    ab_result_category, flatten_play_by_play, men_on_base, result_category,
)


# ── base state ──────────────────────────────────────────────────────────────

def test_men_on_base_categories():
    assert men_on_base(None, None, None) == "Empty"
    assert men_on_base(1, None, None) == "Men_On"
    assert men_on_base(None, 2, None) == "RISP"
    assert men_on_base(None, None, 3) == "RISP"
    assert men_on_base(1, 2, None) == "RISP"
    assert men_on_base(1, None, 3) == "RISP"
    assert men_on_base(1, 2, 3) == "Loaded"


def test_men_on_base_treats_first_only_as_not_in_scoring_position():
    # The distinction that makes the RISP split meaningful.
    assert men_on_base(101, None, None) == "Men_On"
    assert men_on_base(101, 102, None) == "RISP"


# ── vocabulary parity with vocab.ts ─────────────────────────────────────────

def test_result_category_matches_the_edge_function_vocabulary():
    assert result_category("called_strike") == "strike_foul"
    assert result_category("swinging_strike") == "strike_foul"
    assert result_category("foul") == "strike_foul"
    assert result_category("ball") == "ball"
    assert result_category("hit_by_pitch") == "ball"
    assert result_category("in_play") == "in_play"
    assert result_category(None) is None


def test_ab_result_category_matches_the_edge_function_vocabulary():
    assert ab_result_category("strikeout") == "strikeout"
    assert ab_result_category("strikeout_double_play") == "strikeout"
    assert ab_result_category("walk") == "walk"
    assert ab_result_category("intent_walk") == "walk"
    assert ab_result_category("hit_by_pitch") == "walk"
    assert ab_result_category("home_run") == "hit"
    assert ab_result_category("field_out") == "out"
    assert ab_result_category(None) is None


# ── play-by-play fixture ────────────────────────────────────────────────────

def _pitch_event(n, balls, strikes, code="C", speed=95.0):
    """A pitch event. `balls`/`strikes` are POST-pitch, as the API reports."""
    return {
        "type": "pitch", "pitchNumber": n,
        "startTime": f"2025-08-20T19:0{n}:00Z",
        "count": {"balls": balls, "strikes": strikes},
        "details": {"call": {"code": code}, "isStrike": code == "C",
                    "isBall": code == "B", "isInPlay": code == "X",
                    "type": {"code": "FF"}},
        "pitchData": {"startSpeed": speed, "zone": 5,
                      "typeConfidence": 0.9,
                      "strikeZoneWidth": 1.66, "strikeZoneDepth": 0.83,
                      # `x`/`y` are legacy Gameday pixel coordinates and are
                      # here so the assertions below can prove we ignore them.
                      "coordinates": {"pX": 0.1, "pZ": 2.4,
                                      "x": 110.2, "y": 168.4,
                                      "x0": -1.9, "y0": 50.0, "z0": 5.8,
                                      "vX0": 6.2, "vY0": -138.4, "vZ0": -5.1,
                                      "aX": -10.3, "aY": 29.7, "aZ": -14.2,
                                      "pfxX": -5.6, "pfxZ": 9.1},
                      "breaks": {"spinRate": 2300,
                                 "breakVertical": -22.1, "breakY": 24.0}},
    }


def _play(abi, inning, top, events, event_type, home, away,
          post=(None, None, None), splits_men_on="Loaded"):
    """`splits_men_on` defaults to a deliberately wrong value: the flattener
    must ignore matchup.splits.menOnBase entirely."""
    m = {"pitcher": {"id": 100}, "batter": {"id": 200 + abi},
         "batSide": {"code": "R"}, "pitchHand": {"code": "L"},
         "splits": {"menOnBase": splits_men_on}}
    for key, val in zip(("postOnFirst", "postOnSecond", "postOnThird"), post):
        if val:
            m[key] = {"id": val}
    return {
        "about": {"atBatIndex": abi, "inning": inning, "isTopInning": top,
                  "isScoringPlay": False},
        "count": {"outs": 0},
        "matchup": m,
        "playEvents": events,
        "result": {"eventType": event_type, "event": event_type.title(),
                   "rbi": 0, "homeScore": home, "awayScore": away},
    }


@pytest.fixture
def game():
    """Three at-bats in one half-inning:
      AB0  single, 3 pitches -> runner to 1B, score unchanged
      AB1  double, 2 pitches -> runners 1B+2B, home scores 1
      AB2  strikeout, 3 pitches
    """
    return {"allPlays": [
        _play(0, 1, True,
              [_pitch_event(1, 0, 1), _pitch_event(2, 1, 1, "B"),
               _pitch_event(3, 1, 1, "X")],
              "single", 0, 0, post=(501, None, None)),
        _play(1, 1, True,
              [_pitch_event(1, 0, 1), _pitch_event(2, 0, 1, "X")],
              "double", 1, 0, post=(502, 501, None)),
        _play(2, 1, True,
              [_pitch_event(1, 0, 1), _pitch_event(2, 0, 2),
               _pitch_event(3, 0, 3)],
              "strikeout", 1, 0, post=(502, 501, None)),
    ]}


def test_first_pitch_of_every_at_bat_has_an_empty_count(game):
    pitches, _ = flatten_play_by_play(1, date(2025, 8, 20), game)
    firsts = [p for p in pitches if p["pitch_number"] == 1]
    assert len(firsts) == 3
    for p in firsts:
        assert (p["balls"], p["strikes"]) == (0, 0)


def test_counts_are_lagged_to_be_pre_pitch(game):
    pitches, _ = flatten_play_by_play(1, date(2025, 8, 20), game)
    ab0 = [p for p in pitches if p["at_bat_index"] == 0]
    # Events report post-pitch 0-1, 1-1, 1-1 -> pre-pitch 0-0, 0-1, 1-1.
    assert [(p["balls"], p["strikes"]) for p in ab0] == [(0, 0), (0, 1), (1, 1)]


def test_base_state_is_pre_play_and_ignores_the_leaky_splits_field(game):
    """The regression this guards: matchup.splits.menOnBase is the state AFTER
    the play. The fixture sets it to 'Loaded' on every play; if the flattener
    read it, every row would say Loaded and the model would see the at-bat's
    own outcome as an input."""
    pitches, _ = flatten_play_by_play(1, date(2025, 8, 20), game)
    by_ab = {}
    for p in pitches:
        by_ab.setdefault(p["at_bat_index"], p)
    # AB0 opens the inning: nobody on.
    assert by_ab[0]["men_on_base"] == "Empty"
    assert by_ab[0]["on_first"] is None
    # AB1 follows a single: runner on first only.
    assert by_ab[1]["men_on_base"] == "Men_On"
    assert by_ab[1]["on_first"] == 501
    # AB2 follows a double: runners on first and second.
    assert by_ab[2]["men_on_base"] == "RISP"
    assert by_ab[2]["on_second"] == 501
    assert "Loaded" not in {p["men_on_base"] for p in pitches}


def test_score_is_pre_plate_appearance(game):
    pitches, _ = flatten_play_by_play(1, date(2025, 8, 20), game)
    by_ab = {}
    for p in pitches:
        by_ab.setdefault(p["at_bat_index"], p)
    # The double in AB1 scores a run; AB1's own rows must still show 0-0.
    assert (by_ab[1]["home_score"], by_ab[1]["away_score"]) == (0, 0)
    # AB2 sees the run.
    assert (by_ab[2]["home_score"], by_ab[2]["away_score"]) == (1, 0)


def test_bases_clear_at_a_half_inning_change():
    plays = [
        _play(0, 1, True, [_pitch_event(1, 0, 1, "X")], "single", 0, 0,
              post=(501, None, None)),
        # New half inning: the previous inning's runner must not carry over.
        _play(1, 1, False, [_pitch_event(1, 0, 1)], "strikeout", 0, 0),
    ]
    pitches, _ = flatten_play_by_play(1, date(2025, 8, 20), {"allPlays": plays})
    second = [p for p in pitches if p["at_bat_index"] == 1][0]
    assert second["men_on_base"] == "Empty"
    assert second["on_first"] is None


def test_pitch_of_game_accumulates_per_pitcher(game):
    pitches, _ = flatten_play_by_play(1, date(2025, 8, 20), game)
    # One pitcher throws all 8 pitches.
    assert [p["pitch_of_game"] for p in pitches] == [1, 2, 3, 4, 5, 6, 7, 8]


def test_times_through_order_counts_pitcher_batter_meetings():
    plays = [
        _play(0, 1, True, [_pitch_event(1, 0, 1)], "strikeout", 0, 0),
        _play(1, 3, True, [_pitch_event(1, 0, 1)], "strikeout", 0, 0),
    ]
    # Same pitcher, different batters -> both are first meetings.
    pitches, _ = flatten_play_by_play(1, date(2025, 8, 20), {"allPlays": plays})
    assert {p["times_through_order"] for p in pitches} == {1}

    # Same pitcher AND same batter twice -> second meeting is TTO 2.
    repeat = [
        _play(0, 1, True, [_pitch_event(1, 0, 1)], "strikeout", 0, 0),
        _play(0, 4, True, [_pitch_event(1, 0, 1)], "strikeout", 0, 0),
    ]
    pitches, _ = flatten_play_by_play(1, date(2025, 8, 20), {"allPlays": repeat})
    assert [p["times_through_order"] for p in pitches] == [1, 2]


def test_at_bat_rows_carry_pre_play_context(game):
    _, at_bats = flatten_play_by_play(1, date(2025, 8, 20), game)
    assert len(at_bats) == 3
    assert [a["result"] for a in at_bats] == ["hit", "hit", "strikeout"]
    assert [a["pitch_count"] for a in at_bats] == [3, 2, 3]
    assert at_bats[2]["men_on_base"] == "RISP"
    assert (at_bats[1]["home_score"], at_bats[1]["away_score"]) == (0, 0)


def test_physics_fields_are_carried_through(game):
    pitches, _ = flatten_play_by_play(1, date(2025, 8, 20), game)
    p = pitches[0]
    assert p["start_speed"] == 95.0
    assert p["zone"] == 5
    assert p["plate_x"] == 0.1
    assert p["plate_z"] == 2.4
    assert p["spin_rate"] == 2300


def test_release_and_movement_fields_are_carried_through(game):
    """pitchData.coordinates beyond pX/pZ.

    These rode along in the payload from the start and were dropped on the
    floor until 2026-09. Capturing them costs no extra API call, which is why
    the omission was worth correcting rather than scheduling.
    """
    pitches, _ = flatten_play_by_play(1, date(2025, 8, 20), game)
    p = pitches[0]
    assert (p["release_pos_x"], p["release_pos_y"], p["release_pos_z"]) == (
        -1.9, 50.0, 5.8)
    assert (p["release_vel_x"], p["release_vel_y"], p["release_vel_z"]) == (
        6.2, -138.4, -5.1)
    assert (p["accel_x"], p["accel_y"], p["accel_z"]) == (-10.3, 29.7, -14.2)
    assert (p["pfx_x"], p["pfx_z"]) == (-5.6, 9.1)
    assert p["break_vertical"] == -22.1
    assert p["type_confidence"] == 0.9


def test_constant_and_display_fields_are_not_captured(game):
    """Fields present in the payload that carry no per-pitch information.

    `coordinates.x`/`.y` are Gameday display pixels. `breaks.breakY` (24.0),
    `strikeZoneWidth` (17.0) and `strikeZoneDepth` are plate geometry, measured
    constant across live games -- 7.9M copies of a constant buy nothing.
    The fixture supplies all of them precisely so a future widening of the
    flattener cannot pull them in unnoticed under a plausible-looking name.
    """
    pitches, _ = flatten_play_by_play(1, date(2025, 8, 20), game)
    values = set(pitches[0].values())
    for unwanted in (110.2, 168.4, 24.0, 1.66, 0.83):
        assert unwanted not in values, f"{unwanted} leaked into the pitch row"


def test_flattener_emits_a_key_for_every_schema_column(game):
    """Every PITCH_SCHEMA column must be produced by the flattener.

    `ingest.to_parquet` shapes rows with `r.get(f.name)`, so a schema column
    the flattener never sets does not raise -- it becomes an all-NULL column
    that looks like missing data forever. The declared-schema invariant stops
    DuckDB choking on it, but nothing else would report it.
    """
    from warehouse.config import PITCH_SCHEMA

    pitches, _ = flatten_play_by_play(1, date(2025, 8, 20), game)
    declared = {f.name for f in PITCH_SCHEMA}
    emitted = set(pitches[0])
    assert declared - emitted == set(), (
        f"PITCH_SCHEMA columns with no flattener key: "
        f"{sorted(declared - emitted)}")
    assert emitted - declared == set(), (
        f"flattener emits keys absent from PITCH_SCHEMA (they would be "
        f"silently dropped at write time): {sorted(emitted - declared)}")
