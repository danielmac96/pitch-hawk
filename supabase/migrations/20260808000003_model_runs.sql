-- model_runs: every training run, promoted or not.
--
-- Deliberately separate from model_params. model_params answers "what is live";
-- this answers "what was tried, and why was this the one". The rejected runs
-- are half the record -- a registry that only holds winners cannot show that a
-- version was chosen rather than merely produced.
--
-- Sized in kilobytes per row: metrics and fold summaries only, never per-row
-- predictions. The database is on a 500 MB ceiling.

create table if not exists model_runs (
    id               bigserial primary key,
    run_id           text not null unique,
    market           text not null,
    spec_hash        text not null,
    git_sha          text,
    data_through     date,
    train_seasons    int[],
    config           jsonb not null default '{}'::jsonb,
    folds            jsonb not null default '[]'::jsonb,
    oos_metrics      jsonb not null default '{}'::jsonb,
    holdout_metrics  jsonb,
    calibration      jsonb,
    params           jsonb,
    version          text,
    status           text not null default 'completed',
    notes            text,
    created_at       timestamptz not null default now(),
    constraint model_runs_status_check
        check (status in ('completed', 'failed', 'promoted'))
);

create index if not exists model_runs_market_created_idx
    on model_runs (market, created_at desc);
create index if not exists model_runs_version_idx
    on model_runs (market, version) where version is not null;

alter table model_runs enable row level security;

-- Read-only to the dashboard's anon key; writes require the service role.
drop policy if exists model_runs_read on model_runs;
create policy model_runs_read on model_runs for select using (true);
