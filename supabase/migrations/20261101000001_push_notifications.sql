-- Web Push notifications (2026-11-01, v0.5.0). Additive only.
--
--   * push_subscriptions — one row per device (browser PushSubscription). Owner-only read; written through RPCs.
--   * push_prefs         — per-user push settings: enabled kinds, optional fixed reminder time, time zone, quiet hours.
--   * push_jobs          — scheduled pushes. Clients upload their own workout reminders / missed-session nudges /
--                          rest-over alerts (replace_scheduled_jobs); coaching and social pushes are enqueued by a
--                          trigger on public.notifications. Idempotent per (user_id, dedupe_key).
--   * The push-send Edge Function (service role, PUSH_CRON_SECRET) claims due jobs with FOR UPDATE SKIP LOCKED,
--     sends them with VAPID, and reports back (push_finish / push_subscription_result / push_cleanup).
--   * pg_cron + pg_net run push-send every 15 seconds (pg_cron ≥ 1.5) or every minute. The URL and secret come from
--     Vault ('push_send_url', 'push_cron_secret'). private.push_schedule_cron() is a no-op with a NOTICE until the
--     extensions and Vault secrets exist, so this migration never fails; re-run it after adding them:
--       select private.push_schedule_cron();
-- Notification text never contains message or comment content, body weight or food.

/* ============================================================ tables */

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  endpoint text not null unique check (char_length(endpoint) between 12 and 1000 and endpoint like 'https://%'),
  p256dh text not null check (char_length(p256dh) between 20 and 200),
  auth text not null check (char_length(auth) between 8 and 100),
  user_agent text check (user_agent is null or char_length(user_agent) <= 300),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  failed_count integer not null default 0
);
create index if not exists push_subscriptions_user on public.push_subscriptions (user_id);

create table if not exists public.push_prefs (
  user_id uuid primary key references auth.users (id) on delete cascade,
  kinds text[] not null default array['workout_reminder', 'rest_over', 'coaching', 'missed_nudge']
    check (kinds <@ array['workout_reminder', 'rest_over', 'coaching', 'social', 'missed_nudge']),
  fixed_reminder_time time,
  time_zone text not null default 'UTC' check (char_length(time_zone) between 1 and 64),
  quiet_start time not null default '22:00',
  quiet_end time not null default '07:00',
  updated_at timestamptz not null default now()
);

create table if not exists public.push_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('workout_reminder', 'rest_over', 'coaching', 'social', 'missed_nudge', 'test')),
  fire_at timestamptz not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 2048),
  dedupe_key text not null check (char_length(dedupe_key) between 1 and 200),
  sent_at timestamptz,
  cancelled_at timestamptz,
  attempts integer not null default 0,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint push_jobs_dedupe unique (user_id, dedupe_key)
);
create index if not exists push_jobs_due on public.push_jobs (fire_at) where sent_at is null and cancelled_at is null;
create index if not exists push_jobs_user_kind on public.push_jobs (user_id, kind) where sent_at is null and cancelled_at is null;

do $$
declare t text;
begin
  foreach t in array array['push_subscriptions', 'push_prefs', 'push_jobs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_owner_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (user_id = (select auth.uid()))', t || '_owner_read', t);
  end loop;
end $$;

comment on table public.push_subscriptions is 'Web Push subscriptions, one per device. Owner-only read; written via save/delete_push_subscription.';
comment on table public.push_prefs is 'Per-user push notification settings (kinds, fixed reminder time, time zone, quiet hours).';
comment on table public.push_jobs is 'Scheduled push notifications. Sent by the push-send Edge Function; never contains message content.';

/* ============================================================ helpers */

