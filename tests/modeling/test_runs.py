"""Run records. build_run is pure -- record() is the only DB call."""

from __future__ import annotations

from modeling.runs import build_run, new_run_id, spec_hash
from modeling.spec import get_spec
from modeling.validate import FoldResult, SweepResult


def test_run_ids_are_unique():
    assert len({new_run_id() for _ in range(100)}) == 100


def test_spec_hash_is_stable():
    spec = get_spec("pitch_result")
    assert spec_hash(spec) == spec_hash(spec)


def test_spec_hash_changes_with_sql():
    """Silent spec drift must be detectable across runs."""
    import dataclasses
    spec = get_spec("pitch_result")
    other = dataclasses.replace(spec, cell_sql=spec.cell_sql + " -- edited")
    assert spec_hash(spec) != spec_hash(other)


def _sweep() -> SweepResult:
    folds = [FoldResult(2024, 100.0, 10.0, {"logloss": 0.9, "n": 10.0})]
    return SweepResult("d30", 2.0, folds, {"logloss": 0.9, "folds_used": 1})


def test_build_run_captures_the_sweep_config():
    spec = get_spec("pitch_result")
    run = build_run(spec, _sweep(), holdout={"logloss": 0.95},
                    calibration=[], params={"type": "multinomial_logistic"},
                    status="completed", notes="unit test")
    assert run["market"] == "pitch_result"
    assert run["config"]["form_window"] == "d30"
    assert run["config"]["half_life"] == 2.0
    assert run["oos_metrics"]["logloss"] == 0.9
    assert run["holdout_metrics"]["logloss"] == 0.95
    assert run["status"] == "completed"
    assert len(run["folds"]) == 1


def test_build_run_records_failures_too():
    spec = get_spec("pitch_result")
    run = build_run(spec, _sweep(), holdout=None, calibration=None,
                    params=None, status="failed", notes="held by gate")
    assert run["status"] == "failed"
    assert run["notes"] == "held by gate"
