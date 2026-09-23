-- Second attempt at making player_streaks fit the request path. The indexes in
-- 20260825124956 were necessary but not sufficient: the query still read every
-- graded call in the window for every player, then threw away all but the
-- leading run. Measured at ~33s for 50 players over 20 days.
--
-- A streak only ever needs calls back to the first one that breaks it, so the
-- work is bounded per (player, role) with an ordered lateral. Each branch is an
-- index probe on at_bats plus a bounded scan, instead of one scan of everything.
--
-- The 200-call cap is deliberate and is the only inaccuracy: a run longer than
-- 200 consecutive settled calls reports as 200. At ~30 calls per game that is
-- roughly seven perfect games in a row, which the model is not going to have —
-- and if it ever does, understating it is the harmless direction.
--
-- Pushes are skipped rather than counted as breaks: a push is not a wrong call,
-- and ending a streak on one would report the model as having gone cold when it
-- had merely landed on the number.
create or replace function player_streaks(p_from date, p_to date, p_player_ids int[])
returns table (player_id int, role text, streak int)
language sql stable security definer set search_path = public, pg_temp as $$
    with recent as (
        select pid as player_id, 'pitcher'::text as role, g.id, g.result
        from unnest(p_player_ids) as pid
        cross join lateral (
            select p.id, p.result
            from at_bats a
            join predictions p
              on p.game_pk = a.game_pk and p.at_bat_index = a.at_bat_index
            where a.pitcher_id = pid
              and p.created_at >= p_from
              and p.created_at < (p_to + 1)
              and p.result in ('win', 'loss')
            order by p.id desc
            limit 200
        ) g
        union all
        select pid, 'batter', g.id, g.result
        from unnest(p_player_ids) as pid
        cross join lateral (
            select p.id, p.result
            from at_bats a
            join predictions p
              on p.game_pk = a.game_pk and p.at_bat_index = a.at_bat_index
            where a.batter_id = pid
              and p.created_at >= p_from
              and p.created_at < (p_to + 1)
              and p.result in ('win', 'loss')
            order by p.id desc
            limit 200
        ) g
    ),
    ranked as (
        select r.player_id, r.role, r.result,
            -- Gaps and islands: within a player the two row numbers advance
            -- together only while the result is unchanged, so the leading run —
            -- and only it — has a difference of zero.
            row_number() over (partition by r.player_id, r.role order by r.id desc)
          - row_number() over (partition by r.player_id, r.role, r.result order by r.id desc) as grp
        from recent r
    )
    select k.player_id, k.role,
           (case when k.result = 'win' then count(*) else -count(*) end)::int
    from ranked k
    where k.grp = 0
    group by k.player_id, k.role, k.result;
$$;

revoke execute on function player_streaks(date, date, int[]) from anon, authenticated, public;
