-- Pin search_path on all functions (fixes function_search_path_mutable) and
-- lock down the SECURITY DEFINER cron dispatcher so only the service role
-- (edge functions / pg_cron) can invoke it, not anon/authenticated via RPC.
--
-- NOTE: this migration was originally applied to the live project via MCP
-- (version 20260707023820, name harden_functions) and back-filled into the
-- repo later so the repo stays the source of truth for fresh installs.

alter function public.get_pitcher_stats() set search_path = public, pg_temp;
alter function public.get_pitcher_ab_stats() set search_path = public, pg_temp;
alter function public.get_league_averages() set search_path = public, pg_temp;
alter function public.refresh_pitcher_rolling_stats() set search_path = public, pg_temp;
alter function public.refresh_batter_rolling_stats() set search_path = public, pg_temp;
alter function public.refresh_matchup_history() set search_path = public, pg_temp;
alter function public.call_edge_function(text, jsonb) set search_path = public, pg_temp;
alter function public.train_pitch_result_cells() set search_path = public, pg_temp;
alter function public.train_ab_result_cells() set search_path = public, pg_temp;
alter function public.train_pitch_speed_cells() set search_path = public, pg_temp;
alter function public.train_ab_pitches_cells() set search_path = public, pg_temp;
alter function public.train_home_advantage() set search_path = public, pg_temp;

-- call_edge_function must not be reachable from the public API.
revoke execute on function public.call_edge_function(text, jsonb) from anon, authenticated, public;
