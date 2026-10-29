-- Social schema: profiles, friendships, blocks, posts, media, likes, comments, notifications,
-- reports, app_roles + the private authorization helpers and RLS policies.
--
-- Model: mutual friends. A post is visible to its author, or — when audience = 'friends',
-- status = 'published' and not deleted — to accepted friends with no block in either direction.
-- Comments, likes, media rows and storage objects are visible only when the post is visible.
-- All social WRITES go through security-definer RPCs (next migration); clients get SELECT only.

/* ================================================================ tables */

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username extensions.citext not null,
  display_name text not null check (char_length(display_name) between 1 and 50),
  avatar_path text check (avatar_path is null or char_length(avatar_path) <= 200),
  bio text check (bio is null or char_length(bio) <= 280),
  interests text[] not null default '{}' check (cardinality(interests) <= 10),
  discoverable boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- citext's ~ operator is case-insensitive, so check the text form: lowercase only.
  constraint profiles_username_format check (username::text ~ '^[a-z0-9_]{3,20}$'),
  constraint profiles_username_unique unique (username)
);
comment on table public.profiles is
  'Discoverable social profile. Deliberately minimal: NO email, NO health/body data, NO role/permission columns.';

create table public.friendships (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles (id) on delete cascade,
  addressee_id uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  constraint friendships_no_self check (requester_id <> addressee_id)
);
-- One relationship per unordered pair (prevents A→B and B→A duplicates).
create unique index friendships_unique_pair
  on public.friendships (least(requester_id, addressee_id), greatest(requester_id, addressee_id));
create index friendships_addressee on public.friendships (addressee_id, status);
create index friendships_requester on public.friendships (requester_id, status);

create table public.blocks (
  blocker_id uuid not null references public.profiles (id) on delete cascade,
  blocked_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint blocks_no_self check (blocker_id <> blocked_id)
);
create index blocks_blocked on public.blocks (blocked_id);

create table public.posts (
  id uuid primary key,                       -- client-generated → idempotent create
  author_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('workout', 'activity', 'achievement', 'text')),
  audience text not null default 'friends' check (audience in ('only_me', 'friends')),
  caption text not null default '' check (char_length(caption) <= 2000),
  snapshot jsonb check (snapshot is null or (jsonb_typeof(snapshot) = 'object' and octet_length(snapshot::text) <= 20000)),
  status text not null default 'draft' check (status in ('draft', 'published')),
  created_at timestamptz not null default now(),
  published_at timestamptz,
  edited_at timestamptz,
  deleted_at timestamptz,
  removed_by_moderator boolean not null default false,
  media_cleaned_at timestamptz,
  constraint posts_published_has_time check (status = 'draft' or published_at is not null),
  constraint posts_id_author unique (id, author_id)
);
create index posts_feed on public.posts (author_id, published_at desc, id desc) where status = 'published' and deleted_at is null;
create index posts_cleanup_deleted on public.posts (deleted_at) where deleted_at is not null and media_cleaned_at is null;
create index posts_cleanup_drafts on public.posts (created_at) where status = 'draft' and deleted_at is null;

create table public.post_media (
  id uuid primary key,                       -- client-generated
  post_id uuid not null,
  owner_id uuid not null,
  position integer not null check (position between 0 and 3),   -- ⇒ at most 4 per post
  width integer not null check (width between 1 and 4096),
  height integer not null check (height between 1 and 4096),
  description text check (description is null or char_length(description) <= 500),
  status text not null default 'pending' check (status in ('pending', 'ready')),
  bytes integer,
  thumb_bytes integer,
  created_at timestamptz not null default now(),
  -- Storage paths are derived, never client-supplied: {owner_id}/{post_id}/{media_id}.jpg (+ _thumb)
  image_path text generated always as (owner_id::text || '/' || post_id::text || '/' || id::text || '.jpg') stored,
  thumb_path text generated always as (owner_id::text || '/' || post_id::text || '/' || id::text || '_thumb.jpg') stored,
  -- media owner must be the post author
  foreign key (post_id, owner_id) references public.posts (id, author_id) on delete cascade,
  constraint post_media_position_unique unique (post_id, position)
);
create index post_media_post on public.post_media (post_id);
create index post_media_image_path on public.post_media (image_path);
create index post_media_thumb_path on public.post_media (thumb_path);
create index post_media_owner_created on public.post_media (owner_id, created_at);

