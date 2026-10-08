"""Game-level datasets and models on top of the PA outcome model.

Every player and game market on the board, built the same way:

    as-of ratings  ->  PA outcome model  ->  structural roll-up (derive.py)
                   ->  calibrator fitted on what actually happened in games

The calibrator is the honest part. The roll-up assumes independent plate
appearances, a lineup that bats in order, a starter whose exit point is
independent of how he is pitching; none of that is exactly true. Rather than
hand-tune constants for each gap (the old HR_K / HIT_K / CALIB_SHRINK), a
small logistic layer per market is fitted on real game outcomes, walk-forward,
and its coefficients ship in model_params beside everything else.

Pieces:
  workload    a starter's outs recorded and batters faced: linear location
              model on his and his team's history + an empirical residual pmf
  pa_pmf      plate appearances per game by lineup slot and home/away
  batters     batter_hit, batter_hr, batter_tb15, batter_hrr
  starters    pitcher_k, pitcher_bb, pitcher_hits, pitcher_outs, pitcher_er
  teams       runs per team (negative binomial GLM) -> game_total, moneyline

Bullpen plate appearances have no known pitcher pregame, so they are scored
against the team's pooled relief rating with handedness at its league mix
(PEN_LEFT_SHARE). props.ts does the same.
"""

from __future__ import annotations

import math
import time

import numpy as np
import pandas as pd

from modeling import derive as D
from modeling import pa_model as P
from modeling import ratings as R

NC = R.NC

# Share of relief PAs thrown by left-handers, for scoring a bullpen whose
# individual arms are unknown pregame. A default only: markets.run measures it
# from the training data (measure_pen_left_share) and ships the measured value
# in the `workload` params, which is what props.ts reads.
PEN_LEFT_SHARE = 0.29


def measure_pen_left_share(pa: pd.DataFrame) -> float:
    rel = pa[~pa["pit_started"].astype(bool)]
    return round(float((rel["pitch_hand"] == "L").mean()), 4) if len(rel) else PEN_LEFT_SHARE

# wOBA-style weights per class, for a lineup's expected offensive value. Only
# the RATIOS matter: the team-runs GLM fits the scale. Order K BB 1B 2B 3B HR OUT.
RUN_WEIGHTS = np.array([0.0, 0.70, 0.89, 1.27, 1.62, 2.10, 0.0])

# Workload priors (league-ish), in the units of each quantity, and their
# strength in pseudo-starts. The location model re-weights them anyway.
WORKLOAD = {
    "p_outs": {"tau": 150.0, "prior": 16.0, "k": 3.0},
    "p_bf": {"tau": 150.0, "prior": 23.0, "k": 3.0},
    "p_pitches": {"tau": 150.0, "prior": 88.0, "k": 3.0},
}
TEAM_LEASH = {"tau": 150.0, "prior": 16.0, "k": 10.0}


# ── weather, mirrored from mlb.ts semantics ─────────────────────────────────

def wind_out(mph, direction, roof_closed) -> float:  # noqa: ANN001
    """Signed wind toward centre field, mph. 0 for a closed roof or crosswind."""
    if roof_closed or mph is None or (isinstance(mph, float) and math.isnan(mph)):
        return 0.0
    d = str(direction or "").lower()
    f = 0.0
    if d.startswith("out to cf"):
        f = 1.0
    elif d.startswith("out to"):
        f = 0.7
    elif d.startswith("in from cf"):
        f = -1.0
    elif d.startswith("in from"):
        f = -0.7
    return float(mph) * f


def roof_closed(condition) -> bool:  # noqa: ANN001
    c = str(condition or "").lower()
    return "dome" in c or "roof closed" in c


def temp_c(temp, closed) -> float:  # noqa: ANN001
    """Degrees F above 70, 0 when covered or unknown."""
    if closed or temp is None or (isinstance(temp, float) and math.isnan(temp)):
        return 0.0
    return float(temp) - 70.0


# ── loading ─────────────────────────────────────────────────────────────────

BOX_SQL = """
select b.*, g.season, g.venue_id, g.home_team_id, g.away_team_id,
       g.home_score, g.away_score, g.temp_f, g.wind_mph, g.wind_direction,
       g.weather_condition
from player_box b join games g using (game_pk)
where coalesce(g.game_type, 'R') = 'R'
"""


def load_box(store) -> pd.DataFrame:  # noqa: ANN001
    from warehouse import duck

    con = duck.connect(store)
    duck.register(con, store, names=("games", "player_box"))
    df = con.execute(BOX_SQL).df()
    df["day"] = R.day_index(df["game_date"])
    return df


def hands_from_pa(pa: pd.DataFrame) -> tuple[dict, dict]:
    """Most frequent bat side per batter and throwing hand per pitcher."""
    bs = pa.groupby("batter_id")["bat_side"].agg(
        lambda s: s.mode().iat[0] if len(s.mode()) else "R").to_dict()
    ph = pa.groupby("pitcher_id")["pitch_hand"].agg(
        lambda s: s.mode().iat[0] if len(s.mode()) else "R").to_dict()
    return bs, ph


