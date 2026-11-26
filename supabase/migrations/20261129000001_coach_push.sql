-- Coach-initiated push notifications, phase 1 (roadmap item 9). Additive only; extends the 2026-11-01 push pipeline.
--
--   * push_prefs  + daily_cap (1..3, default 2), snooze_until (UTC instant, nullable), revision (monotonic; optimistic
--                   concurrency for update_push_prefs). New kind 'food_unlogged' (never in the default kinds: off).
--   * push_jobs   + typed source (source_type/source_ref/event_date), expiry, claim token + lease, the preference
--                   revision a dispatch was checked against, dispatch state, and the cached copy's language/source.
--   * private.push_quota     service-only reservation ledger keyed by (user, local date, logical event). One logical
--                            event ('training' or 'food' per local day) counts once across all devices.
--   * private.sync_receipts  server-stamped "a full sync finished" receipt (record_sync_complete). A record's
--                            updated_at is not evidence that synchronization finished; food reminders need a receipt
--                            from the current local day and the last 24 hours, otherwise they are skipped.
--   * Workout / missed-workout jobs stay device-uploaded candidates (replace_scheduled_jobs); the server re-checks the
--     synchronized sessions, activities and plan overrides before sending. Food-log jobs are server-owned
--     (push_generate_food, one per local day at 19:00).
--   * Every proactive reminder is checked twice by push-send (push_check 'prepare' before the copy is written, which
--     also reserves quota atomically; 'dispatch' right before sending). Settlement (push_finish) needs the owning
--     claim token. A crashed dispatch is never re-sent: it settles as 'ambiguous' and consumes its reservation.
--   * Rollout: push_claim_due (the function the pre-phase-1 worker calls) never hands out coach reminders any more and
--     its claims carry no token, so an old worker's tokenless settlement still works for what it can claim. The new
--     worker calls push_claim_due_v2. Claims made before this migration (claimed_at set, no token) are settled by a
--     tokenless result once, then never reclaimed.
--   * Account binding: subscription and preference writes accept an optional expectedUserId; a mismatch with
--     auth.uid() (the app switched accounts mid-operation) raises 'account_changed' and writes nothing.
-- Owner-only reads, RPC-only writes, auth.uid() ownership, search_path = '', service-role-only worker functions and
-- cascading account deletion are unchanged. No client-supplied recipient is accepted anywhere.

/* ============================================================ push_prefs */

alter table public.push_prefs
  add column if not exists daily_cap smallint not null default 2,
  add column if not exists snooze_until timestamptz,
  add column if not exists revision bigint not null default 1;
alter table public.push_prefs drop constraint if exists push_prefs_daily_cap_check;
alter table public.push_prefs add constraint push_prefs_daily_cap_check check (daily_cap between 1 and 3);
alter table public.push_prefs drop constraint if exists push_prefs_revision_check;
alter table public.push_prefs add constraint push_prefs_revision_check check (revision >= 1);
alter table public.push_prefs drop constraint if exists push_prefs_kinds_check;
alter table public.push_prefs add constraint push_prefs_kinds_check
  check (kinds <@ array['workout_reminder', 'rest_over', 'coaching', 'social', 'missed_nudge', 'food_unlogged']);

/* ============================================================ push_jobs */

alter table public.push_jobs
  add column if not exists source_type text,
  add column if not exists source_ref text,
  add column if not exists event_date date,
  add column if not exists expires_at timestamptz,
  add column if not exists claim_token uuid,
  add column if not exists lease_until timestamptz,
  add column if not exists prefs_revision bigint,
  add column if not exists dispatch_state text not null default 'pending',
  add column if not exists outcome text,
  add column if not exists copy_language text,
  add column if not exists copy_source text;
alter table public.push_jobs drop constraint if exists push_jobs_kind_check;
alter table public.push_jobs add constraint push_jobs_kind_check
  check (kind in ('workout_reminder', 'rest_over', 'coaching', 'social', 'missed_nudge', 'test', 'food_unlogged'));
alter table public.push_jobs drop constraint if exists push_jobs_source_type_check;
alter table public.push_jobs add constraint push_jobs_source_type_check
  check (source_type is null or source_type in ('planned_session', 'missed_session', 'food_day'));
alter table public.push_jobs drop constraint if exists push_jobs_source_ref_check;
alter table public.push_jobs add constraint push_jobs_source_ref_check check (source_ref is null or char_length(source_ref) <= 100);
alter table public.push_jobs drop constraint if exists push_jobs_dispatch_state_check;
alter table public.push_jobs add constraint push_jobs_dispatch_state_check
  check (dispatch_state in ('pending', 'claimed', 'dispatching', 'sent', 'ambiguous', 'discarded'));
alter table public.push_jobs drop constraint if exists push_jobs_outcome_check;
alter table public.push_jobs add constraint push_jobs_outcome_check check (outcome is null or char_length(outcome) <= 40);
alter table public.push_jobs drop constraint if exists push_jobs_copy_language_check;
alter table public.push_jobs add constraint push_jobs_copy_language_check check (copy_language is null or copy_language in ('en', 'is'));
alter table public.push_jobs drop constraint if exists push_jobs_copy_source_check;
alter table public.push_jobs add constraint push_jobs_copy_source_check check (copy_source is null or copy_source in ('ai', 'fallback'));

update public.push_jobs set dispatch_state = 'sent' where sent_at is not null and dispatch_state = 'pending';

comment on column public.push_jobs.dispatch_state is
  'pending → claimed (claim_token + lease_until) → dispatching (checked, about to send) → sent | ambiguous (outcome unknown: never re-sent) | discarded (ineligible at send time; never revived).';

/* ============================================================ service-only ledgers */

