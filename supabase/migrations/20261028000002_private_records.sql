-- Private, owner-only personal records + the sync RPCs (sync_push / sync_pull).
--
-- Every synced table has the same core shape:
--   owner_id  uuid → auth.users (on delete cascade)   -- account deletion removes everything
--   id        uuid  client-generated, stable across devices
--   version   bigint from private.sync_version_seq   -- server-issued CAS authority
--   payload   jsonb  the client record exactly as sent (tombstones keep only {id, deletedAt})
--   deleted_at timestamptz                            -- tombstone; never resurrected
--   created_at / updated_at                           -- server timestamps
-- plus GENERATED typed projection columns (dates, kinds, status…) for indexing and reporting.
--
-- The primary key is (owner_id, id): ids are namespaced per account, so a record id that
-- happens to exist in another account can never collide with, block, or leak that record.
--
-- Authorization: SELECT is owner-only through RLS. There are NO insert/update/delete grants;
-- every write goes through sync_push (security definer), which forces owner_id := auth.uid().

/* ============================================================== tables */

create table public.account_state (
  owner_id uuid not null references auth.users (id) on delete cascade,
  id uuid not null,
  version bigint not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  onboarded_at timestamptz generated always as (private.try_ts_ms(payload #>> '{profile,onboardedAt}')) stored,
  nutrition_mode text generated always as (private.clip(payload #>> '{nutrition,mode}', 20)) stored,
  primary key (owner_id, id),
  constraint account_state_one_row_per_user unique (owner_id),
  constraint account_state_id_is_owner check (id = owner_id)
);
comment on table public.account_state is
  'One row per account: settings, PRIVATE profile (age, height, injury notes, diet) and nutrition targets. Owner-only; never part of the social profile.';

create table public.programs (
  owner_id uuid not null references auth.users (id) on delete cascade,
  id uuid not null,
  version bigint not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  name text generated always as (private.clip(payload ->> 'name', 200)) stored,
  source text generated always as (private.clip(payload ->> 'source', 20)) stored,
  active boolean generated always as (private.try_bool(payload ->> 'active')) stored,
  start_date date generated always as (private.try_date(payload ->> 'startDate')) stored,
  current_version integer generated always as (private.try_int(payload ->> 'currentVersion')) stored,
  primary key (owner_id, id),
  constraint programs_versions_array check (deleted_at is not null or jsonb_typeof(payload -> 'versions') = 'array')
);

-- Program version history as typed rows, normalized from payload.versions by sync_push.
create table public.program_versions (
  owner_id uuid not null,
  program_id uuid not null,
  version_no integer not null,
  client_created_at timestamptz,
  reason text,
  weeks integer,
  payload jsonb not null,
  primary key (owner_id, program_id, version_no),
  foreign key (owner_id, program_id) references public.programs (owner_id, id) on delete cascade
);

create table public.templates (
  owner_id uuid not null references auth.users (id) on delete cascade,
  id uuid not null,
  version bigint not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  name text generated always as (private.clip(payload #>> '{template,name}', 200)) stored,
  kind text generated always as (private.clip(payload #>> '{template,kind}', 20)) stored,
  primary key (owner_id, id)
);

create table public.workout_sessions (
  owner_id uuid not null references auth.users (id) on delete cascade,
  id uuid not null,
  version bigint not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  name text generated always as (private.clip(payload ->> 'name', 200)) stored,
  status text generated always as (private.clip(payload ->> 'status', 20)) stored,
  session_date date generated always as (private.try_date(payload ->> 'date')) stored,
  started_at timestamptz generated always as (private.try_ts_ms(payload ->> 'startedAt')) stored,
  ended_at timestamptz generated always as (private.try_ts_ms(payload ->> 'endedAt')) stored,
  program_id uuid generated always as (private.try_uuid(payload ->> 'programId')) stored,
  template_id text generated always as (private.clip(payload ->> 'templateId', 100)) stored,
  primary key (owner_id, id)
);

-- Normalized from workout_sessions.payload.exercises by sync_push (nested ids are client text ids).
create table public.session_exercises (
  owner_id uuid not null,
  session_id uuid not null,
  id text not null check (char_length(id) between 1 and 100),
  exercise_id text not null check (char_length(exercise_id) between 1 and 100),
  position integer not null,
  superset_group text,
  notes text,
  discomfort boolean not null default false,
  swapped_from text,
  primary key (owner_id, session_id, id),
  foreign key (owner_id, session_id) references public.workout_sessions (owner_id, id) on delete cascade
);
create index session_exercises_by_exercise on public.session_exercises (owner_id, exercise_id);

create table public.session_sets (
  owner_id uuid not null,
  session_id uuid not null,
  session_exercise_id text not null,
  id text not null check (char_length(id) between 1 and 100),
  position integer not null,
  set_type text not null check (set_type in ('warmup', 'normal', 'drop', 'timed')),
  weight_kg numeric,
  reps integer check (reps is null or reps >= 0),
  duration_sec numeric check (duration_sec is null or duration_sec >= 0),
  distance_m numeric check (distance_m is null or distance_m >= 0),
  rpe numeric,
  rir numeric,
  completed boolean not null default false,
  completed_at timestamptz,
  primary key (owner_id, session_id, session_exercise_id, id),
  foreign key (owner_id, session_id, session_exercise_id)
    references public.session_exercises (owner_id, session_id, id) on delete cascade
);

create table public.activities (
  owner_id uuid not null references auth.users (id) on delete cascade,
  id uuid not null,
  version bigint not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  activity_type text generated always as (private.clip(payload ->> 'type', 30)) stored,
  activity_date date generated always as (private.try_date(payload ->> 'date')) stored,
  duration_sec numeric generated always as (private.try_num(payload ->> 'durationSec')) stored,
  distance_m numeric generated always as (private.try_num(payload ->> 'distanceM')) stored,
  primary key (owner_id, id)
);

create table public.activity_templates (
  owner_id uuid not null references auth.users (id) on delete cascade,
  id uuid not null,
  version bigint not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  name text generated always as (private.clip(payload ->> 'name', 200)) stored,
  activity_type text generated always as (private.clip(payload ->> 'type', 30)) stored,
  primary key (owner_id, id)
);

create table public.measurements (
  owner_id uuid not null references auth.users (id) on delete cascade,
  id uuid not null,
  version bigint not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  kind text generated always as (private.clip(payload ->> 'kind', 30)) stored,
  measured_on date generated always as (private.try_date(payload ->> 'date')) stored,
  value numeric generated always as (private.try_num(payload ->> 'value')) stored,
  primary key (owner_id, id)
);

create table public.goals (
  owner_id uuid not null references auth.users (id) on delete cascade,
  id uuid not null,
  version bigint not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  title text generated always as (private.clip(payload ->> 'title', 200)) stored,
  kind text generated always as (private.clip(payload ->> 'kind', 30)) stored,
  primary key (owner_id, id)
);

create table public.custom_exercises (
  owner_id uuid not null references auth.users (id) on delete cascade,
  id uuid not null,
  version bigint not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  name text generated always as (private.clip(payload ->> 'name', 200)) stored,
  primary key (owner_id, id)
);

create table public.custom_foods (
  owner_id uuid not null references auth.users (id) on delete cascade,
  id uuid not null,
  version bigint not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  name text generated always as (private.clip(payload ->> 'name', 200)) stored,
  primary key (owner_id, id)
);

create table public.food_logs (
  owner_id uuid not null references auth.users (id) on delete cascade,
  id uuid not null,
  version bigint not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  log_date date generated always as (private.try_date(payload ->> 'date')) stored,
  meal text generated always as (private.clip(payload ->> 'meal', 20)) stored,
  primary key (owner_id, id)
);

create table public.saved_meals (
  owner_id uuid not null references auth.users (id) on delete cascade,
  id uuid not null,
  version bigint not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  name text generated always as (private.clip(payload ->> 'name', 200)) stored,
  primary key (owner_id, id)
);

create table public.meal_plans (
  owner_id uuid not null references auth.users (id) on delete cascade,
  id uuid not null,
  version bigint not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  week_start date generated always as (private.try_date(payload ->> 'weekStart')) stored,
  primary key (owner_id, id)
);

/* ==================================================== indexes, RLS, grants */

-- Entity name (as used by the client, see src/db/db.ts SYNCED_ENTITIES) → table.
create or replace function private.sync_table(p_entity text) returns text
language sql immutable set search_path = '' as $$
  select case p_entity
    when 'account_state' then 'account_state'
    when 'programs' then 'programs'
    when 'templates' then 'templates'
    when 'sessions' then 'workout_sessions'
    when 'activities' then 'activities'
    when 'activity_templates' then 'activity_templates'
    when 'measurements' then 'measurements'
    when 'goals' then 'goals'
    when 'custom_exercises' then 'custom_exercises'
    when 'custom_foods' then 'custom_foods'
    when 'food_logs' then 'food_logs'
    when 'saved_meals' then 'saved_meals'
    when 'meal_plans' then 'meal_plans'
  end
$$;

do $$
declare t text;
begin
  foreach t in array array['account_state','programs','templates','workout_sessions','activities','activity_templates',
                           'measurements','goals','custom_exercises','custom_foods','food_logs','saved_meals','meal_plans']
  loop
    execute format('create index %I on public.%I (owner_id, version)', t || '_owner_version', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('create policy "owner can read" on public.%I for select to authenticated using (owner_id = (select auth.uid()))', t);
  end loop;
  foreach t in array array['program_versions','session_exercises','session_sets'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('create policy "owner can read" on public.%I for select to authenticated using (owner_id = (select auth.uid()))', t);
  end loop;
end $$;

create index workout_sessions_by_date on public.workout_sessions (owner_id, session_date);
create index activities_by_date on public.activities (owner_id, activity_date);
create index measurements_by_kind_date on public.measurements (owner_id, kind, measured_on);
create index food_logs_by_date on public.food_logs (owner_id, log_date);
create index meal_plans_by_week on public.meal_plans (owner_id, week_start);

/* ======================================================= normalization */

create or replace function private.normalize_session(p_owner uuid, p_id uuid, p_payload jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_ex jsonb;
begin
  delete from public.session_exercises where owner_id = p_owner and session_id = p_id; -- cascades to sets
  if p_payload is null or jsonb_typeof(p_payload -> 'exercises') is distinct from 'array' then return; end if;

  insert into public.session_exercises (owner_id, session_id, id, exercise_id, position, superset_group, notes, discomfort, swapped_from)
  select p_owner, p_id, left(e.value ->> 'id', 100), left(e.value ->> 'exerciseId', 100),
         coalesce(private.try_int(e.value ->> 'order'), e.ord::int - 1),
         left(e.value ->> 'supersetGroup', 50), left(e.value ->> 'notes', 2000),
         coalesce(private.try_bool(e.value ->> 'discomfort'), false), left(e.value ->> 'swappedFrom', 100)
    from jsonb_array_elements(p_payload -> 'exercises') with ordinality as e(value, ord)
   where jsonb_typeof(e.value) = 'object'
     and coalesce(e.value ->> 'id', '') <> '' and coalesce(e.value ->> 'exerciseId', '') <> ''
  on conflict do nothing;

  for v_ex in select e.value from jsonb_array_elements(p_payload -> 'exercises') e(value)
               where jsonb_typeof(e.value) = 'object' and jsonb_typeof(e.value -> 'sets') = 'array'
                 and coalesce(e.value ->> 'id', '') <> '' and coalesce(e.value ->> 'exerciseId', '') <> ''
  loop
    insert into public.session_sets (owner_id, session_id, session_exercise_id, id, position, set_type, weight_kg, reps,
                                     duration_sec, distance_m, rpe, rir, completed, completed_at)
    select p_owner, p_id, left(v_ex ->> 'id', 100), left(s.value ->> 'id', 100), s.ord::int - 1,
           case when s.value ->> 'type' in ('warmup', 'normal', 'drop', 'timed') then s.value ->> 'type' else 'normal' end,
           private.try_num(s.value ->> 'weightKg'),
           case when private.try_int(s.value ->> 'reps') < 0 then 0 else private.try_int(s.value ->> 'reps') end,
           abs(private.try_num(s.value ->> 'durationSec')),
           abs(private.try_num(s.value ->> 'distanceM')),
           private.try_num(s.value ->> 'rpe'), private.try_num(s.value ->> 'rir'),
           coalesce(private.try_bool(s.value ->> 'completed'), false),
           private.try_ts_ms(s.value ->> 'completedAt')
      from jsonb_array_elements(v_ex -> 'sets') with ordinality as s(value, ord)
     where jsonb_typeof(s.value) = 'object' and coalesce(s.value ->> 'id', '') <> ''
    on conflict do nothing;
  end loop;
end $$;

create or replace function private.normalize_program(p_owner uuid, p_id uuid, p_payload jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from public.program_versions where owner_id = p_owner and program_id = p_id;
  if p_payload is null or jsonb_typeof(p_payload -> 'versions') is distinct from 'array' then return; end if;
  insert into public.program_versions (owner_id, program_id, version_no, client_created_at, reason, weeks, payload)
  select p_owner, p_id, private.try_int(v.value ->> 'version'), private.try_ts_ms(v.value ->> 'createdAt'),
         left(v.value ->> 'reason', 500), private.try_int(v.value ->> 'weeks'), v.value
    from jsonb_array_elements(p_payload -> 'versions') v(value)
   where jsonb_typeof(v.value) = 'object' and private.try_int(v.value ->> 'version') is not null
  on conflict do nothing;
end $$;

/* ============================================================ sync RPCs */

-- Atomic compare-and-swap push of one record. See src/backend/contract.ts (PushResult).
create or replace function public.sync_push(p_entity text, p_id uuid, p_op text, p_base_version bigint, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_table text := private.sync_table(p_entity);
  v_exists boolean;
  v_cur_version bigint;
  v_cur_payload jsonb;
  v_cur_deleted timestamptz;
  v_version bigint;
  v_tomb jsonb;
  v_n integer;
begin
  if v_table is null then
    raise exception 'Unknown record type "%".', p_entity using errcode = '22023';
  end if;
  if p_op is null or p_op not in ('upsert', 'delete') then
    raise exception 'Unknown sync operation "%".', p_op using errcode = '22023';
  end if;
  -- The single account_state row is keyed by the account itself (client local id is 'account').
  if p_entity = 'account_state' then p_id := v_uid; end if;
  if p_id is null then
    raise exception 'Record id is required.' using errcode = '22023';
  end if;
  if p_op = 'upsert' then
    if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
      raise exception 'Record payload must be a JSON object.' using errcode = '22023';
    end if;
    if octet_length(p_payload::text) > 1048576 then
      raise exception 'This record is too large to sync (limit 1 MB).' using errcode = '22023';
    end if;
    if p_entity <> 'account_state' and p_payload ? 'id' and (p_payload ->> 'id') is distinct from p_id::text then
      raise exception 'Record id does not match its payload.' using errcode = '22023';
    end if;
    if p_entity = 'programs' and jsonb_typeof(p_payload -> 'versions') is distinct from 'array' then
      raise exception 'A program must include its versions.' using errcode = '22023';
    end if;
  end if;

  -- Serialize all pushes of one account: versions are assigned and committed in order, so
  -- sync_pull's "version > cursor" never skips a row that commits late.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('sync:' || v_uid::text, 0));

  execute format('select version, payload, deleted_at from public.%I where owner_id = $1 and id = $2 for update', v_table)
     into v_cur_version, v_cur_payload, v_cur_deleted using v_uid, p_id;
  get diagnostics v_n = row_count;
  v_exists := v_n > 0;

  v_tomb := jsonb_build_object('id', coalesce(p_payload ->> 'id', p_id::text),
                               'deletedAt', coalesce(p_payload -> 'deletedAt', to_jsonb((extract(epoch from now()) * 1000)::bigint)));

  if not v_exists then
    v_version := nextval('private.sync_version_seq');
    if p_op = 'delete' then
      -- Deleting a record the server never saw: store a tombstone so a stale device can't create it later.
      execute format('insert into public.%I (owner_id, id, version, payload, deleted_at) values ($1, $2, $3, $4, now())', v_table)
        using v_uid, p_id, v_version, v_tomb;
    else
      execute format('insert into public.%I (owner_id, id, version, payload) values ($1, $2, $3, $4)', v_table)
        using v_uid, p_id, v_version, p_payload;
      if v_table = 'workout_sessions' then perform private.normalize_session(v_uid, p_id, p_payload); end if;
      if v_table = 'programs' then perform private.normalize_program(v_uid, p_id, p_payload); end if;
    end if;
    return jsonb_build_object('status', 'ok', 'version', v_version);
  end if;

  -- Tombstones win: deletions are final, a stale device can never resurrect the record.
  if v_cur_deleted is not null then
    if p_op = 'delete' then
      return jsonb_build_object('status', 'ok', 'version', v_cur_version); -- idempotent delete
    end if;
    return jsonb_build_object('status', 'gone', 'version', v_cur_version);
  end if;

  -- Compare-and-swap on the server-issued version. Never overwrite on mismatch.
  if p_base_version is null or p_base_version <> v_cur_version then
    return jsonb_build_object('status', 'conflict', 'version', v_cur_version, 'payload', v_cur_payload, 'deleted', false);
  end if;

  v_version := nextval('private.sync_version_seq');
  if p_op = 'delete' then
    execute format('update public.%I set version = $3, payload = $4, deleted_at = now(), updated_at = now() where owner_id = $1 and id = $2', v_table)
      using v_uid, p_id, v_version, v_tomb;
    if v_table = 'workout_sessions' then perform private.normalize_session(v_uid, p_id, null); end if;
    if v_table = 'programs' then perform private.normalize_program(v_uid, p_id, null); end if;
  else
    execute format('update public.%I set version = $3, payload = $4, updated_at = now() where owner_id = $1 and id = $2', v_table)
      using v_uid, p_id, v_version, p_payload;
    if v_table = 'workout_sessions' then perform private.normalize_session(v_uid, p_id, p_payload); end if;
    if v_table = 'programs' then perform private.normalize_program(v_uid, p_id, p_payload); end if;
  end if;
  return jsonb_build_object('status', 'ok', 'version', v_version);
end $$;

-- Changes for the caller with version > p_since, ascending. See contract.ts (PullResult).
create or replace function public.sync_pull(p_since bigint default 0, p_limit integer default 500)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 1000);
  v_since bigint := coalesce(p_since, 0);
  v_sql text;
  v_rows jsonb;
  v_count integer;
  v_cursor bigint;
begin
  select string_agg(format(
    '(select %L::text as entity, id, version, deleted_at, payload from public.%I where owner_id = $1 and version > $2 order by version limit $3)',
    e.entity, private.sync_table(e.entity)), ' union all ')
    into v_sql
    from unnest(array['account_state','programs','templates','sessions','activities','activity_templates','measurements',
                      'goals','custom_exercises','custom_foods','food_logs','saved_meals','meal_plans']) as e(entity);

  execute format(
    'select coalesce(jsonb_agg(jsonb_build_object(''entity'', c.entity, ''id'', c.id, ''version'', c.version,
            ''deleted'', c.deleted_at is not null, ''payload'', case when c.deleted_at is null then c.payload end) order by c.version), ''[]''::jsonb),
            count(*)
       from (select * from (%s) u order by version limit $3) c', v_sql)
    into v_rows, v_count using v_uid, v_since, v_limit + 1;

  if v_count > v_limit then
    v_rows := v_rows - v_limit; -- drop the look-ahead row
  end if;
  select coalesce(max((r ->> 'version')::bigint), v_since) into v_cursor from jsonb_array_elements(v_rows) r;
  return jsonb_build_object('changes', v_rows, 'cursor', v_cursor, 'hasMore', v_count > v_limit);
end $$;

revoke all on function public.sync_push(text, uuid, text, bigint, jsonb) from public, anon;
revoke all on function public.sync_pull(bigint, integer) from public, anon;
grant execute on function public.sync_push(text, uuid, text, bigint, jsonb) to authenticated;
grant execute on function public.sync_pull(bigint, integer) to authenticated;
