-- MLB Pitch Predictor — aggregate functions for freq_v1 model
-- Apply via the Supabase SQL editor (additive; safe to re-run with create or replace).

create or replace function get_pitcher_stats()
returns table (
    pitcher_id          int,
    sample_pitches      bigint,
    avg_speed           numeric,
    strike_foul_rate    numeric,
    ball_rate           numeric,
    in_play_rate        numeric
)
language sql stable
as $$
    select
        pitcher_id,
        count(*) as sample_pitches,
        avg(start_speed)                                                  as avg_speed,
        avg(case when result_category = 'strike_foul' then 1.0 else 0.0 end) as strike_foul_rate,
        avg(case when result_category = 'ball'        then 1.0 else 0.0 end) as ball_rate,
        avg(case when result_category = 'in_play'     then 1.0 else 0.0 end) as in_play_rate
    from pitches
    where pitcher_id is not null
    group by pitcher_id
    having count(*) >= 10;
$$;

create or replace function get_pitcher_ab_stats()
returns table (
    pitcher_id      int,
    sample_abs      bigint,
    avg_pitches     numeric,
    so_rate         numeric,
    bb_rate         numeric,
    hit_rate        numeric,
    out_rate        numeric
)
language sql stable
as $$
    select
        pitcher_id,
        count(*) as sample_abs,
        avg(pitch_count)                                       as avg_pitches,
        avg(case when result = 'strikeout' then 1.0 else 0.0 end) as so_rate,
        avg(case when result = 'walk'      then 1.0 else 0.0 end) as bb_rate,
        avg(case when result = 'hit'       then 1.0 else 0.0 end) as hit_rate,
        avg(case when result = 'out'       then 1.0 else 0.0 end) as out_rate
    from at_bats
    where pitcher_id is not null
    group by pitcher_id
    having count(*) >= 5;
$$;

create or replace function get_league_averages()
returns table (
    pitch_sample        bigint,
    avg_speed           numeric,
    strike_foul_rate    numeric,
    ball_rate           numeric,
    in_play_rate        numeric,
    ab_sample           bigint,
    avg_pitches_pa      numeric,
    so_rate             numeric,
    bb_rate             numeric,
    hit_rate            numeric,
    out_rate            numeric
)
language sql stable
as $$
    select
        (select count(*) from pitches)                                                       as pitch_sample,
        (select avg(start_speed) from pitches)                                               as avg_speed,
        (select avg(case when result_category='strike_foul' then 1.0 else 0.0 end) from pitches) as strike_foul_rate,
        (select avg(case when result_category='ball'        then 1.0 else 0.0 end) from pitches) as ball_rate,
        (select avg(case when result_category='in_play'     then 1.0 else 0.0 end) from pitches) as in_play_rate,
        (select count(*) from at_bats)                                                       as ab_sample,
        (select avg(pitch_count) from at_bats)                                               as avg_pitches_pa,
        (select avg(case when result='strikeout' then 1.0 else 0.0 end) from at_bats)        as so_rate,
        (select avg(case when result='walk'      then 1.0 else 0.0 end) from at_bats)        as bb_rate,
        (select avg(case when result='hit'       then 1.0 else 0.0 end) from at_bats)        as hit_rate,
        (select avg(case when result='out'       then 1.0 else 0.0 end) from at_bats)        as out_rate;
$$;
