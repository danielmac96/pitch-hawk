"""Publish today's ratings to Supabase `model_ratings` for the edge functions.

    python -m modeling publish-ratings [--dry-run]

Runs nightly after the warehouse ingest. Everything here is the serving twin
of something training computes, through the SAME functions:

  batter / pitcher   ratings.ratings_current   (training: ratings_asof)
  league             ratings.decayed_total     (training: league_asof)
  park               O/E with the same log5 expectation as pa_model.park_asof
  pen                ratings_current on relief PAs, keyed by pitching team
  workload           ratings.decayed_mean_current (training: decayed_mean_asof)

and with the hyperparameters (tau, k) stored on the ACTIVE `pa_outcome` model
row -- the configuration the served model was validated with. There is no
second set of constants to drift.

"As of" is today in America/New_York, exclusive: every game before today
counts, none of today's do -- the same leakage rule training uses.
"""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

from modeling import games as G
from modeling import pa_model as P
from modeling import ratings as R

NC = R.NC
# Players whose decayed sample has faded below this are not published: a
# player who has not batted in years reads as the prior anyway, and serving
# falls back to the league row for an unknown id.
MIN_N_EFF = 3.0


def _today_et():
    return datetime.now(ZoneInfo("America/New_York")).date()


def _active_pa_params() -> dict:
    from modeling import registry

    row = registry.active("pa_outcome")
    if not row or "ratings" not in (row.get("params") or {}):
        raise RuntimeError(
            "no active pa_outcome model with rating configs; activate one "
            "(python -m modeling activate pa_outcome <version>) before "
            "publishing ratings")
    return row["params"]


def _rows(kind: str, ids, rates: np.ndarray | None, n_eff, as_of: str,
          extra: list[dict] | None = None) -> list[dict]:
    out = []
    for i, pid in enumerate(ids):
        r = {"kind": kind, "id": int(pid), "as_of": as_of,
             "n_eff": float(n_eff[i]) if n_eff is not None else None,
             "extra": (extra[i] if extra else {})}
        for c in range(NC):
            r[f"c{c}"] = float(rates[i, c]) if rates is not None else None
        out.append(r)
    return out


