-- Coaching schema: admin role, coach applications/profiles, service areas, qualifications, review log,
-- coaching relationships + sharing scopes, program proposals (coach + AI rows), feedback, check-ins,
-- private 1:1 messages, coaching reports, notification columns, storage buckets + policies, and the
-- private authorization helpers that RLS / storage policies use.
--
-- Same conventions as the 2026-10-28 migrations: RLS on every table, revoke-all then grant SELECT only
-- (writes happen exclusively in security-definer RPCs, next migration), helpers in `private` with
-- search_path = ''. EXECUTE on private helpers is (re)locked in …04_coaching_lockdown.sql.
--
-- Authorization summary (see docs/BACKEND.md "Coaching"):
--   * A coach is ACTIVE when coach_profiles.status = 'approved' and not suspended. Checked on every request
--     against the current row, so suspension takes effect immediately, even for an open session.
--   * A coach can read a client's private records only through private.coach_can_access(viewer, client, scope):
--     an 'active' relationship + active coach + the client's scope flag + no block either way.
--     Friendship NEVER grants coaching access. Coaches have NO write path to client records.
--   * Admins (app_roles.role = 'admin') review applications and documents and handle coaching reports.
--     They get NO access to client health tables.

/* ===================================================================== roles */

-- Additive constraint swap: 'admin' joins 'moderator'. Still no client grants on app_roles.
alter table public.app_roles drop constraint if exists app_roles_role_check;
alter table public.app_roles add constraint app_roles_role_check check (role in ('moderator', 'admin'));

