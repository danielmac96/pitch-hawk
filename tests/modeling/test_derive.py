"""Market roll-ups: exact identities and a Monte Carlo cross-check."""

from __future__ import annotations

import numpy as np
import pytest

from modeling import derive as D

P = np.array([0.22, 0.09, 0.14, 0.045, 0.004, 0.03, 0.471])


def test_vs_starter_prob_by_slot():
    bf = np.zeros(D.MAX_BF + 1)
    bf[20] = 1.0                         # starter faces exactly 20
    np.testing.assert_allclose(D.vs_starter_prob(1, 4, bf), [1, 1, 1, 0])
    np.testing.assert_allclose(D.vs_starter_prob(3, 4, bf), [1, 1, 0, 0])


def test_at_least_one_matches_closed_form():
    pmf = np.zeros(D.MAX_PA + 1)
    pmf[4] = 1.0
    e = np.full(D.MAX_PA, 0.25)
    assert D.p_at_least_one(e, pmf) == pytest.approx(1 - 0.75 ** 4)


def test_tb2_against_enumeration():
    pmf = np.zeros(D.MAX_PA + 1)
    pmf[2] = 1.0
    d = np.tile(P, (D.MAX_PA, 1))
    # TB >= 2 in two PAs: 1 - P(TB<=1) = 1 - [P0^2 + 2 P0 P1]
    p0 = P[[0, 1, 6]].sum()
    p1 = P[2]
    assert D.p_total_bases_at_least(d, pmf) == pytest.approx(1 - p0**2 - 2*p0*p1)


def test_batter_structural_expectations():
    pmf = np.zeros(D.MAX_PA + 1)
    pmf[4], pmf[5] = 0.5, 0.5
    d = np.tile(P, (D.MAX_PA, 1))
    s = D.batter_structural(d, pmf)
    assert s["e_pa"] == pytest.approx(4.5)
    assert s["e_hits"] == pytest.approx(4.5 * P[2:6].sum())
    assert 0 < s["hr"] < s["hit"] < 1


def test_starter_counts_monte_carlo():
    rng = np.random.default_rng(0)
    outs = np.zeros(D.MAX_OUTS + 1)
    outs[15], outs[18] = 0.6, 0.4
    got = D.starter_counts(P, outs)
    for name in ("k", "h", "bb", "bf"):
        assert got[name].sum() == pytest.approx(1.0, abs=1e-6)
    sims = {"k": [], "h": [], "bb": [], "bf": []}
    for _ in range(20000):
        o_target = 15 if rng.random() < 0.6 else 18
        o = k = h = bb = bf = 0
        while o < o_target:
            c = rng.choice(7, p=P)
            bf += 1
            if c in (0, 6):
                o += 1
                k += c == 0
            elif c == 1:
                bb += 1
            else:
                h += 1
        for n, v in (("k", k), ("h", h), ("bb", bb), ("bf", bf)):
            sims[n].append(v)
    for n in sims:
        mc = np.mean(sims[n])
        an = float(np.dot(np.arange(len(got[n])), got[n]))
        assert an == pytest.approx(mc, rel=0.02), n


def test_lines_and_over_probs():
    pmf = np.array([0.1, 0.2, 0.3, 0.4])
    assert D.over_prob(pmf, 1.5) == pytest.approx(0.7)
    assert D.median_line(pmf) in (1.5, 2.5)


def test_negbin_and_win_prob():
    a = D.negbin_pmf(4.5, 0.1, 40)
    assert a.sum() == pytest.approx(1.0, abs=1e-6)
    assert np.dot(np.arange(41), a) == pytest.approx(4.5, rel=1e-3)
    pois = D.negbin_pmf(4.5, 0.0, 40)
    assert np.dot(np.arange(41), pois) == pytest.approx(4.5, rel=1e-3)
    # Symmetric teams: home advantage only via extras share.
    p = D.home_win_prob(a, a, extra_home=0.5)
    assert p == pytest.approx(0.5, abs=1e-6)
    assert D.home_win_prob(D.negbin_pmf(5.0, 0.1, 40), a) > 0.5


def test_calibrate_identity_and_monotone():
    assert D.calibrate(0.3, None) == 0.3
    cal = {"a": 0.1, "b": 0.9}
    assert D.calibrate(0.2, cal) < D.calibrate(0.4, cal)
