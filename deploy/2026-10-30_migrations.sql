-- Hard Earned deploy 2026-10-30: four additive migrations, in order. Paste into Supabase → SQL Editor → Run.
-- The editor may warn about RLS / destructive statements inside function bodies: both are expected (choose Run).
-- Safe to re-run: every statement is create-or-replace / if-not-exists / on-conflict-do-nothing.
begin;

-- ===================================================== 20261030000001_set_validation
-- Server-side guard for logged workout sets (repair brief 29 Oct, section 4).
--
-- Mirrors the "always" rules of src/domain/setValidation.ts for NEW writes: every set number that is
-- present (weightKg, reps, durationSec, distanceM, rpe, rir) must be a JSON number >= 0, and reps must
-- be a whole number. JSON can't carry NaN/Infinity, so "non-finite" arrives as strings or other types,
-- which are rejected too.
--
-- Decision (backwards compatible): completed rep sets with reps = 0 are NOT rejected here. Devices running
-- the previous app version may hold such sets locally and must still be able to sync edits; the shared
-- client rules keep them from counting as work (working sets, PRs, volume, progression). The current client
-- refuses to complete them.
--
-- Existing production rows are never re-validated: the check runs only when a payload is inserted or
-- changed, deletions/tombstones pass, and a row that was already invalid before this migration may still be
-- updated (grandfathered) so old data never blocks sync.
--
-- Additive only: two private functions and one trigger. Implemented as a BEFORE trigger (not a new
-- sync_push definition) so it composes with any later sync_push changes.

create or replace function private.session_payload_problem(p jsonb)
returns text language sql immutable security definer set search_path = '' as $$
  select format('Workout set "%s" has an invalid %s value.', left(coalesce(s.value ->> 'id', '?'), 100), k.key)
    from jsonb_array_elements(case when jsonb_typeof(p -> 'exercises') = 'array' then p -> 'exercises' else '[]'::jsonb end) e(value)
   cross join lateral jsonb_array_elements(
           case when jsonb_typeof(e.value) = 'object' and jsonb_typeof(e.value -> 'sets') = 'array' then e.value -> 'sets' else '[]'::jsonb end) s(value)
   cross join lateral (values ('weightKg'), ('reps'), ('durationSec'), ('distanceM'), ('rpe'), ('rir')) k(key)
   where jsonb_typeof(s.value) = 'object'
     and s.value ? k.key
     and jsonb_typeof(s.value -> k.key) <> 'null'
     and (case
            when jsonb_typeof(s.value -> k.key) <> 'number' then true
            when ((s.value -> k.key)::text)::numeric < 0 then true
            when k.key = 'reps' and ((s.value -> k.key)::text)::numeric % 1 <> 0 then true
            else false
          end)
   limit 1
$$;

create or replace function private.workout_sessions_validate_sets()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_problem text;
begin
  if new.deleted_at is not null then return new; end if;
  if tg_op = 'UPDATE' and new.payload is not distinct from old.payload then return new; end if;
  v_problem := private.session_payload_problem(new.payload);
  if v_problem is null then return new; end if;
  -- Grandfather rows that were already invalid before this guard existed.
  if tg_op = 'UPDATE' and old.deleted_at is null and private.session_payload_problem(old.payload) is not null then return new; end if;
  raise exception '%', v_problem using errcode = '22023';
end $$;

revoke all on function private.session_payload_problem(jsonb) from public, anon, authenticated;
revoke all on function private.workout_sessions_validate_sets() from public, anon, authenticated;
grant execute on function private.session_payload_problem(jsonb) to service_role;

drop trigger if exists workout_sessions_validate_sets on public.workout_sessions;
create trigger workout_sessions_validate_sets
  before insert or update of payload, deleted_at on public.workout_sessions
  for each row execute function private.workout_sessions_validate_sets();

insert into supabase_migrations.schema_migrations (version, name) values ('20261030000001', 'set_validation') on conflict (version) do nothing;

