-- Social RPCs. Every function:
--   * is security definer with search_path = '' (all names schema-qualified),
--   * derives the caller from auth.uid() (author_id/owner_id are never client-supplied),
--   * raises user-readable errors (P0001 validation, 42501 auth, PT429 rate limit),
--   * has EXECUTE revoked from public/anon and granted to authenticated (bottom of file).

/* ============================================================ JSON helpers */

create or replace function private.require_profile(p_uid uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.profiles where id = p_uid) then
    raise exception 'Set up your profile first.' using errcode = 'P0001';
  end if;
end $$;

create or replace function private.author_json(p_uid uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', p.id, 'username', p.username::text, 'display_name', p.display_name, 'avatar_path', p.avatar_path)
    from public.profiles p where p.id = p_uid
$$;

create or replace function private.profile_json(p_uid uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', p.id, 'username', p.username::text, 'display_name', p.display_name,
                            'avatar_path', p.avatar_path, 'bio', p.bio, 'interests', to_jsonb(p.interests),
                            'discoverable', p.discoverable)
    from public.profiles p where p.id = p_uid
$$;

create or replace function private.post_json(p public.posts, p_viewer uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id,
    'author_id', p.author_id,
    'author', private.author_json(p.author_id),
    'kind', p.kind,
    'audience', p.audience,
    'caption', p.caption,
    'snapshot', p.snapshot,
    'status', p.status,
    'created_at', coalesce(p.published_at, p.created_at),
    'edited_at', p.edited_at,
    'media', coalesce((
      select jsonb_agg(jsonb_build_object('id', m.id, 'position', m.position, 'description', m.description,
                                          'width', m.width, 'height', m.height, 'status', m.status,
                                          'image_path', m.image_path, 'thumb_path', m.thumb_path) order by m.position)
        from public.post_media m where m.post_id = p.id), '[]'::jsonb),
    'like_count', (select count(*) from public.likes l
                    where l.post_id = p.id and not private.is_blocked_between(l.user_id, p_viewer)),
    'comment_count', (select count(*) from public.comments c
                       where c.post_id = p.id and c.deleted_at is null and not private.is_blocked_between(c.author_id, p_viewer)),
    'liked_by_me', exists (select 1 from public.likes l where l.post_id = p.id and l.user_id = p_viewer))
$$;

create or replace function private.comment_json(c public.comments) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', c.id, 'post_id', c.post_id, 'author_id', c.author_id,
                            'author', private.author_json(c.author_id), 'body', c.body, 'created_at', c.created_at)
$$;

create or replace function private.request_json(f public.friendships, p_viewer uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', f.id, 'requester_id', f.requester_id, 'addressee_id', f.addressee_id,
    'status', f.status, 'created_at', f.created_at,
    'other', private.author_json(case when f.requester_id = p_viewer then f.addressee_id else f.requester_id end))
$$;

create or replace function private.pair_friendship(a uuid, b uuid) returns public.friendships
language sql stable security definer set search_path = '' as $$
  select f.* from public.friendships f
   where least(f.requester_id, f.addressee_id) = least(a, b) and greatest(f.requester_id, f.addressee_id) = greatest(a, b)
$$;

/* ================================================================ profiles */

create or replace function public.get_my_profile() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  return private.profile_json(private.require_uid());
end $$;

