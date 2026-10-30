-- AI coach actions (2026-11-02): meal plans and recipe cards on AI replies.
--
-- Additive only:
--   * public.ai_record_exchange now also stores ai_messages.action of kind 'meal_plan' (a meal plan for this or next
--     week, "Add to my meal plan") and 'recipe_suggestions' (recipe cards from find_recipes), besides the existing
--     'week_adjustment'. Same signature, same atomic and idempotent behaviour; unknown kinds are still dropped.
--     The ai-coach function validates every action against the catalogs and the user's allergens, diet and targets;
--     the app applies them on the device only when the user taps the button.
--   * The column, its size check (≤ 32 KB object), ai_message_json and the read paths are unchanged, so the new
--     kinds are returned by list_ai_messages / ai_get_exchange to their owner only (existing RLS + definer RPCs).
-- No data changes; rows written before keep their action as it was.

create or replace function public.ai_record_exchange(p_user uuid, p_message jsonb, p_reply jsonb,
                                                     p_proposal jsonb default null, p_usage jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_msg_id uuid;
  v_owner uuid;
  v_existing jsonb;
  v_prop public.program_proposals;
  v_reply public.ai_messages;
  v_errors jsonb;
  v_base uuid;
  v_target text;
  v_mode text;
  v_why text;
  v_action jsonb;
begin
  if p_user is null or not exists (select 1 from auth.users where id = p_user) then
    raise exception 'Unknown user.' using errcode = '22023';
  end if;
  v_msg_id := private.try_uuid(p_message ->> 'id');
  if v_msg_id is null then raise exception 'Message id is required.' using errcode = '22023'; end if;
  if coalesce(btrim(p_message ->> 'content'), '') = '' or char_length(p_message ->> 'content') > 2000 then
    raise exception 'Message must be 1–2000 characters.' using errcode = '22023';
  end if;
  if coalesce(btrim(p_reply ->> 'content'), '') = '' then
    raise exception 'Reply is empty.' using errcode = '22023';
  end if;
  v_mode := case when p_message ->> 'mode' = 'checkin_review' then 'checkin_review' else 'chat' end;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ai:' || p_user::text, 0));

  select user_id into v_owner from public.ai_messages where id = v_msg_id;
  if v_owner is not null then
    if v_owner <> p_user then
      raise exception 'Message id already used.' using errcode = '23505';
    end if;
    v_existing := private.ai_exchange_json(p_user, v_msg_id);
    if v_existing is not null then return v_existing; end if;
  else
    insert into public.ai_messages (id, user_id, role, content, mode)
    values (v_msg_id, p_user, 'user', p_message ->> 'content', v_mode);
  end if;

  if p_proposal is not null and jsonb_typeof(p_proposal) = 'object' then
    if jsonb_typeof(p_proposal -> 'program') is distinct from 'object' or octet_length((p_proposal -> 'program')::text) > 262144 then
      raise exception 'Proposal program must be an object (≤ 256 KB).' using errcode = '22023';
    end if;
    v_errors := case when jsonb_typeof(p_proposal -> 'validationErrors') = 'array' then p_proposal -> 'validationErrors' else '[]'::jsonb end;
    v_base := private.try_uuid(p_proposal ->> 'baseProgramId');
    v_target := case when p_proposal ->> 'target' = 'for_coach_review' then 'for_coach_review' else 'apply' end;
    if jsonb_array_length(v_errors) = 0 then
      -- A newer valid suggestion for the same plan replaces older open ones.
      update public.program_proposals set status = 'superseded', updated_at = now()
       where author_kind = 'ai' and client_id = p_user and status = 'sent' and base_program_id is not distinct from v_base;
    end if;
    insert into public.program_proposals (id, author_kind, relationship_id, coach_id, client_id, status, base_program_id,
                                          base_version, revision, program, change_summary, message, effective_date,
                                          target, validation_errors, created_at, sent_at)
    values (gen_random_uuid(), 'ai', null, null, p_user,
            case when jsonb_array_length(v_errors) = 0 then 'sent' else 'invalid' end,
            v_base, case when v_base is null then null else private.try_int(p_proposal ->> 'baseVersion') end,
            1 + (select count(*) from public.program_proposals
                  where author_kind = 'ai' and client_id = p_user and base_program_id is not distinct from v_base),
            p_proposal -> 'program',
            case when jsonb_typeof(p_proposal -> 'changeSummary') = 'array' then p_proposal -> 'changeSummary' else '[]'::jsonb end,
            left(p_proposal ->> 'message', 2000),
            private.try_date(p_proposal ->> 'effectiveDate'),
            v_target, v_errors, now(),
            case when jsonb_array_length(v_errors) = 0 then now() end)
    returning * into v_prop;
  end if;

  -- Optional "Why this?" reasoning and one structured action (validated by the ai-coach function; kinds widened in
  -- 20261102000001: week_adjustment, meal_plan, recipe_suggestions — anything else is dropped).
  v_why := nullif(btrim(left(p_reply ->> 'why', 4000)), '');
  v_action := case
    when jsonb_typeof(p_reply -> 'action') = 'object'
         and p_reply -> 'action' ->> 'kind' in ('week_adjustment', 'meal_plan', 'recipe_suggestions')
         and octet_length((p_reply -> 'action')::text) <= 32768
      then p_reply -> 'action'
    else null end;

  insert into public.ai_messages (id, user_id, role, content, reply_to, proposal_id, grounding, mode, model, input_tokens, output_tokens,
                                  why, action)
  values (gen_random_uuid(), p_user, 'assistant', left(p_reply ->> 'content', 16000), v_msg_id, v_prop.id,
          case when jsonb_typeof(p_reply -> 'grounding') = 'array' then p_reply -> 'grounding' else '[]'::jsonb end,
          v_mode, left(p_reply ->> 'model', 100),
          private.try_int(p_reply ->> 'inputTokens'), private.try_int(p_reply ->> 'outputTokens'),
          v_why, v_action)
  returning * into v_reply;

  if p_usage is not null and jsonb_typeof(p_usage) = 'object' then
    insert into public.ai_usage as u (user_id, day, requests, input_tokens, output_tokens, cost_usd)
    values (p_user, private.ai_utc_day(), 0, coalesce(private.try_int(p_usage ->> 'inputTokens'), 0),
            coalesce(private.try_int(p_usage ->> 'outputTokens'), 0), private.try_num(p_usage ->> 'costUsd'))
    on conflict (user_id, day) do update
      set input_tokens = u.input_tokens + excluded.input_tokens,
          output_tokens = u.output_tokens + excluded.output_tokens,
          cost_usd = case when excluded.cost_usd is null then u.cost_usd else coalesce(u.cost_usd, 0) + excluded.cost_usd end,
          updated_at = now();
  end if;

  return jsonb_build_object('reply', private.ai_message_json(v_reply),
                            'proposal', case when v_prop.id is null then null else private.ai_proposal_json(v_prop) end,
                            'duplicate', false);
end $$;

/* ============================================================ privileges (re-stated; this file runs after the lockdown) */

revoke all on function public.ai_record_exchange(uuid, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.ai_record_exchange(uuid, jsonb, jsonb, jsonb, jsonb) to service_role;
