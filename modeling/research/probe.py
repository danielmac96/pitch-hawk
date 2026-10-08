"""Shape of the warehouse, for building the ratings layer against facts.

Prints per-season volumes, the PA-ending event vocabulary, player_box coverage
and cross-checks against at_bats, and the weather/wind vocabulary the game
models parse.
"""

from __future__ import annotations


def _show(con, title: str, sql: str, limit: int = 60) -> None:
    print(f"\n=== {title}")
    df = con.execute(sql).df()
    with __import__("pandas").option_context(
            "display.max_rows", limit, "display.width", 200,
            "display.max_columns", 30):
        print(df.head(limit).to_string(index=False))


def main(store, args) -> None:  # noqa: ANN001
    from warehouse import duck

    con = duck.connect(store)
    seen = duck.register(con, store, names=("at_bats", "games", "player_box"))
    print("scanned days:", seen)

    _show(con, "games by season/type", """
        select season, game_type, count(*) n,
               avg(case when venue_id is null then 1 else 0 end) venue_null,
               avg(case when temp_f is null then 1 else 0 end) temp_null,
               avg(case when wind_direction is null then 1 else 0 end) wind_null
        from games group by 1,2 order by 1,2""")
    _show(con, "at_bats by season", """
        select year(game_date) season, count(*) n,
               avg(case when batter_id is null then 1.0 else 0 end) bat_null,
               avg(case when bat_side is null then 1.0 else 0 end) side_null,
               avg(case when times_through_order is null then 1.0 else 0 end) tto_null,
               avg(case when result_detail='home_run' then 1.0 else 0 end) hr,
               avg(case when result='strikeout' then 1.0 else 0 end) k
        from at_bats group by 1 order by 1""")
    _show(con, "result_detail vocabulary", """
        select result, result_detail, count(*) n from at_bats
        group by 1,2 order by n desc""", 80)
    _show(con, "player_box by season", """
        select year(game_date) season, count(*) n_rows,
               count(distinct game_pk) games,
               sum(case when slot is not null then 1 else 0 end)
                 / count(distinct game_pk) starters_per_game,
               sum(case when p_started then 1 else 0 end)
                 / count(distinct game_pk) sp_per_game,
               sum(r) / count(distinct game_pk) runs_pg,
               sum(p_er) / count(distinct game_pk) er_pg,
               sum(p_outs) / count(distinct game_pk) outs_pg
        from player_box group by 1 order by 1""")
    _show(con, "player_box vs at_bats (rbi, hr, pa per season)", """
        with a as (select year(game_date) s, sum(rbi) rbi,
                          sum(case when result_detail='home_run' then 1 else 0 end) hr,
                          count(*) pa from at_bats group by 1),
             b as (select year(game_date) s, sum(rbi) rbi, sum(hr) hr,
                          sum(pa) pa from player_box group by 1)
        select a.s, a.rbi ab_rbi, b.rbi box_rbi, a.hr ab_hr, b.hr box_hr,
               a.pa ab_pa, b.pa box_pa from a join b using (s) order by 1""")
    _show(con, "wind_direction vocabulary", """
        select wind_direction, count(*) n from games group by 1 order by n desc""")
    _show(con, "weather_condition vocabulary", """
        select weather_condition, count(*) n from games group by 1
        order by n desc""", 30)
    _show(con, "starter BF / pitches distribution by season", """
        select year(game_date) s, avg(p_bf) bf, stddev(p_bf) bf_sd,
               avg(p_pitches) pitches, avg(p_outs) outs, avg(p_er) er
        from player_box where p_started group by 1 order by 1""")
    _show(con, "PA per game by slot (starters, home/away)", """
        select slot, is_home, avg(pa) pa, stddev(pa) sd, count(*) n
        from player_box where slot is not null group by 1,2 order by 1,2""")
