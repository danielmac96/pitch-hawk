"""Build every v4 frame: one row per prediction, outcome + features + v3.

    frames = build_player_frames(store)   # batter_game, start, game, rog,
                                          # live_total, pa_v3
    python -m modeling v4 frames          # the same, written to R2

The v3 pipeline (modeling/markets.py) runs first with keep_frames=True. Its
structural columns are out of sample for every test season (each season
scored by PA, workload and calibration models that never saw it), which is
what lets them enter a v4 model as stacked features and serve as the
incumbent without leaking. Caveat, recorded on the runs: for the two
training-only seasons 2016-2017 those components were fitted on seasons
< 2018, i.e. including the row's own season. Those rows are never scored.

Then the feature groups in modeling/v4/feats.py, each strictly prior-day.
"""

from __future__ import annotations

import time

import numpy as np
import pandas as pd

from modeling import derive as D
from modeling import games as G
from modeling import markets as MK
from modeling.v4 import catalog as C
from modeling.v4 import feats as F

NC = 7


def _log(msg: str) -> None:
    print(f"[v4] {msg}", flush=True)


def _pad(arrs, cap: int) -> np.ndarray:
    """List of pmfs -> (n, cap+1), the last bucket holding the tail."""
    out = np.zeros((len(arrs), cap + 1))
    for i, a in enumerate(arrs):
        a = np.asarray(a, float)
        k = min(len(a), cap)
        out[i, :k] = a[:k]
        out[i, cap] = max(0.0, 1.0 - out[i, :cap].sum())
    return out


def _context(fr: pd.DataFrame, box_games: pd.DataFrame, games: pd.DataFrame | None,
             T: dict) -> pd.DataFrame:
    """Park, weather, roof, day of season, night; per row via game_pk."""
    g = box_games.drop_duplicates("game_pk").set_index("game_pk")
    closed = g["weather_condition"].map(G.roof_closed)
    gctx = pd.DataFrame({
        "temp_c": [G.temp_c(a, c) for a, c in zip(g["temp_f"], closed)],
        "wind_out": [G.wind_out(m, d, c) for m, d, c in
                     zip(g["wind_mph"], g["wind_direction"], closed)],
        "roof_closed": closed.astype(float).to_numpy(),
        "venue_id": g["venue_id"].to_numpy(),
    }, index=g.index)
    if games is not None and "start_ts" in games:
        games = games.drop_duplicates("game_pk", keep="last")
        gctx["night"] = pd.Series(F.night_game(games["start_ts"]),
                                  index=games["game_pk"]).reindex(gctx.index).to_numpy()
        gctx["hp_umpire_id"] = games.set_index("game_pk")["hp_umpire_id"] \
            .reindex(gctx.index).to_numpy()
    out = gctx.reindex(fr["game_pk"].to_numpy()).reset_index(drop=True)
    out.index = fr.index
    pk = G.asof(fr.assign(venue_id=out["venue_id"].to_numpy()), T["park"], "venue_id",
                "venue_id", [f"r_{c}" for c in range(NC)])
    pk = np.where(np.isfinite(pk), pk, 1.0)
    out["park_hr"] = pk[:, 5]
    out["park_h"] = pk[:, 2:6].mean(axis=1)
    out["park_runs"] = (pk * G.RUN_WEIGHTS).sum(axis=1) / G.RUN_WEIGHTS.sum()
    out["day_of_season"] = F.day_of_season(fr)
    return out


# ── starts ──────────────────────────────────────────────────────────────────

