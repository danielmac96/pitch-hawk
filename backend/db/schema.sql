-- MLB Pitch Predictor — Supabase/Postgres schema
-- Apply via the Supabase SQL editor.

create table if not exists pitches (
    id              bigserial primary key,
    game_pk         bigint      not null,
    at_bat_index    int         not null,
    pitch_number    int         not null,
    pitcher_id      int,
    batter_id       int,
    pitch_type      text,
    start_speed     numeric(5,1),
    zone            int,
    description     text,
    result_category text,
    balls           int,
    strikes         int,
    outs            int,
    inning          int,
    top_inning      boolean,
    pitch_ts        timestamptz,
    raw_json        jsonb,
    unique (game_pk, at_bat_index, pitch_number)
);

create index if not exists pitches_game_pa_pitch_idx
    on pitches (game_pk, at_bat_index, pitch_number);

create table if not exists at_bats (
    id              bigserial primary key,
    game_pk         bigint      not null,
    at_bat_index    int         not null,
    pitcher_id      int,
    batter_id       int,
    pitch_count     int,
    result          text,
    result_detail   text,
    start_ts        timestamptz,
    end_ts          timestamptz,
    unique (game_pk, at_bat_index)
);

create index if not exists at_bats_game_pa_idx
    on at_bats (game_pk, at_bat_index);

create table if not exists live_state (
    game_pk         bigint primary key,
    status          text,
    inning          int,
    top_inning      boolean,
    batter_id       int,
    pitcher_id      int,
    balls           int,
    strikes         int,
    outs            int,
    pitch_count_pa  int,
    last_pitch_ts   timestamptz,
    raw_json        jsonb,
    updated_at      timestamptz default now()
);

create index if not exists live_state_updated_at_idx
    on live_state (updated_at);

create table if not exists odds (
    id            bigserial primary key,
    game_pk       bigint,
    market        text,
    line          numeric(6,2),
    over_price    int,
    under_price   int,
    source        text default 'draftkings_stub',
    fetched_at    timestamptz default now()
);

create table if not exists predictions (
    id              bigserial primary key,
    game_pk         bigint,
    at_bat_index    int,
    pitch_number    int,
    market          text,
    predicted_value numeric(8,4),
    confidence      numeric(5,4),
    probs           jsonb,
    recommendation  text,
    line            numeric(6,2),
    price           int,
    edge            numeric(7,4),
    units           numeric(4,2) default 1,
    result          text,
    profit_units    numeric(7,3),
    graded_at       timestamptz,
    model_version   text default 'stub_v0',
    created_at      timestamptz default now()
);

create index if not exists predictions_game_pa_market_idx
    on predictions (game_pk, at_bat_index, market);

-- Bet-CTA click funnel. Powers affiliate-deal negotiation and conversion
-- optimization. Written fire-and-forget from POST /track/click; safe to drop.
create table if not exists bet_clicks (
    id                   bigserial primary key,
    game_pk              bigint,
    market               text,
    side                 text,
    book                 text,
    edge                 numeric(6,4),
    affiliate_configured boolean,
    clicked_at           timestamptz default now()
);

create index if not exists bet_clicks_book_clicked_idx
    on bet_clicks (book, clicked_at);
