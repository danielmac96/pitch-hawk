-- Data Feed: grade total bases, batter strikeouts and every starter prop
-- alongside 1+ Hit / HR / H+R+RBI.
--
-- Settle already grades all of these per player-game (gradeBase); only
-- refresh_graded_reads() kept them out of graded_read, so the Data Feed and
-- /api/graded could not show a starter prop's record. This is the definition
-- from 20261008000003 with the projection branch widened; nothing else
-- changes. Line markets store their line as the subject ("Over 5.5"); a
-- starter prop's player goes in pitcher_id with no batter.
--
-- The backfill at the bottom is idempotent (on conflict do nothing).

create or replace function refresh_graded_reads(p_days int default 2)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
    d_to   date := (now() at time zone 'America/New_York')::date;
    d_from date := d_to - greatest(p_days, 1) + 1;
    n      int;
begin
    delete from graded_read where official_date between d_from and d_to;

    with gs as materialized (
        select * from games where official_date between d_from and d_to
    ),
    pr as materialized (
        select p.id, p.game_pk, p.at_bat_index, p.market, p.result, p.recommendation,
               p.actual_label, p.graded_at, p.created_at,
               coalesce((p.probs ->> p.recommendation)::numeric, p.confidence) as prob,
               row_number() over (partition by p.game_pk, p.at_bat_index, p.market
                                  order by p.pitch_number desc) as rn
          from predictions p
          join gs on gs.game_pk = p.game_pk
         where p.market in ('pitch_result', 'ab_result')
           and p.result in ('win', 'loss', 'void')
           and p.backfilled_at is null
    )
    insert into graded_read
    select 'p:' || pgp.market || ':' || pgp.game_pk || ':' || pgp.player_id,
           coalesce(pgp.graded_at, pgp.updated_at), pgp.official_date, pgp.market,
           g.game_pk, g.away_abbr, g.home_abbr, g.venue_id, g.venue_name,
           array[case when pgp.is_home then g.home_abbr else g.away_abbr end],
           case when pgp.market in ('batter_tb15', 'batter_k') or pgp.role = 'pitcher'
                then 'Over ' || trim_scale(pgp.line)::text end,
           pgp.probability, pgp.result, null,
           sp.pitch_hand, case when pgp.is_home then 'home' else 'away' end, pgp.lineup_slot,
           -- A starter prop's subject is the starter: no batter, the starter
           -- in pitcher_id (/api/graded names the row from it).
           case when pgp.role = 'pitcher' then null else pgp.player_id end,
           case when pgp.role = 'pitcher' then pgp.player_id else pgp.opposing_pitcher_id end,
           case when pgp.is_home then g.home_abbr else g.away_abbr end
      from player_game_projections pgp
      join gs g on g.game_pk = pgp.game_pk
      left join player_info sp on sp.player_id = pgp.opposing_pitcher_id
     where pgp.market in ('batter_hit', 'batter_hr', 'batter_hrr', 'batter_tb15', 'batter_k',
                          'pitcher_k', 'pitcher_outs', 'pitcher_hits', 'pitcher_er', 'pitcher_bb')
       and pgp.result in ('hit', 'miss', 'void')
       and pgp.probability is not null
       and pgp.backfilled_at is null

    union all
    select 'g:' || gp.market || ':' || gp.game_pk,
           coalesce(gp.graded_at, gp.updated_at), gp.official_date, gp.market,
           g.game_pk, g.away_abbr, g.home_abbr, g.venue_id, g.venue_name,
           array[g.away_abbr, g.home_abbr],
           case when gp.market = 'game_moneyline'
                then (case gp.recommendation when 'home' then g.home_abbr
                                             when 'away' then g.away_abbr
                                             else gp.recommendation end) || ' to win'
                else initcap(gp.recommendation) || ' ' || trim_scale(gp.line)::text end,
           coalesce((gp.probs ->> gp.recommendation)::numeric, gp.confidence),
           case gp.result when 'win' then 'hit' when 'loss' then 'miss' else 'void' end,
           null, null, null, null, null, null, null
      from game_predictions gp
      join gs g on g.game_pk = gp.game_pk
     where gp.phase = 'pregame'
       and gp.market in ('game_moneyline', 'game_total')
       and gp.result in ('win', 'loss', 'void')
       and coalesce((gp.probs ->> gp.recommendation)::numeric, gp.confidence) is not null

    union all
    select 'x:' || p.id,
           coalesce(p.graded_at, p.created_at), g.official_date, p.market,
           g.game_pk, g.away_abbr, g.home_abbr, g.venue_id, g.venue_name,
           array[g.away_abbr, g.home_abbr],
           p.recommendation,
           p.prob,
           case p.result when 'win' then 'hit' when 'loss' then 'miss' else 'void' end,
           p.actual_label,
           pi.pitch_hand,
           case when s.top_inning then 'away' when not s.top_inning then 'home' end,
           slot.lineup_slot,
           ab.batter_id, ab.pitcher_id,
           case when s.top_inning then g.away_abbr when not s.top_inning then g.home_abbr end
      from pr p
      join gs g on g.game_pk = p.game_pk
      left join at_bats ab on ab.game_pk = p.game_pk and ab.at_bat_index = p.at_bat_index
      left join player_info pi on pi.player_id = ab.pitcher_id
      left join lateral (
          select x.top_inning from pitches x
           where x.game_pk = p.game_pk and x.at_bat_index = p.at_bat_index
           limit 1
      ) s on true
      left join lateral (
          select q.lineup_slot from player_game_projections q
           where q.game_pk = p.game_pk and q.player_id = ab.batter_id
             and q.market = 'batter_hit'
           limit 1
      ) slot on true
     where (p.market = 'pitch_result' or p.rn = 1)
       and p.prob is not null;

    get diagnostics n = row_count;

    delete from graded_read
     where market in ('pitch_result', 'ab_result')
       and official_date < d_to - 35;

    return n;
end;
$$;

revoke execute on function refresh_graded_reads(int) from anon, authenticated, public;

insert into graded_read
select 'p:' || pgp.market || ':' || pgp.game_pk || ':' || pgp.player_id,
       coalesce(pgp.graded_at, pgp.updated_at), pgp.official_date, pgp.market,
       g.game_pk, g.away_abbr, g.home_abbr, g.venue_id, g.venue_name,
       array[case when pgp.is_home then g.home_abbr else g.away_abbr end],
       case when pgp.market in ('batter_tb15', 'batter_k') or pgp.role = 'pitcher'
            then 'Over ' || trim_scale(pgp.line)::text end,
       pgp.probability, pgp.result, null,
       sp.pitch_hand, case when pgp.is_home then 'home' else 'away' end, pgp.lineup_slot,
       -- A starter prop's subject is the starter: no batter, the starter
       -- in pitcher_id (/api/graded names the row from it).
       case when pgp.role = 'pitcher' then null else pgp.player_id end,
       case when pgp.role = 'pitcher' then pgp.player_id else pgp.opposing_pitcher_id end,
       case when pgp.is_home then g.home_abbr else g.away_abbr end
  from player_game_projections pgp
  join games g on g.game_pk = pgp.game_pk
  left join player_info sp on sp.player_id = pgp.opposing_pitcher_id
 where pgp.market in ('batter_tb15', 'batter_k',
                      'pitcher_k', 'pitcher_outs', 'pitcher_hits', 'pitcher_er', 'pitcher_bb')
   and pgp.result in ('hit', 'miss', 'void')
   and pgp.probability is not null
   and pgp.backfilled_at is null
on conflict (id) do nothing;