create table public.likes (
  post_id uuid not null references public.posts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)            -- one like per user per post
);
create index likes_user on public.likes (user_id);

create table public.comments (
  id uuid primary key,                       -- client-generated → idempotent add
  post_id uuid not null references public.posts (id) on delete cascade,
  author_id uuid not null references public.profiles (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles (id) on delete set null
);
create index comments_post on public.comments (post_id, created_at);
create index comments_author on public.comments (author_id);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  actor_id uuid references public.profiles (id) on delete cascade,
  type text not null check (type in ('friend_request', 'friend_accept', 'like', 'comment')),
  friendship_id uuid references public.friendships (id) on delete cascade,
  post_id uuid references public.posts (id) on delete cascade,
  comment_id uuid references public.comments (id) on delete cascade,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  constraint notifications_never_self check (actor_id is distinct from recipient_id)
);
create index notifications_recipient on public.notifications (recipient_id, created_at desc);
create unique index notifications_one_per_like on public.notifications (recipient_id, actor_id, post_id) where type = 'like';
create index notifications_post on public.notifications (post_id);
create index notifications_actor on public.notifications (actor_id);

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles (id) on delete cascade,
  target_kind text not null check (target_kind in ('post', 'comment', 'user')),
  target_key uuid not null,                  -- the reported id (kept for de-duplication)
  post_id uuid references public.posts (id) on delete set null,
  comment_id uuid references public.comments (id) on delete set null,
  user_id uuid references public.profiles (id) on delete set null,
  reason text not null check (reason in ('spam', 'harassment', 'inappropriate', 'other')),
  details text check (details is null or char_length(details) <= 1000),
  status text not null default 'open' check (status in ('open', 'actioned', 'dismissed')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles (id) on delete set null
);
create unique index reports_one_open_per_target on public.reports (reporter_id, target_key) where status = 'open';
create index reports_status on public.reports (status, created_at);
create index reports_post on public.reports (post_id);

-- Server-authorized roles. NOT writable by any client role; manage with the SQL editor / service role:
--   insert into public.app_roles (user_id, role) values ('<uuid>', 'moderator');
create table public.app_roles (
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('moderator')),
  granted_at timestamptz not null default now(),
  primary key (user_id, role)
);

/* ============================================== authorization helpers
   security definer + search_path = '' so they can read relationship tables without
   recursive RLS, live in the non-exposed `private` schema (not callable over the API). */

