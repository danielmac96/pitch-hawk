-- model_ratings: the serving copy of the as-of ratings every v3 market reads.
--
-- WHY. The batter markets were fitted on career/d30/d90 rates from R2 and
-- served from 30-day rates in batter_rolling_stats -- same names, different
-- quantities -- and the published probabilities ran 1.25x (hits) to 1.37x
-- (home runs) hot. modeling/ratings.py now defines a rating ONCE, as a
-- function of the plate-appearance history before a date; training computes
-- it as of every historical game day and `python -m modeling publish-ratings`
-- computes the same function as of today and writes it here. The edge
-- functions read this table, never the rolling stats, for model inputs.
--
-- One row per (kind, id):
--   kind 'bat'    a batter          c0..c6 = per-PA class rates
--   kind 'pit'    a pitcher         c0..c6 = class rates allowed
--   kind 'pen'    a team's relievers, pooled (id = team_id)
--   kind 'park'   a venue           c0..c6 = per-class park factors (1 = neutral)
--   kind 'league' id 0              c0..c6 = league class rates
--   kind 'team'   a team's starters' leash (extra.outs_mean)
-- Class order: K, BB(+HBP), 1B, 2B, 3B, HR, OUT -- modeling/ratings.CLASSES.
--
-- `extra` carries what is not a class rate: handedness, a starter's workload
-- history (outs/bf/pitches per start, days since his last appearance).
--
-- Published with the display aggregates' stage-and-swap, so a failed build
-- never blanks it: serving keeps yesterday's ratings.

create table if not exists model_ratings (
    kind        text   not null,
    id          bigint not null,
    as_of       date   not null,
    n_eff       double precision,
    c0 double precision, c1 double precision, c2 double precision,
    c3 double precision, c4 double precision, c5 double precision,
    c6 double precision,
    extra       jsonb  not null default '{}'::jsonb,
    updated_at  timestamptz not null default now(),
    primary key (kind, id)
);
create table if not exists model_ratings_staging (like model_ratings including defaults);

-- The whitelist gains one name; everything else about it is unchanged.
create or replace function publishable_aggregates()
returns text[] language sql immutable
set search_path = public, pg_temp as $$
    select array[
        'pitcher_profiles',
        'batter_profiles',
        'situational_splits',
        'pitcher_fatigue_profile',
        'batter_power_profile',
        'game_context',
        'matchup_history',
        'batted_ball_profile',
        'park_hr_factors',
        'model_ratings'
    ]
$$;
revoke execute on function publishable_aggregates() from anon, authenticated;

create or replace function aggregate_freshness()
returns table (table_name text, rows bigint, updated_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
    select 'pitcher_profiles',        count(*), max(updated_at) from pitcher_profiles
    union all select 'batter_profiles',         count(*), max(updated_at) from batter_profiles
    union all select 'situational_splits',      count(*), max(updated_at) from situational_splits
    union all select 'pitcher_fatigue_profile', count(*), max(updated_at) from pitcher_fatigue_profile
    union all select 'batter_power_profile',    count(*), max(updated_at) from batter_power_profile
    union all select 'game_context',            count(*), max(updated_at) from game_context
    union all select 'matchup_history',         count(*), max(updated_at) from matchup_history
    union all select 'batted_ball_profile',     count(*), max(updated_at) from batted_ball_profile
    union all select 'park_hr_factors',         count(*), max(updated_at) from park_hr_factors
    union all select 'model_ratings',           count(*), max(updated_at) from model_ratings
$$;

-- Readable like the other aggregates; the staging twin has RLS and no policy.
do $$
declare
    readers text := (select string_agg(quote_ident(rolname), ', ')
                     from pg_roles where rolname in ('anon','authenticated'));
begin
    alter table model_ratings enable row level security;
    alter table model_ratings_staging enable row level security;
    if readers is not null then
        drop policy if exists model_ratings_read on model_ratings;
        execute format(
            'create policy model_ratings_read on model_ratings for select to %s using (true)',
            readers);
    end if;
end $$;
