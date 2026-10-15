"""Exported v4 models score exactly as the fitted learners do.

The edge functions score in-game markets from the exported JSON, so the
export is the model production runs. Every learner type the ladder can
choose, in every prediction kind, round-trips here to 1e-9; the TypeScript
twin is pinned to `export.score` by tests/fixtures/v4_trees_golden.json.
"""

from __future__ import annotations

import json

import numpy as np
import pytest

from modeling.v4 import export as X
from modeling.v4 import learners as L

from .test_v4_ladder import _frame, _md

CASES = [(k, it) for k in ("binary", "multiclass", "count", "gaussian")
         for it in ("glm", "gbm", "tuned", "calibrated")] + [("count", "gbm_mc")]


def _learner(kind: str, which: str, md):  # noqa: ANN001
    feats = ["x1", "x2", "grp", "v3"]
    small = {"max_iter": 30}
    if which == "glm":
        return L.GLM(md, feats)
    if which == "gbm":
        return L.GBM(md, feats, **small)
    if which == "gbm_mc":
        return L.GBMCountMC(md, feats, **small)
    if which == "tuned":
        return L.Tuned(md, feats, grid=({"max_iter": 20, "max_leaf_nodes": 7},
                                        {"max_iter": 25, "max_leaf_nodes": 15}))
    return L.Calibrated(md, feats, make_base=lambda: L.GBM(md, feats, **small))


@pytest.mark.parametrize("kind,which", CASES)
def test_export_round_trip(kind, which):
    md = _md(kind)
    fr = _frame(kind, n_per=500)
    fr.loc[fr.index[::11], "x2"] = np.nan  # missing values take the learned branch
    tr, te = fr[fr["season"] < 2026], fr[fr["season"] == 2026].head(120)
    m = _learner(kind, which, md).fit(tr)
    spec = json.loads(json.dumps(X.export(m)))  # what travels is JSON
    got = X.score(spec, te[spec["features"]].to_numpy())
    want = np.asarray(m.predict(te))
    assert got.shape == want.shape
    np.testing.assert_allclose(got, want, rtol=0, atol=1e-9)


def test_nb_pmf_matches_derive():
    from modeling import derive as D
    mu = np.array([0.3, 2.5, 7.0])
    for a in (0.0, 0.2):
        got = L.nb_pmf(mu, a, 12)
        for i, m in enumerate(mu):
            want = D.negbin_pmf(m, a, 11)
            np.testing.assert_allclose(got[i, :12], want, atol=1e-12)
            assert got[i].sum() == pytest.approx(1.0)
