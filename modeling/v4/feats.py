"""v4 feature groups: daily aggregates, rolling windows, strictly-prior joins.

The one leakage rule, enforced in one place: a feature for a row on day D
uses only days < D. Every group is built the same way --

    1. a DAILY table: per (subject, day) sums, from SQL over the warehouse
       or from a frame already in memory;
    2. ROLLING sums over that table, inclusive of the day (windows counted
       in the subject's own game-days, plus season-to-date);
    3. an AS-OF join with allow_exact_matches=False, so the row on day D
       picks up the table row for the subject's last day strictly before D.

A season-to-date column whose table row is from an earlier season is
zeroed at join time: a pitcher's first start of April must not carry last
September's "season" totals. tests/modeling/test_v4_feats.py shuffles
the outcomes of one day and asserts no feature on that or any earlier day
moves.

Rates are shrunk toward fixed league-ish priors, (num + k*prior)/(den + k):
fixed so no statistic of the whole warehouse leaks into early seasons.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

# ── SQL over the warehouse (R2) ─────────────────────────────────────────────

FB = "p.pitch_type in ('FF','FT','SI','FA')"
BR = "p.pitch_type in ('SL','CU','KC','SV','ST','CS','SC')"
OS = "p.pitch_type in ('CH','FS','FO','KN','EP')"
SWUNG = "(p.description in ('swinging_strike','foul') or p.result_category = 'in_play')"
# Regular season and postseason (F, D, L, W): spring training and exhibitions
# are the only games no v4 history or frame reads. The views registered by
# duck.register_with_post carry `is_post`; fits filter on it.
REG = "coalesce(g.game_type, 'R') in ('R','F','D','L','W')"

PITCHER_DAY_SQL = f"""
select p.pitcher_id as pid, p.game_date, any_value(g.season) as season,
  count(*) as n,
  count(*) filter (where {FB}) as n_fb,
  count(*) filter (where {BR}) as n_br,
  count(*) filter (where {OS}) as n_os,
  coalesce(sum(p.start_speed) filter (where {FB}), 0) as fb_v,
  count(p.start_speed) filter (where {FB}) as fb_vn,
  coalesce(sum(p.spin_rate) filter (where {FB}), 0) as fb_spin,
  count(p.spin_rate) filter (where {FB}) as fb_spinn,
  coalesce(sum(p.pfx_z) filter (where {FB}), 0) as fb_ivb,
  count(p.pfx_z) filter (where {FB}) as fb_ivbn,
  coalesce(sum(abs(p.pfx_x)) filter (where {BR}), 0) as br_hb,
  count(p.pfx_x) filter (where {BR}) as br_hbn,
  coalesce(sum(p.extension), 0) as ext, count(p.extension) as extn,
  coalesce(sum(p.start_speed), 0) as spd, coalesce(sum(p.start_speed * p.start_speed), 0) as spd2,
  count(p.start_speed) as spdn,
  count(*) filter (where {SWUNG}) as swung,
  count(*) filter (where p.description = 'swinging_strike') as whiffs,
  count(*) filter (where p.description in ('called_strike','swinging_strike')) as csw,
  count(*) filter (where p.zone between 1 and 9) as inz,
  count(*) filter (where p.zone > 9) as outz,
  count(*) filter (where {SWUNG} and p.zone > 9) as chased,
  count(*) filter (where p.result_category = 'ball') as balls,
  count(*) filter (where p.result_category = 'in_play') as inplay,
  count(*) filter (where p.strikes > p.balls) as n_ahead,
  count(*) filter (where p.strikes > p.balls and p.result_category = 'ball') as ahead_balls,
  count(*) filter (where p.strikes > p.balls and p.result_category = 'in_play') as ahead_inplay,
  count(*) filter (where p.strikes > p.balls and {FB}) as ahead_fb,
  count(*) filter (where p.balls > p.strikes) as n_behind,
  count(*) filter (where p.balls > p.strikes and p.result_category = 'ball') as behind_balls,
  count(*) filter (where p.balls > p.strikes and p.result_category = 'in_play') as behind_inplay,
  count(*) filter (where p.balls > p.strikes and {FB}) as behind_fb,
  count(*) filter (where p.balls = p.strikes) as n_even,
  count(*) filter (where p.balls = p.strikes and p.result_category = 'ball') as even_balls,
  count(*) filter (where p.balls = p.strikes and p.result_category = 'in_play') as even_inplay,
  count(*) filter (where p.balls = p.strikes and {FB}) as even_fb
