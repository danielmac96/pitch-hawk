-- Model registry: make swapping model versions a one-call, reversible op.
-- Insert a new model_params row (any type the scorer knows), then
--   select activate_model('pitch_result', 'v2_20260710');
-- and to undo:
--   select rollback_model('pitch_result');
-- See docs/MODELS.md.

alter table model_params add column if not exists activated_at timestamptz;
alter table model_params add column if not exists notes text;

-- Atomically flip the active version for a market.
create or replace function activate_model(p_market text, p_version text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from model_params where market = p_market and version = p_version) then
    raise exception 'no such model %/%', p_market, p_version;
  end if;
  update model_params set is_active = false
    where market = p_market and is_active and version <> p_version;
  update model_params set is_active = true, activated_at = now()
    where market = p_market and version = p_version;
end $$;

-- Reactivate the version that was active immediately before the current one.
create or replace function rollback_model(p_market text)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare prev text;
begin
  select version into prev from model_params
    where market = p_market and not is_active and activated_at is not null
    order by activated_at desc limit 1;
  if prev is null then
    raise exception 'no previous active version to roll back to for %', p_market;
  end if;
  perform activate_model(p_market, prev);
  return prev;
end $$;

revoke execute on function activate_model(text, text) from anon, authenticated, public;
revoke execute on function rollback_model(text) from anon, authenticated, public;
