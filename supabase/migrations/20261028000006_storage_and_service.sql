-- Private storage buckets + storage.objects policies, and service-role-only RPCs used by
-- the Edge Functions (finalize-post, cleanup-media).
--
-- Path conventions (bucket-relative object names):
--   post-media: {owner_id}/{post_id}/{media_id}.jpg  and  {owner_id}/{post_id}/{media_id}_thumb.jpg
--   avatars:    {owner_id}/avatar_{uuid}.jpg
-- Both buckets are PRIVATE: clients read through short-lived signed URLs (300 s), and creating a
-- signed URL requires SELECT on the object under these policies — so visibility changes
-- (audience → only_me, unfriend, block, delete) stop new URLs immediately. URLs already issued
-- stay valid until they expire; see docs/BACKEND.md.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('post-media', 'post-media', false, 5242880, array['image/jpeg', 'image/webp']),
       ('avatars', 'avatars', false, 1048576, array['image/jpeg', 'image/webp'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

/* ------------------------------------------------------------ post-media */

create policy "liftcircle post-media insert: own draft media" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'post-media'
              and (storage.foldername(name))[1] = (select auth.uid())::text
              and private.can_write_post_media_object(name, (select auth.uid())));

-- upsert: true needs UPDATE (and SELECT) as well
create policy "liftcircle post-media update: own draft media" on storage.objects
  for update to authenticated
  using (bucket_id = 'post-media'
         and (storage.foldername(name))[1] = (select auth.uid())::text
         and private.can_write_post_media_object(name, (select auth.uid())))
  with check (bucket_id = 'post-media'
              and (storage.foldername(name))[1] = (select auth.uid())::text
              and private.can_write_post_media_object(name, (select auth.uid())));

-- read / sign: only while the post is visible to the caller
create policy "liftcircle post-media select: visible posts" on storage.objects
  for select to authenticated
  using (bucket_id = 'post-media' and private.can_view_post_media_object(name, (select auth.uid())));

create policy "liftcircle post-media delete: own folder" on storage.objects
  for delete to authenticated
  using (bucket_id = 'post-media' and (storage.foldername(name))[1] = (select auth.uid())::text);

/* --------------------------------------------------------------- avatars */

create policy "liftcircle avatars insert: own avatar" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars'
              and (storage.foldername(name))[1] = (select auth.uid())::text
              and name ~ ('^' || (select auth.uid())::text || '/avatar_[0-9a-f-]{36}\.jpg$'));

create policy "liftcircle avatars update: own avatar" on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'avatars'
              and (storage.foldername(name))[1] = (select auth.uid())::text
              and name ~ ('^' || (select auth.uid())::text || '/avatar_[0-9a-f-]{36}\.jpg$'));

create policy "liftcircle avatars select: visible profiles" on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars'
         and private.can_view_avatar(private.try_uuid((storage.foldername(name))[1]), (select auth.uid())));

create policy "liftcircle avatars delete: own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

/* ================================================= service-role-only RPCs */

-- Called by the finalize-post Edge Function AFTER it verified every image + thumbnail
-- (presence, size, magic bytes, no EXIF/GPS, dimensions). Marks media ready and publishes
-- atomically. Idempotent. p_media: [{ id, width, height, bytes, thumb_bytes }]
create or replace function public.finalize_post_publish(p_post_id uuid, p_user_id uuid, p_media jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_post public.posts; v_media jsonb := coalesce(p_media, '[]'::jsonb);
begin
  select * into v_post from public.posts where id = p_post_id for update;
  if v_post.id is null or v_post.author_id is distinct from p_user_id then
    raise exception 'Post not found.' using errcode = 'P0001';
  end if;
  if v_post.deleted_at is not null then
    raise exception 'This post was deleted.' using errcode = 'P0001';
  end if;
  if v_post.status = 'published' then
    return jsonb_build_object('id', p_post_id, 'status', 'published', 'already', true);
  end if;
  if jsonb_typeof(v_media) <> 'array' then
    raise exception 'Invalid media report.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.post_media m
              where m.post_id = p_post_id
                and not exists (select 1 from jsonb_array_elements(v_media) e where e ->> 'id' = m.id::text)) then
    raise exception 'Some photos have not finished uploading.' using errcode = 'P0001';
  end if;
  update public.post_media m
     set status = 'ready',
         width = coalesce(private.try_int(e ->> 'width'), m.width),
         height = coalesce(private.try_int(e ->> 'height'), m.height),
         bytes = private.try_int(e ->> 'bytes'),
         thumb_bytes = private.try_int(e ->> 'thumb_bytes')
    from jsonb_array_elements(v_media) e
   where m.post_id = p_post_id and m.id::text = e ->> 'id';
  update public.posts set status = 'published', published_at = now() where id = p_post_id;
  return jsonb_build_object('id', p_post_id, 'status', 'published', 'already', false);
end $$;

-- Posts whose storage objects should be removed by cleanup-media.
create or replace function public.cleanup_media_candidates(p_limit integer default 100)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'deleted', coalesce((select jsonb_agg(jsonb_build_object('post_id', p.id, 'author_id', p.author_id))
                           from (select id, author_id from public.posts
                                  where deleted_at is not null and media_cleaned_at is null
                                  order by deleted_at limit greatest(coalesce(p_limit, 100), 1)) p), '[]'::jsonb),
    'abandoned', coalesce((select jsonb_agg(jsonb_build_object('post_id', p.id, 'author_id', p.author_id))
                             from (select id, author_id from public.posts
                                    where status = 'draft' and deleted_at is null and created_at < now() - interval '24 hours'
                                    order by created_at limit greatest(coalesce(p_limit, 100), 1)) p), '[]'::jsonb))
$$;

-- Marks deleted posts as cleaned and hard-deletes abandoned drafts (after their objects were removed).
create or replace function public.cleanup_media_done(p_deleted uuid[], p_abandoned uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_cleaned integer; v_dropped integer;
begin
  update public.posts set media_cleaned_at = now()
   where id = any (coalesce(p_deleted, '{}')) and deleted_at is not null;
  get diagnostics v_cleaned = row_count;
  delete from public.posts
   where id = any (coalesce(p_abandoned, '{}')) and status = 'draft' and created_at < now() - interval '24 hours';
  get diagnostics v_dropped = row_count;
  delete from private.rate_events where created_at < now() - interval '2 days';
  return jsonb_build_object('cleaned', v_cleaned, 'abandoned_removed', v_dropped);
end $$;

revoke all on function public.finalize_post_publish(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.cleanup_media_candidates(integer) from public, anon, authenticated;
revoke all on function public.cleanup_media_done(uuid[], uuid[]) from public, anon, authenticated;
grant execute on function public.finalize_post_publish(uuid, uuid, jsonb) to service_role;
grant execute on function public.cleanup_media_candidates(integer) to service_role;
grant execute on function public.cleanup_media_done(uuid[], uuid[]) to service_role;
