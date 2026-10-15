-- v4_backfill_daily: one row per (market, day) of a v4 model's predictions.
--
-- The row-level backfill (every batter-game, start, pitch ... from 2018) lives
-- in R2 under model_v4/backfill/, because it is millions of rows and this
-- database is on a 500 MB ceiling. What the dashboard plots is this rollup:
-- the day's mean prediction, the observed rate, and the primary metric for
-- the v4 model beside the incumbent and the naive baseline on the SAME rows.
--
-- source: walk_forward (2018-2025, each season predicted by a model fitted on
-- earlier seasons), test_2026 (the held-out season), production (scored by
-- the frozen production fit after it was trained -- `python -m modeling v4
-- score`). Written by modeling/v4/record.py::publish_daily, upserted on
-- (market, day), so a re-run replaces rather than duplicates.
--
-- ~18 markets x ~1,700 game-days: tens of thousands of small rows.

create table if not exists v4_backfill_daily (
    market          text not null,
    day             date not null,
    season          int,
    n               int not null,
    mean_pred       double precision,
    observed        double precision,
    loss            double precision,
    incumbent_loss  double precision,
    baseline_loss   double precision,
    primary_metric  text,
    source          text,
    run_id          text,
    version         text,
    updated_at      timestamptz not null default now(),
    primary key (market, day)
);

create index if not exists v4_backfill_daily_day_idx on v4_backfill_daily (day desc);

alter table v4_backfill_daily enable row level security;

-- Read-only to the dashboard's anon key; writes require the service role.
drop policy if exists v4_backfill_daily_read on v4_backfill_daily;
create policy v4_backfill_daily_read on v4_backfill_daily for select using (true);