from pitches p join games g using (game_pk)
where p.pitcher_id is not null and {REG}
group by 1, 2
"""

BATTER_DAY_SQL = f"""
with b as (
  select p.*, g.season,
         degrees(atan2(p.hit_coord_x - 125.42, 198.27 - p.hit_coord_y)) as spray
  from pitches p join games g using (game_pk)
  where p.batter_id is not null and {REG}
)
select p.batter_id as bid, p.game_date, any_value(p.season) as season,
  count(*) as n,
  count(*) filter (where {SWUNG}) as swung,
  count(*) filter (where p.description = 'swinging_strike') as whiffs,
  count(*) filter (where p.zone > 9) as outz,
  count(*) filter (where {SWUNG} and p.zone > 9) as chased,
  count(*) filter (where p.result_category = 'in_play') as inplay,
  count(*) filter (where p.result_category = 'ball') as balls,
  count(*) filter (where p.strikes > p.balls) as n_ahead,
  count(*) filter (where p.strikes > p.balls and {SWUNG}) as ahead_swung,
  count(*) filter (where p.balls > p.strikes) as n_behind,
  count(*) filter (where p.balls > p.strikes and {SWUNG}) as behind_swung,
  count(*) filter (where p.balls = p.strikes) as n_even,
  count(*) filter (where p.balls = p.strikes and {SWUNG}) as even_swung,
  count(p.launch_speed) filter (where p.result_category = 'in_play') as bip,
  coalesce(sum(p.launch_speed) filter (where p.result_category = 'in_play'), 0) as ev,
  count(*) filter (where p.result_category = 'in_play' and p.launch_speed >= 95) as hard,
  count(*) filter (where p.result_category = 'in_play'
                   and p.launch_angle between 8 and 32) as sweet,
  count(*) filter (where p.result_category = 'in_play' and p.launch_speed >= 98
                   and p.launch_angle between 24 and 33) as barrel,
  count(*) filter (where p.result_category = 'in_play' and p.launch_angle >= 10 and
                   ((p.bat_side = 'R' and p.spray < -15) or
                    (p.bat_side = 'L' and p.spray > 15))) as pull_air
from b p
group by 1, 2
"""

PA_DAY_SQL = f"""
select a.{{who}}_id as pid, a.game_date, any_value(g.season) as season,
  count(*) as pa,
  count(*) filter (where a.result = 'strikeout') as k,
  count(*) filter (where a.result = 'walk') as bb,
  count(*) filter (where a.result = 'hit') as h,
  coalesce(sum(a.pitch_count), 0) as pitches
from at_bats a join games g using (game_pk) where {REG} and a.{{who}}_id is not null
group by 1, 2
"""

UMP_DAY_SQL = f"""
select g.hp_umpire_id as uid, p.game_date, any_value(g.season) as season,
  count(*) filter (where p.description in ('called_strike','ball')) as taken,
  count(*) filter (where p.description = 'called_strike') as called,
  count(*) filter (where p.description = 'called_strike' and p.zone > 9) as called_out,
  count(*) filter (where p.description in ('called_strike','ball') and p.zone > 9) as taken_out
from pitches p join games g using (game_pk)
where g.hp_umpire_id is not null and {REG}
group by 1, 2
"""

PA_START_SQL = """
select game_pk, at_bat_index,
  arg_min(outs, pitch_number) as outs0,
  arg_min(home_score, pitch_number) as hs0,
  arg_min(away_score, pitch_number) as as0,
  arg_min(on_first, pitch_number) is not null as on1,
  arg_min(on_second, pitch_number) is not null as on2,
  arg_min(on_third, pitch_number) is not null as on3,
  arg_min(pitch_of_game, pitch_number) as pog0
