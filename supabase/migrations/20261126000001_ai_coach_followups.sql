-- Training assistant follow-ups (PR 1b, additive; safe to re-run):
--   * public.ai_inflight — one row per user message being answered (a reservation). A replay of the same message id while
--     the first request is still running gets 'in_progress' instead of a second generation (no double action, no double
--     cost). Rows older than 3 minutes count as abandoned; rows older than a day are cleaned up.
--   * public.ai_begin_request(p_user, p_message_id, p_limit) — atomically: already answered? → 'duplicate'; running? →
--     'in_progress'; otherwise counts the request against the daily limit (PT429 when reached, like
--     ai_check_and_count_usage) and reserves the message id → 'started'.
--   * public.ai_fail_request(p_user, p_message_id, p_usage) — a request that failed gives its daily allowance back (only
--     once, only if it held the reservation) and books tokens from rounds that did complete as FAILED usage, separate
--     from successful usage.
--   * ai_usage.failed_requests / failed_input_tokens / failed_output_tokens / failed_cost_usd.
--   * ai_settings.coach_style defaults to 'supportive' for new rows (owner decision, Nov 2026).
-- Service-role only, like the other ai-coach RPCs. The ai-coach function falls back to ai_check_and_count_usage until
-- this migration is applied.

alter table public.ai_usage
  add column if not exists failed_requests integer not null default 0 check (failed_requests >= 0),
  add column if not exists failed_input_tokens bigint not null default 0,
  add column if not exists failed_output_tokens bigint not null default 0,
  add column if not exists failed_cost_usd numeric(14, 6);

create table if not exists public.ai_inflight (
  message_id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  started_at timestamptz not null default now()
);
comment on table public.ai_inflight is 'Training assistant requests in progress (reservation per user message id). Service role only.';
alter table public.ai_inflight enable row level security;
revoke all on public.ai_inflight from public, anon, authenticated;

alter table public.ai_settings alter column coach_style set default 'supportive';

create or replace function public.ai_begin_request(p_user uuid, p_message_id uuid, p_limit integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_day date := private.ai_utc_day();
  v_owner uuid;
  v_started timestamptz;
  v_n integer;
begin
  if p_user is null or p_message_id is null then
    raise exception 'User and message id are required.' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ai:' || p_user::text, 0));

  select user_id into v_owner from public.ai_messages where id = p_message_id;
  if v_owner is not null then
    if v_owner <> p_user then raise exception 'Message id already used.' using errcode = '23505'; end if;
    if exists (select 1 from public.ai_messages where reply_to = p_message_id) then
      return jsonb_build_object('status', 'duplicate');
    end if;
  end if;

  delete from public.ai_inflight where started_at < now() - interval '1 day';
  select user_id, started_at into v_owner, v_started from public.ai_inflight where message_id = p_message_id;
  if v_owner is not null and v_owner <> p_user then raise exception 'Message id already used.' using errcode = '23505'; end if;
  if v_started is not null and v_started > now() - interval '3 minutes' then
    return jsonb_build_object('status', 'in_progress');
  end if;

  if coalesce(p_limit, 0) < 1 then
    raise exception 'The AI coach daily limit is set to 0.' using errcode = 'PT429', hint = 'rate_limited';
  end if;
  insert into public.ai_usage as u (user_id, day, requests) values (p_user, v_day, 1)
  on conflict (user_id, day) do update set requests = u.requests + 1, updated_at = now()
   where u.requests < p_limit
  returning u.requests into v_n;
  if v_n is null then
    raise exception 'You''ve reached today''s AI coach limit of % messages. It resets at midnight UTC.', p_limit
      using errcode = 'PT429', hint = 'rate_limited';
  end if;

  insert into public.ai_inflight (message_id, user_id, day, started_at) values (p_message_id, p_user, v_day, now())
  on conflict (message_id) do update set day = excluded.day, started_at = excluded.started_at;
  return jsonb_build_object('status', 'started', 'remaining', p_limit - v_n);
end $$;

create or replace function public.ai_fail_request(p_user uuid, p_message_id uuid, p_usage jsonb default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_day date;
  v_in bigint := coalesce(private.try_int(p_usage ->> 'inputTokens'), 0);
  v_out bigint := coalesce(private.try_int(p_usage ->> 'outputTokens'), 0);
  v_cost numeric := private.try_num(p_usage ->> 'costUsd');
begin
  if p_user is null or p_message_id is null then
    raise exception 'User and message id are required.' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ai:' || p_user::text, 0));
  -- Only the call that still holds the reservation gives the request back (no double refunds).
  delete from public.ai_inflight where message_id = p_message_id and user_id = p_user returning day into v_day;
  insert into public.ai_usage as u (user_id, day, requests, failed_requests, failed_input_tokens, failed_output_tokens, failed_cost_usd)
  values (p_user, coalesce(v_day, private.ai_utc_day()), 0, 1, v_in, v_out, v_cost)
  on conflict (user_id, day) do update
    set requests = case when v_day is not null then greatest(u.requests - 1, 0) else u.requests end,
        failed_requests = u.failed_requests + 1,
        failed_input_tokens = u.failed_input_tokens + excluded.failed_input_tokens,
        failed_output_tokens = u.failed_output_tokens + excluded.failed_output_tokens,
        failed_cost_usd = case when excluded.failed_cost_usd is null then u.failed_cost_usd
                               else coalesce(u.failed_cost_usd, 0) + excluded.failed_cost_usd end,
        updated_at = now();
end $$;

revoke all on function public.ai_begin_request(uuid, uuid, integer), public.ai_fail_request(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.ai_begin_request(uuid, uuid, integer), public.ai_fail_request(uuid, uuid, jsonb) to service_role;