-- ===================================================== 20261030000002_ai_coach_v2
-- training assistant v2 (2026-10-30): "Why this?" reasoning and a structured this-week schedule action on AI replies.
--
-- Additive only:
--   * ai_messages.why    — optional reasoning shown collapsed under "Why this?" (≤ 4000 chars).
--   * ai_messages.action — optional structured action attached to a reply; today only
--                          {kind:'week_adjustment', …} (an "Apply to this week" schedule change, ≤ 32 KB).
--                          It is applied on the device as date-specific schedule overrides; the plan's content,
--                          frequency, split and version never change (src/domain/program/schedule.ts applyWeekPlan).
--   * private.ai_message_json now returns `why` and `action` (list_ai_messages / ai_get_exchange / record).
--   * public.ai_record_exchange stores p_reply.why / p_reply.action in the same atomic, idempotent insert
--     (same signature; a repeat with the same message id still returns the stored exchange, duplicate = true).
-- Rows written before this migration simply have both columns null.

alter table public.ai_messages
  add column if not exists why text check (why is null or char_length(why) <= 4000),
  add column if not exists action jsonb check (action is null or (jsonb_typeof(action) = 'object' and octet_length(action::text) <= 32768));

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
    'why', m.why,
    'action', m.action,
    'seq', m.seq)
$$;

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
  v_why text;
  v_action jsonb;
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

  -- v2: optional "Why this?" reasoning and a structured this-week action (validated by the function).
  v_why := nullif(btrim(left(p_reply ->> 'why', 4000)), '');
  v_action := case
    when jsonb_typeof(p_reply -> 'action') = 'object' and p_reply -> 'action' ->> 'kind' = 'week_adjustment'
         and octet_length((p_reply -> 'action')::text) <= 32768
      then p_reply -> 'action'
    else null end;

  insert into public.ai_messages (id, user_id, role, content, reply_to, proposal_id, grounding, mode, model, input_tokens, output_tokens,
                                  why, action)
  values (gen_random_uuid(), p_user, 'assistant', left(p_reply ->> 'content', 16000), v_msg_id, v_prop.id,
          case when jsonb_typeof(p_reply -> 'grounding') = 'array' then p_reply -> 'grounding' else '[]'::jsonb end,
          v_mode, left(p_reply ->> 'model', 100),
          private.try_int(p_reply ->> 'inputTokens'), private.try_int(p_reply ->> 'outputTokens'),
          v_why, v_action)
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

/* ============================================================ privileges (re-stated; this file runs after the lockdown) */

revoke all on function private.ai_message_json(public.ai_messages) from public, anon, authenticated;
revoke all on function public.ai_record_exchange(uuid, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.ai_record_exchange(uuid, jsonb, jsonb, jsonb, jsonb) to service_role;

insert into supabase_migrations.schema_migrations (version, name) values ('20261030000002', 'ai_coach_v2') on conflict (version) do nothing;

-- ===================================================== 20261030000003_authz_fixes
-- Backend audit fixes (2026-10-30, repair brief §7). Additive: only `create or replace` of existing RPCs with the
-- same signatures (grants are re-issued below), no table or data changes. Safe to re-run.
--
-- 1. respond_coaching_request
--    a) Lock order. The old body row-locked the request, THEN took the per-client advisory lock, THEN row-locked
--       the client's other requests. Two coaches accepting two pending requests of the same client at the same
--       moment therefore deadlocked (40P01, reproduced in tests/rls/audit.mjs). The advisory lock is now taken
--       first and the request is re-read under it, so concurrent acceptances serialize: the first wins, the
--       second sees "no longer pending" (the first acceptance cancelled it).
--    b) Stale-request guard (defence in depth). Accepting a request may end the client's current coach only when
--       that coach was already active when the client sent this request — the request page warned the client
--       about exactly that switch. If the client's current coaching started AFTER this request was made, the
--       acceptance is refused (hint 'stale_request') instead of silently replacing the newer coach. With 1a this
--       state is not reachable through the API (activation cancels every other pending request in the same
--       transaction); the guard keeps it that way for legacy rows and future code paths.
-- 2. export_my_data: adds the caller's coaching data (as client and as coach) and training assistant data, which the
--    portability export was missing. Only rows the caller owns or authored, or that are about them and already
--    visible to them; nothing from another user's private records.
-- 3. Coach proposal visibility for the client. The client could read any coach proposal whose status was not
--    'draft' — including a draft the coach WITHDREW without ever sending it (withdraw_program_proposal, or
--    close_relationship withdrawing open drafts when coaching ends/switches). Reproduced in tests/rls/audit.mjs.
--    The client now sees a coach proposal only once it was actually sent (sent_at is set by
--    send_program_proposal and kept by every later status). Same rule in the RLS policy and in
--    private.proposal_visible (used by list/get_program_proposal).
--
-- Convention: security definer, search_path = '', EXECUTE revoked from public/anon, granted to authenticated.

