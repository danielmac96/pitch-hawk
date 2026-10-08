"""Train and validate every player and game market, walk-forward, end to end.

    python -m modeling markets [--record]

One pass, because every market stacks on the same pieces:

  1. PA outcome model, walk-forward (pa_model) -> per-season OOS params
  2. game-level frames from player_box: batter-games, starts, team-games
  3. for each test season S in 2018..2026:
       fit workload, PA-count, run and calibration models on seasons < S,
       score season S with the PA params that never saw S
  4. refit everything on all seasons for production

What is reported per market and fold, and why:

  batter_hit / hr / tb15 / hrr    log loss, Brier, calibration-in-the-large
      vs  "slot base rate"        P(event) for that lineup slot in training
          seasons -- what you would say knowing nothing about the players
  pitcher_k / bb / hits / outs / er   the same on P(over the model's line),
      plus MAE of the expected count vs the pitcher's own decayed average
  game_moneyline                  log loss vs a constant home rate and vs the
                                  production formula (log5 on season win%,
                                  home advantage 0.542)
  game_total                      log loss of P(over 8.5) and of the exact
                                  total vs a league-mean negative binomial

2020 is reported but excluded from aggregates, as everywhere in the workbench.
"""

from __future__ import annotations

import json
import time

import numpy as np
import pandas as pd

from modeling import derive as D
from modeling import games as G
from modeling import pa_model as P
from modeling import ratings as R

NC = R.NC
SEASONS = tuple(range(P.FIRST_TRAIN_SEASON, P.HOLDOUT + 1))
TEST_SEASONS = tuple(range(2018, P.HOLDOUT + 1))
BATTER_MARKETS = ("batter_hit", "batter_hr", "batter_tb15", "batter_hrr")
STARTER_MARKETS = ("pitcher_k", "pitcher_bb", "pitcher_hits", "pitcher_outs",
                   "pitcher_er")


def _log(msg: str) -> None:
    print(f"[markets] {msg}", flush=True)


# ── frames ──────────────────────────────────────────────────────────────────

def batter_frame(box: pd.DataFrame, starts: pd.DataFrame, T: dict,
                 bat_side: dict, pit_hand: dict) -> pd.DataFrame:
    bat = box[box["slot"].notna() & (box["pa"].fillna(0) >= 0)].copy()
    bat["slot"] = bat["slot"].astype(int)
    bat["opp_team"] = np.where(bat["is_home"], bat["away_team_id"],
                               bat["home_team_id"])
    sp = starts[["game_pk", "team_id", "player_id"]].rename(
        columns={"team_id": "opp_team", "player_id": "opp_sp"})
    bat = bat.merge(sp, on=["game_pk", "opp_team"], how="left")
    bat = bat[bat["opp_sp"].notna()].reset_index(drop=True)
    rcols = [f"r_{c}" for c in range(NC)]
    bat_r = G.asof(bat.rename(columns={"player_id": "batter_id"}), T["batter"],
                   "batter_id", "batter_id", rcols)
    sp_r = G.asof(bat.rename(columns={"opp_sp": "pitcher_id"}), T["pitcher"],
                  "pitcher_id", "pitcher_id", rcols)
    pen_r = G.asof(bat.rename(columns={"opp_team": "pit_team"}), T["pen"],
                   "pit_team", "pit_team", rcols)
    park = G.asof(bat, T["park"], "venue_id", "venue_id", rcols)
    L = G.asof(bat.assign(_all=0), T["league"].assign(_all=0), "_all", "_all",
               [f"L_{c}" for c in range(NC)])
    # A player with no rating row yet (debut) gets the league rate.
    for arr in (bat_r, sp_r, pen_r):
        bad = ~np.isfinite(arr).all(axis=1)
        arr[bad] = L[bad]
    park[~np.isfinite(park).all(axis=1)] = 1.0
    for name, arr in (("rb", bat_r), ("rs", sp_r), ("rpen", pen_r),
                      ("pk", park), ("L", L)):
        for c in range(NC):
            bat[f"{name}_{c}"] = arr[:, c]
    bat["bat_side"] = bat["player_id"].map(bat_side).fillna("R")
    bat["sp_hand"] = bat["opp_sp"].map(pit_hand).fillna("R")
    return bat


