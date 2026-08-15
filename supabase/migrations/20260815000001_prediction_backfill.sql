-- Provenance for reconstructed predictions.
--
-- live-poll now scores every pitch position rather than one per poll, but the
-- stored history still carries the holes the old writer left: on 2026-08-14
-- only 2,459 of 4,062 pitches (60.5%) had a prediction made into them, and 93
-- at-bats had none at all. backfill-predictions fills those in from the stored
-- `pitches` rows.
--
-- Those rows are NOT equivalent to a live call, and this column is what keeps
-- that auditable rather than implicit:
--
--   1. They are scored after the pitch landed. The context is reconstructed
--      from the count as it stood, so there is no look-ahead in the FEATURES —
--      but nobody could have wagered on the call, because it did not exist.
--   2. They are scored with TODAY'S pitcher_rolling_stats / batter_rolling_stats,
--      which are a trailing 30-day snapshot refreshed nightly. The rolling
--      figures that stood on the day in question are gone. A backfilled call is
--      therefore the call the model would make now about a past pitch, not the
--      call it would have made then.
--
-- Anything reporting model accuracy as a track record should filter on
-- `backfilled_at is null`. It is left in the headline aggregates by product
-- decision; the column exists so that decision can be revisited without
-- re-deriving which rows were reconstructed.
alter table predictions
    add column if not exists backfilled_at timestamptz;

comment on column predictions.backfilled_at is
    'Set when the row was reconstructed after the fact by backfill-predictions '
    'rather than written live by live-poll. Non-null rows were scored with '
    'current rolling stats and were never available to bet. Filter on IS NULL '
    'for a true live track record.';

-- Partial: the overwhelming majority of rows are live (NULL) and never need to
-- be found this way, so only the reconstructed ones are indexed.
create index if not exists predictions_backfilled_idx
    on predictions (backfilled_at)
    where backfilled_at is not null;

-- Per-pitch coverage for a single date, which is what the backfill is trying to
-- drive to 100% and the only honest way to confirm it worked.
--
-- The join is off by one on purpose: predictions.pitch_number is a POSITION (k
-- pitches already thrown, so the call is about pitch k+1) while
-- pitches.pitch_number is 1-based. The call about pitch n is stamped n-1.
create or replace function prediction_pitch_coverage(p_date date)
returns table (
    game_pk        bigint,
    pitches        bigint,
    covered        bigint,
    backfilled     bigint,
    pct_covered    numeric
) language sql stable security definer set search_path = public, pg_temp as $$
    with slate as (
        select g.game_pk from games g where g.official_date = p_date
    ),
    pi as (
        select p.game_pk, p.at_bat_index, p.pitch_number
        from pitches p join slate s on s.game_pk = p.game_pk
    ),
    pr as (
        select distinct pr.game_pk, pr.at_bat_index,
               pr.pitch_number + 1 as predicts_pitch,
               (pr.backfilled_at is not null) as was_backfilled
        from predictions pr join slate s on s.game_pk = pr.game_pk
        where pr.market = 'pitch_result' and pr.pitch_number is not null
    )
    select pi.game_pk,
           count(*)::bigint,
           count(pr.predicts_pitch)::bigint,
           count(*) filter (where pr.was_backfilled)::bigint,
           round(100.0 * count(pr.predicts_pitch) / nullif(count(*), 0), 1)
    from pi
    left join pr
      on pr.game_pk = pi.game_pk
     and pr.at_bat_index = pi.at_bat_index
     and pr.predicts_pitch = pi.pitch_number
    group by pi.game_pk
    order by pi.game_pk;
$$;

revoke execute on function prediction_pitch_coverage(date) from anon, authenticated, public;
