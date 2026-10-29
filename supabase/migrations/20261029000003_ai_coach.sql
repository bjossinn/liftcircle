-- AI coach: settings/consent, conversation history, per-user daily usage, and AI program proposals.
-- See docs/AI_COACH.md and docs/COACHING_INTERFACES.md (ai_* tables and RPCs).
--
-- Runs AFTER 20261029000001_coaching_schema.sql (creates public.program_proposals) and BEFORE
-- 20261029000004_coaching_lockdown.sql. Additive only.
--
-- Authorization model
--   * ai_settings / ai_messages / ai_usage: RLS "user_id = auth.uid()" for SELECT, no client write grants.
--   * Client RPCs (authenticated): get_ai_settings, save_ai_settings, list_ai_messages, clear_ai_history,
--     list_ai_proposals, respond_ai_proposal. Caller = auth.uid(); nothing is taken from the request body.
--   * Service-role-only RPCs (ai-coach Edge Function): ai_check_and_count_usage, ai_record_exchange,
--     ai_get_exchange. The function passes the user id it verified from the JWT.
--   * The private.* helpers below are only called from those security-definer RPCs (which run as the
--     owner), so the lockdown migration revoking EXECUTE on private functions from API roles is harmless.

/* ============================================================== tables */

create table public.ai_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  enabled boolean not null default false,
  paused boolean not null default false,
  consent_at timestamptz,
  consent_version text check (consent_version is null or char_length(consent_version) <= 40),
  scopes jsonb not null default '{"profile": true, "training": true, "measurements": false, "nutrition": false}'::jsonb
    check (jsonb_typeof(scopes) = 'object'),
  scopes_changed_at timestamptz not null default now(),
  profile_notes text not null default '' check (char_length(profile_notes) <= 4000),
  updated_at timestamptz not null default now(),
  constraint ai_settings_enabled_needs_consent check (not enabled or consent_at is not null)
);
comment on table public.ai_settings is
  'Per-user AI coach enrollment: consent, enabled/paused, which data categories (scopes) the server may send to the AI provider, and user-editable notes.';

create table public.ai_messages (
  id uuid primary key, -- client uuid for user messages (idempotency key) / server uuid for replies
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(content) between 1 and 16000),
  reply_to uuid references public.ai_messages (id) on delete cascade,
  proposal_id uuid references public.program_proposals (id) on delete set null,
  grounding jsonb not null default '[]'::jsonb check (jsonb_typeof(grounding) = 'array'),
  mode text check (mode is null or mode in ('chat', 'checkin_review')),
  model text check (model is null or char_length(model) <= 100),
  input_tokens integer,
  output_tokens integer,
  created_at timestamptz not null default now(),
  seq bigint generated always as identity,
  constraint ai_messages_reply_shape check ((role = 'assistant') = (reply_to is not null))
);
create unique index ai_messages_one_reply_per_message on public.ai_messages (reply_to) where reply_to is not null;
create index ai_messages_by_user_seq on public.ai_messages (user_id, seq);
comment on table public.ai_messages is
  'AI coach conversation. Stored in this project until the user clears history or deletes the account.';

create table public.ai_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null, -- UTC day
  requests integer not null default 0 check (requests >= 0),
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cost_usd numeric(14, 6), -- null until prices are configured (AI_PRICE_*_PER_MTOK)
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);
comment on table public.ai_usage is 'Per-user, per-UTC-day AI request counts, token usage and estimated cost.';

do $$
declare t text;
begin
  foreach t in array array['ai_settings', 'ai_messages', 'ai_usage'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('create policy "owner can read" on public.%I for select to authenticated using (user_id = (select auth.uid()))', t);
  end loop;
end $$;

/* ============================================================ JSON helpers (private, definer-only) */

create or replace function private.ai_settings_json(s public.ai_settings) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when s.user_id is null then null else jsonb_build_object(
    'enabled', s.enabled,
    'paused', s.paused,
    'consentAt', s.consent_at,
    'consentVersion', s.consent_version,
    'scopes', jsonb_build_object(
      'profile', coalesce((s.scopes ->> 'profile')::boolean, false),
      'training', coalesce((s.scopes ->> 'training')::boolean, false),
      'measurements', coalesce((s.scopes ->> 'measurements')::boolean, false),
      'nutrition', coalesce((s.scopes ->> 'nutrition')::boolean, false)),
    'scopesChangedAt', s.scopes_changed_at,
    'profileNotes', s.profile_notes,
    'updatedAt', s.updated_at) end
$$;

create or replace function private.ai_message_json(m public.ai_messages) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', m.id,
    'role', m.role,
    'content', m.content,
    'createdAt', m.created_at,
    'status', 'sent',
    'proposalId', m.proposal_id,
    'grounding', m.grounding,
    'seq', m.seq)