def start_frame(Fr: dict, src: dict | None) -> pd.DataFrame:
    S = Fr["starts"]
    pend = S["pending"].astype(bool) if "pending" in S else False
    S = S[(S["bf"].fillna(0) > 0) | pend].reset_index(drop=True).copy()
    T, box, B, pa = Fr["tables"], Fr["box"], Fr["batter"], Fr["pa"]
    for stat in ("k", "bb", "h", "outs"):
        cap = C.get({"k": "pitcher_k", "bb": "pitcher_bb", "h": "pitcher_hits",
                     "outs": "pitcher_outs"}[stat]).cap
        pm = _pad(S[f"pmf_{stat}"].to_list(), cap)
        S[f"v3_e_{stat}"] = pm[:, :cap] @ np.arange(cap) + pm[:, cap] * cap
        for k in range(cap + 1):
            S[f"v3pmf_{stat}_{k}"] = pm[:, k]
    S = S.drop(columns=[c for c in S.columns if c.startswith("pmf_")])
    # v3's earned-run GLM, one fit per season on earlier seasons only.
    S["v3_e_er"] = np.nan
    for s in sorted(S["season"].unique()):
        cut = max(int(s), MK.TEST_SEASONS[0])
        tr = S[(S["season"] < cut) & _fit_rows(S)]
        if len(tr) < 50:
            continue
        glm = MK._er_glm(tr)
        m = S["season"] == s
        z = glm["intercept"] + glm["coef"][0] * np.log(np.maximum(S.loc[m, "e_outs"], 1.0)) \
            + glm["coef"][1] * np.log(np.maximum(S.loc[m, "rpo"], 1e-3))
        S.loc[m, "v3_e_er"] = np.exp(z)

    rs = G.asof(S.rename(columns={"player_id": "pitcher_id"}), T["pitcher"],
                "pitcher_id", "pitcher_id", [f"r_{c}" for c in range(NC)])
    for c in range(NC):
        S[f"rs_{c}"] = rs[:, c]
    _, pit_hand = G.hands_from_pa(pa)
    S["p_left"] = (S["player_id"].map(pit_hand) == "L").astype(float)
    S["opp_team"] = np.nan
    gm = box.drop_duplicates("game_pk").set_index("game_pk")
    S["opp_team"] = np.where(S["is_home"].astype(bool),
                             gm["away_team_id"].reindex(S["game_pk"]).to_numpy(),
                             gm["home_team_id"].reindex(S["game_pk"]).to_numpy())
    ctx = _context(S, box, src and src.get("games"), T)
    S = pd.concat([S, ctx.drop(columns=["venue_id"])], axis=1)
    S = pd.concat([S, F.starter_form(S, box)], axis=1)
    if src:
        S = pd.concat([S, F.pitcher_stuff(S, src["pitcher_day"], "player_id")], axis=1)
        if "hp_umpire_id" in S:
            S = pd.concat([S, F.umpire(S, src["ump_day"])], axis=1)
    # The lineup he faces, from the batter frame's own as-of ratings.
    lu = B.assign(
        _k=B["rb_0"], _bb=B["rb_1"], _h=B[[f"rb_{c}" for c in (2, 3, 4, 5)]].sum(axis=1),
        _iso=B["rb_3"] + 2 * B["rb_4"] + 3 * B["rb_5"],
        _l=(B["bat_side"] == "L").astype(float)
    ).groupby(["game_pk", "opp_sp"]).agg(
        opp_k_rate=("_k", "mean"), opp_bb_rate=("_bb", "mean"), opp_h_rate=("_h", "mean"),
        opp_iso=("_iso", "mean"), opp_value=("s_e_value", "sum"),
        opp_lhb_share=("_l", "mean")).reset_index().rename(columns={"opp_sp": "player_id"})
    S = S.merge(lu, on=["game_pk", "player_id"], how="left")
    pen = G.asof(S.rename(columns={"team_id": "pit_team"}), T["pen"], "pit_team",
                 "pit_team", [f"r_{c}" for c in range(NC)])
    S["pen_rating_k"] = pen[:, 0]
    S["pen_rating_out"] = pen[:, 0] + pen[:, 6]
    S["pen_ip_3d"] = F.bullpen_usage(S, box, "team_id").to_numpy()
    S["game_date"] = pd.Timestamp("2015-01-01") + pd.to_timedelta(S["day"], "D")
    # Two rows flagged as a team's starter in one game (an opener, a game
    # suspended and resumed): keep the one who faced the most batters, so a
    # start is one row and every join on (game, team) stays one-to-one.
    S = S.copy()
    S["_bf"] = S["bf"].fillna(-1)
    n0 = len(S)
    S = (S.sort_values("_bf").drop_duplicates(["game_pk", "team_id"], keep="last")
         .drop(columns="_bf").sort_values(["day", "game_pk"]).reset_index(drop=True))
    if len(S) < n0:
        _log(f"start frame: dropped {n0 - len(S):,} second starters")
    return S


