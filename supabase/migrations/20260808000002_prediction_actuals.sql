-- Persist what actually happened, alongside whether we were right.
--
-- `predictions` has always stored `result` ('win'/'loss'/'push'/'void') and
-- thrown the underlying outcome away. settle's gradeRow() computes it for every
-- market -- the speed of the next pitch, its result_category, the at-bat's
-- result, its pitch count, the winning side -- compares it, and discards it.
--
-- Two consequences, both of which this fixes:
--
--   1. The Data Feed cannot render "predicted 94.2, actual 93.1, err +1.1"
--      from `predictions` alone. Until now it rebuilt that in browser memory by
--      grading each pitch as it arrived, which meant every user saw a different
--      table and it died on refresh.
--   2. The R2 holdout export carries predictions with no actuals, so any
--      out-of-sample scoring has to re-join `pitches` -- against data Postgres
--      deletes after 35 days.
--
-- Two columns, not one, because the markets are not the same shape:
--
--   actual_value  numeric  the measured quantity: start_speed for
--                          pitch_speed_ou, pitch_count for ab_pitches_ou,
--                          the winning margin for game_moneyline
--   actual_label  text     the categorical outcome: result_category for
--                          pitch_result, the at-bat result for ab_result,
--                          'over'/'under' or 'home'/'away' elsewhere
--
-- Collapsing them into one text column would make every numeric comparison a
-- cast, and `game_predictions.actual_value` is already numeric -- keeping the
-- name and type aligned means one mental model across both tables.

alter table predictions
    add column if not exists actual_value numeric,
    add column if not exists actual_label text;

comment on column predictions.actual_value is
    'What actually happened, as a number. Written by settle at grading time.';
comment on column predictions.actual_label is
    'What actually happened, as a category. Written by settle at grading time.';

-- Rows graded before this migration keep NULL actuals. Deliberately not
-- backfilled: reconstructing them means re-joining `pitches`, which only
-- reaches 35 days, so a backfill would silently cover part of the range and
-- leave the rest null anyway. The read path treats null as "not recorded"
-- rather than as a missing value to be inferred.

-- The per-pitch feed queries by day. `predictions` carries no date column, so
-- the endpoint resolves today's game_pks from `games` and filters on those --
-- this index is what keeps that ordered, paginated scan cheap as the table
-- grows back toward its 21-day steady state.
create index if not exists predictions_game_market_id_idx
    on predictions (game_pk, market, id desc);
