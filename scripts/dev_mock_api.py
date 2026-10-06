#!/usr/bin/env python3
"""Serve dist/ plus a canned /api on one localhost port -- DEVELOPMENT ONLY.

The board is live-data-only and has no offline mode, so laying it out (in
particular the phone layouts) needs a slate to look at when the real API is
unreachable or the league is between games. This serves one synthetic slate
-- live, final and scheduled games, batter and starter projections, a game
context -- shaped like the real routes in supabase/functions/api.

Every value is invented. /graded answers 404 "no route", which on localhost
switches the Data Feed to its own labelled dev fixture (frontend/dev/).

    bash scripts/build_frontend.sh
    SUPABASE_FUNCTIONS_URL=http://localhost:8787 bash scripts/build_frontend.sh  # optional
    python3 scripts/dev_mock_api.py [port]      # default 8787

then open http://localhost:8787/. The page's API base is forced to
http://localhost:<port>/api regardless of what config.js was built with.
"""
import json
import random
import sys
from datetime import datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
ET = ZoneInfo("America/New_York")
TODAY = datetime.now(ET).strftime("%Y-%m-%d")
NOW = datetime.now(timezone.utc)
rnd = random.Random(20261006)


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


TEAMS = [
    ("NYY", "BOS", "Fenway Park"), ("LAD", "SD", "Petco Park"),
    ("PHI", "ATL", "Truist Park"), ("HOU", "SEA", "T-Mobile Park"),
    ("CHC", "MIL", "American Family Field"), ("TOR", "CLE", "Progressive Field"),
    ("NYM", "WSH", "Nationals Park"),
]
FIRST = ["Aaron", "Juan", "Mookie", "Freddie", "Bryce", "Kyle", "Pete", "Jose",
         "Rafael", "Bobby", "Gunnar", "Corey", "Fernando", "Julio", "Yordan", "Adley"]
LAST = ["Judge", "Soto", "Betts", "Freeman", "Harper", "Schwarber", "Alonso",
        "Ramirez", "Devers", "Witt", "Henderson", "Seager", "Tatis", "Rodriguez",
        "Alvarez", "Rutschman", "Alvarez-Longname", "Guerrero"]
PTYPES = ["FF", "SL", "CH", "CU", "SI", "FC"]
CATS = ["ball", "strike_foul", "in_play"]


def name():
    return f"{rnd.choice(FIRST)} {rnd.choice(LAST)}"


def norm(d):
    t = sum(d.values())
    return {k: round(v / t, 3) for k, v in d.items()}