# ── batter-games ────────────────────────────────────────────────────────────

def batter_frame(Fr: dict, src: dict | None, start: pd.DataFrame) -> pd.DataFrame:
    B = Fr["batter"]
    pend = B["pending"].astype(bool) if "pending" in B else False
    B = B[(B["pa"].fillna(0) > 0) | pend].reset_index(drop=True).copy()
    T, box, pa = Fr["tables"], Fr["box"], Fr["pa"]
    B = B.drop(columns=[c for c in B.columns if c.startswith(("c_", "L_"))])
    played = B["pa"].notna()
    # A pending row has no outcome yet: NULL, never 0 (0 would read as a miss).
    for col, val in (("y_hit", B["h"] >= 1), ("y_hr", B["hr"] >= 1),
                     ("y_tb2", B["tb"] >= 2),
                     ("y_hrr", (B["h"] + B["r"] + B["rbi"]) >= 1)):
        B[col] = val.astype(float).where(played)
    B["team_value"] = B.groupby(["game_pk", "team_id"])["s_e_value"].transform("sum")
    B["log_team_value"] = np.log(np.maximum(B["team_value"], 1e-3))
    B["top_order"] = (B["slot"] <= 5).astype(float)
    B["e_pa"] = B["s_e_pa"]
    bs, sh = B["bat_side"].to_numpy(), B["sp_hand"].to_numpy()
    B["same_hand"] = ((bs == sh) & (bs != "S")).astype(float)
    B["sp_left"] = (sh == "L").astype(float)
    B["bat_left"] = (bs == "L").astype(float)
    B["switch"] = (bs == "S").astype(float)
    # Protection: on-base rating of the two hitters behind him.
    B["_obp"] = 1 - B["rb_0"] - B["rb_6"]
    lk = B.set_index(["game_pk", "team_id", "slot"])["_obp"].to_dict()
    nxt = lambda d: np.array([lk.get((g, t, (s - 1 + d) % 9 + 1), np.nan)  # noqa: E731
                              for g, t, s in zip(B["game_pk"], B["team_id"], B["slot"])])
    B["lineup_obp_behind"] = np.nanmean(np.column_stack([nxt(1), nxt(2)]), axis=1)
    B = B.drop(columns=["_obp"])
    ctx = _context(B, box, src and src.get("games"), T)
    B = pd.concat([B, ctx.drop(columns=["venue_id"])], axis=1)
    B = B.drop(columns=[c for c in B.columns if c.startswith("pk_")])
    B = pd.concat([B, F.batter_form(B, box)], axis=1)
    if src:
        B = pd.concat([B, F.batter_discipline(B, src["batter_day"], "player_id")], axis=1)
        if "hp_umpire_id" in B:
            B = pd.concat([B, F.umpire(B, src["ump_day"])], axis=1)
    opp = start[["game_pk", "player_id"] + [c for c in (
        "ps_velo", "ps_whiff", "pf_k_s15", "pf_bb_s15", "pf_hr_s15", "mu_bf")
        if c in start]].rename(columns=lambda c: c if c in ("game_pk", "player_id")
                               else f"opp_sp_{c.replace('ps_', '').replace('pf_', '')}")
    B = B.merge(opp.rename(columns={"player_id": "opp_sp"}), on=["game_pk", "opp_sp"],
                how="left")
    B = pd.concat([B, F.head_to_head(B, pa, "player_id", "opp_sp")], axis=1)
    B["pen_rating_k"] = B["rpen_0"]
    B["pen_rating_out"] = B["rpen_0"] + B["rpen_6"]
    B["pen_ip_3d"] = F.bullpen_usage(B, box, "opp_team").to_numpy()
    n0 = len(B)
    B = B.drop_duplicates(["game_pk", "player_id"], keep="first").reset_index(drop=True)
    if len(B) < n0:
        _log(f"batter_game frame: dropped {n0 - len(B):,} duplicate batter-games")
    return B


