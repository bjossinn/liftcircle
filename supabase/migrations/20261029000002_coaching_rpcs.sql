-- Coaching RPCs. Same rules as the social RPCs:
--   * security definer, search_path = '' (every name schema-qualified),
--   * the caller comes from auth.uid() (client_id / coach_id / sender_id are never client-supplied),
--   * authorization is re-checked against CURRENT rows on every call (suspension, revocation, ending and
--     blocking take effect for the very next request — including queued offline writes),
--   * user-readable errors: P0001 validation, 42501 not allowed, PT429 rate limit,
--   * EXECUTE revoked from public/anon, granted to authenticated (service-only RPCs: service_role).

/* ================================================================ helpers */

create or replace function private.require_admin() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid();
begin
  if not private.is_admin(v_uid) then
    raise exception 'Only admins can do this.' using errcode = '42501';
  end if;
  return v_uid;
end $$;

-- Distinct, trimmed, non-empty strings from a JSON array (first spelling wins), with limits.
create or replace function private.clean_text_array(j jsonb, p_max_n integer, p_max_len integer, p_what text) returns text[]
language plpgsql immutable set search_path = '' as $$
declare v text[];
begin
  if j is null or jsonb_typeof(j) = 'null' then return '{}'; end if;
  if jsonb_typeof(j) <> 'array' then
    raise exception '% must be a list.', p_what using errcode = 'P0001';
  end if;
  select coalesce(array_agg(x order by o), '{}') into v
    from (select distinct on (lower(btrim(e))) btrim(e) as x, o
            from jsonb_array_elements_text(j) with ordinality t(e, o)
           where btrim(e) <> '' order by lower(btrim(e)), o) s;
  if cardinality(v) > p_max_n then
    raise exception 'Choose at most % %.', p_max_n, p_what using errcode = 'P0001';
  end if;
  if exists (select 1 from unnest(v) x where char_length(x) > p_max_len) then
    raise exception 'Each of your % can be at most % characters.', p_what, p_max_len using errcode = 'P0001';
  end if;
  return v;
end $$;

-- Coaching notifications: never self, never across a block, never to an account without a social
-- profile (notifications.recipient_id → profiles), respect settings.notifications.coaching (default on).
-- They NEVER carry message text — only ids.
create or replace function private.coach_notify(p_recipient uuid, p_actor uuid, p_type text, p_relationship uuid,
                                                p_coach uuid, p_proposal uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := p_actor;
begin
  if p_recipient is null then return; end if;
  if v_actor = p_recipient then v_actor := null; end if;
  if not exists (select 1 from public.profiles where id = p_recipient) then return; end if;
  if v_actor is not null and private.is_blocked_between(p_recipient, v_actor) then return; end if;
  if v_actor is not null and not exists (select 1 from public.profiles where id = v_actor) then v_actor := null; end if;
  if coalesce((select private.try_bool(a.payload #>> '{settings,notifications,coaching}')
                 from public.account_state a where a.owner_id = p_recipient and a.deleted_at is null), true) = false then
    return;
  end if;
  if p_type = 'coach_message' then
    -- one unread "new messages" notification per conversation; newer messages just bump it
    update public.notifications n set created_at = now()
     where n.recipient_id = p_recipient and n.type = 'coach_message' and n.relationship_id = p_relationship and n.read_at is null;
    if found then return; end if;
  end if;
  insert into public.notifications (recipient_id, actor_id, type, relationship_id, coach_id, proposal_id)
  values (p_recipient, v_actor, p_type, p_relationship, p_coach, p_proposal);
end $$;

create or replace function private.coach_areas_json(p_coach uuid, p_public boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', a.id, 'kind', a.kind, 'city', a.city, 'region', a.region, 'country', a.country,
           -- the directory publishes coordinates at ≈1 km precision only
           'lat', case when p_public then round(a.lat, 2) else round(a.lat, 3) end,
           'lng', case when p_public then round(a.lng, 2) else round(a.lng, 3) end,
           'radius_km', a.radius_km, 'label', a.label) order by a.position, a.created_at, a.id), '[]'::jsonb)
    from public.coach_service_areas a where a.coach_id = p_coach
$$;

create or replace function private.coach_quals_json(p_coach uuid, p_public boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(case when p_public
           then jsonb_build_object('id', q.id, 'title', q.title, 'issuer', q.issuer, 'year', q.year)
           else jsonb_build_object('id', q.id, 'title', q.title, 'issuer', q.issuer, 'year', q.year,
                                   'document_path', q.document_path, 'document_name', q.document_name,
                                   'review_status', q.review_status, 'review_note', q.review_note,
                                   'reviewed_at', q.reviewed_at) end
           order by q.position, q.created_at, q.id), '[]'::jsonb)
    from public.coach_qualifications q
   where q.coach_id = p_coach and (not p_public or q.review_status = 'approved')
$$;

-- Applicant / admin view (includes private columns).
create or replace function private.coach_profile_json(p_coach uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'user_id', c.user_id, 'display_name', c.display_name, 'photo_path', c.photo_path, 'bio', c.bio,
    'experience_years', c.experience_years, 'experience', c.experience,
    'specialties', to_jsonb(c.specialties), 'goals', to_jsonb(c.goals), 'languages', to_jsonb(c.languages),
    'city', c.city, 'region', c.region, 'country', c.country, 'formats', to_jsonb(c.formats),
    'accepting_clients', c.accepting_clients, 'listed', c.listed, 'status', c.status,
    'suspended', c.suspended, 'suspended_reason', c.suspended_reason, 'suspended_at', c.suspended_at,
    'submitted_at', c.submitted_at, 'reviewed_at', c.reviewed_at, 'approved_at', c.approved_at,
    'latest_feedback', c.latest_feedback, 'created_at', c.created_at, 'updated_at', c.updated_at,
    'service_areas', private.coach_areas_json(c.user_id, false),
    'qualifications', private.coach_quals_json(c.user_id, false))
    from public.coach_profiles c where c.user_id = p_coach
$$;

-- Public directory card (NO private columns: documents, suspension, feedback, review state).
create or replace function private.coach_card_json(c public.coach_profiles, p_match text, p_distance double precision)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'user_id', c.user_id, 'display_name', c.display_name, 'photo_path', c.photo_path, 'bio', c.bio,
    'specialties', to_jsonb(c.specialties), 'goals', to_jsonb(c.goals), 'languages', to_jsonb(c.languages),
    'city', c.city, 'region', c.region, 'country', c.country, 'formats', to_jsonb(c.formats),
    'accepting_clients', c.accepting_clients,
    'service_areas', private.coach_areas_json(c.user_id, true),
    'match', p_match,
    'distance_km', case when p_distance is null then null else greatest(1, round(p_distance))::integer end)
$$;

create or replace function private.relationship_unread(p_rel uuid, p_viewer uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select case when not private.is_relationship_participant(p_rel, p_viewer, false) then 0 else (
    select count(*)::integer from public.coach_messages m
     where m.relationship_id = p_rel and m.sender_id <> p_viewer and m.status = 'sent'
       and m.seq > coalesce((select k.last_read_seq from public.coach_message_reads k
                              where k.relationship_id = p_rel and k.user_id = p_viewer), 0)) end
$$;

create or replace function private.relationship_json(r public.coaching_relationships, p_viewer uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', r.id, 'coach_id', r.coach_id, 'client_id', r.client_id,
    'coach', jsonb_build_object('user_id', c.user_id, 'display_name', c.display_name, 'photo_path', c.photo_path,
                                'suspended', c.suspended, 'approved', c.status = 'approved'),
    'client', jsonb_build_object('user_id', r.client_id, 'display_name', coalesce(pr.display_name, 'LiftCircle member'),
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

create or replace function private.proposal_json(pp public.program_proposals) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', pp.id, 'author_kind', pp.author_kind, 'relationship_id', pp.relationship_id, 'coach_id', pp.coach_id,
    'client_id', pp.client_id, 'status', pp.status, 'base_program_id', pp.base_program_id, 'base_version', pp.base_version,
    'revision', pp.revision, 'program', pp.program, 'change_summary', pp.change_summary, 'message', pp.message,
    'effective_date', pp.effective_date, 'target', pp.target, 'validation_errors', pp.validation_errors,
    'created_at', pp.created_at, 'sent_at', pp.sent_at, 'responded_at', pp.responded_at,
    'applied_program_id', pp.applied_program_id, 'applied_version', pp.applied_version)
$$;

create or replace function private.message_json(m public.coach_messages) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', m.id, 'relationship_id', m.relationship_id, 'sender_id', m.sender_id, 'body', m.body,
                            'media', m.media, 'status', m.status, 'shared_from_ai', m.shared_from_ai, 'seq', m.seq,
                            'created_at', m.created_at)
$$;

create or replace function private.checkin_json(k public.coach_checkins) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', k.id, 'relationship_id', k.relationship_id, 'client_id', k.client_id,
                            'created_at', k.created_at, 'answers', k.answers, 'note', k.note,
                            'coach_response', k.coach_response, 'reviewed_at', k.reviewed_at)
$$;

create or replace function private.review_event_json(e public.coach_review_events, p_admin_view boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', e.id, 'coach_id', e.coach_id, 'actor_id', e.actor_id,
    'actor_name', case when e.actor_id = e.coach_id then null
                       when p_admin_view then coalesce((select p.display_name from public.profiles p where p.id = e.actor_id), 'Admin')
                       else 'LiftCircle review team' end,
    'action', e.action, 'reason', e.reason, 'qualification_id', e.qualification_id,
    'from_status', e.from_status, 'to_status', e.to_status, 'created_at', e.created_at)
$$;

