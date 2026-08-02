-- Retention for `predictions`, the only unbounded table in the schema.
--
-- Measured 2026-07-28: 203,010 rows accumulated in 21 days (~9,667/day) with
-- no prune policy of any kind. Left alone that is ~3.5M rows/year, which would
-- exceed the 0.5 GB plan cap on its own.
--
-- Pruning raw predictions must never destroy the model's accuracy record, so
-- this migration adds a daily rollup that runs BEFORE the prune. The rollup is
-- ~5 rows/day (one per market) versus ~9,667 raw rows, and it is what any
-- future model-performance view should read.

create table if not exists prediction_accuracy_daily (
    day               date not null,
    market            text not null,
    -- '' rather than NULL so it can sit in the primary key.
    model_version     text not null default '',
    n                 bigint,
    n_graded          bigint,
    wins              bigint,
    losses            bigint,
    pushes            bigint,
    mean_confidence   numeric(6,4),
    mean_profit_units numeric(8,4),
    updated_at        timestamptz default now(),
    primary key (day, market, model_version)
);

alter table prediction_accuracy_daily enable row level security;

-- Public read, consistent with the other app-data tables.
do $$
declare roles text := (
    select string_agg(quote_ident(rolname), ', ')
    from pg_roles where rolname in ('anon', 'authenticated')
);
begin
    if roles is null then return; end if;
    if not exists (
        select 1 from pg_policies
        where schemaname = 'public' and tablename = 'prediction_accuracy_daily'
          and policyname = 'public read'
    ) then
        execute format(
            'create policy "public read" on prediction_accuracy_daily for select to %s using (true)',
            roles);
    end if;
end $$;

-- Aggregate the trailing p_days of predictions into the daily table. Idempotent
-- (upsert), so re-running only refreshes. The window intentionally exceeds a
-- single day: settlement grades rows asynchronously, so a day's `wins` count
-- keeps moving for a while after the day closes.
create or replace function rollup_prediction_accuracy(p_days int default 7)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
    insert into prediction_accuracy_daily as t (
        day, market, model_version, n, n_graded, wins, losses, pushes,
        mean_confidence, mean_profit_units, updated_at
    )
    select
        created_at::date,
        market,
        coalesce(model_version, ''),
        count(*),
        count(*) filter (where result is not null),
        count(*) filter (where result = 'win'),
        count(*) filter (where result = 'loss'),
        count(*) filter (where result = 'push'),
        round(avg(confidence), 4),
        round(avg(profit_units), 4),
        now()
    from predictions
    where created_at >= (now() - make_interval(days => p_days))::date
      and market is not null
    group by 1, 2, 3
    on conflict (day, market, model_version) do update set
        n                 = excluded.n,
        n_graded          = excluded.n_graded,
        wins              = excluded.wins,
        losses            = excluded.losses,
        pushes            = excluded.pushes,
        mean_confidence   = excluded.mean_confidence,
        mean_profit_units = excluded.mean_profit_units,
        updated_at        = now();
    get diagnostics n = row_count;
    return n;
end $$;

-- Delete raw predictions past the retention horizon. ALWAYS call
-- rollup_prediction_accuracy() first — daily-ingest does, in that order.
--
-- 21 days is deliberately just past the current data age so the first run is a
-- near no-op and the effect is observable before the horizon is tightened. If
-- Phase 0 sizing shows we need space now, drop this to 14 or 7.
create or replace function prune_predictions(keep_days int default 21)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
    delete from predictions
    where created_at < now() - make_interval(days => keep_days);
    get diagnostics n = row_count;
    return n;
end $$;

-- Bookkeeping tables don't need 30 days of history; 7 is plenty for debugging
-- a failed job, and live-poll alone was writing ~2.2k rows/day.
create or replace function prune_ingest_runs(keep_days int default 7)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  delete from ingest_runs
  where started_at < now() - make_interval(days => keep_days);
  get diagnostics n = row_count;
  return n;
end $$;

-- None of these are reachable from the public API.
revoke execute on function rollup_prediction_accuracy(int) from anon, authenticated, public;
revoke execute on function prune_predictions(int) from anon, authenticated, public;
revoke execute on function prune_ingest_runs(int) from anon, authenticated, public;