create or replace function private.are_friends(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select a is not null and b is not null and a <> b and exists (
    select 1 from public.friendships f
     where least(f.requester_id, f.addressee_id) = least(a, b)
       and greatest(f.requester_id, f.addressee_id) = greatest(a, b)
       and f.status = 'accepted')
$$;

create or replace function private.has_pending_request(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select a is not null and b is not null and exists (
    select 1 from public.friendships f
     where least(f.requester_id, f.addressee_id) = least(a, b)
       and greatest(f.requester_id, f.addressee_id) = greatest(a, b)
       and f.status = 'pending')
$$;

create or replace function private.is_blocked_between(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select a is not null and b is not null and exists (
    select 1 from public.blocks bl
     where (bl.blocker_id = a and bl.blocked_id = b) or (bl.blocker_id = b and bl.blocked_id = a))
$$;

create or replace function private.is_moderator(uid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select uid is not null and exists (select 1 from public.app_roles r where r.user_id = uid and r.role = 'moderator')
$$;

-- THE post visibility rule. Used by RLS on posts/post_media/likes/comments/notifications,
-- by storage.objects policies, and by every read RPC.
create or replace function private.can_view_post(p_post_id uuid, p_viewer uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_viewer is not null and exists (
    select 1 from public.posts p
     where p.id = p_post_id
       and p.deleted_at is null
       and (
         p.author_id = p_viewer
         or (p.status = 'published' and p.audience = 'friends'
             and private.are_friends(p.author_id, p_viewer)
             and not private.is_blocked_between(p.author_id, p_viewer))
         -- moderators may review posts that have been reported (and only those)
         or (p.status = 'published' and private.is_moderator(p_viewer)
             and exists (select 1 from public.reports r where r.post_id = p.id))
       ))
$$;

-- Direct SELECT on profiles: yourself, friends, and people with a pending request with you.
-- Everyone else goes through the exact-match lookup RPCs (no enumeration of the user base).
create or replace function private.profile_row_visible(p_target uuid, p_viewer uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_viewer is not null and (
    p_target = p_viewer
    or (not private.is_blocked_between(p_target, p_viewer)
        and (private.are_friends(p_target, p_viewer) or private.has_pending_request(p_target, p_viewer))))
$$;

-- Lookup visibility (profile page by id): row-visible OR discoverable and not blocked.
create or replace function private.can_view_profile(p_target uuid, p_viewer uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.profile_row_visible(p_target, p_viewer)
      or (p_viewer is not null and not private.is_blocked_between(p_target, p_viewer)
          and exists (select 1 from public.profiles p where p.id = p_target and p.discoverable))
$$;

-- Avatar objects: anyone who can see the profile, plus viewers of a post the person commented on.
create or replace function private.can_view_avatar(p_owner uuid, p_viewer uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.can_view_profile(p_owner, p_viewer)
      or (p_viewer is not null and not private.is_blocked_between(p_owner, p_viewer)
          and exists (select 1 from public.comments c
                       where c.author_id = p_owner and c.deleted_at is null
                         and private.can_view_post(c.post_id, p_viewer)))
$$;

create or replace function private.relation(p_viewer uuid, p_target uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when exists (select 1 from public.blocks b where b.blocker_id = p_viewer and b.blocked_id = p_target) then 'blocked'
    when exists (select 1 from public.blocks b where b.blocker_id = p_target and b.blocked_id = p_viewer) then 'blocked_by'
    when private.are_friends(p_viewer, p_target) then 'friends'
    when exists (select 1 from public.friendships f where f.requester_id = p_viewer and f.addressee_id = p_target and f.status = 'pending') then 'outgoing'
    when exists (select 1 from public.friendships f where f.requester_id = p_target and f.addressee_id = p_viewer and f.status = 'pending') then 'incoming'
    else 'none' end
$$;

create or replace function private.notification_visible(p_recipient uuid, p_actor uuid, p_post uuid, p_comment uuid, p_viewer uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_viewer is not null and p_recipient = p_viewer
     and (p_actor is null or not private.is_blocked_between(p_actor, p_viewer))
     and (p_post is null or private.can_view_post(p_post, p_viewer))
     and (p_comment is null or exists (select 1 from public.comments c where c.id = p_comment and c.deleted_at is null))
$$;

-- Storage helpers (object name → post_media row).
create or replace function private.can_view_post_media_object(p_name text, p_viewer uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_viewer is not null and exists (
    select 1 from public.post_media m
     where (m.image_path = p_name or m.thumb_path = p_name)
       and private.can_view_post(m.post_id, p_viewer))
$$;

-- Upload/overwrite only into your own folder, for a DRAFT post you author, at a path
-- that matches one of its post_media rows.
create or replace function private.can_write_post_media_object(p_name text, p_viewer uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_viewer is not null and exists (
    select 1 from public.post_media m join public.posts p on p.id = m.post_id
     where (m.image_path = p_name or m.thumb_path = p_name)
       and m.owner_id = p_viewer and p.author_id = p_viewer
       and p.status = 'draft' and p.deleted_at is null)
$$;

-- EXECUTE grants for these helpers: see …_lockdown.sql (policies run them as `authenticated`).

/* =========================================================== RLS + grants */

do $$
declare t text;
begin
  foreach t in array array['profiles','friendships','blocks','posts','post_media','likes','comments','notifications','reports','app_roles'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
  end loop;
end $$;

-- Read-only for signed-in users (RLS narrows rows). No INSERT/UPDATE/DELETE grants at all:
-- writes happen only inside the RPCs, which set author/owner ids from auth.uid().
grant select on public.profiles, public.friendships, public.blocks, public.posts, public.post_media,
  public.likes, public.comments, public.notifications, public.reports to authenticated;
-- app_roles: no grants to anon/authenticated whatsoever.

create policy "visible profiles" on public.profiles for select to authenticated
  using (private.profile_row_visible(id, (select auth.uid())));

create policy "own relationships" on public.friendships for select to authenticated
  using (requester_id = (select auth.uid()) or addressee_id = (select auth.uid()));

create policy "own blocks" on public.blocks for select to authenticated
  using (blocker_id = (select auth.uid()));

create policy "visible posts" on public.posts for select to authenticated
  using (private.can_view_post(id, (select auth.uid())));

create policy "media of visible posts" on public.post_media for select to authenticated
  using (private.can_view_post(post_id, (select auth.uid())));

create policy "likes on visible posts" on public.likes for select to authenticated
  using (private.can_view_post(post_id, (select auth.uid()))
         and not private.is_blocked_between(user_id, (select auth.uid())));

create policy "comments on visible posts" on public.comments for select to authenticated
  using (deleted_at is null
         and private.can_view_post(post_id, (select auth.uid()))
         and not private.is_blocked_between(author_id, (select auth.uid())));

create policy "recipient reads own notifications" on public.notifications for select to authenticated
  using (private.notification_visible(recipient_id, actor_id, post_id, comment_id, (select auth.uid())));

create policy "moderators read reports" on public.reports for select to authenticated
  using (private.is_moderator((select auth.uid())));

/* ============================================ notifications (server-created) */

create or replace function private.wants_notification(p_recipient uuid, p_type text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select private.try_bool(a.payload #>> array['settings', 'notifications',
             case p_type when 'like' then 'likes' when 'comment' then 'comments' else 'friendRequests' end])
      from public.account_state a where a.owner_id = p_recipient and a.deleted_at is null), true)
$$;

create or replace function private.notify(p_recipient uuid, p_actor uuid, p_type text, p_friendship uuid, p_post uuid, p_comment uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_recipient is null or p_actor is null or p_recipient = p_actor then return; end if;  -- never self
  if private.is_blocked_between(p_recipient, p_actor) then return; end if;                -- respect blocks
  if not private.wants_notification(p_recipient, p_type) then return; end if;             -- respect preferences
  insert into public.notifications (recipient_id, actor_id, type, friendship_id, post_id, comment_id)
  values (p_recipient, p_actor, p_type, p_friendship, p_post, p_comment)
  on conflict do nothing;
end $$;

create or replace function private.trg_friendship_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' and new.status = 'pending' then
    perform private.notify(new.addressee_id, new.requester_id, 'friend_request', new.id, null, null);
  elsif tg_op = 'UPDATE' and old.status = 'pending' and new.status = 'accepted' then
    perform private.notify(new.requester_id, new.addressee_id, 'friend_accept', new.id, null, null);
  end if;
  return null;
end $$;
create trigger friendship_notify after insert or update of status on public.friendships
  for each row execute function private.trg_friendship_notify();

create or replace function private.trg_like_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_author uuid;
begin
  select author_id into v_author from public.posts where id = coalesce(new.post_id, old.post_id);
  if tg_op = 'INSERT' then
    perform private.notify(v_author, new.user_id, 'like', null, new.post_id, null);
  elsif tg_op = 'DELETE' then
    delete from public.notifications n
     where n.type = 'like' and n.post_id = old.post_id and n.actor_id = old.user_id and n.recipient_id = v_author;
  end if;
  return null;
end $$;
create trigger like_notify after insert or delete on public.likes
  for each row execute function private.trg_like_notify();

create or replace function private.trg_comment_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_author uuid;
begin
  select author_id into v_author from public.posts where id = new.post_id;
  perform private.notify(v_author, new.author_id, 'comment', null, new.post_id, new.id);
  return null;
end $$;
create trigger comment_notify after insert on public.comments
  for each row execute function private.trg_comment_notify();

-- Keep updated_at honest on profiles.
create or replace function private.trg_touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;
create trigger profiles_touch before update on public.profiles for each row execute function private.trg_touch_updated_at();
