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


# ── the calibration veto ────────────────────────────────────────────────────

def test_overconfident_model_is_held_despite_better_logloss():
    """The failure this veto exists for.

    `ab_result` shipped predicting ~1.4x the realised rate and was patched at
    serve time with CALIB_SHRINK = 0.7 -- a constant applied after the fact,
    to output nobody had gated. Log loss barely moves for a rare class when a
    model is systematically over-confident, so the primary metric alone would
    wave this through.
    """
    spec = get_spec("batter_hr")
    ok, reason = gate(spec,
                      {"logloss": 0.10, "calibration_ratio": 1.40},
                      {"logloss": 0.20, "calibration_ratio": 1.00})
    assert not ok
    assert "calibration_ratio" in reason and "over-confident" in reason


def test_underconfident_model_is_also_held():
    """Both directions. A model that under-predicts home runs is as wrong as
    one that over-predicts them; it just fails quietly instead of loudly."""
    spec = get_spec("batter_hr")
    ok, reason = gate(spec, {"logloss": 0.10, "calibration_ratio": 0.60}, None)
    assert not ok and "under-confident" in reason


def test_calibrated_model_promotes():
    spec = get_spec("batter_hr")
    ok, _ = gate(spec, {"logloss": 0.18, "calibration_ratio": 1.02}, None)
    assert ok


def test_a_missing_calibration_ratio_is_held_not_ignored():
    """A market that declares a band and produces no number has not passed the
    check -- it skipped it. Defaulting to promote would make the veto
    disappear the moment the metric did."""
    spec = get_spec("batter_hr")
    ok, reason = gate(spec, {"logloss": 0.18}, None)
    assert not ok and "calibration_ratio" in reason


def test_markets_without_a_band_are_unaffected():
    """The five pitcher markets declare no band and must gate exactly as
    before -- this veto is additive, not a change to their rules."""
    spec = get_spec("pitch_result")
    assert spec.calibration_band is None
    ok, _ = gate(spec, {"logloss": 0.90}, {"logloss": 1.00})
    assert ok


def test_the_home_run_band_is_wider_than_the_hit_band():
    """Wider for the RARER class, which is the opposite of the instinct.

    A calibration ratio is a ratio of rates. Home runs are ~3.2% of plate
    appearances against ~23% for a hit, so the numerator rests on roughly a
    seventh of the positive events and carries several times the sampling
    noise. Matching the hit market's band would hold good models on variance
    rather than on bias.
    """
    hr = get_spec("batter_hr").calibration_band
    hit = get_spec("batter_hit").calibration_band
    assert (hr[1] - hr[0]) > (hit[1] - hit[0]), (
        f"the rarer class needs the wider band: hr={hr} hit={hit}")
    # Both still centred on 1.0 -- a band that does not contain "correct"
    # would reject every calibrated model.
    assert hr[0] < 1.0 < hr[1] and hit[0] < 1.0 < hit[1]


def test_version_format():
    v = make_version()
    assert v.startswith("v2_") and len(v) == len("v2_20260808")
