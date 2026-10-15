"""tests/fixtures/v4_trees_golden.json: the contract between
modeling/v4/export.py::score and supabase/functions/_shared/v4.ts.

Python writes it (it is the only side that can fit a model); the Deno test
supabase/functions/tests/v4_golden_test.ts scores every row with the
TypeScript and must match to 1e-9. This test fails if the fixture is stale
relative to export.score. Regenerate after an intentional change:

    UPDATE_GOLDEN=1 pytest tests/modeling/test_v4_golden.py
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np

from modeling.v4 import export as X
from modeling.v4 import learners as L

from .test_v4_ladder import _frame, _md

PATH = Path(__file__).resolve().parents[1] / "fixtures" / "v4_trees_golden.json"
FEATS = ["x1", "x2", "grp", "v3"]


def _cases():
    out = []
    for kind, mk in (
        ("binary", lambda md: L.Calibrated(md, FEATS, make_base=lambda: L.GBM(md, FEATS, max_iter=8))),
        ("binary", lambda md: L.GLM(md, FEATS)),
        ("multiclass", lambda md: L.GBM(md, FEATS, max_iter=6)),
        ("multiclass", lambda md: L.Calibrated(md, FEATS, make_base=lambda: L.GLM(md, FEATS))),
        ("count", lambda md: L.GBM(md, FEATS, max_iter=8)),
        ("count", lambda md: L.GBMCountMC(md, FEATS, max_iter=5)),
        ("count", lambda md: L.GLM(md, FEATS)),
        ("gaussian", lambda md: L.GBM(md, FEATS, max_iter=8)),
        ("gaussian", lambda md: L.Calibrated(md, FEATS, make_base=lambda: L.GLM(md, FEATS))),
    ):
        md = _md(kind)
        fr = _frame(kind, n_per=300)
        fr.loc[fr.index[::7], "x2"] = np.nan
        m = mk(md).fit(fr[fr["season"] < 2026])
        spec = json.loads(json.dumps(X.export(m)))
        te = fr[fr["season"] == 2026].head(25)
        rows = [{f: (None if np.isnan(v) else float(v)) for f, v in zip(FEATS, r)}
                for r in te[FEATS].to_numpy(float)]
        pred = X.score(spec, te[spec["features"]].to_numpy())
        out.append({"spec": spec, "rows": rows, "expected": np.asarray(pred).tolist()})
    return out


def test_golden_fixture_matches_export_score():
    cases = _cases()
    if os.environ.get("UPDATE_GOLDEN"):
        PATH.write_text(json.dumps({"cases": cases}, separators=(",", ":")))
    stored = json.loads(PATH.read_text())["cases"]
    assert len(stored) == len(cases)
    for s in stored:
        spec = s["spec"]
        Xr = np.array([[np.nan if r[f] is None else r[f] for f in spec["features"]]
                       for r in s["rows"]])
        np.testing.assert_allclose(np.asarray(X.score(spec, Xr)), np.asarray(s["expected"]),
                                   atol=1e-12)