def asof(frame: pd.DataFrame, table: pd.DataFrame, left_key: str,
         right_key: str, cols: list[str]) -> np.ndarray:
    """Latest table row at or before each frame row's day, per key."""
    left = frame[[left_key, "day"]].copy()
    left["_i"] = np.arange(len(left))
    left = left.rename(columns={left_key: "_k"}).sort_values("day")
    right = table[[right_key, "day"] + cols].rename(
        columns={right_key: "_k"}).sort_values("day")
    left["_k"] = left["_k"].astype("float64")
    right["_k"] = right["_k"].astype("float64")
    m = pd.merge_asof(left, right, on="day", by="_k", direction="backward")
    return m.sort_values("_i")[cols].to_numpy()


# ── workload ────────────────────────────────────────────────────────────────

WORKLOAD_FEATURES = ("own_mean", "team_leash", "pitches_mean", "rest",
                     "first_start", "quality")


def workload_frame(box: pd.DataFrame, pit_rating: pd.DataFrame,
                   league: pd.DataFrame) -> pd.DataFrame:
    """One row per start with as-of workload features."""
    starts = box[box["p_started"].fillna(False).astype(bool)].copy()
    starts = starts.sort_values(["day", "game_pk"]).reset_index(drop=True)
    for v, cfg in WORKLOAD.items():
        m = R.decayed_mean_asof(starts, "player_id", v, cfg["tau"],
                                cfg["prior"], cfg["k"])
        starts = starts.merge(m[["player_id", "day", f"{v}_mean"]],
                              on=["player_id", "day"], how="left")
    leash = R.decayed_mean_asof(starts.assign(team_outs=starts["p_outs"]),
                                "team_id", "team_outs", TEAM_LEASH["tau"],
                                TEAM_LEASH["prior"], TEAM_LEASH["k"])
    starts = starts.merge(leash[["team_id", "day", "team_outs_mean"]],
                          on=["team_id", "day"], how="left")
    # Days since this pitcher's previous appearance of any kind.
    apps = box[box["p_bf"].notna()][["player_id", "day"]].drop_duplicates()
    apps = apps.sort_values(["player_id", "day"])
    apps["prev"] = apps.groupby("player_id")["day"].shift(1)
    starts = starts.merge(apps, on=["player_id", "day"], how="left")
    rest = (starts["day"] - starts["prev"]).fillna(60.0)
    starts["rest"] = rest.clip(0, 15)
    starts["first_start"] = (rest > 30).astype(float)
    r = asof(starts.rename(columns={"player_id": "pitcher_id"}), pit_rating,
             "pitcher_id", "pitcher_id", [f"r_{c}" for c in range(NC)])
    L = asof(starts.assign(_all=0), league.assign(_all=0), "_all", "_all",
             [f"L_{c}" for c in range(NC)])
    # Out-getting ability relative to the league: better pitchers go deeper.
    starts["quality"] = (np.nan_to_num(r[:, 0] + r[:, 6], nan=0.68)
                         - (L[:, 0] + L[:, 6]))
    starts["own_mean"] = starts["p_outs_mean"]
    starts["team_leash"] = starts["team_outs_mean"]
    starts["pitches_mean"] = starts["p_pitches_mean"]
    return starts


def fit_workload(starts: pd.DataFrame, target: str) -> dict:
    """Linear location model + empirical integer residual pmf."""
    from sklearn.linear_model import LinearRegression

    X = starts[list(WORKLOAD_FEATURES)].to_numpy(float)
    y = starts[target].to_numpy(float)
    ok = np.isfinite(X).all(axis=1) & np.isfinite(y)
    reg = LinearRegression().fit(X[ok], y[ok])
    mu = reg.predict(X[ok])
    res = np.round(y[ok] - mu).astype(int)
    vals, cnt = np.unique(res, return_counts=True)
    pmf = {int(v): round(float(c) / cnt.sum(), 6) for v, c in zip(vals, cnt)}
    return {"features": list(WORKLOAD_FEATURES),
            "coef": [round(float(v), 6) for v in reg.coef_],
            "intercept": round(float(reg.intercept_), 6),
            "residual_pmf": pmf}


def workload_mu(model: dict, starts: pd.DataFrame) -> np.ndarray:
    X = starts[model["features"]].to_numpy(float)
    X = np.nan_to_num(X, nan=0.0)
    return X @ np.asarray(model["coef"]) + model["intercept"]


def workload_pmf(model: dict, mu: float, hi: int) -> np.ndarray:
    return D.shift_pmf(mu, model["residual_pmf"], 0, hi)


# ── PA count by slot ────────────────────────────────────────────────────────

