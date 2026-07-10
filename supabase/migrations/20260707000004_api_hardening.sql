-- /record served from a single SQL aggregate instead of scanning up to 5000
-- pick rows per request. Returns overall + last-30-days + per-market buckets.
create or replace function pick_record()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare result jsonb;
begin
  with g as (
    select market, status, coalesce(units, 1) as units,
           coalesce(profit_units, 0) as profit, pick_date
    from picks where status in ('win', 'loss', 'push')
  ),
  cutoff as (select (now() at time zone 'utc')::date - 30 as d),
  overall as (
    select jsonb_build_object(
      'picks', count(*), 'wins', count(*) filter (where status = 'win'),
      'losses', count(*) filter (where status = 'loss'),
      'pushes', count(*) filter (where status = 'push'),
      'units', round(coalesce(sum(profit), 0)::numeric, 2),
      'roi', case when sum(units) > 0 then round(100 * sum(profit) / sum(units), 1) else 0 end
    ) j from g
  ),
  last30 as (
    select jsonb_build_object(
      'picks', count(*), 'wins', count(*) filter (where status = 'win'),
      'losses', count(*) filter (where status = 'loss'),
      'pushes', count(*) filter (where status = 'push'),
      'units', round(coalesce(sum(profit), 0)::numeric, 2),
      'roi', case when sum(units) > 0 then round(100 * sum(profit) / sum(units), 1) else 0 end
    ) j from g, cutoff where g.pick_date >= cutoff.d
  ),
  bym as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'market', market, 'picks', picks, 'wins', wins, 'losses', losses,
      'pushes', pushes, 'units', units, 'roi', roi) order by market), '[]'::jsonb) j
    from (
      select market, count(*) picks,
        count(*) filter (where status = 'win') wins,
        count(*) filter (where status = 'loss') losses,
        count(*) filter (where status = 'push') pushes,
        round(sum(profit)::numeric, 2) units,
        case when sum(units) > 0 then round(100 * sum(profit) / sum(units), 1) else 0 end roi
      from g group by market
    ) t
  )
  select jsonb_build_object(
    'overall', (select j from overall),
    'last30', (select j from last30),
    'byMarket', (select j from bym)
  ) into result;
  return result;
end $$;
