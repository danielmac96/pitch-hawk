-- Backfill actual_value / actual_label onto predictions graded before those
-- columns existed.
--
-- 20260808000002 added the columns and taught settle to write them, but settle
-- only ever selects `where result is null` -- it grades a row once and never
-- returns to it. Every row graded before that migration landed therefore kept
-- its result and its profit_units and got no actual at all: 242,807 of 242,865
-- graded rows on 2026-08-16.
--
-- That is not a cosmetic gap. The Data Feed's per-pitch log drops a velo row
-- outright when the actual is missing (frontend/pitchhawk.js, dfRow):
--
--     if (r.predicted_value == null || r.actual_value == null) return null;
--
-- so the entire VELO half of every past slate rendered as nothing rather than
-- as an incomplete row. The class half survived but showed "—" for actual.
--
-- The measurements are still recoverable because `pitches` and `at_bats` keep a
-- 35-day hot window (20260802000003) while `predictions` is pruned at 21
-- (20260728000002) -- the evidence outlives the rows that need it. That margin
-- is what makes this migration possible at all, and it is why this runs now
-- rather than later.
--
-- This writes ONLY the two actual_* columns. `result`, `profit_units` and
-- `graded_at` are left exactly as settle decided them: the outcome of a call is
-- history, and re-deriving it here would risk silently restating the track
-- record. We are recording what happened, not re-grading what was called.

-- Scoped to finished games throughout, via an EXISTS against games_pkey. In a
-- live game `at_bats.result` and `at_bats.pitch_count` are still moving, so
-- reading them now would not reproduce what settle saw at grade time --
-- verified against the 144 rows settle had populated on 2026-08-16, every one
-- of which belonged to an In Progress game and disagreed with a current read.
-- Rows on live games are left alone; settle fills them as those games finish.
--
-- Each statement plans as a nested loop driven by an index scan on
-- pitches_game_pk_at_bat_index_pitch_number_key (the row-value comparison below
-- is an index condition, not a filter), measured at ~1.1s for 55k rows.

-- 1. pitch_speed_ou -- the measured speed, plus the over/under side.
--
-- "Next pitch" is the next one in GAME order, not the next in this at-bat:
-- settle's nextPitch() takes the minimum (at_bat_index, pitch_number) strictly
-- greater than the row's, so the pitch following the last one of an at-bat is
-- the first of the next at-bat. The row-value comparison below is exactly that
-- ordering. Note this is deliberately NOT the `pitch_number + 1` join used by
-- pitch_prediction_coverage (20260814000001) -- that one asks "was a call made
-- about this pitch" within an at-bat, a different question.
--
-- value is the speed itself rather than the side, because the feed shows the
-- miss in mph and the side alone cannot express it (see 20260808000002).
-- The lateral is resolved in a CTE rather than inline in UPDATE ... FROM,
-- because Postgres will not let a LATERAL in an UPDATE's FROM list reference
-- the update target (42P10: "invalid reference to FROM-clause entry"). Inside
-- the CTE `p` is an ordinary FROM entry, so the correlation is legal.
with nxt as (
  select p.id, n.start_speed
    from predictions p
    join lateral (
          select pi.start_speed
            from pitches pi
           where pi.game_pk = p.game_pk
             and (pi.at_bat_index, pi.pitch_number) > (p.at_bat_index, p.pitch_number)
           order by pi.at_bat_index, pi.pitch_number
           limit 1
         ) n on true
   where p.market = 'pitch_speed_ou'
     and p.result in ('win', 'loss', 'push')
     and p.actual_value is null
     and p.actual_label is null
     and p.line is not null
     and n.start_speed is not null
     and exists (select 1 from games g where g.game_pk = p.game_pk
                 and g.status in ('Final', 'Game Over', 'Completed Early'))
)
update predictions t
   set actual_value = nxt.start_speed,
       actual_label = case when nxt.start_speed > t.line then 'over' else 'under' end
  from nxt
 where t.id = nxt.id;

-- 2. pitch_result -- categorical only. settle passes value as null here
-- (decide(cat, null, cat)); a class call has no measured quantity, and putting
-- one there would invent a number the model never produced.
with nxt as (
  select p.id, n.result_category
    from predictions p
    join lateral (
          select pi.result_category
            from pitches pi
           where pi.game_pk = p.game_pk
             and (pi.at_bat_index, pi.pitch_number) > (p.at_bat_index, p.pitch_number)
           order by pi.at_bat_index, pi.pitch_number
           limit 1
         ) n on true
   where p.market = 'pitch_result'
     and p.result in ('win', 'loss', 'push')
     and p.actual_value is null
     and p.actual_label is null
     and n.result_category is not null
     and exists (select 1 from games g where g.game_pk = p.game_pk
                 and g.status in ('Final', 'Game Over', 'Completed Early'))
)
update predictions t
   set actual_label = nxt.result_category
  from nxt
 where t.id = nxt.id;

-- 3. ab_result -- categorical, same reasoning as pitch_result.
update predictions p
   set actual_label = ab.result
  from at_bats ab
 where ab.game_pk = p.game_pk
   and ab.at_bat_index = p.at_bat_index
   and p.market = 'ab_result'
   and p.result in ('win', 'loss', 'push')
   and p.actual_value is null
   and p.actual_label is null
   and ab.result is not null
   and exists (select 1 from games g where g.game_pk = p.game_pk
               and g.status in ('Final', 'Game Over', 'Completed Early'));

-- 4. ab_pitches_ou -- the realized pitch count, with push on an exact line
-- match (settle grades an exact match as a push, not an over).
update predictions p
   set actual_value = ab.pitch_count,
       actual_label = case
                        when ab.pitch_count = p.line then 'push'
                        when ab.pitch_count > p.line then 'over'
                        else 'under'
                      end
  from at_bats ab
 where ab.game_pk = p.game_pk
   and ab.at_bat_index = p.at_bat_index
   and p.market = 'ab_pitches_ou'
   and p.result in ('win', 'loss', 'push')
   and p.actual_value is null
   and p.actual_label is null
   and ab.pitch_count is not null
   and p.line is not null
   and exists (select 1 from games g where g.game_pk = p.game_pk
               and g.status in ('Final', 'Game Over', 'Completed Early'));

-- 5. game_moneyline -- value is the signed margin (home - away), label the
-- winning side. A tie carries margin 0 and label 'tie', matching settle's
-- explicit push branch.
update predictions p
   set actual_value = g.home_score - g.away_score,
       actual_label = case
                        when g.home_score = g.away_score then 'tie'
                        when g.home_score > g.away_score then 'home'
                        else 'away'
                      end
  from games g
 where g.game_pk = p.game_pk
   and p.market = 'game_moneyline'
   and p.result in ('win', 'loss', 'push')
   and p.actual_value is null
   and p.actual_label is null
   and g.home_score is not null
   and g.away_score is not null
   and g.status in ('Final', 'Game Over', 'Completed Early');

-- Rows left NULL after this are correct, not missed: a call about a pitch that
-- was never thrown (game ended first) has no actual, which is the same reason
-- settle grades those 'void'. pitchfeed.ts already renders a null actual as an
-- absent error rather than a zero.
