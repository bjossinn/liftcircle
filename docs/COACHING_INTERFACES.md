# Coaching & training assistant — cross-slice spec

Contract types: `src/backend/coachingContract.ts` (CoachingApi, AiApi). This file fixes the **server** names so the
database, Edge Functions and client wrappers agree. All new SQL lives in NEW migrations
`supabase/migrations/20261029000001_coaching_schema.sql`, `…02_coaching_rpcs.sql`, `…03_ai_coach.sql`,
`…04_coaching_lockdown.sql` (re-applies the lockdown for new functions; must stay last). Never edit the 2026-10-28 files.

Conventions (same as existing backend): RLS on every table; revoke-all then grant minimal; writes via
`security definer` RPCs with `set search_path = ''`; caller = `auth.uid()`; helpers in schema `private`;
EXECUTE revoked from public/anon; user-readable errors raised with SQLSTATE P0001 (rate limit PT429).

## Roles
- `public.app_roles.role` check extended to `('moderator','admin')` (additive constraint swap).
- `private.is_admin(uid)`; admin ⊇ coach-application review, coach suspension, coaching reports. Admin does NOT get
  general read access to client health records.
- First admin: SQL editor / service role only (`insert into public.app_roles(user_id, role) values ('<uuid>','admin')`).
  No RPC can grant roles. Documented in docs/SETUP.md.
- RPC `my_roles()` → `{admin bool, moderator bool}`.

## Tables (new)
| table | key facts |
|---|---|
| `coach_profiles` | PK `user_id` → auth.users cascade; display_name, photo_path, bio(≤2000), experience_years, experience(≤4000), specialties text[], goals text[], languages text[], city, region, country(char 2), formats text[] ⊆ {in_person,online}, accepting_clients bool, listed bool, status (draft/submitted/changes_requested/approved/rejected), suspended bool, suspended_reason, suspended_at, submitted_at, reviewed_at, approved_at, latest_feedback, updated_at. Columns `status`, `suspended*`, `reviewed_at`, `approved_at`, `latest_feedback` are writable ONLY by admin RPCs. |
| `coach_service_areas` | id, coach_id, kind(city/region/country), city, region, country, lat, lng (numeric(7,4), rounded ≈10 m→ stored rounded to 3 decimals ≈100 m), radius_km, label, geo_source ('geocoder:<provider>' or null) |
| `coach_qualifications` | id, coach_id, title, issuer, year, document_path (bucket `coach-docs`), document_name, review_status(pending/approved/rejected), review_note, reviewed_by, reviewed_at. Changing title/issuer/year/document of an approved row → back to pending (trigger). Only `approved` rows are public. |
| `coach_review_events` | id, coach_id, actor_id, action, reason, qualification_id, from_status, to_status, created_at. Insert-only (definer). |
| `coaching_relationships` | id(client-generated, idempotent), coach_id, client_id, status(requested/active/declined/cancelled/ended), intake jsonb, intro_message(≤2000), requested_at, responded_at, ended_at, ended_by, end_reason. Check coach_id <> client_id. Partial unique: one `active` per client; one `requested` per (client, coach); at most 3 open requests per client. |
| `coaching_scopes` | PK relationship_id; training, measurements, nutrition, checkins bool; updated_at. Client-only writes. |
| `program_proposals` | id, author_kind(coach/ai), relationship_id (null for AI), coach_id, client_id, status, base_program_id, base_version, revision, program jsonb, change_summary jsonb, message, effective_date, target(apply/for_coach_review), validation_errors jsonb, created_at, sent_at, responded_at, applied_program_id, applied_version |
| `coach_feedback` | id, relationship_id, coach_id, client_id, session_id, body(≤2000), created_at |
| `coach_checkins` | id, relationship_id, client_id, coach_id, answers jsonb, note, coach_response, reviewed_at, created_at |
| `coach_messages` | id (client uuid, PK), relationship_id, sender_id, body(≤4000), media jsonb (array of {id,width,height}), status (awaiting_media/sent), shared_from_ai bool, seq bigint (identity, ordering), created_at |
| `coach_message_reads` | (relationship_id, user_id) PK, last_read_seq |
| `coaching_reports` | id, reporter_id, relationship_id, message_id, reason, details, status(open/actioned/dismissed), created_at, resolved_by, resolved_at |
| `ai_settings` | PK user_id; enabled, paused, consent_at, consent_version, scopes jsonb {profile,training,measurements,nutrition}, scopes_changed_at, profile_notes(≤4000), updated_at |
| `ai_messages` | id (client uuid for user msgs / server uuid for replies), user_id, role(user/assistant), content, reply_to uuid, proposal_id, grounding jsonb, model, input_tokens, output_tokens, mode (chat/checkin_review), created_at, seq identity |
| `ai_usage` | (user_id, day) PK; requests, input_tokens, output_tokens, cost_usd numeric |

