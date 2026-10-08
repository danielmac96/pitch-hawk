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


# lgamma at the integers 0..255. Every argument in the count tables below is
# a whole number, so a lookup is exact and keeps a season of starters cheap.
_LG = np.array([math.lgamma(i) if i > 0 else 0.0 for i in range(256)])


def _lgamma(x: np.ndarray) -> np.ndarray:
    return _LG[np.asarray(x, float).astype(int)]


def binom_table(n_max: int, p: float) -> np.ndarray:
    """T[n, k] = P(Binomial(n, p) = k), n, k = 0..n_max (zero for k > n)."""
    p = min(max(p, 1e-12), 1 - 1e-12)
    n = np.arange(n_max + 1)[:, None]
    k = np.arange(n_max + 1)[None, :]
    valid = k <= n
    lg = (_lgamma(n + 1.0) - _lgamma(np.where(valid, k, 0) + 1.0)
          - _lgamma(np.where(valid, n - k, 0) + 1.0))
    t = np.exp(lg + k * math.log(p) + np.where(valid, n - k, 0) * math.log(1 - p))
    return np.where(valid, t, 0.0)


def negbin_failures_table(o_max: int, p_out: float, n_max: int) -> np.ndarray:
    """T[o, f] = P(f non-out PAs before the o-th out), o = 0..o_max."""
    p_out = min(max(p_out, 1e-9), 1 - 1e-12)
    o = np.arange(o_max + 1)[:, None].astype(float)
    f = np.arange(n_max + 1)[None, :].astype(float)
    lg = _lgamma(f + np.maximum(o, 1.0)) - _lgamma(f + 1.0) - _lgamma(np.maximum(o, 1.0))
    t = np.exp(lg + o * math.log(p_out) + f * math.log(1 - p_out))
    t[0, :] = 0.0
    t[0, 0] = 1.0
    return t


def starter_counts(p_avg: np.ndarray, outs_pmf: np.ndarray,
                   n_max: int = 30) -> dict[str, np.ndarray]:
    """Count pmfs for a starter's K, BB(+HBP), hits allowed and batters faced.

    Given O = o outs: strikeouts ~ Binomial(o, pK/(pK+pOUT)); baserunners F
    ~ NegBin(o, p_out); hits | F ~ Binomial(F, pH/(pH+pBB)). `p_avg` is the
    pitcher's per-PA distribution averaged over the lineup he will face.
    Written as matrix products so a season of starters scores in seconds;
    props.ts computes the same sums with loops.
    """
    o_max = len(outs_pmf) - 1
    pk, pout = float(p_avg[K]), float(p_avg[OUT])
    p_o = pk + pout
    ph = float(p_avg[list(HIT)].sum())
    pbb = float(p_avg[BB])
    w = np.asarray(outs_pmf, float)
    kt = binom_table(max(o_max, n_max), pk / p_o)[: o_max + 1, : n_max + 1]
    nb = negbin_failures_table(o_max, p_o, n_max)          # (o, f)
    f_marg = w @ nb                                          # P(F = f)
    ht = binom_table(n_max, ph / max(ph + pbb, 1e-12))      # (f, h)
    h_pmf = f_marg @ ht
    # BB = F - H: P(BB = j) = sum_f P(F = f) P(H = f - j).
    bb_pmf = np.zeros(n_max + 1)
    for f_ in range(n_max + 1):
        if f_marg[f_] > 0:
            bb_pmf[: f_ + 1] += f_marg[f_] * ht[f_, f_::-1]
    bf_pmf = np.zeros(MAX_BF + 1)
    wn = w[:, None] * nb
    for o_ in range(o_max + 1):
        idx = np.minimum(MAX_BF, o_ + np.arange(n_max + 1))
        np.add.at(bf_pmf, idx, wn[o_])
    return {"k": w @ kt, "h": h_pmf, "bb": bb_pmf, "bf": bf_pmf,
            "outs": w}


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

def calibrate(p: float, cal: dict | None, x: dict | None = None) -> float:
    """sigmoid(a + b * logit(p) + sum_j w_j * x_j). None -> identity.

    `cal["w"]` names extra features (e.g. the batter's expected times on base
    for H+R+RBI); a name missing from `x` contributes 0, matching props.ts.
    """
    if not cal:
        return p
    p = min(max(p, 1e-6), 1 - 1e-6)
    z = cal["a"] + cal["b"] * math.log(p / (1 - p))
    for name, w in (cal.get("w") or {}).items():
        z += float(w) * float((x or {}).get(name, 0.0))
    return 1.0 / (1.0 + math.exp(-z))