from pitches group by 1, 2
"""

GAMES_SQL = f"""
select game_pk, game_date, season, home_team_id, away_team_id, home_score, away_score,
       venue_id, hp_umpire_id, start_ts, is_post, game_type
from games g where {REG}
"""


def load_sources(store, *, con=None) -> dict[str, pd.DataFrame]:  # noqa: ANN001
    """The four daily tables, from R2. Minutes, not hours: one aggregate
    pass over pitches per table."""
    import time

    from modeling import ratings as R
    from warehouse import duck

    if con is None:
        con = duck.connect(store)
        duck.register_with_post(con, store, ("pitches", "at_bats", "games"))
    out = {}
    for name, sql in (("pitcher_day", PITCHER_DAY_SQL), ("batter_day", BATTER_DAY_SQL),
                      ("ump_day", UMP_DAY_SQL), ("games", GAMES_SQL),
                      ("pa_start", PA_START_SQL),
                      ("pitcher_pa_day", PA_DAY_SQL.format(who="pitcher")),
                      ("batter_pa_day", PA_DAY_SQL.format(who="batter"))):
        t0 = time.time()
        df = con.execute(sql).df()
        if "game_date" in df:
            df["day"] = R.day_index(df["game_date"])
        out[name] = df
        print(f"[v4] source {name}: {len(df):,} rows in {time.time() - t0:.0f}s", flush=True)
    return out


# ── rolling + as-of machinery ───────────────────────────────────────────────

def rolling(daily: pd.DataFrame, key: str, cols: list[str],
            windows: dict[str, int | None]) -> pd.DataFrame:
    """Inclusive rolling sums per subject. `None` = season to date."""
    d = daily.sort_values([key, "day"]).reset_index(drop=True)
    out = d[[key, "day", "season"]].copy()
    vals = d[cols].astype("float64")
    for w, n in windows.items():
        if n is None:
            s = vals.groupby([d[key], d["season"]], sort=False).cumsum()
        else:
            s = (vals.groupby(d[key], sort=False).rolling(n, min_periods=1).sum()
                 .reset_index(level=0, drop=True).sort_index())
        for c in cols:
            out[f"{c}_{w}"] = s[c].to_numpy()
    return out


def asof_prior(frame: pd.DataFrame, table: pd.DataFrame, fkey: str, tkey: str,
               cols: list[str], season_cols: tuple[str, ...] = ()) -> pd.DataFrame:
    """Each frame row gets the subject's latest table row strictly before
    its day. Season-to-date columns from an earlier season read 0."""
    left = pd.DataFrame({"_k": frame[fkey].to_numpy(dtype="float64"),
                         "day": frame["day"].to_numpy(dtype="int64"),
                         "season": frame["season"].to_numpy(),
                         "_i": np.arange(len(frame))})
    right = table[[tkey, "day", "season"] + cols].rename(
        columns={tkey: "_k", "season": "_ts"})
    right["_k"] = right["_k"].astype("float64")
    right["day"] = right["day"].astype("int64")
    left = left[np.isfinite(left["_k"])]
    m = pd.merge_asof(left.sort_values("day"), right.sort_values("day"), on="day",
                      by="_k", direction="backward", allow_exact_matches=False)
    stale = (m["_ts"] != m["season"]).to_numpy()
    for c in season_cols:
        if c in m:
            m.loc[stale, c] = 0.0
    res = pd.DataFrame(np.nan, index=np.arange(len(frame)), columns=cols)
    res.iloc[m["_i"].to_numpy()] = m[cols].to_numpy()
    return res


def shrink(num, den, prior: float, k: float):  # noqa: ANN001
    num = np.nan_to_num(np.asarray(num, float))
    den = np.nan_to_num(np.asarray(den, float))
    return (num + k * prior) / (den + k)


def _ratio(num, den):  # noqa: ANN001
    num, den = np.asarray(num, float), np.asarray(den, float)
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(den > 0, num / np.where(den > 0, den, 1), np.nan)


# ── pitcher stuff (from pitches) ────────────────────────────────────────────

PITCHER_COLS = ["n", "n_fb", "n_br", "n_os", "fb_v", "fb_vn", "fb_spin", "fb_spinn",
                "fb_ivb", "fb_ivbn", "br_hb", "br_hbn", "ext", "extn", "spd", "spd2",
                "spdn", "swung", "whiffs", "csw", "inz", "outz", "chased", "balls",
                "inplay", "n_ahead", "ahead_balls", "ahead_inplay", "ahead_fb",
                "n_behind", "behind_balls", "behind_inplay", "behind_fb", "n_even",
                "even_balls", "even_inplay", "even_fb"]


def pitcher_stuff(frame: pd.DataFrame, pitcher_day: pd.DataFrame, key: str,
                  prefix: str = "ps_") -> pd.DataFrame:
    """Arsenal and plate-discipline rates as of the morning: last 15
    appearances, with a last-3 velocity trend."""
    tab = rolling(pitcher_day, "pid", PITCHER_COLS, {"a15": 15, "a3": 3})
    cols = [c for c in tab.columns if c.endswith(("_a15", "_a3"))]
    j = asof_prior(frame, tab, key, "pid", cols)
    g = lambda c, w="a15": j[f"{c}_{w}"].to_numpy(float)  # noqa: E731
    v15 = _ratio(g("fb_v"), g("fb_vn"))
    out = pd.DataFrame({
        f"{prefix}velo": v15,
        f"{prefix}velo_trend": _ratio(g("fb_v", "a3"), g("fb_vn", "a3")) - v15,
        f"{prefix}spin": _ratio(g("fb_spin"), g("fb_spinn")),
        f"{prefix}ivb": _ratio(g("fb_ivb"), g("fb_ivbn")),
        f"{prefix}hb": _ratio(g("br_hb"), g("br_hbn")),
        f"{prefix}ext": _ratio(g("ext"), g("extn")),
        f"{prefix}whiff": shrink(g("whiffs"), g("swung"), 0.24, 150),
        f"{prefix}csw": shrink(g("csw"), g("n"), 0.29, 300),
        f"{prefix}zone": shrink(g("inz"), g("n"), 0.48, 300),
        f"{prefix}chase": shrink(g("chased"), g("outz"), 0.29, 150),
        f"{prefix}ball_rate": shrink(g("balls"), g("n"), 0.36, 300),
        f"{prefix}inplay_rate": shrink(g("inplay"), g("n"), 0.17, 300),
        f"{prefix}ff_share": shrink(g("n_fb"), g("n"), 0.5, 100),
        f"{prefix}br_share": shrink(g("n_br"), g("n"), 0.3, 100),
        f"{prefix}os_share": shrink(g("n_os"), g("n"), 0.15, 100),
        f"{prefix}speed_mean": _ratio(g("spd"), g("spdn")),
        f"{prefix}speed_sd": np.sqrt(np.clip(_ratio(g("spd2"), g("spdn"))
                                             - _ratio(g("spd"), g("spdn")) ** 2, 0, None)),
        f"{prefix}n": np.nan_to_num(g("n")),
    }, index=frame.index)
    for st in ("ahead", "behind", "even"):
        out[f"{prefix}{st}_ball_rate"] = shrink(g(f"{st}_balls"), g(f"n_{st}"), 0.36, 100)
        out[f"{prefix}{st}_inplay_rate"] = shrink(g(f"{st}_inplay"), g(f"n_{st}"), 0.17, 100)
        out[f"{prefix}{st}_ff_share"] = shrink(g(f"{st}_fb"), g(f"n_{st}"), 0.5, 100)
    return out


BATTER_COLS = ["n", "swung", "whiffs", "outz", "chased", "inplay", "balls", "n_ahead",
               "ahead_swung", "n_behind", "behind_swung", "n_even", "even_swung",
               "bip", "ev", "hard", "sweet", "barrel", "pull_air"]


def batter_discipline(frame: pd.DataFrame, batter_day: pd.DataFrame, key: str,
                      prefix: str = "bd_") -> pd.DataFrame:
    """Plate discipline over the last 30 game-days and contact quality over
    the last 120 (a batted ball is rarer than a pitch)."""
    tab = rolling(batter_day, "bid", BATTER_COLS, {"g30": 30, "g120": 120})
    cols = [c for c in tab.columns if c.endswith(("_g30", "_g120"))]
    j = asof_prior(frame, tab, key, "bid", cols)
    g = lambda c, w="g30": j[f"{c}_{w}"].to_numpy(float)  # noqa: E731
    out = pd.DataFrame({
        f"{prefix}swing": shrink(g("swung"), g("n"), 0.47, 200),
        f"{prefix}whiff": shrink(g("whiffs"), g("swung"), 0.24, 150),
        f"{prefix}chase": shrink(g("chased"), g("outz"), 0.29, 150),
        f"{prefix}inplay_rate": shrink(g("inplay"), g("n"), 0.17, 200),
        f"{prefix}ball_rate": shrink(g("balls"), g("n"), 0.36, 200),
        f"{prefix}n": np.nan_to_num(g("n")),
        f"{prefix}ahead_swing": shrink(g("ahead_swung"), g("n_ahead"), 0.55, 80),
        f"{prefix}behind_swing": shrink(g("behind_swung"), g("n_behind"), 0.40, 80),
        f"{prefix}even_swing": shrink(g("even_swung"), g("n_even"), 0.47, 80),
        "bc_ev": shrink(g("ev", "g120"), g("bip", "g120"), 88.5, 30),
        "bc_hardhit": shrink(g("hard", "g120"), g("bip", "g120"), 0.38, 40),
        "bc_la_sweet": shrink(g("sweet", "g120"), g("bip", "g120"), 0.34, 40),
        "bc_barrel": shrink(g("barrel", "g120"), g("bip", "g120"), 0.07, 60),
        "bc_pull_air": shrink(g("pull_air", "g120"), g("bip", "g120"), 0.16, 60),
        "bc_n": np.nan_to_num(g("bip", "g120")),
    }, index=frame.index)
    return out


def umpire(frame: pd.DataFrame, ump_day: pd.DataFrame, key: str = "hp_umpire_id") -> pd.DataFrame:
    tab = rolling(ump_day, "uid", ["taken", "called", "called_out", "taken_out"],
                  {"g40": 40})
    cols = [c for c in tab.columns if c.endswith("_g40")]
    j = asof_prior(frame, tab, key, "uid", cols)
    return pd.DataFrame({
        "ump_called_strike": shrink(j["called_g40"], j["taken_g40"], 0.33, 800),
        "ump_out_zone_strike": shrink(j["called_out_g40"], j["taken_out_g40"], 0.07, 600),
        "ump_n": np.nan_to_num(j["taken_g40"].to_numpy(float)),
    }, index=frame.index)


# ── box-score form (batters, starters, teams) ───────────────────────────────

BAT_STATS = ("h", "hr", "tb", "bb", "k", "r", "rbi")
BAT_PRIOR = {"h": 0.22, "hr": 0.03, "tb": 0.36, "bb": 0.085, "k": 0.22, "r": 0.115,
             "rbi": 0.11}


def batter_form(frame: pd.DataFrame, box: pd.DataFrame) -> pd.DataFrame:
    """Per-PA rates over the last 15 / 50 game-days and the season, and PA
    per game (a proxy for playing time and lineup position)."""
    bat = box[box["pa"].notna()].copy()
    for c in BAT_STATS:
        if c not in bat:
            bat[c] = np.nan
    daily = bat.groupby(["player_id", "day"], as_index=False).agg(
        season=("season", "first"), games=("game_pk", "nunique"),
        pa=("pa", "sum"), **{s: (s, "sum") for s in BAT_STATS})
    cols = ["games", "pa", *BAT_STATS]
    tab = rolling(daily, "player_id", cols, {"g15": 15, "g50": 50, "szn": None})
    tcols = [c for c in tab.columns if c.endswith(("_g15", "_g50", "_szn"))]
    j = asof_prior(frame, tab, "player_id", "player_id", tcols,
                   season_cols=tuple(c for c in tcols if c.endswith("_szn")))
    out = {}
    for w, k in (("g15", 40), ("g50", 80), ("szn", 80)):
        pa = j[f"pa_{w}"].to_numpy(float)
        for s in BAT_STATS:
            out[f"bf_{s}_{w}"] = shrink(j[f"{s}_{w}"], pa, BAT_PRIOR[s], k)
        out[f"bf_pa_{w}"] = shrink(pa, j[f"games_{w}"], 4.0, 3)
    return pd.DataFrame(out, index=frame.index)


SP_STATS = {"k": ("p_k", 0.22), "bb": ("p_bb", 0.08), "h": ("p_h", 0.23),
            "hr": ("p_hr", 0.03), "er": ("p_er", 0.11)}


def starter_form(frame: pd.DataFrame, box: pd.DataFrame) -> pd.DataFrame:
    """Per-BF rates and per-start volume over the last 5 / 15 starts and the
    season. Relief outings are excluded: a starter's line is what is priced."""
    st = box[box["p_started"].fillna(False).astype(bool) & box["p_bf"].notna()].copy()
    for c in ["p_outs", "p_pitches", *(v[0] for v in SP_STATS.values())]:
        if c not in st:
            st[c] = np.nan
    daily = st.groupby(["player_id", "day"], as_index=False).agg(
        season=("season", "first"), starts=("game_pk", "nunique"),
        bf=("p_bf", "sum"), outs=("p_outs", "sum"), pitches=("p_pitches", "sum"),
        **{k: (v[0], "sum") for k, v in SP_STATS.items()})
    cols = ["starts", "bf", "outs", "pitches", *SP_STATS]
    tab = rolling(daily, "player_id", cols, {"s5": 5, "s15": 15, "szn": None})
    tcols = [c for c in tab.columns if c.endswith(("_s5", "_s15", "_szn"))]
    j = asof_prior(frame, tab, "player_id", "player_id", tcols,
                   season_cols=tuple(c for c in tcols if c.endswith("_szn")))
    out = {}
    for w, k in (("s5", 60), ("s15", 120), ("szn", 120)):
        bf = j[f"bf_{w}"].to_numpy(float)
        n = j[f"starts_{w}"].to_numpy(float)
        for s, (_, prior) in SP_STATS.items():
            out[f"pf_{s}_{w}"] = shrink(j[f"{s}_{w}"], bf, prior, k)
        out[f"pf_outs_{w}"] = shrink(j[f"outs_{w}"], n, 16.0, 2)
        out[f"pf_bf_{w}"] = shrink(bf, n, 23.0, 2)
        out[f"pf_pitches_{w}"] = shrink(j[f"pitches_{w}"], n, 88.0, 2)
    out["season_ip"] = np.nan_to_num(j["outs_szn"].to_numpy(float)) / 3
    # The previous start's pitch count: a long outing shortens the next leash.
    last = asof_prior(frame, daily.assign(lp=daily["pitches"]), "player_id",
                      "player_id", ["lp"])
    out["last_pitches"] = last["lp"].to_numpy(float)
    return pd.DataFrame(out, index=frame.index)


