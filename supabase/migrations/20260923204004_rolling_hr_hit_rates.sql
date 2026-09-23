-- Home-run and hit rates on the rolling-stats tables the live scorer reads.
--
-- These exist so the `batter_hr` and `batter_hit` markets have a real serving
-- source. `model.ts::featureValue` resolves batter_hr_delta / pitcher_hr_delta
-- / batter_hit_delta / pitcher_hit_delta from these rows; without the columns
-- every one of them would resolve to 0.0 in production while training learned
-- a real coefficient for it.
--
-- That failure mode is not hypothetical. `pitcher_bb_delta` has done exactly
-- this since the first trainer -- computed for real at serving time, trained
-- as a constant zero -- and is recorded as a known defect. Shipping a market
-- whose every feature had that shape would have been the same mistake with
-- more steps, so the columns land with the market rather than after it.
--
-- Contrast with `exit_velo_avg` / `hard_hit_rate`, dropped from
-- batter_rolling_stats in 20260919000001: those could NOT be populated here,
-- because they need `launch_speed` and the live `pitches` table does not
-- capture it. These can -- `at_bats.result_detail` is in the hot table and
-- already distinguishes home_run from the other hits.

alter table pitcher_rolling_stats
    add column if not exists hit_rate numeric(6,4),
    add column if not exists hr_rate  numeric(6,4);

alter table batter_rolling_stats
    add column if not exists hit_rate numeric(6,4),
    add column if not exists hr_rate  numeric(6,4);


-- ── pitcher ──────────────────────────────────────────────────────────────
-- Unchanged except for the two new rates in `recent_abs` and the columns they
-- feed. The 30-day window, the 30-pitch floor and every existing column keep
-- their exact definitions.
create or replace function refresh_pitcher_rolling_stats()
returns int language plpgsql as $$
declare n int;
begin
    with recent as (
        select * from pitches
        where pitch_ts >= now() - interval '30 days' and pitcher_id is not null
    ),
    swings as (
        select pitcher_id,
            count(*) filter (where zone between 1 and 9) as in_zone,
            count(*) as total,
            count(*) filter (where description in ('swinging_strike','foul') or result_category = 'in_play') as swung,
            count(*) filter (where (description in ('swinging_strike','foul') or result_category = 'in_play') and zone > 9) as chased,
            count(*) filter (where zone > 9) as out_zone,
            count(*) filter (where description = 'swinging_strike') as whiffs,
            count(*) filter (where (description = 'foul' or result_category = 'in_play')) as contact,
            avg(start_speed) filter (where pitch_type in ('FF','FT','SI','FC')) as fb_velo,
            avg(start_speed) filter (where pitch_type not in ('FF','FT','SI','FC')) as os_velo
        from recent group by pitcher_id
    ),
    recent_abs as (
        select pitcher_id,
            count(*) as n_abs,
            avg(case when result = 'strikeout' then 1.0 else 0.0 end) as k_rate,
            avg(case when result = 'walk' then 1.0 else 0.0 end) as bb_rate,
            -- `result` for hits, `result_detail` for home runs: `result`
            -- collapses single/double/triple/home_run into one `hit` bucket,
            -- so a home-run rate is unreachable from it.
            avg(case when result = 'hit' then 1.0 else 0.0 end) as hit_rate,
            avg(case when result_detail = 'home_run' then 1.0 else 0.0 end) as hr_rate
        from at_bats
        where end_ts >= now() - interval '30 days' and pitcher_id is not null
        group by pitcher_id
    ),
    merged as (
        select s.pitcher_id,
            s.total as sample_pitches,
            coalesce(a.n_abs, 0) as sample_abs,
            case when s.total > 0 then s.in_zone::numeric / s.total end as zone_rate,
            case when s.out_zone > 0 then s.chased::numeric / s.out_zone end as chase_rate_against,
            case when s.swung > 0 then s.whiffs::numeric / s.swung end as whiff_rate,
            s.fb_velo, s.os_velo, a.k_rate, a.bb_rate, a.hit_rate, a.hr_rate,
            case when s.swung > 0 then s.contact::numeric / s.swung end as contact_rate_against
        from swings s left join recent_abs a using (pitcher_id)
        where s.total >= 30
    )
    insert into pitcher_rolling_stats as t (
        pitcher_id, sample_pitches, sample_abs, zone_rate, chase_rate_against,
        whiff_rate, avg_fastball_velo, avg_offspeed_velo, k_rate, bb_rate,
        hit_rate, hr_rate, contact_rate_against, updated_at
    )
    select pitcher_id, sample_pitches, sample_abs, round(zone_rate, 4),
           round(chase_rate_against, 4), round(whiff_rate, 4),
           round(fb_velo::numeric, 1), round(os_velo::numeric, 1),
           round(k_rate, 4), round(bb_rate, 4),
           round(hit_rate, 4), round(hr_rate, 4),
           round(contact_rate_against, 4), now()
    from merged
    on conflict (pitcher_id) do update set
        sample_pitches = excluded.sample_pitches,
        sample_abs = excluded.sample_abs,
        zone_rate = excluded.zone_rate,
        chase_rate_against = excluded.chase_rate_against,
        whiff_rate = excluded.whiff_rate,
        avg_fastball_velo = excluded.avg_fastball_velo,
        avg_offspeed_velo = excluded.avg_offspeed_velo,
        k_rate = excluded.k_rate,
        bb_rate = excluded.bb_rate,
        hit_rate = excluded.hit_rate,
        hr_rate = excluded.hr_rate,
        contact_rate_against = excluded.contact_rate_against,
        updated_at = now();
    get diagnostics n = row_count;
    return n;