-- Ends / cancels a relationship and withdraws its open proposals. Caller handles authorization + notifications.
create or replace function private.close_relationship(p_rel uuid, p_status text, p_by uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.coaching_relationships
     set status = p_status, ended_at = now(), ended_by = p_by, end_reason = p_reason
   where id = p_rel;
  update public.program_proposals set status = 'withdrawn', updated_at = now()
   where relationship_id = p_rel and status in ('draft', 'sent');
end $$;

/* ================================================================== roles */

create or replace function public.my_roles() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid();
begin
  return jsonb_build_object('admin', private.is_admin(v_uid), 'moderator', private.is_moderator(v_uid));
end $$;

/* ===================================================== applicant profile */

create or replace function public.get_my_coach_profile() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  return private.coach_profile_json(private.require_uid());
end $$;

-- Saves the applicant-editable fields in ANY state. Ignores status/suspension/review fields entirely.
-- Changed qualification claims go back to 'pending' (trigger) and are logged.
create or replace function public.save_my_coach_profile(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_status text;
  v_display text; v_bio text; v_exp text; v_years integer; v_city text; v_region text; v_country text;
  v_spec text[]; v_goals text[]; v_langs text[]; v_formats text[]; v_photo text;
  v_areas jsonb; v_quals jsonb; e jsonb; o bigint;
  v_area_ids uuid[] := '{}'; v_qual_ids uuid[] := '{}';
  v_id uuid; v_kind text; v_lat numeric; v_lng numeric; v_ac text; v_acity text; v_aregion text; v_radius integer; v_src text;
  v_old public.coach_qualifications; v_title text; v_issuer text; v_year integer; v_doc text; v_docname text;
  v_claims_changed boolean := false;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'Invalid coach profile.' using errcode = 'P0001';
  end if;
  perform private.enforce_rate_limit(v_uid, 'coach_profile_save', 120, interval '1 hour',
                                     'You''re saving your coach profile very often. Please wait a few minutes.');

  v_display := btrim(coalesce(p ->> 'displayName', ''));
  v_bio := btrim(coalesce(p ->> 'bio', ''));
  v_exp := btrim(coalesce(p ->> 'experience', ''));
  v_years := private.try_int(p ->> 'experienceYears');
  v_city := nullif(btrim(coalesce(p ->> 'city', '')), '');
  v_region := nullif(btrim(coalesce(p ->> 'region', '')), '');
  v_country := upper(nullif(btrim(coalesce(p ->> 'country', '')), ''));
  v_photo := nullif(btrim(coalesce(p ->> 'photoPath', '')), '');
  if char_length(v_display) > 80 then raise exception 'Display name can be at most 80 characters.' using errcode = 'P0001'; end if;
  if char_length(v_bio) > 2000 then raise exception 'Bio can be at most 2000 characters.' using errcode = 'P0001'; end if;
  if char_length(v_exp) > 4000 then raise exception 'Experience can be at most 4000 characters.' using errcode = 'P0001'; end if;
  if v_years is not null and v_years not between 0 and 80 then
    raise exception 'Years of experience must be between 0 and 80.' using errcode = 'P0001';
  end if;
  if char_length(v_city) > 100 or char_length(v_region) > 100 then
    raise exception 'City and region can be at most 100 characters.' using errcode = 'P0001';
  end if;
  if v_country is not null and v_country !~ '^[A-Z]{2}$' then
    raise exception 'Country must be a two-letter country code.' using errcode = 'P0001';
  end if;
  if v_photo is not null and v_photo !~ ('^' || v_uid::text || '/photo_[0-9a-f-]{36}\.jpg$') then
    raise exception 'Invalid photo path.' using errcode = 'P0001';
  end if;
  v_spec := private.clean_text_array(p -> 'specialties', 15, 50, 'specialties');
  v_goals := private.clean_text_array(p -> 'goals', 15, 50, 'goals');
  v_langs := (select coalesce(array_agg(lower(x)), '{}') from unnest(private.clean_text_array(p -> 'languages', 10, 3, 'languages')) x);
  if exists (select 1 from unnest(v_langs) x where x !~ '^[a-z]{2,3}$') then
    raise exception 'Languages must be ISO language codes such as "en" or "is".' using errcode = 'P0001';
  end if;
  v_formats := private.clean_text_array(p -> 'formats', 2, 20, 'formats');
  if not v_formats <@ array['in_person', 'online']::text[] then
    raise exception 'Formats must be in_person and/or online.' using errcode = 'P0001';
  end if;

  insert into public.coach_profiles as c (user_id, display_name, photo_path, bio, experience_years, experience, specialties,
                                          goals, languages, city, region, country, formats, accepting_clients, listed)
  values (v_uid, v_display, v_photo, v_bio, v_years, v_exp, v_spec, v_goals, v_langs, v_city, v_region, v_country, v_formats,
          coalesce(private.try_bool(p ->> 'acceptingClients'), false), coalesce(private.try_bool(p ->> 'listed'), false))
  on conflict (user_id) do update
    set display_name = excluded.display_name, photo_path = excluded.photo_path, bio = excluded.bio,
        experience_years = excluded.experience_years, experience = excluded.experience, specialties = excluded.specialties,
        goals = excluded.goals, languages = excluded.languages, city = excluded.city, region = excluded.region,
        country = excluded.country, formats = excluded.formats, accepting_clients = excluded.accepting_clients,
        listed = excluded.listed;
  select status into v_status from public.coach_profiles where user_id = v_uid;

  /* ---- service areas (replace set; ids kept when supplied) */
  v_areas := coalesce(p -> 'serviceAreas', '[]'::jsonb);
  if jsonb_typeof(v_areas) <> 'array' then raise exception 'Service areas must be a list.' using errcode = 'P0001'; end if;
  if jsonb_array_length(v_areas) > 20 then raise exception 'Add at most 20 service areas.' using errcode = 'P0001'; end if;
  for e, o in select x.value, x.ord from jsonb_array_elements(v_areas) with ordinality x(value, ord) loop
    if jsonb_typeof(e) <> 'object' then raise exception 'Invalid service area.' using errcode = 'P0001'; end if;
    v_id := private.try_uuid(e ->> 'id');
    if v_id is not null and exists (select 1 from public.coach_service_areas a where a.id = v_id and a.coach_id <> v_uid) then
      v_id := null;
    end if;
    v_id := coalesce(v_id, gen_random_uuid());
    v_acity := nullif(btrim(coalesce(e ->> 'city', '')), '');
    v_aregion := nullif(btrim(coalesce(e ->> 'region', '')), '');
    v_ac := upper(nullif(btrim(coalesce(e ->> 'country', '')), ''));
    v_kind := coalesce(nullif(e ->> 'kind', ''), case when v_acity is not null then 'city' when v_aregion is not null then 'region' else 'country' end);
    if v_kind not in ('city', 'region', 'country') then raise exception 'Unknown service area kind.' using errcode = 'P0001'; end if;
    if v_ac is null or v_ac !~ '^[A-Z]{2}$' then
      raise exception 'Each service area needs a two-letter country code.' using errcode = 'P0001';
    end if;
    if (v_kind = 'city' and v_acity is null) or (v_kind = 'region' and v_aregion is null) then
      raise exception 'A % service area needs a % name.', v_kind, v_kind using errcode = 'P0001';
    end if;
    if char_length(v_acity) > 100 or char_length(v_aregion) > 100 or char_length(e ->> 'label') > 200 then
      raise exception 'Service area names are too long.' using errcode = 'P0001';
    end if;
    v_lat := round(private.try_num(e ->> 'lat'), 3);
    v_lng := round(private.try_num(e ->> 'lng'), 3);
    if (v_lat is null) <> (v_lng is null) or v_lat not between -90 and 90 or v_lng not between -180 and 180 then
      raise exception 'Invalid service area coordinates.' using errcode = 'P0001';
    end if;
    v_radius := private.try_int(e ->> 'radiusKm');
    if v_radius is not null and v_radius not between 1 and 500 then
      raise exception 'Travel radius must be between 1 and 500 km.' using errcode = 'P0001';
    end if;
    -- Coordinates are only accepted as geocoder results (the client takes them from the geocode function).
    v_src := case when v_lat is not null then coalesce(nullif(e ->> 'geoSource', ''), 'geocoder') end;
    if v_src is not null and v_src !~ '^geocoder(:[a-z0-9_-]{1,30})?$' then
      raise exception 'Invalid coordinate source.' using errcode = 'P0001';
    end if;
    insert into public.coach_service_areas as a (id, coach_id, position, kind, city, region, country, lat, lng, radius_km, label, geo_source)
    values (v_id, v_uid, o::integer, v_kind, v_acity, v_aregion, v_ac, v_lat, v_lng, v_radius,
            nullif(btrim(coalesce(e ->> 'label', '')), ''), v_src)
    on conflict (id) do update
      set position = excluded.position, kind = excluded.kind, city = excluded.city, region = excluded.region,
          country = excluded.country, lat = excluded.lat, lng = excluded.lng, radius_km = excluded.radius_km,
          label = excluded.label, geo_source = excluded.geo_source
      where a.coach_id = v_uid;
    v_area_ids := v_area_ids || v_id;
  end loop;
  delete from public.coach_service_areas where coach_id = v_uid and id <> all (v_area_ids);

  /* ---- qualification claims */
  v_quals := coalesce(p -> 'qualifications', '[]'::jsonb);
  if jsonb_typeof(v_quals) <> 'array' then raise exception 'Qualifications must be a list.' using errcode = 'P0001'; end if;
  if jsonb_array_length(v_quals) > 20 then raise exception 'Add at most 20 qualifications.' using errcode = 'P0001'; end if;
  for e, o in select x.value, x.ord from jsonb_array_elements(v_quals) with ordinality x(value, ord) loop
    v_id := private.try_uuid(e ->> 'id');
    if v_id is null then raise exception 'Each qualification needs an id.' using errcode = 'P0001'; end if;
    select * into v_old from public.coach_qualifications where id = v_id;
    if v_old.id is not null and v_old.coach_id <> v_uid then
      raise exception 'Qualification not found.' using errcode = 'P0001';
    end if;
    v_title := btrim(coalesce(e ->> 'title', ''));
    v_issuer := nullif(btrim(coalesce(e ->> 'issuer', '')), '');
    v_year := private.try_int(e ->> 'year');
    v_doc := nullif(btrim(coalesce(e ->> 'documentPath', '')), '');
    v_docname := nullif(btrim(coalesce(e ->> 'documentName', '')), '');
    if char_length(v_title) not between 1 and 200 or char_length(v_issuer) > 200 or char_length(v_docname) > 200 then
      raise exception 'Each qualification needs a title (at most 200 characters).' using errcode = 'P0001';
    end if;
    if v_year is not null and v_year not between 1950 and extract(year from now())::integer + 1 then
      raise exception 'Invalid qualification year.' using errcode = 'P0001';
    end if;
    if v_doc is not null and v_doc !~ ('^' || v_uid::text || '/' || v_id::text || '/[^/]{1,200}$') then
      raise exception 'Invalid document path.' using errcode = 'P0001';
    end if;
    if v_old.id is null then
      insert into public.coach_qualifications (id, coach_id, position, title, issuer, year, document_path, document_name)
      values (v_id, v_uid, o::integer, v_title, v_issuer, v_year, v_doc, v_docname);
      v_claims_changed := true;
    else
      if (v_title, v_issuer, v_year, v_doc) is distinct from (v_old.title, v_old.issuer, v_old.year, v_old.document_path) then
        v_claims_changed := true;
      end if;
      update public.coach_qualifications
         set position = o::integer, title = v_title, issuer = v_issuer, year = v_year, document_path = v_doc, document_name = v_docname
       where id = v_id;
    end if;
    v_qual_ids := v_qual_ids || v_id;
  end loop;
  delete from public.coach_qualifications where coach_id = v_uid and id <> all (v_qual_ids);

  if v_claims_changed and v_status <> 'draft' then
    insert into public.coach_review_events (coach_id, actor_id, action, from_status, to_status)
    values (v_uid, v_uid, 'qualifications_changed', v_status, v_status);
  end if;
  return private.coach_profile_json(v_uid);
end $$;

-- draft | changes_requested | rejected → submitted (validated). Re-submitting while submitted is a no-op.
create or replace function public.submit_coach_application() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  c public.coach_profiles;
  v_problems text[] := '{}';
  v_admin uuid;
begin
  select * into c from public.coach_profiles where user_id = v_uid for update;
  if c.user_id is null then raise exception 'Save your coach profile first.' using errcode = 'P0001'; end if;
  if c.status = 'submitted' then return private.coach_profile_json(v_uid); end if;
  if c.status = 'approved' then raise exception 'Your application is already approved.' using errcode = 'P0001'; end if;

  if char_length(btrim(c.display_name)) = 0 then v_problems := v_problems || 'Add a display name.'::text; end if;
  if char_length(btrim(c.bio)) < 40 then v_problems := v_problems || 'Write a bio of at least 40 characters.'::text; end if;
  if cardinality(c.specialties) = 0 then v_problems := v_problems || 'Choose at least one specialty.'::text; end if;
  if cardinality(c.languages) = 0 then v_problems := v_problems || 'Choose at least one language.'::text; end if;
  if c.country is null then v_problems := v_problems || 'Choose your country.'::text; end if;
  if cardinality(c.formats) = 0 then v_problems := v_problems || 'Choose in-person, online or both.'::text; end if;
  if 'in_person' = any (c.formats) and not exists (select 1 from public.coach_service_areas a where a.coach_id = v_uid) then
    v_problems := v_problems || 'Add at least one service area for in-person coaching.'::text;
  end if;
  if cardinality(v_problems) > 0 then
    raise exception '%', array_to_string(v_problems, ' ') using errcode = 'P0001', detail = to_jsonb(v_problems)::text;
  end if;
  perform private.enforce_rate_limit(v_uid, 'coach_submit', 10, interval '1 day',
                                     'You''ve submitted your application many times today. Please try again tomorrow.');

  update public.coach_profiles set status = 'submitted', submitted_at = now() where user_id = v_uid;
  insert into public.coach_review_events (coach_id, actor_id, action, from_status, to_status)
  values (v_uid, v_uid, case when c.status = 'draft' then 'submitted' else 'resubmitted' end, c.status, 'submitted');
  for v_admin in select r.user_id from public.app_roles r where r.role = 'admin' and r.user_id <> v_uid loop
    perform private.coach_notify(v_admin, v_uid, 'coach_application', null, v_uid, null);
  end loop;
  return private.coach_profile_json(v_uid);
end $$;

-- Listing visibility and accepting-new-clients are independent of approval.
create or replace function public.set_coach_listing(p_listed boolean, p_accepting boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid();
begin
  update public.coach_profiles
     set listed = coalesce(p_listed, listed), accepting_clients = coalesce(p_accepting, accepting_clients)
   where user_id = v_uid;
  if not found then raise exception 'Save your coach profile first.' using errcode = 'P0001'; end if;
  return private.coach_profile_json(v_uid);
end $$;

create or replace function public.my_coach_review_events() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid();
begin
  return coalesce((select jsonb_agg(private.review_event_json(e, false) order by e.created_at desc, e.id)
                     from public.coach_review_events e where e.coach_id = v_uid), '[]'::jsonb);
end $$;

/* ============================================================== directory */

-- Does a declared area (or the profile's business location) match the searched place? Folded comparison.
create or replace function private.area_text_match(p_kind text, p_city text, p_region text, p_country text,
                                                   s_city text, s_region text, s_country text) returns boolean
language sql immutable set search_path = '' as $$
  select case
    when s_country is not null and p_country is distinct from s_country then false
    when s_city is null and s_region is null then s_country is not null          -- country-only search
    when p_kind = 'country' then s_country is not null                           -- covers the whole (searched) country
    when s_city is not null then
      private.fold_text(p_city) = s_city
      or (p_kind = 'region' and (private.fold_text(p_region) = s_city or private.fold_text(p_region) = s_region))
    else private.fold_text(p_region) = s_region
  end
$$;

-- Directory search. Only approved, non-suspended, LISTED coaches; never private columns.
-- Distances are returned only when the search point AND a matched area have geocoder coordinates.
create or replace function public.search_coaches(p jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  q jsonb := case when jsonb_typeof(p) = 'object' then p else '{}'::jsonb end;
  v_city text := private.fold_text(q ->> 'city');
  v_region text := private.fold_text(q ->> 'region');
  v_country text := upper(nullif(btrim(coalesce(q ->> 'country', '')), ''));
  v_lat double precision := private.try_num(q ->> 'lat');
  v_lng double precision := private.try_num(q ->> 'lng');
  v_radius double precision := private.try_num(q ->> 'radiusKm');
  v_format text := coalesce(nullif(q ->> 'format', ''), 'any');
  v_specialty text := private.fold_text(q ->> 'specialty');
  v_goal text := private.fold_text(q ->> 'goal');
  v_language text := lower(nullif(btrim(coalesce(q ->> 'language', '')), ''));
  v_accepting boolean := coalesce(private.try_bool(q ->> 'acceptingOnly'), false);
  v_limit integer := least(greatest(coalesce(private.try_int(q ->> 'limit'), 20), 1), 50);
  v_offset integer := greatest(coalesce(private.try_int(q ->> 'offset'), 0), 0);
  v_has_place boolean;
  v_out jsonb;
begin
  if v_lat is null or v_lng is null or v_lat not between -90 and 90 or v_lng not between -180 and 180 then
    v_lat := null; v_lng := null;
  end if;
  if v_radius is not null and v_radius <= 0 then v_radius := null; end if;
  if v_radius is not null then v_radius := least(v_radius, 2000); end if;
  if v_country is not null and v_country !~ '^[A-Z]{2}$' then v_country := null; end if;
  if v_format not in ('any', 'in_person', 'online') then v_format := 'any'; end if;
  v_has_place := v_city is not null or v_region is not null or v_country is not null or v_lat is not null;

  with base as (
    select c.* from public.coach_profiles c
     where c.status = 'approved' and not c.suspended and c.listed
       and not private.is_blocked_between(c.user_id, v_uid)
       and (not v_accepting or c.accepting_clients)
       and (v_specialty is null or exists (select 1 from unnest(c.specialties) s where private.fold_text(s) = v_specialty))
       and (v_goal is null or exists (select 1 from unnest(c.goals) g where private.fold_text(g) = v_goal))
       and (v_language is null or v_language = any (c.languages))
       and (v_format = 'any' or v_format = any (c.formats))
  ),
  areas as (
    select a.coach_id, a.kind, a.city, a.region, a.country, a.lat::double precision as lat, a.lng::double precision as lng, a.radius_km
      from public.coach_service_areas a join base b on b.user_id = a.coach_id
    union all -- the profile's business location counts as a (coordinate-less) city area
    select b.user_id, 'city', b.city, b.region, b.country, null, null, null
      from base b where b.city is not null or b.region is not null or b.country is not null
  ),
  scored as (
    select a.coach_id,
           private.area_text_match(a.kind, a.city, a.region, a.country, v_city, v_region, v_country) as text_match,
           case when v_lat is not null and a.lat is not null then private.haversine_km(v_lat, v_lng, a.lat, a.lng) end as dist,
           a.radius_km
      from areas a
  ),
  local_match as (
    select s.coach_id, min(s.dist) as dist
      from scored s join base b on b.user_id = s.coach_id
     where v_has_place and 'in_person' = any (b.formats)
       and (s.text_match or (s.dist is not null and s.dist <= coalesce(s.radius_km, v_radius, 25)))
       and (v_radius is null or s.dist is null or s.dist <= v_radius)
     group by s.coach_id
  ),
  results as (
    select b.user_id, b.display_name, 0 as grp, l.dist from base b join local_match l on l.coach_id = b.user_id
    union all
    select b.user_id, b.display_name, 1, null::double precision from base b
     where 'online' = any (b.formats) and v_format <> 'in_person'
       and not exists (select 1 from local_match l where l.coach_id = b.user_id)
       and (v_country is null or v_language is not null or b.country = v_country
            or exists (select 1 from public.coach_service_areas a where a.coach_id = b.user_id and a.country = v_country))
  ),
  ranked as (
    select r.*, row_number() over (order by r.grp, r.dist asc nulls last, lower(r.display_name), r.user_id) as n from results r
  ),
  page as (
    select * from ranked order by n limit v_limit + 1 offset v_offset
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(private.coach_card_json(cp, case when pg.grp = 0 then 'local' else 'remote' end, pg.dist)
                                        order by pg.n)
                         from page pg join public.coach_profiles cp on cp.user_id = pg.user_id
                        where pg.n <= v_offset + v_limit), '[]'::jsonb),
    'has_more', (select count(*) from page) > v_limit,
    'distance_available', v_lat is not null and exists (select 1 from results r where r.grp = 0 and r.dist is not null))
    into v_out;
  return v_out;
end $$;

-- Coach detail. Visible when approved + not suspended + (listed or the viewer is/was their client);
-- always to the coach themself and to admins. Never private columns.
create or replace function public.get_coach(p_coach uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid(); c public.coach_profiles;
begin
  select * into c from public.coach_profiles where user_id = p_coach;
  if c.user_id is null then return null; end if;
  if not (c.user_id = v_uid or private.is_admin(v_uid)
          or (c.status = 'approved' and not c.suspended and not private.is_blocked_between(c.user_id, v_uid)
              and (c.listed or exists (select 1 from public.coaching_relationships r
                                        where r.coach_id = c.user_id and r.client_id = v_uid)))) then
    return null;
  end if;
  return private.coach_card_json(c, case when 'in_person' = any (c.formats) then 'local' else 'remote' end, null)
      || jsonb_build_object('experience_years', c.experience_years, 'experience', c.experience,
                            'approved_qualifications', private.coach_quals_json(c.user_id, true),
                            'approved_since', c.approved_at,
                            'is_approved', c.status = 'approved', 'is_suspended', c.suspended and c.user_id = v_uid);
end $$;

/* ========================================================== relationships */

create or replace function private.clean_scopes(j jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'training', coalesce(private.try_bool(j ->> 'training'), false),
    'measurements', coalesce(private.try_bool(j ->> 'measurements'), false),
    'nutrition', coalesce(private.try_bool(j ->> 'nutrition'), false),
    'checkins', coalesce(private.try_bool(j ->> 'checkins'), false))
$$;

-- Only allow-listed intake keys are kept (snapshot the CLIENT chose to share).
create or replace function private.clean_intake(j jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
    from jsonb_each(case when jsonb_typeof(j) = 'object' then j else '{}'::jsonb end) e(k, v)
   where k in ('goal', 'secondaryGoal', 'experience', 'daysPerWeek', 'sessionMinutes', 'equipment', 'limitations',
               'preferredFormat', 'notes')
$$;

-- Client → coach request. Idempotent on p_id. The caller is always the client (a coach cannot assign
-- themselves users). Target must be an active, listed coach accepting new clients; no self, no block.
create or replace function public.request_coaching(p_id uuid, p_coach uuid, p_intake jsonb default '{}',
                                                   p_message text default '', p_scopes jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  r public.coaching_relationships;
  c public.coach_profiles;
  v_msg text := btrim(coalesce(p_message, ''));
  v_intake jsonb := private.clean_intake(p_intake);
  v_scopes jsonb := private.clean_scopes(coalesce(p_scopes, '{}'::jsonb));
begin
  if p_id is null or p_coach is null then raise exception 'Choose a coach.' using errcode = 'P0001'; end if;
  select * into r from public.coaching_relationships where id = p_id;
  if r.id is not null then
    if r.client_id <> v_uid then raise exception 'Request not found.' using errcode = 'P0001'; end if;
    return private.relationship_json(r, v_uid); -- idempotent retry
  end if;
  if p_coach = v_uid then raise exception 'You can''t request coaching from yourself.' using errcode = 'P0001'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('coach-req:' || v_uid::text, 0));
  select * into c from public.coach_profiles where user_id = p_coach;
  if c.user_id is null or c.status <> 'approved' or c.suspended or not c.listed
     or private.is_blocked_between(p_coach, v_uid) then
    raise exception 'This coach isn''t available.' using errcode = 'P0001';
  end if;
  if not c.accepting_clients then
    raise exception 'This coach isn''t accepting new clients right now.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.coaching_relationships x where x.client_id = v_uid and x.coach_id = p_coach and x.status = 'active') then
    raise exception 'This coach is already your coach.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.coaching_relationships x where x.client_id = v_uid and x.coach_id = p_coach and x.status = 'requested') then
    raise exception 'You already have a pending request with this coach.' using errcode = 'P0001';
  end if;
  if (select count(*) from public.coaching_relationships x where x.client_id = v_uid and x.status = 'requested') >= 3 then
    raise exception 'You can have at most 3 open coaching requests. Cancel one first.' using errcode = 'P0001';
  end if;
  if char_length(v_msg) > 2000 then raise exception 'Your message can be at most 2000 characters.' using errcode = 'P0001'; end if;
  if octet_length(v_intake::text) > 8000 then raise exception 'Your intake is too long.' using errcode = 'P0001'; end if;
  perform private.enforce_rate_limit(v_uid, 'coaching_request', 10, interval '1 day',
                                     'You''ve sent many coaching requests today. Please try again tomorrow.');
  insert into public.coaching_relationships (id, coach_id, client_id, status, intake, intro_message)
  values (p_id, p_coach, v_uid, 'requested', v_intake, v_msg)
  returning * into r;
  insert into public.coaching_scopes (relationship_id, training, measurements, nutrition, checkins)
  values (p_id, (v_scopes ->> 'training')::boolean, (v_scopes ->> 'measurements')::boolean,
          (v_scopes ->> 'nutrition')::boolean, (v_scopes ->> 'checkins')::boolean);
  perform private.coach_notify(p_coach, v_uid, 'coach_request', p_id, p_coach, null);
  return private.relationship_json(r, v_uid);
end $$;

create or replace function public.cancel_coaching_request(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid(); r public.coaching_relationships;
begin
  select * into r from public.coaching_relationships where id = p_id for update;
  if r.id is null or r.client_id <> v_uid then raise exception 'Request not found.' using errcode = 'P0001'; end if;
  if r.status = 'cancelled' then return; end if;
  if r.status <> 'requested' then raise exception 'Only a pending request can be cancelled.' using errcode = 'P0001'; end if;
  perform private.close_relationship(p_id, 'cancelled', v_uid, null);
  perform private.coach_notify(r.coach_id, v_uid, 'coach_request_cancelled', p_id, r.coach_id, null);
end $$;

-- Coach only. Accepting ends the client's previous active relationship (explicit switch, old coach is
-- notified) and cancels the client's other pending requests.
create or replace function public.respond_coaching_request(p_id uuid, p_accept boolean, p_message text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  r public.coaching_relationships;
  x public.coaching_relationships;
  v_msg text := nullif(btrim(coalesce(p_message, '')), '');
begin
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
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('coach-req:' || r.client_id::text, 0));
  if p_accept then
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

-- Either party may end an active relationship (always allowed — it only reduces access).
create or replace function public.end_coaching(p_id uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid(); r public.coaching_relationships; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select * into r from public.coaching_relationships where id = p_id for update;
  if r.id is null or v_uid not in (r.coach_id, r.client_id) then raise exception 'Coaching relationship not found.' using errcode = 'P0001'; end if;
  if r.status = 'ended' then return; end if;
  if r.status = 'requested' and v_uid = r.client_id then perform public.cancel_coaching_request(p_id); return; end if;
  if r.status <> 'active' then raise exception 'This coaching relationship isn''t active.' using errcode = 'P0001'; end if;
  perform private.close_relationship(p_id, 'ended', v_uid, left(v_reason, 500));
  perform private.coach_notify(case when v_uid = r.client_id then r.coach_id else r.client_id end, v_uid, 'coach_ended',
                               p_id, r.coach_id, null);
end $$;

-- Client only. Takes effect on the coach's very next query.
create or replace function public.set_coaching_scopes(p_id uuid, p_scopes jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid(); r public.coaching_relationships; v jsonb := private.clean_scopes(coalesce(p_scopes, '{}'::jsonb));
begin
  select * into r from public.coaching_relationships where id = p_id;
  if r.id is null or r.client_id <> v_uid then raise exception 'Coaching relationship not found.' using errcode = 'P0001'; end if;
  if r.status not in ('requested', 'active') then
    raise exception 'This coaching relationship has ended.' using errcode = 'P0001';
  end if;
  insert into public.coaching_scopes as s (relationship_id, training, measurements, nutrition, checkins, updated_at)
  values (p_id, (v ->> 'training')::boolean, (v ->> 'measurements')::boolean, (v ->> 'nutrition')::boolean,
          (v ->> 'checkins')::boolean, now())
  on conflict (relationship_id) do update
    set training = excluded.training, measurements = excluded.measurements, nutrition = excluded.nutrition,
        checkins = excluded.checkins, updated_at = now();
  return private.relationship_json(r, v_uid);
end $$;

create or replace function public.my_coaching_relationships() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid();
begin
  return coalesce((select jsonb_agg(private.relationship_json(r, v_uid)
                                    order by (r.status in ('active', 'requested')) desc, coalesce(r.responded_at, r.requested_at) desc)
                     from public.coaching_relationships r
                    where r.client_id = v_uid or r.coach_id = v_uid), '[]'::jsonb);
end $$;

-- Coach-side read of the client's PERMITTED records. Each panel is null unless the current scope allows it.
-- Pending → relationship (with intake + intro message) only.
create or replace function public.coach_client_overview(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  r public.coaching_relationships;
  v_client uuid;
  v_training jsonb; v_meas jsonb; v_nutr jsonb; v_checkins jsonb;
  v_prog public.programs;
  v_ver jsonb;
begin
  select * into r from public.coaching_relationships where id = p_id;
  if r.id is null or r.coach_id <> v_uid then raise exception 'Client not found.' using errcode = 'P0001'; end if;
  if not private.coach_is_active(v_uid) then
    raise exception 'Your coaching account isn''t active, so client records are unavailable.' using errcode = '42501';
  end if;
  v_client := r.client_id;
  if r.status = 'active' then
    if private.coach_can_access(v_uid, v_client, 'training') then
      select * into v_prog from public.programs
       where owner_id = v_client and deleted_at is null and active is true order by updated_at desc limit 1;
      if v_prog.id is not null then
        select v.payload into v_ver from public.program_versions v
         where v.owner_id = v_client and v.program_id = v_prog.id and v.version_no = v_prog.current_version;
      end if;
      v_training := jsonb_build_object(
        'active_program', case when v_prog.id is null then null else jsonb_build_object(
            'id', v_prog.id, 'name', v_prog.name, 'current_version', v_prog.current_version,
            'managed_by', v_prog.payload #>> '{managedBy,kind}') end,
        'recent_sessions', coalesce((select jsonb_agg(jsonb_build_object(
              'id', s.id, 'date', s.session_date, 'name', s.name, 'status', s.status,
              'duration_min', case when s.ended_at is not null and s.started_at is not null then greatest(0, round(
                 (extract(epoch from (s.ended_at - s.started_at)) - coalesce(private.try_num(s.payload ->> 'pausedTotalMs'), 0) / 1000) / 60))::integer end,
              'working_sets', (select count(*) from public.session_sets ss
                                where ss.owner_id = s.owner_id and ss.session_id = s.id and ss.completed and ss.set_type <> 'warmup'))
              order by s.session_date desc nulls last, s.started_at desc nulls last)
            from (select * from public.workout_sessions w where w.owner_id = v_client and w.deleted_at is null
                   order by w.session_date desc nulls last, w.started_at desc nulls last limit 10) s), '[]'::jsonb),
        'planned_last28', case when v_ver is null or v_prog.start_date is null then null else (
            select count(*)::integer
              from generate_series(greatest(current_date - 27, v_prog.start_date), current_date, interval '1 day') d
              join jsonb_array_elements(case when jsonb_typeof(v_ver -> 'schedule') = 'array' then v_ver -> 'schedule' else '[]'::jsonb end) sl
                on private.try_int(sl ->> 'weekday') = extract(dow from d)::integer) end,
        'completed_last28', (select count(*)::integer from public.workout_sessions w
                              where w.owner_id = v_client and w.deleted_at is null and w.status = 'completed'
                                and w.session_date >= current_date - 27));
    end if;
    if private.coach_can_access(v_uid, v_client, 'measurements') then
      v_meas := coalesce((select jsonb_agg(jsonb_build_object('date', m.measured_on, 'kind', m.kind, 'value', m.value)
                                           order by m.measured_on desc)
                            from (select * from public.measurements x where x.owner_id = v_client and x.deleted_at is null
                                     and x.measured_on is not null and x.value is not null
                                   order by x.measured_on desc limit 90) m), '[]'::jsonb);
    end if;
    if private.coach_can_access(v_uid, v_client, 'nutrition') then
      v_nutr := coalesce((select jsonb_agg(jsonb_build_object('date', d.log_date, 'protein', d.protein, 'kcal', d.kcal) order by d.log_date desc)
                            from (select f.log_date, sum(private.try_num(f.payload ->> 'protein')) as protein,
                                         sum(private.try_num(f.payload ->> 'kcal')) as kcal
                                    from public.food_logs f
                                   where f.owner_id = v_client and f.deleted_at is null and f.log_date >= current_date - 27
                                   group by f.log_date) d), '[]'::jsonb);
    end if;
    if private.coach_can_access(v_uid, v_client, 'checkins') then
      v_checkins := coalesce((select jsonb_agg(private.checkin_json(k) order by k.created_at desc)
                                from (select * from public.coach_checkins x where x.relationship_id = r.id
                                       order by x.created_at desc limit 20) k), '[]'::jsonb);
    end if;
  end if;
  return jsonb_build_object('relationship', private.relationship_json(r, v_uid), 'training', v_training,
                            'measurements', v_meas, 'nutrition', v_nutr, 'checkins', v_checkins);
end $$;

-- Blocking (either direction) ends requested/active coaching between the pair. Unfriending does nothing:
-- friendship never grants coaching access in the first place.
create or replace function private.trg_block_ends_coaching() returns trigger
language plpgsql security definer set search_path = '' as $$
declare x public.coaching_relationships;
begin
  for x in select * from public.coaching_relationships r
            where r.status in ('requested', 'active')
              and ((r.coach_id = new.blocker_id and r.client_id = new.blocked_id)
                or (r.coach_id = new.blocked_id and r.client_id = new.blocker_id)) loop
    perform private.close_relationship(x.id, case when x.status = 'requested' then 'cancelled' else 'ended' end, new.blocker_id, null);
  end loop;
  return null;
end $$;
create trigger blocks_end_coaching after insert on public.blocks
  for each row execute function private.trg_block_ends_coaching();

/* ================================================================ programs */

-- Structural validation of a proposed program (same shape as a ProgramVersion + name).
create or replace function private.validate_proposed_program(p jsonb) returns text[]
language plpgsql stable security definer set search_path = '' as $$
declare
  v text[] := '{}';
  t jsonb; x jsonb; s jsonb;
  v_tids text[] := '{}';
  v_check_ref boolean := exists (select 1 from public.ref_exercises);
begin
  if p is null or jsonb_typeof(p) <> 'object' then return array['The program is missing.']; end if;
  if char_length(btrim(coalesce(p ->> 'name', ''))) not between 1 and 200 then v := v || 'The program needs a name.'::text; end if;
  if jsonb_typeof(p -> 'templates') is distinct from 'array' or jsonb_array_length(p -> 'templates') = 0 then
    return v || 'The program needs at least one session.'::text;
  end if;
  if jsonb_array_length(p -> 'templates') > 14 then v := v || 'A program can have at most 14 sessions.'::text; end if;
  for t in select value from jsonb_array_elements(p -> 'templates') loop
    if jsonb_typeof(t) <> 'object' or coalesce(t ->> 'id', '') = '' or char_length(btrim(coalesce(t ->> 'name', ''))) = 0 then
      v := v || 'Every session needs an id and a name.'::text; continue;
    end if;
    v_tids := v_tids || (t ->> 'id');
    if jsonb_typeof(t -> 'exercises') is distinct from 'array' then v := v || ('Session "' || (t ->> 'name') || '" has no exercise list.'); continue; end if;
    if jsonb_array_length(t -> 'exercises') > 30 then v := v || ('Session "' || (t ->> 'name') || '" has too many exercises.'); end if;
    for x in select value from jsonb_array_elements(t -> 'exercises') loop
      if jsonb_typeof(x) <> 'object' or coalesce(x ->> 'exerciseId', '') = '' then
        v := v || ('An exercise in "' || (t ->> 'name') || '" has no exercise id.'); continue;
      end if;
      if v_check_ref and private.try_uuid(x ->> 'exerciseId') is null
         and not exists (select 1 from public.ref_exercises e where e.id = x ->> 'exerciseId') then
        v := v || ('Unknown exercise "' || left(x ->> 'exerciseId', 100) || '".');
      end if;
      if coalesce(private.try_int(x ->> 'sets'), 1) not between 1 and 20
         or coalesce(private.try_int(x ->> 'repMin'), 0) not between 0 and 100
         or coalesce(private.try_int(x ->> 'repMax'), 0) not between 0 and 100
         or coalesce(private.try_int(x ->> 'repMin'), 0) > coalesce(private.try_int(x ->> 'repMax'), 100)
         or coalesce(private.try_int(x ->> 'restSec'), 0) not between 0 and 1800 then
        v := v || ('Check the sets, reps and rest for "' || left(x ->> 'exerciseId', 100) || '".');
      end if;
    end loop;
  end loop;
  if jsonb_typeof(p -> 'schedule') is distinct from 'array' then
    v := v || 'The program needs a weekly schedule.'::text;
  else
    for s in select value from jsonb_array_elements(p -> 'schedule') loop
      if coalesce(private.try_int(s ->> 'weekday'), -1) not between 0 and 6 or not coalesce((s ->> 'templateId') = any (v_tids), false) then
        v := v || 'Every scheduled day must name a weekday (0–6) and one of the program''s sessions.'::text;
        exit;
      end if;
    end loop;
  end if;
  return v;
end $$;

-- Coach draft (idempotent on id; editable while 'draft'). Only while the relationship is writable.
create or replace function public.save_program_proposal(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_id uuid := private.try_uuid(p ->> 'id');
  v_rel uuid := private.try_uuid(p ->> 'relationshipId');
  r public.coaching_relationships;
  pp public.program_proposals;
  v_base uuid := private.try_uuid(p ->> 'baseProgramId');
  v_base_ver integer := private.try_int(p ->> 'baseVersion');
  v_program jsonb := p -> 'program';
  v_summary text[];
  v_message text := nullif(btrim(coalesce(p ->> 'message', '')), '');
  v_problems text[];
  v_rev integer;
begin
  if v_id is null or v_rel is null then raise exception 'Proposal id and client are required.' using errcode = 'P0001'; end if;
  select * into r from public.coaching_relationships where id = v_rel;
  if r.id is null or r.coach_id <> v_uid then raise exception 'Client not found.' using errcode = 'P0001'; end if;
  if not private.is_relationship_participant(v_rel, v_uid, true) then
    raise exception 'This coaching relationship isn''t active, so you can''t send programs.' using errcode = '42501';
  end if;
  if v_base is not null and v_base_ver is null then
    raise exception 'A revision must say which program version it is based on.' using errcode = 'P0001';
  end if;
  v_summary := private.clean_text_array(p -> 'changeSummary', 50, 300, 'change notes');
  if char_length(v_message) > 4000 then raise exception 'Your note can be at most 4000 characters.' using errcode = 'P0001'; end if;
  if v_program is null or octet_length(v_program::text) > 262144 then
    raise exception 'This program is too large.' using errcode = 'P0001';
  end if;
  v_problems := private.validate_proposed_program(v_program);
  if cardinality(v_problems) > 0 then
    raise exception '%', array_to_string(v_problems[1:5], ' ') using errcode = 'P0001', detail = to_jsonb(v_problems)::text;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('proposal:' || v_rel::text, 0));
  select * into pp from public.program_proposals where id = v_id for update;
  if pp.id is not null then
    if pp.author_kind <> 'coach' or pp.coach_id <> v_uid or pp.relationship_id <> v_rel then
      raise exception 'Proposal not found.' using errcode = 'P0001';
    end if;
    if pp.status <> 'draft' then
      raise exception 'This proposal was already sent. Create a revision instead.' using errcode = 'P0001';
    end if;
    if pp.base_program_id is distinct from v_base then
      select coalesce(max(x.revision), 0) + 1 into v_rev from public.program_proposals x
       where x.relationship_id = v_rel and x.base_program_id is not distinct from v_base and x.id <> v_id;
    else
      v_rev := pp.revision;
    end if;
    update public.program_proposals
       set base_program_id = v_base, base_version = v_base_ver, revision = v_rev, program = v_program,
           change_summary = to_jsonb(v_summary), message = v_message, effective_date = private.try_date(p ->> 'effectiveDate'),
           validation_errors = '[]', updated_at = now()
     where id = v_id returning * into pp;
  else
    perform private.enforce_rate_limit(v_uid, 'coach_proposal', 20, interval '1 day',
                                       'You''ve created many program proposals today. Please try again tomorrow.');
    select coalesce(max(x.revision), 0) + 1 into v_rev from public.program_proposals x
     where x.relationship_id = v_rel and x.base_program_id is not distinct from v_base;
    insert into public.program_proposals (id, author_kind, relationship_id, coach_id, client_id, status, base_program_id,
                                          base_version, revision, program, change_summary, message, effective_date, target)
    values (v_id, 'coach', v_rel, v_uid, r.client_id, 'draft', v_base, v_base_ver, v_rev, v_program, to_jsonb(v_summary),
            v_message, private.try_date(p ->> 'effectiveDate'), 'apply')
    returning * into pp;
  end if;
  return private.proposal_json(pp);
end $$;

create or replace function public.send_program_proposal(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid(); pp public.program_proposals;
begin
  select * into pp from public.program_proposals where id = p_id for update;
  if pp.id is null or pp.author_kind <> 'coach' or pp.coach_id <> v_uid then raise exception 'Proposal not found.' using errcode = 'P0001'; end if;
  if not private.is_relationship_participant(pp.relationship_id, v_uid, true) then
    raise exception 'This coaching relationship isn''t active, so you can''t send programs.' using errcode = '42501';
  end if;
  if pp.status = 'sent' then return private.proposal_json(pp); end if; -- idempotent, no second notification
  if pp.status <> 'draft' then raise exception 'Only a draft can be sent.' using errcode = 'P0001'; end if;
  update public.program_proposals set status = 'superseded', updated_at = now()
   where relationship_id = pp.relationship_id and base_program_id is not distinct from pp.base_program_id
     and status = 'sent' and id <> p_id;
  update public.program_proposals set status = 'sent', sent_at = now(), updated_at = now() where id = p_id returning * into pp;
  perform private.coach_notify(pp.client_id, v_uid, 'coach_proposal', pp.relationship_id, v_uid, pp.id);
  return private.proposal_json(pp);
end $$;

create or replace function public.withdraw_program_proposal(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid(); pp public.program_proposals;
begin
  select * into pp from public.program_proposals where id = p_id for update;
  if pp.id is null or pp.author_kind <> 'coach' or pp.coach_id <> v_uid then raise exception 'Proposal not found.' using errcode = 'P0001'; end if;
  if pp.status = 'withdrawn' then return; end if;
  if not private.is_relationship_participant(pp.relationship_id, v_uid, true) then
    raise exception 'This coaching relationship isn''t active.' using errcode = '42501';
  end if;
  if pp.status not in ('draft', 'sent') then raise exception 'This proposal can no longer be withdrawn.' using errcode = 'P0001'; end if;
  update public.program_proposals set status = 'withdrawn', updated_at = now() where id = p_id;
end $$;

-- Coach proposals visible to the caller: as client (sent or later), or as an ACTIVE coach (own).
create or replace function private.proposal_visible(pp public.program_proposals, p_viewer uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_viewer is not null and (
    (pp.client_id = p_viewer and (pp.author_kind = 'ai' or pp.status <> 'draft'))
    or (pp.author_kind = 'coach' and pp.coach_id = p_viewer and private.coach_is_active(p_viewer)
        and private.is_relationship_participant(pp.relationship_id, p_viewer, false)))
$$;

-- p: { relationshipId?, mine? (client view only), status?: [] }. Coach proposals only (AI: list_ai_proposals).
create or replace function public.list_program_proposals(p jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  q jsonb := case when jsonb_typeof(p) = 'object' then p else '{}'::jsonb end;
  v_rel uuid := private.try_uuid(q ->> 'relationshipId');
  v_mine boolean := coalesce(private.try_bool(q ->> 'mine'), false);
  v_status text[] := case when jsonb_typeof(q -> 'status') = 'array'
                          then (select array_agg(x) from jsonb_array_elements_text(q -> 'status') x) end;
begin
  return coalesce((select jsonb_agg(private.proposal_json(pp) order by pp.created_at desc, pp.id)
                     from (select * from public.program_proposals x
                            where x.author_kind = 'coach' and (x.client_id = v_uid or x.coach_id = v_uid)
                              and (v_rel is null or x.relationship_id = v_rel)
                              and (not v_mine or x.client_id = v_uid)
                              and (v_status is null or x.status = any (v_status))
                            order by x.created_at desc limit 200) pp
                    where private.proposal_visible(pp, v_uid)), '[]'::jsonb);
end $$;

create or replace function public.get_program_proposal(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid(); pp public.program_proposals;
begin
  select * into pp from public.program_proposals where id = p_id;
  if pp.id is null or not private.proposal_visible(pp, v_uid) then return null; end if;
  return private.proposal_json(pp);
end $$;

-- Client only. Accept re-checks (when the base program is on the server) that the client's program has not
-- moved past base_version, so a stale proposal can never overwrite a newer plan. p_program_id/p_version are
-- the program and NEW version the client applies it as (a revision must be applied to its base program).
-- Same rule as respond_ai_proposal: the server copy may be at base_version (respond, then push the applied
-- version) or already at p_version (pushed first, then respond); anything else is stale.
create or replace function public.respond_program_proposal(p_id uuid, p_accept boolean, p_program_id uuid default null,
                                                           p_version integer default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid(); pp public.program_proposals; v_cur integer; v_found boolean;
begin
  select * into pp from public.program_proposals where id = p_id for update;
  if pp.id is null or pp.author_kind <> 'coach' or pp.client_id <> v_uid or pp.status = 'draft' then
    raise exception 'Proposal not found.' using errcode = 'P0001';
  end if;
  if (pp.status = 'accepted' and p_accept) or (pp.status = 'declined' and not p_accept) then
    return private.proposal_json(pp); -- idempotent retry
  end if;
  if pp.status <> 'sent' then
    raise exception 'This proposal is no longer open (%).', pp.status using errcode = 'P0001';
  end if;
  if p_accept then
    if not private.is_relationship_participant(pp.relationship_id, v_uid, true) then
      raise exception 'This coaching relationship isn''t active, so the proposal can''t be accepted.' using errcode = '42501';
    end if;
    if p_program_id is null or p_version is null or p_version < 1 then
      raise exception 'Accepting needs the program id and version it is applied as.' using errcode = 'P0001';
    end if;
    if pp.base_program_id is not null then
      if p_program_id <> pp.base_program_id then
        raise exception 'This proposal revises a different plan.' using errcode = 'P0001', hint = 'wrong_program';
      end if;
      if p_version <= pp.base_version then
        raise exception 'Applying a revision creates a new version of your plan.' using errcode = 'P0001';
      end if;
      select current_version, true into v_cur, v_found from public.programs
       where owner_id = v_uid and id = pp.base_program_id and deleted_at is null;
      if coalesce(v_found, false) and v_cur is distinct from pp.base_version and v_cur is distinct from p_version then
        raise exception 'This proposal is stale: your program changed since your coach made it (now version %, proposal is for version %). Ask for an updated proposal.',
          v_cur, pp.base_version using errcode = 'P0001', hint = 'stale';
      end if;
    end if;
    update public.program_proposals
       set status = 'accepted', responded_at = now(), updated_at = now(), applied_program_id = p_program_id, applied_version = p_version
     where id = p_id returning * into pp;
  else
    update public.program_proposals set status = 'declined', responded_at = now(), updated_at = now()
     where id = p_id returning * into pp;
  end if;
  perform private.coach_notify(pp.coach_id, v_uid, 'coach_proposal_response', pp.relationship_id, pp.coach_id, pp.id);
  return private.proposal_json(pp);
end $$;

/* ===================================================== feedback + check-ins */

create or replace function public.add_coach_feedback(p_id uuid, p_relationship uuid, p_session uuid, p_body text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid(); r public.coaching_relationships; f public.coach_feedback; v_body text := btrim(coalesce(p_body, ''));
begin
  select * into f from public.coach_feedback where id = p_id;
  if f.id is not null then
    if f.coach_id <> v_uid then raise exception 'Feedback not found.' using errcode = 'P0001'; end if;
    return jsonb_build_object('id', f.id, 'relationship_id', f.relationship_id, 'session_id', f.session_id, 'body', f.body, 'created_at', f.created_at);
  end if;
  select * into r from public.coaching_relationships where id = p_relationship;
  if r.id is null or r.coach_id <> v_uid then raise exception 'Client not found.' using errcode = 'P0001'; end if;
  if not private.is_relationship_participant(p_relationship, v_uid, true) then
    raise exception 'This coaching relationship isn''t active.' using errcode = '42501';
  end if;
  if char_length(v_body) not between 1 and 2000 then raise exception 'Feedback must be 1–2000 characters.' using errcode = 'P0001'; end if;
  if p_session is not null and not (private.coach_can_access(v_uid, r.client_id, 'training')
       and exists (select 1 from public.workout_sessions w where w.owner_id = r.client_id and w.id = p_session and w.deleted_at is null)) then
    raise exception 'Workout not found.' using errcode = 'P0001';
  end if;
  perform private.enforce_rate_limit(v_uid, 'coach_feedback', 200, interval '1 day', 'You''ve written a lot of feedback today. Please try again tomorrow.');
  insert into public.coach_feedback (id, relationship_id, coach_id, client_id, session_id, body)
  values (p_id, p_relationship, v_uid, r.client_id, p_session, v_body) returning * into f;
  perform private.coach_notify(r.client_id, v_uid, 'coach_feedback', p_relationship, v_uid, null);
  return jsonb_build_object('id', f.id, 'relationship_id', f.relationship_id, 'session_id', f.session_id, 'body', f.body, 'created_at', f.created_at);
end $$;

create or replace function public.list_coach_feedback(p_relationship uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid();
begin
  if not private.is_relationship_participant(p_relationship, v_uid, false) then
    raise exception 'Coaching relationship not found.' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'relationship_id', f.relationship_id, 'session_id', f.session_id,
                                                       'body', f.body, 'created_at', f.created_at) order by f.created_at desc)
                     from public.coach_feedback f where f.relationship_id = p_relationship), '[]'::jsonb);
end $$;

create or replace function public.submit_checkin(p_id uuid, p_relationship uuid, p_answers jsonb, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid(); r public.coaching_relationships; k public.coach_checkins;
  a jsonb := case when jsonb_typeof(p_answers) = 'object' then p_answers else '{}'::jsonb end;
  v_clean jsonb; v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select * into k from public.coach_checkins where id = p_id;
  if k.id is not null then
    if k.client_id <> v_uid then raise exception 'Check-in not found.' using errcode = 'P0001'; end if;
    return private.checkin_json(k);
  end if;
  select * into r from public.coaching_relationships where id = p_relationship;
  if r.id is null or r.client_id <> v_uid then raise exception 'Coaching relationship not found.' using errcode = 'P0001'; end if;
  if not private.is_relationship_participant(p_relationship, v_uid, true) then
    raise exception 'This coaching relationship isn''t active.' using errcode = '42501';
  end if;
  v_clean := jsonb_strip_nulls(jsonb_build_object(
    'energy', case when private.try_int(a ->> 'energy') between 1 and 5 then private.try_int(a ->> 'energy') end,
    'sleep', case when private.try_int(a ->> 'sleep') between 1 and 5 then private.try_int(a ->> 'sleep') end,
    'soreness', case when private.try_int(a ->> 'soreness') between 1 and 5 then private.try_int(a ->> 'soreness') end,
    'stress', case when private.try_int(a ->> 'stress') between 1 and 5 then private.try_int(a ->> 'stress') end,
    'bodyweightKg', case when private.try_num(a ->> 'bodyweightKg') between 20 and 400 then round(private.try_num(a ->> 'bodyweightKg'), 1) end,
    'wins', nullif(left(btrim(coalesce(a ->> 'wins', '')), 1000), ''),
    'struggles', nullif(left(btrim(coalesce(a ->> 'struggles', '')), 1000), '')));
  if char_length(v_note) > 2000 then raise exception 'Your note can be at most 2000 characters.' using errcode = 'P0001'; end if;
  perform private.enforce_rate_limit(v_uid, 'coach_checkin', 20, interval '1 day', 'You''ve sent many check-ins today.');
  insert into public.coach_checkins (id, relationship_id, client_id, coach_id, answers, note)
  values (p_id, p_relationship, v_uid, r.coach_id, v_clean, v_note) returning * into k;
  if private.coach_can_access(r.coach_id, v_uid, 'checkins') then
    perform private.coach_notify(r.coach_id, v_uid, 'coach_checkin', p_relationship, r.coach_id, null);
  end if;
  return private.checkin_json(k);
end $$;

create or replace function public.list_checkins(p_relationship uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid(); r public.coaching_relationships;
begin
  select * into r from public.coaching_relationships where id = p_relationship;
  if r.id is null or not (r.client_id = v_uid or (r.coach_id = v_uid and private.coach_can_access(v_uid, r.client_id, 'checkins'))) then
    raise exception 'Check-ins aren''t shared with you.' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(private.checkin_json(k) order by k.created_at desc)
                     from public.coach_checkins k where k.relationship_id = p_relationship), '[]'::jsonb);
end $$;

create or replace function public.respond_checkin(p_id uuid, p_response text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid(); k public.coach_checkins; v_resp text := btrim(coalesce(p_response, ''));
begin
  select * into k from public.coach_checkins where id = p_id for update;
  if k.id is null or k.coach_id <> v_uid or not private.coach_can_access(v_uid, k.client_id, 'checkins')
     or not private.is_relationship_participant(k.relationship_id, v_uid, true) then
    raise exception 'Check-in not found.' using errcode = '42501';
  end if;
  if char_length(v_resp) not between 1 and 2000 then raise exception 'Your response must be 1–2000 characters.' using errcode = 'P0001'; end if;
  update public.coach_checkins set coach_response = v_resp, reviewed_at = now() where id = p_id returning * into k;
  perform private.coach_notify(k.client_id, v_uid, 'coach_checkin', k.relationship_id, v_uid, null);
  return private.checkin_json(k);
end $$;

/* ================================================================ messages */

create or replace function public.list_coach_messages(p_relationship uuid, p_after_seq bigint default 0, p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid(); v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 200);
begin
  if not private.is_relationship_participant(p_relationship, v_uid, false) then
    raise exception 'This conversation isn''t available.' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(private.message_json(m) order by m.seq)
                     from (select * from public.coach_messages x
                            where x.relationship_id = p_relationship and x.seq > coalesce(p_after_seq, 0)
                              and (x.status = 'sent' or x.sender_id = v_uid)
                            order by x.seq limit v_limit) m), '[]'::jsonb);
end $$;

-- Idempotent on p_id: a retry returns the stored row and creates NO second notification.
-- With media (p_media: [{ id, width?, height? }]) the message stays 'awaiting_media' (invisible to the other
-- party) until finalize-coach-media has validated every photo.
create or replace function public.send_coach_message(p_id uuid, p_relationship uuid, p_body text, p_media jsonb default '[]',
                                                     p_shared_from_ai boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  r public.coaching_relationships;
  m public.coach_messages;
  v_body text := btrim(coalesce(p_body, ''));
  v_media jsonb := '[]';
  e jsonb;
begin
  if p_id is null then raise exception 'Message id is required.' using errcode = 'P0001'; end if;
  select * into m from public.coach_messages where id = p_id;
  if m.id is not null then
    if m.sender_id <> v_uid or m.relationship_id <> p_relationship then raise exception 'Message not found.' using errcode = 'P0001'; end if;
    return private.message_json(m);
  end if;
  select * into r from public.coaching_relationships where id = p_relationship;
  if r.id is null or v_uid not in (r.coach_id, r.client_id) then raise exception 'This conversation isn''t available.' using errcode = '42501'; end if;
  if not private.is_relationship_participant(p_relationship, v_uid, true) then
    raise exception 'This conversation is read-only now. Messages can''t be sent.' using errcode = '42501';
  end if;
  if char_length(v_body) > 4000 then raise exception 'Messages can be at most 4000 characters.' using errcode = 'P0001'; end if;
  if p_media is not null and jsonb_typeof(p_media) = 'array' then
    if jsonb_array_length(p_media) > 4 then raise exception 'Attach at most 4 photos.' using errcode = 'P0001'; end if;
    for e in select value from jsonb_array_elements(p_media) loop
      -- width/height are optional here; finalize-coach-media records the validated dimensions
      if private.try_uuid(e ->> 'id') is null or coalesce(private.try_int(e ->> 'width'), 1) not between 1 and 4096
         or coalesce(private.try_int(e ->> 'height'), 1) not between 1 and 4096 then
        raise exception 'Invalid photo.' using errcode = 'P0001';
      end if;
      if v_media @> jsonb_build_array(jsonb_build_object('id', lower(e ->> 'id'))) then
        raise exception 'The same photo is attached twice.' using errcode = 'P0001';
      end if;
      v_media := v_media || jsonb_build_array(jsonb_build_object('id', lower(e ->> 'id'), 'width', private.try_int(e ->> 'width'),
                                                                  'height', private.try_int(e ->> 'height')));
    end loop;
  end if;
  if v_body = '' and jsonb_array_length(v_media) = 0 then raise exception 'Write a message first.' using errcode = 'P0001'; end if;
  perform private.enforce_rate_limit(v_uid, 'coach_message', 120, interval '1 hour',
                                     'You''re sending messages very quickly. Please wait a few minutes.');
  insert into public.coach_messages (id, relationship_id, sender_id, body, media, status, shared_from_ai)
  values (p_id, p_relationship, v_uid, v_body, v_media, case when jsonb_array_length(v_media) > 0 then 'awaiting_media' else 'sent' end,
          coalesce(p_shared_from_ai, false))
  on conflict (id) do nothing
  returning * into m;
  if m.id is null then -- lost a race with a concurrent retry of the same id
    select * into m from public.coach_messages where id = p_id;
    if m.sender_id <> v_uid then raise exception 'Message not found.' using errcode = 'P0001'; end if;
    return private.message_json(m);
  end if;
  if m.status = 'sent' then
    perform private.coach_notify(case when v_uid = r.client_id then r.coach_id else r.client_id end, v_uid, 'coach_message',
                                 p_relationship, r.coach_id, null);
  end if;
  return private.message_json(m);
end $$;

create or replace function public.mark_coach_messages_read(p_relationship uuid, p_upto bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid(); v_max bigint;
begin
  if not private.is_relationship_participant(p_relationship, v_uid, false) then
    raise exception 'This conversation isn''t available.' using errcode = '42501';
  end if;
  select max(seq) into v_max from public.coach_messages where relationship_id = p_relationship;
  insert into public.coach_message_reads as k (relationship_id, user_id, last_read_seq, updated_at)
  values (p_relationship, v_uid, greatest(least(coalesce(p_upto, 0), coalesce(v_max, 0)), 0), now())
  on conflict (relationship_id, user_id) do update
    set last_read_seq = greatest(k.last_read_seq, excluded.last_read_seq), updated_at = now();
  update public.notifications set read_at = now()
   where recipient_id = v_uid and type = 'coach_message' and relationship_id = p_relationship and read_at is null
     and not exists (select 1 from public.coach_messages m
                      where m.relationship_id = p_relationship and m.sender_id <> v_uid and m.status = 'sent'
                        and m.seq > greatest(least(coalesce(p_upto, 0), coalesce(v_max, 0)), 0));
end $$;

create or replace function public.unread_coaching_count() returns integer
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid();
begin
  return coalesce((select sum(private.relationship_unread(r.id, v_uid))::integer
                     from public.coaching_relationships r
                    where (r.client_id = v_uid or r.coach_id = v_uid) and r.status in ('active', 'ended')), 0);
end $$;

create or replace function public.report_coaching_content(p_relationship uuid, p_message uuid default null, p_reason text default 'other',
                                                          p_details text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid(); r public.coaching_relationships; m public.coach_messages;
        v_details text := nullif(btrim(coalesce(p_details, '')), '');
begin
  select * into r from public.coaching_relationships where id = p_relationship;
  if r.id is null or v_uid not in (r.coach_id, r.client_id) then raise exception 'Nothing to report here.' using errcode = 'P0001'; end if;
  if p_reason is null or p_reason not in ('spam', 'harassment', 'inappropriate', 'other') then
    raise exception 'Choose a reason.' using errcode = 'P0001';
  end if;
  if char_length(v_details) > 1000 then raise exception 'Details can be at most 1000 characters.' using errcode = 'P0001'; end if;
  if p_message is not null then
    select * into m from public.coach_messages where id = p_message and relationship_id = p_relationship;
    if m.id is null or m.sender_id = v_uid then raise exception 'Message not found.' using errcode = 'P0001'; end if;
  end if;
  perform private.enforce_rate_limit(v_uid, 'coaching_report', 20, interval '1 hour', 'You''ve sent many reports recently.');
  insert into public.coaching_reports (reporter_id, relationship_id, message_id, reported_user_id, reason, details, message_snapshot)
  values (v_uid, p_relationship, p_message, case when v_uid = r.client_id then r.coach_id else r.client_id end,
          p_reason, v_details, m.body)
  on conflict do nothing;
end $$;

/* =================================================================== admin */

create or replace function public.admin_list_coach_applications(p_filter text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.require_admin();
begin
  if p_filter is not null and p_filter not in ('all', 'draft', 'submitted', 'changes_requested', 'approved', 'rejected',
                                               'suspended', 'qualifications_pending') then
    raise exception 'Unknown filter.' using errcode = 'P0001';
  end if;
  return coalesce((select jsonb_agg(private.coach_profile_json(c.user_id)
                                    order by c.submitted_at asc nulls last, c.updated_at desc)
                     from (select * from public.coach_profiles x
                            where case coalesce(p_filter, 'all')
                                    when 'all' then x.status <> 'draft'
                                    when 'suspended' then x.suspended
                                    when 'qualifications_pending' then x.status <> 'draft' and exists (
                                      select 1 from public.coach_qualifications q where q.coach_id = x.user_id and q.review_status = 'pending')
                                    else x.status = p_filter end
                            order by x.submitted_at asc nulls last limit 500) c), '[]'::jsonb);
end $$;

create or replace function public.admin_get_coach_application(p_coach uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.require_admin();
begin
  if not exists (select 1 from public.coach_profiles where user_id = p_coach) then return null; end if;
  return jsonb_build_object(
    'profile', private.coach_profile_json(p_coach),
    'events', coalesce((select jsonb_agg(private.review_event_json(e, true) order by e.created_at desc, e.id)
                          from public.coach_review_events e where e.coach_id = p_coach), '[]'::jsonb));
end $$;

-- Every admin action is logged (actor, time, reason) and notifies the applicant in-app. Suspension and
-- reinstatement also notify the coach's active clients (coach_status). No admin access to client records.
create or replace function public.admin_review_coach(p_coach uuid, p_action text, p_reason text default null,
                                                     p_qualification uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_admin uuid := private.require_admin();
  c public.coach_profiles;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_to text;
  v_client uuid;
begin
  select * into c from public.coach_profiles where user_id = p_coach for update;
  if c.user_id is null then raise exception 'Application not found.' using errcode = 'P0001'; end if;
  if p_coach = v_admin then raise exception 'You can''t review your own application.' using errcode = '42501'; end if;
  if char_length(v_reason) > 2000 then raise exception 'The reason can be at most 2000 characters.' using errcode = 'P0001'; end if;
  v_to := c.status;
  case p_action
    when 'approve' then
      if c.status <> 'submitted' then raise exception 'Only a submitted application can be approved.' using errcode = 'P0001'; end if;
      v_to := 'approved';
      update public.coach_profiles set status = 'approved', reviewed_at = now(), approved_at = coalesce(approved_at, now()),
                                       latest_feedback = v_reason where user_id = p_coach;
    when 'request_changes' then
      if c.status <> 'submitted' then raise exception 'Changes can only be requested on a submitted application.' using errcode = 'P0001'; end if;
      if v_reason is null then raise exception 'Tell the applicant what to change.' using errcode = 'P0001'; end if;
      v_to := 'changes_requested';
      update public.coach_profiles set status = 'changes_requested', reviewed_at = now(), latest_feedback = v_reason where user_id = p_coach;
    when 'reject' then
      if c.status not in ('submitted', 'changes_requested') then
        raise exception 'Only a pending application can be rejected.' using errcode = 'P0001';
      end if;
      if v_reason is null then raise exception 'A reason is required to reject an application.' using errcode = 'P0001'; end if;
      v_to := 'rejected';
      update public.coach_profiles set status = 'rejected', reviewed_at = now(), latest_feedback = v_reason where user_id = p_coach;
    when 'suspend' then
      if c.suspended then raise exception 'This coach is already suspended.' using errcode = 'P0001'; end if;
      if v_reason is null then raise exception 'A reason is required to suspend a coach.' using errcode = 'P0001'; end if;
      update public.coach_profiles set suspended = true, suspended_reason = v_reason, suspended_at = now(), reviewed_at = now()
       where user_id = p_coach;
    when 'reinstate' then
      if not c.suspended then raise exception 'This coach isn''t suspended.' using errcode = 'P0001'; end if;
      update public.coach_profiles set suspended = false, suspended_reason = null, suspended_at = null, reviewed_at = now()
       where user_id = p_coach;
    when 'approve_qualification', 'reject_qualification' then
      if p_qualification is null or not exists (select 1 from public.coach_qualifications q where q.id = p_qualification and q.coach_id = p_coach) then
        raise exception 'Qualification not found.' using errcode = 'P0001';
      end if;
      update public.coach_qualifications
         set review_status = case when p_action = 'approve_qualification' then 'approved' else 'rejected' end,
             review_note = v_reason, reviewed_by = v_admin, reviewed_at = now()
       where id = p_qualification;
    else
      raise exception 'Unknown review action.' using errcode = 'P0001';
  end case;
  insert into public.coach_review_events (coach_id, actor_id, action, reason, qualification_id, from_status, to_status)
  values (p_coach, v_admin, p_action, v_reason, p_qualification, c.status, v_to);
  perform private.coach_notify(p_coach, v_admin, case when p_action in ('suspend', 'reinstate') then 'coach_status' else 'coach_application' end,
                               null, p_coach, null);
  if p_action in ('suspend', 'reinstate') then
    for v_client in select r.client_id from public.coaching_relationships r where r.coach_id = p_coach and r.status = 'active' loop
      perform private.coach_notify(v_client, null, 'coach_status', (select r.id from public.coaching_relationships r
                                    where r.coach_id = p_coach and r.client_id = v_client and r.status = 'active'), p_coach, null);
    end loop;
  end if;
  return private.coach_profile_json(p_coach);
end $$;

create or replace function public.admin_list_coaching_reports(p_status text default 'open') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.require_admin();
begin
  if p_status is not null and p_status not in ('open', 'actioned', 'dismissed') then
    raise exception 'Unknown report status.' using errcode = 'P0001';
  end if;
  -- Only the reported message itself is shown to reviewers — never the rest of the conversation.
  return coalesce((select jsonb_agg(jsonb_build_object(
             'id', x.id, 'reporter_id', x.reporter_id, 'relationship_id', x.relationship_id, 'message_id', x.message_id,
             'reported_user_id', x.reported_user_id, 'reason', x.reason, 'details', x.details,
             'message_body', coalesce((select m.body from public.coach_messages m where m.id = x.message_id), x.message_snapshot),
             'coach_id', (select r.coach_id from public.coaching_relationships r where r.id = x.relationship_id),
             'status', x.status, 'created_at', x.created_at, 'resolved_by', x.resolved_by, 'resolved_at', x.resolved_at)
           order by x.created_at)
      from (select * from public.coaching_reports r where p_status is null or r.status = p_status order by r.created_at limit 500) x), '[]'::jsonb);
end $$;

-- p_action: 'dismiss' | 'actioned' | 'remove_message' (deletes the reported message, marks actioned).
create or replace function public.admin_resolve_coaching_report(p_id uuid, p_action text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_admin(); x public.coaching_reports;
begin
  if p_action is null or p_action not in ('dismiss', 'actioned', 'remove_message') then
    raise exception 'Unknown action.' using errcode = 'P0001';
  end if;
  select * into x from public.coaching_reports where id = p_id for update;
  if x.id is null then raise exception 'Report not found.' using errcode = 'P0001'; end if;
  if p_action = 'remove_message' and x.message_id is not null then
    delete from public.coach_messages where id = x.message_id;
  end if;
  update public.coaching_reports
     set status = case when p_action = 'dismiss' then 'dismissed' else 'actioned' end, resolved_by = v_uid, resolved_at = now()
   where id = p_id or (status = 'open' and x.message_id is not null and message_id = x.message_id);
end $$;

/* ================================================= Edge Function support */

-- geocode function: durable per-user quota (60 lookups / hour).
create or replace function public.coaching_geocode_quota() returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid();
begin
  perform private.enforce_rate_limit(v_uid, 'geocode', 60, interval '1 hour', 'Too many location searches. Please wait a few minutes.');
  return true;
end $$;

-- finalize-coach-media (service role): the message the caller wants to finalize, if they sent it and
-- the conversation is still writable.
create or replace function public.coach_media_pending(p_message uuid, p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare m public.coach_messages;
begin
  select * into m from public.coach_messages where id = p_message;
  if m.id is null or m.sender_id is distinct from p_user then raise exception 'Message not found.' using errcode = 'P0001'; end if;
  if m.status = 'sent' then return private.message_json(m); end if;
  if not private.is_relationship_participant(m.relationship_id, p_user, true) then
    raise exception 'This conversation is read-only now.' using errcode = '42501';
  end if;
  return private.message_json(m);
end $$;

-- finalize-coach-media (service role) AFTER validating every image + thumbnail. Idempotent.
-- p_media: [{ id, width, height }]. The message gets a fresh seq so pollers see it after its earlier peers.
create or replace function public.finalize_coach_message(p_message uuid, p_user uuid, p_media jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare m public.coach_messages; r public.coaching_relationships; v_media jsonb;
begin
  select * into m from public.coach_messages where id = p_message for update;
  if m.id is null or m.sender_id is distinct from p_user then raise exception 'Message not found.' using errcode = 'P0001'; end if;
  if m.status = 'sent' then return private.message_json(m) || jsonb_build_object('already', true); end if;
  if not private.is_relationship_participant(m.relationship_id, p_user, true) then
    raise exception 'This conversation is read-only now.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_media) is distinct from 'array'
     or exists (select 1 from jsonb_array_elements(m.media) d
                 where not exists (select 1 from jsonb_array_elements(p_media) e where lower(e ->> 'id') = d ->> 'id')) then
    raise exception 'Some photos have not finished uploading.' using errcode = 'P0001';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', d ->> 'id',
            'width', coalesce((select private.try_int(e ->> 'width') from jsonb_array_elements(p_media) e where lower(e ->> 'id') = d ->> 'id' limit 1), (d ->> 'width')::integer),
            'height', coalesce((select private.try_int(e ->> 'height') from jsonb_array_elements(p_media) e where lower(e ->> 'id') = d ->> 'id' limit 1), (d ->> 'height')::integer))
          order by o), '[]'::jsonb)
    into v_media from jsonb_array_elements(m.media) with ordinality t(d, o);
  update public.coach_messages set status = 'sent', media = v_media, seq = default where id = p_message returning * into m;
  select * into r from public.coaching_relationships where id = m.relationship_id;
  perform private.coach_notify(case when p_user = r.client_id then r.coach_id else r.client_id end, p_user, 'coach_message',
                               r.id, r.coach_id, null);
  return private.message_json(m) || jsonb_build_object('already', false);
end $$;

/* ================================= notifications list: include coaching ids */

-- Same behaviour as 20261028000005 plus the (nullable) coaching reference ids. Visibility is unchanged:
-- recipient only (private.notification_visible), so coaching notifications reach nobody else.
create or replace function public.list_notifications(p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid(); v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', n.id, 'type', n.type, 'actor', private.author_json(n.actor_id),
                                        'post_id', n.post_id, 'comment_id', n.comment_id, 'friendship_id', n.friendship_id,
                                        'relationship_id', n.relationship_id, 'coach_id', n.coach_id, 'proposal_id', n.proposal_id,
                                        'created_at', n.created_at, 'read_at', n.read_at) order by n.created_at desc, n.id)
      from (select * from public.notifications n
             where n.recipient_id = v_uid
               and private.notification_visible(n.recipient_id, n.actor_id, n.post_id, n.comment_id, v_uid)
             order by n.created_at desc, n.id limit v_limit) n), '[]'::jsonb);
end $$;

/* =================================================================== grants */

do $$
declare f text;
begin
  foreach f in array array[
    'public.my_roles()', 'public.get_my_coach_profile()', 'public.save_my_coach_profile(jsonb)',
    'public.submit_coach_application()', 'public.set_coach_listing(boolean, boolean)', 'public.my_coach_review_events()',
    'public.search_coaches(jsonb)', 'public.get_coach(uuid)',
    'public.request_coaching(uuid, uuid, jsonb, text, jsonb)', 'public.cancel_coaching_request(uuid)',
    'public.respond_coaching_request(uuid, boolean, text)', 'public.end_coaching(uuid, text)',
    'public.set_coaching_scopes(uuid, jsonb)', 'public.my_coaching_relationships()', 'public.coach_client_overview(uuid)',
    'public.save_program_proposal(jsonb)', 'public.send_program_proposal(uuid)', 'public.withdraw_program_proposal(uuid)',
    'public.list_program_proposals(jsonb)', 'public.get_program_proposal(uuid)',
    'public.respond_program_proposal(uuid, boolean, uuid, integer)',
    'public.add_coach_feedback(uuid, uuid, uuid, text)', 'public.list_coach_feedback(uuid)',
    'public.submit_checkin(uuid, uuid, jsonb, text)', 'public.list_checkins(uuid)', 'public.respond_checkin(uuid, text)',
    'public.list_coach_messages(uuid, bigint, integer)', 'public.send_coach_message(uuid, uuid, text, jsonb, boolean)',
    'public.mark_coach_messages_read(uuid, bigint)', 'public.unread_coaching_count()',
    'public.report_coaching_content(uuid, uuid, text, text)',
    'public.admin_list_coach_applications(text)', 'public.admin_get_coach_application(uuid)',
    'public.admin_review_coach(uuid, text, text, uuid)',
    'public.admin_list_coaching_reports(text)', 'public.admin_resolve_coaching_report(uuid, text)',
    'public.coaching_geocode_quota()', 'public.list_notifications(integer)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  foreach f in array array['public.coach_media_pending(uuid, uuid)', 'public.finalize_coach_message(uuid, uuid, jsonb)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
