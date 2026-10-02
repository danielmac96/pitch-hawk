-- ════════════════════════════════════════════════════════════════════════
-- Data Feed: one row per resolved read, and the aggregates over them.
--
-- The redesigned Data Feed (design/redesign/DATA_CONTRACT.md) filters every
-- graded read by market, team, venue, opposing starter's hand and batting
-- side. No source table carries all of those, and deriving them on request
-- is too slow: `predictions` is scanned in ~3s for a 30-day window before a
-- single join (measured 2026-09-30), and /graded is paged 40 rows at a time.
-- So the reads are materialised into `graded_read`, refreshed on a schedule,
-- and /api/graded pages that table directly:
--
--   refresh_graded_reads(days)  rebuilds the last N Eastern days from source
--   graded_venues()             the stadium list for the filter
--   graded_summary(...)         jsonb aggregates; /api/graded/summary
--
-- A "read" is one call graded once, at the probability it carried when its
-- market locked:
--   batter_hit / batter_hr   player_game_projections (one row per batter-game)
--   game_moneyline / total   game_predictions, phase = 'pregame' only
--   pitch_result             predictions, every pitch
--   ab_result                predictions, the LAST call of each at-bat only --
--                            every pitch's ab_result row is graded, and
--                            counting all of them would weight long at-bats
--                            several times over
--
-- `result` uses the UI's vocabulary: 'hit' (landed), 'miss', or 'void' (DNP /
-- did not resolve). Pushes are dropped -- a total that lands on its line is
-- neither. Ungraded rows never enter, so a pending read is never a miss.
--
-- Game-level markets have no batting side, hand or slot; those are null, and a
-- hand/side filter excludes them (the UI says so).
--
-- Size: ~6k rows a day, ids not names. Pitch and at-bat rows are pruned at 35
-- days with the hot window they come from; the rest are kept.
-- ════════════════════════════════════════════════════════════════════════

create table if not exists graded_read (
    id               text primary key,
    resolved_at      timestamptz not null,
    official_date    date not null,
    market           text not null,
    game_pk          bigint not null,
    away_abbr        text,
    home_abbr        text,
    venue_id         int,
    venue_name       text,
    team_abbrs       text[] not null,   -- batter's team for batter markets; both teams otherwise
    subject          text,              -- "PHI to win" | "Over 8.5" | outcome key; null = batter name
    probability      numeric(6,4) not null,
    result           text not null check (result in ('hit', 'miss', 'void')),
    actual_label     text,
    opp_pitcher_hand text,
    batting_side     text,
    lineup_slot      smallint,
    batter_id        int,
    pitcher_id       int,
    batter_team      text
);
create index if not exists graded_read_date_idx   on graded_read (official_date desc, resolved_at desc);
create index if not exists graded_read_market_idx on graded_read (market, official_date desc);
alter table graded_read enable row level security;   -- no policies: service role only


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
        -- rn = 1 marks an at-bat's last call. Computed over graded rows: an
        -- at-bat is graded as a unit when it ends.
        -- Only the columns the insert reads: carrying the whole row made the
        -- window sort spill to disk.
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
    -- 1+ Hit / 1+ HR
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
     where pgp.result in ('hit', 'miss', 'void')
       and pgp.probability is not null

    union all
    -- Win prob and totals: the pregame call only. game_total has no probs
    -- map; its confidence is P(side).
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
    -- Pitch calls, and each at-bat's last call.
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
           limit 1
      ) slot on true
     where (p.market = 'pitch_result' or p.rn = 1)
       and p.prob is not null;

    get diagnostics n = row_count;

    -- Pitch and at-bat reads follow their source's hot window.
    delete from graded_read
     where market in ('pitch_result', 'ab_result')
       and official_date < d_to - 35;

    return n;
end;
$$;


-- The stadiums that have graded reads, labelled with the club that played
-- its most recent game there (so a neutral site gets whoever was "home").
create or replace function graded_venues()
returns table (venue_id int, venue_name text, home_abbr text)
language sql stable security definer set search_path = public, pg_temp as $$
    select distinct on (r.venue_id) r.venue_id, r.venue_name, r.home_abbr
      from graded_read r
     where r.venue_id is not null
     order by r.venue_id, r.official_date desc;
$$;


-- Aggregates for the Data Feed charts, with the filter-ignore rules the design
-- depends on (each is what lets that surface act as a filter itself):
--   daily      ignores the timeframe, and spans at least 7 days for context
--   by_market  ignores the market filter
--   by_team    ignores the team filter
-- Voids are excluded from every figure. `gap` and `skill` are derived
-- client-side from n / exp / act / brier.
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

-- Read through /api only (service role), like the other analytics functions.
revoke execute on function refresh_graded_reads(int) from anon, authenticated, public;
revoke execute on function graded_venues() from anon, authenticated, public;
revoke execute on function graded_summary(date, date, text, text, int, text, text) from anon, authenticated, public;

-- Every 15 minutes: the last two Eastern days, which is where grades land
-- during and just after a slate. Nightly (04:50 ET, after the 03:00 ET settle
-- sweep): three weeks, to pick up late grades and re-grades.
select cron.schedule('np-graded-refresh', '*/15 * * * *', $$select refresh_graded_reads(2)$$);
select cron.schedule('np-graded-refresh-nightly', '50 8 * * *', $$select refresh_graded_reads(21)$$);

-- Seed the full hot window once.
select refresh_graded_reads(35);