create or replace function private.push_prefs_json(p public.push_prefs) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'kinds', to_jsonb(coalesce(p.kinds, array['workout_reminder', 'rest_over', 'coaching', 'missed_nudge'])),
    'fixedReminderTime', case when p.fixed_reminder_time is null then null else to_char(p.fixed_reminder_time, 'HH24:MI') end,
    'timeZone', coalesce(p.time_zone, 'UTC'),
    'quietStart', to_char(coalesce(p.quiet_start, '22:00'::time), 'HH24:MI'),
    'quietEnd', to_char(coalesce(p.quiet_end, '07:00'::time), 'HH24:MI'))
$$;

create or replace function private.push_valid_payload(p jsonb) returns jsonb
language plpgsql immutable security definer set search_path = '' as $$
begin
  if p is null or jsonb_typeof(p) <> 'object'
     or coalesce(btrim(p ->> 'title'), '') = '' or char_length(p ->> 'title') > 80
     or char_length(coalesce(p ->> 'body', '')) > 200
     or coalesce(p ->> 'url', '') !~ '^/[^/\\]' and coalesce(p ->> 'url', '') <> '/'
     or char_length(coalesce(p ->> 'url', '')) > 300
     or char_length(coalesce(p ->> 'tag', '')) > 40 then
    raise exception 'Push payload needs a title (≤ 80), body (≤ 200), an in-app url starting with / and a short tag.' using errcode = '22023';
  end if;
  return jsonb_build_object('title', p ->> 'title', 'body', coalesce(p ->> 'body', ''), 'url', p ->> 'url', 'tag', coalesce(nullif(p ->> 'tag', ''), 'liftcircle'));
end $$;

/* ============================================================ client RPCs (caller = auth.uid()) */