/* ============================================================ 1. respond_coaching_request */

create or replace function public.respond_coaching_request(p_id uuid, p_accept boolean, p_message text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  r public.coaching_relationships;
  x public.coaching_relationships;
  v_client uuid;
  v_msg text := nullif(btrim(coalesce(p_message, '')), '');
begin
  if p_accept is null then raise exception 'Choose accept or decline.' using errcode = 'P0001'; end if;
  -- Unlocked read only to find the client (and to reject strangers before taking any lock).
  select client_id into v_client from public.coaching_relationships where id = p_id and coach_id = v_uid;
  if v_client is null then raise exception 'Request not found.' using errcode = 'P0001'; end if;
  -- Same lock as request_coaching: every change to this client's requests/activation is serialized.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('coach-req:' || v_client::text, 0));
  select * into r from public.coaching_relationships where id = p_id for update;
  if r.id is null or r.coach_id <> v_uid then raise exception 'Request not found.' using errcode = 'P0001'; end if;
  if not private.coach_is_active(v_uid) then
    raise exception 'Your coaching account isn''t active, so you can''t respond to requests.' using errcode = '42501';
  end if;
  if r.status = 'active' and p_accept then return private.relationship_json(r, v_uid); end if;
  if r.status = 'declined' and not p_accept then return private.relationship_json(r, v_uid); end if;
  if r.status <> 'requested' then raise exception 'This request is no longer pending.' using errcode = 'P0001'; end if;
  if char_length(v_msg) > 2000 then raise exception 'Your message can be at most 2000 characters.' using errcode = 'P0001'; end if;
  if private.is_blocked_between(r.coach_id, r.client_id) then
    raise exception 'This request is no longer available.' using errcode = 'P0001';
  end if;
  if p_accept then
    if exists (select 1 from public.coaching_relationships a
                where a.client_id = r.client_id and a.status = 'active' and a.id <> r.id
                  and a.responded_at is not null and a.responded_at > r.requested_at) then
      raise exception 'This request is out of date: the person started coaching with someone else after sending it. They can send you a new request.'
        using errcode = 'P0001', hint = 'stale_request';
    end if;
    for x in select * from public.coaching_relationships
              where client_id = r.client_id and status = 'active' and id <> r.id for update loop
      perform private.close_relationship(x.id, 'ended', r.client_id, 'switched coach');
      perform private.coach_notify(x.coach_id, r.client_id, 'coach_ended', x.id, x.coach_id, null);
    end loop;
    for x in select * from public.coaching_relationships
              where client_id = r.client_id and status = 'requested' and id <> r.id for update loop
      perform private.close_relationship(x.id, 'cancelled', r.client_id, 'another coach accepted');
      perform private.coach_notify(x.coach_id, r.client_id, 'coach_request_cancelled', x.id, x.coach_id, null);
    end loop;
    update public.coaching_relationships set status = 'active', responded_at = now(), response_message = v_msg
     where id = p_id returning * into r;
    perform private.coach_notify(r.client_id, v_uid, 'coach_request_accepted', p_id, v_uid, null);
  else
    update public.coaching_relationships set status = 'declined', responded_at = now(), response_message = v_msg
     where id = p_id returning * into r;
    perform private.coach_notify(r.client_id, v_uid, 'coach_request_declined', p_id, v_uid, null);
  end if;
  return private.relationship_json(r, v_uid);
end $$;

/* ============================================================ 2. export_my_data */

create or replace function private.export_coaching_json(p_uid uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'coach_profile', private.coach_profile_json(p_uid), -- null unless the caller applied as a coach
    'coach_review_events', coalesce((select jsonb_agg(private.review_event_json(e, false) order by e.created_at)
                                       from public.coach_review_events e where e.coach_id = p_uid), '[]'::jsonb),
    -- as client: the full relationship incl. the intake + intro the caller wrote and the sharing choices
    'relationships_as_client', coalesce((select jsonb_agg(jsonb_build_object(
          'id', r.id, 'coach_id', r.coach_id,
          'coach_name', (select c.display_name from public.coach_profiles c where c.user_id = r.coach_id),
          'status', r.status, 'intake', r.intake, 'intro_message', r.intro_message,
          'response_message', r.response_message, 'requested_at', r.requested_at, 'responded_at', r.responded_at,
          'ended_at', r.ended_at, 'end_reason', r.end_reason,
          'scopes', (select jsonb_build_object('training', s.training, 'measurements', s.measurements,
                                               'nutrition', s.nutrition, 'checkins', s.checkins, 'updated_at', s.updated_at)
                       from public.coaching_scopes s where s.relationship_id = r.id))
        order by r.requested_at) from public.coaching_relationships r where r.client_id = p_uid), '[]'::jsonb),
    -- as coach: the relationship facts and the coach's own reply; NOT the client's intake (their data)
    'relationships_as_coach', coalesce((select jsonb_agg(jsonb_build_object(
          'id', r.id, 'client_id', r.client_id, 'status', r.status, 'response_message', r.response_message,
          'requested_at', r.requested_at, 'responded_at', r.responded_at, 'ended_at', r.ended_at,
          'end_reason', r.end_reason) order by r.requested_at)
        from public.coaching_relationships r where r.coach_id = p_uid), '[]'::jsonb),
    'messages_sent', coalesce((select jsonb_agg(jsonb_build_object(
          'id', m.id, 'relationship_id', m.relationship_id, 'body', m.body, 'media', m.media, 'status', m.status,
          'shared_from_ai', m.shared_from_ai, 'created_at', m.created_at) order by m.created_at, m.seq)
        from public.coach_messages m where m.sender_id = p_uid), '[]'::jsonb),
    'checkins_submitted', coalesce((select jsonb_agg(private.checkin_json(k) order by k.created_at)
                                      from public.coach_checkins k where k.client_id = p_uid), '[]'::jsonb),
    'checkin_responses_written', coalesce((select jsonb_agg(jsonb_build_object(
          'id', k.id, 'relationship_id', k.relationship_id, 'coach_response', k.coach_response, 'reviewed_at', k.reviewed_at)
          order by k.created_at)
        from public.coach_checkins k where k.coach_id = p_uid and k.coach_response is not null), '[]'::jsonb),
    'feedback_received', coalesce((select jsonb_agg(jsonb_build_object(
          'id', f.id, 'relationship_id', f.relationship_id, 'session_id', f.session_id, 'body', f.body,
          'created_at', f.created_at) order by f.created_at)
        from public.coach_feedback f where f.client_id = p_uid), '[]'::jsonb),
    'feedback_written', coalesce((select jsonb_agg(jsonb_build_object(
          'id', f.id, 'relationship_id', f.relationship_id, 'session_id', f.session_id, 'body', f.body,
          'created_at', f.created_at) order by f.created_at)
        from public.coach_feedback f where f.coach_id = p_uid), '[]'::jsonb),
    -- coach proposals the caller received (never another coach's unsent drafts) or authored (incl. drafts)
    'proposals_received', coalesce((select jsonb_agg(private.proposal_json(pp) order by pp.created_at)
                                      from public.program_proposals pp
                                     where pp.author_kind = 'coach' and pp.client_id = p_uid and pp.status <> 'draft'
                                       and pp.sent_at is not null), '[]'::jsonb),
    'proposals_authored', coalesce((select jsonb_agg(private.proposal_json(pp) order by pp.created_at)
                                      from public.program_proposals pp
                                     where pp.author_kind = 'coach' and pp.coach_id = p_uid), '[]'::jsonb),
    'reports_filed', coalesce((select jsonb_agg(jsonb_build_object(
          'id', x.id, 'relationship_id', x.relationship_id, 'message_id', x.message_id, 'reason', x.reason,
          'details', x.details, 'status', x.status, 'created_at', x.created_at) order by x.created_at)
        from public.coaching_reports x where x.reporter_id = p_uid), '[]'::jsonb))
$$;

-- to_jsonb(row) on purpose: columns added to the AI tables later are exported automatically.
create or replace function private.export_ai_json(p_uid uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'settings', (select to_jsonb(s) - 'user_id' from public.ai_settings s where s.user_id = p_uid),
    'messages', coalesce((select jsonb_agg(to_jsonb(m) - 'user_id' order by m.seq)
                            from public.ai_messages m where m.user_id = p_uid), '[]'::jsonb),
    'usage', coalesce((select jsonb_agg(to_jsonb(u) - 'user_id' order by u.day)
                         from public.ai_usage u where u.user_id = p_uid), '[]'::jsonb),
    'proposals', coalesce((select jsonb_agg(private.ai_proposal_json(pp) order by pp.created_at)
                             from public.program_proposals pp where pp.author_kind = 'ai' and pp.client_id = p_uid), '[]'::jsonb))
$$;

-- Everything the caller owns, as JSON (personal data export / portability). Version 2 = version 1 + coaching,
-- ai and social reports filed.
create or replace function public.export_my_data() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid(); v_out jsonb := jsonb_build_object('format', 'liftcircle-server-export', 'version', 2,
          'exported_at', now(), 'note', 'Structured data only. Photo files and documents are not included.');
        v_part jsonb; t text;
begin
  foreach t in array array['account_state','programs','templates','workout_sessions','activities','activity_templates',
                           'measurements','goals','custom_exercises','custom_foods','food_logs','saved_meals','meal_plans'] loop
    execute format('select coalesce(jsonb_agg(payload order by version), ''[]''::jsonb) from public.%I where owner_id = $1 and deleted_at is null', t)
      into v_part using v_uid;
    v_out := v_out || jsonb_build_object(t, v_part);
  end loop;
  v_out := v_out || jsonb_build_object(
    'profile', private.profile_json(v_uid),
    'posts', coalesce((select jsonb_agg(private.post_json(p, v_uid) order by p.created_at) from public.posts p
                        where p.author_id = v_uid and p.deleted_at is null), '[]'::jsonb),
    'comments', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'post_id', c.post_id, 'body', c.body, 'created_at', c.created_at))
                           from public.comments c where c.author_id = v_uid and c.deleted_at is null), '[]'::jsonb),
    'likes', coalesce((select jsonb_agg(jsonb_build_object('post_id', l.post_id, 'created_at', l.created_at))
                        from public.likes l where l.user_id = v_uid), '[]'::jsonb),
    'friends', public.list_friends(),
    'reports_filed', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'target_kind', x.target_kind, 'post_id', x.post_id,
                                                                   'comment_id', x.comment_id, 'user_id', x.user_id,
                                                                   'reason', x.reason, 'details', x.details, 'status', x.status,
                                                                   'created_at', x.created_at) order by x.created_at)
                                 from public.reports x where x.reporter_id = v_uid), '[]'::jsonb),
    'coaching', private.export_coaching_json(v_uid),
    'ai', private.export_ai_json(v_uid));
  return v_out;
