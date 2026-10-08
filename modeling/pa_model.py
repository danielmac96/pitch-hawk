"""The plate-appearance outcome model -- the core every player market derives from.

    P(K, BB, 1B, 2B, 3B, HR, OUT | batter, pitcher, park, context)

One multinomial logistic regression over seven classes. Hits, home runs, total
bases, H+R+RBI, a starter's strikeouts/walks/hits/outs and the rest-of-game
markets are all questions about how these seven outcomes are distributed over
a game, so they are answered by rolling THIS distribution up (modeling/derive.py
and supabase/functions/_shared/props.ts) rather than by six unrelated formulas
that each made their own assumptions.

FEATURES (pa_features below; mirrored exactly in _shared/props.ts):

  for each class c:
    bat_c   = logit(batter rating_c)  - logit(league_c)
    pit_c   = logit(pitcher rating_c) - logit(league_c)
    park_c  = log(park factor_c)
  for each class c except OUT:
    l5_c    = log(p5_c / p5_OUT), p5 = log5(batter, pitcher, league)
  context:
    same_hand   batter and pitcher throw/bat from the same side (switch -> 0)
    pit_left    left-handed pitcher
    bat_home    the batting team is at home
    reliever    the pitcher did not start the game
    tto2, tto3  second / third-or-later time through the order

With a coefficient of 1 on l5_c and 0 elsewhere this IS the classic log5
odds-ratio matchup formula; bat_c / pit_c let the data say where log5 is wrong
(it over-credits extreme pitchers against extreme hitters, and the classes
interact: a high-strikeout hitter puts fewer balls in play to be outs).

WHY l5_c AND NOT logit(league_c). The first real-data run (2026-10-08) used
seven raw league-logit features. League rates take roughly one value per
season, so those columns fitted season effects: coefficients up to +/-13,
L-BFGS at its iteration cap, home-run calibration swinging 0.99-1.06 between
folds and 0.93 on the 2026 holdout. The log5 logit carries the league level
inside a fixed structure (rb*rp/L), so the model no longer has a free knob per
season to over-fit with.

Ratings are as-of the game day, exclusive (modeling/ratings.py), so a training
row sees what production would have read that morning.
"""

from __future__ import annotations

import json
import time

import numpy as np
import pandas as pd

from modeling import ratings as R

CLASSES = R.CLASSES
NC = R.NC

CONTEXT = ("same_hand", "pit_left", "bat_home", "reliever", "tto2", "tto3")
FEATURES: tuple[str, ...] = tuple(
    [f"bat_{c}" for c in CLASSES] + [f"pit_{c}" for c in CLASSES]
    + [f"park_{c}" for c in CLASSES] + [f"l5_{c}" for c in CLASSES[:-1]]
    + list(CONTEXT))

# Seasons. 2015 is burn-in only: a rating needs history, and the warehouse
# starts on 2015-04-05, so every 2015 rating is mostly prior.
FIRST_TRAIN_SEASON = 2016
WALK_FORWARD = tuple(range(2018, 2026))
HOLDOUT = 2026
EXCLUDE_FROM_AGG = (2020,)

# Park factors move slowly (dimensions, humidors) and are estimated from few
# PAs per class per venue, so their decay is long and fixed rather than tuned.
PARK_TAU = 1095.0
PARK_K_GRID = (200.0, 800.0, 3200.0, 12800.0)


def logit(p: np.ndarray) -> np.ndarray:
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


# ── data ────────────────────────────────────────────────────────────────────

PA_SQL = """
select a.game_pk, a.at_bat_index, a.game_date, a.inning, a.top_inning,
       a.batter_id, a.pitcher_id, a.bat_side, a.pitch_hand,
       a.times_through_order as tto, a.result_detail, a.rbi,
       a.home_score, a.away_score, a.men_on_base,
       g.season, g.venue_id, g.home_team_id, g.away_team_id,
       coalesce(b.p_started, false) as pit_started
from at_bats a
join games g using (game_pk)
left join player_box b
  on b.game_pk = a.game_pk and b.player_id = a.pitcher_id
where a.batter_id is not null and a.pitcher_id is not null
  and coalesce(g.game_type, 'R') = 'R'
"""


def load_pa(store, seasons=None) -> pd.DataFrame:  # noqa: ANN001
    """Every regular-season plate appearance with its class label and keys."""
    from warehouse import duck

    con = duck.connect(store)
    duck.register(con, store, names=("at_bats", "games", "player_box"),
                  seasons=seasons)
    t0 = time.time()
    df = con.execute(PA_SQL).df()
    df["y"] = R.classify(df["result_detail"])
    df = df[df["y"].notna()].copy()
    df["y"] = df["y"].astype(int)
    df["day"] = R.day_index(df["game_date"])
    df["pit_team"] = np.where(df["top_inning"], df["home_team_id"],
                              df["away_team_id"])
    df["bat_home"] = (~df["top_inning"].astype(bool)).astype(float)
    df = df.sort_values(["day", "game_pk", "at_bat_index"]).reset_index(drop=True)
    print(f"[pa] loaded {len(df):,} plate appearances in {time.time()-t0:.0f}s",
          flush=True)
    return df


