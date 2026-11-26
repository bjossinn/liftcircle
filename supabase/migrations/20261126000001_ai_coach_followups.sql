-- Training assistant follow-ups (PR 1b, additive; safe to re-run).
--
-- One row per user message in public.ai_requests: the attempt answering it now, whether it holds a charge (a request
-- counted in ai_usage.requests) and its state. Each message is charged at most once, and only while its answer is
-- running or stored. States and transitions (all under the per-user advisory lock):
--
--   (none) ──begin, allowance left──▶ running(charged, attempt A1)              ai_begin_request → 'started'
--   (none) ──begin, limit reached──▶ (none)                                      PT429
--   running, < 3 min ──begin──▶ unchanged                                        'in_progress' (no generation, no charge)
--   running, ≥ 3 min ──begin──▶ running(NEW attempt A2, SAME charge)            'started' (takeover: no new charge, no
--                                                                                 limit check: the request already paid)
--   running ──fail(current attempt)──▶ failed(uncharged)                         refund + failed_* booked, once
--   running ──fail(older attempt)──▶ unchanged                                   no-op (a newer attempt owns it)
--   running | failed ──record (any attempt)──▶ succeeded(charged)               ai_record_exchange_settled: the stored
--                                                                                 answer and the success are one
--                                                                                 transaction; a request refunded
--                                                                                 earlier is charged again (no limit
--                                                                                 check: the work is done)
--   failed ──begin, allowance left──▶ running(charged, new attempt)             retry of a failed message
--   failed | succeeded ──fail(any attempt)──▶ unchanged                          no-op (idempotent; a lost response after
--                                                                                 a stored answer never refunds)
--   succeeded (or a stored reply) ──begin──▶ unchanged                           'duplicate'
--
-- Also: ai_usage.failed_requests / failed_input_tokens / failed_output_tokens / failed_cost_usd (tokens of failed
-- attempts, never mixed with successful usage) and ai_settings.coach_style defaults to 'supportive' for new rows.
-- Service-role only, like the other ai-coach RPCs. Until this is applied the ai-coach function falls back to
-- ai_check_and_count_usage / ai_record_exchange (the previous behaviour).

alter table public.ai_usage
  add column if not exists failed_requests integer not null default 0 check (failed_requests >= 0),
  add column if not exists failed_input_tokens bigint not null default 0,
  add column if not exists failed_output_tokens bigint not null default 0,
  add column if not exists failed_cost_usd numeric(14, 6);

-- An earlier draft of this migration (never applied outside development) used these names.
drop function if exists public.ai_fail_request(uuid, uuid, jsonb);
drop table if exists public.ai_inflight;

create table if not exists public.ai_requests (
  message_id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  attempt uuid not null,
  state text not null check (state in ('running', 'succeeded', 'failed')),
  charged boolean not null,
  day date not null,
  started_at timestamptz not null default now(),
  settled_at timestamptz
);
create index if not exists ai_requests_user_idx on public.ai_requests (user_id, started_at);
comment on table public.ai_requests is 'Training assistant requests: current attempt, charge and state per user message. Service role only.';
alter table public.ai_requests enable row level security;
revoke all on public.ai_requests from public, anon, authenticated;

alter table public.ai_settings alter column coach_style set default 'supportive';

/* Charge one request for p_user today (PT429 when p_limit is reached; no check when p_limit is null). */
create or replace function private.ai_charge_request(p_user uuid, p_limit integer) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_n integer;
begin
  if p_limit is not null and p_limit < 1 then
    raise exception 'The AI coach daily limit is set to 0.' using errcode = 'PT429', hint = 'rate_limited';
  end if;
  insert into public.ai_usage as u (user_id, day, requests) values (p_user, private.ai_utc_day(), 1)
  on conflict (user_id, day) do update set requests = u.requests + 1, updated_at = now()
   where p_limit is null or u.requests < p_limit
  returning u.requests into v_n;
  if v_n is null then
    raise exception 'You''ve reached today''s AI coach limit of % messages. It resets at midnight UTC.', p_limit
      using errcode = 'PT429', hint = 'rate_limited';
  end if;
  return v_n;