-- p: { endpoint, p256dh, auth, userAgent? }. A device that was used by another account moves to the caller.
create or replace function public.save_push_subscription(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v public.push_subscriptions;
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'Subscription must be a JSON object.' using errcode = '22023'; end if;
  perform private.enforce_rate_limit(v_uid, 'push_subscribe', 60, interval '1 hour', 'Too many notification changes. Please wait a little.');
  insert into public.push_subscriptions as s (user_id, endpoint, p256dh, auth, user_agent)
  values (v_uid, p ->> 'endpoint', p ->> 'p256dh', p ->> 'auth', left(p ->> 'userAgent', 300))
  on conflict (endpoint) do update
     set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent, failed_count = 0
  returning * into v;
  insert into public.push_prefs (user_id) values (v_uid) on conflict (user_id) do nothing;
  return jsonb_build_object('id', v.id, 'endpoint', v.endpoint, 'createdAt', v.created_at);
end $$;

create or replace function public.delete_push_subscription(p_endpoint text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid(); v_deleted boolean;
begin
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = v_uid;
  v_deleted := found;
  if not exists (select 1 from public.push_subscriptions where user_id = v_uid) then
    -- No device left: drop pending pushes (they could never be delivered).
    update public.push_jobs set cancelled_at = now() where user_id = v_uid and sent_at is null and cancelled_at is null;
  end if;
  return v_deleted;
end $$;

create or replace function public.get_push_prefs() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid(); p public.push_prefs;
begin
  select * into p from public.push_prefs where user_id = v_uid;
  return private.push_prefs_json(p) || jsonb_build_object(
    'devices', (select count(*) from public.push_subscriptions where user_id = v_uid));
end $$;

-- p keys (all optional): kinds text[], fixedReminderTime 'HH:MM' | null, timeZone, quietStart 'HH:MM', quietEnd 'HH:MM'.
create or replace function public.set_push_prefs(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  s public.push_prefs;
  v_kinds text[];
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'Settings must be a JSON object.' using errcode = '22023'; end if;
  perform private.enforce_rate_limit(v_uid, 'push_prefs', 240, interval '1 hour', 'Too many notification changes. Please wait a little.');
  insert into public.push_prefs (user_id) values (v_uid) on conflict (user_id) do nothing;
  select * into s from public.push_prefs where user_id = v_uid for update;
  if p ? 'kinds' then
    if jsonb_typeof(p -> 'kinds') <> 'array' then raise exception 'kinds must be a list.' using errcode = '22023'; end if;
    select coalesce(array_agg(distinct k), '{}') into v_kinds from jsonb_array_elements_text(p -> 'kinds') k;
    if not v_kinds <@ array['workout_reminder', 'rest_over', 'coaching', 'social', 'missed_nudge'] then
      raise exception 'Unknown notification kind.' using errcode = '22023';
    end if;
    s.kinds := v_kinds;
    -- Pending pushes of kinds that were just switched off never go out.
    update public.push_jobs set cancelled_at = now()
     where user_id = v_uid and sent_at is null and cancelled_at is null and kind <> 'test' and not (kind = any (v_kinds));
  end if;
  if p ? 'fixedReminderTime' then
    if jsonb_typeof(p -> 'fixedReminderTime') = 'null' then s.fixed_reminder_time := null;
    elsif coalesce(p ->> 'fixedReminderTime', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then s.fixed_reminder_time := (p ->> 'fixedReminderTime')::time;
    else raise exception 'fixedReminderTime must be HH:MM or null.' using errcode = '22023'; end if;
  end if;
  if p ? 'timeZone' then
    if not exists (select 1 from pg_catalog.pg_timezone_names where name = p ->> 'timeZone') then
      raise exception 'Unknown time zone.' using errcode = '22023';
    end if;
    s.time_zone := p ->> 'timeZone';
  end if;
  if p ? 'quietStart' then
    if coalesce(p ->> 'quietStart', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'quietStart must be HH:MM.' using errcode = '22023'; end if;
    s.quiet_start := (p ->> 'quietStart')::time;
  end if;
  if p ? 'quietEnd' then
    if coalesce(p ->> 'quietEnd', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'quietEnd must be HH:MM.' using errcode = '22023'; end if;
    s.quiet_end := (p ->> 'quietEnd')::time;
  end if;
  update public.push_prefs
     set kinds = s.kinds, fixed_reminder_time = s.fixed_reminder_time, time_zone = s.time_zone,
         quiet_start = s.quiet_start, quiet_end = s.quiet_end, updated_at = now()
   where user_id = v_uid
  returning * into s;
  return private.push_prefs_json(s);
end $$;

-- Replaces the caller's future, unsent jobs of one client-scheduled kind with p_jobs
-- ([{ dedupeKey, fireAt (ISO), payload: { title, body, url, tag } }], ≤ 60). Idempotent by dedupe key: an unchanged
-- upload changes nothing; jobs not in the list are cancelled; already-sent jobs are never touched or re-sent.
create or replace function public.replace_scheduled_jobs(p_kind text, p_jobs jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_keys text[] := '{}';
  j jsonb;
  v_fire timestamptz;
  v_key text;
  n integer := 0;
begin
  if p_kind not in ('workout_reminder', 'missed_nudge', 'rest_over') then
    raise exception 'Only reminders, nudges and rest alerts can be scheduled by the app.' using errcode = '22023';
  end if;
  if p_jobs is null or jsonb_typeof(p_jobs) <> 'array' or jsonb_array_length(p_jobs) > 60 then
    raise exception 'jobs must be a list of at most 60.' using errcode = '22023';
  end if;
  perform private.enforce_rate_limit(v_uid, 'push_schedule', 900, interval '1 hour', 'Too many reminder updates. Please wait a little.');

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
    v_keys := v_keys || v_key;
    insert into public.push_jobs as pj (user_id, kind, fire_at, payload, dedupe_key)
    values (v_uid, p_kind, v_fire, private.push_valid_payload(j -> 'payload'), v_key)
    on conflict (user_id, dedupe_key) do update
       set kind = excluded.kind, fire_at = excluded.fire_at, payload = excluded.payload, cancelled_at = null, claimed_at = null
     where pj.sent_at is null
       and (pj.fire_at, pj.payload, pj.kind, pj.cancelled_at) is distinct from (excluded.fire_at, excluded.payload, excluded.kind, null::timestamptz);
    n := n + 1;
  end loop;

  update public.push_jobs set cancelled_at = now()
   where user_id = v_uid and kind = p_kind and sent_at is null and cancelled_at is null and fire_at > now() - interval '1 minute'
     and not (dedupe_key = any (v_keys));
  return n;
end $$;

create or replace function public.cancel_push_job(p_dedupe_key text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid();
begin
  update public.push_jobs set cancelled_at = now()
   where user_id = v_uid and dedupe_key = p_dedupe_key and sent_at is null and cancelled_at is null;
  return found;
end $$;

-- "Send a test notification": queued for push-send (arrives within the cron interval).
create or replace function public.send_test_push() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid(); v_key text;
begin
  perform private.enforce_rate_limit(v_uid, 'push_test', 10, interval '1 hour', 'You can send up to 10 test notifications an hour.');
  if not exists (select 1 from public.push_subscriptions where user_id = v_uid) then
    raise exception 'Turn on notifications on this device first.' using errcode = 'P0001', hint = 'no_subscription';
  end if;
  v_key := 'test:' || gen_random_uuid()::text;
  insert into public.push_jobs (user_id, kind, fire_at, payload, dedupe_key)
  values (v_uid, 'test', now(), jsonb_build_object('title', 'LiftCircle', 'body', 'Notifications are working. See you at your next session! 💪', 'url', '/settings', 'tag', 'test'), v_key);
  return jsonb_build_object('queued', true, 'dedupeKey', v_key);
end $$;

/* ============================================================ coaching + social pushes (from in-app notifications) */

-- Called for every in-app notification that is created (or bumped, for coach messages). The in-app preferences were
-- already applied by private.notify / private.coach_notify. Pushes only when the user enabled that kind and has a
-- device. Bursts are coalesced: at most one push per kind per 2 minutes, and an unsent one is replaced by the newer
-- text (same tag on the device).
create or replace function private.push_enqueue_notification(n public.notifications) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_kind text;
  v_name text;
  v_title text;
  v_body text;
  v_url text;
  v_payload jsonb;
  v_last timestamptz;
  v_fire timestamptz;
begin
  v_kind := case when n.type in ('friend_request', 'friend_accept', 'like', 'comment') then 'social'
                 when n.type like 'coach\_%' then 'coaching' end;
  if v_kind is null then return; end if;
  if not exists (select 1 from public.push_prefs p where p.user_id = n.recipient_id and v_kind = any (p.kinds)) then return; end if;
  if not exists (select 1 from public.push_subscriptions s where s.user_id = n.recipient_id) then return; end if;

  select left(pr.display_name, 30) into v_name from public.profiles pr where pr.id = n.actor_id;
  v_name := coalesce(v_name, 'Someone');
  v_title := 'LiftCircle';
  case n.type
    when 'like' then v_body := v_name || ' liked your post'; v_url := '/feed/post/' || n.post_id;
    when 'comment' then v_body := v_name || ' commented on your post'; v_url := '/feed/post/' || n.post_id;
    when 'friend_request' then v_body := v_name || ' sent you a friend request'; v_url := '/friends';
    when 'friend_accept' then v_body := v_name || ' accepted your friend request'; v_url := '/friends';
    when 'coach_message' then
      v_body := case when n.coach_id = n.recipient_id then v_name || ' sent you a message' else 'Your coach sent you a message' end;
      v_url := case when n.relationship_id is null then '/coaching' else '/coaching/messages/' || n.relationship_id end;
    when 'coach_proposal' then v_body := 'Your coach sent you a plan update to review'; v_url := case when n.proposal_id is null then '/coaching/my' else '/coaching/proposal/' || n.proposal_id end;
    when 'coach_proposal_response' then v_body := v_name || ' responded to your plan update'; v_url := '/coaching/dashboard';
    when 'coach_request' then v_body := 'You have a new coaching request'; v_url := '/coaching/dashboard';
    when 'coach_request_accepted' then v_body := 'Your coaching request was accepted'; v_url := '/coaching/my';
    when 'coach_checkin' then v_body := v_name || ' sent a check-in'; v_url := '/coaching/dashboard';
    when 'coach_feedback' then v_body := 'Your coach left feedback on your training'; v_url := '/coaching/my';
    else v_body := 'You have a new coaching update'; v_url := '/notifications';
  end case;
  if v_url is null or v_url like '%/' then v_url := '/notifications'; end if;
  v_payload := jsonb_build_object('title', v_title, 'body', v_body, 'url', v_url, 'tag', v_kind);

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('push:' || n.recipient_id::text || ':' || v_kind, 0));
  update public.push_jobs set payload = v_payload
   where user_id = n.recipient_id and kind = v_kind and sent_at is null and cancelled_at is null;
  if found then return; end if;
  select max(sent_at) into v_last from public.push_jobs
   where user_id = n.recipient_id and kind = v_kind and sent_at > now() - interval '2 minutes';
  v_fire := case when v_last is null then now() else v_last + interval '2 minutes' end;
  insert into public.push_jobs (user_id, kind, fire_at, payload, dedupe_key)
  values (n.recipient_id, v_kind, v_fire, v_payload, v_kind || ':' || gen_random_uuid()::text);
end $$;

create or replace function private.trg_notification_push() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (new.read_at is not null or new.created_at is not distinct from old.created_at) then return null; end if;
  perform private.push_enqueue_notification(new);
  return null;
end $$;

drop trigger if exists notification_push on public.notifications;
create trigger notification_push after insert or update of created_at on public.notifications
  for each row execute function private.trg_notification_push();

/* ============================================================ push-send (service role only) */

-- Claims up to p_limit due jobs. FOR UPDATE SKIP LOCKED + claimed_at mean overlapping runs never pick the same job;
-- a claim older than 2 minutes (a crashed run) becomes claimable again.
create or replace function public.push_claim_due(p_limit integer default 50) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  with picked as (
    select j.id from public.push_jobs j
     where j.fire_at <= now() and j.sent_at is null and j.cancelled_at is null
       and (j.claimed_at is null or j.claimed_at < now() - interval '2 minutes')
     order by j.fire_at
     limit least(greatest(coalesce(p_limit, 50), 1), 200)
     for update skip locked
  ), claimed as (
    update public.push_jobs j set claimed_at = now(), attempts = j.attempts + 1
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

-- p_results: [{ id, status: 'sent' | 'deferred' | 'retry' | 'dropped', fireAt? }]
create or replace function public.push_finish(p_results jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare r jsonb; n integer := 0; v_id uuid;
begin
  for r in select * from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) loop
    v_id := private.try_uuid(r ->> 'id');
    if v_id is null then continue; end if;
    case r ->> 'status'
      when 'sent' then update public.push_jobs set sent_at = now(), claimed_at = null where id = v_id and sent_at is null;
      when 'deferred' then update public.push_jobs set fire_at = (r ->> 'fireAt')::timestamptz, claimed_at = null, attempts = greatest(attempts - 1, 0) where id = v_id and sent_at is null;
      when 'retry' then update public.push_jobs set claimed_at = null, cancelled_at = case when attempts >= 5 then now() end where id = v_id and sent_at is null;
      else update public.push_jobs set cancelled_at = now(), claimed_at = null where id = v_id and sent_at is null;
    end case;
    n := n + 1;
  end loop;
  return n;
end $$;

-- 404/410 → the subscription is gone: delete it. 2xx → healthy. Anything else → failed_count + 1.
create or replace function public.push_subscription_result(p_endpoint text, p_status integer) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_status in (404, 410) then
    delete from public.push_subscriptions where endpoint = p_endpoint;
  elsif p_status between 200 and 299 then
    update public.push_subscriptions set last_used_at = now(), failed_count = 0 where endpoint = p_endpoint;
  else
    update public.push_subscriptions set failed_count = failed_count + 1 where endpoint = p_endpoint;
  end if;
end $$;

create or replace function public.push_cleanup() returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  delete from public.push_jobs
   where (sent_at is not null and sent_at < now() - interval '7 days')
      or (cancelled_at is not null and cancelled_at < now() - interval '7 days');
  get diagnostics n = row_count;
  return n;
end $$;

/* ============================================================ cron (pg_cron + pg_net + Vault) */

create or replace function private.push_schedule_cron() returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_ver text;
  v_schedule text;
  v_cmd text;
begin
  select extversion into v_ver from pg_catalog.pg_extension where extname = 'pg_cron';
  if v_ver is null or not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_net') then
    raise notice 'push: pg_cron and pg_net are not both enabled; push-send is not scheduled yet (see docs/SETUP.md).';
    return 'skipped: extensions';
  end if;
  if not exists (select 1 from pg_catalog.pg_namespace where nspname = 'vault') then
    raise notice 'push: Vault is not available; push-send is not scheduled yet (see docs/SETUP.md).';
    return 'skipped: vault';
  end if;
  execute $q$select count(*) = 2 from vault.decrypted_secrets where name in ('push_send_url', 'push_cron_secret')$q$ into strict v_cmd;
  if v_cmd is distinct from 'true' then
    raise notice 'push: Vault secrets push_send_url / push_cron_secret do not exist yet; push-send is not scheduled (see docs/SETUP.md), then run: select private.push_schedule_cron();';
    return 'skipped: secrets';
  end if;
  -- pg_cron 1.5+ accepts second-level schedules ('15 seconds'); older versions run every minute.
  v_schedule := case when string_to_array(split_part(v_ver, '-', 1), '.')::int[] >= array[1, 5] then '15 seconds' else '* * * * *' end;
  v_cmd := $c$select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'push_send_url'),
      headers := jsonb_build_object('Content-Type', 'application/json',
        'x-push-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'push_cron_secret')),
      body := '{}'::jsonb,
      timeout_milliseconds := 25000)$c$;
  execute $q$select cron.unschedule(jobid) from cron.job where jobname = 'liftcircle-push-send'$q$;
  execute format('select cron.schedule(%L, %L, %L)', 'liftcircle-push-send', v_schedule, v_cmd);
  raise notice 'push: push-send scheduled (%).', v_schedule;
  return 'scheduled: ' || v_schedule;
end $$;

select private.push_schedule_cron();

/* ============================================================ privileges */

revoke all on function private.push_prefs_json(public.push_prefs), private.push_valid_payload(jsonb),
  private.push_enqueue_notification(public.notifications), private.trg_notification_push(), private.push_schedule_cron()
  from public, anon, authenticated;

revoke all on function public.save_push_subscription(jsonb), public.delete_push_subscription(text), public.get_push_prefs(),
  public.set_push_prefs(jsonb), public.replace_scheduled_jobs(text, jsonb), public.cancel_push_job(text), public.send_test_push()
  from public, anon;
grant execute on function public.save_push_subscription(jsonb), public.delete_push_subscription(text), public.get_push_prefs(),
  public.set_push_prefs(jsonb), public.replace_scheduled_jobs(text, jsonb), public.cancel_push_job(text), public.send_test_push()
  to authenticated;

revoke all on function public.push_claim_due(integer), public.push_finish(jsonb), public.push_subscription_result(text, integer),
  public.push_cleanup() from public, anon, authenticated;
grant execute on function public.push_claim_due(integer), public.push_finish(jsonb), public.push_subscription_result(text, integer),
  public.push_cleanup() to service_role;
