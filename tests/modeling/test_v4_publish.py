"""The publisher writes rows in the shape the board, API and settle read."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from modeling import derive as D
from modeling.v4 import catalog as C
from modeling.v4 import publish as PB
from modeling.v4 import slate as SL


def test_batter_rows_shape():
    fr = pd.DataFrame({"game_pk": [1], "player_id": [7], "team_id": [10], "opp_team": [11.0],
                       "is_home": [True], "slot": [3], "opp_sp": [99.0], "e_pa": [4.4]})
    r = PB.batter_rows(C.get("batter_hit"), fr, np.array([0.62]), "v4_x", "2026-10-15")[0]
    assert r["probability"] == 0.62 and r["role"] == "batter" and r["lineup_slot"] == 3
    assert r["per_pa_probability"] == pytest.approx(1 - (1 - 0.62) ** (1 / 4.4), abs=1e-4)
    assert r["model_version"] == "v4_x" and r["book"] == "model_fair"


def test_starter_rows_line_is_the_median_and_ladder_brackets_it():
    pmf = D.negbin_pmf(5.2, 0.05, 15)
    pmf = np.append(pmf[:15], 1 - pmf[:15].sum())
    fr = pd.DataFrame({"game_pk": [1], "player_id": [5], "team_id": [10], "opp_team": [11.0],
                       "is_home": [False]})
    r = PB.starter_rows(C.get("pitcher_k"), fr, pmf[None, :], "v4_x", "2026-10-15")[0]
    assert r["line"] == D.median_line(pmf)
    assert abs(r["probability"] - 0.5) < 0.2
    assert any(x["line"] == r["line"] for x in r["ladder"])
    assert r["expected_value"] == pytest.approx(float(pmf @ np.arange(16)), abs=1e-4)


def test_game_rows_moneyline_and_total():
    fr = pd.DataFrame({"game_pk": [1], "home_team_id": [10], "away_team_id": [11],
                       "v3_mu_home": [4.6], "v3_mu_away": [4.1], "v3_alpha": [0.1]})
    ml = PB.game_rows(C.get("game_moneyline"), fr, np.array([0.58]), "v4_x", "2026-10-15", {})[0]
    assert ml["recommendation"] == "home" and ml["probs"]["home"] == 0.58 and ml["price"] < 0
    tot = D.convolve_total(D.negbin_pmf(4.6, 0.1, 30), D.negbin_pmf(4.1, 0.1, 30))[:31]
    tot[30] = 1 - tot[:30].sum()
    t = PB.game_rows(C.get("game_total"), fr, tot[None, :], "v4_x", "2026-10-15", {})[0]
    assert t["phase"] == "pregame" and t["probs"]["mu_home"] == 4.6 and len(t["probs"]["pmf"]) == 31


def test_slate_parse_and_pending_box():
    data = {"dates": [{"date": "2026-10-15", "games": [{
        "gamePk": 5, "officialDate": "2026-10-15", "gameType": "L", "season": "2026",
        "status": {"detailedState": "Scheduled"}, "gameDate": "2026-10-15T23:08:00Z",
        "venue": {"id": 3},
        "teams": {"home": {"team": {"id": 10}, "probablePitcher": {"id": 100}},
                  "away": {"team": {"id": 11}, "probablePitcher": {"id": 200}}},
        "weather": {"temp": "61", "wind": "8 mph, Out To CF", "condition": "Clear"},
        "lineups": {"homePlayers": [{"id": i} for i in range(1, 10)], "awayPlayers": []}}]}]}
    games = SL.parse_schedule(data)
    assert games[0]["game_type"] == "L" and games[0]["wind_mph"] == 8.0
    hist = pd.DataFrame({"game_pk": 1, "team_id": 11, "slot": range(1, 10),
                         "player_id": range(21, 30), "pa": 4, "day": 100})
    pend = SL.pending_box(games, hist)
    assert len(pend) == 20 and pend["is_post"].all()
    away = pend[(pend["team_id"] == 11) & pend["slot"].notna()]
    assert list(away["player_id"]) == list(range(21, 30)) and not away["lineup_posted"].any()
    assert pend["pa"].isna().all()