end $$;


-- ── batter ───────────────────────────────────────────────────────────────
create or replace function refresh_batter_rolling_stats()
returns int language plpgsql as $$
declare n int;
begin
    with recent as (
        select * from pitches
        where pitch_ts >= now() - interval '30 days' and batter_id is not null
    ),
    swings as (
        select batter_id,
            count(*) as total,
            count(*) filter (where description in ('swinging_strike','foul') or result_category = 'in_play') as swung,
            count(*) filter (where (description in ('swinging_strike','foul') or result_category = 'in_play') and zone > 9) as chased,
            count(*) filter (where zone > 9) as out_zone,
            count(*) filter (where (description = 'foul' or result_category = 'in_play')) as contact
        from recent group by batter_id
    ),
    recent_pas as (
        select batter_id,
            count(*) as n_pas,
            avg(case when result = 'strikeout' then 1.0 else 0.0 end) as k_rate,
            avg(case when result = 'walk' then 1.0 else 0.0 end) as bb_rate,
            avg(case when result = 'hit' then 1.0 else 0.0 end) as hit_rate,
            avg(case when result_detail = 'home_run' then 1.0 else 0.0 end) as hr_rate
        from at_bats
        where end_ts >= now() - interval '30 days' and batter_id is not null
        group by batter_id
    ),
    merged as (
        select s.batter_id,
            coalesce(p.n_pas, 0) as sample_pas,
            case when s.out_zone > 0 then s.chased::numeric / s.out_zone end as chase_rate,
            case when s.swung > 0 then s.contact::numeric / s.swung end as contact_rate,
            p.k_rate, p.bb_rate, p.hit_rate, p.hr_rate
        from swings s left join recent_pas p using (batter_id)
        where s.total >= 30
    )
    insert into batter_rolling_stats as t (
        batter_id, sample_pas, chase_rate, contact_rate, k_rate, bb_rate,
        hit_rate, hr_rate, updated_at
    )
    select batter_id, sample_pas, round(chase_rate, 4), round(contact_rate, 4),
           round(k_rate, 4), round(bb_rate, 4),
           round(hit_rate, 4), round(hr_rate, 4), now()
    from merged
    on conflict (batter_id) do update set
        sample_pas = excluded.sample_pas,
        chase_rate = excluded.chase_rate,
        contact_rate = excluded.contact_rate,
        k_rate = excluded.k_rate,
        bb_rate = excluded.bb_rate,
        hit_rate = excluded.hit_rate,
        hr_rate = excluded.hr_rate,
        updated_at = now();
    get diagnostics n = row_count;
    return n;
end $$;
