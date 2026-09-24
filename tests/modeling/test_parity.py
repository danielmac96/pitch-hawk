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


def _case_indices() -> range:
    """Every case in the file, not a fixed count.

    This was `range(36)` while the emitter wrote 54, so the last 18 cases were
    never compared -- which is how the batter-market features came to be
    covered by the Deno golden test and by nothing on the Python side. A
    hardcoded count silently stops testing whatever is added after it.
    """
    if not GOLDEN.exists():
        return range(0)
    return range(len(json.loads(GOLDEN.read_text())["cases"]))


def test_fixtures_exist_and_are_populated():
    assert len(_cases()) >= 36


def test_every_case_is_compared():
    """Guards the guard: the parametrisation must cover the whole file."""
    assert len(_case_indices()) == len(_cases())


@pytest.mark.parametrize("i", _case_indices())
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


def _ts_league() -> dict:
    """The LEAGUE object from model.ts, as a dict.

    Parsed rather than duplicated: the point is to read what production
    actually uses. Comments are stripped and the keys quoted so the object
    literal becomes JSON.
    """
    import json
    import re

    ts = pathlib.Path("supabase/functions/_shared/model.ts").read_text(
        encoding="utf-8")
    body = ts.split("export const LEAGUE = ", 1)[1].split("\n};", 1)[0] + "\n}"
    body = re.sub(r"//[^\n]*", "", body)          # line comments
    body = re.sub(r",(\s*})", r"\1", body)        # trailing commas
    body = re.sub(r"(\w+):", r'"\1":', body)      # bare keys
    return json.loads(body)


def test_league_constants_match_model_ts():
    """`LEAGUE` exists in two languages and nothing was checking they agree.

    Every `*_delta` feature is centred on one of these. Training and serving
    have to subtract the SAME number or the shipped coefficients meet a
    differently-scaled input in production -- the model would still score,
    still look sane, and be quietly wrong by the size of the gap.

    This gap was live: `hr_rate` was added to both files by hand for the
    batter markets, with nothing asserting the two copies matched.
    """
    from modeling.score import LEAGUE as PY

    ts = _ts_league()
    assert set(ts) == set(PY), (
        f"LEAGUE keys differ.\n  only in model.ts: {sorted(set(ts) - set(PY))}"
        f"\n  only in score.py: {sorted(set(PY) - set(ts))}")
    for key, want in ts.items():
        assert PY[key] == want, (
            f"LEAGUE[{key!r}] is {want} in model.ts and {PY[key]} in "
            f"modeling/score.py")


def test_inline_baselines_match_model_ts():
    """featureValue() subtracts four constants inline rather than from LEAGUE.

    Same failure mode as above, one layer down: score.py mirrors them as
    module constants, and a change to either side alone is invisible.
    """
    import re

    from modeling import score

    ts = pathlib.Path("supabase/functions/_shared/model.ts").read_text(
        encoding="utf-8")
    body = ts.split("function featureValue(")[1].split("\nfunction ")[0]

    for case, const in (("pitcher_zone_delta", score.ZONE_BASELINE),
                        ("pitcher_whiff_delta", score.WHIFF_BASELINE),
                        ("batter_chase_delta", score.CHASE_BASELINE),
                        ("batter_contact_delta", score.CONTACT_BASELINE)):
        line = next(ln for ln in body.splitlines() if f'case "{case}"' in ln)
        found = re.search(r"-\s*(0?\.\d+)\s*:", line)
        assert found, f"could not read the baseline out of: {line.strip()}"
        assert float(found.group(1)) == const, (
            f"{case} subtracts {found.group(1)} in model.ts and {const} in "
            f"modeling/score.py")


def test_scorable_features_matches_model_ts():
    """`spec.SCORABLE_FEATURES` is the gate on what a market may name.

    A spec naming something outside model.ts::featureValue() trains a
    coefficient production never applies, because that switch ends in
    `default: return 0`. The gate is only worth having if it tracks the real
    switch, so it is read from the source here rather than trusted.

    Drift in either direction is a bug:
      * a name in model.ts but not in the set -- a real feature no spec can
        use, and the error message would claim production cannot score it
      * a name in the set but not in model.ts -- the gate waves through a
        feature that silently scores 0.0 live, which is what it exists to stop
    """
    import re

    from modeling.spec import SCORABLE_FEATURES

    ts = pathlib.Path("supabase/functions/_shared/model.ts").read_text(
        encoding="utf-8")
    body = ts.split("function featureValue(")[1].split("\nfunction ")[0]
    names = set(re.findall(r'case "([a-z0-9_]+)":', body))
    assert names, "could not parse featureValue() -- did model.ts move?"

    assert names == set(SCORABLE_FEATURES), (
        f"SCORABLE_FEATURES has drifted from model.ts::featureValue().\n"
        f"  only in model.ts: {sorted(names - set(SCORABLE_FEATURES))}\n"
        f"  only in the set : {sorted(set(SCORABLE_FEATURES) - names)}")


def test_every_spec_feature_is_scored_in_production():
    """End to end: what the registry actually ships, against the real switch.

    test_scorable_features_matches_model_ts pins the gate; this pins the
    markets. A spec could otherwise pass construction and still name something
    production ignores, if the gate were ever widened by mistake.
    """
    import re

    from modeling.spec import all_markets, get_spec

    ts = pathlib.Path("supabase/functions/_shared/model.ts").read_text(
        encoding="utf-8")
    body = ts.split("function featureValue(")[1].split("\nfunction ")[0]
    names = set(re.findall(r'case "([a-z0-9_]+)":', body))

    for market in all_markets():
        spec = get_spec(market)
        unknown = sorted(set(spec.feature_names) - names)
        assert not unknown, (
            f"{market} names {unknown}, which model.ts scores as 0.0")


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