def bullpen_usage(frame: pd.DataFrame, box: pd.DataFrame, team_key: str) -> pd.Series:
    """Relief outs the team's bullpen threw over the previous three calendar
    days: a tired pen means a longer leash and more runs late."""
    rel = box[~box["p_started"].fillna(False).astype(bool) & box["p_outs"].notna()]
    daily = rel.groupby(["team_id", "day"], as_index=False).agg(
        outs=("p_outs", "sum"), season=("season", "first"))
    lookup = daily.set_index(["team_id", "day"])["outs"].to_dict()
    t = frame[team_key].to_numpy()
    d = frame["day"].to_numpy()
    tot = np.zeros(len(frame))
    for lag in (1, 2, 3):
        tot += np.array([lookup.get((a, b - lag), 0.0) for a, b in zip(t, d)])
    return pd.Series(tot / 3.0, index=frame.index)


def team_form(frame: pd.DataFrame, games: pd.DataFrame, team_key: str,
              prefix: str) -> pd.DataFrame:
    """Season win %, run differential per game and the last 15 games' runs
    scored / allowed, plus days since the team last played."""
    h = games[["game_pk", "day", "season", "home_team_id", "home_score", "away_score"]] \
        .rename(columns={"home_team_id": "team", "home_score": "rs", "away_score": "ra"})
    a = games[["game_pk", "day", "season", "away_team_id", "away_score", "home_score"]] \
        .rename(columns={"away_team_id": "team", "away_score": "rs", "home_score": "ra"})
    tg = pd.concat([h, a]).dropna(subset=["rs", "ra"])
    tg["w"] = (tg["rs"] > tg["ra"]).astype(float)
    tg["g"] = 1.0
    daily = tg.groupby(["team", "day"], as_index=False).agg(
        season=("season", "first"), g=("g", "sum"), w=("w", "sum"),
        rs=("rs", "sum"), ra=("ra", "sum"))
    tab = rolling(daily, "team", ["g", "w", "rs", "ra"], {"g15": 15, "szn": None})
    tcols = [c for c in tab.columns if c.endswith(("_g15", "_szn"))]
    j = asof_prior(frame, tab, team_key, "team", tcols,
                   season_cols=tuple(c for c in tcols if c.endswith("_szn")))
    last = asof_prior(frame, daily.assign(last_day=daily["day"]), team_key, "team",
                      ["last_day"])
    g = lambda c: j[c].to_numpy(float)  # noqa: E731
    return pd.DataFrame({
        f"{prefix}win_pct": shrink(g("w_szn"), g("g_szn"), 0.5, 20),
        f"{prefix}run_diff_pg": shrink(g("rs_szn") - g("ra_szn"), g("g_szn"), 0.0, 20),
        f"{prefix}rs_pg_g15": shrink(g("rs_g15"), g("g_g15"), 4.5, 5),
        f"{prefix}ra_pg_g15": shrink(g("ra_g15"), g("g_g15"), 4.5, 5),
        f"{prefix}rest_days": np.clip(frame["day"].to_numpy(float)
                                      - last["last_day"].to_numpy(float), 0, 10),
    }, index=frame.index)