create table if not exists private.push_quota (
  user_id uuid not null references auth.users (id) on delete cascade,
  local_date date not null,
  event_key text not null check (char_length(event_key) between 1 and 60),
  job_id uuid,
  state text not null default 'reserved' check (state in ('reserved', 'consumed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, local_date, event_key)
);
create index if not exists push_quota_job on private.push_quota (job_id);
revoke all on table private.push_quota from public, anon, authenticated;
comment on table private.push_quota is
  'Daily coach-reminder quota: one row per (user, local date, logical event). Reserved before the copy is written, consumed on send or an ambiguous outcome, released when a job is discarded. Service-only.';

create table if not exists private.sync_receipts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  completed_at timestamptz not null
);
revoke all on table private.sync_receipts from public, anon, authenticated;
comment on table private.sync_receipts is
  'Server-stamped time of the account''s last completed sync (record_sync_complete). Food-log reminders need one from today (local) and the last 24 h.';

/* ============================================================ quota lifecycle (no worker callback needed) */

-- Every way a job ends releases or consumes its reservation in the same transaction: sent/ambiguous consume it;
-- cancelled (opt-out, re-upload, cancel_push_job, last device removed, too many attempts) or discarded release it;
-- a deleted job releases it.
create or replace function private.trg_push_job_quota() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    delete from private.push_quota where job_id = old.id and state = 'reserved';
    return null;
  end if;
  if new.sent_at is not null and old.sent_at is null then
    update private.push_quota set state = 'consumed', updated_at = now() where job_id = new.id and state = 'reserved';
  elsif (new.cancelled_at is not null and old.cancelled_at is null)
        or (new.dispatch_state = 'discarded' and old.dispatch_state is distinct from 'discarded') then
    delete from private.push_quota where job_id = new.id and state = 'reserved';
  end if;
  return null;
end $$;
drop trigger if exists push_job_quota on public.push_jobs;
create trigger push_job_quota after update of sent_at, cancelled_at, dispatch_state or delete on public.push_jobs
  for each row execute function private.trg_push_job_quota();

/* ============================================================ helpers */

-- The instant quiet hours end if p_at is inside them (in p_tz), else null. Equal start and end = no quiet hours.
create or replace function private.push_quiet_until(p_tz text, p_start time, p_end time, p_at timestamptz) returns timestamptz
language plpgsql stable security definer set search_path = '' as $$
declare
  v_local timestamp := p_at at time zone coalesce(p_tz, 'UTC');
  v_t time := v_local::time;
  v_d date := v_local::date;
  v_start time := coalesce(p_start, '22:00'::time);
  v_end time := coalesce(p_end, '07:00'::time);
  v_until timestamptz;
begin
  if v_start = v_end then return null; end if;
  if not (case when v_start > v_end then v_t >= v_start or v_t < v_end else v_t >= v_start and v_t < v_end end) then
    return null;
  end if;
  v_until := (v_d + v_end) at time zone coalesce(p_tz, 'UTC');
  if v_until <= p_at then v_until := (v_d + 1 + v_end) at time zone coalesce(p_tz, 'UTC'); end if;
  return v_until;
end $$;

-- Templates the user's CURRENT synced active program plans on p_date (src/domain/program/schedule.ts rawItems: the
-- current version's weekday slots from startDate on, minus skipped/moved overrides, plus sessions moved to the day),
-- and whether each is a cardio-only template (done by any logged activity that day).
create or replace function private.push_planned_on(p_uid uuid, p_date date)
returns table (template_id text, cardio_only boolean)
language sql stable security definer set search_path = '' as $$
  with pr as (
    select p.payload from public.programs p
     where p.owner_id = p_uid and p.deleted_at is null and p.active is true
     order by p.updated_at desc limit 1
  ), v as (
    select x from pr cross join lateral jsonb_array_elements(case when jsonb_typeof(pr.payload -> 'versions') = 'array' then pr.payload -> 'versions' else '[]'::jsonb end) x
     where x ->> 'version' = pr.payload ->> 'currentVersion'
     limit 1
  ), ov as (
    select o from pr cross join lateral jsonb_array_elements(case when jsonb_typeof(pr.payload -> 'overrides') = 'array' then pr.payload -> 'overrides' else '[]'::jsonb end) o
  ), slots as (
    select s ->> 'templateId' as tid
      from pr cross join v cross join lateral jsonb_array_elements(case when jsonb_typeof(v.x -> 'schedule') = 'array' then v.x -> 'schedule' else '[]'::jsonb end) s
     where private.try_int(s ->> 'weekday') = extract(dow from p_date)::int
       and p_date >= coalesce(private.try_date(pr.payload ->> 'startDate'), p_date)
       and not exists (select 1 from ov where ov.o ->> 'date' = p_date::text and ov.o ->> 'templateId' = s ->> 'templateId'
                                          and ov.o ->> 'status' in ('skipped', 'moved'))
  ), moved as (
    select ov.o ->> 'templateId' as tid from ov where ov.o ->> 'status' = 'moved' and ov.o ->> 'movedTo' = p_date::text
  ), ids as (
    select tid from slots union select tid from moved
  )
  select ids.tid,
         (jsonb_typeof(t -> 'cardio') = 'object'
          and coalesce(jsonb_array_length(case when jsonb_typeof(t -> 'exercises') = 'array' then t -> 'exercises' end), 0) = 0)
    from ids cross join v
    cross join lateral (select t from jsonb_array_elements(case when jsonb_typeof(v.x -> 'templates') = 'array' then v.x -> 'templates' else '[]'::jsonb end) t
                         where t ->> 'id' = ids.tid limit 1) tt
$$;

-- The app may assert which account an operation was started for; a different signed-in account writes nothing.
create or replace function private.push_assert_account(p_expected text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_expected is not null and p_expected is distinct from (select auth.uid())::text then
    raise exception 'The signed-in account changed. Nothing was saved.' using errcode = 'P0001', hint = 'account_changed';
  end if;
end $$;

create or replace function private.push_proactive(p_kind text) returns boolean
language sql immutable security definer set search_path = '' as $$
  select p_kind in ('workout_reminder', 'missed_nudge', 'food_unlogged')
$$;

create or replace function private.push_prefs_json(p public.push_prefs) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'kinds', to_jsonb(coalesce(p.kinds, array['workout_reminder', 'rest_over', 'coaching', 'missed_nudge'])),
    'fixedReminderTime', case when p.fixed_reminder_time is null then null else to_char(p.fixed_reminder_time, 'HH24:MI') end,
    'timeZone', coalesce(p.time_zone, 'UTC'),
    'quietStart', to_char(coalesce(p.quiet_start, '22:00'::time), 'HH24:MI'),
    'quietEnd', to_char(coalesce(p.quiet_end, '07:00'::time), 'HH24:MI'),
    'dailyCap', coalesce(p.daily_cap, 2),
    'snoozeUntil', case when p.snooze_until is null or p.snooze_until <= now() then null
                        else to_char(p.snooze_until at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') end,
    'revision', coalesce(p.revision, 0))
$$;

-- Applies a preference patch to the caller's row and bumps the revision. Returns the stored row, or raises 22023 with
-- the field name as HINT ('kinds', 'time', 'timeZone', 'cap', 'snoozeDays').
--   kinds text[] · fixedReminderTime 'HH:MM' | null · timeZone · quietStart / quietEnd 'HH:MM' · dailyCap 1..3 ·
--   snoozeDays 1|3|7|14 (pause until the same local time N calendar days later) · resume true (clear the pause).
-- p_keep_new: legacy set_push_prefs keeps the caller's food_unlogged choice when it sends a kinds list (old apps don't
-- know about it and must not switch it off).
create or replace function private.push_apply_prefs(p_uid uuid, p jsonb, p_keep_new boolean) returns public.push_prefs
language plpgsql security definer set search_path = '' as $$
declare
  s public.push_prefs;
  v_kinds text[];
  v_days integer;
  v_cap integer;
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'Settings must be a JSON object.' using errcode = '22023'; end if;
  insert into public.push_prefs (user_id) values (p_uid) on conflict (user_id) do nothing;
  select * into s from public.push_prefs where user_id = p_uid for update;
  if p ? 'kinds' then
    if jsonb_typeof(p -> 'kinds') <> 'array' then raise exception 'kinds must be a list.' using errcode = '22023', hint = 'kinds'; end if;
    select coalesce(array_agg(distinct k), '{}') into v_kinds from jsonb_array_elements_text(p -> 'kinds') k;
    if not v_kinds <@ array['workout_reminder', 'rest_over', 'coaching', 'social', 'missed_nudge', 'food_unlogged'] then
      raise exception 'Unknown notification kind.' using errcode = '22023', hint = 'kinds';
    end if;
    if p_keep_new then
      v_kinds := array_remove(v_kinds, 'food_unlogged');
      if 'food_unlogged' = any (s.kinds) then v_kinds := array_append(v_kinds, 'food_unlogged'); end if;
    end if;
    s.kinds := v_kinds;
    -- Pending pushes of kinds that were just switched off never go out.
    update public.push_jobs set cancelled_at = now()
     where user_id = p_uid and sent_at is null and cancelled_at is null and kind <> 'test' and not (kind = any (v_kinds))
       and dispatch_state in ('pending', 'claimed');
  end if;
  if p ? 'fixedReminderTime' then
    if jsonb_typeof(p -> 'fixedReminderTime') = 'null' then s.fixed_reminder_time := null;
    elsif coalesce(p ->> 'fixedReminderTime', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then s.fixed_reminder_time := (p ->> 'fixedReminderTime')::time;
    else raise exception 'fixedReminderTime must be HH:MM or null.' using errcode = '22023', hint = 'time'; end if;
  end if;
  if p ? 'timeZone' then
    if not exists (select 1 from pg_catalog.pg_timezone_names where name = p ->> 'timeZone') then
      raise exception 'Unknown time zone.' using errcode = '22023', hint = 'timeZone';
    end if;
    s.time_zone := p ->> 'timeZone';
  end if;
  if p ? 'quietStart' then
    if coalesce(p ->> 'quietStart', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'quietStart must be HH:MM.' using errcode = '22023', hint = 'time'; end if;
    s.quiet_start := (p ->> 'quietStart')::time;
  end if;
  if p ? 'quietEnd' then
    if coalesce(p ->> 'quietEnd', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'quietEnd must be HH:MM.' using errcode = '22023', hint = 'time'; end if;
    s.quiet_end := (p ->> 'quietEnd')::time;
  end if;
  if p ? 'dailyCap' then
    v_cap := case when jsonb_typeof(p -> 'dailyCap') = 'number' and (p ->> 'dailyCap') ~ '^[123]$' then (p ->> 'dailyCap')::integer end;
    if v_cap is null then raise exception 'dailyCap must be 1, 2 or 3.' using errcode = '22023', hint = 'cap'; end if;
    s.daily_cap := v_cap;
  end if;
  if p ? 'snoozeDays' then
    v_days := case when jsonb_typeof(p -> 'snoozeDays') = 'number' and (p ->> 'snoozeDays') in ('1', '3', '7', '14') then (p ->> 'snoozeDays')::integer end;
    if v_days is null then raise exception 'snoozeDays must be 1, 3, 7 or 14.' using errcode = '22023', hint = 'snoozeDays'; end if;
    -- Same local wall-clock time N calendar days later (DST-aware), stored as a UTC instant.
    s.snooze_until := ((now() at time zone s.time_zone) + make_interval(days => v_days)) at time zone s.time_zone;
  elsif p -> 'resume' = 'true'::jsonb then
    s.snooze_until := null;
  end if;
  update public.push_prefs
     set kinds = s.kinds, fixed_reminder_time = s.fixed_reminder_time, time_zone = s.time_zone,
         quiet_start = s.quiet_start, quiet_end = s.quiet_end, daily_cap = s.daily_cap, snooze_until = s.snooze_until,
         revision = s.revision + 1, updated_at = now()
   where user_id = p_uid
  returning * into s;
  return s;
end $$;

/* ============================================================ client RPCs (caller = auth.uid()) */

-- p: { endpoint, p256dh, auth, userAgent?, expectedUserId? }. A device used by another account moves to the caller.
create or replace function public.save_push_subscription(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v public.push_subscriptions;
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'Subscription must be a JSON object.' using errcode = '22023'; end if;
  perform private.push_assert_account(p ->> 'expectedUserId');
  perform private.enforce_rate_limit(v_uid, 'push_subscribe', 60, interval '1 hour', 'Too many notification changes. Please wait a little.');
  insert into public.push_subscriptions as s (user_id, endpoint, p256dh, auth, user_agent)
  values (v_uid, p ->> 'endpoint', p ->> 'p256dh', p ->> 'auth', left(p ->> 'userAgent', 300))
  on conflict (endpoint) do update
     set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent, failed_count = 0
  returning * into v;
  insert into public.push_prefs (user_id) values (v_uid) on conflict (user_id) do nothing;
  return jsonb_build_object('id', v.id, 'endpoint', v.endpoint, 'createdAt', v.created_at);
end $$;

-- Account-bound variant of delete_push_subscription(text).
create or replace function public.delete_push_subscription(p_endpoint text, p_expected_user uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform private.push_assert_account(p_expected_user::text);
  return public.delete_push_subscription(p_endpoint);
end $$;

-- Does the caller own this device's subscription? ('mine' | 'other' | 'none') — lets an account that returns to a
-- shared browser take its device back after another account used it.
create or replace function public.push_device_owner(p_endpoint text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid(); v_owner uuid;
begin
  select user_id into v_owner from public.push_subscriptions where endpoint = p_endpoint;
  return case when v_owner is null then 'none' when v_owner = v_uid then 'mine' else 'other' end;
end $$;

create or replace function public.get_push_prefs() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid(); p public.push_prefs;
begin
  select * into p from public.push_prefs where user_id = v_uid;
  return private.push_prefs_json(p) || jsonb_build_object(
    'devices', (select count(*) from public.push_subscriptions where user_id = v_uid));
end $$;

-- Legacy (pre-phase-1 apps): last write wins, but newly added fields are preserved (food reminders, cap, pause).
create or replace function public.set_push_prefs(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid();
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'Settings must be a JSON object.' using errcode = '22023'; end if;
  perform private.push_assert_account(p ->> 'expectedUserId');
  perform private.enforce_rate_limit(v_uid, 'push_prefs', 240, interval '1 hour', 'Too many notification changes. Please wait a little.');
  return private.push_prefs_json(private.push_apply_prefs(v_uid, p - 'snoozeDays' - 'resume' - 'dailyCap' - 'expectedUserId', true));
end $$;

-- Phase 1: one versioned patch. p_revision must equal the stored revision, otherwise nothing is written and
-- { status: 'conflict', prefs } returns the latest settings. Invalid input → { status: 'invalid', field, prefs }.
-- Success → { status: 'ok', prefs } (the server acknowledgement a pause/resume waits for).
create or replace function public.update_push_prefs(p_patch jsonb, p_revision bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  s public.push_prefs;
  v_current bigint;
begin
  perform private.enforce_rate_limit(v_uid, 'push_prefs', 240, interval '1 hour', 'Too many notification changes. Please wait a little.');
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'Settings must be a JSON object.' using errcode = '22023'; end if;
  perform private.push_assert_account(p_patch ->> 'expectedUserId');
  p_patch := p_patch - 'expectedUserId';
  -- No row yet reads as revision 0 (get_push_prefs shows the defaults with revision 0).
  insert into public.push_prefs (user_id) values (v_uid) on conflict (user_id) do nothing returning * into s;
  if found then
    v_current := 0;
  else
    select * into s from public.push_prefs where user_id = v_uid for update;
    v_current := s.revision;
  end if;
  if p_revision is distinct from v_current then
    return jsonb_build_object('status', 'conflict', 'prefs', private.push_prefs_json(s));
  end if;
  begin
    s := private.push_apply_prefs(v_uid, p_patch, false);
  exception when sqlstate '22023' then
    declare v_hint text;
    begin
      get stacked diagnostics v_hint = pg_exception_hint;
      select * into s from public.push_prefs where user_id = v_uid;
      return jsonb_build_object('status', 'invalid', 'field', coalesce(nullif(v_hint, ''), 'unknown'), 'prefs', private.push_prefs_json(s));
    end;
  end;
  return jsonb_build_object('status', 'ok', 'prefs', private.push_prefs_json(s));
end $$;

-- The app calls this after a sync cycle that pushed and pulled everything (nothing pending, failing or in conflict).
-- The server stamps the time; repeated calls within 30 s write nothing.
create or replace function public.record_sync_complete() returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid();
begin
  insert into private.sync_receipts as r (user_id, completed_at) values (v_uid, now())
  on conflict (user_id) do update set completed_at = now() where r.completed_at < now() - interval '30 seconds';
  return true;
end $$;

-- Replaces the caller's future, unsent jobs of one client-scheduled kind with p_jobs
-- ([{ dedupeKey, fireAt (ISO), payload: { title, body, url, tag }, eventDate?, sourceDate? }], ≤ 60).
-- Workout reminders / missed-workout nudges are candidates: the event date (local day the reminder belongs to) and the
-- source date (planned day) are stored, and the job expires at the end of the event's local day. An upload never
-- touches a job a worker holds (lease), never revives a sent or discarded job, and never resets a lease.
create or replace function public.replace_scheduled_jobs(p_kind text, p_jobs jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_keys text[] := '{}';
  v_tz text;
  j jsonb;
  v_fire timestamptz;
  v_key text;
  v_event date;
  v_source date;
  v_expires timestamptz;
  n integer := 0;
begin
  if p_kind not in ('workout_reminder', 'missed_nudge', 'rest_over') then
    raise exception 'Only reminders, nudges and rest alerts can be scheduled by the app.' using errcode = '22023';
  end if;
  if p_jobs is null or jsonb_typeof(p_jobs) <> 'array' or jsonb_array_length(p_jobs) > 60 then
    raise exception 'jobs must be a list of at most 60.' using errcode = '22023';
  end if;
  perform private.enforce_rate_limit(v_uid, 'push_schedule', 900, interval '1 hour', 'Too many reminder updates. Please wait a little.');
  select coalesce(p.time_zone, 'UTC') into v_tz from public.push_prefs p where p.user_id = v_uid;
  v_tz := coalesce(v_tz, 'UTC');

  for j in select * from jsonb_array_elements(p_jobs) loop
    v_key := left(j ->> 'dedupeKey', 200);
    begin
      v_fire := (j ->> 'fireAt')::timestamptz;
    exception when others then
      raise exception 'fireAt must be an ISO timestamp.' using errcode = '22023';
    end;
    if coalesce(v_key, '') = '' then raise exception 'dedupeKey is required.' using errcode = '22023'; end if;
    if v_fire is null or v_fire < now() - interval '1 minute' or v_fire > now() + interval '15 days' then
      continue; -- in the past or too far ahead: nothing to schedule
    end if;
    v_event := null; v_source := null; v_expires := null;
    if p_kind <> 'rest_over' then
      v_event := coalesce(private.try_date(j ->> 'eventDate'), (v_fire at time zone v_tz)::date);
      v_source := coalesce(private.try_date(j ->> 'sourceDate'), case when p_kind = 'missed_nudge' then v_event - 1 else v_event end);
      v_expires := (v_event + 1)::timestamp at time zone v_tz;
      if v_fire >= v_expires or v_fire < (v_event::timestamp at time zone v_tz) then
        continue; -- a reminder must fire within its own local day
      end if;
    end if;
    v_keys := v_keys || v_key;
    insert into public.push_jobs as pj (user_id, kind, fire_at, payload, dedupe_key, source_type, source_ref, event_date, expires_at)
    values (v_uid, p_kind, v_fire, private.push_valid_payload(j -> 'payload'), v_key,
            case p_kind when 'workout_reminder' then 'planned_session' when 'missed_nudge' then 'missed_session' end,
            v_source::text, v_event, v_expires)
    on conflict (user_id, dedupe_key) do update
       set kind = excluded.kind, fire_at = excluded.fire_at, payload = excluded.payload, cancelled_at = null, claimed_at = null,
           source_type = excluded.source_type, source_ref = excluded.source_ref, event_date = excluded.event_date,
           expires_at = excluded.expires_at, dispatch_state = 'pending', claim_token = null, lease_until = null
     where pj.sent_at is null
       and (pj.dispatch_state = 'pending' or (pj.dispatch_state = 'claimed' and pj.lease_until < now()))
       and (pj.fire_at, pj.payload, pj.kind, pj.cancelled_at, pj.event_date, pj.source_ref)
           is distinct from (excluded.fire_at, excluded.payload, excluded.kind, null::timestamptz, excluded.event_date, excluded.source_ref);
    n := n + 1;
  end loop;

  update public.push_jobs set cancelled_at = now()
   where user_id = v_uid and kind = p_kind and sent_at is null and cancelled_at is null and fire_at > now() - interval '1 minute'
     and dispatch_state in ('pending', 'claimed')
     and not (dedupe_key = any (v_keys));
  return n;
end $$;

create or replace function public.cancel_push_job(p_dedupe_key text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid();
begin
  update public.push_jobs set cancelled_at = now()
   where user_id = v_uid and dedupe_key = p_dedupe_key and sent_at is null and cancelled_at is null
     and dispatch_state in ('pending', 'claimed');
  return found;
end $$;

/* ============================================================ push-send (service role only) */

-- Server-owned food-log reminders: one candidate per opted-in user and local day, at 19:00 local time. Only created
-- before 19:00 (no catch-up later that day). Eligibility is decided at send time (push_check).
create or replace function public.push_generate_food() returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  insert into public.push_jobs as pj (user_id, kind, fire_at, payload, dedupe_key, source_type, source_ref, event_date, expires_at)
  select p.user_id, 'food_unlogged', (d.local_date + time '19:00') at time zone p.time_zone,
         jsonb_build_object('title', 'Hard Earned', 'body', 'Want to update your food log? Do it whenever it suits you.', 'url', '/nutrition/log', 'tag', 'food'),
         'food:' || d.local_date::text, 'food_day', d.local_date::text, d.local_date, (d.local_date + 1)::timestamp at time zone p.time_zone
    from public.push_prefs p
    cross join lateral (select (now() at time zone p.time_zone) as local_ts) l
    cross join lateral (select l.local_ts::date as local_date) d
   where 'food_unlogged' = any (p.kinds)
     and l.local_ts::time < time '19:00'
     and exists (select 1 from public.push_subscriptions s where s.user_id = p.user_id)
     and not exists (select 1 from public.push_jobs x where x.user_id = p.user_id and x.dedupe_key = 'food:' || d.local_date::text and x.cancelled_at is null)
  on conflict (user_id, dedupe_key) do update set cancelled_at = null
   where pj.cancelled_at is not null and pj.sent_at is null and pj.dispatch_state = 'pending';
  get diagnostics n = row_count;
  return n;
end $$;

-- LEGACY claim (the pre-phase-1 push-send worker). It never hands out coach reminders (that worker can't run the
-- eligibility, quota and copy checks) and its claims carry no token, so that worker's tokenless results settle them.
create or replace function public.push_claim_due(p_limit integer default 50) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  with picked as (
    select j.id from public.push_jobs j
     where j.fire_at <= now() and j.sent_at is null and j.cancelled_at is null
       and not private.push_proactive(j.kind)
       and j.dispatch_state in ('pending', 'claimed')
       and (case when j.lease_until is null then j.claimed_at is null or j.claimed_at < now() - interval '2 minutes'
                 else j.lease_until < now() end)
     order by j.fire_at
     limit least(greatest(coalesce(p_limit, 50), 1), 200)
     for update skip locked
  ), claimed as (
    update public.push_jobs j
       set claimed_at = now(), lease_until = now() + interval '2 minutes', claim_token = null,
           dispatch_state = 'claimed', attempts = j.attempts + 1
      from picked where j.id = picked.id
    returning j.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'userId', c.user_id, 'kind', c.kind, 'fireAt', c.fire_at, 'payload', c.payload, 'attempts', c.attempts,
           'prefs', (select private.push_prefs_json(p) from public.push_prefs p where p.user_id = c.user_id),
           'subscriptions', coalesce((select jsonb_agg(jsonb_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth))
                                        from public.push_subscriptions s where s.user_id = c.user_id), '[]'::jsonb))
         order by c.fire_at), '[]'::jsonb)
    into v from claimed c;
  return v;
end $$;

-- Phase-1 claim: up to p_limit due jobs (FOR UPDATE SKIP LOCKED), each with a fresh claim token and a 2-minute lease;
-- only the token holder can check or settle the job. Rest alerts, tests, coaching and social pushes are handed out
-- before coach reminders so a slow copy model never delays them. A dispatch whose worker died after the
-- 'dispatching' check is settled as 'ambiguous' (consumes its reservation, never re-sent).
create or replace function public.push_claim_due_v2(p_limit integer default 50) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  update public.push_jobs j set dispatch_state = 'ambiguous', outcome = 'lease_expired', sent_at = now(), lease_until = null, claim_token = null
   where j.dispatch_state = 'dispatching' and j.lease_until < now() and j.sent_at is null;

  -- Repeatedly crashed claims stop eventually (old workers that never settle included).
  update public.push_jobs j set cancelled_at = now(), dispatch_state = 'discarded', outcome = 'too_many_attempts', lease_until = null, claim_token = null
   where j.sent_at is null and j.cancelled_at is null and j.attempts >= 6 and j.fire_at <= now()
     and (j.lease_until is null or j.lease_until < now()) and j.dispatch_state in ('pending', 'claimed');

  with picked as (
    select j.id from public.push_jobs j
     where j.fire_at <= now() and j.sent_at is null and j.cancelled_at is null
       and j.dispatch_state in ('pending', 'claimed')
       and (case when j.lease_until is null then j.claimed_at is null or j.claimed_at < now() - interval '2 minutes'
                 else j.lease_until < now() end)
     order by private.push_proactive(j.kind), j.fire_at
     limit least(greatest(coalesce(p_limit, 50), 1), 200)
     for update skip locked
  ), claimed as (
    update public.push_jobs j
       set claimed_at = now(), lease_until = now() + interval '2 minutes', claim_token = gen_random_uuid(),
           dispatch_state = 'claimed', attempts = j.attempts + 1
      from picked where j.id = picked.id
    returning j.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'userId', c.user_id, 'kind', c.kind, 'fireAt', c.fire_at, 'payload', c.payload, 'attempts', c.attempts,
           'token', c.claim_token, 'eventDate', c.event_date, 'expiresAt', c.expires_at, 'sourceType', c.source_type,
           'copy', case when c.copy_source is null then null
                        else jsonb_build_object('body', c.payload ->> 'body', 'language', c.copy_language, 'source', c.copy_source) end,
           'prefs', (select private.push_prefs_json(p) from public.push_prefs p where p.user_id = c.user_id),
           'subscriptions', coalesce((select jsonb_agg(jsonb_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth))
                                        from public.push_subscriptions s where s.user_id = c.user_id), '[]'::jsonb))
         order by private.push_proactive(c.kind), c.fire_at), '[]'::jsonb)
    into v from claimed c;
  return v;
end $$;

-- Releases a job's quota reservation (deferred) — consumed reservations stay.
create or replace function private.push_release(p_job uuid) returns void
language sql security definer set search_path = '' as $$
  delete from private.push_quota where job_id = p_job and state = 'reserved';
$$;

-- Eligibility of a claimed proactive reminder, checked by the token holder:
--   p_stage 'prepare'  — before the copy is generated; reserves the daily quota atomically (one 'training' event and
--                        one 'food' event per local day, at most daily_cap events per day, across all devices).
--   p_stage 'dispatch' — immediately before sending; re-checks everything with the CURRENT settings (quiet hours and
--                        time zone included), re-evaluates the cap against the current daily_cap, and marks the job
--                        'dispatching'.
-- p_copy ({ body, language, source }) is stored on the job first, under the claim, so a retry reuses it (one
-- generation attempt per event) whatever this check decides.
-- Returns { status: 'ok', language, revision, ai } | { status: 'deferred', fireAt } (quiet hours; the job is
-- rescheduled within its local day and its reservation released) | { status: 'discard', reason } (the job is
-- discarded and its reservation released) | { status: 'lost' } (the caller no longer holds the claim).
create or replace function public.push_check(p_id uuid, p_token uuid, p_stage text, p_copy jsonb default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  j public.push_jobs;
  p public.push_prefs;
  v_settings jsonb;
  v_ai public.ai_settings;
  v_tz text;
  v_event date;
  v_source date;
  v_expires timestamptz;
  v_quiet timestamptz;
  v_reason text;
  v_key text;
  v_q private.push_quota;
  v_count integer;
  v_receipt timestamptz;
begin
  if p_stage not in ('prepare', 'dispatch') then raise exception 'Unknown stage.' using errcode = '22023'; end if;
  select * into j from public.push_jobs where id = p_id for update;
  if not found or p_token is null or j.claim_token is distinct from p_token or j.dispatch_state <> 'claimed' or j.sent_at is not null
     or j.lease_until is null or j.lease_until < now() then
    return jsonb_build_object('status', 'lost');
  end if;
  if not private.push_proactive(j.kind) then raise exception 'Only coach reminders are checked.' using errcode = '22023'; end if;

  -- Persist the attempt's copy before anything else can end this attempt.
  if jsonb_typeof(p_copy) = 'object' and jsonb_typeof(p_copy -> 'body') = 'string' and char_length(p_copy ->> 'body') between 1 and 200
     and p_copy ->> 'language' in ('en', 'is') and p_copy ->> 'source' in ('ai', 'fallback') then
    update public.push_jobs
       set payload = payload || jsonb_build_object('body', p_copy ->> 'body'), copy_language = p_copy ->> 'language', copy_source = p_copy ->> 'source'
     where id = j.id
    returning * into j;
  end if;

  select * into p from public.push_prefs where user_id = j.user_id;
  v_tz := coalesce(p.time_zone, 'UTC');
  v_event := coalesce(j.event_date, (j.fire_at at time zone v_tz)::date);
  v_source := coalesce(private.try_date(j.source_ref), case when j.kind = 'missed_nudge' then v_event - 1 else v_event end);
  v_expires := coalesce(j.expires_at, (v_event + 1)::timestamp at time zone v_tz);
  select a.payload -> 'settings' into v_settings from public.account_state a where a.owner_id = j.user_id and a.deleted_at is null;
  select * into v_ai from public.ai_settings where user_id = j.user_id;

  if j.cancelled_at is not null then v_reason := 'cancelled';
  elsif p.user_id is null or not (j.kind = any (p.kinds)) then v_reason := 'kind_off';
  elsif p.snooze_until is not null and p.snooze_until > now() then v_reason := 'snoozed';
  elsif now() >= v_expires then v_reason := 'expired';
  elsif not exists (select 1 from public.push_subscriptions s where s.user_id = j.user_id) then v_reason := 'no_device';
  elsif coalesce(v_settings ->> 'demoData', 'false') = 'true' then v_reason := 'demo';
  elsif j.kind in ('workout_reminder', 'missed_nudge') and not exists (select 1 from private.push_planned_on(j.user_id, v_source)) then
    v_reason := 'not_planned'; -- the day was removed, skipped or moved, or the program was deactivated (any device)
  elsif j.kind in ('workout_reminder', 'missed_nudge') and (
          -- started, completed or logged on the planned day (or, for a nudge, already trained today)
          exists (select 1 from public.workout_sessions s
                   where s.owner_id = j.user_id and s.deleted_at is null and s.status in ('active', 'completed')
                     and (s.session_date = v_source or s.payload ->> 'plannedDate' = v_source::text
                          or (j.kind = 'missed_nudge' and (s.session_date = v_event or s.payload ->> 'plannedDate' = v_event::text))))
          -- a cardio-only day is done by any logged activity that day
          or (not exists (select 1 from private.push_planned_on(j.user_id, v_source) x where not x.cardio_only)
              and exists (select 1 from public.activities a where a.owner_id = j.user_id and a.deleted_at is null and a.activity_date = v_source))
          or (j.kind = 'missed_nudge' and exists (select 1 from public.activities a
                   where a.owner_id = j.user_id and a.deleted_at is null and a.activity_date in (v_source, v_event)))) then
    v_reason := 'source_done';
  elsif j.kind = 'missed_nudge' and exists (
          -- discomfort flagged in the latest completed workout: no nudges
          select 1 from (select s.payload from public.workout_sessions s
                          where s.owner_id = j.user_id and s.deleted_at is null and s.status = 'completed'
                          order by s.started_at desc nulls last limit 1) l
           cross join lateral jsonb_array_elements(case when jsonb_typeof(l.payload -> 'exercises') = 'array' then l.payload -> 'exercises' else '[]'::jsonb end) e
           where e ->> 'discomfort' = 'true') then
    v_reason := 'discomfort';
  elsif j.kind = 'missed_nudge' and exists (
          select 1 from public.push_jobs w
           where w.user_id = j.user_id and w.kind = 'workout_reminder' and w.event_date = v_event and w.id <> j.id
             and w.cancelled_at is null and w.dispatch_state in ('pending', 'claimed', 'dispatching')) then
    v_reason := 'workout_preferred';
  elsif j.kind = 'food_unlogged' and coalesce(v_settings ->> 'nutritionEnabled', 'false') <> 'true' then v_reason := 'nutrition_off';
  elsif j.kind = 'food_unlogged' and exists (select 1 from public.food_logs f where f.owner_id = j.user_id and f.deleted_at is null and f.log_date = v_event) then
    v_reason := 'source_done';
  elsif j.kind = 'food_unlogged' then
    select r.completed_at into v_receipt from private.sync_receipts r where r.user_id = j.user_id;
    if v_receipt is null or v_receipt < now() - interval '24 hours' or (v_receipt at time zone v_tz)::date <> v_event then
      v_reason := 'sync_stale'; -- unknown or stale sync state: missing logs prove nothing
    end if;
  end if;

  -- Quiet hours with the CURRENT settings: defer within the event's local day, otherwise discard (no catch-up).
  if v_reason is null then
    v_quiet := private.push_quiet_until(v_tz, p.quiet_start, p.quiet_end, now());
    if v_quiet is not null then
      if v_quiet >= v_expires then
        v_reason := 'quiet_hours';
      else
        update public.push_jobs
           set fire_at = v_quiet, dispatch_state = 'pending', claim_token = null, lease_until = null, claimed_at = null,
               attempts = greatest(attempts - 1, 0)
         where id = j.id;
        perform private.push_release(j.id);
        return jsonb_build_object('status', 'deferred', 'fireAt', v_quiet);
      end if;
    end if;
  end if;

  if v_reason is null then
    v_key := case when j.kind = 'food_unlogged' then 'food' else 'training' end;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('push-quota:' || j.user_id::text || ':' || v_event::text, 0));
    select * into v_q from private.push_quota where user_id = j.user_id and local_date = v_event and event_key = v_key;
    if found then
      if v_q.job_id is distinct from j.id then
        v_reason := case when v_key = 'training' then 'training_done_today' else 'duplicate_event' end;
      else
        -- The current cap decides: reservations made earlier (and every consumed one) come first.
        select count(*) into v_count from private.push_quota q
         where q.user_id = j.user_id and q.local_date = v_event and q.job_id is distinct from j.id
           and (q.state = 'consumed' or (q.created_at, q.event_key) < (v_q.created_at, v_q.event_key));
        if v_count >= coalesce(p.daily_cap, 2) then v_reason := 'daily_cap'; end if;
      end if;
    elsif p_stage = 'dispatch' then
      v_reason := 'not_reserved';
    else
      select count(*) into v_count from private.push_quota where user_id = j.user_id and local_date = v_event;
      if v_count >= coalesce(p.daily_cap, 2) then v_reason := 'daily_cap';
      else insert into private.push_quota (user_id, local_date, event_key, job_id) values (j.user_id, v_event, v_key, j.id);
      end if;
    end if;
  end if;

  if v_reason is not null then
    -- The quota trigger releases the reservation in this same statement.
    update public.push_jobs set cancelled_at = coalesce(cancelled_at, now()), dispatch_state = 'discarded', outcome = v_reason,
                                lease_until = null, claim_token = null
     where id = j.id;
    return jsonb_build_object('status', 'discard', 'reason', v_reason);
  end if;

  if p_stage = 'dispatch' then
    update public.push_jobs set dispatch_state = 'dispatching', lease_until = now() + interval '2 minutes', prefs_revision = p.revision
     where id = j.id;
  end if;
  return jsonb_build_object(
    'status', 'ok',
    'language', case when v_settings ->> 'language' = 'is' then 'is' else 'en' end,
    'revision', p.revision,
    'ai', case when v_ai.user_id is null then null else jsonb_build_object(
      'enabled', v_ai.enabled, 'paused', v_ai.paused, 'consentAt', v_ai.consent_at, 'consentVersion', v_ai.consent_version,
      'training', coalesce((v_ai.scopes ->> 'training')::boolean, false), 'nutrition', coalesce((v_ai.scopes ->> 'nutrition')::boolean, false)) end);
end $$;

-- p_results: [{ id, token?, status, fireAt?, reason?, copy?: { body, language, source } }]
--   sent | ambiguous (outcome unknown: counted as sent, never re-sent) | deferred (quiet hours; a coach reminder past
--   its local day is discarded instead) | retry (cancelled after 5 attempts) | release (not processed this run) |
--   discarded | dropped. With a token, a result settles the job only for the current claim. Without a token
--   (the pre-phase-1 worker), only a tokenless claim is settled: the legacy push_claim_due's claims and claims made
--   before this migration. Reservations are consumed/released by the quota trigger.
create or replace function public.push_finish(p_results jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  r jsonb; n integer := 0; v_id uuid; v_token uuid; j public.push_jobs; v_fire timestamptz; v_copy jsonb; v_body text;
begin
  for r in select * from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) loop
    v_id := private.try_uuid(r ->> 'id');
    v_token := private.try_uuid(r ->> 'token');
    if v_id is null then continue; end if;
    select * into j from public.push_jobs where id = v_id for update;
    if not found or j.sent_at is not null then continue; end if;
    if v_token is not null then
      if j.claim_token is distinct from v_token then continue; end if;
    elsif j.claim_token is not null or j.dispatch_state not in ('pending', 'claimed') or j.claimed_at is null then
      continue;
    end if;
    v_copy := case when jsonb_typeof(r -> 'copy') = 'object' then r -> 'copy' end;
    v_body := v_copy ->> 'body';
    if v_body is not null and (char_length(v_body) > 200 or coalesce(v_copy ->> 'language', '') not in ('en', 'is')
                               or coalesce(v_copy ->> 'source', '') not in ('ai', 'fallback')) then
      v_copy := null; v_body := null;
    end if;
    case r ->> 'status'
      when 'sent', 'ambiguous' then
        update public.push_jobs
           set sent_at = now(), claimed_at = null, lease_until = null, claim_token = null,
               dispatch_state = case when r ->> 'status' = 'sent' then 'sent' else 'ambiguous' end,
               outcome = case when r ->> 'status' = 'ambiguous' then 'ambiguous' end,
               payload = case when v_body is null then payload else payload || jsonb_build_object('body', v_body) end,
               copy_language = coalesce(v_copy ->> 'language', copy_language), copy_source = coalesce(v_copy ->> 'source', copy_source)
         where id = v_id;
      when 'deferred' then
        begin
          v_fire := (r ->> 'fireAt')::timestamptz;
        exception when others then
          v_fire := null;
        end;
        if v_fire is null or (private.push_proactive(j.kind) and v_fire >= coalesce(j.expires_at, 'infinity'::timestamptz)) then
          update public.push_jobs set cancelled_at = now(), dispatch_state = 'discarded', outcome = 'quiet_hours', claimed_at = null, lease_until = null, claim_token = null where id = v_id;
        else
          update public.push_jobs set fire_at = v_fire, claimed_at = null, lease_until = null, claim_token = null, dispatch_state = 'pending',
                                      attempts = greatest(attempts - 1, 0)
           where id = v_id;
          perform private.push_release(v_id);
        end if;
      when 'retry' then
        update public.push_jobs
           set claimed_at = null, lease_until = null, claim_token = null,
               dispatch_state = case when attempts >= 5 then 'discarded' else 'pending' end,
               outcome = case when attempts >= 5 then 'too_many_attempts' end,
               cancelled_at = case when attempts >= 5 then now() end,
               payload = case when v_body is null then payload else payload || jsonb_build_object('body', v_body) end,
               copy_language = coalesce(v_copy ->> 'language', copy_language), copy_source = coalesce(v_copy ->> 'source', copy_source)
         where id = v_id;
      when 'release' then
        update public.push_jobs set claimed_at = null, lease_until = null, claim_token = null, dispatch_state = 'pending',
                                    attempts = greatest(attempts - 1, 0)
         where id = v_id and dispatch_state = 'claimed';
      else -- discarded / dropped
        update public.push_jobs set cancelled_at = now(), claimed_at = null, lease_until = null, claim_token = null,
                                    dispatch_state = 'discarded', outcome = left(coalesce(r ->> 'reason', r ->> 'status', 'dropped'), 40)
         where id = v_id;
    end case;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.push_cleanup() returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  delete from public.push_jobs
   where (sent_at is not null and sent_at < now() - interval '7 days')
      or (cancelled_at is not null and cancelled_at < now() - interval '7 days');
  get diagnostics n = row_count;
  delete from private.push_quota where local_date < (now() at time zone 'UTC')::date - 3;
  return n;
end $$;

/* ============================================================ privileges */

revoke all on function private.push_proactive(text), private.push_prefs_json(public.push_prefs),
  private.push_apply_prefs(uuid, jsonb, boolean), private.push_release(uuid), private.trg_push_job_quota(),
  private.push_quiet_until(text, time, time, timestamptz), private.push_planned_on(uuid, date), private.push_assert_account(text)
  from public, anon, authenticated;

revoke all on function public.get_push_prefs(), public.set_push_prefs(jsonb), public.update_push_prefs(jsonb, bigint),
  public.record_sync_complete(), public.replace_scheduled_jobs(text, jsonb), public.cancel_push_job(text),
  public.save_push_subscription(jsonb), public.delete_push_subscription(text, uuid), public.push_device_owner(text)
  from public, anon;
grant execute on function public.get_push_prefs(), public.set_push_prefs(jsonb), public.update_push_prefs(jsonb, bigint),
  public.record_sync_complete(), public.replace_scheduled_jobs(text, jsonb), public.cancel_push_job(text),
  public.save_push_subscription(jsonb), public.delete_push_subscription(text, uuid), public.push_device_owner(text)
  to authenticated;

revoke all on function public.push_generate_food(), public.push_claim_due(integer), public.push_claim_due_v2(integer),
  public.push_check(uuid, uuid, text, jsonb), public.push_finish(jsonb), public.push_cleanup() from public, anon, authenticated;
grant execute on function public.push_generate_food(), public.push_claim_due(integer), public.push_claim_due_v2(integer),
  public.push_check(uuid, uuid, text, jsonb), public.push_finish(jsonb), public.push_cleanup() to service_role;
