-- Training-set aggregate RPCs. Each returns weighted "cells" (grouped counts)
-- rather than raw rows, so model fitting works over any size of backfill with
-- tiny result sets. scripts/train_models.py consumes these.
--
-- Count semantics: MLB playEvents report the count AFTER the pitch, which is
-- exactly the state live predictions are made from (live_state mirrors the
-- last pitch), so training on after-pitch states matches serving.

-- Outcome counts of the NEXT pitch, grouped by current count and
-- pitcher-zone / batter-chase buckets.
create or replace function train_pitch_result_cells()
returns table (
    balls int, strikes int, zone_bucket int, chase_bucket int,
    outcome text, n bigint
) language sql stable as $$
    with pitcher_zone as (
        select pitcher_id, avg(case when zone between 1 and 9 then 1.0 else 0.0 end) as zr
        from pitches where pitcher_id is not null and zone is not null
        group by pitcher_id having count(*) >= 100
    ),
    batter_chase as (
        select batter_id,
            (count(*) filter (where (description in ('swinging_strike','foul') or result_category='in_play') and zone > 9))::numeric
              / nullif(count(*) filter (where zone > 9), 0) as cr
        from pitches where batter_id is not null and zone is not null
        group by batter_id having count(*) >= 100
    ),
    seq as (
        select p.game_pk, p.at_bat_index, p.pitch_number, p.pitcher_id, p.batter_id,
            p.result_category,
            coalesce(lag(p.balls)  over w, 0) as pre_balls,
            coalesce(lag(p.strikes) over w, 0) as pre_strikes
        from pitches p
        window w as (partition by p.game_pk, p.at_bat_index order by p.pitch_number)
    )
    select s.pre_balls, s.pre_strikes,
        least(2, greatest(-2, coalesce(round((pz.zr - 0.48) / 0.03), 0)))::int as zone_bucket,
        least(2, greatest(-2, coalesce(round((bc.cr - 0.28) / 0.04), 0)))::int as chase_bucket,
        s.result_category, count(*)
    from seq s
    left join pitcher_zone pz using (pitcher_id)
    left join batter_chase bc using (batter_id)
    where s.result_category is not null
      and s.pre_balls between 0 and 3 and s.pre_strikes between 0 and 2
    group by 1, 2, 3, 4, 5;
$$;

-- At-bat outcome counts by current count and pitcher/batter K-rate buckets +
-- platoon flag. States are every after-pitch count in the AB plus the 0-0 start.
create or replace function train_ab_result_cells()
returns table (
    balls int, strikes int, pk_bucket int, bk_bucket int,
    platoon_same int, outcome text, n bigint
) language sql stable as $$
    with pitcher_k as (
        select pitcher_id,
            avg(case when result = 'strikeout' then 1.0 else 0.0 end) as kr,
            avg(case when result = 'walk' then 1.0 else 0.0 end) as br
        from at_bats where pitcher_id is not null
        group by pitcher_id having count(*) >= 50
    ),
    batter_k as (
        select batter_id, avg(case when result = 'strikeout' then 1.0 else 0.0 end) as kr
        from at_bats where batter_id is not null
        group by batter_id having count(*) >= 50
    ),
    states as (
        -- 0-0 pre-first-pitch state
        select a.game_pk, a.at_bat_index, a.pitcher_id, a.batter_id, a.result,
               0 as balls, 0 as strikes
        from at_bats a where a.result is not null
        union all
        -- every mid-AB after-pitch state (excluding the AB-ending pitch)
        select a.game_pk, a.at_bat_index, a.pitcher_id, a.batter_id, a.result,
               p.balls, p.strikes
        from at_bats a
        join pitches p using (game_pk, at_bat_index)
        where a.result is not null and p.pitch_number < a.pitch_count
          and p.balls between 0 and 3 and p.strikes between 0 and 2
    )
    select st.balls, st.strikes,
        least(2, greatest(-2, coalesce(round((pk.kr - 0.221) / 0.035), 0)))::int,
        least(2, greatest(-2, coalesce(round((bk.kr - 0.221) / 0.035), 0)))::int,
        case when pi.pitch_hand is not null and bi.bat_side in ('L','R')
             and pi.pitch_hand = bi.bat_side then 1 else 0 end,
        st.result, count(*)
    from states st
    left join pitcher_k pk using (pitcher_id)
    left join batter_k bk using (batter_id)
    left join player_info pi on pi.player_id = st.pitcher_id
    left join player_info bi on bi.player_id = st.batter_id
    group by 1, 2, 3, 4, 5, 6;
$$;

-- Next-pitch speed stats by pitcher-velocity bucket, count, and pitch-of-PA.
create or replace function train_pitch_speed_cells()
returns table (
    velo_bucket numeric, balls int, strikes int, pitch_of_pa int,
    n bigint, mean_speed numeric, var_speed numeric
) language sql stable as $$
    with pitcher_velo as (
        select pitcher_id, avg(start_speed) filter (where pitch_type in ('FF','FT','SI','FC')) as fb
        from pitches where pitcher_id is not null and start_speed is not null
        group by pitcher_id
        having count(*) filter (where pitch_type in ('FF','FT','SI','FC')) >= 50
    ),
    seq as (
        select p.pitcher_id, p.start_speed, p.pitch_number,
            coalesce(lag(p.balls)  over w, 0) as pre_balls,
            coalesce(lag(p.strikes) over w, 0) as pre_strikes
        from pitches p
        where p.start_speed is not null
        window w as (partition by p.game_pk, p.at_bat_index order by p.pitch_number)
    )
    select round(pv.fb)::numeric, s.pre_balls, s.pre_strikes,
        least(s.pitch_number, 8), count(*),
        avg(s.start_speed), var_samp(s.start_speed)
    from seq s join pitcher_velo pv using (pitcher_id)
    where s.pre_balls between 0 and 3 and s.pre_strikes between 0 and 2
    group by 1, 2, 3, 4
    having count(*) >= 20;
$$;

-- Distribution of REMAINING pitches in the AB by current count.
create or replace function train_ab_pitches_cells()
returns table (balls int, strikes int, remaining int, n bigint)
language sql stable as $$
    with states as (
        select 0 as balls, 0 as strikes, a.pitch_count as remaining
        from at_bats a where a.pitch_count is not null and a.pitch_count > 0
        union all
        select p.balls, p.strikes, a.pitch_count - p.pitch_number
        from at_bats a
        join pitches p using (game_pk, at_bat_index)
        where a.pitch_count is not null and p.pitch_number < a.pitch_count
          and p.balls between 0 and 3 and p.strikes between 0 and 2
    )
    select balls, strikes, least(remaining, 12), count(*)
    from states where remaining >= 1
    group by 1, 2, 3;
$$;

-- Home-field advantage estimate for the log5 moneyline model.
create or replace function train_home_advantage()
returns table (games bigint, home_win_rate numeric)
language sql stable as $$
    select count(*),
        avg(case when home_score > away_score then 1.0 else 0.0 end)
    from games
    where status like 'Final%' and home_score is not null and away_score is not null
      and home_score <> away_score;
$$;
