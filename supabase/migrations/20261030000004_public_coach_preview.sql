-- Public (signed-out) preview of the coach directory. Additive: no tables, columns or policies change.
--
-- Why: guests should be able to see what human coaching offers before creating an account.
-- What anon can read: ONLY the public listing fields of coaches that are approved, not suspended and listed —
-- display name, bio, specialties, goals, languages, business city/region/country, formats, accepting-clients,
-- service-area labels (id/city/region/country/radius; NO coordinates), experience text/years, reviewed
-- qualifications (title/issuer/year) and the approval date. Never: photos (the coach-public storage policy
-- stays signed-in only), coordinates or distances, application status/notes, documents, review history,
-- relationships, messages, or anything about the viewer. Requests, messages and all private data keep
-- requiring an account (request_coaching etc. still call private.require_uid()).
--
-- Abuse limits: text filters only (no coordinate search, so service-area coordinates can't be triangulated),
-- at most 20 results per call and no paging beyond 200 results; both functions are STABLE and cheap.
-- Blocks can't apply to a signed-out viewer; a blocked member who signs out sees only this public listing,
-- and every action on it still needs an account where blocks are enforced.

create or replace function public.public_search_coaches(p jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  q jsonb := case when jsonb_typeof(p) = 'object' then p else '{}'::jsonb end;
  v_city text := private.fold_text(left(q ->> 'city', 120));
  v_region text := private.fold_text(left(q ->> 'region', 120));
  v_country text := upper(nullif(btrim(coalesce(left(q ->> 'country', 8), '')), ''));
  v_format text := coalesce(nullif(q ->> 'format', ''), 'any');
  v_specialty text := private.fold_text(left(q ->> 'specialty', 80));
  v_goal text := private.fold_text(left(q ->> 'goal', 80));
  v_language text := lower(nullif(btrim(coalesce(left(q ->> 'language', 8), '')), ''));
  v_accepting boolean := coalesce(private.try_bool(q ->> 'acceptingOnly'), false);
  v_limit integer := least(greatest(coalesce(private.try_int(q ->> 'limit'), 20), 1), 20);
  v_offset integer := least(greatest(coalesce(private.try_int(q ->> 'offset'), 0), 0), 200);
  v_has_place boolean;
  v_out jsonb;
begin
  if v_country is not null and v_country !~ '^[A-Z]{2}$' then v_country := null; end if;
  if v_format not in ('any', 'in_person', 'online') then v_format := 'any'; end if;
  v_has_place := v_city is not null or v_region is not null or v_country is not null;

  with base as (
    select c.* from public.coach_profiles c
     where c.status = 'approved' and not c.suspended and c.listed
       and (not v_accepting or c.accepting_clients)
       and (v_specialty is null or exists (select 1 from unnest(c.specialties) s where private.fold_text(s) = v_specialty))
       and (v_goal is null or exists (select 1 from unnest(c.goals) g where private.fold_text(g) = v_goal))
       and (v_language is null or v_language = any (c.languages))
       and (v_format = 'any' or v_format = any (c.formats))
  ),
  areas as (
    select a.coach_id, a.kind, a.city, a.region, a.country
      from public.coach_service_areas a join base b on b.user_id = a.coach_id
    union all
    select b.user_id, 'city', b.city, b.region, b.country
      from base b where b.city is not null or b.region is not null or b.country is not null
  ),
  local_match as (
    select distinct a.coach_id
      from areas a join base b on b.user_id = a.coach_id
     where v_has_place and 'in_person' = any (b.formats)
       and private.area_text_match(a.kind, a.city, a.region, a.country, v_city, v_region, v_country)
  ),
  results as (
    -- same grouping as the signed-in search_coaches: local in-person matches first, then online coaches
    select b.user_id, b.display_name, 0 as grp from base b join local_match l on l.coach_id = b.user_id
    union all
    select b.user_id, b.display_name, 1 from base b
     where 'online' = any (b.formats) and v_format <> 'in_person'
       and not exists (select 1 from local_match l where l.coach_id = b.user_id)
       and (v_country is null or v_language is not null or b.country = v_country
            or exists (select 1 from public.coach_service_areas a where a.coach_id = b.user_id and a.country = v_country))
  ),
  ranked as (
    select r.*, row_number() over (order by r.grp, lower(r.display_name), r.user_id) as n from results r
  ),
  page as (
    select * from ranked order by n limit v_limit + 1 offset v_offset
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object(
                 'user_id', c.user_id, 'display_name', c.display_name, 'bio', c.bio,
                 'specialties', to_jsonb(c.specialties), 'goals', to_jsonb(c.goals), 'languages', to_jsonb(c.languages),
                 'city', c.city, 'region', c.region, 'country', c.country, 'formats', to_jsonb(c.formats),
                 'accepting_clients', c.accepting_clients,
                 'service_areas', coalesce((select jsonb_agg(jsonb_build_object(
                                     'id', a.id, 'kind', a.kind, 'city', a.city, 'region', a.region, 'country', a.country,
                                     'radius_km', a.radius_km, 'label', a.label) order by a.position, a.created_at, a.id)
                                    from public.coach_service_areas a where a.coach_id = c.user_id), '[]'::jsonb),
                 'match', case when pg.grp = 0 then 'local' else 'remote' end)
               order by pg.n)
             from page pg join public.coach_profiles c on c.user_id = pg.user_id
            where pg.n <= v_offset + v_limit), '[]'::jsonb),
    'has_more', (select count(*) from page) > v_limit and v_offset + v_limit < 200)
    into v_out;
  return v_out;
end $$;

create or replace function public.public_get_coach(p_coach uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.coach_profiles;
begin
  if p_coach is null then return null; end if;
  select * into c from public.coach_profiles
   where user_id = p_coach and status = 'approved' and not suspended and listed;
  if c.user_id is null then return null; end if;
  return jsonb_build_object(
    'user_id', c.user_id, 'display_name', c.display_name, 'bio', c.bio,
    'specialties', to_jsonb(c.specialties), 'goals', to_jsonb(c.goals), 'languages', to_jsonb(c.languages),
    'city', c.city, 'region', c.region, 'country', c.country, 'formats', to_jsonb(c.formats),
    'accepting_clients', c.accepting_clients,
    'service_areas', coalesce((select jsonb_agg(jsonb_build_object(
                        'id', a.id, 'kind', a.kind, 'city', a.city, 'region', a.region, 'country', a.country,
                        'radius_km', a.radius_km, 'label', a.label) order by a.position, a.created_at, a.id)
                       from public.coach_service_areas a where a.coach_id = c.user_id), '[]'::jsonb),
    'match', case when 'in_person' = any (c.formats) then 'local' else 'remote' end,
    'experience_years', c.experience_years, 'experience', c.experience,
    'approved_qualifications', private.coach_quals_json(c.user_id, true),
    'approved_since', c.approved_at);
end $$;

revoke all on function public.public_search_coaches(jsonb) from public;
revoke all on function public.public_get_coach(uuid) from public;
grant execute on function public.public_search_coaches(jsonb), public.public_get_coach(uuid) to anon, authenticated, service_role;
