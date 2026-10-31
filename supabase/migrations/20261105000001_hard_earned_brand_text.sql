-- Hard Earned rebrand (v1.0.0): user-visible text produced by the database.
-- Additive: re-creates four functions with their exact previous bodies except for the brand strings below. No schema,
-- data, grant, policy, bucket, cron or identifier changes (create or replace keeps existing grants).
--   private.relationship_json          fallback client name → 'Hard Earned member'
--   private.review_event_json          reviewer name shown to applicants → 'Hard Earned review team'
--   public.send_test_push              test notification title → 'Hard Earned'; body without the exclamation/emoji
--   private.push_enqueue_notification  coaching/social push title → 'Hard Earned'
-- Kept on purpose (durable identifiers, see docs/BRAND_AUDIT.md): the push tag default in private.push_valid_payload
-- (the device tag scheme), the push cron job name, storage policy names and the server export format id.

-- relationship_json
create or replace function private.relationship_json(r public.coaching_relationships, p_viewer uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', r.id, 'coach_id', r.coach_id, 'client_id', r.client_id,
    'coach', jsonb_build_object('user_id', c.user_id, 'display_name', c.display_name, 'photo_path', c.photo_path,
                                'suspended', c.suspended, 'approved', c.status = 'approved'),
    'client', jsonb_build_object('user_id', r.client_id, 'display_name', coalesce(pr.display_name, 'Hard Earned member'),
                                 'avatar_path', pr.avatar_path),
    'status', r.status,
    -- a suspended coach loses access to the client's intake as well
    'intake', case when hide then '{}'::jsonb else r.intake end,
    'intro_message', case when hide then '' else r.intro_message end,
    'response_message', r.response_message,
    'scopes', jsonb_build_object('training', coalesce(s.training, false), 'measurements', coalesce(s.measurements, false),
                                 'nutrition', coalesce(s.nutrition, false), 'checkins', coalesce(s.checkins, false)),
    'requested_at', r.requested_at, 'responded_at', r.responded_at, 'ended_at', r.ended_at,
    'ended_by', r.ended_by, 'end_reason', r.end_reason,
    'unread', private.relationship_unread(r.id, p_viewer),
    'viewer_is_coach', r.coach_id = p_viewer)
    from public.coach_profiles c
    left join public.profiles pr on pr.id = r.client_id
    left join public.coaching_scopes s on s.relationship_id = r.id
    cross join lateral (select (p_viewer = r.coach_id and c.suspended) as hide) h
   where c.user_id = r.coach_id
$$;

-- review_event_json
create or replace function private.review_event_json(e public.coach_review_events, p_admin_view boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', e.id, 'coach_id', e.coach_id, 'actor_id', e.actor_id,
    'actor_name', case when e.actor_id = e.coach_id then null
                       when p_admin_view then coalesce((select p.display_name from public.profiles p where p.id = e.actor_id), 'Admin')
                       else 'Hard Earned review team' end,
    'action', e.action, 'reason', e.reason, 'qualification_id', e.qualification_id,
    'from_status', e.from_status, 'to_status', e.to_status, 'created_at', e.created_at)
$$;

-- send_test_push
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
  values (v_uid, 'test', now(), jsonb_build_object('title', 'Hard Earned', 'body', 'Notifications are working.', 'url', '/settings', 'tag', 'test'), v_key);
  return jsonb_build_object('queued', true, 'dedupeKey', v_key);
end $$;

-- push_enqueue_notification
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
  v_title := 'Hard Earned';
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
