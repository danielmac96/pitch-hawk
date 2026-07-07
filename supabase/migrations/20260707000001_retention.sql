-- Retention: keep the pipeline's bookkeeping tables bounded. Called daily from
-- daily-ingest. ingest_runs older than N days are dropped outright; odds older
-- than N days are dropped EXCEPT the most recent snapshot per
-- (game, market, source, outcome) so a last-known line always survives.

create or replace function prune_ingest_runs(keep_days int default 30)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  delete from ingest_runs
  where started_at < now() - make_interval(days => keep_days);
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function prune_odds(keep_days int default 14)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  delete from odds o
  where o.fetched_at < now() - make_interval(days => keep_days)
    and o.id not in (
      select distinct on (game_pk, market, source, coalesce(outcome, '')) id
      from odds
      order by game_pk, market, source, coalesce(outcome, ''), fetched_at desc
    );
  get diagnostics n = row_count;
  return n;
end $$;

-- Not reachable from the public API.
revoke execute on function prune_ingest_runs(int) from anon, authenticated, public;
revoke execute on function prune_odds(int) from anon, authenticated, public;
