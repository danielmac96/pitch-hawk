"""Python scorer == model.ts scorer.

Without this, "validated offline" and "computed in production" are two
unverified claims. If this fails, THE PYTHON IS WRONG -- model.ts is what
actually serves users.

Regenerate fixtures after any model.ts scoring change:
    deno test --allow-write --allow-read supabase/functions/tests/scorer_golden_test.ts
"""

from __future__ import annotations

import json
import pathlib

import pytest

from modeling.score import feature_value, score, speed_over_prob

GOLDEN = pathlib.Path("tests/fixtures/scorer_golden.json")


def _cases():
    if not GOLDEN.exists():
        pytest.skip(f"{GOLDEN} missing -- run the Deno emitter (Task 4.1)")
    return json.loads(GOLDEN.read_text())["cases"]


def test_fixtures_exist_and_are_populated():
    assert len(_cases()) >= 36


@pytest.mark.parametrize("i", range(36))
def test_python_matches_typescript(i):
    case = _cases()[i]
    got = score(case["params"], case["context"])
    for key, expected in case["expected"].items():
        assert got[key] == pytest.approx(expected, abs=1e-9), (
            f"case {i} key {key}: python={got[key]} typescript={expected}. "
            f"model.ts is correct -- fix modeling/score.py.")


def test_probabilities_sum_to_one():
    for case in _cases():
        got = score(case["params"], case["context"])
        assert sum(got.values()) == pytest.approx(1.0, abs=1e-9)


def test_every_featurevalue_case_is_mirrored():
    """The Python must know every name model.ts branches on.

    A name handled in the TypeScript but missing here would silently score as
    0.0 in Python only -- offline metrics would then describe a model
    production does not run. This reads the real switch statement so the two
    cannot drift.
    """
    import re

    ts = pathlib.Path("supabase/functions/_shared/model.ts").read_text(
        encoding="utf-8")
    body = ts.split("function featureValue(")[1].split("\nfunction ")[0]
    names = set(re.findall(r'case "([a-z0-9_]+)":', body))
    assert names, "could not parse featureValue() -- did model.ts move?"

    ctx = {"balls": 0, "strikes": 0, "pitch_count_pa": 0,
           "pitcher": {}, "batter": {}}
    sentinel = object()
    for name in sorted(names):
        assert feature_value(name, ctx, _missing=sentinel) is not sentinel, (
            f"featureValue() in model.ts handles {name!r} but "
            f"modeling/score.py does not")


def _speed_cases():
    data = json.loads(GOLDEN.read_text())
    cases = data.get("speed_cases")
    if not cases:
        pytest.skip(
            "speed_cases missing from the golden fixtures -- regenerate with "
            "UPDATE_GOLDEN=1 deno test --allow-write --allow-read --allow-env "
            "supabase/functions/tests/scorer_golden_test.ts")
    return cases


def test_speed_cases_exist_and_are_populated():
    assert len(_speed_cases()) >= 18


@pytest.mark.parametrize("i", range(18))
def test_speed_over_prob_matches_typescript(i):
    """The mean -> P(over) step for the `linear` markets.

    scoreLinear() returns only a mean, so the 36 multinomial cases never
    reached normCdf -- this half of the scorer was unpinned, which is exactly
    why modeling.score.speed_over_prob looked like dead code.
    """
    case = _speed_cases()[i]
    got = speed_over_prob(case["mu"], case["sigma"], case["line"])
    assert got == pytest.approx(case["expected"], abs=1e-9), (
        f"speed case {i} (mu={case['mu']}, sigma={case['sigma']}, "
        f"line={case['line']}): python={got} typescript={case['expected']}. "
        f"model.ts is correct -- fix modeling/score.py.")