def game(i, away, home, venue, phase):
    pk = 800000 + i
    start = NOW + timedelta(hours=(-2.5 if phase == "live" else -4 if phase == "final" else 1 + i * 0.5))
    hp = rnd.uniform(0.38, 0.66)
    g = {
        "game_pk": pk, "game_label": f"{away} @ {home}", "away_abbr": away, "home_abbr": home,
        "venue": venue, "phase": phase, "start_ts": iso(start),
        "status": {"live": "In Progress", "final": "Final", "pregame": "Scheduled"}[phase],
        "model_version": "v3.2.0",
        "probable_away_pitcher": {"id": 600000 + i * 2, "name": name()},
        "probable_home_pitcher": {"id": 600001 + i * 2, "name": name()},
        "markets_pregame": [
            {"market": "game_moneyline", "probs": {"home": round(hp, 3), "away": round(1 - hp, 3)},
             "recommendation": "home" if hp >= .5 else "away", "confidence": round(max(hp, 1 - hp), 3)},
            {"market": "game_total", "line": 8.5, "predicted_value": round(rnd.uniform(7.2, 9.8), 1),
             "recommendation": rnd.choice(["over", "under"]), "confidence": round(rnd.uniform(.51, .62), 3)},
        ],
        "markets": [],
    }
    if phase == "pregame":
        g["markets"] = list(g["markets_pregame"])
        return g
    a, h = rnd.randint(0, 7), rnd.randint(0, 7)
    if phase == "final" and a == h:
        h += 1
    if phase == "final":
        g["situation"] = {"away_score": a, "home_score": h, "inning": 9, "half": "▼"}
        return g
    hp_now = min(.97, max(.03, hp + (h - a) * 0.08))
    n = rnd.randint(1, 5)
    balls = strikes = 0
    pitches, preds = [], []
    for k in range(n + 1):
        pr = norm({"ball": rnd.uniform(.25, .45), "strike_foul": rnd.uniform(.35, .55), "in_play": rnd.uniform(.1, .25)})
        rec = max(pr, key=pr.get)
        spd = round(rnd.uniform(84, 97), 1)
        preds.append({"market": "pitch_result", "pitch_number": k, "probs": pr, "recommendation": rec, "confidence": pr[rec]})
        preds.append({"market": "pitch_speed_ou", "pitch_number": k, "predicted_value": spd, "line": round(spd), "recommendation": "over"})
        if k == n:
            break
        cat = rnd.choice(CATS[:2])
        pitches.append({"pitch_number": k + 1, "pitch_type": rnd.choice(PTYPES), "start_speed": round(spd + rnd.uniform(-3, 3), 1),
                        "result_category": cat, "description": cat, "balls": balls, "strikes": strikes})
        if cat == "ball":
            balls = min(3, balls + 1)
        elif strikes < 2:
            strikes += 1
    pr = norm({"ball": .35, "strike_foul": .45, "in_play": .2})
    ab = norm({"out": .45, "hit": .24, "strikeout": .22, "walk": .09})
    g["situation"] = {"away_score": a, "home_score": h, "inning": rnd.randint(2, 9), "half": rnd.choice(["▲", "▼"]),
                      "count": f"{balls}-{strikes}", "outs": rnd.randint(0, 2), "last_pitch_ts": iso(NOW),
                      "pitch_count_pa": n}
    g.update({"batter_id": 700000 + i * 20 + 1, "batter_name": name(), "batter_hand": rnd.choice("LR"),
              "pitcher_id": g["probable_home_pitcher"]["id"], "pitcher_name": g["probable_home_pitcher"]["name"],
              "pitcher_hand": rnd.choice("LR"), "current_pa_pitches": pitches, "pa_predictions": preds})
    g["markets"] = [
        {"market": "game_moneyline", "probs": {"home": round(hp_now, 3), "away": round(1 - hp_now, 3)}},
        g["markets_pregame"][1],
        {"market": "pitch_result", "probs": pr, "recommendation": max(pr, key=pr.get), "confidence": max(pr.values())},
        {"market": "ab_result", "probs": ab, "recommendation": max(ab, key=ab.get), "confidence": max(ab.values())},
        {"market": "pitch_speed_ou", "predicted_value": 93.4, "line": 93.5, "recommendation": "under", "confidence": .55},
        {"market": "ab_pitches_ou", "predicted_value": 4.1, "line": 3.5, "recommendation": "over", "confidence": .58},
    ]
    g["live_models"] = {
        "total": {"projected": round(a + h + rnd.uniform(1, 4), 1), "line": 8.5, "p_over": round(rnd.uniform(.3, .7), 3)},
        "rest_of_game": [{"player_id": 700000 + i * 20 + s, "hit": round(rnd.uniform(.2, .6), 3),
                          "hr": round(rnd.uniform(.03, .15), 3), "remaining_pa": round(rnd.uniform(1, 3), 1)} for s in range(1, 19)],
    }
    return g


PHASES = ["live", "live", "live", "final", "final", "pregame", "pregame"]
GAMES = [game(i, *TEAMS[i], PHASES[i]) for i in range(len(TEAMS))]