# ── games ───────────────────────────────────────────────────────────────────

def _fit_rows(df: pd.DataFrame) -> pd.Series:
    """Rows a fit may see: regular season, already played."""
    ok = pd.Series(True, index=df.index)
    if "is_post" in df:
        ok &= ~df["is_post"].fillna(False).astype(bool)
    if "pending" in df:
        ok &= ~df["pending"].fillna(False).astype(bool)
    return ok


def team_table(B: pd.DataFrame, box: pd.DataFrame) -> pd.DataFrame:
    """markets.team_frame, but over every batter-game row -- postseason and
    pending included -- so those games get a v3 run mean too."""
    keys = ["game_pk", "team_id", "is_home", "season", "day"]
    agg = {"value": ("s_e_value", "sum"), "n": ("slot", "count")}
    for c in ("is_post", "pending"):
        if c in B:
            agg[c] = (c, "max")
    t = B.groupby(keys, as_index=False).agg(**agg)
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
    return t.reset_index(drop=True)


def game_frame(Fr: dict, src: dict | None, start: pd.DataFrame,
               batter: pd.DataFrame) -> pd.DataFrame:
    box, T = Fr["box"], Fr["tables"]
    team = team_table(batter, box)
    flags = team.groupby("game_pk")[[c for c in ("is_post", "pending") if c in team]].max()
    rows = []
    for s in sorted(team["season"].unique()):
        cut = max(int(s), MK.TEST_SEASONS[0])
        tr = team[(team["season"] < cut) & _fit_rows(team) & team["runs"].notna()]
        te = team[team["season"] == s]
        if len(tr) < 100 or not len(te):
            continue
        m = MK._team_glm(tr)
        g_tr, g_te = MK._games(tr, MK._team_mu(m, tr)), MK._games(te, MK._team_mu(m, te))

        def win_p(g):  # noqa: ANN001
            return np.array([D.home_win_prob(D.negbin_pmf(a, m["alpha"], 30),
                                             D.negbin_pmf(b, m["alpha"], 30), m["extra_home"])
                             for a, b in zip(g["mu_home"], g["mu_away"])])
        g_tr = g_tr.dropna(subset=["runs_home", "runs_away"])
        cal = G.fit_calibrator(win_p(g_tr), (g_tr["runs_home"] > g_tr["runs_away"])
                               .astype(int).to_numpy())
        g_te = g_te.assign(v3_p_home=G.apply_calibrator(cal, win_p(g_te)),
                           v3_alpha=m["alpha"])
        tot = np.stack([D.convolve_total(D.negbin_pmf(a, m["alpha"], 30),
                                         D.negbin_pmf(b, m["alpha"], 30))[:31]
                        for a, b in zip(g_te["mu_home"], g_te["mu_away"])])
        tot[:, 30] = np.clip(1 - tot[:, :30].sum(axis=1), 0, 1)
        for k in range(31):
            g_te[f"v3pmf_total_{k}"] = tot[:, k]
        rows.append(g_te)
    g = pd.concat(rows, ignore_index=True).rename(
        columns={"mu_home": "v3_mu_home", "mu_away": "v3_mu_away"})
    for c in flags.columns:
        g[c] = flags[c].reindex(g["game_pk"]).fillna(False).to_numpy()
    played = g["runs_home"].notna() & g["runs_away"].notna()
    g["y_home_win"] = (g["runs_home"] > g["runs_away"]).astype(float).where(played)
    g["total_runs"] = (g["runs_home"] + g["runs_away"]).where(played)
    tv = team.pivot_table(index="game_pk", columns="is_home", values="value")
    g["h_value"] = tv[True].reindex(g["game_pk"]).to_numpy()
    g["a_value"] = tv[False].reindex(g["game_pk"]).to_numpy()
    st = start.set_index(["game_pk", "is_home"])
    for side, home in (("h", True), ("a", False)):
        idx = list(zip(g["game_pk"], [home] * len(g)))
        sub = st.reindex(idx)
        for src_c, dst in (("quality", "sp_quality"), ("pf_k_s15", "sp_k_s15"),
                           ("pf_er_s15", "sp_era_s15"), ("mu_outs", "sp_mu_outs"),
                           ("pen_rating_out", "pen_rating_out"),
                           ("pen_ip_3d", "pen_ip_3d")):
            g[f"{side}_{dst}"] = sub[src_c].to_numpy() if src_c in sub else np.nan
        tid = g["home_team_id"] if home else g["away_team_id"]
        tf = F.team_form(g.assign(_team=tid.to_numpy()), src["games"] if src else
                         _games_from_box(box), "_team", f"{side}_")
        g = pd.concat([g, tf], axis=1)
    ctx = _context(g, box, src and src.get("games"), T)
    g = pd.concat([g, ctx.drop(columns=["venue_id"])], axis=1)
    if src and "hp_umpire_id" in g:
        g = pd.concat([g, F.umpire(g, src["ump_day"])], axis=1)
    g["game_date"] = pd.Timestamp("2015-01-01") + pd.to_timedelta(g["day"], "D")
    return g


