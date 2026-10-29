-- Final privilege lockdown (keep this migration LAST; re-run its statements after adding functions).
--
-- Postgres grants EXECUTE to PUBLIC on every new function and Supabase additionally grants the
-- API roles everything in `public` by default. Client RPCs already revoke/grant individually;
-- here we make sure no `private` helper is executable by anyone except what RLS needs.

revoke all on all functions in schema private from public, anon, authenticated;
revoke all on all sequences in schema private from public, anon, authenticated;
revoke all on all tables in schema private from public, anon, authenticated;

-- Helpers that RLS / storage policies evaluate as the querying `authenticated` role.
grant execute on function
  private.try_num(text), private.try_int(text), private.try_bool(text), private.try_date(text),
  private.try_ts_ms(text), private.try_uuid(text), private.clip(text, integer),
  private.are_friends(uuid, uuid), private.has_pending_request(uuid, uuid), private.is_blocked_between(uuid, uuid),
  private.is_moderator(uuid), private.can_view_post(uuid, uuid), private.profile_row_visible(uuid, uuid),
  private.can_view_profile(uuid, uuid), private.can_view_avatar(uuid, uuid),
  private.notification_visible(uuid, uuid, uuid, uuid, uuid),
  private.can_view_post_media_object(text, uuid), private.can_write_post_media_object(text, uuid)
  to authenticated, service_role;

-- Belt and braces for the client RPCs in public (each migration already did this).
revoke execute on function public.finalize_post_publish(uuid, uuid, jsonb), public.cleanup_media_candidates(integer),
  public.cleanup_media_done(uuid[], uuid[]) from public, anon, authenticated;
