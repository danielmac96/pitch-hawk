"""Training's bulk batter roll-up == serving's per-batter roll-up.

markets.py computes batter distributions for half a million batter-games at
once; serve.py (mirrored by props.ts) computes one. The calibrators are fitted
on the bulk numbers and applied to the served ones, so they must be the same
numbers.
"""

from __future__ import annotations

import json
import pathlib

import numpy as np
import pandas as pd

from modeling import derive as D
from modeling import games as G
from modeling import markets as M
from modeling import serve as S

GOLDEN = pathlib.Path("tests/fixtures/props_golden.json")


def test_bulk_batter_dists_match_serving(monkeypatch):
    g = json.loads(GOLDEN.read_text())
    b, c = g["bundle"], g["cases"][0]
    x = c["inputs"]
    monkeypatch.setattr(G, "PEN_LEFT_SHARE", b["workload"]["pen_left_share"])
    _, bf = S.workload(b, rp=x["sp_r"], L=x["L"], **{k: v for k, v in x["workload"].items()
                                                     if k not in ("rp", "L")})
    rows = []
    for s, (rb, side) in enumerate(x["lineup"], 1):
        r = {"slot": s, "is_home": x["is_home"], "bat_side": side, "sp_hand": x["sp_hand"]}
        for name, arr in (("rb", rb), ("rs", x["sp_r"]), ("rpen", x["pen_r"]),
                          ("pk", x["pk"]), ("L", x["L"])):
            for k in range(7):
                r[f"{name}_{k}"] = arr[k]
        rows.append(r)
    frame = pd.DataFrame(rows)
    ps, pp = M.batter_pa_probs(b["pa_outcome"], frame)
    bulk = M.batter_dists(ps, pp, frame["slot"].to_numpy(), np.stack([bf] * len(frame)))
    for i, (rb, side) in enumerate(x["lineup"]):
        one = S.batter_dists(b, rb=rb, bat_side=side, slot=i + 1, is_home=x["is_home"],
                             sp_r=x["sp_r"], sp_hand=x["sp_hand"], pen_r=x["pen_r"],
                             pk=x["pk"], L=x["L"], bf_pmf=bf)
        np.testing.assert_allclose(bulk[i], one, atol=1e-12)
    pmf = np.stack([S.pa_pmf(b, s, x["is_home"]) for s in range(1, 10)])
    sv = G.batch_structural(bulk, pmf)
    for i in range(9):
        one = D.batter_structural(bulk[i], pmf[i])
        for k in ("hit", "hr", "tb2", "e_onbase", "e_pa"):
            assert abs(sv[k][i] - one[k]) < 1e-12, k
        assert abs(sv["e_value"][i] - S.batter_value(bulk[i], pmf[i])) < 1e-12
