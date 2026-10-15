"""The v4 feature dictionary: what every model input means.

    describe("bf_h_g15")  -> {"group", "meaning", "window", "source", "as_of"}
    dictionary()          -> one row per feature used by any v4 market

Generated from naming rules rather than hand-kept per feature, so a feature
added to a frame is documented the moment it follows a rule, and one that
follows none reads "undocumented" on the dashboard -- which is the signal to
add a rule here. tests/modeling/test_v4_featdoc.py fails if any feature in
the catalogue is undocumented.
"""

from __future__ import annotations

import re

from modeling.v4 import catalog as C

PRIOR = "strictly before the game day (rolling tables joined as-of the day before)"
LIVE = "the game state before the pitch / plate appearance, from the play-by-play"
V3 = "out of sample: the v3 pipeline fitted on seasons before this one"

CLASSES7 = ["strikeout", "walk/HBP", "single", "double", "triple", "home run", "out in play"]

_WINDOWS = {"g15": "last 15 game-days", "g50": "last 50 game-days",
            "szn": "season to date (resets each season)", "s5": "last 5 starts",
            "s15": "last 15 starts", "a15": "last 15 appearances",
            "g30": "last 30 game-days", "g120": "last 120 game-days"}
_BAT_STATS = {"h": "hits per PA", "hr": "home runs per PA", "tb": "total bases per PA",
              "bb": "walks per PA", "k": "strikeouts per PA", "r": "runs per PA",
              "rbi": "RBIs per PA", "pa": "plate appearances per game"}
_SP_STATS = {"k": "strikeouts per batter faced", "bb": "walks per batter faced",
             "h": "hits allowed per batter faced", "hr": "home runs per batter faced",
             "er": "earned runs per batter faced", "outs": "outs recorded per start",
             "bf": "batters faced per start", "pitches": "pitches per start"}

