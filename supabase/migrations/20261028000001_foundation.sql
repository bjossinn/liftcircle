-- LiftCircle backend foundation: extensions, private helper schema, version sequence,
-- safe cast helpers for typed projections, and abuse-limit bookkeeping.
--
-- Conventions used by every LiftCircle migration:
--   * All tables live in `public` (exposed through the Data API) with RLS enabled and
--     least-privilege grants (Supabase grants everything to anon/authenticated by default,
--     so every migration revokes first and then grants only what is required).
--   * Privileged helpers live in the NON-exposed `private` schema, are `security definer`
--     and pin `set search_path = ''`; every name inside them is schema-qualified.
--   * Client-callable RPCs live in `public`, are `security definer` + `search_path = ''`,
--     derive the caller from auth.uid() and have EXECUTE revoked from public/anon.

create extension if not exists citext with schema extensions;
create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public;
-- RLS policies call a few private helpers as the querying role, so the API roles need USAGE.
-- The schema is not in the Data API's exposed schemas, so nothing here is callable over HTTP.
grant usage on schema private to anon, authenticated, service_role;

-- One global, server-issued version sequence for every synced private record.
create sequence if not exists private.sync_version_seq as bigint start with 1;

/* ------------------------------------------------------------------ safe casts
   Typed projection columns are GENERATED from the client payload. These helpers never
   raise: malformed client data yields NULL in the projection instead of failing the sync. */

create or replace function private.try_num(t text) returns numeric
language plpgsql immutable parallel safe set search_path = '' as $$
begin
  if t is null or t !~ '^\s*-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]{1,3})?\s*$' then return null; end if;
  return t::numeric;
exception when others then return null;
end $$;

create or replace function private.try_int(t text) returns integer
language plpgsql immutable parallel safe set search_path = '' as $$
declare n numeric := private.try_num(t);
begin
  if n is null or n < -2147483648 or n > 2147483647 then return null; end if;
  return round(n)::integer;
end $$;

create or replace function private.try_bool(t text) returns boolean
language sql immutable parallel safe set search_path = '' as $$
  select case t when 'true' then true when 'false' then false else null end
$$;

create or replace function private.try_date(t text) returns date
language plpgsql immutable parallel safe set search_path = '' as $$
begin
  if t is null or t !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return null; end if;
  return make_date(substr(t, 1, 4)::int, substr(t, 6, 2)::int, substr(t, 9, 2)::int);
exception when others then return null;
end $$;

-- Epoch milliseconds (as JSON number text) → timestamptz.
create or replace function private.try_ts_ms(t text) returns timestamptz
language plpgsql immutable parallel safe set search_path = '' as $$
declare n numeric := private.try_num(t);
begin
  if n is null or n < 0 or n > 32503680000000 then return null; end if; -- < year 3000
  return pg_catalog.to_timestamp((n / 1000)::double precision);
exception when others then return null;
end $$;

create or replace function private.try_uuid(t text) returns uuid
language plpgsql immutable parallel safe set search_path = '' as $$
begin
  if t is null or t !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return null; end if;
  return t::uuid;
end $$;

create or replace function private.clip(t text, n integer) returns text
language sql immutable parallel safe set search_path = '' as $$ select left(t, n) $$;

/* ---------------------------------------------------------------- abuse limits */

create table if not exists private.rate_events (
  user_id uuid not null references auth.users (id) on delete cascade,
  action text not null,
  created_at timestamptz not null default now()
);
create index if not exists rate_events_lookup on private.rate_events (user_id, action, created_at desc);
alter table private.rate_events enable row level security; -- no policies: only definer code touches it
revoke all on private.rate_events from public, anon, authenticated;

-- Raises SQLSTATE PT429 (PostgREST → HTTP 429) with a user-readable message when recording
-- p_n more events of p_action would exceed p_max within p_window; otherwise records them.
create or replace function private.enforce_rate_limit(p_user uuid, p_action text, p_max integer, p_window interval,
                                                      p_message text, p_n integer default 1)
returns void language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  if coalesce(p_n, 0) <= 0 then return; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('rate:' || p_user::text || ':' || p_action, 0));
  select count(*) into n from private.rate_events
   where user_id = p_user and action = p_action and created_at > now() - p_window;
  if n + p_n > p_max then
    raise exception '%', p_message using errcode = 'PT429', hint = 'rate_limited';
  end if;
  insert into private.rate_events (user_id, action) select p_user, p_action from generate_series(1, p_n);
end $$;

-- Caller identity for RPCs. Raises (HTTP 401/403) when there is no signed-in user.
create or replace function private.require_uid() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v uuid := auth.uid();
begin
  if v is null then
    raise exception 'You need to be signed in.' using errcode = '42501';
  end if;
  return v;
end $$;

-- EXECUTE on `private` functions is locked down in the final migration (…_lockdown.sql):
-- Postgres grants EXECUTE to PUBLIC on every new function, and a per-schema default-privilege
-- REVOKE cannot undo that global default, so the lockdown is explicit.