def _games_from_box(box: pd.DataFrame) -> pd.DataFrame:
    return box.drop_duplicates("game_pk")[["game_pk", "day", "season", "home_team_id",
                                           "away_team_id", "home_score", "away_score"]]


# ── live: rest of game, live total ──────────────────────────────────────────

TEAM_PA_PER_OUT = 38.2 / 27


def _pa_with_state(pa: pd.DataFrame, src: dict | None) -> pd.DataFrame:
    cols = ["game_pk", "at_bat_index", "inning", "top_inning", "batter_id", "pitcher_id",
            "pit_started", "y", "season", "day"]
    p = pa[cols + (["is_post"] if "is_post" in pa else [])].copy()
    if src and "pa_start" in src:
        p = p.merge(src["pa_start"], on=["game_pk", "at_bat_index"], how="left")
    else:  # synthetic league: no pitches, reconstruct a coarse state
        p["outs0"] = 0
        p["hs0"] = 0
        p["as0"] = 0
    return p.sort_values(["game_pk", "at_bat_index"]).reset_index(drop=True)


def rog_frame(Fr: dict, src: dict | None, batter: pd.DataFrame) -> pd.DataFrame:
    p = _pa_with_state(Fr["pa"], src)
    p["hit"] = np.isin(p["y"], [2, 3, 4, 5]).astype(int)
    p["hr"] = (p["y"] == 5).astype(int)
    p = p.rename(columns={"batter_id": "player_id"})
    p = p.drop(columns=["is_post"], errors="ignore")
    keep = ["game_pk", "player_id", "is_post", "is_home", "slot", "e_pa", "s_hit", "s_hr", "rb_2",
            "rb_5", "bf_h_g50", "bf_hr_g50", "day_of_season", "game_date"]
    p = p.merge(batter[[c for c in keep if c in batter]], on=["game_pk", "player_id"],
                how="inner")
    p = p.sort_values(["game_pk", "player_id", "at_bat_index"]).reset_index(drop=True)
    g = p.groupby(["game_pk", "player_id"], sort=False)
    p["pa_k"] = g.cumcount() + 1
    for c, name in (("hit", "hits_so_far"), ("hr", "hr_so_far")):
        p[name] = g[c].cumsum() - p[c]
        rev = p.iloc[::-1].groupby(["game_pk", "player_id"], sort=False)[c].cumsum().iloc[::-1]
        p[f"y_{c}_rest"] = (rev > 0).astype(int)
    p["pa_so_far"] = p["pa_k"] - 1
    p["outs"] = p["outs0"].fillna(0)
    bat_home = ~p["top_inning"].astype(bool)
    p["score_diff"] = np.where(bat_home, p["hs0"] - p["as0"], p["as0"] - p["hs0"])
    outs_left = np.clip((9 - p["inning"] + 1) * 3 - p["outs"], 1, None)
    team_pa = outs_left * TEAM_PA_PER_OUT
    # He is at the plate now: this PA plus one per full trip through the order.
    p["rem_pa_base"] = 1 + np.maximum(team_pa - 1, 0) / 9
    per = lambda s: 1 - (1 - np.clip(s, 1e-6, 1 - 1e-6)) ** (1 / np.maximum(p["e_pa"], 1))  # noqa: E731
    p["rog_v3_hit"] = 1 - (1 - per(p["s_hit"])) ** p["rem_pa_base"]
    p["rog_v3_hr"] = 1 - (1 - per(p["s_hr"])) ** p["rem_pa_base"]
    p["sp_still_in"] = p["pit_started"].astype(float)
    p["sp_pitches"] = p.get("pog0", np.nan)
    return p.drop(columns=["hit", "hr", "y"])