# exact names first
EXACT: dict[str, tuple[str, str, str, str]] = {
    # (group, meaning, source, as-of)
    "slot": ("lineup", "batting-order slot, 1-9", "box score / posted lineup", "pregame"),
    "e_pa": ("lineup", "expected plate appearances (v3 PA-count model for the slot)", "v3", V3),
    "same_hand": ("matchup", "1 if batter and pitcher share a side (switch hitters never)",
                  "play-by-play / player info", "pregame or live"),
    "sp_left": ("matchup", "1 if the opposing starter throws left-handed", "player info", "pregame"),
    "bat_left": ("matchup", "1 if the batter bats left", "player info", "pregame"),
    "switch": ("matchup", "1 for a switch hitter", "player info", "pregame"),
    "p_left": ("matchup", "1 if the pitcher throws left-handed", "player info", "pregame or live"),
    "team_value": ("lineup", "sum of the lineup's expected offensive value (v3 run weights)", "v3", V3),
    "lineup_obp_behind": ("lineup", "mean on-base rating of the two hitters batting behind",
                          "v3 ratings", PRIOR),
    "is_home": ("context", "1 for the home team", "schedule", "pregame"),
    "park_hr": ("context", "park factor for home runs (decayed observed/expected at the venue)",
                "v3 park ratings", PRIOR),
    "park_h": ("context", "park factor for hits (mean of the four hit classes)", "v3 park ratings", PRIOR),
    "park_runs": ("context", "park factor for run value", "v3 park ratings", PRIOR),
    "temp_c": ("weather", "temperature, °F above 70 (0 under a closed roof or unknown)",
               "MLB game weather", "pregame forecast / box"),
    "wind_out": ("weather", "wind toward centre field, mph (negative = blowing in, 0 roof closed)",
                 "MLB game weather", "pregame forecast / box"),
    "roof_closed": ("weather", "1 if the roof is closed or a dome", "MLB game weather", "pregame"),
    "day_of_season": ("context", "days since the season's first game", "schedule", "pregame"),
    "night": ("context", "1 for a first pitch at or after 6pm ET", "schedule", "pregame"),
    "h2h_pa": ("matchup", "career plate appearances, this batter vs this pitcher", "at-bats", PRIOR),
    "h2h_ops": ("matchup", "career on-base + total bases per PA in the matchup, shrunk", "at-bats", PRIOR),
    "pen_ip_3d": ("bullpen", "relief outs the team's bullpen threw per day, previous 3 days",
                  "box score", PRIOR),
    "pen_rating_k": ("bullpen", "the opposing bullpen's strikeout rating", "v3 ratings", PRIOR),
    "pen_rating_out": ("bullpen", "the opposing bullpen's out (K + out-in-play) rating",
                       "v3 ratings", PRIOR),
    "ump_called_strike": ("umpire", "home-plate umpire's called-strike share of taken pitches, "
                          "last 40 games, shrunk", "pitches", PRIOR),
    "ump_out_zone_strike": ("umpire", "umpire's strike rate on taken pitches outside the zone",
                            "pitches", PRIOR),
    "ump_n": ("umpire", "taken pitches behind the umpire rating", "pitches", PRIOR),
    "rest": ("workload", "days since the pitcher's previous appearance (max 15)", "box score", PRIOR),
    "first_start": ("workload", "1 if more than 30 days since his last appearance", "box score", PRIOR),
    "own_mean": ("workload", "his decayed mean outs per start", "box score", PRIOR),
    "team_leash": ("workload", "his team's decayed mean starter outs (how long it lets starters go)",
                   "box score", PRIOR),
    "pitches_mean": ("workload", "his decayed mean pitches per start", "box score", PRIOR),
    "quality": ("workload", "out-getting rating above league", "v3 ratings", PRIOR),
    "mu_outs": ("workload", "v3 workload model's expected outs", "v3", V3),
    "mu_bf": ("workload", "v3 workload model's expected batters faced", "v3", V3),
    "last_pitches": ("workload", "pitches thrown in his previous start", "box score", PRIOR),
    "season_ip": ("workload", "innings pitched as a starter this season", "box score", PRIOR),
    "rpo": ("v3 structure", "v3 expected runs per out against the lineup he faces", "v3", V3),
    "balls": ("count", "balls in the count", "play-by-play", LIVE),
    "strikes": ("count", "strikes in the count", "play-by-play", LIVE),
    "outs": ("game state", "outs in the inning", "play-by-play", LIVE),
    "inning": ("game state", "inning", "play-by-play", LIVE),
    "top_inning": ("game state", "1 in the top of the inning", "play-by-play", LIVE),
    "on_1b": ("game state", "runner on first", "play-by-play", LIVE),
    "on_2b": ("game state", "runner on second", "play-by-play", LIVE),
    "on_3b": ("game state", "runner on third", "play-by-play", LIVE),
    "score_diff": ("game state", "batting team's runs minus the fielding team's", "play-by-play", LIVE),
    "pitch_of_game": ("game state", "the pitcher's pitch count today, including this pitch",
                      "play-by-play", LIVE),
    "pitch_of_pa": ("game state", "pitch number within the plate appearance", "play-by-play", LIVE),
    "tto": ("game state", "times this batter has faced this pitcher today", "play-by-play", LIVE),
    "is_home_bat": ("game state", "1 if the home team is batting", "play-by-play", LIVE),
    "prev_type_fb": ("previous pitch", "previous pitch was a fastball/sinker", "play-by-play", LIVE),
    "prev_type_br": ("previous pitch", "previous pitch was a breaking ball", "play-by-play", LIVE),
    "prev_type_os": ("previous pitch", "previous pitch was an offspeed pitch", "play-by-play", LIVE),
    "prev_result_ball": ("previous pitch", "previous pitch was a ball", "play-by-play", LIVE),
    "prev_result_strike": ("previous pitch", "previous pitch was a called/swinging strike",
                           "play-by-play", LIVE),
    "prev_result_foul": ("previous pitch", "previous pitch was fouled off", "play-by-play", LIVE),
    "prev_speed": ("previous pitch", "previous pitch's release speed, mph", "play-by-play", LIVE),
    "game_velo_delta": ("fatigue", "his fastball velocity so far today minus his recent norm",
                        "play-by-play + pitches", LIVE),
    "pa_k": ("rest of game", "the batter's plate appearance number today (this one)",
             "play-by-play", LIVE),
    "hits_so_far": ("rest of game", "his hits so far today", "play-by-play", LIVE),
    "hr_so_far": ("rest of game", "his home runs so far today", "play-by-play", LIVE),
    "pa_so_far": ("rest of game", "his plate appearances so far today", "play-by-play", LIVE),
    "rem_pa_base": ("rest of game", "plate appearances left, from outs remaining (base_v1 rule)",
                    "play-by-play", LIVE),
    "sp_still_in": ("rest of game", "1 while the opposing starter is still pitching", "play-by-play", LIVE),
    "sp_pitches": ("rest of game", "the opposing starter's pitch count", "play-by-play", LIVE),
    "runs_now": ("live total", "runs scored so far, both teams", "play-by-play", LIVE),
    "home_runs_now": ("live total", "home team's runs so far", "play-by-play", LIVE),
    "away_runs_now": ("live total", "away team's runs so far", "play-by-play", LIVE),
    "outs_left_home": ("live total", "outs the home side has left to bat", "play-by-play", LIVE),
    "outs_left_away": ("live total", "outs the away side has left to bat", "play-by-play", LIVE),
    "h_sp_in": ("live total", "1 while the home starter is still in", "play-by-play", LIVE),
    "a_sp_in": ("live total", "1 while the away starter is still in", "play-by-play", LIVE),
    "v3_mu_home": ("v3 structure", "v3 expected runs, home team", "v3", V3),
    "v3_mu_away": ("v3 structure", "v3 expected runs, away team", "v3", V3),
    "v3_p_home": ("v3 structure", "v3 P(home win), calibrated", "v3", V3),
    "live_v3_mu_rest": ("v3 structure", "v3 team means scaled to the outs left", "v3", LIVE),
    "rog_v3_hit": ("v3 structure", "v3 per-PA hit rate over the remaining PAs", "v3", LIVE),
    "rog_v3_hr": ("v3 structure", "v3 per-PA home-run rate over the remaining PAs", "v3", LIVE),
    "opp_k_rate": ("opposing lineup", "mean strikeout rating of the lineup he faces", "v3 ratings", PRIOR),
    "opp_bb_rate": ("opposing lineup", "mean walk rating of that lineup", "v3 ratings", PRIOR),
    "opp_h_rate": ("opposing lineup", "mean hit rating of that lineup", "v3 ratings", PRIOR),
    "opp_iso": ("opposing lineup", "mean extra-base power of that lineup", "v3 ratings", PRIOR),
    "opp_value": ("opposing lineup", "summed expected run value of that lineup", "v3", V3),
    "opp_lhb_share": ("opposing lineup", "share of left-handed batters in it", "lineup", "pregame"),
}

