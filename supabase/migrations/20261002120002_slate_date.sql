-- The slate the board shows: today, or the next day that has games.
--
-- Everything keyed off "today" went blank on an off day -- the Home tab said
-- "No MLB games on today's schedule" through every postseason gap, the
-- All-Star break and the offseason, while the next slate was a day or two
-- away. And game-predict's cron gate only fires for today's games, so even
-- once the next slate was in `games` it never got a pregame read before the
-- morning it was played.
--
-- One definition, in SQL, because two callers need it and they must agree:
-- the cron gate below and the API (/games, /live, /board, /projections, via
-- _shared/slate.ts). A TypeScript copy and a SQL copy would drift.
--
-- Driven by date, never by status: the next slate is the earliest date AFTER
-- today with a playable game. A past date with stale 'Scheduled' rows (a game
-- whose status was never refreshed) can therefore never be picked.

create or replace function slate_date(
    p_today date default (now() at time zone 'America/New_York')::date
)
returns table (slate date, is_today boolean)
language sql stable security definer set search_path = public, pg_temp as $$
    with playable as (
        select distinct official_date
          from games
         where official_date between p_today and p_today + 14
           and coalesce(status, '') !~* '^(Postponed|Cancelled|Canceled|Suspended)'
    ),
    pick as (
        select coalesce(
                   (select official_date from playable where official_date = p_today),
                   (select min(official_date) from playable where official_date > p_today),
                   p_today) as d
    )
    -- is_today is also true in the offseason fallback: there is no other
    -- slate to point at, so the board describes today, and today is empty.
    select d, d = p_today from pick;
$$;

revoke execute on function slate_date(date) from anon, authenticated, public;

comment on function slate_date(date) is
    'The slate the board shows: p_today if it has a playable game, else the '
    'earliest date in the next 14 days that does, else p_today.';


-- ── game-predict cron gate ───────────────────────────────────────────────
-- Copied from the PRODUCTION job, which has drifted from 20260808000001: it
-- fires every hour from 10:00 ET while any game on the slate has not started
-- (game-predict re-scores batter projections on every run, so lineups posted
-- after 10:00 are picked up). The only change is that "the slate" is now
-- slate_date() rather than today, and the date is passed explicitly so the
-- function scores the same slate the gate looked at.
do $$
declare j record;
begin
    for j in select jobid from cron.job where jobname = 'np-game-predict' loop
        perform cron.unschedule(j.jobid);
    end loop;
end $$;

select cron.schedule('np-game-predict', '5 * * * *', $$
do $body$
declare
    et_now  timestamp := now() at time zone 'America/New_York';
    et_hour int       := extract(hour from et_now);
    s_date  date      := (select slate from slate_date(et_now::date));
begin
    -- Nothing to predict before the main run.
    if et_hour < 10 then
        return;
    end if;

    if exists (
        select 1 from games
        where official_date = s_date
          and start_ts > now()
          and status not like 'Final%'
          and status not in ('Postponed', 'Cancelled', 'Canceled', 'Suspended')
    ) then
        perform call_edge_function('game-predict',
                                   jsonb_build_object('date', s_date::text));
    end if;
end $body$
$$);
