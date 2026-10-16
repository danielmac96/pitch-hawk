"""Today's games as pending rows the v4 frames can carry and the models score.

    games = fetch_slate("2026-10-15")              # MLB API: probables, lineups, weather
    pend = pending_box(games, box_history)         # box-shaped rows, outcomes NULL

A lineup that is not posted yet is the team's most recent one (regular season
or postseason), the same fallback production's v3 path uses
(_shared/v3.ts::lastLineups); `lineup_posted` says which a row is. A game
with no probable starter on either side is skipped: every v4 player and
game market is conditioned on the starter.

Regular season and postseason alike (gameType R, F, D, L, W).
"""

from __future__ import annotations

import re

import numpy as np
import pandas as pd

from modeling import ratings as R

GAME_TYPES = "R,F,D,L,W"
NOT_SCOREABLE = re.compile(
    r"^(Final|Game Over|Completed|Postponed|Cancelled|Canceled|Suspended|"
    r"In Progress|Live|Manager challenge)", re.I)
OUTCOME_COLS = ("pa", "ab", "h", "doubles", "triples", "hr", "r", "rbi", "tb", "bb", "k",
                "hbp", "p_bf", "p_outs", "p_h", "p_bb", "p_k", "p_hr", "p_r", "p_er",
                "p_pitches", "home_score", "away_score")


def _num(v) -> float | None:  # noqa: ANN001
    s = re.sub(r"[^0-9.\-]", "", str(v or ""))
    try:
        return float(s) if re.search(r"\d", s) else None
    except ValueError:
        return None


def _wind(v) -> tuple[float | None, str | None]:  # noqa: ANN001
    s = str(v or "").strip().rstrip(".")
    if not s:
        return None, None
    parts = s.split(",", 1)
    d = parts[1].strip() if len(parts) > 1 else None
    return _num(parts[0]), (d if d and not re.match(r"^(none|calm)$", d, re.I) else None)


def parse_schedule(data: dict) -> list[dict]:
    out = []
    for d in data.get("dates", []):
        for g in d.get("games", []):
            if not g.get("gamePk"):
                continue
            status = (g.get("status") or {}).get("detailedState") or ""
            t = g.get("teams") or {}
            w = g.get("weather") or {}
            mph, wdir = _wind(w.get("wind"))
            lu = g.get("lineups") or {}
            ids = lambda ps: [p.get("id") for p in ps or [] if isinstance(p, dict) and p.get("id")]  # noqa: E731
            out.append({
                "game_pk": int(g["gamePk"]),
                "game_date": str(g.get("officialDate") or d.get("date")),
                "game_type": g.get("gameType") or "R",
                "season": int(str(g.get("season") or d.get("date"))[:4]),
                "status": status,
                "start_ts": g.get("gameDate"),
                "venue_id": (g.get("venue") or {}).get("id"),
                "home_team_id": ((t.get("home") or {}).get("team") or {}).get("id"),
                "away_team_id": ((t.get("away") or {}).get("team") or {}).get("id"),
                "home_pitcher_id": ((t.get("home") or {}).get("probablePitcher") or {}).get("id"),
                "away_pitcher_id": ((t.get("away") or {}).get("probablePitcher") or {}).get("id"),
                "home_lineup": ids(lu.get("homePlayers")),
                "away_lineup": ids(lu.get("awayPlayers")),
                "temp_f": _num(w.get("temp")), "wind_mph": mph, "wind_direction": wdir,
                "weather_condition": w.get("condition"),
            })
    return out


def fetch_slate(day: str) -> list[dict]:
    from warehouse import mlb
    data = mlb.get("/schedule", {"sportId": "1", "date": day, "gameType": GAME_TYPES,
                                 "hydrate": "probablePitcher,lineups,weather,team"})
    return [g for g in parse_schedule(data) if not NOT_SCOREABLE.match(g["status"])]


def last_lineups(box: pd.DataFrame) -> dict[int, list[int]]:
    """Each team's batting order (slots 1-9) in its most recent game."""
    b = box[box["slot"].notna() & box["pa"].notna()]
    if b.empty:
        return {}
    last = b.sort_values(["day", "game_pk"]).groupby("team_id")["game_pk"].last()
    out = {}
    for team, gpk in last.items():
        rows = b[(b["game_pk"] == gpk) & (b["team_id"] == team)].sort_values("slot")
        ids = rows.drop_duplicates("slot")["player_id"].astype(int).tolist()
        if len(ids) == 9:
            out[int(team)] = ids
    return out


def pending_box(games: list[dict], box: pd.DataFrame) -> pd.DataFrame:
    """Box-shaped rows for games not yet played: nine batters a side and the
    two probable starters, every outcome NULL."""
    fallback = last_lineups(box)
    rows = []
    for g in games:
        if g["home_pitcher_id"] is None or g["away_pitcher_id"] is None:
            continue
        common = {
            "game_pk": g["game_pk"], "game_date": pd.Timestamp(g["game_date"]),
            "season": g["season"], "venue_id": g["venue_id"],
            "home_team_id": g["home_team_id"], "away_team_id": g["away_team_id"],
            "temp_f": g["temp_f"], "wind_mph": g["wind_mph"],
            "wind_direction": g["wind_direction"],
            "weather_condition": g["weather_condition"],
            "is_post": g["game_type"] != "R",
        }
        sides = []
        for home in (True, False):
            team = g["home_team_id"] if home else g["away_team_id"]
            posted = g["home_lineup"] if home else g["away_lineup"]
            lineup, is_posted = (posted, True) if len(posted) == 9 else \
                (fallback.get(team, []), False)
            if len(lineup) != 9:
                break
            sides.append((home, team, lineup, is_posted))
        if len(sides) != 2:
            continue
        for home, team, lineup, is_posted in sides:
            for slot, pid in enumerate(lineup, 1):
                rows.append({**common, "player_id": int(pid), "team_id": team,
                             "is_home": home, "slot": slot, "batting_order": f"{slot}00",
                             "p_started": None, "lineup_posted": is_posted})
            sp = g["home_pitcher_id"] if home else g["away_pitcher_id"]
            rows.append({**common, "player_id": int(sp), "team_id": team, "is_home": home,
                         "slot": np.nan, "p_started": True, "lineup_posted": is_posted})
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    for c in OUTCOME_COLS:
        df[c] = np.nan
    df["day"] = R.day_index(df["game_date"])
    return df
