-- Tighten the live poll from 30s to 15s.
--
-- This is NOT a coverage fix. Coverage is handled in the writer: live-poll now
-- reconstructs every unscored pitch position from the play-by-play it already
-- fetches (_shared/livepitch.ts), so every pitch gets a prediction at any
-- cadence. A replay over 59,376 simulated pitches drawn from the measured
-- 2026-08-14 distributions returns 100% coverage at 30s, 20s, 15s and 10s
-- alike, worst single game 100%.
--
-- What the cadence changes is how many calls are FORWARD -- written before the
-- pitch they predict -- rather than reconstructed after it. Both are honest
-- (the reconstruction reads the count as it stood, with no look-ahead), but
-- only a forward call was ever available to act on, and only forward calls
-- publish picks. From the same replay:
--
--     interval   forward calls   MLB requests/min @ 15 games
--       30s          52.7%                 60
--       25s          58.0%                 72
--       20s          63.7%                 90
--       15s          69.0%                120
--       12s          71.8%                150
--       10s          73.2%                180
--        5s          74.4%                360
--
-- 15s is the knee: +16 points of forward calls over 30s for 2x the requests,
-- where 10s buys 4 more points for 3x and 5s buys 5 more for 6x. The measured
-- inter-pitch gap supports it and does not support going much below --
-- 2026-08-14 had a median gap of 21.8s and a 10th percentile of 15.1s, with
-- exactly 1 gap of 4,048 at or under 10 seconds.
--
-- (The replay's absolute forward share is an understatement: it can only see
-- pitch rows, so it never models MLB posting the next play before its first
-- pitch, which is what makes a new batter's position-0 call forward. The
-- ranking across intervals is unaffected.)
--
-- On cost: MLB publishes no rate limit for statsapi.mlb.com and the community
-- guidance is simply to cache and back off, so 2 req/s at a full slate is not
-- near any known ceiling. live-poll currently runs 0.4s median / 24.8s max over
-- 6,930 runs with zero failures; 15s spacing leaves ample headroom, but the max
-- is the number to watch after this ships -- a run that overruns its interval
-- starts stacking.

do $$
declare j record;
begin
    for j in select jobid from cron.job where jobname = 'np-live-poll' loop
        perform cron.unschedule(j.jobid);
    end loop;
end $$;

-- Same window guard as 20260716000001: outside a game window the tick does no
-- work at all, so halving the interval costs nothing overnight.
select cron.schedule('np-live-poll', '15 seconds', $$
do $body$
begin
    if exists (
        select 1 from games
        where start_ts <= now() and now() < start_ts + interval '4 hours'
    ) or exists (
        select 1 from live_state where status = 'live'
    ) then
        perform call_edge_function('live-poll');
    end if;
end $body$
$$);
