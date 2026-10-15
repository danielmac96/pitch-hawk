"""Frames for the in-game micro markets: one row per pitch, one per count state.

    pitch      pitch_result (strike/foul | ball | in play) and pitch_speed_ou
               (release speed), each scored before the pitch is thrown
    pa_state   ab_result (K | BB | hit | out) and ab_pitches_ou (pitches left),
               scored at every count a plate appearance reaches

7.9M pitches will not sit in a 7 GB runner as a wide frame together with the
training copies, so frames are built and written one season at a time, and
the ladder reads back only the columns a market uses.

In-game features come from window functions over the game so far (previous
pitch, the pitcher's velocity so far today); pre-game ones from the same
strictly-prior-day rolling tables as every other v4 frame (feats.py).
"""

from __future__ import annotations

import time

import numpy as np
import pandas as pd

from modeling import ratings as R
from modeling.v4 import feats as F
from modeling.v4 import storage as S

PITCH_SQL = f"""
select p.game_pk, p.at_bat_index, p.pitch_number, p.pitcher_id, p.batter_id,
  p.game_date, g.season, g.hp_umpire_id,
  p.balls, p.strikes, coalesce(p.outs, 0) as outs, p.inning,
  cast(p.top_inning as int) as top_inning,
  cast(p.on_first is not null as int) as on_1b,
  cast(p.on_second is not null as int) as on_2b,
  cast(p.on_third is not null as int) as on_3b,
  case when p.top_inning then p.away_score - p.home_score
       else p.home_score - p.away_score end as score_diff,
  p.pitch_of_game, p.pitch_number as pitch_of_pa, p.times_through_order as tto,
  cast(p.bat_side = p.pitch_hand as int) as same_hand,
  cast(p.pitch_hand = 'L' as int) as p_left,
  balls * 10 + strikes as count_state,
  lag(p.pitch_type) over w as prev_type,
  lag(p.description) over w as prev_desc,
  lag(p.start_speed) over w as prev_speed,
  avg(case when {F.FB.replace('p.', '')} then p.start_speed end) over (
      partition by p.game_pk, p.pitcher_id order by p.pitch_of_game
      rows between unbounded preceding and 1 preceding) as game_fb_velo,
  case p.result_category when 'strike_foul' then 0 when 'ball' then 1
       when 'in_play' then 2 end as y_pitch,
  p.start_speed as speed
from pitches p join games g using (game_pk)
where {F.REG} and g.season = ? and p.result_category is not null
  and p.pitcher_id is not null and p.batter_id is not null
window w as (partition by p.game_pk, p.at_bat_index order by p.pitch_number)
"""

PA_STATE_SQL = f"""
with px as (
  select p.game_pk, p.at_bat_index, p.pitch_number, p.balls, p.strikes,
         coalesce(p.outs, 0) as outs, p.inning, p.top_inning, p.pitcher_id, p.batter_id,
         p.on_first, p.on_second, p.on_third, p.home_score, p.away_score,
         p.times_through_order, p.bat_side, p.pitch_hand, p.pitch_of_game, p.game_date,
         row_number() over (partition by p.game_pk, p.at_bat_index, p.balls, p.strikes
                            order by p.pitch_number) as rn
  from pitches p join games g using (game_pk)
  where {F.REG} and g.season = ? and p.balls < 4 and p.strikes < 3
)
select px.game_pk, px.at_bat_index, px.balls, px.strikes, px.outs, px.inning,
  g.season, g.hp_umpire_id, px.pitcher_id, px.batter_id, px.game_date,
  cast(px.on_first is not null as int) as on_1b,
  cast(px.on_second is not null as int) as on_2b,
  cast(px.on_third is not null as int) as on_3b,
  case when px.top_inning then px.away_score - px.home_score
       else px.home_score - px.away_score end as score_diff,
  px.times_through_order as tto,
  cast(px.bat_side = px.pitch_hand as int) as same_hand,
  cast(px.pitch_hand = 'L' as int) as p_left,
  cast(not px.top_inning as int) as is_home_bat,
  px.pitch_of_game,
  px.balls * 10 + px.strikes as count_state,
  case a.result when 'strikeout' then 0 when 'walk' then 1 when 'hit' then 2
       when 'out' then 3 end as y_ab,
  a.pitch_count - (px.pitch_number - 1) as remaining
from px
join at_bats a using (game_pk, at_bat_index)
join games g using (game_pk)
where px.rn = 1 and a.result is not null and a.pitch_count >= px.pitch_number
"""

