"""A small synthetic league for end-to-end tests of modeling/markets.py.

Teams with fixed lineups and rotations, PA-by-PA simulation from known talent,
starters pulled on a pitch-count-like rule, and box lines derived from the
simulation -- so every frame markets.run() builds has the real shape.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from modeling import ratings as R

BASE = np.array([0.22, 0.09, 0.14, 0.045, 0.004, 0.03, 0.471])


def league(seed=0, teams=6, seasons=(2016, 2017, 2018, 2019), days=40):
    rng = np.random.default_rng(seed)
    bats = {t: [t * 100 + i for i in range(9)] for t in range(teams)}
    sps = {t: [5000 + t * 10 + i for i in range(3)] for t in range(teams)}
    rps = {t: [7000 + t * 10 + i for i in range(3)] for t in range(teams)}
    talent = {}
    for t in range(teams):
        for p in bats[t] + sps[t] + rps[t]:
            talent[p] = rng.normal(0, 0.3, R.NC)
    pa_rows, box_rows, game_rows = [], [], []
    gpk = 0
    for s in seasons:
        for d in range(days):
            day = pd.Timestamp(f"{s}-04-01") + pd.Timedelta(days=d)
            order = rng.permutation(teams)
            for h, a in zip(order[::2], order[1::2]):
                gpk += 1
                score = {h: 0, a: 0}
                for bat_t, pit_t in ((a, h), (h, a)):
                    sp = sps[pit_t][d % 3]
                    leash = int(rng.integers(15, 28))
                    lines = {p: dict(pa=0, h=0, hr=0, tb=0, r=0, rbi=0, bb=0, k=0)
                             for p in bats[bat_t]}
                    pl = {sp: dict(bf=0, outs=0, k=0, bb=0, h=0, er=0)}
                    outs_total, i, faced = 0, 0, {}
                    while outs_total < 27:
                        b = bats[bat_t][i % 9]
                        p = sp if pl[sp]["bf"] < leash else rps[pit_t][i % 3]
                        pl.setdefault(p, dict(bf=0, outs=0, k=0, bb=0, h=0, er=0))
                        faced[(p, b)] = faced.get((p, b), 0) + 1
                        z = np.log(BASE) + talent[b] + talent[p]
                        q = np.exp(z) / np.exp(z).sum()
                        y = int(rng.choice(R.NC, p=q))
                        ev = ["strikeout", "walk", "single", "double", "triple",
                              "home_run", "field_out"][y]
                        pa_rows.append(dict(
                            game_pk=gpk, at_bat_index=len(pa_rows), game_date=day,
                            inning=1 + outs_total // 3, top_inning=bat_t == a,
                            batter_id=b, pitcher_id=p,
                            bat_side="L" if b % 2 else "R",
                            pitch_hand="L" if p % 3 == 0 else "R",
                            tto=faced[(p, b)], result_detail=ev, rbi=0,
                            home_score=0, away_score=0, men_on_base="Empty",
                            season=s, venue_id=h, home_team_id=h,
                            away_team_id=a, pit_started=p == sp))
                        ln, pp = lines[b], pl[p]
                        ln["pa"] += 1
                        pp["bf"] += 1
                        if y in (0, 6):
                            outs_total += 1
                            pp["outs"] += 1
                            ln["k"] += y == 0
                            pp["k"] += y == 0
                        elif y == 1:
                            ln["bb"] += 1
                            pp["bb"] += 1
                        else:
                            ln["h"] += 1
                            pp["h"] += 1
                            ln["tb"] += y - 1
                            ln["hr"] += y == 5
                            if rng.random() < 0.35:
                                score[bat_t] += 1
                                ln["r"] += 1
                                ln["rbi"] += 1
                                pp["er"] += 1
                        i += 1
                    for slot, b in enumerate(bats[bat_t], 1):
                        box_rows.append(dict(
                            game_pk=gpk, game_date=day, player_id=b, team_id=bat_t,
                            is_home=bat_t == h, slot=slot, p_started=None,
                            p_bf=None, **lines[b], p_k=None, p_bb=None, p_h=None,
                            p_outs=None, p_er=None, p_pitches=None))
                    for p, v in pl.items():
                        box_rows.append(dict(
                            game_pk=gpk, game_date=day, player_id=p, team_id=pit_t,
                            is_home=pit_t == h, slot=None, p_started=p == sp,
                            p_bf=v["bf"], p_outs=v["outs"], p_k=v["k"], p_bb=v["bb"],
                            p_h=v["h"], p_er=v["er"], p_pitches=v["bf"] * 4,
                            pa=None, h=None, hr=None, tb=None, r=None, rbi=None,
                            bb=None, k=None))
                game_rows.append(dict(game_pk=gpk, season=s, venue_id=h,
                                      home_team_id=h, away_team_id=a,
                                      home_score=score[h], away_score=score[a],
                                      temp_f=70, wind_mph=5,
                                      wind_direction="Out To CF",
                                      weather_condition="Sunny"))
    pa = pd.DataFrame(pa_rows)
    pa["y"] = R.classify(pa["result_detail"]).astype(int)
    pa["day"] = R.day_index(pa["game_date"])
    pa["pit_team"] = np.where(pa["top_inning"], pa["home_team_id"], pa["away_team_id"])
    pa["bat_home"] = (~pa["top_inning"].astype(bool)).astype(float)
    box = pd.DataFrame(box_rows).merge(pd.DataFrame(game_rows), on="game_pk")
    box["day"] = R.day_index(box["game_date"])
    return pa, box
