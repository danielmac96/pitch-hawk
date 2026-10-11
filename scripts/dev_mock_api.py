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
    MH, MA = round(rnd.uniform(3.6, 5.2), 3), round(rnd.uniform(3.4, 5.0), 3)
    TL = round(MH + MA) - 0.5 if round(MH + MA) > MH + MA else round(MH + MA) + 0.5
    g = {
        "game_pk": pk, "game_label": f"{away} @ {home}", "away_abbr": away, "home_abbr": home,
        "venue": venue, "phase": phase, "start_ts": iso(start),
        "status": {"live": "In Progress", "final": "Final", "pregame": "Scheduled"}[phase],
        "model_version": "v3.2.0", "game_type": "R",
        "probable_away_pitcher": {"id": 600000 + i * 2, "name": name()},
        "probable_home_pitcher": {"id": 600001 + i * 2, "name": name()},
        "markets_pregame": [
            {"market": "game_moneyline", "probs": {"home": round(hp, 3), "away": round(1 - hp, 3)},
             "recommendation": "home" if hp >= .5 else "away", "confidence": round(max(hp, 1 - hp), 3)},
            {"market": "game_total", "line": TL, "predicted_value": round(MH + MA, 2),
             "recommendation": "over" if MH + MA > TL else "under", "confidence": round(rnd.uniform(.51, .62), 3),
             "probs": {"mu_home": MH, "mu_away": MA, "alpha": 0.12}},
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
                      "pitch_count_pa": n, "pitcher_pitch_count": rnd.randint(12, 104),
                      "bases": {"first": rnd.random() < .4, "second": rnd.random() < .25, "third": rnd.random() < .15}}
    g["batter_today"] = {"pa": 2, "h": 1, "hr": 0, "bb": 0, "k": 1}
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
        "total": {"projected": round(a + h + rnd.uniform(1, 4), 1), "line": TL, "p_over": round(rnd.uniform(.3, .7), 3)},
        "rest_of_game": [{"player_id": 700000 + i * 20 + s, "hit": round(rnd.uniform(.2, .6), 3),
                          "hr": round(rnd.uniform(.03, .15), 3), "remaining_pa": round(rnd.uniform(1, 3), 1)} for s in range(1, 19)],
    }
    return g


PHASES = ["live", "live", "live", "final", "final", "pregame", "pregame"]
GAMES = [game(i, *TEAMS[i], PHASES[i]) for i in range(len(TEAMS))]


def _binom_over(p, n, line):
    from math import comb
    k = int(line)
    return 1 - sum(comb(n, i) * p ** i * (1 - p) ** (n - i) for i in range(0, min(n, k) + 1))


def _pois_over(mu, line):
    from math import exp, factorial
    k = int(line)
    return 1 - sum(exp(-mu) * mu ** i / factorial(i) for i in range(k + 1))


def _ladder(over, cap=16):
    out = []
    for k in range(40):
        if len(out) >= cap:
            break
        p = over(k + 0.5)
        if p > 0.995:
            continue
        if p < 0.005:
            break
        out.append({"line": k + 0.5, "p_over": round(p, 4)})
    return out


def _mix(xpa, f):
    lo = int(xpa); w = xpa - lo
    return (1 - w) * f(lo) + w * f(lo + 1)