# ── ratings attached to every PA ────────────────────────────────────────────

def _attach(pa: pd.DataFrame, rat: pd.DataFrame, key: str, prefix: str) -> np.ndarray:
    j = pa[[key, "day"]].merge(rat, on=[key, "day"], how="left")
    return j[[f"r_{c}" for c in range(NC)]].to_numpy()


def log5(rb: np.ndarray, rp: np.ndarray, L: np.ndarray) -> np.ndarray:
    """Odds-ratio matchup: p_c proportional to rb_c * rp_c / L_c."""
    m = rb * rp / L
    return m / m.sum(axis=1, keepdims=True)


def park_asof(pa: pd.DataFrame, expected: np.ndarray, k: float,
              tau: float = PARK_TAU) -> pd.DataFrame:
    """Park factor per class as of each (venue, day): (O_c + k)/(E_c + k).

    O is observed outcomes at the venue, E the outcomes the matchups there
    were EXPECTED to produce (log5 of the players' own ratings). Measuring
    against expectation rather than the league rate is what keeps a park from
    inheriting its home team's quality: a great-hitting home team inflates O
    and E together.
    """
    O = R.decayed_asof(pa, "venue_id", tau)
    E = R.decayed_asof(pa, "venue_id", tau, weights=expected)
    out = O[["venue_id", "day"]].copy()
    for c in range(NC):
        out[f"r_{c}"] = (O[f"S_{c}"].to_numpy() + k) / (E[f"S_{c}"].to_numpy() + k)
    return out


def attach_ratings(pa: pd.DataFrame, *, tune: bool = True,
                   configs: dict | None = None) -> tuple[pd.DataFrame, dict]:
    """Batter, pitcher, park and bullpen ratings for every PA.

    Returns (frame with rb_*, rp_*, pk_*, L_* columns, configs). With
    tune=False, `configs` must hold previously fitted RatingConfigs.
    """
    configs = dict(configs or {})
    league = R.league_asof(pa)
    L = pa[["day"]].merge(league, on="day", how="left")[
        [f"L_{c}" for c in range(NC)]].to_numpy()

    # Tune on 2017-2025: 2015-16 ratings are still warming up and 2026 is the
    # holdout, which nothing may be selected on.
    mask = ((pa["season"] >= 2017) & (pa["season"] < HOLDOUT)).to_numpy()
    for key, name in (("batter_id", "batter"), ("pitcher_id", "pitcher")):
        if tune:
            configs[name] = R.tune(pa, key, league, eval_mask=mask)
        cfg = configs[name]
        if isinstance(cfg, dict):
            cfg = configs[name] = R.RatingConfig.from_json(cfg)
        rat = R.ratings_asof(pa, key, league, cfg)
        arr = _attach(pa, rat, key, name)
        pa[[f"{name[0]}r_{c}" for c in range(NC)]] = arr
        pa[f"{name[0]}n"] = pa[[key, "day"]].merge(
            rat[[key, "day", "n_eff"]], on=[key, "day"], how="left")["n_eff"].to_numpy()

    rb = pa[[f"br_{c}" for c in range(NC)]].to_numpy()
    rp = pa[[f"pr_{c}" for c in range(NC)]].to_numpy()
    expected = log5(rb, rp, L)

    # Park: pick k by next-PA log loss of the park-adjusted log5 on the
    # tuning window. One k for all classes; the per-class O/E already scales.
    if tune:
        best = None
        y = pa["y"].to_numpy(int)
        for k in PARK_K_GRID:
            pk = park_asof(pa, expected, k)
            f = pa[["venue_id", "day"]].merge(pk, on=["venue_id", "day"],
                                               how="left")[
                [f"r_{c}" for c in range(NC)]].fillna(1.0).to_numpy()
            p = expected * f
            p = p / p.sum(axis=1, keepdims=True)
            ll = float(-np.mean(np.log(np.clip(p[mask, :][np.arange(mask.sum()), y[mask]], 1e-9, 1))))
            print(f"[ratings] park k={k:.0f} next-PA logloss {ll:.6f}", flush=True)
            if best is None or ll < best[0]:
                best = (ll, k)
        configs["park"] = {"tau": PARK_TAU, "k": best[1]}
    pk = park_asof(pa, expected, configs["park"]["k"], configs["park"]["tau"])
    pa[[f"pk_{c}" for c in range(NC)]] = pa[["venue_id", "day"]].merge(
        pk, on=["venue_id", "day"], how="left")[
        [f"r_{c}" for c in range(NC)]].fillna(1.0).to_numpy()
    pa[[f"L_{c}" for c in range(NC)]] = L
    configs["league_tau"] = 365.0
    # The tables themselves, keyed (id, day), for the game-level datasets
    # (modeling/games.py) that need a rating on days with no PA row to hang
    # it on -- a bullpen, a park, a starter's opponents.
    pen_cfg = configs.get("pen") or R.RatingConfig(
        tau=configs["pitcher"].tau, k=tuple(4 * v for v in configs["pitcher"].k))
    configs["pen"] = pen_cfg
    TABLES.clear()
    TABLES.update({
        "league": league,
        "batter": R.ratings_asof(pa, "batter_id", league, configs["batter"]),
        "pitcher": R.ratings_asof(pa, "pitcher_id", league, configs["pitcher"]),
        "park": pk,
        "pen": bullpen_asof(pa, league, pen_cfg),
    })
    return pa, configs


