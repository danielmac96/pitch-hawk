"""Cell tables: the weighted-aggregate contract the fitter depends on."""

from __future__ import annotations

from modeling.spec import get_spec


def test_pitch_result_spec_registered():
    spec = get_spec("pitch_result")
    assert spec.family == "multinomial_logistic"
    assert spec.classes == ("strike_foul", "ball", "in_play")
    assert set(spec.form_windows) == {"career", "d30", "d90"}


def test_pitch_result_features_match_model_ts():
    """Every feature name must exist in featureValue() in model.ts.

    A name model.ts does not know is scored as 0.0 -- silently. This test reads
    the actual TypeScript so the two cannot drift.
    """
    spec = get_spec("pitch_result")
    ts = open("supabase/functions/_shared/model.ts", encoding="utf-8").read()
    for name in spec.feature_names:
        assert f'"{name}"' in ts or f"'{name}'" in ts, \
            f"feature {name!r} is not handled by featureValue() in model.ts"


def test_cell_sql_emits_all_three_form_windows():
    """The sweep must be a column selection, not a rebuild.

    If cell_sql emitted only one window, changing form_window would cost a
    fresh ~50k-op R2 scan per sweep step.
    """
    spec = get_spec("pitch_result")
    for window in ("career", "d30", "d90"):
        assert f"{window}_zone_bucket" in spec.cell_sql, \
            f"cell_sql must emit {window}_zone_bucket in the single build pass"


def test_zone_baseline_matches_model_ts():
    """The delta baseline must be the one production actually subtracts.

    featureValue() hardcodes `p.zone_rate - 0.48`. If the cell build centred
    the feature anywhere else, the shipped coefficients would be applied to a
    differently-scaled input in production -- and no scorer parity test could
    see it, because the scorer is handed the delta already computed.
    """
    from modeling.specs.pitch_result import ZONE_BASELINE

    ts = open("supabase/functions/_shared/model.ts", encoding="utf-8").read()
    line = next(ln for ln in ts.splitlines() if "pitcher_zone_delta" in ln
                and "case" in ln)
    assert str(ZONE_BASELINE) in line, (
        f"ZONE_BASELINE={ZONE_BASELINE} is not the constant model.ts "
        f"subtracts: {line.strip()}")


def test_cell_sql_groups_and_counts():
    spec = get_spec("pitch_result")
    sql = spec.cell_sql.lower()
    assert "count(*)" in sql and " as n" in sql, \
        "cells must carry count(*) as n -- it becomes sklearn's sample_weight"
    assert "group by" in sql
    assert "season" in sql, "cells must carry season for fold splitting"
