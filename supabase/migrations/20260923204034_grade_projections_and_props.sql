-- Grading for the batter analytics surface, plus a player dimension on `odds`
-- so real prop lines have somewhere to land.
--
-- WHY GRADE AT ALL, WHEN THESE ARE NOT PRICED.
-- The offline promotion gate measures calibration on historical cells. That is
-- the right check before shipping, and it is not the same thing as whether the
-- numbers we actually published matched what actually happened. `ab_result`
-- passed its offline metrics and still ran ~1.4x hot in production; nobody
-- found that from a training run, they found it from graded picks.
--
-- So these rows get an outcome and nothing else. No `profit_units`, no price,
-- no wager: grading a `model_fair` projection against even money would
-- manufacture a betting record out of a market with no line. What this buys is
-- REALISED CALIBRATION -- predicted rate against observed rate on published
-- rows -- which is the evidence the whole "ship it as analytics first" ordering
-- was waiting for.
--
-- Deliberately NOT touching `predictions`, `picks`, or settle's existing
-- grading branches. The player dimension lives where the player rows already
-- are.


-- ── outcome columns ──────────────────────────────────────────────────────
alter table player_game_projections
    -- 'hit' | 'miss' | 'void'. `void` is a batter who was projected and did
    -- not bat: a late scratch, or a lineup that changed after scoring. That
    -- is not a miss, and counting it as one would drag every measured rate
    -- downward by however often clubs change their minds.
    add column if not exists result text,
    -- How many of the event actually happened (2 home runs is still a 'hit'
    -- for a >=1 projection, but the count is the honest record).
    add column if not exists actual_count int,
    add column if not exists plate_appearances int,
    add column if not exists graded_at timestamptz;

-- Ungraded rows, newest first -- the shape settle scans on every pass.
create index if not exists player_game_projections_ungraded_idx
    on player_game_projections (official_date desc)
    where result is null;


-- ── realised calibration ─────────────────────────────────────────────────
-- Predicted rate against observed rate, on rows we actually published.
--
-- This is the production counterpart of `calibration_ratio` in the offline
-- gate, and the number that says whether the gate was telling the truth. A
-- ratio near 1.0 means the published probabilities meant what they said.
--
-- Voids are excluded from both sides: a projection for a batter who never
-- batted is not evidence either way.
create or replace function projection_calibration(
    p_from date default null,
    p_to   date default null,
    p_market text default null
)
returns table (
    market          text,
    n               bigint,
    n_void          bigint,
    mean_predicted  numeric,
    observed_rate   numeric,
    calibration_ratio numeric
)
language sql stable security definer set search_path = public, pg_temp as $$
    with graded as (
        select market, probability, result
          from player_game_projections
         where result is not null
           and (p_from is null or official_date >= p_from)
           and (p_to   is null or official_date <= p_to)
           and (p_market is null or market = p_market)
    )
    select
        g.market,
        count(*) filter (where g.result <> 'void'),
        count(*) filter (where g.result =  'void'),
        round(avg(g.probability) filter (where g.result <> 'void'), 5),
        round(avg(case when g.result = 'hit' then 1.0 else 0.0 end)
              filter (where g.result <> 'void'), 5),
        round(
            avg(g.probability) filter (where g.result <> 'void')
            / nullif(avg(case when g.result = 'hit' then 1.0 else 0.0 end)
                     filter (where g.result <> 'void'), 0),
            4)
      from graded g
     group by g.market;
$$;

-- A reliability curve, for when the single ratio says something is wrong and
-- the question becomes where. Deciles of predicted probability.
create or replace function projection_reliability(
    p_market text,
    p_from date default null,
    p_to   date default null,
    p_bins int default 10
)
returns table (
    bin_lo         numeric,
    bin_hi         numeric,
    n              bigint,
    mean_predicted numeric,
    observed_rate  numeric
)
language sql stable security definer set search_path = public, pg_temp as $$
    with graded as (
        select probability,
               case when result = 'hit' then 1.0 else 0.0 end as hit,
               least(floor(probability * p_bins)::int, p_bins - 1) as bin
          from player_game_projections
         where market = p_market
           and result is not null and result <> 'void'
           and (p_from is null or official_date >= p_from)
           and (p_to   is null or official_date <= p_to)
    )
    select
        round((bin::numeric) / p_bins, 4),
        round((bin + 1)::numeric / p_bins, 4),
        count(*),
        round(avg(probability), 5),
        round(avg(hit), 5)
      from graded
     group by bin
     order by bin;
$$;

revoke execute on function projection_calibration(date, date, text)
    from anon, authenticated;
revoke execute on function projection_reliability(text, date, date, int)
    from anon, authenticated;


-- ── a player dimension on `odds` ─────────────────────────────────────────
-- Player props are per-PLAYER lines; `odds` has only ever held game-level
-- markets and is keyed on nothing finer. Nullable and additive: every
-- existing row keeps meaning exactly what it meant, and the game-level
-- markets never set it.
--
-- `odds` is append-only snapshots with no unique constraint, so this needs no
-- key change -- consumers already take the latest per
-- (game, market, source, outcome) and now additionally per player.
alter table odds
    add column if not exists player_id int;

create index if not exists odds_player_idx
    on odds (player_id, market, fetched_at desc)
    where player_id is not null;