def live_total_frame(Fr: dict, src: dict | None, game: pd.DataFrame) -> pd.DataFrame:
    p = _pa_with_state(Fr["pa"], src)
    first = p.groupby(["game_pk", "inning", "top_inning"], as_index=False).first()
    first = first[first["inning"] <= 9]
    first = first.drop(columns=["is_post"], errors="ignore")
    gcols = ["game_pk", "is_post", "total_runs", "v3_mu_home", "v3_mu_away", "v3_alpha", "temp_c",
             "wind_out", "park_runs", "game_date"]
    st = first.merge(game[[c for c in gcols if c in game]], on="game_pk", how="inner")
    top = st["top_inning"].astype(bool)
    inn = st["inning"]
    st["home_runs_now"] = st["hs0"].fillna(0)
    st["away_runs_now"] = st["as0"].fillna(0)
    st["runs_now"] = st["home_runs_now"] + st["away_runs_now"]
    st["outs_left_away"] = np.where(top, (9 - inn + 1) * 3, (9 - inn) * 3)
    st["outs_left_home"] = (9 - inn + 1) * 3
    # Whether each side's starter was still the pitcher on its last PA.
    p["h_sp"] = np.where(p["top_inning"], p["pit_started"].astype(float), np.nan)
    p["a_sp"] = np.where(~p["top_inning"].astype(bool), p["pit_started"].astype(float), np.nan)
    for c in ("h_sp", "a_sp"):
        p[c] = p.groupby("game_pk")[c].transform(lambda s: s.ffill().shift(1))
    sp = p.groupby(["game_pk", "inning", "top_inning"], as_index=False)[["h_sp", "a_sp"]].first()
    st = st.merge(sp, on=["game_pk", "inning", "top_inning"], how="left")
    st["h_sp_in"] = st["h_sp"].fillna(1.0)
    st["a_sp_in"] = st["a_sp"].fillna(1.0)
    muh = st["v3_mu_home"] * st["outs_left_home"] / 27
    mua = st["v3_mu_away"] * st["outs_left_away"] / 27
    st["live_v3_mu_rest"] = muh + mua
    pm = np.zeros((len(st), 31))
    for i, (a, b, al, now) in enumerate(zip(muh, mua, st["v3_alpha"], st["runs_now"])):
        rest = D.convolve_total(D.negbin_pmf(max(a, 1e-3), al, 30),
                                D.negbin_pmf(max(b, 1e-3), al, 30))
        n0 = int(min(now, 30))
        take = rest[:31 - n0]
        pm[i, n0:n0 + len(take)] = take
        pm[i, 30] += max(0.0, 1 - pm[i].sum())
    for k in range(31):
        st[f"live_v3pmf_{k}"] = pm[:, k]
    return st.drop(columns=["h_sp", "a_sp", "y", "batter_id", "pitcher_id", "pit_started",
                            "at_bat_index"], errors="ignore")


