-- Privacy-first product analytics (roadmap item 5, 2026-11-27). Additive only; safe to re-run.
--
--   * product_analytics_events: one row per product event. Columns are ONLY: a client event id, the user, an
--     allowlisted event name, allowlisted enum properties, when it happened and when it arrived. No health or training
--     data, no chat content, no names, no email, no free text: there is no column that could hold them, and props is
--     checked key-by-key and value-by-value against the allowlist below (mirrors src/analytics/events.ts).
--   * Clients have no grant on the table (nobody can read it back through the API, not even their own rows) and write
--     only through public.log_product_events(jsonb), which takes the user from the access token, drops anything not
--     on the allowlist, and is idempotent (event id primary key + one row per user for one-time milestones).
--   * The app degrades silently until this is applied: events stay queued on the device and are retried later.
--   * Deleting the account deletes the events (on delete cascade).

create table if not exists public.product_analytics_events (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  event_name text not null check (event_name in (
    'first_set_logged', 'first_workout_completed', 'second_workout_within_7d', 'onboarding_completed',
    'workout_started', 'ai_action_used')),
  props jsonb not null default '{}'::jsonb check (jsonb_typeof(props) = 'object' and octet_length(props::text) <= 256),
  occurred_at timestamptz not null,
  received_at timestamptz not null default now()
);
create unique index if not exists product_analytics_once on public.product_analytics_events (user_id, event_name)
  where event_name in ('first_set_logged', 'first_workout_completed', 'second_workout_within_7d', 'onboarding_completed');
create index if not exists product_analytics_name_time on public.product_analytics_events (event_name, occurred_at);
create index if not exists product_analytics_user_received on public.product_analytics_events (user_id, received_at);
comment on table public.product_analytics_events is
  'Product analytics: allowlisted event names and enum properties only. Never health/training data, chat content or PII. Written via log_product_events.';

alter table public.product_analytics_events enable row level security;
revoke all on table public.product_analytics_events from public, anon, authenticated;
-- Defence in depth: if a grant is ever added by mistake, a user could still only insert rows for themselves and read none.
drop policy if exists product_analytics_insert_own on public.product_analytics_events;
create policy product_analytics_insert_own on public.product_analytics_events
  for insert to authenticated with check (user_id = (select auth.uid()));

/* Allowed property keys and values per event (keys not listed are rejected; `required` keys must be present). */
create or replace function private.analytics_props_ok(p_name text, p_props jsonb) returns boolean
language sql immutable set search_path = '' as $$
  with allowed(event_name, key, vals, required) as (values
    ('onboarding_completed', 'path', array['suggested', 'manual'], false),
    ('workout_started', 'source', array['template', 'repeat', 'empty'], false),
    ('ai_action_used', 'action_type', array['chat_message', 'checkin_review', 'program_proposal', 'week_plan', 'meal_plan'], true),
    ('ai_action_used', 'outcome', array['sent', 'proposed', 'applied', 'dismissed', 'reverted'], true)
  )
  select p_props is not null and jsonb_typeof(p_props) = 'object'
    and not exists (
      select 1 from jsonb_each(p_props) e
      where not exists (
        select 1 from allowed a
        where a.event_name = p_name and a.key = e.key and jsonb_typeof(e.value) = 'string' and (e.value #>> '{}') = any (a.vals)))
    and not exists (select 1 from allowed a where a.event_name = p_name and a.required and not (p_props ? a.key));
$$;

/*
 * Record a batch of the caller's events (at most 50). Invalid items are skipped, not errors, so one bad event never
 * blocks the rest of a device's queue. Returns how many rows were newly stored (duplicates count as 0).
 * At most 500 rows per user per rolling day: calls for the same user are serialized with a transaction-scoped advisory
 * lock, and inserting stops as soon as the remaining allowance is used, so concurrent calls can't exceed it either.
 */
create or replace function public.log_product_events(p_events jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_n integer := 0;
  v_rows integer;
  v_left integer;
  v_at timestamptz;
  e jsonb;
begin
  if v_uid is null then raise exception 'Not signed in' using errcode = '28000'; end if;
  if p_events is null or jsonb_typeof(p_events) <> 'array' then raise exception 'events must be an array' using errcode = '22023'; end if;
  if jsonb_array_length(p_events) > 50 then raise exception 'too many events in one call' using errcode = '22023'; end if;
  -- Abuse guard: a real device sends a handful a day. One caller per user at a time (released at commit), then the
  -- exact allowance left for the rolling day.
  perform pg_advisory_xact_lock(hashtextextended('product_analytics:' || v_uid::text, 0));
  v_left := 500 - (select count(*)::integer from public.product_analytics_events where user_id = v_uid and received_at > now() - interval '1 day');
  if v_left <= 0 then return 0; end if;

  for e in select value from jsonb_array_elements(p_events) loop
    exit when v_n >= v_left;
    continue when jsonb_typeof(e) <> 'object';
    continue when exists (select 1 from jsonb_object_keys(e) k where k not in ('id', 'name', 'props', 'occurred_at'));
    continue when coalesce(e ->> 'id', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
    continue when coalesce(e ->> 'name', '') not in (
      'first_set_logged', 'first_workout_completed', 'second_workout_within_7d', 'onboarding_completed', 'workout_started', 'ai_action_used');
    continue when not private.analytics_props_ok(e ->> 'name', coalesce(e -> 'props', '{}'::jsonb));
    begin
      v_at := (e ->> 'occurred_at')::timestamptz;
    exception when others then
      continue;
    end;
    continue when v_at is null or v_at < now() - interval '90 days' or v_at > now() + interval '1 day';

    insert into public.product_analytics_events (id, user_id, event_name, props, occurred_at)
    values ((e ->> 'id')::uuid, v_uid, e ->> 'name', coalesce(e -> 'props', '{}'::jsonb), v_at)
    on conflict do nothing;
    get diagnostics v_rows = row_count;
    v_n := v_n + v_rows;
  end loop;
  return v_n;
end $$;

revoke all on function private.analytics_props_ok(text, jsonb) from public, anon, authenticated;
revoke all on function public.log_product_events(jsonb) from public, anon;
grant execute on function public.log_product_events(jsonb) to authenticated;