PITCHER_PA_DAY_SQL = f"""
select a.pitcher_id as pid, a.game_date, any_value(g.season) as season,
  count(*) as pa,
  count(*) filter (where a.result = 'strikeout') as k,
  count(*) filter (where a.result = 'walk') as bb,
  count(*) filter (where a.result = 'hit') as h,
  coalesce(sum(a.pitch_count), 0) as pitches
from at_bats a join games g using (game_pk) where {F.REG} and a.pitcher_id is not null
group by 1, 2
"""
BATTER_PA_DAY_SQL = PITCHER_PA_DAY_SQL.replace("a.pitcher_id as pid", "a.batter_id as pid") \
    .replace("a.pitcher_id is not null", "a.batter_id is not null")


def _pa_rates(frame: pd.DataFrame, day_tab: pd.DataFrame, key: str, prefix: str,
              window: int) -> pd.DataFrame:
    tab = F.rolling(day_tab, "pid", ["pa", "k", "bb", "h", "pitches"], {"w": window})
    cols = [c for c in tab.columns if c.endswith("_w")]
    j = F.asof_prior(frame, tab, key, "pid", cols)
    pa = j["pa_w"].to_numpy(float)
    return pd.DataFrame({
        f"{prefix}k_rate": F.shrink(j["k_w"], pa, 0.22, 80),
        f"{prefix}bb_rate": F.shrink(j["bb_w"], pa, 0.085, 80),
        f"{prefix}h_rate": F.shrink(j["h_w"], pa, 0.22, 80),
        f"{prefix}pitches_pa": F.shrink(j["pitches_w"], pa, 3.9, 40),
    }, index=frame.index)


def _count_bucket(balls: np.ndarray, strikes: np.ndarray) -> np.ndarray:
    return np.where(strikes > balls, 0, np.where(balls > strikes, 1, 2))


def _pitch_features(df: pd.DataFrame, src: dict) -> pd.DataFrame:
    ps = F.pitcher_stuff(df, src["pitcher_day"], "pitcher_id", prefix="ps_")
    bd = F.batter_discipline(df, src["batter_day"], "batter_id", prefix="bd_")
    out = pd.DataFrame(index=df.index)
    out["p_velo"] = ps["ps_velo"]
    out["p_velo_all"] = ps["ps_speed_mean"]
    out["p_velo_sd"] = ps["ps_speed_sd"]
    for c in ("ff_share", "br_share", "os_share", "zone", "whiff", "chase", "ball_rate",
              "inplay_rate", "n"):
        out[f"p_{c}"] = ps[f"ps_{c}"]
    bucket = _count_bucket(df["balls"].to_numpy(), df["strikes"].to_numpy())
    pick = lambda stem: np.choose(bucket, [ps[f"ps_ahead_{stem}"], ps[f"ps_behind_{stem}"],  # noqa: E731
                                           ps[f"ps_even_{stem}"]])
    out["p_cnt_ball_rate"] = pick("ball_rate")
    out["p_cnt_inplay_rate"] = pick("inplay_rate")
    out["p_cnt_ff_share"] = pick("ff_share")
    for c in ("swing", "whiff", "chase", "inplay_rate", "ball_rate", "n"):
        out[f"b_{c}"] = bd[f"bd_{c}"]
    out["b_cnt_swing"] = np.choose(bucket, [bd["bd_ahead_swing"], bd["bd_behind_swing"],
                                            bd["bd_even_swing"]])
    out = pd.concat([out, F.umpire(df, src["ump_day"]).drop(columns=["ump_n"])], axis=1)
    out["day_of_season"] = F.day_of_season(df)
    return out


