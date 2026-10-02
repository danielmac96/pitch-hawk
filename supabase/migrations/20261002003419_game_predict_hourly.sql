-- ════════════════════════════════════════════════════════════════════════
-- np-game-predict: re-run hourly while any game today has not started.
--
-- The 10:00 ET main run happens before most lineups are posted (they land
-- ~3 h before first pitch), so it scores the game markets but almost no
-- batters. game-predict re-scores batter projections on every run -- but the
-- hourly gap-fill below only fired while a game had FEWER THAN SIX game-level
-- markets, which the 10:00 run always writes. So after 10:00 it never fired
-- again, and batter_hit / batter_hr went from 72 rows (2026-09-24) to 9 a day
-- and then to none from 2026-09-27.
--
-- The lineup is not stored anywhere the cron can see, so the gate is simply
-- "a game today is still ahead of first pitch". Each extra run is cheap:
-- frozen pregame game markets are skipped, and only batter (and starter)
-- projections are re-scored.
-- ════════════════════════════════════════════════════════════════════════

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
    et_date date      := et_now::date;
begin
    -- Nothing to predict before the main run.
    if et_hour < 10 then
        return;
    end if;

    if exists (
        select 1 from games
        where official_date = et_date
          and start_ts > now()
          and status not like 'Final%'
          and status not in ('Postponed', 'Cancelled', 'Canceled', 'Suspended')
    ) then
        perform call_edge_function('game-predict');
    end if;
end $body$
$$);
