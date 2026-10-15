-- v4 serving (docs/models/V4-PLAN.md, phase 6).
--
-- v4_models: the exported model of each in-game v4 market (per-pitch, per-PA,
-- rest of game, live total), scored by supabase/functions/_shared/v4.ts.
-- Kept OUT of model_params.params on purpose: loadActiveModels() reads every
-- active params blob on every 15-second live-poll, and a tree ensemble is
-- hundreds of kilobytes. The edge functions read a spec once per version and
-- cache it for the life of the isolate.
--
-- v4_serve_features: the pregame half of every in-game market's inputs,
-- written by `python -m modeling v4 serve` each morning (and again as
-- lineups post): pitcher / batter snapshots (arsenal, plate discipline,
-- per-PA rates), per batter-game values (v3 structure, form) and per game
-- values (park, weather, umpire, day of season). The live scorers join these
-- with the game state. Rows older than 7 days are pruned by the same job.

create table if not exists v4_models (
    market      text not null,
    version     text not null,
    spec        jsonb not null,
    size_kb     double precision,
    run_id      text,
    created_at  timestamptz not null default now(),
    primary key (market, version)
);

create table if not exists v4_serve_features (
    kind        text not null,
    key         text not null,
    as_of       date not null,
    features    jsonb not null,
    updated_at  timestamptz not null default now(),
    primary key (kind, key, as_of)
);
create index if not exists v4_serve_features_asof_idx on v4_serve_features (as_of);

alter table v4_models enable row level security;
alter table v4_serve_features enable row level security;
-- Service role only: the edge functions read with it, nothing public does.