# Rating tables from the last attach_ratings() call. Module state rather than
# a third return value so existing callers keep their (pa, configs) shape.
TABLES: dict[str, pd.DataFrame] = {}


def bullpen_asof(pa: pd.DataFrame, league: pd.DataFrame,
                 cfg: R.RatingConfig) -> pd.DataFrame:
    """Team relief rating as of each (pitching team, day).

    Pregame we know the opposing starter but not which relievers will pitch,
    so every PA a batter is projected to take after the starter leaves is
    scored against this: the team's relievers pooled, decayed like a player.
    """
    rel = pa[~pa["pit_started"].astype(bool)].copy()
    return R.ratings_asof(rel, "pit_team", league, cfg)


# ── features ────────────────────────────────────────────────────────────────

def pa_features(rb: np.ndarray, rp: np.ndarray, pk: np.ndarray, L: np.ndarray,
                same_hand: np.ndarray, pit_left: np.ndarray,
                bat_home: np.ndarray, reliever: np.ndarray,
                tto: np.ndarray) -> np.ndarray:
    """The design matrix, column order = FEATURES. Mirrored in props.ts."""
    lL = logit(L)
    tto = np.nan_to_num(np.asarray(tto, float), nan=1.0)
    p5 = log5(np.clip(rb, 1e-6, 1), np.clip(rp, 1e-6, 1), np.clip(L, 1e-6, 1))
    l5 = np.log(p5[:, :-1]) - np.log(p5[:, -1:])
    return np.column_stack([
        logit(rb) - lL,
        logit(rp) - lL,
        np.log(np.clip(pk, 0.2, 5.0)),
        l5,
        same_hand, pit_left, bat_home, reliever,
        (tto == 2).astype(float), (tto >= 3).astype(float),
    ])


def context_columns(pa: pd.DataFrame) -> dict:
    bs = pa["bat_side"].fillna("R").to_numpy()
    ph = pa["pitch_hand"].fillna("R").to_numpy()
    # A switch hitter bats from the side opposite the pitcher, so he is never
    # "same hand". An unknown side reads as R, the majority, rather than
    # dropping the row.
    same = ((bs == ph) & (bs != "S")).astype(float)
    return {
        "same_hand": same,
        "pit_left": (ph == "L").astype(float),
        "bat_home": pa["bat_home"].to_numpy(float),
        "reliever": (~pa["pit_started"].astype(bool)).to_numpy(float),
        "tto": pa["tto"].to_numpy(float),
    }


def design(pa: pd.DataFrame) -> np.ndarray:
    g = lambda p: pa[[f"{p}_{c}" for c in range(NC)]].to_numpy()  # noqa: E731
    ctx = context_columns(pa)
    return pa_features(g("br"), g("pr"), g("pk"), g("L"), ctx["same_hand"],
                       ctx["pit_left"], ctx["bat_home"], ctx["reliever"],
                       ctx["tto"])


# ── fit / predict / evaluate ────────────────────────────────────────────────

