-- Coach client overview: recent sessions carry their display provenance (v1.0.8, 2026-12-01). Additive; safe to re-run.
--
-- Workout names are stored in canonical English when the program generator wrote them ("Upper A") and as typed
-- otherwise. The coach app localizes a generated name only when it can prove it is one: the template id the workout was
-- started from (`templateId`) and the person's rename marker (`nameEdited`). Both come from the stored client record
-- (payload); nothing else in the function changes. Same signature, so existing grants are kept.

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
              'template_id', private.clip(s.payload ->> 'templateId', 128), 'name_edited', coalesce((s.payload ->> 'nameEdited') = 'true', false),
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