create or replace function public.is_username_available(p_username text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid(); v_name text := lower(btrim(coalesce(p_username, '')));
begin
  if v_name !~ '^[a-z0-9_]{3,20}$' then return false; end if;
  return not exists (select 1 from public.profiles p
                      where p.username operator(extensions.=) v_name::extensions.citext and p.id <> v_uid);
end $$;

create or replace function public.save_my_profile(p_username text, p_display_name text, p_bio text default null,
                                                  p_interests text[] default '{}', p_discoverable boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_name text := lower(btrim(coalesce(p_username, '')));
  v_display text := btrim(coalesce(p_display_name, ''));
  v_bio text := nullif(btrim(coalesce(p_bio, '')), '');
  v_interests text[];
begin
  if v_name !~ '^[a-z0-9_]{3,20}$' then
    raise exception 'Usernames are 3–20 characters: lowercase letters, numbers and underscores.' using errcode = 'P0001';
  end if;
  if char_length(v_display) not between 1 and 50 then
    raise exception 'Display name must be 1–50 characters.' using errcode = 'P0001';
  end if;
  if v_bio is not null and char_length(v_bio) > 280 then
    raise exception 'Bio can be at most 280 characters.' using errcode = 'P0001';
  end if;
  select coalesce(array_agg(distinct left(btrim(i), 30)) filter (where btrim(i) <> ''), '{}')
    into v_interests from unnest(coalesce(p_interests, '{}')) as i;
  if cardinality(v_interests) > 10 then
    raise exception 'Choose at most 10 interests.' using errcode = 'P0001';
  end if;
  begin
    insert into public.profiles (id, username, display_name, bio, interests, discoverable)
    values (v_uid, v_name::extensions.citext, v_display, v_bio, v_interests, coalesce(p_discoverable, true))
    on conflict (id) do update
      set username = excluded.username, display_name = excluded.display_name, bio = excluded.bio,
          interests = excluded.interests, discoverable = excluded.discoverable;
  exception when unique_violation then
    raise exception 'That username is taken.' using errcode = 'P0001';
  end;
  return private.profile_json(v_uid);
end $$;

create or replace function public.set_avatar_path(p_path text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid();
begin
  perform private.require_profile(v_uid);
  if p_path is not null and p_path !~ ('^' || v_uid::text || '/avatar_[0-9a-f-]{36}\.jpg$') then
    raise exception 'Invalid avatar path.' using errcode = 'P0001';
  end if;
  update public.profiles set avatar_path = p_path where id = v_uid;
  return private.profile_json(v_uid);
end $$;

-- Exact username lookup. null if not found, blocked either way, or not discoverable
-- (a non-discoverable profile is findable only by existing friends).
create or replace function public.get_profile_by_username(p_username text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_id uuid;
  v_discoverable boolean;
  v_rel text;
begin
  select p.id, p.discoverable into v_id, v_discoverable from public.profiles p
   where p.username operator(extensions.=) lower(btrim(coalesce(p_username, '')))::extensions.citext;
  if v_id is null then return null; end if;
  if v_id = v_uid then
    return jsonb_build_object('profile', private.profile_json(v_id), 'relation', 'none');
  end if;
  v_rel := private.relation(v_uid, v_id);
  if v_rel in ('blocked', 'blocked_by') then return null; end if;
  if not v_discoverable and v_rel <> 'friends' then return null; end if;
  return jsonb_build_object('profile', private.profile_json(v_id), 'relation', v_rel,
    'request_id', case when v_rel in ('outgoing', 'incoming') then (private.pair_friendship(v_uid, v_id)).id end);
end $$;

create or replace function public.get_profile_by_id(p_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid(); v_rel text;
begin
  if not exists (select 1 from public.profiles where id = p_user_id) then return null; end if;
  if p_user_id = v_uid then
    return jsonb_build_object('profile', private.profile_json(v_uid), 'relation', 'none');
  end if;
  v_rel := private.relation(v_uid, p_user_id);
  if v_rel = 'blocked_by' then return null; end if;
  if v_rel = 'blocked' then  -- the blocker may see who they blocked (to unblock), nothing more
    return jsonb_build_object('profile', private.author_json(p_user_id) || jsonb_build_object('bio', null, 'interests', '[]'::jsonb, 'discoverable', false),
                              'relation', 'blocked');
  end if;
  if not private.can_view_profile(p_user_id, v_uid) then return null; end if;
  return jsonb_build_object('profile', private.profile_json(p_user_id), 'relation', v_rel,
    'request_id', case when v_rel in ('outgoing', 'incoming') then (private.pair_friendship(v_uid, p_user_id)).id end);
end $$;

/* ================================================================= friends */

create or replace function public.send_friend_request(p_target uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid(); f public.friendships;
begin
  perform private.require_profile(v_uid);
  if p_target is null or p_target = v_uid then
    raise exception 'You can''t send a friend request to yourself.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.blocks where blocker_id = v_uid and blocked_id = p_target) then
    raise exception 'Unblock this person before sending a friend request.' using errcode = 'P0001';
  end if;
  if not private.can_view_profile(p_target, v_uid) then  -- also covers "they blocked you" without revealing it
    raise exception 'User not found.' using errcode = 'P0001';
  end if;
  -- serialize concurrent requests for this pair
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('pair:' || least(v_uid, p_target)::text || greatest(v_uid, p_target)::text, 0));
  f := private.pair_friendship(v_uid, p_target);
  if f.id is not null then
    if f.status = 'accepted' then
      return jsonb_build_object('id', f.id, 'status', 'accepted');                 -- already friends
    elsif f.requester_id = v_uid then
      return jsonb_build_object('id', f.id, 'status', 'pending');                  -- idempotent retry
    else
      -- they already asked us: sending back means accepting (we are the addressee)
      update public.friendships set status = 'accepted', responded_at = now() where id = f.id;
      return jsonb_build_object('id', f.id, 'status', 'accepted');
    end if;
  end if;
  perform private.enforce_rate_limit(v_uid, 'friend_request', 50, interval '1 day',
    'You''ve sent a lot of friend requests today. Please try again tomorrow.');
  insert into public.friendships (requester_id, addressee_id) values (v_uid, p_target) returning * into f;
  return jsonb_build_object('id', f.id, 'status', 'pending');
end $$;

create or replace function public.respond_friend_request(p_request_id uuid, p_accept boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid(); f public.friendships;
begin
  select * into f from public.friendships where id = p_request_id for update;
  if f.id is null then
    if not coalesce(p_accept, false) then return; end if; -- declining twice is a no-op
    raise exception 'Friend request not found.' using errcode = 'P0001';
  end if;
  -- ONLY the addressee may respond (the requester cannot accept their own request).
  if f.addressee_id <> v_uid then
    raise exception 'Friend request not found.' using errcode = 'P0001';
  end if;
  if f.status = 'accepted' then
    if coalesce(p_accept, false) then return; end if; -- idempotent accept
    raise exception 'You are already friends. Remove the friend instead.' using errcode = 'P0001';
  end if;
  if coalesce(p_accept, false) then
    update public.friendships set status = 'accepted', responded_at = now() where id = f.id;
  else
    delete from public.friendships where id = f.id;
  end if;
end $$;

create or replace function public.cancel_friend_request(p_request_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid();
begin
  delete from public.friendships where id = p_request_id and requester_id = v_uid and status = 'pending';
end $$;

create or replace function public.remove_friend(p_other uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid();
begin
  delete from public.friendships f
   where least(f.requester_id, f.addressee_id) = least(v_uid, p_other)
     and greatest(f.requester_id, f.addressee_id) = greatest(v_uid, p_other);
end $$;

create or replace function public.block_user(p_other uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid();
begin
  perform private.require_profile(v_uid);
  if p_other is null or p_other = v_uid then
    raise exception 'You can''t block yourself.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.profiles where id = p_other) then
    raise exception 'User not found.' using errcode = 'P0001';
  end if;
  insert into public.blocks (blocker_id, blocked_id) values (v_uid, p_other) on conflict do nothing;
  -- Blocking ends the friendship and any pending request in either direction …
  delete from public.friendships f
   where least(f.requester_id, f.addressee_id) = least(v_uid, p_other)
     and greatest(f.requester_id, f.addressee_id) = greatest(v_uid, p_other);
  -- … and clears notifications between the two accounts.
  delete from public.notifications n
   where (n.recipient_id = v_uid and n.actor_id = p_other) or (n.recipient_id = p_other and n.actor_id = v_uid);
end $$;

create or replace function public.unblock_user(p_other uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid();
begin
  delete from public.blocks where blocker_id = v_uid and blocked_id = p_other;
end $$;

create or replace function public.list_friends() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid();
begin
  return coalesce((
    select jsonb_agg(private.profile_json(x.other) order by lower(pr.display_name), pr.username::text)
      from (select case when f.requester_id = v_uid then f.addressee_id else f.requester_id end as other
              from public.friendships f
             where f.status = 'accepted' and (f.requester_id = v_uid or f.addressee_id = v_uid)) x
      join public.profiles pr on pr.id = x.other
     where not private.is_blocked_between(x.other, v_uid)), '[]'::jsonb);
end $$;

create or replace function public.list_friend_requests() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid();
begin
  return jsonb_build_object(
    'incoming', coalesce((select jsonb_agg(private.request_json(f, v_uid) order by f.created_at desc)
                            from public.friendships f where f.addressee_id = v_uid and f.status = 'pending'), '[]'::jsonb),
    'outgoing', coalesce((select jsonb_agg(private.request_json(f, v_uid) order by f.created_at desc)
                            from public.friendships f where f.requester_id = v_uid and f.status = 'pending'), '[]'::jsonb));
end $$;

create or replace function public.list_blocked() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid();
begin
  return coalesce((
    select jsonb_agg(private.author_json(b.blocked_id) || jsonb_build_object('bio', null, 'interests', '[]'::jsonb, 'discoverable', false)
                     order by b.created_at desc)
      from public.blocks b where b.blocker_id = v_uid), '[]'::jsonb);
end $$;

/* =================================================================== posts */

-- Creates (or refreshes) an unpublished draft. Idempotent on p_id.
-- p_media: [{ "id": uuid, "position": 0-3, "width": int, "height": int, "description": text? }]
create or replace function public.create_post_draft(p_id uuid, p_kind text, p_audience text, p_caption text,
                                                    p_snapshot jsonb default null, p_media jsonb default '[]')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_post public.posts;
  v_media jsonb := coalesce(p_media, '[]'::jsonb);
  v_caption text := coalesce(p_caption, '');
  v_new_media integer;
  v_bad integer;
begin
  perform private.require_profile(v_uid);
  if p_id is null then raise exception 'Post id is required.' using errcode = 'P0001'; end if;
  if p_kind is null or p_kind not in ('workout', 'activity', 'achievement', 'text') then
    raise exception 'Unknown post type.' using errcode = 'P0001';
  end if;
  if p_audience is null or p_audience not in ('only_me', 'friends') then
    raise exception 'Choose who can see this post.' using errcode = 'P0001';
  end if;
  if char_length(v_caption) > 2000 then
    raise exception 'Captions can be at most 2000 characters.' using errcode = 'P0001';
  end if;
  if p_snapshot is not null and jsonb_typeof(p_snapshot) = 'null' then p_snapshot := null; end if;
  if p_snapshot is not null and (jsonb_typeof(p_snapshot) <> 'object' or octet_length(p_snapshot::text) > 20000) then
    raise exception 'The shared workout summary is invalid or too large.' using errcode = 'P0001';
  end if;
  if jsonb_typeof(v_media) <> 'array' then
    raise exception 'Invalid photo list.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(v_media) > 4 then
    raise exception 'A post can have at most 4 photos.' using errcode = 'P0001';
  end if;
  select count(*) into v_bad from jsonb_array_elements(v_media) e
   where jsonb_typeof(e) <> 'object'
      or private.try_uuid(e ->> 'id') is null
      or private.try_int(e ->> 'position') is null or private.try_int(e ->> 'position') not between 0 and 3
      or private.try_int(e ->> 'width') is null or private.try_int(e ->> 'width') not between 1 and 4096
      or private.try_int(e ->> 'height') is null or private.try_int(e ->> 'height') not between 1 and 4096
      or char_length(coalesce(e ->> 'description', '')) > 500;
  if v_bad > 0 then
    raise exception 'Photos must be at most 4096 px per side, with a description of at most 500 characters.' using errcode = 'P0001';
  end if;
  if (select count(distinct private.try_int(e ->> 'position')) from jsonb_array_elements(v_media) e) <> jsonb_array_length(v_media)
     or (select count(distinct e ->> 'id') from jsonb_array_elements(v_media) e) <> jsonb_array_length(v_media) then
    raise exception 'Each photo needs a unique id and position.' using errcode = 'P0001';
  end if;
  if exists (select 1 from jsonb_array_elements(v_media) e join public.post_media m on m.id = (e ->> 'id')::uuid
              where m.post_id <> p_id) then
    raise exception 'A photo id is already in use.' using errcode = 'P0001';
  end if;

  select * into v_post from public.posts where id = p_id for update;
  if v_post.id is not null then
    if v_post.author_id <> v_uid then
      raise exception 'This post id is already in use.' using errcode = 'P0001';
    end if;
    if v_post.deleted_at is not null then
      raise exception 'This post was deleted.' using errcode = 'P0001';
    end if;
    if v_post.status = 'published' then
      return jsonb_build_object('id', p_id, 'status', 'published'); -- retry after publish: no-op
    end if;
    update public.posts set kind = p_kind, audience = p_audience, caption = v_caption, snapshot = p_snapshot where id = p_id;
  else
    perform private.enforce_rate_limit(v_uid, 'post', 30, interval '1 hour',
      'You''re posting a lot. Please wait a while before posting again.');
    insert into public.posts (id, author_id, kind, audience, caption, snapshot, status)
    values (p_id, v_uid, p_kind, p_audience, v_caption, p_snapshot, 'draft');
  end if;

  select count(*) into v_new_media from jsonb_array_elements(v_media) e
   where not exists (select 1 from public.post_media m where m.id = (e ->> 'id')::uuid);
  perform private.enforce_rate_limit(v_uid, 'media_upload', 60, interval '1 hour',
    'You''ve uploaded a lot of photos in the last hour. Please try again later.', v_new_media);

  -- Replace the draft's media rows (ids are stable, storage paths derive from them).
  delete from public.post_media where post_id = p_id;
  insert into public.post_media (id, post_id, owner_id, position, width, height, description)
  select (e ->> 'id')::uuid, p_id, v_uid, (e ->> 'position')::int, (e ->> 'width')::int, (e ->> 'height')::int,
         nullif(btrim(coalesce(e ->> 'description', '')), '')
    from jsonb_array_elements(v_media) e;

  return jsonb_build_object('id', p_id, 'status', 'draft');
end $$;

create or replace function public.update_post(p_post_id uuid, p_caption text default null, p_audience text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid(); v_post public.posts;
begin
  select * into v_post from public.posts where id = p_post_id for update;
  -- only the author can edit; others get "not found" (no existence leak)
  if v_post.id is null or v_post.author_id <> v_uid or v_post.deleted_at is not null then
    raise exception 'Post not found.' using errcode = 'P0001';
  end if;
  if p_caption is not null and char_length(p_caption) > 2000 then
    raise exception 'Captions can be at most 2000 characters.' using errcode = 'P0001';
  end if;
  if p_audience is not null and p_audience not in ('only_me', 'friends') then
    raise exception 'Choose who can see this post.' using errcode = 'P0001';
  end if;
  update public.posts
     set caption = coalesce(p_caption, caption),
         audience = coalesce(p_audience, audience),
         edited_at = case when p_caption is not null and p_caption is distinct from caption then now() else edited_at end
   where id = p_post_id;
end $$;

-- Soft delete + remove likes, comments, media rows and notifications. Storage objects are
-- removed by the cleanup-media Edge Function (and immediately stop being signable: no media row).
create or replace function private.soft_delete_post(p_post_id uuid, p_by_moderator boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.posts set deleted_at = coalesce(deleted_at, now()), removed_by_moderator = removed_by_moderator or p_by_moderator
   where id = p_post_id;
  delete from public.notifications where post_id = p_post_id;
  delete from public.likes where post_id = p_post_id;
  delete from public.comments where post_id = p_post_id;
  delete from public.post_media where post_id = p_post_id;
end $$;

create or replace function public.delete_post(p_post_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid(); v_post public.posts;
begin
  select * into v_post from public.posts where id = p_post_id for update;
  if v_post.id is null or v_post.author_id <> v_uid then
    raise exception 'Post not found.' using errcode = 'P0001';
  end if;
  if v_post.deleted_at is not null then return; end if; -- idempotent
  perform private.soft_delete_post(p_post_id, false);
end $$;

create or replace function public.get_post(p_post_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid(); v_post public.posts;
begin
  if not private.can_view_post(p_post_id, v_uid) then return null; end if;
  select * into v_post from public.posts where id = p_post_id;
  return private.post_json(v_post, v_uid);
end $$;

-- Chronological feed of your own + accepted, non-blocked friends' visible posts.
-- Keyset pagination on (published_at desc, id desc).
create or replace function public.get_feed(p_cursor_created_at timestamptz default null, p_cursor_id uuid default null,
                                           p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_authors uuid[];
  v_items jsonb;
  v_n integer;
  v_last jsonb;
begin
  select array_agg(x) into v_authors from (
    select v_uid as x
    union
    select case when f.requester_id = v_uid then f.addressee_id else f.requester_id end
      from public.friendships f
     where f.status = 'accepted' and (f.requester_id = v_uid or f.addressee_id = v_uid)) s
   where s.x = v_uid or not private.is_blocked_between(s.x, v_uid);

  with page as (
    select p as post, p.published_at, p.id
      from public.posts p
     where p.author_id = any (v_authors)
       and p.status = 'published' and p.deleted_at is null
       and (p.author_id = v_uid or p.audience = 'friends')
       and (p_cursor_created_at is null
            or (p.published_at, p.id) < (p_cursor_created_at, coalesce(p_cursor_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
     order by p.published_at desc, p.id desc
     limit v_limit + 1)
  select coalesce(jsonb_agg(private.post_json(page.post, v_uid) order by page.published_at desc, page.id desc), '[]'::jsonb), count(*)
    into v_items, v_n from page;

  if v_n > v_limit then
    v_items := v_items - v_limit;
    v_last := v_items -> (v_limit - 1);
    return jsonb_build_object('items', v_items, 'next', jsonb_build_object('created_at', v_last -> 'created_at', 'id', v_last -> 'id'));
  end if;
  return jsonb_build_object('items', v_items, 'next', null);
end $$;

create or replace function public.get_user_posts(p_user_id uuid, p_cursor_created_at timestamptz default null,
                                                 p_cursor_id uuid default null, p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_items jsonb;
  v_n integer;
  v_last jsonb;
begin
  with page as (
    select p as post, p.published_at, p.id
      from public.posts p
     where p.author_id = p_user_id and p.status = 'published' and p.deleted_at is null
       and private.can_view_post(p.id, v_uid)
       and (p_cursor_created_at is null
            or (p.published_at, p.id) < (p_cursor_created_at, coalesce(p_cursor_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
     order by p.published_at desc, p.id desc
     limit v_limit + 1)
  select coalesce(jsonb_agg(private.post_json(page.post, v_uid) order by page.published_at desc, page.id desc), '[]'::jsonb), count(*)
    into v_items, v_n from page;
  if v_n > v_limit then
    v_items := v_items - v_limit;
    v_last := v_items -> (v_limit - 1);
    return jsonb_build_object('items', v_items, 'next', jsonb_build_object('created_at', v_last -> 'created_at', 'id', v_last -> 'id'));
  end if;
  return jsonb_build_object('items', v_items, 'next', null);
end $$;

/* ======================================================= likes & comments */

create or replace function public.like_post(p_post_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid();
begin
  perform private.require_profile(v_uid);
  if not exists (select 1 from public.posts p where p.id = p_post_id and p.status = 'published')
     or not private.can_view_post(p_post_id, v_uid) then
    raise exception 'Post not found.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.likes where post_id = p_post_id and user_id = v_uid) then return; end if; -- idempotent
  perform private.enforce_rate_limit(v_uid, 'like', 600, interval '1 hour', 'Too many likes. Please slow down.');
  insert into public.likes (post_id, user_id) values (p_post_id, v_uid) on conflict do nothing;
end $$;

create or replace function public.unlike_post(p_post_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid();
begin
  delete from public.likes where post_id = p_post_id and user_id = v_uid;
end $$;

-- Idempotent on p_id: retrying returns the existing comment instead of duplicating it.
create or replace function public.add_comment(p_post_id uuid, p_id uuid, p_body text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid(); v_body text := btrim(coalesce(p_body, '')); c public.comments;
begin
  perform private.require_profile(v_uid);
  if p_id is null then raise exception 'Comment id is required.' using errcode = 'P0001'; end if;
  select * into c from public.comments where id = p_id;
  if c.id is not null then
    if c.author_id <> v_uid or c.post_id <> p_post_id then
      raise exception 'This comment id is already in use.' using errcode = 'P0001';
    end if;
    if c.deleted_at is not null then
      raise exception 'This comment was deleted.' using errcode = 'P0001';
    end if;
    return private.comment_json(c);
  end if;
  if char_length(v_body) not between 1 and 1000 then
    raise exception 'Comments must be 1–1000 characters.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.posts p where p.id = p_post_id and p.status = 'published')
     or not private.can_view_post(p_post_id, v_uid) then
    raise exception 'Post not found.' using errcode = 'P0001';
  end if;
  perform private.enforce_rate_limit(v_uid, 'comment', 120, interval '1 hour',
    'You''re commenting a lot. Please wait a while before commenting again.');
  insert into public.comments (id, post_id, author_id, body) values (p_id, p_post_id, v_uid, v_body) returning * into c;
  return private.comment_json(c);
end $$;

-- The comment author, or the author of the post, can remove a comment.
create or replace function public.delete_comment(p_comment_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid(); c public.comments; v_post_author uuid;
begin
  select * into c from public.comments where id = p_comment_id for update;
  if c.id is not null then select author_id into v_post_author from public.posts where id = c.post_id; end if;
  if c.id is null or (c.author_id <> v_uid and v_post_author is distinct from v_uid) then
    raise exception 'Comment not found.' using errcode = 'P0001';
  end if;
  if c.deleted_at is not null then return; end if;
  update public.comments set deleted_at = now(), deleted_by = v_uid where id = p_comment_id;
  delete from public.notifications where comment_id = p_comment_id;
end $$;

create or replace function public.list_comments(p_post_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid();
begin
  if not private.can_view_post(p_post_id, v_uid) then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(private.comment_json(c) order by c.created_at, c.id)
      from public.comments c
     where c.post_id = p_post_id and c.deleted_at is null and not private.is_blocked_between(c.author_id, v_uid)), '[]'::jsonb);
end $$;

/* ================================================================= reports */

create or replace function public.report_content(p_reason text, p_post_id uuid default null, p_comment_id uuid default null,
                                                 p_user_id uuid default null, p_details text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_kind text;
  v_key uuid;
  v_details text := nullif(btrim(coalesce(p_details, '')), '');
begin
  perform private.require_profile(v_uid);
  if num_nonnulls(p_post_id, p_comment_id, p_user_id) <> 1 then
    raise exception 'Report exactly one post, comment or person.' using errcode = 'P0001';
  end if;
  if p_reason is null or p_reason not in ('spam', 'harassment', 'inappropriate', 'other') then
    raise exception 'Choose a reason for the report.' using errcode = 'P0001';
  end if;
  if v_details is not null and char_length(v_details) > 1000 then
    raise exception 'Report details can be at most 1000 characters.' using errcode = 'P0001';
  end if;
  if p_post_id is not null then
    if not private.can_view_post(p_post_id, v_uid) then raise exception 'Post not found.' using errcode = 'P0001'; end if;
    v_kind := 'post'; v_key := p_post_id;
  elsif p_comment_id is not null then
    if not exists (select 1 from public.comments c where c.id = p_comment_id and c.deleted_at is null
                     and private.can_view_post(c.post_id, v_uid)) then
      raise exception 'Comment not found.' using errcode = 'P0001';
    end if;
    v_kind := 'comment'; v_key := p_comment_id;
  else
    if p_user_id = v_uid or not exists (select 1 from public.profiles where id = p_user_id) then
      raise exception 'User not found.' using errcode = 'P0001';
    end if;
    v_kind := 'user'; v_key := p_user_id;
  end if;
  if exists (select 1 from public.reports r where r.reporter_id = v_uid and r.target_key = v_key and r.status = 'open') then
    return; -- already reported and still open: idempotent
  end if;
  perform private.enforce_rate_limit(v_uid, 'report', 20, interval '1 hour', 'Too many reports. Please try again later.');
  insert into public.reports (reporter_id, target_kind, target_key, post_id, comment_id, user_id, reason, details)
  values (v_uid, v_kind, v_key, p_post_id, p_comment_id, p_user_id, p_reason, v_details)
  on conflict do nothing;
end $$;

/* =========================================================== notifications */

create or replace function public.list_notifications(p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid(); v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', n.id, 'type', n.type, 'actor', private.author_json(n.actor_id),
                                        'post_id', n.post_id, 'comment_id', n.comment_id, 'friendship_id', n.friendship_id,
                                        'created_at', n.created_at, 'read_at', n.read_at) order by n.created_at desc, n.id)
      from (select * from public.notifications n
             where n.recipient_id = v_uid
               and private.notification_visible(n.recipient_id, n.actor_id, n.post_id, n.comment_id, v_uid)
             order by n.created_at desc, n.id limit v_limit) n), '[]'::jsonb);
end $$;

create or replace function public.unread_notification_count() returns integer
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid();
begin
  return (select count(*) from public.notifications n
           where n.recipient_id = v_uid and n.read_at is null
             and private.notification_visible(n.recipient_id, n.actor_id, n.post_id, n.comment_id, v_uid));
end $$;

create or replace function public.mark_notifications_read(p_ids uuid[] default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid(); v_n integer;
begin
  update public.notifications set read_at = now()
   where recipient_id = v_uid and read_at is null and (p_ids is null or id = any (p_ids));
  get diagnostics v_n = row_count;
  return v_n;
end $$;

/* ============================================================== moderation */

create or replace function public.am_moderator() returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_moderator(auth.uid())
$$;

create or replace function private.require_moderator() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid();
begin
  if not private.is_moderator(v_uid) then
    raise exception 'Only moderators can do this.' using errcode = '42501';
  end if;
  return v_uid;
end $$;

create or replace function public.list_reports(p_status text default 'open') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.require_moderator();
begin
  if p_status is not null and p_status not in ('open', 'actioned', 'dismissed') then
    raise exception 'Unknown report status.' using errcode = 'P0001';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', r.id, 'reporter_id', r.reporter_id, 'target_kind', r.target_kind,
             'post_id', r.post_id, 'comment_id', r.comment_id, 'user_id', r.user_id,
             'reason', r.reason, 'details', r.details, 'status', r.status, 'created_at', r.created_at,
             'content', case r.target_kind
               when 'post' then (select jsonb_build_object('caption', p.caption, 'author_id', p.author_id, 'deleted', p.deleted_at is not null)
                                   from public.posts p where p.id = r.post_id)
               when 'comment' then (select jsonb_build_object('body', c.body, 'author_id', c.author_id, 'post_id', c.post_id, 'deleted', c.deleted_at is not null)
                                      from public.comments c where c.id = r.comment_id)
               else (select jsonb_build_object('author_id', pr.id, 'username', pr.username::text, 'display_name', pr.display_name, 'bio', pr.bio)
                       from public.profiles pr where pr.id = r.user_id) end)
           order by r.created_at)
      from (select * from public.reports r where p_status is null or r.status = p_status order by r.created_at limit 500) r), '[]'::jsonb);
end $$;

create or replace function public.resolve_report(p_report_id uuid, p_action text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_moderator(); r public.reports;
begin
  if p_action is null or p_action not in ('dismiss', 'remove_content') then
    raise exception 'Unknown moderation action.' using errcode = 'P0001';
  end if;
  select * into r from public.reports where id = p_report_id for update;
  if r.id is null then raise exception 'Report not found.' using errcode = 'P0001'; end if;
  if p_action = 'remove_content' then
    if r.post_id is not null then
      perform private.soft_delete_post(r.post_id, true);
    elsif r.comment_id is not null then
      update public.comments set deleted_at = coalesce(deleted_at, now()), deleted_by = v_uid where id = r.comment_id;
      delete from public.notifications where comment_id = r.comment_id;
    elsif r.user_id is not null then
      -- No account suspension in v1: hide the profile from discovery and clear its public text.
      update public.profiles set discoverable = false, bio = null where id = r.user_id;
    end if;
  end if;
  -- Resolve every open report about the same target with the same outcome.
  update public.reports
     set status = case when p_action = 'dismiss' then 'dismissed' else 'actioned' end,
         resolved_at = now(), resolved_by = v_uid
   where id = r.id or (target_key = r.target_key and status = 'open');
end $$;

/* ============================================================== data export */

-- Everything the caller owns, as JSON (personal data export / portability).

create or replace function public.export_my_data() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid(); v_out jsonb := jsonb_build_object('format', 'liftcircle-server-export', 'version', 1,
          'exported_at', now(), 'note', 'Structured data only. Photo files are not included.');
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
    'friends', public.list_friends());
  return v_out;
end $$;

/* =================================================================== grants */

do $$
declare f text;
begin
  foreach f in array array[
    'public.get_my_profile()', 'public.is_username_available(text)',
    'public.save_my_profile(text, text, text, text[], boolean)', 'public.set_avatar_path(text)',
    'public.get_profile_by_username(text)', 'public.get_profile_by_id(uuid)',
    'public.send_friend_request(uuid)', 'public.respond_friend_request(uuid, boolean)', 'public.cancel_friend_request(uuid)',
    'public.remove_friend(uuid)', 'public.block_user(uuid)', 'public.unblock_user(uuid)',
    'public.list_friends()', 'public.list_friend_requests()', 'public.list_blocked()',
    'public.create_post_draft(uuid, text, text, text, jsonb, jsonb)', 'public.update_post(uuid, text, text)',
    'public.delete_post(uuid)', 'public.get_post(uuid)', 'public.get_feed(timestamptz, uuid, integer)',
    'public.get_user_posts(uuid, timestamptz, uuid, integer)',
    'public.like_post(uuid)', 'public.unlike_post(uuid)', 'public.add_comment(uuid, uuid, text)',
    'public.delete_comment(uuid)', 'public.list_comments(uuid)',
    'public.report_content(text, uuid, uuid, uuid, text)',
    'public.list_notifications(integer)', 'public.unread_notification_count()', 'public.mark_notifications_read(uuid[])',
    'public.am_moderator()', 'public.list_reports(text)', 'public.resolve_report(uuid, text)',
    'public.export_my_data()'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
