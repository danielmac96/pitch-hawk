-- ════════════════════════════════════════════════════════════════════════
-- Base models for every market the board showed as NOT MODELED.
--
-- The formulas live in supabase/functions/_shared/basemodels.ts. They are
-- placeholders -- league rates scaled by 30-day rolling rates -- registered
-- here as version base_v1 so each market has an active model row that a
-- trained model replaces later (promote a new version; one active per market
-- is enforced by model_params_one_active). `params` may override any
-- constant in BASE_DEFAULTS without a code change.
--
--   batter_tb15, batter_hrr                      pregame, per batter
--   pitcher_k, pitcher_bb, pitcher_hits,
--   pitcher_outs, pitcher_er                     pregame, per probable starter
--   batter_hit_rog, batter_hr_rog                live rest-of-game, per batter
--   game_total_live                              live, per game
-- ════════════════════════════════════════════════════════════════════════

-- ── projection rows for the new pregame markets ─────────────────────────────
-- Starter props are a line and P(over); batter markets keep using
-- probability / expected_pa / per_pa_probability as before.
alter table player_game_projections
    add column if not exists role           text not null default 'batter'
        check (role in ('batter', 'pitcher')),
    add column if not exists line           numeric(6,2),   -- starter props: the over/under line
    add column if not exists expected_value numeric(8,4);   -- mean count (TB, Ks, outs...)

comment on column player_game_projections.probability is
    'batter markets: P(event) for the game. pitcher_* markets: P(over `line`).';

-- ── model registry ──────────────────────────────────────────────────────────
insert into model_params (market, version, params, metrics, is_active, trained_at, activated_at, notes)
select m, 'base_v1', '{"type": "base_rate"}'::jsonb, '{}'::jsonb, true, now(), now(),
       'Base model (league rates x 30-day rolling rates). Placeholder until a trained model is promoted; see _shared/basemodels.ts.'
  from unnest(array[
      'batter_tb15', 'batter_hrr',
      'pitcher_k', 'pitcher_bb', 'pitcher_hits', 'pitcher_outs', 'pitcher_er',
      'batter_hit_rog', 'batter_hr_rog', 'game_total_live'
  ]) as m
 where not exists (select 1 from model_params p where p.market = m and p.is_active)
on conflict (market, version) do nothing;

-- ── keep the Data Feed on its six markets ───────────────────────────────────
-- refresh_graded_reads copies graded batter projections; restrict it to the
-- two markets the Data Feed was designed around, so the new player markets do
-- not appear in it unlabelled. Same function as 20260930221608 otherwise.
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
    )
    insert into graded_read
    select 'p:' || pgp.market || ':' || pgp.game_pk || ':' || pgp.player_id,
           coalesce(pgp.graded_at, pgp.updated_at), pgp.official_date, pgp.market,
           g.game_pk, g.away_abbr, g.home_abbr, g.venue_id, g.venue_name,
           array[case when pgp.is_home then g.home_abbr else g.away_abbr end],
           null, pgp.probability, pgp.result, null,
           sp.pitch_hand, case when pgp.is_home then 'home' else 'away' end, pgp.lineup_slot,
           pgp.player_id, pgp.opposing_pitcher_id,
           case when pgp.is_home then g.home_abbr else g.away_abbr end
      from player_game_projections pgp
      join gs g on g.game_pk = pgp.game_pk
      left join player_info sp on sp.player_id = pgp.opposing_pitcher_id
     where pgp.market in ('batter_hit', 'batter_hr')
       and pgp.result in ('hit', 'miss', 'void')
       and pgp.probability is not null

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
