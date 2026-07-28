"""Unit tests for the freq_v2 rule-based predictor.

This is the part of the codebase the README earmarks for replacement by a
real ML model — these tests pin down its current behavior so a future model
swap has a documented baseline to diff against, and so `_blend`/`_confidence`
regressions get caught immediately rather than silently shifting predictions.

get_cache() is monkeypatched to a stub so these tests never touch Supabase.
"""

from __future__ import annotations

import math

import pytest

from backend.models import predictor as predictor_mod
from backend.models.predictor import PitchPredictor, _blend_weight, _confidence


class _StubCache:
    """Returns None for everything by default — exercises the league-average
    fallback path. Override attributes per-test for the pitcher/batter-data
    paths."""

    def get_pitch_stats(self, _pitcher_id):
        return None

    def get_ab_stats(self, _pitcher_id):
        return None

    def get_pitcher_rolling(self, _pitcher_id):
        return None

    def get_batter_rolling(self, _batter_id):
        return None

    def get_matchup_history(self, _pitcher_id, _batter_id):
        return None

    def get_player_info(self, _player_id):
        return None


@pytest.fixture(autouse=True)
def stub_cache(monkeypatch):
    cache = _StubCache()
    monkeypatch.setattr(predictor_mod, "get_cache", lambda: cache)
    return cache


@pytest.fixture
def predictor():
    return PitchPredictor()


# --- pure helper functions --------------------------------------------------

def test_blend_weight_zero_samples_is_zero():
    assert _blend_weight(0) == 0.0


def test_blend_weight_approaches_085_with_large_n():
    assert _blend_weight(100_000) == pytest.approx(0.85, abs=1e-6)


def test_blend_weight_monotonically_increases():
    weights = [_blend_weight(n) for n in (0, 10, 100, 1000, 10000)]
    assert weights == sorted(weights)


def test_confidence_floor_is_050_at_zero_samples():
    assert _confidence(0, k=300.0) == pytest.approx(0.50)


def test_confidence_asymptotes_to_082():
    assert _confidence(1_000_000, k=300.0) == pytest.approx(0.82, abs=1e-6)


# --- predict_pitch_speed -----------------------------------------------------

def test_predict_pitch_speed_league_avg_fallback(predictor):
    out = predictor.predict_pitch_speed({"pitcher_id": 1, "balls": 0, "strikes": 0})
    assert out["market"] == "pitch_speed_ou"
    assert out["predicted_mph"] == pytest.approx(92.5, abs=0.01)
    assert out["sample_size"] == 0
    assert out["features_used"] == ["league_avg"]
    assert out["model_version"] == "freq_v2"


def test_predict_pitch_speed_full_count_delta_applied(predictor):
    base = predictor.predict_pitch_speed({"pitcher_id": 1, "balls": 0, "strikes": 0})
    full_count = predictor.predict_pitch_speed({"pitcher_id": 1, "balls": 3, "strikes": 0})
    assert full_count["predicted_mph"] == pytest.approx(base["predicted_mph"] + 0.3, abs=0.01)


# --- predict_pitch_result ----------------------------------------------------

def test_predict_pitch_result_league_avg_probs_sum_to_one(predictor):
    out = predictor.predict_pitch_result({"pitcher_id": 1, "balls": 0, "strikes": 0})
    assert out["market"] == "pitch_result"
    assert sum(out["probs"].values()) == pytest.approx(1.0, abs=1e-3)
    assert out["features_used"] == ["league_avg"]


def test_predict_pitch_result_0_2_count_favors_strike_foul(predictor):
    neutral = predictor.predict_pitch_result({"pitcher_id": 1, "balls": 0, "strikes": 0})
    two_strikes = predictor.predict_pitch_result({"pitcher_id": 1, "balls": 0, "strikes": 2})
    assert two_strikes["probs"]["strike_foul"] > neutral["probs"]["strike_foul"]


# --- predict_at_bat_result ----------------------------------------------------

def test_predict_at_bat_result_probs_sum_to_one(predictor):
    out = predictor.predict_at_bat_result({"pitcher_id": 1, "batter_id": 2})
    assert out["market"] == "ab_result"
    assert sum(out["probs"].values()) == pytest.approx(1.0, abs=1e-3)


def test_predict_at_bat_result_3_0_count_favors_walk(predictor):
    neutral = predictor.predict_at_bat_result({"pitcher_id": 1, "batter_id": 2, "balls": 0, "strikes": 0})
    three_oh = predictor.predict_at_bat_result({"pitcher_id": 1, "batter_id": 2, "balls": 3, "strikes": 0})
    assert three_oh["probs"]["walk"] > neutral["probs"]["walk"]


# --- predict_at_bat_pitches ---------------------------------------------------

def test_predict_at_bat_pitches_league_avg_baseline(predictor):
    out = predictor.predict_at_bat_pitches({"pitcher_id": 1, "batter_id": 2, "pitch_count_pa": 0})
    assert out["market"] == "ab_pitches_ou"
    assert out["predicted_count"] == pytest.approx(3.82, abs=0.01)


def test_predict_at_bat_pitches_extends_past_current_count_when_pa_already_long(predictor):
    out = predictor.predict_at_bat_pitches(
        {"pitcher_id": 1, "batter_id": 2, "pitch_count_pa": 6, "balls": 1, "strikes": 1}
    )
    assert out["predicted_count"] > out["current_pitch_count"]


# --- graceful degradation: a broken optional data source must not crash ------

def test_pitcher_rolling_exception_degrades_gracefully(predictor, stub_cache, monkeypatch):
    def boom(_pitcher_id):
        raise RuntimeError("supabase is down")

    monkeypatch.setattr(stub_cache, "get_pitcher_rolling", boom)
    out = predictor.predict_pitch_speed({"pitcher_id": 1})
    assert out["features_used"] == ["league_avg"]
    assert math.isfinite(out["predicted_mph"])