end $$;
revoke all on function private.ai_charge_request(uuid, integer) from public, anon, authenticated;

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

  delete from public.ai_requests where user_id = p_user and state <> 'running' and started_at < now() - interval '7 days';
  select * into v_req from public.ai_requests where message_id = p_message_id for update;
  if found then
    if v_req.user_id <> p_user then raise exception 'Message id already used.' using errcode = '23505'; end if;
    if v_req.state = 'succeeded' then return jsonb_build_object('status', 'duplicate'); end if;
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
       set attempt = v_attempt, state = 'running', charged = true, day = private.ai_utc_day(), started_at = now(), settled_at = null
     where message_id = p_message_id;
    return jsonb_build_object('status', 'started', 'attempt', v_attempt, 'remaining', p_limit - v_n);
  end if;

  v_n := private.ai_charge_request(p_user, p_limit);
  insert into public.ai_requests (message_id, user_id, attempt, state, charged, day, started_at)
  values (p_message_id, p_user, v_attempt, 'running', true, private.ai_utc_day(), now());
  return jsonb_build_object('status', 'started', 'attempt', v_attempt, 'remaining', p_limit - v_n);
end $$;

create or replace function public.ai_fail_request(p_user uuid, p_message_id uuid, p_attempt uuid, p_usage jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_req public.ai_requests;
  v_in bigint := coalesce(private.try_int(p_usage ->> 'inputTokens'), 0);
  v_out bigint := coalesce(private.try_int(p_usage ->> 'outputTokens'), 0);
  v_cost numeric := private.try_num(p_usage ->> 'costUsd');
begin
  if p_user is null or p_message_id is null or p_attempt is null then
    raise exception 'User, message id and attempt are required.' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ai:' || p_user::text, 0));
  -- Only the attempt that currently owns a running request settles it; everything else is a no-op (idempotent).
  select * into v_req from public.ai_requests
   where message_id = p_message_id and user_id = p_user and attempt = p_attempt and state = 'running' for update;
  if not found then return jsonb_build_object('settled', false); end if;

  update public.ai_requests set state = 'failed', charged = false, settled_at = now() where message_id = p_message_id;
  if v_req.charged then
    update public.ai_usage set requests = greatest(requests - 1, 0), updated_at = now() where user_id = p_user and day = v_req.day;
  end if;
  insert into public.ai_usage as u (user_id, day, requests, failed_requests, failed_input_tokens, failed_output_tokens, failed_cost_usd)
  values (p_user, private.ai_utc_day(), 0, 1, v_in, v_out, v_cost)
  on conflict (user_id, day) do update
    set failed_requests = u.failed_requests + 1,
        failed_input_tokens = u.failed_input_tokens + excluded.failed_input_tokens,
        failed_output_tokens = u.failed_output_tokens + excluded.failed_output_tokens,
        failed_cost_usd = case when excluded.failed_cost_usd is null then u.failed_cost_usd
                               else coalesce(u.failed_cost_usd, 0) + excluded.failed_cost_usd end,
        updated_at = now();
  return jsonb_build_object('settled', true, 'refunded', v_req.charged);
end $$;

-- Store the exchange AND settle its request as succeeded in one transaction (ai_record_exchange is unchanged).
create or replace function public.ai_record_exchange_settled(p_user uuid, p_message jsonb, p_reply jsonb,
                                                             p_proposal jsonb default null, p_usage jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_result jsonb;
  v_id uuid;
  v_req public.ai_requests;
begin
  if p_user is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ai:' || p_user::text, 0));
  end if;
  v_result := public.ai_record_exchange(p_user, p_message, p_reply, p_proposal, p_usage);
  v_id := private.try_uuid(p_message ->> 'id');
  select * into v_req from public.ai_requests where message_id = v_id and user_id = p_user for update;
  if found and v_req.state <> 'succeeded' then
    -- A request refunded by a failed attempt whose answer was stored anyway (an older, slow attempt) pays once.
    if not v_req.charged then perform private.ai_charge_request(p_user, null); end if;
    update public.ai_requests
       set state = 'succeeded', charged = true, settled_at = now(),
           day = case when v_req.charged then v_req.day else private.ai_utc_day() end
     where message_id = v_id;
  end if;
  return v_result;
end $$;

revoke all on function public.ai_begin_request(uuid, uuid, integer), public.ai_fail_request(uuid, uuid, uuid, jsonb),
  public.ai_record_exchange_settled(uuid, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.ai_begin_request(uuid, uuid, integer), public.ai_fail_request(uuid, uuid, uuid, jsonb),
  public.ai_record_exchange_settled(uuid, jsonb, jsonb, jsonb, jsonb) to service_role;