`notifications.type` check extended with: `coach_request, coach_request_accepted, coach_request_declined,
coach_request_cancelled, coach_ended, coach_message, coach_proposal, coach_proposal_response, coach_checkin,
coach_feedback, coach_application, coach_status`; new nullable columns `relationship_id`, `coach_id`,
`proposal_id`. Notifications NEVER contain message text. Created only by definer RPCs/triggers.

## Access helpers (private, stable, definer)
- `private.coach_is_active(coach uuid)` = approved and not suspended.
- `private.coach_can_access(viewer, client, scope text)` = an `active` relationship (coach_id=viewer, client_id=client)
  AND coach_is_active(viewer) AND the scope flag is true AND no block either way. Scopes: training, measurements,
  nutrition, checkins.
- `private.is_relationship_participant(rel, viewer, writable bool)`; writable ⇒ status active, coach active, no block.
  Readable ⇒ participant AND (status in active/ended/declined/cancelled) AND (viewer is client OR coach is not suspended).

Additive SELECT policies on existing private tables (OR'd with "owner can read"):
`workout_sessions, session_exercises, session_sets, activities, programs, program_versions, goals` → scope training;
`measurements` → measurements; `food_logs` → nutrition. NOT account_state (coach sees the intake instead).

## RPCs (all `authenticated` only)
Profile/application: `get_my_coach_profile()`, `save_my_coach_profile(p jsonb)`, `submit_coach_application()`,
`set_coach_listing(p_listed bool, p_accepting bool)`, `my_coach_review_events()`.
Directory: `search_coaches(p jsonb)` (keys of CoachSearch; returns `{items, distance_available}`), `get_coach(p_coach uuid)`.
Relationships: `request_coaching(p_id uuid, p_coach uuid, p_intake jsonb, p_message text, p_scopes jsonb)`,
`cancel_coaching_request(p_id)`, `respond_coaching_request(p_id, p_accept bool, p_message text)`,
`end_coaching(p_id, p_reason text)`, `set_coaching_scopes(p_id, p_scopes jsonb)`, `my_coaching_relationships()`,
`coach_client_overview(p_id)`.
Programs: `save_program_proposal(p jsonb)`, `send_program_proposal(p_id)`, `withdraw_program_proposal(p_id)`,
`list_program_proposals(p jsonb)`, `get_program_proposal(p_id)`, `respond_program_proposal(p_id, p_accept bool, p_program_id uuid, p_version int)`.
Feedback/check-ins: `add_coach_feedback(p_id, p_relationship, p_session uuid, p_body)`, `list_coach_feedback(p_relationship)`,
`submit_checkin(p_id, p_relationship, p_answers jsonb, p_note)`, `list_checkins(p_relationship)`, `respond_checkin(p_id, p_response)`.
Messages: `list_coach_messages(p_relationship, p_after_seq bigint, p_limit int)`,
`send_coach_message(p_id uuid, p_relationship uuid, p_body text, p_media jsonb, p_shared_from_ai bool)` (idempotent:
same id → returns existing row, no second notification; with media → status `awaiting_media` until
`finalize-coach-media` validates), `mark_coach_messages_read(p_relationship, p_upto bigint)`, `unread_coaching_count()`,
`report_coaching_content(p_relationship, p_message, p_reason, p_details)`.
Admin: `admin_list_coach_applications(p_filter text)`, `admin_get_coach_application(p_coach uuid)`,
`admin_review_coach(p_coach uuid, p_action text, p_reason text, p_qualification uuid)`.
AI (called by the ai-coach function with the USER's JWT unless noted): `get_ai_settings()`, `save_ai_settings(p jsonb)`,
`list_ai_messages(p_limit int)`, `clear_ai_history()`, `list_ai_proposals()`, `respond_ai_proposal(p_id, p_accept, p_program_id, p_version)`.
Service-role only: `ai_record_exchange(...)`, `ai_check_and_count_usage(p_user uuid, p_limit int)`,
`ai_get_exchange(p_user, p_message_id)` (replays a stored reply for an idempotent resend).
Added during the build: `admin_list_coaching_reports(p_status)`, `admin_resolve_coaching_report(p_id, p_action)`
(client: `coachingReportsApi` in `src/backend/coaching.ts`, UI `/coaching/admin/reports`), `coaching_geocode_quota()`,
service-only `coach_media_pending`, `finalize_coach_message`. `list_notifications` additionally returns
`relationship_id`, `coach_id`, `proposal_id`. Coaching notifications respect `settings.notifications.coaching`
(default on; Settings → Notifications → "Coaching updates").

## Storage buckets (private)
- `coach-public`: coach photos, path `{coach_id}/photo_{uuid}.jpg`; read: any authenticated user if coach is listed,
  approved, not suspended — or the owner, or admins; write: owner folder.
- `coach-docs`: qualification documents, path `{coach_id}/{qualification_id}/{filename}`; read: owner + admins only; write: owner. pdf/jpeg/png/webp, ≤10 MiB.
- `coach-media`: chat attachments, path `{relationship_id}/{message_id}/{media_id}.jpg|_thumb.jpg`; read: readable participants;
  write: sender while writable.

## Edge Functions (new)
- `ai-coach` (verify_jwt): POST `{action:'status'}` (→ also `provider`, `providerName`, `consentCurrent`) | `{action:'send', id, text, mode}`
  (409 `consent_required` when the user agreed for another provider). Provider: `AI_PROVIDER` + `OPENAI_API_KEY`/`OPENAI_MODEL`
  (see docs/AI_COACH.md) or `ANTHROPIC_API_KEY`
  (secret), `ANTHROPIC_MODEL`, `AI_DAILY_REQUEST_LIMIT` (default 40), `AI_MAX_OUTPUT_TOKENS` (default 1200),
  `AI_PRICE_INPUT_PER_MTOK`, `AI_PRICE_OUTPUT_PER_MTOK`. Missing key → 503 `{code:'ai_unavailable', reason:'not_configured'}`.
- `geocode` (verify_jwt): POST `{query}` → `{available, results: GeocodeResult[]}`. Env `GEOCODER=nominatim|none`
  (+ `GEOCODER_CONTACT_EMAIL` required for nominatim usage policy). No provider → `{available:false, results:[]}`.
- `finalize-coach-media` (verify_jwt): validates uploaded chat images (reuses `_shared/image.ts`), flips message to `sent`.

## Client local data (Dexie v2, owned by integrator)
- `db.coachOutbox` — queued coach messages `{id, relationshipId, body, mediaBlobs?, status, attempts, error, createdAt, accountId}`.
- AI unsent draft in `kv('ai-draft')`.
- Programs: `Program.managedBy` (`src/domain/types.ts`) marks self/coach/ai management. ONE active program.

## UI routes (owned per slice)
`/coaching` hub · `/coaching/find` · `/coaching/coach/:id` · `/coaching/request/:coachId` (directory slice)
`/coaching/apply` · `/coaching/admin` · `/coaching/admin/:coachId` (directory slice)
`/coaching/my` · `/coaching/messages/:relationshipId` · `/coaching/proposal/:id` · `/coaching/checkin/:relationshipId`
`/coaching/dashboard` · `/coaching/client/:relationshipId` · `/coaching/client/:relationshipId/program` (coach-tools slice)
`/coaching/ai` · `/coaching/ai/setup` · `/coaching/ai/settings` · `/coaching/ai/proposals` (AI slice)