def _arr(df: pd.DataFrame, prefix: str) -> np.ndarray:
    return df[[f"{prefix}_{c}" for c in range(NC)]].to_numpy()


def batter_pa_probs(params: dict, bat: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
    """(n, 3, 7) vs the starter at tto 1..3 and (n, 7) vs the bullpen."""
    n = len(bat)
    bs = bat["bat_side"].to_numpy()
    sh = bat["sp_hand"].to_numpy()
    same = ((bs == sh) & (bs != "S")).astype(float)
    left = (sh == "L").astype(float)
    home = bat["is_home"].astype(float).to_numpy()
    rb, rs, rpen, pk, L = (_arr(bat, p) for p in ("rb", "rs", "rpen", "pk", "L"))
    ps = np.stack([G.pa_probs(params, rb, rs, pk, L, same, left, home,
                              np.zeros(n), np.full(n, t)) for t in (1, 2, 3)],
                  axis=1)
    # Bullpen: handedness at its league mix. A switch hitter is never "same".
    pen_same = np.where(bs == "S", 0.0,
                        np.where(bs == "L", G.PEN_LEFT_SHARE, 1 - G.PEN_LEFT_SHARE))
    pp = G.pa_probs(params, rb, rpen, pk, L, pen_same,
                    np.full(n, G.PEN_LEFT_SHARE), home, np.ones(n), np.ones(n))
    return ps, pp


def batter_dists(ps: np.ndarray, pp: np.ndarray, slot: np.ndarray,
                 bf_pmf: np.ndarray) -> np.ndarray:
    q = G.batch_vs_starter(slot, bf_pmf)                      # (n, MAX_PA)
    tto = np.minimum(np.arange(D.MAX_PA), 2)                   # PA i -> tto idx
    vs_sp = ps[:, tto, :]                                      # (n, MAX_PA, 7)
    return q[:, :, None] * vs_sp + (1 - q)[:, :, None] * pp[:, None, :]


# ── the run ─────────────────────────────────────────────────────────────────

def season_params(s: int, holdout_params: dict) -> dict:
    if s >= P.HOLDOUT:
        return holdout_params
    return P.FOLD_PARAMS[max(s, min(P.FOLD_PARAMS))]


def run(store, *, record: bool = False, C: float = 1.0) -> dict:  # noqa: ANN001
    t0 = time.time()
    pa = P.load_pa(store)
    pa, configs = P.attach_ratings(pa, tune=True)
    T = dict(P.TABLES)
    X = P.design(pa)
    y = pa["y"].to_numpy(int)
    season = pa["season"].to_numpy(int)
    pa_folds = P.walk_forward(pa, X, C=C)
    pre = (season >= P.FIRST_TRAIN_SEASON) & (season < P.HOLDOUT)
    holdout_params = P.fit(X[pre], y[pre], C=C)
    pa_holdout = P.metrics(P.predict(holdout_params, X[season == P.HOLDOUT]),
                           y[season == P.HOLDOUT]) if (season == P.HOLDOUT).any() else None
    final_pa = P.fit(X[season >= P.FIRST_TRAIN_SEASON],
                     y[season >= P.FIRST_TRAIN_SEASON], C=C)
    final_pa["ratings"] = {k: (v.to_json() if hasattr(v, "to_json") else v)
                           for k, v in configs.items()}
    _log(f"PA model done in {time.time()-t0:.0f}s; holdout {pa_holdout}")
    bat_side, pit_hand = G.hands_from_pa(pa)
    G.PEN_LEFT_SHARE = G.measure_pen_left_share(pa)
    _log(f"bullpen left-handed PA share: {G.PEN_LEFT_SHARE}")
    del X

    box = G.load_box(store)
    box = box[box["season"].isin(SEASONS)].reset_index(drop=True)
    starts = G.workload_frame(box, T["pitcher"], T["league"])
    bat = batter_frame(box, starts, T, bat_side, pit_hand)
    _log(f"frames: {len(starts):,} starts, {len(bat):,} batter-games")

    # Per-season structural quantities, each from models that never saw it.
    bat_parts, st_parts = [], []
    workload_by_season = {}
    for s in SEASONS:
        cut = max(s, TEST_SEASONS[0])
        tr_st = starts[(starts["season"] < cut)]
        wl = {"outs": G.fit_workload(tr_st, "p_outs"),
              "bf": G.fit_workload(tr_st, "p_bf"),
              "pa_pmf": G.fit_pa_pmf(bat[bat["season"] < cut])}
        workload_by_season[s] = wl

        st = starts[starts["season"] == s].copy()
        st["mu_outs"] = G.workload_mu(wl["outs"], st)
        st["mu_bf"] = G.workload_mu(wl["bf"], st)
        bf_pmf = np.stack([G.workload_pmf(wl["bf"], m, D.MAX_BF)
                           for m in st["mu_bf"].to_numpy()]) if len(st) else \
            np.zeros((0, D.MAX_BF + 1))
        st_bf = dict(zip(zip(st["game_pk"], st["player_id"]), bf_pmf))

        b = bat[bat["season"] == s].copy()
        if not len(b):
            continue
        params = season_params(s, holdout_params)
        ps, pp = batter_pa_probs(params, b)
        bpmf = np.stack([st_bf.get((g, sp), np.eye(D.MAX_BF + 1)[22])
                         for g, sp in zip(b["game_pk"], b["opp_sp"])])
        dists = batter_dists(ps, pp, b["slot"].to_numpy(), bpmf)
        pa_pmf = np.stack([np.asarray(wl["pa_pmf"].get(
            f"{sl}{'H' if h else 'A'}", wl["pa_pmf"][f"{sl}H"]))
            for sl, h in zip(b["slot"], b["is_home"])])
        sv = G.batch_structural(dists, pa_pmf)
        for k, v in sv.items():
            b[f"s_{k}"] = v
        bat_parts.append(b.drop(columns=[c for c in b.columns
                                         if c[:3] in ("rb_", "rs_", "pk_")]))

        # Starters: the opposing lineup at tto 1..3 from the batter rows.
        lineup = b[["game_pk", "opp_sp"]].copy()
        lineup["idx"] = np.arange(len(b))
        st_parts.append(starter_structural(st, lineup, ps, wl))
        _log(f"season {s}: {len(b):,} batter-games, {len(st):,} starts scored")

    B = pd.concat(bat_parts, ignore_index=True)
    S_ = pd.concat(st_parts, ignore_index=True)
    team = team_frame(B, box)

    report = {"pa_outcome": {"folds": pa_folds, "oos": P.aggregate(pa_folds),
                             "holdout": pa_holdout}}
    final = {"pa_outcome": final_pa}
    report.update(batter_markets(B, final))
    report.update(starter_markets(S_, final))
    report.update(team_markets(team, final))

    wl_all = {"outs": G.fit_workload(starts, "p_outs"),
              "bf": G.fit_workload(starts, "p_bf"),
              "pa_pmf": G.fit_pa_pmf(bat),
              "pen_left_share": G.PEN_LEFT_SHARE,
              "workload_priors": G.WORKLOAD, "team_leash": G.TEAM_LEASH}
    final["workload"] = {"type": "workload", **wl_all}
    _log(f"done in {time.time()-t0:.0f}s")
    print(json.dumps({m: {k: v for k, v in r.items() if k != "folds"}
                      for m, r in report.items()}, indent=1, default=str))
    if record:
        _record(report, final)
    return {"report": report, "final": final}


# ── starters ────────────────────────────────────────────────────────────────

def starter_structural(st: pd.DataFrame, lineup: pd.DataFrame,
                       ps: np.ndarray, wl: dict) -> pd.DataFrame:
    """Per start: lineup-averaged per-PA dist, count pmfs and expectations."""
    by = {}
    for (g, sp), grp in lineup.groupby(["game_pk", "opp_sp"]):
        by[(g, int(sp))] = grp["idx"].to_numpy()
    rows = []
    for r in st.itertuples():
        idx = by.get((r.game_pk, int(r.player_id)))
        if idx is None or len(idx) < 9:
            continue
        outs_pmf = G.workload_pmf(wl["outs"], r.mu_outs, D.MAX_OUTS)
        bf_pmf = G.workload_pmf(wl["bf"], r.mu_bf, D.MAX_BF)
        bf = np.arange(len(bf_pmf))
        w = np.array([np.dot(bf_pmf, np.minimum(bf, 9)),
                      np.dot(bf_pmf, np.clip(bf - 9, 0, 9)),
                      np.dot(bf_pmf, np.maximum(bf - 18, 0))])
        w = w / max(w.sum(), 1e-9)
        p_avg = (ps[idx].mean(axis=0) * w[:, None]).sum(axis=0)
        cnt = D.starter_counts(p_avg, outs_pmf)
        rpo = float(p_avg @ G.RUN_WEIGHTS) / float(p_avg[0] + p_avg[6])
        rows.append({
            "game_pk": r.game_pk, "player_id": r.player_id, "season": r.season,
            "day": r.day, "k": r.p_k, "bb": r.p_bb, "h": r.p_h,
            "outs": r.p_outs, "er": r.p_er, "bf": r.p_bf,
            "pmf_k": cnt["k"], "pmf_bb": cnt["bb"], "pmf_h": cnt["h"],
            "pmf_outs": cnt["outs"],
            "e_outs": float(np.dot(np.arange(len(outs_pmf)), outs_pmf)),
            "rpo": rpo,
        })
    return pd.DataFrame(rows)


_STARTER_COUNT = {"pitcher_k": ("pmf_k", "k"), "pitcher_bb": ("pmf_bb", "bb"),
                  "pitcher_hits": ("pmf_h", "h"), "pitcher_outs": ("pmf_outs", "outs")}


def _er_glm(tr: pd.DataFrame) -> dict:
    from sklearn.linear_model import PoissonRegressor

    X = np.column_stack([np.log(np.maximum(tr["e_outs"], 1.0)),
                         np.log(np.maximum(tr["rpo"], 1e-3))])
    yv = tr["er"].to_numpy(float)
    reg = PoissonRegressor(alpha=0.0, max_iter=500).fit(X, yv)
    mu = reg.predict(X)
    alpha = float(np.clip(np.mean(((yv - mu) ** 2 - mu) / np.maximum(mu, 1e-6) ** 2), 0, 5))
    return {"coef": [round(float(v), 6) for v in reg.coef_],
            "intercept": round(float(reg.intercept_), 6), "alpha": round(alpha, 6),
            "features": ["log_e_outs", "log_runs_per_out"]}


def _er_pmf(m: dict, e_outs: float, rpo: float) -> np.ndarray:
    z = m["intercept"] + m["coef"][0] * np.log(max(e_outs, 1.0)) + \
        m["coef"][1] * np.log(max(rpo, 1e-3))
    return D.negbin_pmf(float(np.exp(z)), m["alpha"], 30)


def starter_markets(S_: pd.DataFrame, final: dict) -> dict:
    report = {}
    S_ = S_[S_["bf"].fillna(0) > 0].reset_index(drop=True)
    for mkt in STARTER_MARKETS:
        folds, structs = [], {}
        # Structural P(over line) at the model's own median line.
        if mkt == "pitcher_er":
            pmfs = None
        else:
            col, lab = _STARTER_COUNT[mkt]
            pmfs = S_[col].to_list()
        for s in TEST_SEASONS:
            tr = S_[S_["season"] < s]
            te = S_[S_["season"] == s]
            if not len(te):
                continue
            if mkt == "pitcher_er":
                glm = _er_glm(tr)
                pm_tr = [_er_pmf(glm, a, b) for a, b in zip(tr["e_outs"], tr["rpo"])]
                pm_te = [_er_pmf(glm, a, b) for a, b in zip(te["e_outs"], te["rpo"])]
                lab = "er"
            else:
                pm_tr = [pmfs[i] for i in tr.index]
                pm_te = [pmfs[i] for i in te.index]
            lines_tr = np.array([D.median_line(p) for p in pm_tr])
            p_tr = np.array([D.over_prob(p, l) for p, l in zip(pm_tr, lines_tr)])
            y_tr = (tr[lab].to_numpy() > lines_tr).astype(int)
            cal = G.fit_calibrator(p_tr, y_tr)
            lines = np.array([D.median_line(p) for p in pm_te])
            p_te = np.array([D.over_prob(p, l) for p, l in zip(pm_te, lines)])
            y_te = (te[lab].to_numpy() > lines).astype(int)
            pc = G.apply_calibrator(cal, p_te)
            ev = np.array([np.dot(np.arange(len(p)), p) for p in pm_te])
            m = G.binary_metrics(pc, y_te)
            m["uncalibrated_logloss"] = G.binary_metrics(p_te, y_te)["logloss"]
            m["mae_expected"] = round(float(np.mean(np.abs(ev - te[lab].to_numpy()))), 4)
            m["mae_train_mean"] = round(float(np.mean(np.abs(tr[lab].mean() - te[lab].to_numpy()))), 4)
            m["season"] = s
            folds.append(m)
            _log(f"{mkt} {s}: {m}")
        report[mkt] = {"folds": folds, "oos": _agg(folds)}
        if mkt == "pitcher_er":
            glm = _er_glm(S_)
            pm = [_er_pmf(glm, a, b) for a, b in zip(S_["e_outs"], S_["rpo"])]
        else:
            pm = pmfs
            glm = None
        lines = np.array([D.median_line(p) for p in pm])
        pv = np.array([D.over_prob(p, l) for p, l in zip(pm, lines)])
        yv = (S_[lab].to_numpy() > lines).astype(int)
        final[mkt] = {"type": "starter_count", "stat": lab,
                      "cal": G.fit_calibrator(pv, yv)}
        if glm:
            final[mkt]["er_glm"] = glm
    return report


# ── batters ─────────────────────────────────────────────────────────────────

_BATTER = {
    "batter_hit": ("s_hit", lambda b: b["h"] >= 1),
    "batter_hr": ("s_hr", lambda b: b["hr"] >= 1),
    "batter_tb15": ("s_tb2", lambda b: b["tb"] >= 2),
    "batter_hrr": ("s_hit", lambda b: (b["h"] + b["r"] + b["rbi"]) >= 1),
}


def _extra(mkt: str, b: pd.DataFrame) -> dict | None:
    """Extra calibrator inputs. H+R+RBI needs more than P(hit): getting on
    base and batting in a run-scoring spot both create runs and RBIs."""
    if mkt != "batter_hrr":
        return None
    return {"e_onbase": b["s_e_onbase"].to_numpy(),
            "top_order": (b["slot"] <= 5).astype(float).to_numpy(),
            "log_team_value": np.log(np.maximum(b["team_value"].to_numpy(), 1e-3))}


def batter_markets(B: pd.DataFrame, final: dict) -> dict:
    B = B[B["pa"].fillna(0) > 0].reset_index(drop=True)
    tv = B.groupby(["game_pk", "team_id"])["s_e_value"].transform("sum")
    B["team_value"] = tv
    report = {}
    for mkt, (col, label) in _BATTER.items():
        y = label(B).to_numpy().astype(int)
        folds = []
        for s in TEST_SEASONS:
            tr = (B["season"] < s).to_numpy()
            te = (B["season"] == s).to_numpy()
            if not te.any():
                continue
            ex_tr = _extra(mkt, B[tr])
            cal = G.fit_calibrator(B.loc[tr, col].to_numpy(), y[tr], ex_tr)
            pc = G.apply_calibrator(cal, B.loc[te, col].to_numpy(), _extra(mkt, B[te]))
            m = G.binary_metrics(pc, y[te])
            m["uncalibrated_logloss"] = G.binary_metrics(B.loc[te, col].to_numpy(), y[te])["logloss"]
            m["uncalibrated_calibration"] = G.binary_metrics(B.loc[te, col].to_numpy(), y[te])["calibration"]
            # Naive baseline: the training-season rate for this lineup slot.
            rate = pd.Series(y[tr]).groupby(B.loc[tr, "slot"].to_numpy()).mean()
            base = B.loc[te, "slot"].map(rate).fillna(y[tr].mean()).to_numpy()
            m["slot_baseline_logloss"] = G.binary_metrics(base, y[te])["logloss"]
            m["season"] = s
            folds.append(m)
            _log(f"{mkt} {s}: {m}")
        report[mkt] = {"folds": folds, "oos": _agg(folds)}
        final[mkt] = {"type": "batter_game", "event": col[2:],
                      "cal": G.fit_calibrator(B[col].to_numpy(), y, _extra(mkt, B))}
    return report


# ── teams / games ───────────────────────────────────────────────────────────

def team_frame(B: pd.DataFrame, box: pd.DataFrame) -> pd.DataFrame:
    t = B.groupby(["game_pk", "team_id", "is_home", "season", "day"],
                  as_index=False).agg(value=("s_e_value", "sum"),
                                      n=("slot", "count"))
    t = t[t["n"] == 9]
    g = box.drop_duplicates("game_pk")[[
        "game_pk", "home_score", "away_score", "temp_f", "wind_mph",
        "wind_direction", "weather_condition", "home_team_id", "away_team_id"]]
    t = t.merge(g, on="game_pk", how="left")
    t["runs"] = np.where(t["is_home"], t["home_score"], t["away_score"])
    closed = t["weather_condition"].map(G.roof_closed)
    t["temp_c"] = [G.temp_c(a, c) for a, c in zip(t["temp_f"], closed)]
    t["wind_out"] = [G.wind_out(m, d, c) for m, d, c in
                     zip(t["wind_mph"], t["wind_direction"], closed)]
    return t.dropna(subset=["runs"]).reset_index(drop=True)


TEAM_FEATURES = ("log_value", "home", "temp_c", "wind_out")


def _team_X(t: pd.DataFrame) -> np.ndarray:
    return np.column_stack([np.log(np.maximum(t["value"].to_numpy(), 1e-3)),
                            t["is_home"].astype(float).to_numpy(),
                            t["temp_c"].to_numpy(float),
                            t["wind_out"].to_numpy(float)])


def _team_glm(tr: pd.DataFrame) -> dict:
    from sklearn.linear_model import PoissonRegressor

    X = _team_X(tr)
    yv = tr["runs"].to_numpy(float)
    reg = PoissonRegressor(alpha=0.0, max_iter=500).fit(X, yv)
    mu = reg.predict(X)
    alpha = float(np.clip(np.mean(((yv - mu) ** 2 - mu) / mu ** 2), 0, 5))
    return {"type": "team_runs", "features": list(TEAM_FEATURES),
            "coef": [round(float(v), 6) for v in reg.coef_],
            "intercept": round(float(reg.intercept_), 6),
            "alpha": round(alpha, 6), "extra_home": 0.52}


def _team_mu(m: dict, t: pd.DataFrame) -> np.ndarray:
    return np.exp(_team_X(t) @ np.asarray(m["coef"]) + m["intercept"])


def _games(t: pd.DataFrame, mu: np.ndarray) -> pd.DataFrame:
    t = t.assign(mu=mu)
    h = t[t["is_home"]].set_index("game_pk")
    a = t[~t["is_home"]].set_index("game_pk")
    g = h[["season", "day", "runs", "mu", "home_team_id", "away_team_id"]].join(
        a[["runs", "mu"]], rsuffix="_away", how="inner")
    return g.rename(columns={"runs": "runs_home", "mu": "mu_home"}).reset_index()


def _log5_baseline(g: pd.DataFrame) -> np.ndarray:
    """Production's pregame moneyline: log5 on season-to-date win% (as of the
    morning), home advantage 0.542, clipped to [0.05, 0.95].

    Records are updated only after a whole day is scored, so a same-day
    result never leaks into another game's baseline.
    """
    adv = 0.542 / 0.458
    rec: dict = {}
    res: dict = {}
    for _, grp in g.sort_values("day").groupby("day"):
        for r in grp.itertuples():
            wh, nh = rec.get((r.season, r.home_team_id), (0, 0))
            wa, na = rec.get((r.season, r.away_team_id), (0, 0))
            h = wh / nh if nh else 0.5
            a = wa / na if na else 0.5
            raw = (h * (1 - a)) / ((h * (1 - a) + (1 - h) * a) or 1e-9)
            p = raw * adv / (raw * adv + 1 - raw)
            res[r.game_pk] = min(0.95, max(0.05, p))
        for r in grp.itertuples():
            hw = int(r.runs_home > r.runs_away)
            wh, nh = rec.get((r.season, r.home_team_id), (0, 0))
            wa, na = rec.get((r.season, r.away_team_id), (0, 0))
            rec[(r.season, r.home_team_id)] = (wh + hw, nh + 1)
            rec[(r.season, r.away_team_id)] = (wa + 1 - hw, na + 1)
    return np.array([res[k] for k in g["game_pk"]])


def team_markets(t: pd.DataFrame, final: dict) -> dict:
    ml_folds, tot_folds = [], []
    for s in TEST_SEASONS:
        tr = t[t["season"] < s]
        te = t[t["season"] == s]
        if not len(te):
            continue
        m = _team_glm(tr)
        g_tr = _games(tr, _team_mu(m, tr))
        g_te = _games(te, _team_mu(m, te))

        def win_p(g):
            return np.array([D.home_win_prob(D.negbin_pmf(a, m["alpha"], 30),
                                             D.negbin_pmf(b, m["alpha"], 30),
                                             m["extra_home"])
                             for a, b in zip(g["mu_home"], g["mu_away"])])
        y_tr = (g_tr["runs_home"] > g_tr["runs_away"]).astype(int).to_numpy()
        y_te = (g_te["runs_home"] > g_te["runs_away"]).astype(int).to_numpy()
        cal = G.fit_calibrator(win_p(g_tr), y_tr)
        p_te = G.apply_calibrator(cal, win_p(g_te))
        mm = G.binary_metrics(p_te, y_te)
        mm["home_rate_baseline_logloss"] = G.binary_metrics(
            np.full(len(y_te), y_tr.mean()), y_te)["logloss"]
        mm["production_log5_logloss"] = G.binary_metrics(
            _log5_baseline(g_te), y_te)["logloss"]
        mm["season"] = s
        ml_folds.append(mm)
        _log(f"game_moneyline {s}: {mm}")

        tot = [D.convolve_total(D.negbin_pmf(a, m["alpha"], 30),
                                D.negbin_pmf(b, m["alpha"], 30))
               for a, b in zip(g_te["mu_home"], g_te["mu_away"])]
        actual = (g_te["runs_home"] + g_te["runs_away"]).to_numpy().astype(int)
        p85 = np.array([D.over_prob(p, 8.5) for p in tot])
        lg_mu = float(tr["runs"].mean())
        lg = D.convolve_total(D.negbin_pmf(lg_mu, m["alpha"], 30),
                              D.negbin_pmf(lg_mu, m["alpha"], 30))
        tm = G.binary_metrics(p85, (actual > 8.5).astype(int))
        tm["league_over85_logloss"] = G.binary_metrics(
            np.full(len(actual), D.over_prob(lg, 8.5)), (actual > 8.5).astype(int))["logloss"]
        tm["exact_total_nll"] = round(float(-np.mean(np.log(np.clip(
            [p[min(a, len(p) - 1)] for p, a in zip(tot, actual)], 1e-9, 1)))), 5)
        tm["league_exact_total_nll"] = round(float(-np.mean(np.log(np.clip(
            lg[np.minimum(actual, len(lg) - 1)], 1e-9, 1)))), 5)
        tm["mae_mean"] = round(float(np.mean(np.abs(
            g_te["mu_home"] + g_te["mu_away"] - actual))), 4)
        tm["season"] = s
        tot_folds.append(tm)
        _log(f"game_total {s}: {tm}")
    m = _team_glm(t)
    g = _games(t, _team_mu(m, t))
    wp = np.array([D.home_win_prob(D.negbin_pmf(a, m["alpha"], 30),
                                   D.negbin_pmf(b, m["alpha"], 30), m["extra_home"])
                   for a, b in zip(g["mu_home"], g["mu_away"])])
    final["team_runs"] = m
    final["game_moneyline"] = {"type": "moneyline_v3", "cal": G.fit_calibrator(
        wp, (g["runs_home"] > g["runs_away"]).astype(int).to_numpy())}
    final["game_total"] = {"type": "total_v3"}
    return {"game_moneyline": {"folds": ml_folds, "oos": _agg(ml_folds)},
            "game_total": {"folds": tot_folds, "oos": _agg(tot_folds)}}


# ── aggregation and recording ───────────────────────────────────────────────

def _agg(folds: list[dict]) -> dict:
    used = [f for f in folds if f["season"] not in (2020, P.HOLDOUT)]
    if not used:
        return {}
    w = np.array([f["n"] for f in used], float)
    keys = [k for k, v in used[0].items()
            if k not in ("n", "season") and isinstance(v, (int, float))]
    out = {k: round(float(np.average([f[k] for f in used], weights=w)), 6)
           for k in keys}
    out["folds_used"] = len(used)
    hold = [f for f in folds if f["season"] == P.HOLDOUT]
    if hold:
        out["holdout_2026"] = {k: v for k, v in hold[0].items() if k != "season"}
    return out


def _record(report: dict, final: dict) -> None:
    from modeling import runs as runs_mod

    for mkt, params in final.items():
        r = report.get(mkt, {})
        run = {
            "run_id": runs_mod.new_run_id(), "market": mkt,
            "spec_hash": "v3_" + str(params.get("type")),
            "git_sha": runs_mod.git_sha(),
            "data_through": f"{P.HOLDOUT}-12-31",
            "train_seasons": list(SEASONS),
            "config": {"family": params.get("type"), "pipeline": "markets_v3"},
            "folds": r.get("folds", []), "oos_metrics": r.get("oos", {}),
            "holdout_metrics": (r.get("oos") or {}).get("holdout_2026")
            or r.get("holdout"),
            "calibration": None, "params": params, "version": None,
            "status": "completed", "notes": "lab run: markets v3 pipeline",
        }
        runs_mod.record(json.loads(json.dumps(run, default=_jsonable)))


def _jsonable(o):  # noqa: ANN001
    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, (np.floating, np.integer)):
        return o.item()
    if hasattr(o, "to_json"):
        return o.to_json()
    return str(o)
