-- Per-batter, per-game P(hit) and P(home run) -- the analytics surface the
-- batter markets feed.
--
-- WHY A SEPARATE TABLE AND NOT `predictions`.
-- `predictions` is keyed (game_pk, at_bat_index, pitch_number, market) and
-- carries no player_id at all. A game-long player projection has no at-bat
-- index, and `settle` grades against the next pitch, the finished at-bat or
-- the final score -- none of which is "did this batter get a hit today".
-- Bolting a player onto that table would mean a nullable at_bat_index, a new
-- uniqueness shape and a new grading branch, all to support a surface that is
-- not being priced.
--
-- So this is its own thing, and `predictions` / `picks` / `settle` are
-- untouched. That is the whole reason the analytics-first ordering was chosen:
-- the schema surgery is deferred until the model has earned it.
--
-- NOT GRADED, ON PURPOSE. There is no `result`, no `profit_units`, no
-- `graded_at`. These are published probabilities, not a wager record. Adding
-- grading here without a real prop line would produce a track record measured
-- against even money, which is the `model_fair` trap the micro-markets already
-- sit in -- except those at least say so.

create table if not exists player_game_projections (
    game_pk        bigint  not null,
    player_id      int     not null,
    market         text    not null,     -- 'batter_hit' | 'batter_hr'
    official_date  date    not null,
    -- Denormalised so the surface is readable without joining games: the API
    -- serves this straight through and a join per row is the kind of thing
    -- that turns a 200ms route into a 2s one.
    team_id        int,
    opponent_id    int,
    is_home        boolean,
    -- Batting order slot, 1-9, from the confirmed lineup. Null when the
    -- lineup was not posted at scoring time; the row is still written because
    -- the probability does not depend on it.
    lineup_slot    int,
    opposing_pitcher_id int,
    probability    numeric(6,4) not null,
    -- Expected plate appearances behind the game-level number. P(>=1 hit in a
    -- game) is arithmetic on a per-PA probability, and that arithmetic needs
    -- an assumed PA count -- stored so the number can be reproduced rather
    -- than merely trusted.
    expected_pa    numeric(4,2),
    -- Per-plate-appearance probability, before the PA roll-up. Kept because
    -- it is what the model actually emits; `probability` is a derived view of
    -- it and the two answer different questions.
    per_pa_probability numeric(6,4),
    model_version  text,
    -- Always 'model_fair' today. There is no prop source for these markets,
    -- so any edge figure would be against even money. Present so the column
    -- means the same thing here as on `predictions` when a real book lands.
    book           text not null default 'model_fair',
    scored_at      timestamptz not null default now(),
    updated_at     timestamptz not null default now(),
    primary key (game_pk, player_id, market)
);

create index if not exists player_game_projections_date_idx
    on player_game_projections (official_date, market);

create index if not exists player_game_projections_player_idx
    on player_game_projections (player_id, official_date);


-- Retention. Matches game_predictions at 35 days rather than predictions at
-- 21: these are pregame rows for a slate, and the board shows recent history.
create or replace function prune_player_game_projections(p_days int default 35)
returns int language plpgsql security definer
set search_path = public, pg_temp as $$
declare n int;
begin
    delete from player_game_projections
    where official_date < (current_date - p_days);
    get diagnostics n = row_count;
    return n;
end $$;

revoke execute on function prune_player_game_projections(int)
    from anon, authenticated;


-- ── RLS ──────────────────────────────────────────────────────────────────
-- Public read, like every other app table. Writes are service-role only,
-- which bypasses RLS.
do $$
declare
    readers text := (select string_agg(quote_ident(rolname), ', ')
                     from pg_roles where rolname in ('anon','authenticated'));
begin
    execute 'alter table player_game_projections enable row level security';
    if readers is not null then
        execute format('drop policy if exists %I on player_game_projections',
                       'player_game_projections_read');
        execute format(
            'create policy %I on player_game_projections for select to %s '
            'using (true)', 'player_game_projections_read', readers);
    end if;
end $$;