def head_to_head(frame: pd.DataFrame, pa: pd.DataFrame, bkey: str, pkey: str) -> pd.DataFrame:
    """Career batter-vs-pitcher line before today: PA and an OPS-like score
    (on-base + total bases per PA), from the PA frame's 7-class outcomes."""
    tb = np.array([0, 0, 1, 2, 3, 4, 0], float)
    p = pa[["batter_id", "pitcher_id", "day", "season", "y"]].copy()
    p["pair"] = p["batter_id"].astype("int64") * 10_000_000 + p["pitcher_id"].astype("int64")
    p["pa"] = 1.0
    p["onb"] = np.isin(p["y"], [1, 2, 3, 4, 5]).astype(float)
    p["tb"] = tb[p["y"].to_numpy(int)]
    daily = p.groupby(["pair", "day"], as_index=False).agg(
        season=("season", "first"), pa=("pa", "sum"), onb=("onb", "sum"), tb=("tb", "sum"))
    daily = daily.sort_values(["pair", "day"])
    for c in ("pa", "onb", "tb"):
        daily[f"{c}_cum"] = daily.groupby("pair")[c].cumsum()
    f = frame.assign(_pair=frame[bkey].astype("int64") * 10_000_000
                     + frame[pkey].fillna(0).astype("int64"))
    j = asof_prior(f, daily, "_pair", "pair", ["pa_cum", "onb_cum", "tb_cum"])
    n = np.nan_to_num(j["pa_cum"].to_numpy(float))
    return pd.DataFrame({
        "h2h_pa": n,
        "h2h_ops": shrink(j["onb_cum"].to_numpy(float) + j["tb_cum"].to_numpy(float),
                          n, 0.72, 15),
    }, index=frame.index)


# ── small context helpers ───────────────────────────────────────────────────

def day_of_season(frame: pd.DataFrame) -> np.ndarray:
    first = frame.groupby("season")["day"].transform("min")
    return (frame["day"] - first).to_numpy(float)


def night_game(start_ts: pd.Series) -> np.ndarray:
    """First pitch at or after 22:00 UTC (6pm ET)."""
    ts = pd.to_datetime(start_ts, utc=True, errors="coerce")
    h = ts.dt.hour.to_numpy(float)
    return np.where(np.isnan(h), np.nan, ((h >= 22) | (h < 8)).astype(float))
