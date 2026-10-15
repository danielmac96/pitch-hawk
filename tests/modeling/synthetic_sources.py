"""Synthetic stand-ins for modeling/v4/feats.load_sources, shaped like R2's.

Built from the synthetic league so ids line up, with the warts the real
warehouse has: a game_pk that appears twice in `games` (a re-dated game),
and pitchers / umpires with no history. Lets the frame builders' source
paths run in tests -- the first real-data run crashed in one of them.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from modeling.v4 import feats as F


def sources(pa: pd.DataFrame, box: pd.DataFrame, seed: int = 0) -> dict:
    rng = np.random.default_rng(seed)
    p = pa.copy()
    p["game_date"] = pd.to_datetime(p["game_date"])

    def day_table(key: str, cols: list[str]) -> pd.DataFrame:
        g = p.groupby([key, "game_date"], as_index=False).agg(season=("season", "first"),
                                                               n=("y", "size"))
        for c in cols:
            if c != "n":
                g[c] = rng.integers(0, 4, len(g)) * (g["n"] > 0)
        return g.rename(columns={key: "pid" if key == "pitcher_id" else "bid"})

    pitcher_day = day_table("pitcher_id", F.PITCHER_COLS)
    for c, base in (("fb_v", 94.0), ("fb_spin", 2300.0), ("fb_ivb", 1.3), ("br_hb", 0.7),
                    ("ext", 6.3), ("spd", 89.0)):
        n = pitcher_day["n"]
        pitcher_day[c] = base * n + rng.normal(0, 1, len(n))
        pitcher_day[c + "n" if c != "spd" else "spdn"] = n
    pitcher_day["spd2"] = (pitcher_day["spd"] / pitcher_day["spdn"]) ** 2 * pitcher_day["spdn"]
    batter_day = day_table("batter_id", F.BATTER_COLS)
    batter_day["ev"] = 88.0 * batter_day["bip"]

    g = box.drop_duplicates("game_pk")[["game_pk", "game_date", "season", "home_team_id",
                                        "away_team_id", "home_score", "away_score",
                                        "venue_id"]].copy()
    g["game_date"] = pd.to_datetime(g["game_date"])
    g["hp_umpire_id"] = 900 + (g["game_pk"] % 7)
    g["start_ts"] = g["game_date"] + pd.Timedelta(hours=23)
    g["is_post"] = False
    g["game_type"] = "R"
    games = pd.concat([g, g.head(3)], ignore_index=True)  # the re-dated-game wart

    ump = g.groupby(["hp_umpire_id", "game_date"], as_index=False).agg(season=("season", "first"))
    ump = ump.rename(columns={"hp_umpire_id": "uid"})
    ump["taken"] = 150
    ump["called"] = 50
    ump["called_out"] = 8
    ump["taken_out"] = 90

    pa_start = p[["game_pk", "at_bat_index"]].copy()
    pa_start["outs0"] = rng.integers(0, 3, len(p))
    pa_start["hs0"] = 0
    pa_start["as0"] = 0
    pa_start["on1"] = False
    pa_start["on2"] = False
    pa_start["on3"] = False
    pa_start["pog0"] = rng.integers(1, 100, len(p))

    def pa_day(key: str) -> pd.DataFrame:
        d = p.groupby([key, "game_date"], as_index=False).agg(
            season=("season", "first"), pa=("y", "size"),
            k=("y", lambda s: int((s == 0).sum())), bb=("y", lambda s: int((s == 1).sum())),
            h=("y", lambda s: int(s.isin([2, 3, 4, 5]).sum())))
        d["pitches"] = d["pa"] * 4
        return d.rename(columns={key: "pid"})

    out = {"pitcher_day": pitcher_day, "batter_day": batter_day, "ump_day": ump,
           "games": games, "pa_start": pa_start, "pitcher_pa_day": pa_day("pitcher_id"),
           "batter_pa_day": pa_day("batter_id")}
    from modeling import ratings as R
    for k, df in out.items():
        if "game_date" in df:
            df["day"] = R.day_index(df["game_date"])
    out["games"] = out["games"].sort_values("game_date").drop_duplicates("game_pk", keep="last")
    return out
