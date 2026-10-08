"""modeling/serve.py == supabase/functions/_shared/props.ts, to 1e-9.

The fixtures are emitted by the TypeScript (props_golden_test.ts). If this
fails, the PYTHON is wrong: props.ts is what serves users. Regenerate after an
intentional props.ts change:

    UPDATE_GOLDEN=1 deno test --allow-write --allow-read --allow-env \\
        supabase/functions/tests/props_golden_test.ts
"""

from __future__ import annotations

import json
import pathlib

import numpy as np
import pytest

from modeling import serve as S

GOLDEN = pathlib.Path("tests/fixtures/props_golden.json")
TOL = 1e-9


@pytest.fixture(scope="module")
def golden():
    if not GOLDEN.exists():
        pytest.skip("props_golden.json missing -- run the Deno emitter")
    return json.loads(GOLDEN.read_text())


def _cases():
    return range(len(json.loads(GOLDEN.read_text())["cases"])) if GOLDEN.exists() else range(0)


@pytest.mark.parametrize("i", _cases())
def test_case(golden, i):
    b = golden["bundle"]
    c = golden["cases"][i]
    x, out = c["inputs"], c["outputs"]
    L = x["L"]
    w = x["workload"]
    outs, bf = S.workload(b, own_outs=w["own_outs"], pitches=w["pitches"],
                          team_leash=w["team_leash"], rest_days=w["rest_days"],
                          rp=w["rp"], L=L)
    np.testing.assert_allclose(outs, out["outs_pmf"], atol=TOL)
    np.testing.assert_allclose(bf, out["bf_pmf"], atol=TOL)

    lineup = x["lineup"]
    one = S.pa_dist(b["pa_outcome"], lineup[0][0], x["sp_r"], x["pk"], L,
                    same=1.0, left=0.0, home=1.0, reliever=0.0, tto=2.0)
    np.testing.assert_allclose(one, out["pa_dist"], atol=TOL)

    vals, d3, p3 = [], None, None
    for s, (rb, side) in enumerate(lineup, 1):
        d = S.batter_dists(b, rb=rb, bat_side=side, slot=s, is_home=x["is_home"],
                           sp_r=x["sp_r"], sp_hand=x["sp_hand"], pen_r=x["pen_r"],
                           pk=x["pk"], L=L, bf_pmf=bf)
        pmf = S.pa_pmf(b, s, x["is_home"])
        vals.append(S.batter_value(d, pmf))
        if s == 3:
            d3, p3 = d, pmf
    team_value = sum(vals)
    assert team_value == pytest.approx(out["team_value"], abs=TOL)
    bm = S.batter_markets(b, d3, p3, slot=3, team_value=team_value)
    for k, m in (("hit", "batter_hit"), ("hr", "batter_hr"),
                 ("tb15", "batter_tb15"), ("hrr", "batter_hrr")):
        assert bm[m] == pytest.approx(out["batter3"][k], abs=TOL), k

    sm = S.starter_markets(b, sp_r=x["sp_r"], sp_hand=x["sp_hand"],
                           lineup=[(rb, side) for rb, side in lineup],
                           batting_home=x["is_home"], pk=x["pk"], L=L,
                           outs_pmf=outs, bf_pmf=bf)
    for mkt, v in out["starter"].items():
        assert sm[mkt]["line"] == v["line"], mkt
        assert sm[mkt]["p_over"] == pytest.approx(v["p_over"], abs=TOL), mkt
        assert sm[mkt]["expected"] == pytest.approx(v["expected"], abs=1e-8), mkt

    gm = S.game_markets(b, mu_home=out["mu_home"], mu_away=out["mu_away"])
    for k in ("p_home", "total_line", "p_over", "mu_total"):
        assert gm[k] == pytest.approx(out["game"][k], abs=TOL), k


def test_every_case_is_compared(golden):
    assert len(_cases()) == len(golden["cases"]) >= 6
