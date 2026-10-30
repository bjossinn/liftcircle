-- AI coach v3 (2026-10-31): per-user coach style.
--
-- Additive only:
--   * ai_settings.coach_style — 'supportive' | 'balanced' | 'strict' (nullable, default 'balanced'; null reads as
--     'balanced'). The ai-coach function puts the matching style rules into the system prompt; the safety limits
--     in the prompt override every style.
--   * private.ai_settings_json now returns `coachStyle` (get_ai_settings / save_ai_settings).
--   * public.save_ai_settings accepts p.coachStyle (same signature; unknown values are refused with 22023).
-- Existing rows get the default; nothing else changes.

alter table public.ai_settings
  add column if not exists coach_style text default 'balanced'
    check (coach_style is null or coach_style in ('supportive', 'balanced', 'strict'));

create or replace function private.ai_settings_json(s public.ai_settings) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when s.user_id is null then null else jsonb_build_object(
    'enabled', s.enabled,
    'paused', s.paused,
    'consentAt', s.consent_at,
    'consentVersion', s.consent_version,
    'scopes', jsonb_build_object(
      'profile', coalesce((s.scopes ->> 'profile')::boolean, false),
      'training', coalesce((s.scopes ->> 'training')::boolean, false),
      'measurements', coalesce((s.scopes ->> 'measurements')::boolean, false),
      'nutrition', coalesce((s.scopes ->> 'nutrition')::boolean, false)),
    'scopesChangedAt', s.scopes_changed_at,
    'profileNotes', s.profile_notes,
    'coachStyle', coalesce(s.coach_style, 'balanced'),
    'updatedAt', s.updated_at) end
$$;

-- p keys (all optional): enabled bool, paused bool, scopes {profile,training,measurements,nutrition: bool},
-- profileNotes text (≤ 4000), coachStyle ('supportive'|'balanced'|'strict'), acceptConsent bool, consentVersion text.
-- Other keys are ignored (consentAt / scopesChangedAt / userId can never be set by the client).
create or replace function public.save_ai_settings(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  s public.ai_settings;
  v_scopes jsonb;
  v_key text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'Settings must be a JSON object.' using errcode = '22023';
  end if;
  perform private.enforce_rate_limit(v_uid, 'ai_settings', 120, interval '1 hour',
    'Too many AI coach settings changes. Please wait a little and try again.');

  insert into public.ai_settings (user_id) values (v_uid) on conflict (user_id) do nothing;
  select * into s from public.ai_settings where user_id = v_uid for update;

  if p ? 'acceptConsent' then
    if jsonb_typeof(p -> 'acceptConsent') <> 'boolean' then
      raise exception 'acceptConsent must be true or false.' using errcode = '22023';
    end if;
    if (p ->> 'acceptConsent')::boolean then
      s.consent_at := now();
      s.consent_version := coalesce(left(nullif(p ->> 'consentVersion', ''), 40), '2026-10-29');
    end if;
  end if;

  if p ? 'enabled' then
    if jsonb_typeof(p -> 'enabled') <> 'boolean' then
      raise exception 'enabled must be true or false.' using errcode = '22023';
    end if;
    s.enabled := (p ->> 'enabled')::boolean;
  end if;
  if p ? 'paused' then
    if jsonb_typeof(p -> 'paused') <> 'boolean' then
      raise exception 'paused must be true or false.' using errcode = '22023';
    end if;
    s.paused := (p ->> 'paused')::boolean;
  end if;

  if p ? 'scopes' then
    if jsonb_typeof(p -> 'scopes') <> 'object' then
      raise exception 'scopes must be an object.' using errcode = '22023';
    end if;
    v_scopes := private.ai_settings_json(s) -> 'scopes';
    foreach v_key in array array['profile', 'training', 'measurements', 'nutrition'] loop
      if (p -> 'scopes') ? v_key then
        if jsonb_typeof(p -> 'scopes' -> v_key) <> 'boolean' then
          raise exception 'Scope "%" must be true or false.', v_key using errcode = '22023';
        end if;
        v_scopes := jsonb_set(v_scopes, array[v_key], p -> 'scopes' -> v_key);
      end if;
    end loop;
    if v_scopes is distinct from (private.ai_settings_json(s) -> 'scopes') then
      s.scopes := v_scopes;
      -- History before this moment is no longer re-sent as context (it may quote revoked data).
      s.scopes_changed_at := now();
    end if;
  end if;

  if p ? 'profileNotes' then
    if jsonb_typeof(p -> 'profileNotes') not in ('string', 'null') then
      raise exception 'Notes must be text.' using errcode = '22023';
    end if;
    if char_length(coalesce(p ->> 'profileNotes', '')) > 4000 then
      raise exception 'Notes can be at most 4000 characters.' using errcode = 'P0001';
    end if;
    s.profile_notes := coalesce(p ->> 'profileNotes', '');
  end if;

  if p ? 'coachStyle' then
    if jsonb_typeof(p -> 'coachStyle') <> 'string' or (p ->> 'coachStyle') not in ('supportive', 'balanced', 'strict') then
      raise exception 'Coach style must be supportive, balanced or strict.' using errcode = '22023';
    end if;
    s.coach_style := p ->> 'coachStyle';
  end if;

  if s.enabled and s.consent_at is null then
    raise exception 'Please review what the AI coach uses and agree before turning it on.'
      using errcode = 'P0001', hint = 'consent_required';
  end if;

  update public.ai_settings
     set enabled = s.enabled, paused = s.paused, consent_at = s.consent_at, consent_version = s.consent_version,
         scopes = s.scopes, scopes_changed_at = s.scopes_changed_at, profile_notes = s.profile_notes,
         coach_style = s.coach_style, updated_at = now()
   where user_id = v_uid
  returning * into s;
  return private.ai_settings_json(s);
end $$;

/* ============================================================ privileges (re-stated; this file runs after the lockdown) */

revoke all on function private.ai_settings_json(public.ai_settings) from public, anon, authenticated;
revoke all on function public.save_ai_settings(jsonb) from public, anon;
grant execute on function public.save_ai_settings(jsonb) to authenticated;
