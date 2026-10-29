-- Server-side guard for logged workout sets (repair brief 29 Oct, section 4).
--
-- Mirrors the "always" rules of src/domain/setValidation.ts for NEW writes: every set number that is
-- present (weightKg, reps, durationSec, distanceM, rpe, rir) must be a JSON number >= 0, and reps must
-- be a whole number. JSON can't carry NaN/Infinity, so "non-finite" arrives as strings or other types,
-- which are rejected too.
--
-- Decision (backwards compatible): completed rep sets with reps = 0 are NOT rejected here. Devices running
-- the previous app version may hold such sets locally and must still be able to sync edits; the shared
-- client rules keep them from counting as work (working sets, PRs, volume, progression). The current client
-- refuses to complete them.
--
-- Existing production rows are never re-validated: the check runs only when a payload is inserted or
-- changed, deletions/tombstones pass, and a row that was already invalid before this migration may still be
-- updated (grandfathered) so old data never blocks sync.
--
-- Additive only: two private functions and one trigger. Implemented as a BEFORE trigger (not a new
-- sync_push definition) so it composes with any later sync_push changes.

create or replace function private.session_payload_problem(p jsonb)
returns text language sql immutable security definer set search_path = '' as $$
  select format('Workout set "%s" has an invalid %s value.', left(coalesce(s.value ->> 'id', '?'), 100), k.key)
    from jsonb_array_elements(case when jsonb_typeof(p -> 'exercises') = 'array' then p -> 'exercises' else '[]'::jsonb end) e(value)
   cross join lateral jsonb_array_elements(
           case when jsonb_typeof(e.value) = 'object' and jsonb_typeof(e.value -> 'sets') = 'array' then e.value -> 'sets' else '[]'::jsonb end) s(value)
   cross join lateral (values ('weightKg'), ('reps'), ('durationSec'), ('distanceM'), ('rpe'), ('rir')) k(key)
   where jsonb_typeof(s.value) = 'object'
     and s.value ? k.key
     and jsonb_typeof(s.value -> k.key) <> 'null'
     and (case
            when jsonb_typeof(s.value -> k.key) <> 'number' then true
            when ((s.value -> k.key)::text)::numeric < 0 then true
            when k.key = 'reps' and ((s.value -> k.key)::text)::numeric % 1 <> 0 then true
            else false
          end)
   limit 1
$$;

create or replace function private.workout_sessions_validate_sets()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_problem text;
begin
  if new.deleted_at is not null then return new; end if;
  if tg_op = 'UPDATE' and new.payload is not distinct from old.payload then return new; end if;
  v_problem := private.session_payload_problem(new.payload);
  if v_problem is null then return new; end if;
  -- Grandfather rows that were already invalid before this guard existed.
  if tg_op = 'UPDATE' and old.deleted_at is null and private.session_payload_problem(old.payload) is not null then return new; end if;
  raise exception '%', v_problem using errcode = '22023';
end $$;

revoke all on function private.session_payload_problem(jsonb) from public, anon, authenticated;
revoke all on function private.workout_sessions_validate_sets() from public, anon, authenticated;
grant execute on function private.session_payload_problem(jsonb) to service_role;

drop trigger if exists workout_sessions_validate_sets on public.workout_sessions;
create trigger workout_sessions_validate_sets
  before insert or update of payload, deleted_at on public.workout_sessions
  for each row execute function private.workout_sessions_validate_sets();