def fit_pa_pmf(bat: pd.DataFrame) -> dict:
    """P(PA = k | slot, home) for starters, k = 0..MAX_PA."""
    out = {}
    for (slot, home), g in bat.groupby(["slot", "is_home"]):
        cnt = np.bincount(np.clip(g["pa"].fillna(0).astype(int), 0, D.MAX_PA),
                          minlength=D.MAX_PA + 1).astype(float)
        out[f"{int(slot)}{'H' if home else 'A'}"] = [
            round(float(v), 6) for v in cnt / cnt.sum()]
    return out


# ── PA predictions in bulk ──────────────────────────────────────────────────

def pa_probs(params: dict, rb, rp, pk, L, same, left, home, rel, tto) -> np.ndarray:  # noqa: ANN001
    X = P.pa_features(rb, rp, pk, L, same, left, home, rel, tto)
    return P.predict(params, X)


def batch_vs_starter(slot: np.ndarray, bf_pmf: np.ndarray) -> np.ndarray:
    """(n, MAX_PA) P(PA i vs starter) for each row's slot and BF pmf."""
    sf = np.cumsum(bf_pmf[:, ::-1], axis=1)[:, ::-1]           # P(BF >= b)
    sf = np.concatenate([sf, np.zeros((len(sf), 1))], axis=1)
    idx = slot[:, None] + 9 * np.arange(D.MAX_PA)[None, :]
    idx = np.minimum(idx, sf.shape[1] - 1)
    return np.take_along_axis(sf, idx, axis=1)


def batch_structural(dists: np.ndarray, pa_pmf: np.ndarray) -> dict:
    """Vectorised derive.batter_structural over rows. dists (n, MAX_PA, 7)."""
    n = len(dists)
    hit = dists[:, :, 2:6].sum(axis=2)
    hr = dists[:, :, 5]
    surv = np.cumsum(pa_pmf[:, ::-1], axis=1)[:, ::-1][:, 1:]    # P(N >= i)

    def at_least_one(e):
        none = np.concatenate([np.ones((n, 1)), np.cumprod(1 - e, axis=1)], axis=1)
        return (pa_pmf * (1 - none)).sum(axis=1)

    state = np.zeros((n, 3))
    state[:, 0] = 1.0
    tb2 = np.zeros(n)
    tb_of = D.TB_OF.astype(int)
    for i in range(1, pa_pmf.shape[1]):
        d = dists[:, i - 1]
        nxt = np.zeros((n, 3))
        for have in range(3):
            for c in range(7):
                nxt[:, min(2, have + tb_of[c])] += state[:, have] * d[:, c]
        state = nxt
        tb2 += pa_pmf[:, i] * state[:, 2]
    onb = 1 - dists[:, :, 0] - dists[:, :, 6]
    return {
        "hit": at_least_one(hit), "hr": at_least_one(hr), "tb2": tb2,
        "e_hits": (surv * hit).sum(axis=1),
        "e_onbase": (surv * onb).sum(axis=1),
        "e_value": (surv * (dists @ RUN_WEIGHTS)).sum(axis=1),
        "e_pa": (pa_pmf * np.arange(pa_pmf.shape[1])).sum(axis=1),
    }


# ── calibrators ─────────────────────────────────────────────────────────────

def fit_calibrator(p: np.ndarray, y: np.ndarray,
                   extra: dict[str, np.ndarray] | None = None) -> dict:
    """Logistic recalibration: y ~ a + b logit(p) + sum w_j x_j."""
    from sklearn.linear_model import LogisticRegression

    z = P.logit(np.asarray(p, float))
    cols = [z] + [np.asarray(v, float) for v in (extra or {}).values()]
    X = np.column_stack(cols)
    clf = LogisticRegression(C=100.0, max_iter=1000).fit(X, y.astype(int))
    out = {"a": round(float(clf.intercept_[0]), 6),
           "b": round(float(clf.coef_[0][0]), 6)}
    if extra:
        out["w"] = {k: round(float(c), 6)
                    for k, c in zip(extra.keys(), clf.coef_[0][1:])}
    return out


def apply_calibrator(cal: dict, p: np.ndarray,
                     extra: dict[str, np.ndarray] | None = None) -> np.ndarray:
    z = cal["a"] + cal["b"] * P.logit(np.asarray(p, float))
    for k, w in (cal.get("w") or {}).items():
        z = z + w * np.asarray((extra or {}).get(k, 0.0), float)
    return 1 / (1 + np.exp(-z))


def binary_metrics(p: np.ndarray, y: np.ndarray) -> dict:
    p = np.clip(p, 1e-6, 1 - 1e-6)
    y = y.astype(float)
    return {"n": int(len(y)),
            "logloss": round(float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p))), 6),
            "brier": round(float(np.mean((p - y) ** 2)), 6),
            "calibration": round(float(p.mean() / max(y.mean(), 1e-9)), 4),
            "accuracy": round(float(np.mean((p >= 0.5) == (y == 1))), 4),
            "base_rate": round(float(y.mean()), 4)}


def time_t() -> float:
    return time.time()
