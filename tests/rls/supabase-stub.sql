-- Minimal, faithful stand-in for the parts of a hosted Supabase database that LiftCircle's
-- migrations depend on. Run as the bootstrap superuser (supabase_admin) BEFORE the migrations,
-- which are then applied as the non-superuser `postgres` role, exactly like `supabase db push`.
-- NOT a migration: never apply this to a real project.

-- ---------------------------------------------------------------- roles
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator login noinherit;
grant anon, authenticated, service_role to authenticator;
create role supabase_auth_admin nologin noinherit createrole;
create role supabase_storage_admin nologin noinherit createrole;
-- Hosted `postgres` is not a superuser; it has bypassrls and can assume the API roles.
create role postgres login createrole createdb bypassrls;
grant anon, authenticated, service_role to postgres;
grant supabase_storage_admin to postgres; -- lets postgres create policies on storage.objects (as on hosted)
grant create, connect on database postgres to postgres;

-- ------------------------------------------------------------ public schema + defaults
alter schema public owner to postgres;
grant usage on schema public to anon, authenticated, service_role;
-- Supabase's default privileges: everything created by postgres in public is granted to the API
-- roles. Migrations must REVOKE explicitly — this stub reproduces that trap on purpose.
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;

-- ------------------------------------------------------------ extensions
create schema extensions;
grant usage on schema extensions to postgres, anon, authenticated, service_role;
create extension citext with schema extensions;
create extension pgcrypto with schema extensions;
alter database postgres set search_path = "$user", public, extensions;

-- ------------------------------------------------------------ auth schema
create schema auth authorization supabase_auth_admin;
grant usage on schema auth to postgres, anon, authenticated, service_role;

create table auth.users (
  instance_id uuid,
  id uuid primary key,
  aud varchar(255) default 'authenticated',
  role varchar(255) default 'authenticated',
  email varchar(255) unique,
  encrypted_password varchar(255),
  email_confirmed_at timestamptz,
  raw_app_meta_data jsonb default '{}',
  raw_user_meta_data jsonb default '{}',
  is_anonymous boolean not null default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  deleted_at timestamptz
);
alter table auth.users owner to supabase_auth_admin;
-- postgres may reference/read auth.users (FKs from public tables); API roles get nothing.
grant select, references, delete on auth.users to postgres;
grant all on auth.users to service_role;

-- Same definitions as GoTrue's auth.uid()/role()/jwt(): read the PostgREST request claims.
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text
$$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                  nullif(current_setting('request.jwt.claims', true), ''))::jsonb
$$;
alter function auth.uid() owner to supabase_auth_admin;
alter function auth.role() owner to supabase_auth_admin;
alter function auth.jwt() owner to supabase_auth_admin;
grant execute on function auth.uid(), auth.role(), auth.jwt() to postgres, anon, authenticated, service_role;

-- ------------------------------------------------------------ storage schema
create schema storage authorization supabase_storage_admin;
grant usage on schema storage to postgres, anon, authenticated, service_role;

create table storage.buckets (
  id text primary key,
  name text not null unique,
  owner uuid,
  owner_id text,
  public boolean default false,
  avif_autodetection boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid,
  owner_id text,
  metadata jsonb,
  user_metadata jsonb,
  path_tokens text[] generated always as (string_to_array(name, '/')) stored,
  version text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  last_accessed_at timestamptz default now(),
  unique (bucket_id, name)
);
alter table storage.buckets owner to supabase_storage_admin;
alter table storage.objects owner to supabase_storage_admin;
alter table storage.buckets enable row level security;
alter table storage.objects enable row level security;
-- As on hosted Supabase: API roles have table privileges; RLS policies decide.
grant all on storage.buckets, storage.objects to anon, authenticated, service_role, postgres;

create function storage.foldername(name text) returns text[] language plpgsql immutable as $$
declare _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1 : array_length(_parts, 1) - 1];
end $$;
create function storage.filename(name text) returns text language plpgsql immutable as $$
declare _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[array_length(_parts, 1)];
end $$;
create function storage.extension(name text) returns text language plpgsql immutable as $$
declare _parts text[]; _filename text;
begin
  select string_to_array(name, '/') into _parts;
  select _parts[array_length(_parts, 1)] into _filename;
  return reverse(split_part(reverse(_filename), '.', 1));
end $$;
alter function storage.foldername(text) owner to supabase_storage_admin;
alter function storage.filename(text) owner to supabase_storage_admin;
alter function storage.extension(text) owner to supabase_storage_admin;
grant execute on function storage.foldername(text), storage.filename(text), storage.extension(text)
  to postgres, anon, authenticated, service_role;
