-- Training assistant: acknowledged cancellation (roadmap item 10, 2026-11-30). Additive only; safe to re-run. No data changes.
--
-- public.ai_requests gains two states and a timestamp. Transitions added to 20261126000001 (all under the same per-user
-- advisory lock, and on the same request row as success, so cancel and success are serialized):
--
--   (none) ──cancel──▶ cancelled (uncharged tombstone)              the delayed original send never starts
--   running ──cancel──▶ cancel_requested                            NOT yet cancelled: the worker must acknowledge
--   running ≥ 3 min (abandoned) ──cancel──▶ cancelled, refund once
--   failed ──cancel──▶ cancelled                                    (already refunded; a delayed retry never starts)
--   cancel_requested ──settle(own attempt)──▶ cancelled, refund once, completed-round tokens booked as cancelled usage
--   cancel_requested ──fail(own attempt)──▶ cancelled, refund once  (the worker failed while stopping)
--   cancel_requested ≥ 2 min ──(cancel | status | begin)──▶ cancelled, refund once   bounded expiry finalizer: the worker died
--   cancel_requested | cancelled ──begin──▶ unchanged               'cancelled' (a resend needs a new message id)
--   cancel_requested | cancelled ──record──▶ refused                 PT409 'cancelled': nothing is stored or published
--   succeeded ──cancel──▶ unchanged                                 'succeeded' (success won; the app shows the exchange)
--
-- Refunds go to the day the request was charged (a request charged before midnight UTC is refunded on that day);
-- failed/cancelled usage is booked on the current day. Usage reports are idempotent per attempt
-- (public.ai_request_usage_reports): a late or repeated report never books twice and never refunds again. A report
-- without provider usage counts in ai_usage.unknown_usage_attempts instead of pretending zero tokens.
--
-- Publication guard: a BEFORE INSERT trigger on ai_messages refuses an assistant reply to a cancelled or
-- cancel-requested request, so EVERY settlement path is covered, including the legacy ai_record_exchange called by
-- older function deployments.
--
-- New service-role RPCs: ai_cancel_request, ai_settle_cancelled, ai_request_status. The ai-coach function detects them
-- (PGRST202 = not applied yet) and only then offers Stop; until this migration is applied the app keeps today's behaviour.

alter table public.ai_requests add column if not exists cancel_requested_at timestamptz;
alter table public.ai_requests drop constraint if exists ai_requests_state_check;
alter table public.ai_requests add constraint ai_requests_state_check
  check (state in ('running', 'succeeded', 'failed', 'cancel_requested', 'cancelled'));

alter table public.ai_usage
  add column if not exists cancelled_requests integer not null default 0 check (cancelled_requests >= 0),
  add column if not exists unknown_usage_attempts integer not null default 0 check (unknown_usage_attempts >= 0);

create table if not exists public.ai_request_usage_reports (
  message_id uuid not null,
  attempt uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  booked_at timestamptz not null default now(),
  primary key (message_id, attempt)
);
comment on table public.ai_request_usage_reports is 'Training assistant: which attempt''s failed/cancelled usage was booked (idempotency). Service role only.';
alter table public.ai_request_usage_reports enable row level security;
revoke all on public.ai_request_usage_reports from public, anon, authenticated;

