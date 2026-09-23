"""The MarketSpec contract.

These tests exist because a spec with a typo'd family or a feature name that
model.ts does not know about fails *silently in production* -- model.ts has no
default branch on params.type, and featureValue() returns 0 for unknown names.
Catching it here is the whole point.
"""

import pytest

from modeling.spec import (
    FAMILIES, STATIC_FEATURES, FormFeature, MarketSpec, all_markets, get_spec,
)


def _spec(**over) -> MarketSpec:
    base = dict(
        market="test_market",
        family="multinomial_logistic",
        cell_sql="select 1",
        feature_names=("balls", "strikes"),
        classes=("a", "b"),
        primary_metric="logloss",
        metric_direction="lower",
        form_windows=("career",),
        to_params=lambda fit, window: {},
    )
    base.update(over)
    return MarketSpec(**base)


def test_spec_is_frozen():
    spec = _spec()
    with pytest.raises(Exception):
        spec.market = "changed"


def test_unknown_family_rejected():
    with pytest.raises(ValueError, match="unknown family"):
        _spec(family="random_forest")


def test_known_families_accepted():
    for family in FAMILIES:
        assert _spec(family=family).family == family


def test_classes_required_for_multinomial():
    with pytest.raises(ValueError, match="classes"):
        _spec(family="multinomial_logistic", classes=None)


def test_metric_direction_validated():
    with pytest.raises(ValueError, match="metric_direction"):
        _spec(metric_direction="sideways")


def test_get_spec_unknown_market_lists_valid_ones():
    with pytest.raises(ValueError, match="unknown market"):
        get_spec("not_a_market")


#: The five pitcher-facing markets, written before FormFeature existed. They
#: derive their single form column from the legacy bucket_col triple.
LEGACY_MARKETS = {
    "pitch_result", "ab_result", "pitch_speed_ou",
    "ab_pitches_ou", "game_moneyline",
}


def test_every_market_is_registered():
    assert set(all_markets()) == LEGACY_MARKETS | {"batter_hit", "batter_hr"}


# ── form features and the intercept ─────────────────────────────────────────

def test_legacy_specs_derive_one_form_feature():
    """The five markets predate FormFeature and declare none.

    Their single bucket column is recovered from bucket_col/step/baseline, so
    their design matrices are unchanged. Losing this would silently zero the
    one feature each of them actually varies.
    """
    for market in LEGACY_MARKETS:
        spec = get_spec(market)
        legacy = [f for f in spec.feature_names
                  if f in {"pitcher_zone_delta", "pitcher_k_delta",
                           "pitcher_velo"}]
        assert [f.feature for f in spec.form_features] == legacy, market
        for f in spec.form_features:
            assert f.bucket_col == spec.bucket_col
            assert f.step == spec.bucket_step
            assert f.baseline == spec.bucket_baseline


def test_the_batter_markets_carry_two_form_dimensions():
    """What step 7 unlocked, as shipped rather than as a synthetic fixture.

    Each names a batter form column AND a pitcher form column with their own
    bucket widths. Under the old engine both would have read one shared array,
    so the batter side could not have existed.
    """
    for market in ("batter_hit", "batter_hr"):
        spec = get_spec(market)
        subjects = {f.feature.split("_")[0] for f in spec.form_features}
        assert subjects == {"batter", "pitcher"}, market
        cols = {f.bucket_col for f in spec.form_features}
        assert len(cols) == 2, f"{market} aliases one bucket column"
        assert spec.cell_features == ("platoon_same",), market
        assert spec.intercept_folded == (), (
            f"{market} folds a feature to zero -- a new market should carry "
            f"what it names")


def test_a_market_may_declare_several_form_dimensions():
    """The capability step 7 exists for.

    Before this, every pitcher-form name read one shared array and every
    batter-form name was hardcoded to zeros, so pitcher form and batter form
    could not both vary in one market. A hit or home-run model needs exactly
    that.
    """
    spec = _spec(
        feature_names=("balls", "pitcher_k_delta", "batter_k_delta"),
        form_features=(
            FormFeature("pitcher_k_delta", "p_k_bucket", 0.035),
            FormFeature("batter_k_delta", "b_k_bucket", 0.04),
        ),
    )
    assert len(spec.form_features) == 2
    assert {f.bucket_col for f in spec.form_features} == {"p_k_bucket",
                                                          "b_k_bucket"}


def test_a_feature_with_no_column_must_be_declared_folded():
    """The defect this makes visible.

    `pitcher_bb_delta` trained as a constant 0.0 for a year while model.ts
    computed it for real, because the engine silently defaulted it. Now a
    market that names it has to say so.
    """
    with pytest.raises(ValueError, match="intercept_folded"):
        _spec(feature_names=("balls", "batter_chase_delta"))

    ok = _spec(feature_names=("balls", "batter_chase_delta"),
               intercept_folded=("batter_chase_delta",))
    assert ok.intercept_folded == ("batter_chase_delta",)


def test_a_name_model_ts_cannot_score_is_rejected():
    """featureValue() ends in `default: return 0`, so an unknown name trains a
    coefficient production never applies."""
    with pytest.raises(ValueError, match="not scored by"):
        _spec(feature_names=("balls", "batter_sprint_speed"))


def test_a_form_feature_must_be_named_in_feature_names():
    with pytest.raises(ValueError, match="not in feature_names"):
        _spec(feature_names=("balls",),
              form_features=(FormFeature("pitcher_k_delta", "k", 0.03),))


def test_a_feature_cannot_be_both_form_and_folded():
    with pytest.raises(ValueError, match="pick one"):
        _spec(feature_names=("balls", "pitcher_k_delta"),
              form_features=(FormFeature("pitcher_k_delta", "k", 0.03),),
              intercept_folded=("pitcher_k_delta",))


def test_one_feature_cannot_have_two_form_columns():
    with pytest.raises(ValueError, match="more than one"):
        _spec(feature_names=("balls", "pitcher_k_delta"),
              form_features=(FormFeature("pitcher_k_delta", "a", 0.03),
                             FormFeature("pitcher_k_delta", "b", 0.03)))


def test_static_features_need_no_declaration():
    spec = _spec(feature_names=tuple(sorted(STATIC_FEATURES)))
    assert spec.form_features == ()
    assert spec.intercept_folded == ()