_RULES: list[tuple[str, callable]] = []


def _rule(pattern: str):
    def deco(fn):
        _RULES.append((re.compile(pattern), fn))
        return fn
    return deco


@_rule(r"^(rb|rs|rpen)_(\d)$")
def _rating(m):
    who = {"rb": "batter's", "rs": "opposing starter's", "rpen": "opposing bullpen's"}[m[1]]
    return ("v3 ratings", f"{who} decayed, shrunk rate of {CLASSES7[int(m[2])]} per PA",
            "v3 ratings", PRIOR)


@_rule(r"^bf_(\w+?)_(g15|g50|szn)$")
def _bat_form(m):
    return ("batter form", f"{_BAT_STATS.get(m[1], m[1])}, {_WINDOWS[m[2]]}, shrunk to league",
            "box score", PRIOR)


@_rule(r"^pf_(\w+?)_(s5|s15|szn)$")
def _sp_form(m):
    return ("starter form", f"{_SP_STATS.get(m[1], m[1])}, {_WINDOWS[m[2]]}, shrunk",
            "box score", PRIOR)


@_rule(r"^(ps|p)_(velo|velo_trend|spin|ivb|hb|ext|whiff|csw|zone|chase|ball_rate|inplay_rate|"
       r"ff_share|br_share|os_share|n|velo_all|velo_sd|speed_mean|speed_sd)$")
def _stuff(m):
    d = {"velo": "fastball velocity (mph), last 15 appearances",
         "velo_trend": "fastball velocity, last 3 appearances minus last 15",
         "spin": "fastball spin rate", "ivb": "fastball vertical movement (pfx_z)",
         "hb": "breaking-ball horizontal movement", "ext": "release extension",
         "whiff": "whiffs per swing", "csw": "called + swinging strikes per pitch",
         "zone": "share of pitches in the zone", "chase": "swings at pitches outside the zone",
         "ball_rate": "balls per pitch", "inplay_rate": "balls in play per pitch",
         "ff_share": "fastball share", "br_share": "breaking-ball share",
         "os_share": "offspeed share", "n": "pitches behind these rates",
         "velo_all": "mean release speed of every pitch type", "velo_sd": "release-speed spread",
         "speed_mean": "mean release speed of every pitch type", "speed_sd": "release-speed spread"}
    return ("pitcher stuff", f"pitcher's {d[m[2]]}", "pitches", PRIOR)