/* Book an attempt's failed (or cancelled) usage once. Returns false when it was already booked. */
create or replace function private.ai_book_attempt_usage(p_user uuid, p_message_id uuid, p_attempt uuid, p_usage jsonb, p_cancelled boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_in bigint := coalesce(private.try_int(p_usage ->> 'inputTokens'), 0);
  v_out bigint := coalesce(private.try_int(p_usage ->> 'outputTokens'), 0);
  v_cost numeric := private.try_num(p_usage ->> 'costUsd');
  v_unknown boolean := coalesce((p_usage ->> 'unknown') = 'true', false) or p_usage is null;
begin
  insert into public.ai_request_usage_reports (message_id, attempt, user_id) values (p_message_id, p_attempt, p_user)
  on conflict (message_id, attempt) do nothing;
  if not found then return false; end if;
  insert into public.ai_usage as u (user_id, day, requests, failed_requests, failed_input_tokens, failed_output_tokens, failed_cost_usd,
                                    cancelled_requests, unknown_usage_attempts)
  values (p_user, private.ai_utc_day(), 0, 1, v_in, v_out, v_cost, case when p_cancelled then 1 else 0 end, case when v_unknown then 1 else 0 end)
  on conflict (user_id, day) do update
    set failed_requests = u.failed_requests + 1,
        failed_input_tokens = u.failed_input_tokens + excluded.failed_input_tokens,
        failed_output_tokens = u.failed_output_tokens + excluded.failed_output_tokens,
        failed_cost_usd = case when excluded.failed_cost_usd is null then u.failed_cost_usd
                               else coalesce(u.failed_cost_usd, 0) + excluded.failed_cost_usd end,
        cancelled_requests = u.cancelled_requests + excluded.cancelled_requests,
        unknown_usage_attempts = u.unknown_usage_attempts + excluded.unknown_usage_attempts,
        updated_at = now();
  return true;
end $$;
revoke all on function private.ai_book_attempt_usage(uuid, uuid, uuid, jsonb, boolean) from public, anon, authenticated;

/* Give back a request's charge once, on the day it was charged. Caller holds the lock and the row. */
create or replace function private.ai_refund_request(p_req public.ai_requests) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not p_req.charged then return false; end if;
  update public.ai_usage set requests = greatest(requests - 1, 0), updated_at = now() where user_id = p_req.user_id and day = p_req.day;
  update public.ai_requests set charged = false where message_id = p_req.message_id;
  return true;
end $$;
revoke all on function private.ai_refund_request(public.ai_requests) from public, anon, authenticated;

/* Bounded expiry finalizer: a cancel nobody acknowledged within 2 minutes (worker died) becomes cancelled. */
create or replace function private.ai_finalize_cancel(p_message_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_req public.ai_requests;
begin
  select * into v_req from public.ai_requests where message_id = p_message_id for update;
  if found and v_req.state = 'cancel_requested' and v_req.cancel_requested_at < now() - interval '2 minutes' then
    perform private.ai_refund_request(v_req);
    update public.ai_requests set state = 'cancelled', settled_at = now() where message_id = p_message_id;
  end if;
end $$;
revoke all on function private.ai_finalize_cancel(uuid) from public, anon, authenticated;

/* ai_begin_request: as 20261126000001, plus: cancel_requested / cancelled never start ('cancelled'). */
create or replace function public.ai_begin_request(p_user uuid, p_message_id uuid, p_limit integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid;
  v_req public.ai_requests;
  v_attempt uuid := gen_random_uuid();
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

  delete from public.ai_requests where user_id = p_user and state not in ('running', 'cancel_requested') and started_at < now() - interval '7 days';
  perform private.ai_finalize_cancel(p_message_id);
  select * into v_req from public.ai_requests where message_id = p_message_id for update;
  if found then
    if v_req.user_id <> p_user then raise exception 'Message id already used.' using errcode = '23505'; end if;
    if v_req.state = 'succeeded' then return jsonb_build_object('status', 'duplicate'); end if;
    if v_req.state in ('cancel_requested', 'cancelled') then return jsonb_build_object('status', 'cancelled'); end if;
    if v_req.state = 'running' then
      if v_req.started_at > now() - interval '3 minutes' then
        return jsonb_build_object('status', 'in_progress');
      end if;
      -- Takeover of an abandoned attempt: the request already holds its charge; only the attempt changes.
      update public.ai_requests set attempt = v_attempt, started_at = now() where message_id = p_message_id;
      return jsonb_build_object('status', 'started', 'attempt', v_attempt, 'takeover', true);
    end if;
    -- 'failed' (uncharged): a retry is a new request.
    v_n := private.ai_charge_request(p_user, p_limit);
    update public.ai_requests
       set attempt = v_attempt, state = 'running', charged = true, day = private.ai_utc_day(), started_at = now(), settled_at = null,
           cancel_requested_at = null
     where message_id = p_message_id;
    return jsonb_build_object('status', 'started', 'attempt', v_attempt, 'remaining', p_limit - v_n);
  end if;

  v_n := private.ai_charge_request(p_user, p_limit);
  insert into public.ai_requests (message_id, user_id, attempt, state, charged, day, started_at)
  values (p_message_id, p_user, v_attempt, 'running', true, private.ai_utc_day(), now());
  return jsonb_build_object('status', 'started', 'attempt', v_attempt, 'remaining', p_limit - v_n);
end $$;

/* ai_fail_request: as 20261126000001 (only the owning attempt settles), plus cancel_requested → cancelled, and usage booked
   once per attempt. A report for an attempt of an already-cancelled request books its tokens once, never a refund. */
create or replace function public.ai_fail_request(p_user uuid, p_message_id uuid, p_attempt uuid, p_usage jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_req public.ai_requests;
  v_refunded boolean;
begin
  if p_user is null or p_message_id is null or p_attempt is null then
    raise exception 'User, message id and attempt are required.' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ai:' || p_user::text, 0));
  select * into v_req from public.ai_requests
   where message_id = p_message_id and user_id = p_user and attempt = p_attempt for update;
  if not found then return jsonb_build_object('settled', false); end if;
  if v_req.state = 'running' then
    v_refunded := private.ai_refund_request(v_req);
    update public.ai_requests set state = 'failed', settled_at = now() where message_id = p_message_id;
    perform private.ai_book_attempt_usage(p_user, p_message_id, p_attempt, p_usage, false);
    return jsonb_build_object('settled', true, 'refunded', v_refunded);
  end if;
  if v_req.state = 'cancel_requested' then
    v_refunded := private.ai_refund_request(v_req);
    update public.ai_requests set state = 'cancelled', settled_at = now() where message_id = p_message_id;
    perform private.ai_book_attempt_usage(p_user, p_message_id, p_attempt, p_usage, true);
    return jsonb_build_object('settled', true, 'refunded', v_refunded, 'state', 'cancelled');
  end if;
  if v_req.state = 'cancelled' then
    perform private.ai_book_attempt_usage(p_user, p_message_id, p_attempt, p_usage, true);
  end if;
  return jsonb_build_object('settled', false);
end $$;

/* The user's Stop. Ownership from p_user (the verified JWT subject in the function). */
create or replace function public.ai_cancel_request(p_user uuid, p_message_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid;
  v_req public.ai_requests;
begin
  if p_user is null or p_message_id is null then
    raise exception 'User and message id are required.' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ai:' || p_user::text, 0));
  select user_id into v_owner from public.ai_messages where id = p_message_id;
  if v_owner is not null and v_owner <> p_user then raise exception 'Message id already used.' using errcode = '23505'; end if;
  if v_owner is not null and exists (select 1 from public.ai_messages where reply_to = p_message_id) then
    return jsonb_build_object('status', 'succeeded');
  end if;
  perform private.ai_finalize_cancel(p_message_id);
  select * into v_req from public.ai_requests where message_id = p_message_id for update;
  if not found then
    -- Before admission: a tombstone, so the delayed original send can never start.
    insert into public.ai_requests (message_id, user_id, attempt, state, charged, day, started_at, settled_at, cancel_requested_at)
    values (p_message_id, p_user, gen_random_uuid(), 'cancelled', false, private.ai_utc_day(), now(), now(), now());
    return jsonb_build_object('status', 'cancelled');
  end if;
  if v_req.user_id <> p_user then raise exception 'Message id already used.' using errcode = '23505'; end if;
  if v_req.state = 'succeeded' then return jsonb_build_object('status', 'succeeded'); end if;
  if v_req.state = 'cancelled' then return jsonb_build_object('status', 'cancelled'); end if;
  if v_req.state = 'cancel_requested' then return jsonb_build_object('status', 'cancel_requested'); end if;
  if v_req.state = 'failed' then
    update public.ai_requests set state = 'cancelled', cancel_requested_at = now(), settled_at = now() where message_id = p_message_id;
    return jsonb_build_object('status', 'cancelled');
  end if;
  -- running
  if v_req.started_at < now() - interval '3 minutes' then
    perform private.ai_refund_request(v_req);
    update public.ai_requests set state = 'cancelled', cancel_requested_at = now(), settled_at = now() where message_id = p_message_id;
    return jsonb_build_object('status', 'cancelled');
  end if;
  update public.ai_requests set state = 'cancel_requested', cancel_requested_at = now() where message_id = p_message_id;
  return jsonb_build_object('status', 'cancel_requested');
end $$;

/* The worker's acknowledgement of a cancel (its own attempt only). Idempotent; never refunds twice. */
create or replace function public.ai_settle_cancelled(p_user uuid, p_message_id uuid, p_attempt uuid, p_usage jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_req public.ai_requests;
  v_refunded boolean;
begin
  if p_user is null or p_message_id is null or p_attempt is null then
    raise exception 'User, message id and attempt are required.' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ai:' || p_user::text, 0));
  select * into v_req from public.ai_requests
   where message_id = p_message_id and user_id = p_user and attempt = p_attempt for update;
  if not found then return jsonb_build_object('settled', false, 'refunded', false); end if;
  if v_req.state = 'cancel_requested' then
    v_refunded := private.ai_refund_request(v_req);
    update public.ai_requests set state = 'cancelled', settled_at = now() where message_id = p_message_id;
    perform private.ai_book_attempt_usage(p_user, p_message_id, p_attempt, p_usage, true);
    return jsonb_build_object('settled', true, 'refunded', v_refunded);
  end if;
  if v_req.state = 'cancelled' then
    perform private.ai_book_attempt_usage(p_user, p_message_id, p_attempt, p_usage, true);
  end if;
  return jsonb_build_object('settled', false, 'refunded', false);
end $$;

/* Where a request stands (with the expiry finalizer). 'none' when there is no row; 'succeeded' once a reply is stored. */
create or replace function public.ai_request_status(p_user uuid, p_message_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_req public.ai_requests;
begin
  if p_user is null or p_message_id is null then
    raise exception 'User and message id are required.' using errcode = '22023';
  end if;
  if exists (select 1 from public.ai_messages where reply_to = p_message_id and user_id = p_user) then
    return jsonb_build_object('state', 'succeeded');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ai:' || p_user::text, 0));
  perform private.ai_finalize_cancel(p_message_id);
  select * into v_req from public.ai_requests where message_id = p_message_id and user_id = p_user;
  return jsonb_build_object('state', coalesce(v_req.state, 'none'));
end $$;

/* ai_record_exchange_settled: as 20261126000001, but a cancelled or cancel-requested request is refused FIRST. */
create or replace function public.ai_record_exchange_settled(p_user uuid, p_message jsonb, p_reply jsonb,
                                                             p_proposal jsonb default null, p_usage jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_result jsonb;
  v_id uuid;
  v_req public.ai_requests;
  v_found boolean;
begin
  if p_user is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ai:' || p_user::text, 0));
  end if;
  v_id := private.try_uuid(p_message ->> 'id');
  select * into v_req from public.ai_requests where message_id = v_id and user_id = p_user for update;
  v_found := found;
  if v_found and v_req.state in ('cancel_requested', 'cancelled') then
    raise exception 'The reply was stopped.' using errcode = 'PT409', hint = 'cancelled';
  end if;
  v_result := public.ai_record_exchange(p_user, p_message, p_reply, p_proposal, p_usage);
  if v_found and v_req.state <> 'succeeded' then
    -- A request refunded by a failed attempt whose answer was stored anyway (an older, slow attempt) pays once.
    if not v_req.charged then perform private.ai_charge_request(p_user, null); end if;
    update public.ai_requests
       set state = 'succeeded', charged = true, settled_at = now(),
           day = case when v_req.charged then v_req.day else private.ai_utc_day() end
     where message_id = v_id;
  end if;
  return v_result;
end $$;

/* Publication guard for every path (incl. the legacy ai_record_exchange): no reply to a stopped request. */
create or replace function private.ai_block_cancelled_reply() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.role = 'assistant' and new.reply_to is not null and exists (
    select 1 from public.ai_requests r where r.message_id = new.reply_to and r.state in ('cancel_requested', 'cancelled')
  ) then
    raise exception 'The reply was stopped.' using errcode = 'PT409', hint = 'cancelled';
  end if;
  return new;
end $$;
revoke all on function private.ai_block_cancelled_reply() from public, anon, authenticated;
drop trigger if exists ai_messages_block_cancelled on public.ai_messages;
create trigger ai_messages_block_cancelled before insert on public.ai_messages
  for each row execute function private.ai_block_cancelled_reply();

revoke all on function public.ai_cancel_request(uuid, uuid), public.ai_settle_cancelled(uuid, uuid, uuid, jsonb),
  public.ai_request_status(uuid, uuid), public.ai_begin_request(uuid, uuid, integer), public.ai_fail_request(uuid, uuid, uuid, jsonb),
  public.ai_record_exchange_settled(uuid, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.ai_cancel_request(uuid, uuid), public.ai_settle_cancelled(uuid, uuid, uuid, jsonb),
  public.ai_request_status(uuid, uuid), public.ai_begin_request(uuid, uuid, integer), public.ai_fail_request(uuid, uuid, uuid, jsonb),
  public.ai_record_exchange_settled(uuid, jsonb, jsonb, jsonb, jsonb) to service_role;