end $$;

/* ============================================================ 3. never-sent coach drafts stay private */

create or replace function private.proposal_visible(pp public.program_proposals, p_viewer uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_viewer is not null and (
    (pp.client_id = p_viewer and (pp.author_kind = 'ai' or (pp.status <> 'draft' and pp.sent_at is not null)))
    or (pp.author_kind = 'coach' and pp.coach_id = p_viewer and private.coach_is_active(p_viewer)
        and private.is_relationship_participant(pp.relationship_id, p_viewer, false)))
$$;

alter policy "client reads sent coach proposals and own ai proposals; active coach reads own" on public.program_proposals
  using ((client_id = (select auth.uid()) and (author_kind = 'ai' or (status <> 'draft' and sent_at is not null)))
         or (author_kind = 'coach' and coach_id = (select auth.uid()) and private.coach_is_active((select auth.uid()))));

/* =================================================================== grants */

do $$
begin
  revoke all on function public.respond_coaching_request(uuid, boolean, text) from public, anon;
  grant execute on function public.respond_coaching_request(uuid, boolean, text) to authenticated;
  revoke all on function public.export_my_data() from public, anon;
  grant execute on function public.export_my_data() to authenticated;
  -- private helpers: only called from the definer RPC above (runs as owner) → no API role needs EXECUTE
  revoke all on function private.export_coaching_json(uuid) from public, anon, authenticated;
  revoke all on function private.export_ai_json(uuid) from public, anon, authenticated;
end $$;

insert into supabase_migrations.schema_migrations (version, name) values ('20261030000003', 'authz_fixes') on conflict (version) do nothing;

-- ===================================================== 20261030000004_public_coach_preview
-- Public (signed-out) preview of the coach directory. Additive: no tables, columns or policies change.
--
-- Why: guests should be able to see what human coaching offers before creating an account.
-- What anon can read: ONLY the public listing fields of coaches that are approved, not suspended and listed —
-- display name, bio, specialties, goals, languages, business city/region/country, formats, accepting-clients,
-- service-area labels (id/city/region/country/radius; NO coordinates), experience text/years, reviewed
-- qualifications (title/issuer/year) and the approval date. Never: photos (the coach-public storage policy
-- stays signed-in only), coordinates or distances, application status/notes, documents, review history,
-- relationships, messages, or anything about the viewer. Requests, messages and all private data keep
-- requiring an account (request_coaching etc. still call private.require_uid()).
--
-- Abuse limits: text filters only (no coordinate search, so service-area coordinates can't be triangulated),
-- at most 20 results per call and no paging beyond 200 results; both functions are STABLE and cheap.
-- Blocks can't apply to a signed-out viewer; a blocked member who signs out sees only this public listing,
-- and every action on it still needs an account where blocks are enforced.

create or replace function public.public_search_coaches(p jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  q jsonb := case when jsonb_typeof(p) = 'object' then p else '{}'::jsonb end;
  v_city text := private.fold_text(left(q ->> 'city', 120));
  v_region text := private.fold_text(left(q ->> 'region', 120));
  v_country text := upper(nullif(btrim(coalesce(left(q ->> 'country', 8), '')), ''));
  v_format text := coalesce(nullif(q ->> 'format', ''), 'any');
  v_specialty text := private.fold_text(left(q ->> 'specialty', 80));
  v_goal text := private.fold_text(left(q ->> 'goal', 80));
  v_language text := lower(nullif(btrim(coalesce(left(q ->> 'language', 8), '')), ''));
  v_accepting boolean := coalesce(private.try_bool(q ->> 'acceptingOnly'), false);
  v_limit integer := least(greatest(coalesce(private.try_int(q ->> 'limit'), 20), 1), 20);
  v_offset integer := least(greatest(coalesce(private.try_int(q ->> 'offset'), 0), 0), 200);
  v_has_place boolean;
  v_out jsonb;
begin
  if v_country is not null and v_country !~ '^[A-Z]{2}$' then v_country := null; end if;
  if v_format not in ('any', 'in_person', 'online') then v_format := 'any'; end if;
  v_has_place := v_city is not null or v_region is not null or v_country is not null;

  with base as (
    select c.* from public.coach_profiles c
     where c.status = 'approved' and not c.suspended and c.listed
       and (not v_accepting or c.accepting_clients)
       and (v_specialty is null or exists (select 1 from unnest(c.specialties) s where private.fold_text(s) = v_specialty))
       and (v_goal is null or exists (select 1 from unnest(c.goals) g where private.fold_text(g) = v_goal))
       and (v_language is null or v_language = any (c.languages))
       and (v_format = 'any' or v_format = any (c.formats))
  ),
  areas as (
    select a.coach_id, a.kind, a.city, a.region, a.country
      from public.coach_service_areas a join base b on b.user_id = a.coach_id
    union all
    select b.user_id, 'city', b.city, b.region, b.country
      from base b where b.city is not null or b.region is not null or b.country is not null
  ),
  local_match as (
    select distinct a.coach_id
      from areas a join base b on b.user_id = a.coach_id
     where v_has_place and 'in_person' = any (b.formats)
       and private.area_text_match(a.kind, a.city, a.region, a.country, v_city, v_region, v_country)
  ),
  results as (
    -- same grouping as the signed-in search_coaches: local in-person matches first, then online coaches
    select b.user_id, b.display_name, 0 as grp from base b join local_match l on l.coach_id = b.user_id
    union all
    select b.user_id, b.display_name, 1 from base b
     where 'online' = any (b.formats) and v_format <> 'in_person'
       and not exists (select 1 from local_match l where l.coach_id = b.user_id)
       and (v_country is null or v_language is not null or b.country = v_country
            or exists (select 1 from public.coach_service_areas a where a.coach_id = b.user_id and a.country = v_country))
  ),
  ranked as (
    select r.*, row_number() over (order by r.grp, lower(r.display_name), r.user_id) as n from results r
  ),
  page as (
    select * from ranked order by n limit v_limit + 1 offset v_offset
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object(
                 'user_id', c.user_id, 'display_name', c.display_name, 'bio', c.bio,
                 'specialties', to_jsonb(c.specialties), 'goals', to_jsonb(c.goals), 'languages', to_jsonb(c.languages),
                 'city', c.city, 'region', c.region, 'country', c.country, 'formats', to_jsonb(c.formats),
                 'accepting_clients', c.accepting_clients,
                 'service_areas', coalesce((select jsonb_agg(jsonb_build_object(
                                     'id', a.id, 'kind', a.kind, 'city', a.city, 'region', a.region, 'country', a.country,
                                     'radius_km', a.radius_km, 'label', a.label) order by a.position, a.created_at, a.id)
                                    from public.coach_service_areas a where a.coach_id = c.user_id), '[]'::jsonb),
                 'match', case when pg.grp = 0 then 'local' else 'remote' end)
               order by pg.n)
             from page pg join public.coach_profiles c on c.user_id = pg.user_id
            where pg.n <= v_offset + v_limit), '[]'::jsonb),
    'has_more', (select count(*) from page) > v_limit and v_offset + v_limit < 200)
    into v_out;
  return v_out;
