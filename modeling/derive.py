"""From per-PA outcome distributions to game-level market probabilities.

Pure numpy, no I/O. Every function here has an exact TypeScript twin in
supabase/functions/_shared/props.ts, pinned by tests/modeling/test_derive_parity.py
against golden fixtures the TypeScript emits -- the same arrangement as
score.py / model.ts. If the two disagree, the TypeScript is what users see.

Class order everywhere is pa_model.CLASSES: K, BB, 1B, 2B, 3B, HR, OUT.

THE STRUCTURAL ASSUMPTIONS, stated so they can be argued with:

  * Plate appearances are independent given the matchup. They are not quite
    (a big inning gives the lineup an extra trip), and the per-market
    calibrators fitted on real game outcomes (calibrate()) absorb what this
    gets wrong rather than a hand-tuned constant.
  * A batter's i-th plate appearance is against the starter iff the starter is
    still in when that lineup turn comes up: slot s's i-th trip is the team's
    (s + 9(i-1))-th batter, so P(vs starter) = P(starter BF >= s + 9(i-1)).
  * A starter's outs recorded is the workload variable (it is what managers
    pull on and what the outs market grades); batters faced follow from it.
"""

from __future__ import annotations

import math

import numpy as np

K, BB, B1, B2, B3, HR, OUT = range(7)
HIT = (B1, B2, B3, HR)
TB_OF = np.array([0, 0, 1, 2, 3, 4, 0], float)   # total bases per class

MAX_PA = 8        # batter PA support 0..MAX_PA
MAX_BF = 45       # starter batters faced support
MAX_OUTS = 27     # a starter's outs support (complete game)


# ── batters ─────────────────────────────────────────────────────────────────

def vs_starter_prob(slot: int, n_pa: int, bf_pmf: np.ndarray) -> np.ndarray:
    """P(PA i is against the starter), i = 1..n_pa, from the starter's BF pmf."""
    sf = np.concatenate([np.cumsum(bf_pmf[::-1])[::-1], [0.0]])  # P(BF >= b)
    out = np.zeros(n_pa)
    for i in range(1, n_pa + 1):
        b = slot + 9 * (i - 1)
        out[i - 1] = sf[b] if b < len(sf) else 0.0
    return out


def batter_pa_dists(p_starter: np.ndarray, p_pen: np.ndarray, slot: int,
                    bf_pmf: np.ndarray, n: int = MAX_PA) -> np.ndarray:
    """(n, 7) per-PA class distributions: a mix of starter and bullpen."""
    q = vs_starter_prob(slot, n, bf_pmf)
    return q[:, None] * p_starter[None, :] + (1 - q)[:, None] * p_pen[None, :]


def p_at_least_one(per_pa: np.ndarray, pa_pmf: np.ndarray) -> float:
    """P(event in >= 1 PA) = sum_k P(N=k) * (1 - prod_{i<=k} (1 - e_i))."""
    none = np.concatenate([[1.0], np.cumprod(1.0 - per_pa)])
    k = min(len(pa_pmf), len(none))
    return float(np.dot(pa_pmf[:k], 1.0 - none[:k]))


def p_total_bases_at_least(dists: np.ndarray, pa_pmf: np.ndarray,
                           need: int = 2) -> float:
    """P(total bases >= need) over a random number of PAs, by DP capped at need."""
    state = np.zeros(need + 1)
    state[0] = 1.0
    out = pa_pmf[0] * 0.0
    for i in range(1, len(pa_pmf)):
        d = dists[i - 1]
        nxt = np.zeros(need + 1)
        for tb_have in range(need + 1):
            if state[tb_have] == 0.0:
                continue
            for c in range(7):
                nxt[min(need, tb_have + int(TB_OF[c]))] += state[tb_have] * d[c]
        state = nxt
        out += pa_pmf[i] * state[need]
    return float(out)


def batter_structural(dists: np.ndarray, pa_pmf: np.ndarray) -> dict:
    """Structural P(hit>=1), P(HR>=1), P(TB>=2) and expected counts."""
    k = len(pa_pmf)
    hit = dists[:, list(HIT)].sum(axis=1)
    hr = dists[:, HR]
    # E[count] = sum_i P(N >= i) * e_i
    surv = np.cumsum(pa_pmf[::-1])[::-1][1:]          # P(N >= i), i = 1..k-1
    return {
        "hit": p_at_least_one(hit, pa_pmf),
        "hr": p_at_least_one(hr, pa_pmf),
        "tb2": p_total_bases_at_least(dists, pa_pmf, 2),
        "e_hits": float(np.dot(surv, hit[: k - 1])),
        "e_tb": float(np.dot(surv, dists[: k - 1] @ TB_OF)),
        "e_pa": float(np.dot(np.arange(k), pa_pmf)),
        "e_onbase": float(np.dot(surv, 1.0 - dists[: k - 1, K]
                                 - dists[: k - 1, OUT])),
    }


# ── starters ────────────────────────────────────────────────────────────────

def shift_pmf(mu: float, residual_pmf: dict[int, float], lo: int = 0,
              hi: int = MAX_OUTS) -> np.ndarray:
    """P(X = x) for X = round(mu + R), R from an empirical residual pmf."""
    out = np.zeros(hi - lo + 1)
    for r, w in residual_pmf.items():
        x = int(math.floor(mu + int(r) + 0.5))
        out[min(hi, max(lo, x)) - lo] += float(w)
    s = out.sum()
    return out / s if s > 0 else out