def projections():
    rows = []
    for i, g in enumerate(GAMES):
        lineup_known = g["phase"] != "pregame" or i == 5
        for side_i, side in enumerate(("away", "home")):
            opp = g["probable_home_pitcher" if side == "away" else "probable_away_pitcher"]
            for s in range(1, 10):
                pid = 700000 + i * 20 + side_i * 9 + s
                pname = name()
                xpa = round(4.6 - s * 0.1, 2)
                base = dict(game_pk=g["game_pk"], player_id=pid, player=pname, role="batter",
                            is_home=side == "home", lineup_slot=s if lineup_known else None,
                            expected_pa=xpa, opposing_pitcher_id=opp["id"], opposing_pitcher=opp["name"],
                            updated_at=iso(NOW - timedelta(minutes=12)), model_version="bh_v2")
                res = (lambda: rnd.choice(["hit", "miss", "miss", "void"])) if g["phase"] == "final" else (lambda: None)
                rows.append(dict(base, market="batter_hit", probability=round(rnd.uniform(.45, .78), 3),
                                 per_pa_probability=round(rnd.uniform(.18, .32), 3), result=res()))
                rows.append(dict(base, market="batter_hr", probability=round(rnd.uniform(.05, .24), 3),
                                 per_pa_probability=round(rnd.uniform(.01, .06), 3), result=res()))
                rows.append(dict(base, market="batter_tb15", probability=round(rnd.uniform(.3, .55), 3),
                                 expected_value=round(rnd.uniform(1.1, 2.1), 2)))
                rows.append(dict(base, market="batter_hrr", probability=round(rnd.uniform(.5, .8), 3),
                                 per_pa_probability=round(rnd.uniform(.2, .4), 3)))
        for key in ("probable_away_pitcher", "probable_home_pitcher"):
            p = g[key]
            for m, line in (("pitcher_k", 5.5), ("pitcher_outs", 16.5), ("pitcher_hits", 5.5), ("pitcher_er", 2.5), ("pitcher_bb", 1.5)):
                rows.append(dict(game_pk=g["game_pk"], player_id=p["id"], player=p["name"], role="pitcher",
                                 market=m, line=line, probability=round(rnd.uniform(.4, .6), 3),
                                 expected_value=round(line + rnd.uniform(-1, 1), 1), updated_at=iso(NOW)))
    return rows


PROJ = projections()


def route(path, q):
    first = lambda k: (q.get(k) or [None])[0]
    if path == "/health":
        return 200, {"data_fresh": True, "jobs": {"live-poll": {"age_seconds": 8}}}
    if path == "/live":
        return 200, GAMES
    if path == "/games":
        return 200, {"date": TODAY, "is_today": True, "games": [{"game_pk": g["game_pk"], "status": g["status"]} for g in GAMES]}
    if path == "/board":
        by = lambda ph: [g for g in GAMES if g["phase"] == ph]
        return 200, {"date": TODAY, "recap": None, "live": by("live"), "upcoming": by("pregame"), "final": by("final")}
    if path == "/projections":
        rows = PROJ
        if first("date") and first("date") != TODAY:
            rows = []
        if first("market"):
            rows = [r for r in rows if r["market"] == first("market")]
        if first("role"):
            rows = [r for r in rows if r["role"] == first("role")]
        return 200, {"rows": rows}
    if path.startswith("/game/") and path.endswith("/context"):
        return 200, {"found": True, "venue_name": "Mock Park", "weather_condition": "Partly Cloudy", "temp_f": 71,
                     "wind_mph": 9, "wind_direction": "Out To CF", "hp_umpire": "Pat Hoberg"}
    if path == "/pitches":
        return 200, {"rows": [], "next_cursor": None}
    if path == "/accuracy":
        return 200, {"rows": []}
    if path == "/feed":
        return 200, {"games": [], "rows": []}
    if path.startswith("/graded"):
        return 404, {"error": f"no route: {path}"}
    return 404, {"error": "not found"}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(DIST), **kw)

    def log_message(self, *_):
        pass

    def do_GET(self):
        u = urlparse(self.path)
        if u.path.startswith("/api/") or u.path == "/api":
            code, body = route(u.path[4:] or "/", parse_qs(u.query))
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if u.path == "/config.js":
            port = self.server.server_address[1]
            src = (DIST / "config.js").read_text()
            data = (f'window.PITCH_EDGE_API = "http://localhost:{port}/api";\n' + src).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if u.path.startswith("/dev/"):
            # build_frontend.sh strips dev/ from dist/; serve the Data Feed
            # fixture from the source tree instead.
            f = ROOT / "frontend" / u.path.lstrip("/")
            if f.is_file():
                data = f.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "application/javascript")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
        super().do_GET()


if __name__ == "__main__":
    if not DIST.exists():
        sys.exit("dist/ not found -- run scripts/build_frontend.sh first")
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8787
    print(f"mock board on http://localhost:{port}/  (API http://localhost:{port}/api)")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