end $$;

create or replace function public.public_get_coach(p_coach uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.coach_profiles;
begin
  if p_coach is null then return null; end if;
  select * into c from public.coach_profiles
   where user_id = p_coach and status = 'approved' and not suspended and listed;
  if c.user_id is null then return null; end if;
  return jsonb_build_object(
    'user_id', c.user_id, 'display_name', c.display_name, 'bio', c.bio,
    'specialties', to_jsonb(c.specialties), 'goals', to_jsonb(c.goals), 'languages', to_jsonb(c.languages),
    'city', c.city, 'region', c.region, 'country', c.country, 'formats', to_jsonb(c.formats),
    'accepting_clients', c.accepting_clients,
    'service_areas', coalesce((select jsonb_agg(jsonb_build_object(
                        'id', a.id, 'kind', a.kind, 'city', a.city, 'region', a.region, 'country', a.country,
                        'radius_km', a.radius_km, 'label', a.label) order by a.position, a.created_at, a.id)
                       from public.coach_service_areas a where a.coach_id = c.user_id), '[]'::jsonb),
    'match', case when 'in_person' = any (c.formats) then 'local' else 'remote' end,
    'experience_years', c.experience_years, 'experience', c.experience,
    'approved_qualifications', private.coach_quals_json(c.user_id, true),
    'approved_since', c.approved_at);
end $$;

revoke all on function public.public_search_coaches(jsonb) from public;
revoke all on function public.public_get_coach(uuid) from public;
grant execute on function public.public_search_coaches(jsonb), public.public_get_coach(uuid) to anon, authenticated, service_role;

insert into supabase_migrations.schema_migrations (version, name) values ('20261030000004', 'public_coach_preview') on conflict (version) do nothing;
commit;