create or replace function private.is_admin(uid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select uid is not null and exists (select 1 from public.app_roles r where r.user_id = uid and r.role = 'admin')
$$;

/* ============================================================ text helpers */

-- Case- and diacritic-insensitive key for place / tag matching ("Reykjavík" = "reykjavik",
-- "Þórshöfn" = "thorshofn"). Self-contained (no unaccent dependency) and immutable.
create or replace function private.fold_text(t text) returns text
language sql immutable parallel safe set search_path = '' as $$
  select nullif(btrim(regexp_replace(lower(
           replace(replace(replace(replace(replace(replace(replace(replace(
             translate(t,
               'áàâäãåāăąÁÀÂÄÃÅĀĂĄçćčÇĆČďđðĎĐÐéèêëēėęěÉÈÊËĒĖĘĚíìîïīįıÍÌÎÏĪĮİñńňÑŃŇóòôöõøōőÓÒÔÖÕØŌŐŕřŔŘśšşŚŠŞťŤúùûüūůűųÚÙÛÜŪŮŰŲýÿÝŸžźżŽŹŻłŁğĞ',
               'aaaaaaaaaaaaaaaaaaccccccddddddeeeeeeeeeeeeeeeeiiiiiiiiiiiiiinnnnnnoooooooooooooooorrrrssssssttuuuuuuuuuuuuuuuuyyyyzzzzzzllgg'),
             'þ', 'th'), 'Þ', 'th'), 'æ', 'ae'), 'Æ', 'ae'), 'œ', 'oe'), 'Œ', 'oe'), 'ß', 'ss'), '''', '')),
           '[^a-z0-9]+', ' ', 'g')), '')
$$;

-- Great-circle distance in km.
create or replace function private.haversine_km(lat1 double precision, lng1 double precision,
                                                lat2 double precision, lng2 double precision) returns double precision
language sql immutable parallel safe set search_path = '' as $$
  select 2 * 6371.0088 * asin(least(1.0, sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2))))
$$;

/* ============================================================== coach tables */

create table public.coach_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 80),
  photo_path text check (photo_path is null or char_length(photo_path) <= 300),
  bio text not null default '' check (char_length(bio) <= 2000),
  experience_years integer check (experience_years is null or experience_years between 0 and 80),
  experience text not null default '' check (char_length(experience) <= 4000),
  specialties text[] not null default '{}' check (cardinality(specialties) <= 15),
  goals text[] not null default '{}' check (cardinality(goals) <= 15),
  languages text[] not null default '{}' check (cardinality(languages) <= 10),
  city text check (city is null or char_length(city) <= 100),
  region text check (region is null or char_length(region) <= 100),
  country text check (country is null or country ~ '^[A-Z]{2}$'),
  formats text[] not null default '{}' check (formats <@ array['in_person', 'online']::text[]),
  accepting_clients boolean not null default false,
  listed boolean not null default false,
  -- ↓ written ONLY by admin RPCs (and status 'submitted' by submit_coach_application). No client grants.
  status text not null default 'draft' check (status in ('draft', 'submitted', 'changes_requested', 'approved', 'rejected')),
  suspended boolean not null default false,
  suspended_reason text check (suspended_reason is null or char_length(suspended_reason) <= 2000),
  suspended_at timestamptz,
  submitted_at timestamptz,
  reviewed_at timestamptz,
  approved_at timestamptz,
  latest_feedback text check (latest_feedback is null or char_length(latest_feedback) <= 2000),
  -- ↑
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.coach_profiles is
  'Coach application + business profile. city/region/country are the coach''s chosen business location (no home address field). '
  'status/suspended*/reviewed_at/approved_at/latest_feedback are written only by admin RPCs.';
create index coach_profiles_directory on public.coach_profiles (status, suspended, listed);
create trigger coach_profiles_touch before update on public.coach_profiles
  for each row execute function private.trg_touch_updated_at();

create table public.coach_service_areas (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references public.coach_profiles (user_id) on delete cascade,
  position integer not null default 0,
  kind text not null check (kind in ('city', 'region', 'country')),
  city text check (city is null or char_length(city) <= 100),
  region text check (region is null or char_length(region) <= 100),
  country text not null check (country ~ '^[A-Z]{2}$'),
  -- Coordinates only from the configured geocoder (geo_source), stored rounded to 3 decimals (≈100 m).
  lat numeric(7, 4) check (lat is null or lat between -90 and 90),
  lng numeric(7, 4) check (lng is null or lng between -180 and 180),
  radius_km integer check (radius_km is null or radius_km between 1 and 500),
  label text check (label is null or char_length(label) <= 200),
  geo_source text check (geo_source is null or geo_source ~ '^geocoder(:[a-z0-9_-]{1,30})?$'),
  created_at timestamptz not null default now(),
  constraint coach_service_areas_coords_pair check ((lat is null) = (lng is null)),
  constraint coach_service_areas_coords_sourced check (lat is null or geo_source is not null),
  constraint coach_service_areas_kind_fields check (
    (kind <> 'city' or city is not null) and (kind <> 'region' or region is not null))
);
create index coach_service_areas_coach on public.coach_service_areas (coach_id, position);

create table public.coach_qualifications (
  id uuid primary key,                         -- client-generated (document path uses it)
  coach_id uuid not null references public.coach_profiles (user_id) on delete cascade,
  position integer not null default 0,
  title text not null check (char_length(title) between 1 and 200),
  issuer text check (issuer is null or char_length(issuer) <= 200),
  year integer check (year is null or year between 1950 and 2100),
  document_path text check (document_path is null or char_length(document_path) <= 400),
  document_name text check (document_name is null or char_length(document_name) <= 200),
  review_status text not null default 'pending' check (review_status in ('pending', 'approved', 'rejected')),
  review_note text check (review_note is null or char_length(review_note) <= 2000),
  reviewed_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index coach_qualifications_coach on public.coach_qualifications (coach_id, position);
create index coach_qualifications_pending on public.coach_qualifications (review_status) where review_status = 'pending';

-- A reviewed claim whose content changes goes back to 'pending' (not public until re-approved).
create or replace function private.trg_qualification_review_reset() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.title, new.issuer, new.year, new.document_path) is distinct from (old.title, old.issuer, old.year, old.document_path)
     and old.review_status <> 'pending' and new.review_status = old.review_status then
    new.review_status := 'pending';
    new.review_note := null;
    new.reviewed_by := null;
    new.reviewed_at := null;
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger coach_qualifications_review_reset before update on public.coach_qualifications
  for each row execute function private.trg_qualification_review_reset();

-- Append-only audit log of every application transition (submissions included). Definer-written only.
create table public.coach_review_events (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references public.coach_profiles (user_id) on delete cascade,
  actor_id uuid references auth.users (id) on delete set null,
  action text not null check (action in ('submitted', 'resubmitted', 'qualifications_changed', 'approve', 'request_changes',
                                         'reject', 'suspend', 'reinstate', 'approve_qualification', 'reject_qualification')),
  reason text check (reason is null or char_length(reason) <= 2000),
  qualification_id uuid,
  from_status text,
  to_status text,
  created_at timestamptz not null default now()
);
create index coach_review_events_coach on public.coach_review_events (coach_id, created_at desc);

/* ===================================================== coaching relationships */

create table public.coaching_relationships (
  id uuid primary key,                         -- client-generated → idempotent request
  coach_id uuid not null references public.coach_profiles (user_id) on delete cascade,
  client_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'requested' check (status in ('requested', 'active', 'declined', 'cancelled', 'ended')),
  intake jsonb not null default '{}' check (jsonb_typeof(intake) = 'object' and octet_length(intake::text) <= 8000),
  intro_message text not null default '' check (char_length(intro_message) <= 2000),
  response_message text check (response_message is null or char_length(response_message) <= 2000),
  requested_at timestamptz not null default now(),
  responded_at timestamptz,
  ended_at timestamptz,
  ended_by uuid references auth.users (id) on delete set null,
  end_reason text check (end_reason is null or char_length(end_reason) <= 500),
  constraint coaching_relationships_not_self check (coach_id <> client_id)
);
-- ONE primary human coach per client; one open request per (client, coach).
create unique index coaching_relationships_one_active on public.coaching_relationships (client_id) where status = 'active';
create unique index coaching_relationships_one_request on public.coaching_relationships (client_id, coach_id) where status = 'requested';
create index coaching_relationships_coach on public.coaching_relationships (coach_id, status);
create index coaching_relationships_client on public.coaching_relationships (client_id, status);

create table public.coaching_scopes (
  relationship_id uuid primary key references public.coaching_relationships (id) on delete cascade,
  training boolean not null default false,
  measurements boolean not null default false,
  nutrition boolean not null default false,
  checkins boolean not null default false,
  updated_at timestamptz not null default now()
);

/* ================================================================= programs */

create table public.program_proposals (
  id uuid primary key,
  author_kind text not null check (author_kind in ('coach', 'ai')),
  relationship_id uuid references public.coaching_relationships (id) on delete cascade, -- null for AI
  coach_id uuid references auth.users (id) on delete cascade,
  client_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'draft'
    check (status in ('draft', 'sent', 'accepted', 'declined', 'withdrawn', 'superseded', 'invalid')),
  base_program_id uuid,
  base_version integer,
  revision integer not null default 1 check (revision >= 1),
  program jsonb not null check (jsonb_typeof(program) = 'object' and octet_length(program::text) <= 262144),
  change_summary jsonb not null default '[]' check (jsonb_typeof(change_summary) = 'array'),
  message text check (message is null or char_length(message) <= 4000),
  effective_date date,
  target text not null default 'apply' check (target in ('apply', 'for_coach_review')),
  validation_errors jsonb not null default '[]' check (jsonb_typeof(validation_errors) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  responded_at timestamptz,
  applied_program_id uuid,
  applied_version integer,
  constraint program_proposals_coach_rows check (author_kind <> 'coach' or (relationship_id is not null and coach_id is not null))
);
create index program_proposals_relationship on public.program_proposals (relationship_id, base_program_id, created_at desc);
create index program_proposals_client on public.program_proposals (client_id, author_kind, created_at desc);
create index program_proposals_coach on public.program_proposals (coach_id, created_at desc);

create table public.coach_feedback (
  id uuid primary key,
  relationship_id uuid not null references public.coaching_relationships (id) on delete cascade,
  coach_id uuid not null references auth.users (id) on delete cascade,
  client_id uuid not null references auth.users (id) on delete cascade,
  session_id uuid,
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index coach_feedback_relationship on public.coach_feedback (relationship_id, created_at desc);

create table public.coach_checkins (
  id uuid primary key,
  relationship_id uuid not null references public.coaching_relationships (id) on delete cascade,
  client_id uuid not null references auth.users (id) on delete cascade,
  coach_id uuid not null references auth.users (id) on delete cascade,
  answers jsonb not null default '{}' check (jsonb_typeof(answers) = 'object' and octet_length(answers::text) <= 4000),
  note text check (note is null or char_length(note) <= 2000),
  coach_response text check (coach_response is null or char_length(coach_response) <= 2000),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create index coach_checkins_relationship on public.coach_checkins (relationship_id, created_at desc);

/* ================================================================= messages */

create table public.coach_messages (
  id uuid primary key,                         -- client-generated → idempotent send
  relationship_id uuid not null references public.coaching_relationships (id) on delete cascade,
  sender_id uuid not null references auth.users (id) on delete cascade,
  body text not null default '' check (char_length(body) <= 4000),
  media jsonb not null default '[]' check (jsonb_typeof(media) = 'array' and jsonb_array_length(media) <= 4),
  status text not null default 'sent' check (status in ('awaiting_media', 'sent')),
  shared_from_ai boolean not null default false,
  -- Server ordering. Re-issued (set to DEFAULT) when a media message is finalized so pollers using
  -- "seq > cursor" never miss a message that became visible late.
  seq bigint generated always as identity,
  created_at timestamptz not null default now(),
  constraint coach_messages_not_empty check (char_length(body) > 0 or jsonb_array_length(media) > 0)
);
create unique index coach_messages_seq on public.coach_messages (relationship_id, seq);
create index coach_messages_sender on public.coach_messages (sender_id);

create table public.coach_message_reads (
  relationship_id uuid not null references public.coaching_relationships (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  last_read_seq bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (relationship_id, user_id)
);

create table public.coaching_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users (id) on delete cascade,
  relationship_id uuid references public.coaching_relationships (id) on delete set null,
  message_id uuid references public.coach_messages (id) on delete set null,
  reported_user_id uuid references auth.users (id) on delete set null,
  reason text not null check (reason in ('spam', 'harassment', 'inappropriate', 'other')),
  details text check (details is null or char_length(details) <= 1000),
  -- copy of the reported message at report time, so a later edit/delete cannot hide it from review
  message_snapshot text check (message_snapshot is null or char_length(message_snapshot) <= 4000),
  status text not null default 'open' check (status in ('open', 'actioned', 'dismissed')),
  created_at timestamptz not null default now(),
  resolved_by uuid references auth.users (id) on delete set null,
  resolved_at timestamptz
);
create index coaching_reports_status on public.coaching_reports (status, created_at);
create unique index coaching_reports_one_open on public.coaching_reports
  (reporter_id, coalesce(message_id, relationship_id)) where status = 'open';

/* ============================================================ notifications */

alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type in (
  'friend_request', 'friend_accept', 'like', 'comment',
  'coach_request', 'coach_request_accepted', 'coach_request_declined', 'coach_request_cancelled', 'coach_ended',
  'coach_message', 'coach_proposal', 'coach_proposal_response', 'coach_checkin', 'coach_feedback',
  'coach_application', 'coach_status'));
alter table public.notifications
  add column if not exists relationship_id uuid references public.coaching_relationships (id) on delete cascade,
  add column if not exists coach_id uuid references auth.users (id) on delete cascade,
  add column if not exists proposal_id uuid references public.program_proposals (id) on delete cascade;
create index if not exists notifications_relationship on public.notifications (relationship_id) where relationship_id is not null;
create index if not exists notifications_coach on public.notifications (coach_id) where coach_id is not null;
create index if not exists notifications_proposal on public.notifications (proposal_id) where proposal_id is not null;

/* ===================================================== authorization helpers */

-- Approved and not suspended — evaluated against the CURRENT row on every request.
create or replace function private.coach_is_active(coach uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coach is not null and exists (
    select 1 from public.coach_profiles c where c.user_id = coach and c.status = 'approved' and not c.suspended)
$$;

-- THE coach read rule for a client's private records.
create or replace function private.coach_can_access(viewer uuid, client uuid, scope text) returns boolean
language sql stable security definer set search_path = '' as $$
  select viewer is not null and client is not null and viewer <> client
     and exists (
       select 1 from public.coaching_relationships r
         join public.coaching_scopes s on s.relationship_id = r.id
        where r.coach_id = viewer and r.client_id = client and r.status = 'active'
          and case scope when 'training' then s.training when 'measurements' then s.measurements
                         when 'nutrition' then s.nutrition when 'checkins' then s.checkins else false end)
     and private.coach_is_active(viewer)
     and not private.is_blocked_between(viewer, client)
$$;

-- writable ⇒ active relationship, active coach, no block.
-- readable ⇒ participant, status active/ended/declined/cancelled, and (viewer is the client or the coach is not suspended).
create or replace function private.is_relationship_participant(rel uuid, viewer uuid, writable boolean) returns boolean
language sql stable security definer set search_path = '' as $$
  select viewer is not null and exists (
    select 1 from public.coaching_relationships r join public.coach_profiles c on c.user_id = r.coach_id
     where r.id = rel and viewer in (r.coach_id, r.client_id)
       and case when writable
                then r.status = 'active' and c.status = 'approved' and not c.suspended
                     and not private.is_blocked_between(r.coach_id, r.client_id)
                else r.status in ('active', 'ended', 'declined', 'cancelled')
                     and (viewer = r.client_id or not c.suspended) end)
$$;

-- Relationship row (incl. intake) is visible to the client, and to the coach unless suspended.
create or replace function private.relationship_row_visible(p_coach uuid, p_client uuid, p_viewer uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_viewer is not null and (
    p_viewer = p_client
    or (p_viewer = p_coach and exists (select 1 from public.coach_profiles c where c.user_id = p_coach and not c.suspended)))
$$;

/* ---------------------------------------------------------- storage helpers */

-- coach-public: {coach_id}/photo_{uuid}.jpg — owner, admins, or anyone signed in when it is the CURRENT photo
-- of an approved, non-suspended coach that is listed (or already related to the viewer as their coach).
create or replace function private.can_view_coach_photo(p_name text, p_viewer uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_viewer is not null and (
    (storage.foldername(p_name))[1] = p_viewer::text
    or private.is_admin(p_viewer)
    or exists (
      select 1 from public.coach_profiles c
       where c.user_id = private.try_uuid((storage.foldername(p_name))[1])
         and c.photo_path = p_name and c.status = 'approved' and not c.suspended
         and not private.is_blocked_between(c.user_id, p_viewer)
         and (c.listed or exists (select 1 from public.coaching_relationships r
                                   where r.coach_id = c.user_id and r.client_id = p_viewer))))
$$;

-- coach-docs: {coach_id}/{qualification_id}/{filename} — the applicant and admins only.
create or replace function private.can_read_coach_doc(p_name text, p_viewer uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_viewer is not null and ((storage.foldername(p_name))[1] = p_viewer::text or private.is_admin(p_viewer))
$$;

-- coach-media: {relationship_id}/{message_id}/{media_id}.jpg | _thumb.jpg
create or replace function private.coach_media_parts(p_name text, out rel uuid, out msg uuid, out media text)
language sql immutable set search_path = '' as $$
  select case when array_length(string_to_array(p_name, '/'), 1) = 3 then private.try_uuid(split_part(p_name, '/', 1)) end,
         case when array_length(string_to_array(p_name, '/'), 1) = 3 then private.try_uuid(split_part(p_name, '/', 2)) end,
         (regexp_match(split_part(p_name, '/', 3), '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(_thumb)?\.jpg$'))[1]
$$;

-- Upload only by the sender, for a message still awaiting media, while the conversation is writable,
-- at a path that matches one of the message's declared media ids.
create or replace function private.can_write_coach_media_object(p_name text, p_viewer uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_viewer is not null and exists (
    select 1 from private.coach_media_parts(p_name) x
      join public.coach_messages m on m.id = x.msg and m.relationship_id = x.rel
     where x.media is not null and m.sender_id = p_viewer and m.status = 'awaiting_media'
       and m.media @> jsonb_build_array(jsonb_build_object('id', x.media))
       and private.is_relationship_participant(x.rel, p_viewer, true))
$$;

-- Read/sign only by participants who can currently read the conversation; others' media only once sent.
create or replace function private.can_view_coach_media_object(p_name text, p_viewer uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_viewer is not null and exists (
    select 1 from private.coach_media_parts(p_name) x
      join public.coach_messages m on m.id = x.msg and m.relationship_id = x.rel
     where x.media is not null and (m.status = 'sent' or m.sender_id = p_viewer)
       and m.media @> jsonb_build_array(jsonb_build_object('id', x.media))
       and private.is_relationship_participant(x.rel, p_viewer, false))
$$;

/* ============================================================ RLS + grants */

do $$
declare t text;
begin
  foreach t in array array['coach_profiles', 'coach_service_areas', 'coach_qualifications', 'coach_review_events',
                           'coaching_relationships', 'coaching_scopes', 'program_proposals', 'coach_feedback',
                           'coach_checkins', 'coach_messages', 'coach_message_reads', 'coaching_reports'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
  end loop;
end $$;

-- Applicant's own rows + admins (the public directory goes through search_coaches / get_coach,
-- which never return private columns).
create policy "coach reads own profile; admins read all" on public.coach_profiles for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin((select auth.uid())));
create policy "coach reads own areas; admins read all" on public.coach_service_areas for select to authenticated
  using (coach_id = (select auth.uid()) or private.is_admin((select auth.uid())));
create policy "coach reads own qualifications; admins read all" on public.coach_qualifications for select to authenticated
  using (coach_id = (select auth.uid()) or private.is_admin((select auth.uid())));
create policy "coach reads own review events; admins read all" on public.coach_review_events for select to authenticated
  using (coach_id = (select auth.uid()) or private.is_admin((select auth.uid())));

create policy "participants read relationships" on public.coaching_relationships for select to authenticated
  using (private.relationship_row_visible(coach_id, client_id, (select auth.uid())));
create policy "participants read scopes" on public.coaching_scopes for select to authenticated
  using (exists (select 1 from public.coaching_relationships r where r.id = relationship_id
                  and private.relationship_row_visible(r.coach_id, r.client_id, (select auth.uid()))));

create policy "client reads sent coach proposals and own ai proposals; active coach reads own" on public.program_proposals
  for select to authenticated
  using ((client_id = (select auth.uid()) and (author_kind = 'ai' or status <> 'draft'))
         or (author_kind = 'coach' and coach_id = (select auth.uid()) and private.coach_is_active((select auth.uid()))));

create policy "participants read feedback" on public.coach_feedback for select to authenticated
  using (private.is_relationship_participant(relationship_id, (select auth.uid()), false));

create policy "client reads own check-ins; coach with checkins scope" on public.coach_checkins for select to authenticated
  using (client_id = (select auth.uid())
         or (coach_id = (select auth.uid()) and private.coach_can_access((select auth.uid()), client_id, 'checkins')));

create policy "participants read messages" on public.coach_messages for select to authenticated
  using ((status = 'sent' or sender_id = (select auth.uid()))
         and private.is_relationship_participant(relationship_id, (select auth.uid()), false));

create policy "own read markers" on public.coach_message_reads for select to authenticated
  using (user_id = (select auth.uid()));

create policy "admins read coaching reports" on public.coaching_reports for select to authenticated
  using (private.is_admin((select auth.uid())));

/* --------------------- additive coach SELECT policies on existing private tables
   OR'd with "owner can read". NOT on account_state (the coach sees the client's intake instead). */
do $$
declare t text;
begin
  foreach t in array array['workout_sessions', 'activities', 'programs', 'goals'] loop
    execute format('create policy "active coach reads (training scope)" on public.%I for select to authenticated
                      using (deleted_at is null and private.coach_can_access((select auth.uid()), owner_id, ''training''))', t);
  end loop;
  foreach t in array array['session_exercises', 'session_sets', 'program_versions'] loop
    execute format('create policy "active coach reads (training scope)" on public.%I for select to authenticated
                      using (private.coach_can_access((select auth.uid()), owner_id, ''training''))', t);
  end loop;
end $$;
create policy "active coach reads (measurements scope)" on public.measurements for select to authenticated
  using (deleted_at is null and private.coach_can_access((select auth.uid()), owner_id, 'measurements'));
create policy "active coach reads (nutrition scope)" on public.food_logs for select to authenticated
  using (deleted_at is null and private.coach_can_access((select auth.uid()), owner_id, 'nutrition'));

/* ================================================================= storage */

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('coach-public', 'coach-public', false, 2097152, array['image/jpeg', 'image/webp']),
       ('coach-docs', 'coach-docs', false, 10485760, array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']),
       ('coach-media', 'coach-media', false, 5242880, array['image/jpeg', 'image/webp'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- coach-public (photos)
create policy "liftcircle coach-public insert: own photo" on storage.objects for insert to authenticated
  with check (bucket_id = 'coach-public'
              and name ~ ('^' || (select auth.uid())::text || '/photo_[0-9a-f-]{36}\.jpg$'));
create policy "liftcircle coach-public update: own photo" on storage.objects for update to authenticated
  using (bucket_id = 'coach-public' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'coach-public'
              and name ~ ('^' || (select auth.uid())::text || '/photo_[0-9a-f-]{36}\.jpg$'));
create policy "liftcircle coach-public select: visible coaches" on storage.objects for select to authenticated
  using (bucket_id = 'coach-public' and private.can_view_coach_photo(name, (select auth.uid())));
create policy "liftcircle coach-public delete: own" on storage.objects for delete to authenticated
  using (bucket_id = 'coach-public' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- coach-docs (qualification documents; applicant + admins)
create policy "liftcircle coach-docs insert: own folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'coach-docs'
              and name ~ ('^' || (select auth.uid())::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[^/]{1,200}$'));
create policy "liftcircle coach-docs update: own folder" on storage.objects for update to authenticated
  using (bucket_id = 'coach-docs' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'coach-docs'
              and name ~ ('^' || (select auth.uid())::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[^/]{1,200}$'));
create policy "liftcircle coach-docs select: owner and admins" on storage.objects for select to authenticated
  using (bucket_id = 'coach-docs' and private.can_read_coach_doc(name, (select auth.uid())));
create policy "liftcircle coach-docs delete: own" on storage.objects for delete to authenticated
  using (bucket_id = 'coach-docs' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- coach-media (chat attachments). No client DELETE: account deletion / relationship cascade handles rows.
create policy "liftcircle coach-media insert: sender while writable" on storage.objects for insert to authenticated
  with check (bucket_id = 'coach-media' and private.can_write_coach_media_object(name, (select auth.uid())));
create policy "liftcircle coach-media update: sender while writable" on storage.objects for update to authenticated
  using (bucket_id = 'coach-media' and private.can_write_coach_media_object(name, (select auth.uid())))
  with check (bucket_id = 'coach-media' and private.can_write_coach_media_object(name, (select auth.uid())));
create policy "liftcircle coach-media select: readable participants" on storage.objects for select to authenticated
  using (bucket_id = 'coach-media' and private.can_view_coach_media_object(name, (select auth.uid())));
