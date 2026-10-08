"""Player, park and bullpen ratings -- the one feature source for train AND serve.

THE PROBLEM THIS SOLVES. Until 2026-10 the batter markets were fitted on
career/d30/d90 bucketed rates computed from R2, then served from 30-day rates
in `batter_rolling_stats` (the Postgres hot window). Same names, different
quantities: the 30-day serve-time inputs carry ~1.7x the spread of the
training ones, so the shipped coefficients over-reacted and the published
probabilities ran 1.25x (hits) to 1.37x (home runs) hot against what happened.
The patches -- HR_K, HIT_K, CALIB_SHRINK in model.ts -- were constants tuned
after the fact.

Here a rating is defined ONCE, as a function of the PA history before a date,
and both sides call it:

  * training computes it as of every historical game day (exclusive of that
    day -- the leakage rule), so a 2019 plate appearance sees exactly what
    production would have read that morning;
  * the nightly publish computes it as of tomorrow for every active player and
    writes `player_ratings`, which the edge functions read.

THE ESTIMATOR. For player p, outcome class c and day d:

    S_c(d) = sum over p's PAs before d of  exp(-(d - day)/tau) * [class == c]
    S_n(d) = sum over p's PAs before d of  exp(-(d - day)/tau)
    r_c(d) = (S_c + k_c * L_c(d)) / (S_n + k_c)          then normalised

an exponentially-weighted rate with a beta prior of strength k_c centred on the
league rate as of the same day. Two knobs, both fitted rather than chosen:
`tau` (how fast old seasons fade) and `k_c` (how many plate appearances a
class needs before a player's own rate is trusted -- strikeouts stabilise in
tens of PAs, triples never really do). `tune()` picks them by out-of-sample
log loss of the NEXT plate appearance.

Vectorised: within a player, S_c(d) = exp(-d/tau) * cumsum(c * exp(day/tau))
over earlier days, so every as-of value in the corpus is two cumulative sums
and a subtraction. Days are counted from 2015-01-01; with tau >= 100 the
largest exponent is ~44, comfortably inside float64.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

# The seven plate-appearance outcomes every player market is built from.
CLASSES: tuple[str, ...] = ("K", "BB", "1B", "2B", "3B", "HR", "OUT")
NC = len(CLASSES)

# at_bats.result_detail (the MLB eventType) -> class index.
#
# BB includes hit-by-pitch and intentional walks: for every market on the
# board (hits, total bases, runs, strikeouts, outs) they are the same event --
# the batter is on first and no ball was put in play.
#
# OUT is every ball-in-play out INCLUDING reached-on-error and fielder's
# choice: the batter did not get a hit, which is what the hit and total-bases
# markets ask. Sacrifices are OUT for the same reason.
EVENT_CLASS: dict[str, int] = {
    "strikeout": 0, "strikeout_double_play": 0, "strikeout_triple_play": 0,
    "walk": 1, "intent_walk": 1, "hit_by_pitch": 1,
    "single": 2, "double": 3, "triple": 4, "home_run": 5,
    "field_out": 6, "force_out": 6, "grounded_into_double_play": 6,
    "grounded_into_triple_play": 6, "double_play": 6, "triple_play": 6,
    "sac_fly": 6, "sac_bunt": 6, "sac_fly_double_play": 6,
    "sac_bunt_double_play": 6, "field_error": 6, "fielders_choice": 6,
    "fielders_choice_out": 6, "other_out": 6,
}
# Everything else ends a plate appearance WITHOUT the batter completing it
# (caught stealing, pickoffs, wild pitches on a third out) or is not a contest
# between the two players at all (catcher interference). Excluded from every
# rate rather than forced into a class.

EPOCH = pd.Timestamp("2015-01-01")


def day_index(dates) -> np.ndarray:  # noqa: ANN001
    """Days since EPOCH, as float. Accepts dates, timestamps or ISO strings."""
    return ((pd.to_datetime(pd.Series(dates)).dt.normalize() - EPOCH)
            / pd.Timedelta(days=1)).to_numpy(float)


def classify(result_detail: pd.Series) -> pd.Series:
    """result_detail -> class index, NaN for excluded events."""
    return result_detail.map(EVENT_CLASS)


# ── the as-of decayed sums ──────────────────────────────────────────────────

def decayed_asof(df: pd.DataFrame, key: str | list[str], tau: float,
                 *, weights: np.ndarray | None = None) -> pd.DataFrame:
    """Exclusive decayed class sums per (key, day).

    `df` needs `day` (float, days since EPOCH), `y` (class index 0..NC-1) and
    the key column(s). `weights`, if given, replaces the per-row indicator
    mass for EVERY class column (used for expected-count sums: pass a (n, NC)
    array and each class column sums that column instead of [y == c]).

    Returns one row per (key, day) the key appears on, with S_0..S_{NC-1}
    and S_n -- the sums over strictly EARLIER days. A player's own game day
    never informs his rating for that day.
    """
    keys = [key] if isinstance(key, str) else list(key)
    if weights is None:
        mass = np.zeros((len(df), NC))
        mass[np.arange(len(df)), df["y"].to_numpy(int)] = 1.0
    else:
        mass = np.asarray(weights, float)
    cols = [f"S_{c}" for c in range(NC)]
    m = pd.DataFrame(mass, columns=cols, index=df.index)
    m["S_n"] = 1.0
    for k in keys:
        m[k] = df[k].to_numpy()
    m["day"] = df["day"].to_numpy(float)
    daily = m.groupby(keys + ["day"], sort=True, observed=True)[cols + ["S_n"]].sum()
    daily = daily.reset_index()

    up = np.exp(daily["day"].to_numpy() / tau)
    down = 1.0 / up
    vals = daily[cols + ["S_n"]].to_numpy() * up[:, None]
    # Inclusive running sums within each key, minus the day's own mass ->
    # exclusive of the current day.
    cum = pd.DataFrame(vals, index=daily.index).groupby(
        [daily[k] for k in keys], sort=False, observed=True).cumsum().to_numpy()
    excl = (cum - vals) * down[:, None]
    out = daily[keys + ["day"]].copy()
    out[cols + ["S_n"]] = excl
    return out


def decayed_total(df: pd.DataFrame, key: str | list[str], tau: float,
                  at_day: float) -> pd.DataFrame:
    """Decayed class sums per key over ALL rows before `at_day`.

    The serving-side twin of decayed_asof: the nightly publish calls this with
    at_day = tomorrow. Same arithmetic, one row per key.
    """
    keys = [key] if isinstance(key, str) else list(key)
    sub = df[df["day"] < at_day]
    w = np.exp(-(at_day - sub["day"].to_numpy(float)) / tau)
    mass = np.zeros((len(sub), NC))
    mass[np.arange(len(sub)), sub["y"].to_numpy(int)] = w
    cols = [f"S_{c}" for c in range(NC)]
    m = pd.DataFrame(mass, columns=cols, index=sub.index)
    m["S_n"] = w
    for k in keys:
        m[k] = sub[k].to_numpy()
    return m.groupby(keys, observed=True)[cols + ["S_n"]].sum().reset_index()


def league_asof(df: pd.DataFrame, tau: float = 365.0) -> pd.DataFrame:
    """League class rates as of each day (exclusive), one row per day.

    The prior every player rating shrinks toward. As-of rather than a constant
    because the league moves: the strikeout rate rose for a decade and the
    2023 rule changes moved hits and stolen bases in a single winter.
    """
    tmp = df[["day", "y"]].copy()
    tmp["_all"] = 0
    s = decayed_asof(tmp, "_all", tau)
    rates = s[[f"S_{c}" for c in range(NC)]].to_numpy()
    n = s["S_n"].to_numpy()
    # The very first day has no history; borrow the first day's own mix.
    first = df[df["day"] == df["day"].min()]["y"].value_counts(normalize=True)
    fallback = np.array([first.get(c, 1e-3) for c in range(NC)])
    with np.errstate(invalid="ignore", divide="ignore"):
        L = np.where(n[:, None] > 0, rates / n[:, None], fallback[None, :])
    L = np.clip(L, 1e-4, 1.0)
    L = L / L.sum(axis=1, keepdims=True)
    out = pd.DataFrame(L, columns=[f"L_{c}" for c in range(NC)])
    out.insert(0, "day", s["day"].to_numpy())
    return out


def shrink(S: np.ndarray, n: np.ndarray, L: np.ndarray,
           k: np.ndarray) -> np.ndarray:
    """(S_c + k_c L_c) / (n + k_c), renormalised to a distribution."""
    r = (S + k[None, :] * L) / (n[:, None] + k[None, :])
    return r / r.sum(axis=1, keepdims=True)


# ── tuning tau and k ────────────────────────────────────────────────────────

# Grids. k is per class, in plate appearances; tau in days. Wide on purpose:
# the right answer for triples and for strikeouts differ by two orders of
# magnitude, and the sweep is cheap (two cumsums per tau, arithmetic per k).
TAU_GRID: tuple[float, ...] = (180.0, 365.0, 540.0, 730.0, 1095.0)
K_GRID: tuple[float, ...] = (25.0, 50.0, 100.0, 200.0, 400.0, 800.0,
                             1600.0, 3200.0)


@dataclass(frozen=True)
class RatingConfig:
    """Fitted hyperparameters for one subject (batter, pitcher, park, pen)."""

    tau: float
    k: tuple[float, ...]
    # Mean per-PA binary log loss per class at the chosen setting, and the
    # same for the league-only prior -- the rating's measured value-add.
    logloss: dict = field(default_factory=dict)

    def to_json(self) -> dict:
        return {"tau": self.tau, "k": list(self.k), "logloss": self.logloss}

    @staticmethod
    def from_json(d: dict) -> "RatingConfig":
        return RatingConfig(float(d["tau"]), tuple(float(v) for v in d["k"]),
                            dict(d.get("logloss", {})))


def _binary_ll(p: np.ndarray, y: np.ndarray) -> float:
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def tune(pa: pd.DataFrame, key: str, league: pd.DataFrame, *,
         eval_mask: np.ndarray, taus=TAU_GRID, ks=K_GRID,
         verbose: bool = True) -> RatingConfig:
    """Pick tau and per-class k by next-PA binary log loss on `eval_mask` rows.

    Classes are tuned independently given tau: the per-class binary log loss
    of [y == c] against r_c separates exactly over k_c (the renormalisation
    couples them only weakly, and the PA model downstream re-weights every
    class anyway). tau is shared across classes -- one notion of "how fast a
    player changes" -- and chosen by the summed loss.
    """
    Lrow = pa[["day"]].merge(league, on="day", how="left")
    L = Lrow[[f"L_{c}" for c in range(NC)]].to_numpy()[eval_mask]
    y = pa["y"].to_numpy(int)[eval_mask]
    Y = np.zeros((len(y), NC))
    Y[np.arange(len(y)), y] = 1.0
    base = {CLASSES[c]: round(_binary_ll(L[:, c], Y[:, c]), 6) for c in range(NC)}

    best = None
    for tau in taus:
        s = decayed_asof(pa, key, tau)
        joined = pa[[key, "day"]].merge(s, on=[key, "day"], how="left")
        S = joined[[f"S_{c}" for c in range(NC)]].to_numpy()[eval_mask]
        n = joined["S_n"].to_numpy()[eval_mask]
        ks_best, ll_best = [], []
        for c in range(NC):
            scores = []
            for k in ks:
                r = (S[:, c] + k * L[:, c]) / (n + k)
                scores.append(_binary_ll(r, Y[:, c]))
            j = int(np.argmin(scores))
            ks_best.append(ks[j])
            ll_best.append(scores[j])
        total = float(sum(ll_best))
        if verbose:
            print(f"[ratings] {key} tau={tau:.0f} k={ks_best} "
                  f"sum_ll={total:.6f} (league-only {sum(base.values()):.6f})",
                  flush=True)
        if best is None or total < best[0]:
            best = (total, tau, tuple(ks_best),
                    {CLASSES[c]: round(ll_best[c], 6) for c in range(NC)})
    _, tau, k, ll = best
    return RatingConfig(tau=tau, k=k, logloss={"rating": ll, "league": base})


# ── applying a config ───────────────────────────────────────────────────────

def ratings_asof(pa: pd.DataFrame, key: str, league: pd.DataFrame,
                 cfg: RatingConfig) -> pd.DataFrame:
    """Shrunk class rates for every (key, day) in `pa`, plus effective n."""
    s = decayed_asof(pa, key, cfg.tau)
    s = s.merge(league, on="day", how="left")
    S = s[[f"S_{c}" for c in range(NC)]].to_numpy()
    n = s["S_n"].to_numpy()
    L = s[[f"L_{c}" for c in range(NC)]].to_numpy()
    r = shrink(S, n, L, np.asarray(cfg.k))
    out = s[[key, "day"]].copy()
    for c in range(NC):
        out[f"r_{c}"] = r[:, c]
    out["n_eff"] = n
    return out


def ratings_current(pa: pd.DataFrame, key: str, L_now: np.ndarray,
                    cfg: RatingConfig, at_day: float) -> pd.DataFrame:
    """Serving twin of ratings_asof: one row per key, as of `at_day`."""
    s = decayed_total(pa, key, cfg.tau, at_day)
    S = s[[f"S_{c}" for c in range(NC)]].to_numpy()
    n = s["S_n"].to_numpy()
    L = np.repeat(np.asarray(L_now, float)[None, :], len(s), axis=0)
    r = shrink(S, n, L, np.asarray(cfg.k))
    out = s[[key]].copy()
    for c in range(NC):
        out[f"r_{c}"] = r[:, c]
    out["n_eff"] = n
    return out