def build(store, params: dict, *, today=None) -> pd.DataFrame:  # noqa: ANN001
    today = today or _today_et()
    at = float(R.day_index([pd.Timestamp(today)])[0])
    as_of = str(today)
    cfg = params["ratings"]
    cb = R.RatingConfig.from_json(cfg["batter"])
    cp = R.RatingConfig.from_json(cfg["pitcher"])
    cpen = R.RatingConfig.from_json(cfg["pen"])
    park_k, park_tau = float(cfg["park"]["k"]), float(cfg["park"]["tau"])

    pa = P.load_pa(store)
    # League now: the same decayed sum league_asof takes, at `at`.
    tmp = pa[["day", "y"]].assign(_all=0)
    lt = R.decayed_total(tmp, "_all", float(cfg.get("league_tau", 365.0)), at)
    L_now = lt[[f"S_{c}" for c in range(NC)]].to_numpy()[0] / lt["S_n"].iat[0]
    L_now = L_now / L_now.sum()

    rows: list[dict] = []
    rows += _rows("league", [0], L_now[None, :], [float(lt["S_n"].iat[0])], as_of)

    bs, ph = G.hands_from_pa(pa)
    bat = R.ratings_current(pa, "batter_id", L_now, cb, at)
    bat = bat[bat["n_eff"] >= MIN_N_EFF]
    rows += _rows("bat", bat["batter_id"], bat[[f"r_{c}" for c in range(NC)]].to_numpy(),
                  bat["n_eff"].to_numpy(), as_of,
                  [{"bat_side": bs.get(i, "R")} for i in bat["batter_id"]])
    pit = R.ratings_current(pa, "pitcher_id", L_now, cp, at)
    pit = pit[pit["n_eff"] >= MIN_N_EFF]

    # Park: observed vs log5-expected, the expectation built from as-of
    # ratings exactly as in training.
    league = R.league_asof(pa)
    rb = R.ratings_asof(pa, "batter_id", league, cb)
    rp = R.ratings_asof(pa, "pitcher_id", league, cp)
    cols = [f"r_{c}" for c in range(NC)]
    rbm = pa[["batter_id", "day"]].merge(rb, on=["batter_id", "day"], how="left")[cols].to_numpy()
    rpm = pa[["pitcher_id", "day"]].merge(rp, on=["pitcher_id", "day"], how="left")[cols].to_numpy()
    Lm = pa[["day"]].merge(league, on="day", how="left")[
        [f"L_{c}" for c in range(NC)]].to_numpy()
    exp_ = P.log5(rbm, rpm, Lm)
    sub = pa["day"].to_numpy() < at
    w = np.exp(-(at - pa["day"].to_numpy()[sub]) / park_tau)
    obs = np.zeros((sub.sum(), NC))
    obs[np.arange(sub.sum()), pa["y"].to_numpy()[sub]] = 1.0
    venue = pa["venue_id"].to_numpy()[sub]
    O = pd.DataFrame(obs * w[:, None]).groupby(venue).sum()
    E = pd.DataFrame(exp_[sub] * w[:, None]).groupby(venue).sum()
    fac = (O.to_numpy() + park_k) / (E.to_numpy() + park_k)
    rows += _rows("park", O.index, fac, O.sum(axis=1).to_numpy(), as_of)

    rel = pa[~pa["pit_started"].astype(bool)]
    pen = R.ratings_current(rel, "pit_team", L_now, cpen, at)
    rows += _rows("pen", pen["pit_team"], pen[cols].to_numpy(),
                  pen["n_eff"].to_numpy(), as_of)

    # Workload: the same decayed means workload_frame computes per start.
    box = G.load_box(store)
    starts = box[box["p_started"].fillna(False).astype(bool)]
    wl = {}
    for v, c in G.WORKLOAD.items():
        m = R.decayed_mean_current(starts, "player_id", v, c["tau"], c["prior"], c["k"], at)
        wl[v] = m.set_index("player_id")[f"{v}_mean"]
    last_app = box[box["p_bf"].notna() & (box["day"] < at)].groupby("player_id")["day"].max()
    pit_extra = []
    for pid in pit["pitcher_id"]:
        e = {"pitch_hand": ph.get(pid, "R")}
        for v in G.WORKLOAD:
            if pid in wl[v].index:
                e[f"{v}_mean"] = round(float(wl[v][pid]), 4)
        if pid in last_app.index:
            e["last_app_day"] = float(last_app[pid])
        pit_extra.append(e)
    rows += _rows("pit", pit["pitcher_id"], pit[cols].to_numpy(),
                  pit["n_eff"].to_numpy(), as_of, pit_extra)

    leash = R.decayed_mean_current(starts.assign(team_outs=starts["p_outs"]),
                                   "team_id", "team_outs", G.TEAM_LEASH["tau"],
                                   G.TEAM_LEASH["prior"], G.TEAM_LEASH["k"], at)
    rows += _rows("team", leash["team_id"], None, leash["team_outs_n"].to_numpy(),
                  as_of, [{"outs_mean": round(float(v), 4)}
                          for v in leash["team_outs_mean"]])
    return pd.DataFrame(rows)


def main(store, *, dry_run: bool = False) -> int:  # noqa: ANN001
    import pyarrow as pa_

    params = _active_pa_params()
    df = build(store, params)
    print(df.groupby("kind").size().to_string())
    if dry_run:
        return 0
    from warehouse.config import supabase_client
    from warehouse.publish import publish_table

    df["updated_at"] = datetime.now(ZoneInfo("UTC")).isoformat()
    n = publish_table(supabase_client(), "model_ratings",
                      pa_.Table.from_pandas(df, preserve_index=False))
    print(f"model_ratings: {n} rows live")
    return 0