def projections(games=None):
    games = GAMES if games is None else games
    rows = []
    for i, g in enumerate(games):
        lineup_known = g["phase"] != "pregame" or i == 5
        final = g["phase"] == "final"
        for side_i, side in enumerate(("away", "home")):
            opp = g["probable_home_pitcher" if side == "away" else "probable_away_pitcher"]
            for s in range(1, 10):
                pid = 700000 + i * 20 + side_i * 9 + s
                pname = name()
                xpa = round(4.6 - s * 0.1, 2)
                ph, phr, pk = rnd.uniform(.19, .31), rnd.uniform(.012, .06), rnd.uniform(.14, .32)
                ptb = ph * 1.6
                base = dict(game_pk=g["game_pk"], player_id=pid, player=pname, role="batter",
                            is_home=side == "home", lineup_slot=s if lineup_known else None,
                            expected_pa=xpa, opposing_pitcher_id=opp["id"], opposing_pitcher=opp["name"],
                            bat_side=rnd.choice("LLRRRS"), opposing_pitcher_hand="L" if opp["id"] % 3 == 0 else "R",
                            updated_at=iso(NOW - timedelta(minutes=12)), model_version="bh_v2",
                            form_30d={"pa": rnd.randint(8, 110), "hit_rate": round(rnd.uniform(.15, .32), 4), "hr_rate": round(rnd.uniform(0, .07), 4)},
                            opp_form_30d={"pa": rnd.randint(40, 160), "hit_rate": round(rnd.uniform(.18, .28), 4), "hr_rate": round(rnd.uniform(.015, .045), 4)})
                pa_done = rnd.choice([0, 3, 4, 4, 5]) if final else None
                def graded(line, count):
                    if not final:
                        return dict(result=None)
                    if pa_done == 0:
                        return dict(result="void", actual_count=None, plate_appearances=0)
                    return dict(result="hit" if count > line else "miss", actual_count=count, plate_appearances=pa_done)
                h = sum(rnd.random() < ph for _ in range(pa_done or 0))
                hr = min(h, sum(rnd.random() < phr for _ in range(pa_done or 0)))
                ks = sum(rnd.random() < pk for _ in range(pa_done or 0))
                tb = h + hr * 3 + (1 if h - hr > 1 else 0)
                hit_l = _ladder(lambda L: _mix(xpa, lambda n: _binom_over(ph, n, L)), 6)
                hr_l = _ladder(lambda L: _mix(xpa, lambda n: _binom_over(phr, n, L)), 6)
                k_l = _ladder(lambda L: _mix(xpa, lambda n: _binom_over(pk, n, L)), 6)
                tb_l = _ladder(lambda L: _pois_over(ptb * xpa, L), 10)
                rows.append(dict(base, market="batter_hit", probability=hit_l[0]["p_over"], line=0.5,
                                 per_pa_probability=round(ph, 3), ladder=hit_l, **graded(0.5, h)))
                rows.append(dict(base, market="batter_hr", probability=hr_l[0]["p_over"], line=0.5,
                                 per_pa_probability=round(phr, 3), ladder=hr_l, **graded(0.5, hr)))
                rows.append(dict(base, market="batter_tb15", probability=tb_l[1]["p_over"], line=1.5,
                                 expected_value=round(ptb * xpa, 2), ladder=tb_l, **graded(1.5, tb)))
                rows.append(dict(base, market="batter_hrr", probability=round(rnd.uniform(.5, .8), 3), line=0.5,
                                 per_pa_probability=round(rnd.uniform(.2, .4), 3), **graded(0.5, h + rnd.randint(0, 2))))
                rows.append(dict(base, market="batter_k", probability=k_l[0]["p_over"], line=0.5,
                                 expected_value=round(pk * xpa, 2), ladder=k_l, model_version="v3+k_raw", **graded(0.5, ks)))
        for key in ("probable_away_pitcher", "probable_home_pitcher"):
            p = g[key]
            for m, lo, hi in (("pitcher_k", 3.6, 8.2), ("pitcher_outs", 13.5, 19.5), ("pitcher_hits", 3.8, 6.8),
                              ("pitcher_er", 1.6, 3.4), ("pitcher_bb", 1.0, 2.8)):
                mu = round(rnd.uniform(lo, hi), 2)
                line = int(mu) + 0.5
                lad = _ladder(lambda L: _pois_over(mu, L), 14)
                cnt = max(0, int(rnd.gauss(mu, mu ** 0.5)))
                gr = dict(result=("hit" if cnt > line else "miss"), actual_count=cnt, plate_appearances=24) if final else dict(result=None)
                rows.append(dict(game_pk=g["game_pk"], player_id=p["id"], player=p["name"], role="pitcher",
                                 pitch_hand="L" if p["id"] % 3 == 0 else "R",
                                 market=m, line=line, probability=round(_pois_over(mu, line), 4),
                                 expected_value=mu, ladder=lad, model_version="base_v1", updated_at=iso(NOW), **gr))
    return rows


PROJ = projections()
# Any earlier date answers with one fully graded slate, so the Predictions day
# stepper has a past day to show.
PAST_GAMES = [game(10 + i, *TEAMS[i], "final") for i in range(len(TEAMS))]
PAST_PROJ = projections(PAST_GAMES)


def route(path, q):
    first = lambda k: (q.get(k) or [None])[0]
    if path == "/health":
        return 200, {"data_fresh": True, "jobs": {"live-poll": {"age_seconds": 8}}}
    if path == "/live":
        return 200, GAMES
    if path == "/games":
        return 200, {"date": TODAY, "is_today": True, "games": [{"game_pk": g["game_pk"], "status": g["status"]} for g in GAMES]}
    if path == "/board":
        if first("date") and first("date") < TODAY:
            return 200, {"date": first("date"), "recap": None, "live": [], "upcoming": [], "final": PAST_GAMES}
        if first("date") and first("date") > TODAY:
            return 200, {"date": first("date"), "recap": None, "live": [], "upcoming": [], "final": []}
        by = lambda ph: [g for g in GAMES if g["phase"] == ph]
        return 200, {"date": TODAY, "recap": None, "live": by("live"), "upcoming": by("pregame"), "final": by("final")}
    if path == "/projections":
        rows = PROJ
        if first("date") and first("date") < TODAY:
            rows = PAST_PROJ
        elif first("date") and first("date") > TODAY:
            rows = []
        if first("market"):
            rows = [r for r in rows if r["market"] == first("market")]
        if first("role"):
            rows = [r for r in rows if r["role"] == first("role")]
        return 200, {"rows": rows}
    if path.startswith("/game/") and path.endswith("/context"):
        return 200, {"found": True, "source": "schedule", "venue_name": "Mock Park", "weather_condition": "Partly Cloudy",
                     "temp_f": 71, "wind_mph": 9, "wind_direction": "Out To CF", "hp_umpire": "Pat Hoberg",
                     "roof_closed": False, "park_hr_factor": 1.04, "park_hr_factor_season": 2026}
    if path.startswith("/game/") and path.endswith("/winprob"):
        pk = int(path.split("/")[2]); g = next((x for x in GAMES if x["game_pk"] == pk), None)
        if not g or g["phase"] == "pregame":
            return 200, {"game_pk": pk, "pregame_home": None, "points": []}
        cur = hp0 = g["markets_pregame"][0]["probs"]["home"]; pts = []
        for abi in range(40):
            cur = min(.98, max(.02, cur + rnd.gauss(0, .035)))
            pts.append({"abi": abi, "inning": abi // 8 + 1, "half": "▲" if (abi // 4) % 2 == 0 else "▼", "home": round(cur, 4)})
        return 200, {"game_pk": pk, "pregame_home": hp0, "points": pts}
    if path.startswith("/team/") and path.endswith("/next"):
        t = path.split("/")[2].upper()
        return 200, {"team": t, "found": True, "game": {"game_pk": 900001, "official_date": TODAY, "start_ts": iso(NOW + timedelta(days=2)),
                     "status": "Scheduled", "away_abbr": t, "home_abbr": "KC", "venue_name": "Kauffman Stadium"}}
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