def fit(X: np.ndarray, y: np.ndarray, *, C: float = 1.0) -> dict:
    """Multinomial logistic regression -> params JSON (type pa_multinomial)."""
    from sklearn.linear_model import LogisticRegression

    # Standardise for the optimiser, then map back. The league-logit columns
    # barely move (the league K rate drifts a few points over a decade) and
    # sit nearly collinear with the intercept; on the raw scale L-BFGS stalls.
    # The shipped coefficients are on the RAW scale, so the scorer in
    # props.ts needs no knowledge of this.
    mu = X.mean(axis=0)
    sd = X.std(axis=0)
    sd[sd < 1e-9] = 1.0
    clf = LogisticRegression(C=C, max_iter=3000, tol=1e-7)
    clf.fit((X - mu) / sd, y)
    coef = np.zeros((NC, X.shape[1]))
    icpt = np.zeros(NC)
    for i, cls in enumerate(clf.classes_):
        coef[int(cls)] = clf.coef_[i] / sd
        icpt[int(cls)] = clf.intercept_[i] - float(np.dot(clf.coef_[i], mu / sd))
    # Softmax is invariant to a shared shift; centre on OUT so coefficients
    # read as "relative to an out", which is how the docs describe them.
    coef -= coef[NC - 1]
    icpt -= icpt[NC - 1]
    return {
        "type": "pa_multinomial",
        "classes": list(CLASSES),
        "features": list(FEATURES),
        "coef": [[round(float(v), 6) for v in row] for row in coef],
        "intercept": [round(float(v), 6) for v in icpt],
        "C": C,
    }


def predict(params: dict, X: np.ndarray) -> np.ndarray:
    z = X @ np.asarray(params["coef"]).T + np.asarray(params["intercept"])
    z -= z.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=1, keepdims=True)


def metrics(p: np.ndarray, y: np.ndarray) -> dict:
    """Multiclass log loss plus the per-PA binaries the markets care about."""
    n = len(y)
    out = {"n": int(n),
           "logloss": float(-np.mean(np.log(np.clip(p[np.arange(n), y], 1e-12, 1))))}
    hit = p[:, 2:6].sum(axis=1)
    yh = np.isin(y, (2, 3, 4, 5)).astype(float)
    for name, q, t in (("hit", hit, yh), ("hr", p[:, 5], (y == 5).astype(float)),
                       ("k", p[:, 0], (y == 0).astype(float)),
                       ("bb", p[:, 1], (y == 1).astype(float))):
        qq = np.clip(q, 1e-9, 1 - 1e-9)
        out[f"{name}_logloss"] = float(-np.mean(t * np.log(qq) + (1 - t) * np.log(1 - qq)))
        out[f"{name}_calibration"] = float(q.mean() / max(t.mean(), 1e-9))
    return {k: (round(v, 6) if isinstance(v, float) else v) for k, v in out.items()}


# Params of each walk-forward fold, by test season. The game-level models
# (modeling/markets.py) stack on these so that every season's structural
# probabilities come from a PA model that never saw that season.
FOLD_PARAMS: dict[int, dict] = {}


def walk_forward(pa: pd.DataFrame, X: np.ndarray, *, C: float = 1.0) -> list[dict]:
    """Fold S trains on FIRST_TRAIN_SEASON..S-1, tests on S."""
    y = pa["y"].to_numpy(int)
    season = pa["season"].to_numpy(int)
    L = pa[[f"L_{c}" for c in range(NC)]].to_numpy()
    rb = pa[[f"br_{c}" for c in range(NC)]].to_numpy()
    rp = pa[[f"pr_{c}" for c in range(NC)]].to_numpy()
    folds = []
    for s in WALK_FORWARD:
        tr = (season >= FIRST_TRAIN_SEASON) & (season < s)
        te = season == s
        if not tr.any() or not te.any():
            continue
        t0 = time.time()
        params = fit(X[tr], y[tr], C=C)
        FOLD_PARAMS[s] = params
        m = metrics(predict(params, X[te]), y[te])
        m["league_only"] = metrics(L[te], y[te])["logloss"]
        m["log5"] = metrics(log5(rb[te], rp[te], L[te]), y[te])["logloss"]
        m["season"] = s
        folds.append(m)
        print(f"[pa] fold {s}: model {m['logloss']:.5f}  log5 {m['log5']:.5f}  "
              f"league {m['league_only']:.5f}  hit {m['hit_logloss']:.5f} "
              f"(cal {m['hit_calibration']:.3f})  hr {m['hr_logloss']:.5f} "
              f"(cal {m['hr_calibration']:.3f})  [{time.time()-t0:.0f}s]",
              flush=True)
    return folds


def aggregate(folds: list[dict]) -> dict:
    used = [f for f in folds if f["season"] not in EXCLUDE_FROM_AGG]
    w = np.array([f["n"] for f in used], float)
    keys = [k for k in used[0] if k not in ("n", "season")]
    out = {k: round(float(np.average([f[k] for f in used], weights=w)), 6)
           for k in keys}
    out["folds_used"] = len(used)
    out["n"] = int(w.sum())
    return out


def dumps(obj) -> str:  # noqa: ANN001
    return json.dumps(obj, default=lambda o: o.to_json() if hasattr(o, "to_json") else str(o))
