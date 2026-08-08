"""The promotion gate. Pure logic -- no database in these tests."""

from __future__ import annotations

import dataclasses

from modeling.registry import GATE_TOLERANCE, SIGMA_BAND, gate, make_version
from modeling.spec import get_spec


def test_gate_tolerance_matches_prior_convention():
    assert GATE_TOLERANCE == 0.02


def test_no_baseline_promotes():
    spec = get_spec("pitch_result")
    ok, reason = gate(spec, {"logloss": 0.9}, None)
    assert ok and "no active baseline" in reason


def test_clear_improvement_promotes():
    spec = get_spec("pitch_result")
    ok, _ = gate(spec, {"logloss": 0.80}, {"logloss": 0.90})
    assert ok


def test_within_tolerance_promotes():
    """1% worse is inside the 2% band."""
    spec = get_spec("pitch_result")
    ok, _ = gate(spec, {"logloss": 0.909}, {"logloss": 0.90})
    assert ok


def test_beyond_tolerance_is_held():
    spec = get_spec("pitch_result")
    ok, reason = gate(spec, {"logloss": 0.95}, {"logloss": 0.90})
    assert not ok and "HELD" in reason


def test_missing_new_metric_is_held():
    """Never promote something you could not measure."""
    spec = get_spec("pitch_result")
    ok, reason = gate(spec, {}, {"logloss": 0.90})
    assert not ok and "HELD" in reason


def test_sigma_veto_blocks_despite_good_rmse():
    """The regression failure mode: good RMSE, mis-scaled sigma."""
    spec = dataclasses.replace(get_spec("pitch_result"),
                               market="pitch_speed_ou", family="linear",
                               classes=None, primary_metric="rmse")
    ok, reason = gate(spec, {"rmse": 4.0, "sigma_coverage": 0.30},
                      {"rmse": 5.0, "sigma_coverage": 0.68})
    assert not ok and "sigma" in reason.lower()


def test_sigma_inside_band_allows_promotion():
    spec = dataclasses.replace(get_spec("pitch_result"),
                               market="pitch_speed_ou", family="linear",
                               classes=None, primary_metric="rmse")
    ok, _ = gate(spec, {"rmse": 4.0, "sigma_coverage": 0.68},
                 {"rmse": 5.0, "sigma_coverage": 0.68})
    assert ok


def test_sigma_band_is_centred_on_normal():
    assert SIGMA_BAND[0] < 0.6827 < SIGMA_BAND[1]


def test_version_format():
    v = make_version()
    assert v.startswith("v2_") and len(v) == len("v2_20260808")