# ── orchestration ───────────────────────────────────────────────────────────

def build_player_frames(store, *, src: dict | None = None, run=None,  # noqa: ANN001
                        date: str | None = None, slate: list | None = None,
                        rating_configs: dict | None = None, on_frame=None) -> dict:  # noqa: ANN001
    """Every player / game / live frame, postseason included.

    on_frame(name, df): called as each frame (and the tuned rating configs,
    name "_rating_configs") is built -- how the lab writes them to R2 at once.

    date: also carry pending rows for that day's slate (outcomes NULL), so
    the same frames serve the backfill and today's predictions.
    rating_configs: reuse tuned rating configs (skips the slow tuning pass).
    `run`, `src` and `slate` are injectable so tests can skip R2 and MLB.
    """
    from modeling import games as G
    from modeling.v4 import slate as SL

    t0 = time.time()
    pend = None
    if date is not None:
        slate = slate if slate is not None else SL.fetch_slate(date)
        hist = G.load_box(store, include_post=True) if run is None else run["frames"]["box"]
        pend = SL.pending_box(slate, hist)
        _log(f"slate {date}: {len(slate)} scoreable games, "
             f"{0 if pend is None else len(pend):,} pending box rows")
    res = run if run is not None else MK.run(
        store, record=False, keep_frames=True, include_post=True,
        pending_box=pend, rating_configs=rating_configs)
    Fr = res["frames"]
    _log(f"v3 frames ready in {time.time() - t0:.0f}s")
    if src is None and store is not None:
        src = F.load_sources(store)
    cfg = res["final"]["pa_outcome"].get("ratings")
    if on_frame is not None and cfg:
        on_frame("_rating_configs", cfg)
    out: dict = {"pa_v3": Fr["pa_v3"], "_src": src, "_slate": slate or [],
                 "_rating_configs": cfg}
    if on_frame is not None:
        on_frame("pa_v3", Fr["pa_v3"])
    failed = []

    def step(name, fn):  # noqa: ANN001
        # Each frame is written the moment it exists, and a builder that
        # fails does not take the others with it: the v3 run behind them all
        # costs two hours, and losing it to the last builder is how the first
        # two lab attempts ended.
        try:
            df = fn()
        except Exception as exc:  # noqa: BLE001
            import traceback
            traceback.print_exc()
            failed.append(f"{name}: {exc}")
            return None
        out[name] = df
        _log(f"{name} frame: {len(df):,} rows, {len(df.columns)} cols")
        if on_frame is not None:
            on_frame(name, df)
        return df

    start = step("start", lambda: start_frame(Fr, src))
    batter = step("batter_game", lambda: batter_frame(Fr, src, start)) if start is not None else None
    game = step("game", lambda: game_frame(Fr, src, start, batter)) \
        if batter is not None else None
    if batter is not None:
        step("rog", lambda: rog_frame(Fr, src, batter))
    if game is not None:
        step("live_total", lambda: live_total_frame(Fr, src, game))
    if failed:
        raise RuntimeError("frame builders failed (the others were written): "
                           + "; ".join(failed))
    return out