def negbin_failures_pmf(o: int, p_out: float, n_max: int) -> np.ndarray:
    """P(F = f): non-out PAs before the o-th out, f = 0..n_max."""
    out = np.zeros(n_max + 1)
    if o == 0:
        out[0] = 1.0
        return out
    q = 1.0 - p_out
    # P(F=f) = C(f+o-1, f) p^o q^f, by recurrence for stability.
    v = p_out ** o
    for f in range(n_max + 1):
        out[f] = v
        v *= q * (f + o) / (f + 1)
    return out


def binom_pmf(n: int, p: float) -> np.ndarray:
    k = np.arange(n + 1)
    lg = (np.array([math.lgamma(n + 1)] * (n + 1)) - np.vectorize(math.lgamma)(k + 1)
          - np.vectorize(math.lgamma)(n - k + 1))
    p = min(max(p, 1e-12), 1 - 1e-12)
    return np.exp(lg + k * math.log(p) + (n - k) * math.log(1 - p))


def starter_counts(p_avg: np.ndarray, outs_pmf: np.ndarray,
                   n_max: int = 30) -> dict[str, np.ndarray]:
    """Count pmfs for a starter's K, BB(+HBP), hits allowed and batters faced.

    Given O = o outs: strikeouts ~ Binomial(o, pK/(pK+pOUT)); baserunners F
    ~ NegBin(o, p_out); hits | F ~ Binomial(F, pH/(pH+pBB)). `p_avg` is the
    pitcher's per-PA distribution averaged over the lineup he will face.
    """
    pk, pout = float(p_avg[K]), float(p_avg[OUT])
    p_o = pk + pout
    ph = float(p_avg[list(HIT)].sum())
    pbb = float(p_avg[BB])
    k_pmf = np.zeros(n_max + 1)
    h_pmf = np.zeros(n_max + 1)
    bb_pmf = np.zeros(n_max + 1)
    bf_pmf = np.zeros(MAX_BF + 1)
    share_k = pk / p_o
    share_h = ph / max(ph + pbb, 1e-12)
    for o, w in enumerate(outs_pmf):
        if w <= 0:
            continue
        kb = binom_pmf(o, share_k)
        k_pmf[: len(kb)] += w * kb[: n_max + 1]
        fail = negbin_failures_pmf(o, p_o, n_max)
        for f, wf in enumerate(fail):
            if wf <= 1e-14:
                continue
            bf_pmf[min(MAX_BF, o + f)] += w * wf
            hb = binom_pmf(f, share_h)
            h_pmf[: f + 1] += w * wf * hb
            bb_pmf[: f + 1] += w * wf * hb[::-1]
    return {"k": k_pmf, "h": h_pmf, "bb": bb_pmf, "bf": bf_pmf, "outs": outs_pmf}


def over_prob(pmf: np.ndarray, line: float) -> float:
    """P(X > line) for a half-point line."""
    return float(pmf[int(math.floor(line)) + 1:].sum())


def median_line(pmf: np.ndarray) -> float:
    """The half-point line closest to an even split -- the model-fair line."""
    best, line = None, 0.5
    for k in range(len(pmf)):
        d = abs(over_prob(pmf, k + 0.5) - 0.5)
        if best is None or d < best:
            best, line = d, k + 0.5
    return line


# ── runs ────────────────────────────────────────────────────────────────────

def negbin_pmf(mu: float, alpha: float, n_max: int = 30) -> np.ndarray:
    """NB2 pmf with mean mu and variance mu + alpha mu^2 (alpha -> 0: Poisson)."""
    mu = max(mu, 1e-6)
    if alpha < 1e-6:
        k = np.arange(n_max + 1)
        lp = -mu + k * math.log(mu) - np.vectorize(math.lgamma)(k + 1)
        return np.exp(lp)
    r = 1.0 / alpha
    p = r / (r + mu)
    out = np.zeros(n_max + 1)
    v = p ** r
    for k in range(n_max + 1):
        out[k] = v
        v *= (k + r) / (k + 1) * (1 - p)
    return out


def convolve_total(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    return np.convolve(a, b)


def home_win_prob(home: np.ndarray, away: np.ndarray,
                  extra_home: float = 0.52) -> float:
    """P(home scores more) + P(tie after 9) * P(home wins in extras)."""
    cdf_away = np.cumsum(away)
    win = float(sum(home[h] * (cdf_away[h - 1] if h > 0 else 0.0)
                    for h in range(len(home))))
    n = min(len(home), len(away))
    tie = float(np.dot(home[:n], away[:n]))
    return win + tie * extra_home


# ── calibration ─────────────────────────────────────────────────────────────

def calibrate(p: float, cal: dict | None) -> float:
    """Platt-style: sigmoid(a + b * logit(p) + sum w_j x_j). None -> identity."""
    if not cal:
        return p
    p = min(max(p, 1e-6), 1 - 1e-6)
    z = cal["a"] + cal["b"] * math.log(p / (1 - p))
    return 1.0 / (1.0 + math.exp(-z))
