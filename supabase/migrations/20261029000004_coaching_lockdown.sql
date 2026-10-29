-- Final privilege lockdown after the coaching migrations (keep this migration LAST; re-run it — or add a
-- new lockdown migration — whenever a later migration creates `private` functions).
--
-- Postgres grants EXECUTE to PUBLIC on every new function, so we revoke everything in `private` again and
-- grant back exactly what RLS / storage policies evaluate as the querying role:
--   * the 2026-10-28 list (unchanged),
--   * the coaching helpers,
--   * any EXPLICIT grant to `authenticated` that an intermediate migration (e.g. …03_ai_coach.sql) made on
--     purpose for its own policies — PUBLIC's implicit default is NOT preserved.

do $$
declare
  v_keep text[];
  f text;
begin
  select coalesce(array_agg(distinct p.oid::regprocedure::text), '{}') into v_keep
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join lateral aclexplode(p.proacl) a
   where n.nspname = 'private' and a.privilege_type = 'EXECUTE'
     and a.grantee = (select oid from pg_roles where rolname = 'authenticated');

  revoke all on all functions in schema private from public, anon, authenticated;
  revoke all on all sequences in schema private from public, anon, authenticated;
  revoke all on all tables in schema private from public, anon, authenticated;

  foreach f in array v_keep loop
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;

-- Helpers that RLS / storage policies evaluate as the querying `authenticated` role.
grant execute on function
  -- 2026-10-28
  private.try_num(text), private.try_int(text), private.try_bool(text), private.try_date(text),
  private.try_ts_ms(text), private.try_uuid(text), private.clip(text, integer),
  private.are_friends(uuid, uuid), private.has_pending_request(uuid, uuid), private.is_blocked_between(uuid, uuid),
  private.is_moderator(uuid), private.can_view_post(uuid, uuid), private.profile_row_visible(uuid, uuid),
  private.can_view_profile(uuid, uuid), private.can_view_avatar(uuid, uuid),
  private.notification_visible(uuid, uuid, uuid, uuid, uuid),
  private.can_view_post_media_object(text, uuid), private.can_write_post_media_object(text, uuid),
  -- coaching
  private.is_admin(uuid), private.coach_is_active(uuid), private.coach_can_access(uuid, uuid, text),
  private.is_relationship_participant(uuid, uuid, boolean), private.relationship_row_visible(uuid, uuid, uuid),
  private.can_view_coach_photo(text, uuid), private.can_read_coach_doc(text, uuid),
  private.coach_media_parts(text), private.can_write_coach_media_object(text, uuid),
  private.can_view_coach_media_object(text, uuid)
  to authenticated, service_role;

-- Belt and braces for the service-only RPCs in public.
revoke execute on function public.finalize_post_publish(uuid, uuid, jsonb), public.cleanup_media_candidates(integer),
  public.cleanup_media_done(uuid[], uuid[]), public.coach_media_pending(uuid, uuid),
  public.finalize_coach_message(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.coach_media_pending(uuid, uuid), public.finalize_coach_message(uuid, uuid, jsonb) to service_role;