$$;

create or replace function private.ai_proposal_json(p public.program_proposals) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when p.id is null then null else jsonb_build_object(
    'id', p.id,
    'authorKind', p.author_kind,
    'relationshipId', p.relationship_id,
    'coachId', p.coach_id,
    'clientId', p.client_id,
    'status', p.status,
    'baseProgramId', p.base_program_id,
    'baseVersion', p.base_version,
    'revision', p.revision,
    'program', p.program,
    'changeSummary', coalesce(p.change_summary, '[]'::jsonb),
    'message', p.message,
    'effectiveDate', p.effective_date,
    'target', p.target,
    'validationErrors', coalesce(p.validation_errors, '[]'::jsonb),
    'createdAt', p.created_at,
    'sentAt', p.sent_at,
    'respondedAt', p.responded_at,
    'appliedProgramId', p.applied_program_id,
    'appliedVersion', p.applied_version) end
$$;

-- Stored exchange (user message → assistant reply [+ proposal]) for one user, or null.
create or replace function private.ai_exchange_json(p_user uuid, p_message_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_reply public.ai_messages;
  v_prop public.program_proposals;
begin
  select r.* into v_reply
    from public.ai_messages u join public.ai_messages r on r.reply_to = u.id
   where u.id = p_message_id and u.user_id = p_user and r.user_id = p_user;
  if v_reply.id is null then return null; end if;
  if v_reply.proposal_id is not null then
    select * into v_prop from public.program_proposals
     where id = v_reply.proposal_id and client_id = p_user and author_kind = 'ai';
  end if;
  return jsonb_build_object('reply', private.ai_message_json(v_reply),
                            'proposal', case when v_prop.id is null then null else private.ai_proposal_json(v_prop) end,
                            'duplicate', true);
end $$;

create or replace function private.ai_utc_day() returns date
language sql stable security definer set search_path = '' as $$
  select (pg_catalog.now() at time zone 'utc')::date
$$;

/* ============================================================ client RPCs */

create or replace function public.get_ai_settings() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  s public.ai_settings;
begin
  select * into s from public.ai_settings where user_id = v_uid;
  if s.user_id is null then return null; end if;
  return private.ai_settings_json(s);
end $$;

-- p keys (all optional): enabled bool, paused bool, scopes {profile,training,measurements,nutrition: bool},
-- profileNotes text (≤ 4000), acceptConsent bool, consentVersion text. Other keys are ignored
-- (consentAt / scopesChangedAt / userId can never be set by the client).
create or replace function public.save_ai_settings(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  s public.ai_settings;
  v_scopes jsonb;
  v_key text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'Settings must be a JSON object.' using errcode = '22023';
  end if;
  perform private.enforce_rate_limit(v_uid, 'ai_settings', 120, interval '1 hour',
    'Too many AI coach settings changes. Please wait a little and try again.');

  insert into public.ai_settings (user_id) values (v_uid) on conflict (user_id) do nothing;
  select * into s from public.ai_settings where user_id = v_uid for update;

  if p ? 'acceptConsent' then
    if jsonb_typeof(p -> 'acceptConsent') <> 'boolean' then
      raise exception 'acceptConsent must be true or false.' using errcode = '22023';
    end if;
    if (p ->> 'acceptConsent')::boolean then
      s.consent_at := now();
      s.consent_version := coalesce(left(nullif(p ->> 'consentVersion', ''), 40), '2026-10-29');
    end if;
  end if;

  if p ? 'enabled' then
    if jsonb_typeof(p -> 'enabled') <> 'boolean' then
      raise exception 'enabled must be true or false.' using errcode = '22023';
    end if;
    s.enabled := (p ->> 'enabled')::boolean;
  end if;
  if p ? 'paused' then
    if jsonb_typeof(p -> 'paused') <> 'boolean' then
      raise exception 'paused must be true or false.' using errcode = '22023';
    end if;
    s.paused := (p ->> 'paused')::boolean;
  end if;

  if p ? 'scopes' then
    if jsonb_typeof(p -> 'scopes') <> 'object' then
      raise exception 'scopes must be an object.' using errcode = '22023';
    end if;
    v_scopes := private.ai_settings_json(s) -> 'scopes';
    foreach v_key in array array['profile', 'training', 'measurements', 'nutrition'] loop
      if (p -> 'scopes') ? v_key then
        if jsonb_typeof(p -> 'scopes' -> v_key) <> 'boolean' then
          raise exception 'Scope "%" must be true or false.', v_key using errcode = '22023';
        end if;
        v_scopes := jsonb_set(v_scopes, array[v_key], p -> 'scopes' -> v_key);
      end if;
    end loop;
    if v_scopes is distinct from (private.ai_settings_json(s) -> 'scopes') then
      s.scopes := v_scopes;
      -- History before this moment is no longer re-sent as context (it may quote revoked data).
      s.scopes_changed_at := now();
    end if;
  end if;

  if p ? 'profileNotes' then
    if jsonb_typeof(p -> 'profileNotes') not in ('string', 'null') then
      raise exception 'Notes must be text.' using errcode = '22023';
    end if;
    if char_length(coalesce(p ->> 'profileNotes', '')) > 4000 then
      raise exception 'Notes can be at most 4000 characters.' using errcode = 'P0001';
    end if;
    s.profile_notes := coalesce(p ->> 'profileNotes', '');
  end if;

  if s.enabled and s.consent_at is null then
    raise exception 'Please review what the AI coach uses and agree before turning it on.'
      using errcode = 'P0001', hint = 'consent_required';
  end if;

  update public.ai_settings
     set enabled = s.enabled, paused = s.paused, consent_at = s.consent_at, consent_version = s.consent_version,
         scopes = s.scopes, scopes_changed_at = s.scopes_changed_at, profile_notes = s.profile_notes, updated_at = now()
   where user_id = v_uid
  returning * into s;
  return private.ai_settings_json(s);
end $$;

create or replace function public.list_ai_messages(p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
begin
  return coalesce((
    select jsonb_agg(private.ai_message_json(m) order by m.seq)
      from (select * from public.ai_messages where user_id = v_uid order by seq desc limit v_limit) m
  ), '[]'::jsonb);
end $$;

-- Deletes the caller's AI conversation. Proposals (and their accept/decline record) and usage counters stay.
create or replace function public.clear_ai_history() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_n integer;
begin
  delete from public.ai_messages where user_id = v_uid;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create or replace function public.list_ai_proposals() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid();
begin
  return coalesce((
    select jsonb_agg(private.ai_proposal_json(p) order by p.created_at desc)
      from (select * from public.program_proposals
             where author_kind = 'ai' and client_id = v_uid
             order by created_at desc limit 100) p
  ), '[]'::jsonb);
end $$;

-- Client accepts/declines an AI proposal. Accept requires the program id + version the client created by
-- applying it locally (src/domain/program/proposals.ts applyProposal). When the base program is already
-- synced, its server version must still be the proposal's base version (not yet synced) or the applied
-- version (already synced) — anything else means the plan changed in between → 'stale'.
create or replace function public.respond_ai_proposal(p_id uuid, p_accept boolean, p_program_id uuid default null,
                                                      p_version integer default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  r public.program_proposals;
  v_cur integer;
  v_found boolean;
begin
  if p_accept is null then raise exception 'Choose accept or decline.' using errcode = '22023'; end if;
  select * into r from public.program_proposals
   where id = p_id and author_kind = 'ai' and client_id = v_uid for update;
  if r.id is null then
    raise exception 'Suggestion not found.' using errcode = 'P0001', hint = 'not_found';
  end if;

  -- Idempotent repeats.
  if r.status = 'accepted' and p_accept and r.applied_program_id is not distinct from p_program_id
     and r.applied_version is not distinct from p_version then
    return private.ai_proposal_json(r);
  end if;
  if r.status = 'declined' and not p_accept then return private.ai_proposal_json(r); end if;

  if r.status <> 'sent' then
    raise exception 'This suggestion is no longer open (%).', r.status using errcode = 'P0001', hint = 'not_open';
  end if;

  if not p_accept then
    update public.program_proposals set status = 'declined', responded_at = now(), updated_at = now() where id = r.id returning * into r;
    return private.ai_proposal_json(r);
  end if;

  if r.target <> 'apply' then
    raise exception 'This is a suggestion to discuss with your coach; it can''t be applied directly.'
      using errcode = 'P0001', hint = 'not_applicable';
  end if;
  if p_program_id is null or p_version is null or p_version < 1 then
    raise exception 'Accepting needs the program and version it was applied to.' using errcode = '22023';
  end if;

  if r.base_program_id is not null then
    if p_program_id <> r.base_program_id then
      raise exception 'This suggestion revises a different plan.' using errcode = 'P0001', hint = 'wrong_program';
    end if;
    if p_version <= r.base_version then
      raise exception 'Applying creates a new version of your plan.' using errcode = '22023';
    end if;
    select current_version, true into v_cur, v_found from public.programs
     where owner_id = v_uid and id = r.base_program_id and deleted_at is null;
    if v_found and v_cur is distinct from r.base_version and v_cur is distinct from p_version then
      raise exception 'Your plan changed after this suggestion was written. Ask for a revised version.'
        using errcode = 'P0001', detail = 'stale', hint = 'stale';
    end if;
  end if;

  update public.program_proposals
     set status = 'accepted', responded_at = now(), updated_at = now(), applied_program_id = p_program_id, applied_version = p_version
   where id = r.id returning * into r;
  -- Other open AI suggestions for the same plan were written against the old version.
  update public.program_proposals
     set status = 'superseded', updated_at = now()
   where author_kind = 'ai' and client_id = v_uid and status = 'sent' and id <> r.id
     and base_program_id is not distinct from r.base_program_id;
  return private.ai_proposal_json(r);
end $$;

/* ============================================================ service-role RPCs (ai-coach function) */

-- Counts one request for today (UTC) and returns how many remain; raises PT429 when the limit is reached.
create or replace function public.ai_check_and_count_usage(p_user uuid, p_limit integer) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_day date := private.ai_utc_day();
  v_n integer;
begin
  if p_user is null then raise exception 'User is required.' using errcode = '22023'; end if;
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
  return p_limit - v_n;
end $$;

create or replace function public.ai_get_exchange(p_user uuid, p_message_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select private.ai_exchange_json(p_user, p_message_id)
$$;

-- Atomically stores the user's message, the assistant reply and (optionally) an AI program proposal.
-- Idempotent on the user message id: a repeat returns the stored exchange with duplicate = true.
--   p_message  {id, content, mode}
--   p_reply    {content, grounding[], model, inputTokens, outputTokens}
--   p_proposal {baseProgramId, baseVersion, program{}, changeSummary[], message, target, validationErrors[], effectiveDate} | null
--   p_usage    {inputTokens, outputTokens, costUsd|null} | null
create or replace function public.ai_record_exchange(p_user uuid, p_message jsonb, p_reply jsonb,
                                                     p_proposal jsonb default null, p_usage jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_msg_id uuid;
  v_owner uuid;
  v_existing jsonb;
  v_prop public.program_proposals;
  v_reply public.ai_messages;
  v_errors jsonb;
  v_base uuid;
  v_target text;
  v_mode text;
begin
  if p_user is null or not exists (select 1 from auth.users where id = p_user) then
    raise exception 'Unknown user.' using errcode = '22023';
  end if;
  v_msg_id := private.try_uuid(p_message ->> 'id');
  if v_msg_id is null then raise exception 'Message id is required.' using errcode = '22023'; end if;
  if coalesce(btrim(p_message ->> 'content'), '') = '' or char_length(p_message ->> 'content') > 2000 then
    raise exception 'Message must be 1–2000 characters.' using errcode = '22023';
  end if;
  if coalesce(btrim(p_reply ->> 'content'), '') = '' then
    raise exception 'Reply is empty.' using errcode = '22023';
  end if;
  v_mode := case when p_message ->> 'mode' = 'checkin_review' then 'checkin_review' else 'chat' end;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ai:' || p_user::text, 0));

  select user_id into v_owner from public.ai_messages where id = v_msg_id;
  if v_owner is not null then
    if v_owner <> p_user then
      raise exception 'Message id already used.' using errcode = '23505';
    end if;
    v_existing := private.ai_exchange_json(p_user, v_msg_id);
    if v_existing is not null then return v_existing; end if;
  else
    insert into public.ai_messages (id, user_id, role, content, mode)
    values (v_msg_id, p_user, 'user', p_message ->> 'content', v_mode);
  end if;

  if p_proposal is not null and jsonb_typeof(p_proposal) = 'object' then
    if jsonb_typeof(p_proposal -> 'program') is distinct from 'object' or octet_length((p_proposal -> 'program')::text) > 262144 then
      raise exception 'Proposal program must be an object (≤ 256 KB).' using errcode = '22023';
    end if;
    v_errors := case when jsonb_typeof(p_proposal -> 'validationErrors') = 'array' then p_proposal -> 'validationErrors' else '[]'::jsonb end;
    v_base := private.try_uuid(p_proposal ->> 'baseProgramId');
    v_target := case when p_proposal ->> 'target' = 'for_coach_review' then 'for_coach_review' else 'apply' end;
    if jsonb_array_length(v_errors) = 0 then
      -- A newer valid suggestion for the same plan replaces older open ones.
      update public.program_proposals set status = 'superseded', updated_at = now()
       where author_kind = 'ai' and client_id = p_user and status = 'sent' and base_program_id is not distinct from v_base;
    end if;
    insert into public.program_proposals (id, author_kind, relationship_id, coach_id, client_id, status, base_program_id,
                                          base_version, revision, program, change_summary, message, effective_date,
                                          target, validation_errors, created_at, sent_at)
    values (gen_random_uuid(), 'ai', null, null, p_user,
            case when jsonb_array_length(v_errors) = 0 then 'sent' else 'invalid' end,
            v_base, case when v_base is null then null else private.try_int(p_proposal ->> 'baseVersion') end,
            1 + (select count(*) from public.program_proposals
                  where author_kind = 'ai' and client_id = p_user and base_program_id is not distinct from v_base),
            p_proposal -> 'program',
            case when jsonb_typeof(p_proposal -> 'changeSummary') = 'array' then p_proposal -> 'changeSummary' else '[]'::jsonb end,
            left(p_proposal ->> 'message', 2000),
            private.try_date(p_proposal ->> 'effectiveDate'),
            v_target, v_errors, now(),
            case when jsonb_array_length(v_errors) = 0 then now() end)
    returning * into v_prop;
  end if;

  insert into public.ai_messages (id, user_id, role, content, reply_to, proposal_id, grounding, mode, model, input_tokens, output_tokens)
  values (gen_random_uuid(), p_user, 'assistant', left(p_reply ->> 'content', 16000), v_msg_id, v_prop.id,
          case when jsonb_typeof(p_reply -> 'grounding') = 'array' then p_reply -> 'grounding' else '[]'::jsonb end,
          v_mode, left(p_reply ->> 'model', 100),
          private.try_int(p_reply ->> 'inputTokens'), private.try_int(p_reply ->> 'outputTokens'))
  returning * into v_reply;

  if p_usage is not null and jsonb_typeof(p_usage) = 'object' then
    insert into public.ai_usage as u (user_id, day, requests, input_tokens, output_tokens, cost_usd)
    values (p_user, private.ai_utc_day(), 0, coalesce(private.try_int(p_usage ->> 'inputTokens'), 0),
            coalesce(private.try_int(p_usage ->> 'outputTokens'), 0), private.try_num(p_usage ->> 'costUsd'))
    on conflict (user_id, day) do update
      set input_tokens = u.input_tokens + excluded.input_tokens,
          output_tokens = u.output_tokens + excluded.output_tokens,
          cost_usd = case when excluded.cost_usd is null then u.cost_usd else coalesce(u.cost_usd, 0) + excluded.cost_usd end,
          updated_at = now();
  end if;

  return jsonb_build_object('reply', private.ai_message_json(v_reply),
                            'proposal', case when v_prop.id is null then null else private.ai_proposal_json(v_prop) end,
                            'duplicate', false);
end $$;

/* ============================================================ grants */

revoke all on function public.get_ai_settings(), public.save_ai_settings(jsonb), public.list_ai_messages(integer),
  public.clear_ai_history(), public.list_ai_proposals(), public.respond_ai_proposal(uuid, boolean, uuid, integer)
  from public, anon;
grant execute on function public.get_ai_settings(), public.save_ai_settings(jsonb), public.list_ai_messages(integer),
  public.clear_ai_history(), public.list_ai_proposals(), public.respond_ai_proposal(uuid, boolean, uuid, integer)
  to authenticated;

revoke all on function public.ai_check_and_count_usage(uuid, integer), public.ai_get_exchange(uuid, uuid),
  public.ai_record_exchange(uuid, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.ai_check_and_count_usage(uuid, integer), public.ai_get_exchange(uuid, uuid),
  public.ai_record_exchange(uuid, jsonb, jsonb, jsonb, jsonb) to service_role;

revoke all on function private.ai_settings_json(public.ai_settings), private.ai_message_json(public.ai_messages),
  private.ai_proposal_json(public.program_proposals), private.ai_exchange_json(uuid, uuid), private.ai_utc_day()
  from public, anon, authenticated;
