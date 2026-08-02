-- Phase 3, Task 3.2 — cut pitches and at_bats to a 35-day hot window.
--
-- Why a swap and not DELETE: DELETE frees no measured space. Dead tuples are
-- reusable by the table but pg_database_size does not shrink, and this database
-- is capacity-constrained, not bloat-constrained. VACUUM FULL needs ~2x the
-- table size transiently, which is exactly what we do not have. pg_repack is
-- unavailable on Supabase's free tier.
--
-- at_bats goes FIRST and this is not stylistic. Reversed, the peak is ~25 MB
-- higher because the large table's copy is held alongside both originals, and
-- there is no margin for WAL.
--
-- Measured 2026-08-02, immediately before this ran:
--
--   database                    456 MB of a 500 MB cap
--   pitches     1,217,836 rows  257 MB   126,058 rows inside 35 days (10.4%)
--   at_bats       314,315 rows   52 MB    32,435 rows inside 35 days (10.3%)
--
--   step                              peak     after
--   at_bats swap  (copy ~5 MB)        461 MB
--   drop at_bats_old (52 MB)                   409 MB
--   pitches swap  (copy ~27 MB)       436 MB
--   drop pitches_old (257 MB)                  ~179 MB
--
-- Everything older than the window lives in R2 and has been independently
-- re-derived from the MLB API — `python -m warehouse verify --range
-- 2025-03-26..2026-06-29` must exit 0 on the day this runs. That gate, not
-- this file, is what makes the drops safe.
--
-- FOUR THINGS `LIKE ... INCLUDING ALL` DOES NOT CARRY. All four are measured
-- from production and recreated explicitly below:
--
--   1. RLS policies. Both tables have exactly one: "public read", FOR SELECT,
--      TO anon+authenticated, USING (true). Missing it does not error -- with
--      RLS enabled and no policy the table silently reads as EMPTY.
--   2. RLS enablement itself (relrowsecurity). Also not carried.
--   3. Grants. anon, authenticated and service_role each hold all seven.
--      Writes are blocked by the absence of an INSERT policy, not by the
--      grants, so reproduce them as-is rather than "tidying". (postgres holds
--      them too, implicitly as owner -- no explicit grant needed.)
--   4. Sequence ownership. id defaults to nextval('<table>_id_seq'), and those
--      sequences are OWNED BY the old tables -- `drop table pitches` would
--      drop pitches_id_seq with it and every subsequent insert would fail.
--
-- Note there is no game_date column on either table: the window filter is
-- pitch_ts for pitches and start_ts for at_bats.
--
-- The two `drop table ... _old` statements are deliberately left commented.
-- Nothing is lost while the _old tables exist, which is what makes this
-- reversible; see the rollback note at the bottom. They are executed as a
-- separate, deliberate step once the swap is confirmed good.

-- ═══ part 1: at_bats ═════════════════════════════════════════════════════
begin;

create table at_bats_new (like at_bats including all);

insert into at_bats_new
select * from at_bats
where start_ts >= now() - interval '35 days';

-- Re-own BEFORE the old table is dropped, or the sequence goes with it.
alter sequence at_bats_id_seq owned by at_bats_new.id;
-- greatest(...) so the sequence can never move backwards. Upserts burn ids
-- without using them, so last_value sits well above max(id): at_bats_id_seq
-- was at 2,695,215 against 314,315 live rows.
select setval('at_bats_id_seq',
              greatest((select coalesce(max(id), 1) from at_bats_new),
                       (select last_value from at_bats_id_seq)),
              true);

alter table at_bats rename to at_bats_old;
alter table at_bats_new rename to at_bats;

alter table at_bats enable row level security;

-- Roles are resolved from pg_roles rather than named literally, matching
-- 20260728000002. CI applies every migration against a clean Postgres 16 that
-- has only `anon` and `authenticated` -- a bare `grant ... to service_role`
-- there is a hard failure, and this file must stay CI-applicable to be tested
-- at all.
do $$
declare
    readers  text := (select string_agg(quote_ident(rolname), ', ')
                      from pg_roles where rolname in ('anon', 'authenticated'));
    grantees text := (select string_agg(quote_ident(rolname), ', ')
                      from pg_roles
                      where rolname in ('anon', 'authenticated', 'service_role'));
begin
    if readers is not null then
        execute format(
            'create policy "public read" on at_bats for select to %s using (true)',
            readers);
    end if;
    if grantees is not null then
        execute format(
            'grant select, insert, update, delete, truncate, references, '
            'trigger on at_bats to %s', grantees);
    end if;
end $$;

commit;

-- Reclaims 52 MB. Run only once the swap above is confirmed good.
-- drop table at_bats_old;

-- ═══ part 2: pitches ═════════════════════════════════════════════════════
begin;

create table pitches_new (like pitches including all);

insert into pitches_new
select * from pitches
where pitch_ts >= now() - interval '35 days';

alter sequence pitches_id_seq owned by pitches_new.id;
-- pitches_id_seq was at 10,569,990 against 1,217,836 live rows -- the live
-- upsert path burns roughly eight ids per stored row.
select setval('pitches_id_seq',
              greatest((select coalesce(max(id), 1) from pitches_new),
                       (select last_value from pitches_id_seq)),
              true);

alter table pitches rename to pitches_old;
alter table pitches_new rename to pitches;

alter table pitches enable row level security;

do $$
declare
    readers  text := (select string_agg(quote_ident(rolname), ', ')
                      from pg_roles where rolname in ('anon', 'authenticated'));
    grantees text := (select string_agg(quote_ident(rolname), ', ')
                      from pg_roles
                      where rolname in ('anon', 'authenticated', 'service_role'));
begin
    if readers is not null then
        execute format(
            'create policy "public read" on pitches for select to %s using (true)',
            readers);
    end if;
    if grantees is not null then
        execute format(
            'grant select, insert, update, delete, truncate, references, '
            'trigger on pitches to %s', grantees);
    end if;
end $$;

commit;

-- Reclaims 257 MB. Run only once the swap above is confirmed good.
-- drop table pitches_old;

-- ═══ after both drops ════════════════════════════════════════════════════
-- LIKE generates index and constraint names from the NEW table name, so the
-- swapped tables carry pitches_new_pkey / at_bats_new_pkey etc. The original
-- names are only free once the _old tables are gone. Renaming them back keeps
-- pg_indexes matching 20260703000001_core_schema.sql, so a future migration
-- that references an index by name still finds it.
--
--   alter index pitches_new_pkey rename to pitches_pkey;
--   alter index pitches_new_game_pk_at_bat_index_pitch_number_key
--       rename to pitches_game_pk_at_bat_index_pitch_number_key;
--   alter index pitches_new_batter_id_idx rename to pitches_batter_idx;
--   alter index at_bats_new_pkey rename to at_bats_pkey;
--   alter index at_bats_new_game_pk_at_bat_index_key
--       rename to at_bats_game_pk_at_bat_index_key;
--
-- Then recreate the time index Phase 0 dropped at 37 MB. On the ~17 MB heap
-- that remains it costs ~4 MB:
--
--   create index pitches_ts_idx on pitches(pitch_ts);
--   vacuum (analyze) pitches;
--   vacuum (analyze) at_bats;
--
-- ROLLBACK, at any point before the drops:
--   alter table pitches rename to pitches_new;
--   alter table pitches_old rename to pitches;
--   alter sequence pitches_id_seq owned by pitches.id;
-- and re-schedule np-live-poll. Nothing is lost while _old exists, which is
-- precisely why the drops are separate from the swap.
