"""The MarketSpec contract.

These tests exist because a spec with a typo'd family or a feature name that
model.ts does not know about fails *silently in production* -- model.ts has no
default branch on params.type, and featureValue() returns 0 for unknown names.
Catching it here is the whole point.
"""

import pytest

from modeling.spec import FAMILIES, MarketSpec, all_markets, get_spec


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


def test_all_five_markets_registered():
    assert set(all_markets()) == {
        "pitch_result", "ab_result", "pitch_speed_ou",
        "ab_pitches_ou", "game_moneyline",
    }
