-- /api/graded/summary: add 5-point calibration bands below 30%.
--
-- The Data Feed's calibration chart uses 10-point bands, which put every HR
-- read (and every low-line or longshot read) into the 0-10 and 10-20 bars, so
-- a model calling +300 and +600 home runs could not be judged where it
-- matters. This is the definition from 20260930221608 with one key added,
-- `bins_fine`; every existing key is unchanged.

create or replace function graded_summary(
    p_from   date,
    p_to     date,
    p_market text default null,
    p_team   text default null,
    p_venue  int  default null,
    p_hand   text default null,
    p_side   text default null
)
returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
    with f as (
        select r.official_date, r.market, r.team_abbrs, r.probability::float8 as p,
               r.opp_pitcher_hand, r.batting_side, r.lineup_slot,
               case when r.result = 'hit' then 1.0 else 0.0 end::float8 as o,
               (p_market is null or r.market = p_market)          as ok_mk,
               (p_team   is null or p_team = any(r.team_abbrs))   as ok_team,
               (r.official_date >= p_from)                        as ok_tf,
               (p_venue  is null or r.venue_id = p_venue)
                 and (p_hand is null or r.opp_pitcher_hand = p_hand)
                 and (p_side is null or r.batting_side = p_side)  as ok_rest
          from graded_read r
         where r.official_date between least(p_from, p_to - 6) and p_to
           and r.result <> 'void'
    ),
    cur as (select * from f where ok_mk and ok_team and ok_tf and ok_rest)
    select jsonb_build_object(
        'overall', (select jsonb_build_object(
                        'n', count(*), 'exp', avg(p), 'act', avg(o), 'brier', avg((p - o) ^ 2))
                      from cur),
        'bins', coalesce((select jsonb_agg(x.b order by x.k) from (
                    select least(floor(p * 10), 9)::int as k,
                           jsonb_build_object('bin', least(floor(p * 10), 9)::int,
                               'n', count(*), 'exp', avg(p), 'act', avg(o), 'brier', avg((p - o) ^ 2)) as b
                      from cur group by 1) x), '[]'::jsonb),
        -- 5-point bands below 30%, where HR, longshot and low-line reads
        -- live: 10-point bands put every one of them in two bars.
        'bins_fine', coalesce((select jsonb_agg(x.b order by x.k) from (
                    select floor(p * 20)::int as k,
                           jsonb_build_object('lo', floor(p * 20)::int * 5, 'hi', floor(p * 20)::int * 5 + 5,
                               'n', count(*), 'exp', avg(p), 'act', avg(o), 'brier', avg((p - o) ^ 2)) as b
                      from cur where p < 0.3 group by 1) x), '[]'::jsonb),
        'daily', coalesce((select jsonb_agg(x.b order by x.k) from (
                    select official_date as k,
                           jsonb_build_object('date', official_date,
                               'n', count(*), 'exp', avg(p), 'act', avg(o), 'brier', avg((p - o) ^ 2)) as b
                      from f where ok_mk and ok_team and ok_rest group by official_date) x), '[]'::jsonb),
        'by_market', coalesce((select jsonb_agg(x.b) from (
                    select jsonb_build_object('market', market,
                               'n', count(*), 'exp', avg(p), 'act', avg(o), 'brier', avg((p - o) ^ 2)) as b
                      from f where ok_team and ok_tf and ok_rest group by market) x), '[]'::jsonb),
        'by_team', coalesce((select jsonb_agg(x.b) from (
                    select jsonb_build_object('team', tm,
                               'n', count(*), 'exp', avg(p), 'act', avg(o), 'brier', avg((p - o) ^ 2)) as b
                      from f, unnest(team_abbrs) tm
                     where ok_mk and ok_tf and ok_rest group by tm) x), '[]'::jsonb),
        'splits', coalesce((select jsonb_agg(x.b order by x.ord) from (
                    select k.ord,
                           jsonb_build_object('group', k.grp, 'label', k.label,
                               'n', count(c.p), 'exp', avg(c.p), 'act', avg(c.o),
                               'brier', avg((c.p - c.o) ^ 2)) as b
                      from (values
                          (1, 'PITCHER', 'vs LHP'), (2, 'PITCHER', 'vs RHP'),
                          (3, 'SIDE', 'Batting at home'), (4, 'SIDE', 'Batting away'),
                          (5, 'ORDER', 'Slots 1–3'), (6, 'ORDER', 'Slots 4–6'),
                          (7, 'ORDER', 'Slots 7–9')) k(ord, grp, label)
                      left join cur c on case k.ord
                          when 1 then c.opp_pitcher_hand = 'L'
                          when 2 then c.opp_pitcher_hand = 'R'
                          when 3 then c.batting_side = 'home'
                          when 4 then c.batting_side = 'away'
                          when 5 then c.lineup_slot between 1 and 3
                          when 6 then c.lineup_slot between 4 and 6
                          else c.lineup_slot between 7 and 9 end
                     group by k.ord, k.grp, k.label) x), '[]'::jsonb)
    );
$$;

revoke execute on function graded_summary(date, date, text, text, int, text, text) from anon, authenticated, public;