def pitch_season(con, season: int, src: dict) -> pd.DataFrame:  # noqa: ANN001
    df = con.execute(PITCH_SQL, [season]).df()
    df["day"] = R.day_index(df["game_date"])
    t = df["prev_type"].fillna("")
    df["prev_type_fb"] = t.isin(["FF", "FT", "SI", "FA"]).astype(float)
    df["prev_type_br"] = t.isin(["SL", "CU", "KC", "SV", "ST", "CS", "SC"]).astype(float)
    df["prev_type_os"] = t.isin(["CH", "FS", "FO", "KN", "EP"]).astype(float)
    d = df["prev_desc"].fillna("")
    df["prev_result_ball"] = (d == "ball").astype(float)
    df["prev_result_strike"] = d.isin(["called_strike", "swinging_strike"]).astype(float)
    df["prev_result_foul"] = (d == "foul").astype(float)
    df = df.drop(columns=["prev_type", "prev_desc"])
    df = pd.concat([df, _pitch_features(df, src)], axis=1)
    df["game_velo_delta"] = df["game_fb_velo"] - df["p_velo"]
    return df


def pa_state_season(con, season: int, src: dict, pa_v3: pd.DataFrame | None) -> pd.DataFrame:  # noqa: ANN001
    df = con.execute(PA_STATE_SQL, [season]).df()
    df["day"] = R.day_index(df["game_date"])
    ps = F.pitcher_stuff(df, src["pitcher_day"], "pitcher_id", prefix="ps_")
    bd = F.batter_discipline(df, src["batter_day"], "batter_id", prefix="bd_")
    df["p_whiff"], df["p_zone"], df["p_velo"], df["p_n"] = (
        ps["ps_whiff"], ps["ps_zone"], ps["ps_velo"], ps["ps_n"])
    df["b_swing"], df["b_whiff"], df["b_chase"], df["b_n"] = (
        bd["bd_swing"], bd["bd_whiff"], bd["bd_chase"], bd["bd_n"])
    df = pd.concat([df, _pa_rates(df, src["pitcher_pa_day"], "pitcher_id", "p_", 15),
                    _pa_rates(df, src["batter_pa_day"], "batter_id", "b_", 30),
                    F.umpire(df, src["ump_day"]).drop(columns=["ump_n"])], axis=1)
    df["day_of_season"] = F.day_of_season(df)
    if pa_v3 is not None and len(pa_v3):
        df = df.merge(pa_v3.drop(columns=["season"], errors="ignore"),
                      on=["game_pk", "at_bat_index"], how="left")
    return df


def build_micro_frames(store, seasons, *, grains=("pitch", "pa_state")) -> None:  # noqa: ANN001
    from warehouse import duck

    con = duck.connect(store)
    duck.register(con, store, names=("pitches", "at_bats", "games"))
    src = F.load_sources(store, con=con)
    for name, sql in (("pitcher_pa_day", PITCHER_PA_DAY_SQL),
                      ("batter_pa_day", BATTER_PA_DAY_SQL)):
        df = con.execute(sql).df()
        df["day"] = R.day_index(df["game_date"])
        src[name] = df
    pa_v3 = None
    if "pa_state" in grains and S.frame_info(store, "pa_v3"):
        pa_v3 = S.get_frame(store, "pa_v3")
    for grain in grains:
        parts_meta = []
        for s in seasons:
            t0 = time.time()
            df = (pitch_season(con, s, src) if grain == "pitch"
                  else pa_state_season(con, s, src, pa_v3))
            S.put_frame_season(store, grain, s, df)
            parts_meta.append((s, len(df)))
            print(f"[v4] {grain} {s}: {len(df):,} rows, {len(df.columns)} cols "
                  f"in {time.time() - t0:.0f}s", flush=True)
            del df