@_rule(r"^(ps|p)_(ahead|behind|even|cnt)_(ball_rate|inplay_rate|ff_share)$")
def _stuff_count(m):
    when = {"ahead": "when ahead in the count", "behind": "when behind",
            "even": "in even counts", "cnt": "in counts like this one (ahead/behind/even)"}[m[2]]
    return ("pitcher stuff", f"pitcher's {m[3].replace('_', ' ')} {when}", "pitches", PRIOR)


@_rule(r"^(bd|b)_(swing|whiff|chase|inplay_rate|ball_rate|n|ahead_swing|behind_swing|"
       r"even_swing|cnt_swing)$")
def _discipline(m):
    return ("batter discipline", f"batter's {m[2].replace('_', ' ')} rate, last 30 game-days",
            "pitches", PRIOR)


@_rule(r"^bc_(ev|hardhit|la_sweet|pull_air|barrel|n)$")
def _contact(m):
    d = {"ev": "mean exit velocity", "hardhit": "share of balls hit 95+ mph",
         "la_sweet": "share at a launch angle of 8-32°", "pull_air": "pulled balls in the air",
         "barrel": "barrel-like contact (98+ mph, 24-33°)", "n": "balls in play behind these"}
    return ("contact quality", f"batter's {d[m[1]]}, last 120 game-days", "pitches", PRIOR)


@_rule(r"^(p|b)_(k_rate|bb_rate|h_rate|pitches_pa)$")
def _pa_rates(m):
    who = "pitcher's" if m[1] == "p" else "batter's"
    return ("per-PA rates", f"{who} {m[2].replace('_', ' ')} per plate appearance",
            "at-bats", PRIOR)


@_rule(r"^opp_sp_(\w+)$")
def _opp_sp(m):
    return ("opposing starter", f"opposing starter's {m[1].replace('_', ' ')}",
            "pitches / box score", PRIOR)


@_rule(r"^(h|a)_(\w+)$")
def _game_side(m):
    side = "home" if m[1] == "h" else "away"
    d = {"value": "lineup expected run value (v3)", "sp_quality": "starter's out-getting rating",
         "sp_k_s15": "starter's K per BF, last 15 starts", "sp_era_s15": "starter's ER per BF",
         "sp_mu_outs": "starter's expected outs", "pen_rating_out": "bullpen out rating",
         "pen_ip_3d": "bullpen workload, last 3 days", "win_pct": "season win %",
         "run_diff_pg": "season run differential per game", "rest_days": "days since last game",
         "rs_pg_g15": "runs scored per game, last 15", "ra_pg_g15": "runs allowed per game, last 15",
         "sp_in": "starter still in"}
    return ("team", f"{side}: {d.get(m[2], m[2])}", "box score / v3", PRIOR)


@_rule(r"^(s|v3)_(hit|hr|tb2|e_hits|e_value|e_onbase|e_k|e_bb|e_h|e_outs|e_er|e_pa)$")
def _structural(m):
    d = {"hit": "P(1+ hit)", "hr": "P(1+ HR)", "tb2": "P(2+ total bases)",
         "e_hits": "expected hits", "e_value": "expected run value", "e_onbase": "expected times on base",
         "e_k": "expected strikeouts", "e_bb": "expected walks", "e_h": "expected hits allowed",
         "e_outs": "expected outs", "e_er": "expected earned runs", "e_pa": "expected PAs"}
    return ("v3 structure", f"v3 structural {d[m[2]]}", "v3", V3)


def describe(name: str) -> dict:
    if name in EXACT:
        g, meaning, src, asof = EXACT[name]
        return {"feature": name, "group": g, "meaning": meaning, "source": src, "as_of": asof}
    for pat, fn in _RULES:
        m = pat.match(name)
        if m:
            g, meaning, src, asof = fn(m)
            return {"feature": name, "group": g, "meaning": meaning, "source": src, "as_of": asof}
    return {"feature": name, "group": "undocumented", "meaning": "", "source": "", "as_of": ""}


def dictionary() -> list[dict]:
    """Every feature any v4 market declares, with the markets that use it."""
    use: dict[str, list[str]] = {}
    for md in C.MARKETS.values():
        for f in list(md.features) + list(md.stack):
            use.setdefault(f, []).append(md.name)
    return [{**describe(f), "markets": ", ".join(sorted(ms)), "n_markets": len(ms)}
            for f, ms in sorted(use.items())]
