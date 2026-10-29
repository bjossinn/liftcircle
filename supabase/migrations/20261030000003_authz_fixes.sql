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
-- 2. export_my_data: adds the caller's coaching data (as client and as coach) and AI coach data, which the
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
