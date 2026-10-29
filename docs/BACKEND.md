# LiftCircle backend (Supabase)

Connected mode uses Supabase Auth, Postgres with row-level security (RLS), private Storage and three Edge Functions.
Personal mode does not need any of this.

| Path | What it is |
| --- | --- |
| `supabase/migrations/20261028000001…07_*.sql` | Schema, RLS policies, grants, RPCs, storage buckets and policies (apply in order) |
| `supabase/migrations/20261029*.sql`, `20261030*.sql` | Coaching + AI coach (§8, docs/AI_COACH.md); `20261030000003_authz_fixes.sql` = audit fixes (§8.10) |
| `supabase/seed.sql` | Read-only reference catalogs (generated, see below) |
| `supabase/functions/finalize-post` | Verifies uploaded photos and publishes a post |
| `supabase/functions/delete-account` | Removes the caller's storage objects, then deletes the auth user (cascades) |
| `supabase/functions/cleanup-media` | Scheduled removal of storage objects for deleted posts and abandoned drafts |
| `supabase/functions/_shared/*` | CORS/error helpers, Supabase clients and JWT check, JPEG/WebP inspector, storage helpers |
| `supabase/config.toml` | Local CLI config (auth redirects, email confirmations on, function JWT settings) |
| `src/backend/syncRemote.ts`, `src/backend/social.ts` | Client implementations of the contract in `src/backend/contract.ts` |
| `tests/rls/run.mjs` | Real-database authorization tests (`npm run test:rls`) |

## 1. Authorization model

* **RLS is on for every table.** Supabase grants every API role full access to new `public` tables by default, so each
  migration first runs `revoke all … from public, anon, authenticated` and then grants only what is needed.
* **Clients only ever SELECT.** `anon` and `authenticated` have **no INSERT/UPDATE/DELETE grant on any table**. Every write
  goes through a `security definer` RPC with `set search_path = ''`. The RPC takes the acting user from `auth.uid()`,
  so `author_id`, `owner_id` and `requester_id` are never accepted from the client and cannot be forged.
* **Helpers live in the non-exposed `private` schema.** That schema is not in `[api] schemas`, so its functions cannot be
  called over HTTP. These are the security-definer, `stable` helpers with `search_path = ''`:
  `are_friends(a,b)`, `is_blocked_between(a,b)`, `can_view_post(post, viewer)`, `is_moderator(uid)`,
  `can_view_profile`, `can_view_avatar`, `profile_row_visible` and `notification_visible`. Policies call them as the
  `authenticated` role. The last migration (`…07_lockdown.sql`) revokes EXECUTE on everything in `private` and
  grants back only the helpers that policies use.
* **The service role is used only inside Edge Functions.** The browser holds only the publishable (anon) key.
* **Moderation is server-authorized.** `public.app_roles(user_id, role='moderator')` has RLS enabled, no policies and no
  grants. Only the SQL editor or the service role can write to it. No profile field can grant a role.

### Post visibility rule (`private.can_view_post`)

A post is visible when it is not deleted and one of these holds:

* the viewer is the author (including the author's own drafts), or
* the post has `status = 'published'`, `audience = 'friends'`, the viewer is an accepted friend, and neither account has
  blocked the other, or
* the viewer is a moderator and the post has been reported.

The same rule controls:

* **Comments:** also hidden when deleted or written by someone blocked either way.
* **Likes:** also hidden when the liker is blocked either way.
* **`post_media` rows**.
* **Storage objects:** viewers can SELECT or sign only objects of posts they can see.
* **Notifications:** a notification is hidden when its post is no longer visible or its comment was deleted.

Changing a post from Friends to Only me, unfriending, blocking or deleting takes effect immediately for every one of these.

### Access-control matrix (verified by `npm run test:rls`)

P1 is a published post with `audience = 'friends'` and a photo, and it has been reported. P2 is a published post with
`audience = 'only_me'` and a photo. The owner is the author of both posts. The blocked actor was a friend before the
owner blocked them.

| Resource | Owner | Friend | Stranger | Signed out | Blocked | Moderator |
| --- | --- | --- | --- | --- | --- | --- |
| P1 row / `get_post` / comments / likes / media rows / storage image + thumb | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ (reported only) |
| P2 (Only me) row / comments / media / storage | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| workout_sessions, session_sets, program_versions, measurements, food_logs | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| account_state (age, height, injury notes, diet, targets) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `sync_pull` | own rows only | ❌ | ❌ | ❌ | ❌ | ❌ |
| Owner's notifications | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Owner's profile row (direct SELECT) | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Owner's profile via exact username lookup | ✅ | ✅ | ✅ if discoverable | ❌ | ❌ | ✅ if discoverable |
| Report queue (`reports`, `list_reports`) | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| `app_roles`, `private.*` | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

## 2. Schema overview

**Private records.** These are owner-only and synced: `account_state` (one row per user), `programs` with
`program_versions` (typed rows), `templates`, `workout_sessions` with `session_exercises` and `session_sets`,
`activities`, `activity_templates`, `measurements`, `goals`, `custom_exercises`, `custom_foods`, `food_logs`,
`saved_meals` and `meal_plans`.

* **Columns.** Every row has `owner_id → auth.users on delete cascade`, a client-generated `id uuid`, `version bigint`,
  `payload jsonb`, `deleted_at` (the tombstone flag), and server-set `created_at`/`updated_at`. `version` comes from
  the single sequence `private.sync_version_seq`. `payload` holds the record exactly as the client sent it.
* **Projection columns.** Typed columns such as dates, kind, status, started_at and value are `GENERATED` from the
  payload with non-throwing casts. Malformed client data becomes NULL instead of failing the sync.
* **Primary key.** The key is `(owner_id, id)`, not `id` alone, so ids are namespaced per account. The same id in two
  accounts (for example one guest database imported twice) gives two independent rows. It can never collide with,
  block or leak another account's record. This is an intended deviation from "id PK".
* **Normalized children.** `session_exercises` and `session_sets` are rebuilt from `payload.exercises`, and
  `program_versions` from `payload.versions`, inside `sync_push` on every write.
* **The account_state row is keyed by the account.** The client's local id is `'account'`. `syncRemote` sends a nil
  UUID, the server uses `auth.uid()`, and `pull` maps the row back to `ACCOUNT_ROW_ID`.

**Reference data.** `ref_exercises`, `ref_ingredients` and `ref_recipes` can be selected by `anon` and `authenticated`.
No role can write to them.

**Social tables:**

| Table | Notes |
| --- | --- |
| `profiles` | `id = auth user id`, `username citext unique` (format `^[a-z0-9_]{3,20}$`, checked on `::text` because citext `~` ignores case), `display_name`, `avatar_path`, `bio ≤ 280`, `interests text[] ≤ 10`, `discoverable`. No email, health or role columns. |
| `friendships` | `pending`/`accepted`. A unique index on `(least, greatest)` enforces one row per unordered pair, and a check forbids self-requests. |
| `blocks` | `(blocker_id, blocked_id)`, no self-blocks. |
| `posts` | Client `id`, `author_id`, `kind`, `audience`, `caption ≤ 2000`, `snapshot jsonb ≤ 20 kB`, `status draft/published`, `created_at`, `published_at` (feed order), `edited_at`, `deleted_at`, `removed_by_moderator`, `media_cleaned_at`. |
| `post_media` | Client `id`, `(post_id, owner_id)` foreign key to `posts(id, author_id)` (so the media owner is the post author), `position 0–3` unique per post (at most 4), `width`/`height ≤ 4096`, `description ≤ 500`, `status pending/ready`. `image_path` and `thumb_path` are generated, never supplied by the client. |
| `likes` | Primary key `(post_id, user_id)`: one like per user. |
| `comments` | Client `id`, `body 1–1000`, soft delete with `deleted_by`. |
| `notifications` | Created only by security-definer triggers on friend request, accept, like and comment. Never sent to self, skipped when either side has blocked the other, and governed by the recipient's `settings.notifications`. One like notification per (recipient, actor, post). Unliking removes it. |
| `reports` | Exactly one target: post, comment or user. One open report per reporter and target. Statuses: open, actioned, dismissed. |
| `app_roles` | Moderator roles, as described in section 1. |

## 3. RPCs (all `security definer`, `search_path = ''`, EXECUTE for `authenticated` only)

**Sync**

* `sync_push(p_entity, p_id, p_op, p_base_version, p_payload)` is an atomic compare-and-swap:
  * The target row is read with `SELECT … FOR UPDATE` under a per-account advisory lock. Versions are therefore
    committed in order and `sync_pull` never skips a late commit.
  * A tombstone always wins: an upsert on a deleted row returns `gone`.
  * If `base_version` does not match, the call returns `conflict` with the server copy.
  * Retrying a push that already applied returns `conflict` with an identical payload.
  * The payload limit is 1 MB.
* `sync_pull(p_since, p_limit ≤ 1000)` returns `{changes, cursor, hasMore}` in ascending version order.

**Profiles:** `get_my_profile`, `save_my_profile(p_username, p_display_name, p_bio, p_interests, p_discoverable)`,
`is_username_available`, `set_avatar_path`, `get_profile_by_username`, `get_profile_by_id`.

* `get_profile_by_username` needs an exact match. It returns null for a blocked user (either direction) and for a
  non-discoverable profile unless the caller is a friend.
* `get_profile_by_id` also allows viewers with a pending request. A blocker sees `relation: 'blocked'`.

**Friends**

* `send_friend_request(p_target)` is idempotent. If the target already sent you a request, sending one back accepts
  it, because you are its addressee.
* `respond_friend_request(p_request_id, p_accept)` can be called only by the addressee.
* `cancel_friend_request`, `remove_friend` and `unblock_user`.
* `block_user` also deletes the friendship, any pending request in either direction, and notifications between the two
  accounts.
* `list_friends`, `list_friend_requests` and `list_blocked`.

**Posts**

* `create_post_draft(p_id, p_kind, p_audience, p_caption, p_snapshot, p_media)` is idempotent on id and refreshes an
  existing draft.
* `update_post(p_post_id, p_caption, p_audience)` is author only.
* `delete_post` soft-deletes the post and deletes its likes, comments, media rows and notifications.
* `get_post`, `get_feed(p_cursor_created_at, p_cursor_id, p_limit ≤ 50)` and `get_user_posts(p_user_id, …)`. Both
  feeds use keyset pagination on `(published_at desc, id desc)`. Pass `next.created_at` back unchanged (it has
  microsecond precision).

**Interaction**

* `like_post` and `unlike_post` are idempotent.
* `add_comment(p_post_id, p_id, p_body)` is idempotent on id.
* `delete_comment` works for the comment author or the post author.
* `list_comments`.
* `report_content(p_reason, p_post_id | p_comment_id | p_user_id, p_details)`.

**Notifications:** `list_notifications(p_limit)`, `unread_notification_count`, `mark_notifications_read(p_ids | null = all)`.

**Moderation**

* `am_moderator`.
* `list_reports(p_status)` returns live content (caption or body) and requires the moderator role.
* `resolve_report(p_report_id, 'dismiss' | 'remove_content')`:
  * For a post, `remove_content` soft-deletes it as removed by a moderator.
  * For a comment, it soft-deletes the comment.
  * For a user, it sets discoverable to false and clears the bio. v1 does not suspend accounts.
  * Every open report about the same target is resolved with the same outcome.

**Export:** `export_my_data()` (format version 2) returns every private record payload, the caller's profile, posts,
comments, likes, social reports they filed and the friends list, plus (since `20261030000003_authz_fixes.sql`):

* `coaching`: the coach application (`coach_profile` with service areas and qualification claims, `coach_review_events`),
  `relationships_as_client` (with the intake/intro the caller wrote and the sharing scopes), `relationships_as_coach`
  (facts and the coach's own reply only — **not** the client's intake), `messages_sent` (own messages only),
  `checkins_submitted`, `checkin_responses_written`, `feedback_received`, `feedback_written`, `proposals_received`
  (coach proposals that were actually sent, never unsent drafts), `proposals_authored` (incl. own drafts),
  `reports_filed`.
* `ai`: `settings`, `messages` (user + assistant, every column), `usage` (per UTC day), `proposals` (AI proposals).

It never includes another user's private records. Structured data only, with **no photo files or documents**. The
app's own backup/export (Settings) is a separate client-side feature; the RPC is the server-side portability export.

**Service-role only** (EXECUTE revoked from `authenticated`)

* `finalize_post_publish(p_post_id, p_user_id, p_media)`
* `cleanup_media_candidates(p_limit)`
* `cleanup_media_done(p_deleted, p_abandoned)`

### Abuse limits

When a limit is exceeded, the RPC raises SQLSTATE `PT429`, which PostgREST returns as HTTP 429, with a readable message.
Limits are counted in `private.rate_events`, so cancelling or deleting does not reset them.

| Action | Limit |
| --- | --- |
| New posts | 30 per hour |
| Photos (new `post_media` rows; each upload needs one) | 60 per hour |
| Comments | 120 per hour |
| Friend requests | 50 per day |
| Likes | 600 per hour |
| Reports | 20 per hour |

Idempotent retries are not counted.

## 4. Storage

Both buckets are **private** and created by a migration with `public = false`. Both accept `image/jpeg` and `image/webp`.

| Bucket | Size limit | Object path |
| --- | --- | --- |
| `post-media` | 5 MiB | `{owner_id}/{post_id}/{media_id}.jpg` and `{owner_id}/{post_id}/{media_id}_thumb.jpg` |
| `avatars` | 1 MiB | `{owner_id}/avatar_{uuid}.jpg` |

Objects keep the `.jpg` extension even when the content is WebP. The content type header and the magic bytes decide the
real format.

**`post-media` policies on `storage.objects`:**

* **INSERT and UPDATE** (upsert needs both, plus SELECT): allowed only in your own folder, for a **draft** post you
  author, at a path that matches one of that post's `post_media` rows. Once a post is published or deleted, nothing
  more can be uploaded to it.
* **SELECT**, which is also required to create a signed URL: allowed when `can_view_post` is true for the post the
  object belongs to.
* **DELETE**: allowed in your own folder.

**`avatars` policies:**

* Insert and update are allowed in your own folder with the `avatar_{uuid}.jpg` name pattern.
* SELECT is allowed to anyone who can see the profile, and to viewers of a post the person commented on. Blocks hide
  avatars.

**Upload flow (client):**

1. `createPostDraft` creates the draft and its media rows.
2. `uploadPostMedia` uploads the thumbnail, then the image, with `x-upsert: true`. It reports XHR progress and supports
   AbortSignal, and retries are idempotent.
3. `publishPost` invokes **finalize-post**, which checks the following for every media row, then calls
   `finalize_post_publish` to mark the media ready and publish the post in one transaction:
   * both objects exist
   * size: image ≤ 5 MiB, thumbnail ≤ 512 KiB
   * magic bytes are JPEG or WebP
   * no metadata: no JPEG APP1 (EXIF/XMP, including the GPS IFD) or APP13 segment, and no WebP EXIF/XMP chunk or
     animation
   * dimensions: image ≤ 4096 px, thumbnail ≤ 1024 px per side

   If a check fails, finalize-post returns HTTP 422 with `details` listing each problem as `{ mediaId, part, problem }`.
   The client re-encodes, re-uploads (upsert) and calls `publishPost` again.

**Signed URLs and revocation limits.** The client signs media and avatars for **300 seconds** (`SIGNED_URL_TTL` in
`social.ts`) and caches each URL per account for at most that long.

* **What revocation covers.** When access is revoked (audience changed to Only me, unfriend, block, delete or moderator
  removal), no **new** signed URL can be created.
* **Already-issued URLs.** A URL issued earlier keeps working until it expires, at most 5 minutes. Supabase cannot revoke
  individual signed URLs.
* **Copies on the viewer's device.** Images a viewer already downloaded or cached stay with them.
* **Service worker.** Signed URLs and Supabase responses must be excluded from service-worker runtime caches.

**Cleanup.** `delete_post` and moderator removal delete the `post_media` rows right away, so the objects immediately
stop being readable by anyone except the service role. The objects themselves are removed by `cleanup-media`, which also
removes drafts that were never published within 24 hours (their storage objects first, then the draft row).

## 5. Edge Functions

| Function | Auth | Does |
| --- | --- | --- |
| `finalize-post` | User JWT | Body `{ postId }`. Runs the checks in section 4, then publishes. Idempotent. |
| `delete-account` | User JWT | Lists and removes `{uid}/…` in both buckets, then calls `auth.admin.deleteUser(uid)`. Every row is removed through `on delete cascade`. Safe to retry. |
| `cleanup-media` | `x-cleanup-secret: $CLEANUP_SECRET` or the service/secret key | Processes candidates in batches for up to about 50 s. Returns counts. |

**Verifying the caller.** User-facing functions check the token themselves with `auth.getClaims()` (or `getUser()` as a
fallback), whether or not the gateway's `verify_jwt` is on. If your project uses the new asymmetric JWT signing keys and
the gateway rejects valid tokens, deploy with `--no-verify-jwt`. The in-function check still applies.

**Secrets.** These are available only to functions and never belong in the browser or `.env.local`:

* `SUPABASE_URL`, `SUPABASE_ANON_KEY` or `SUPABASE_PUBLISHABLE_KEYS`, and `SUPABASE_SERVICE_ROLE_KEY` or
  `SUPABASE_SECRET_KEYS`. These are provided automatically on hosted projects.
* `CLEANUP_SECRET`, which you set yourself: `supabase secrets set CLEANUP_SECRET=$(openssl rand -hex 32)`.

### Scheduling cleanup-media (Supabase Cron)

1. Enable the `pg_cron` and `pg_net` extensions under Database → Extensions.
2. Store the secrets in Vault.
3. Schedule the job:

```sql
select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
select vault.create_secret('<same value as CLEANUP_SECRET>', 'cleanup_secret');

select cron.schedule('liftcircle-cleanup-media', '17 * * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/cleanup-media',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cleanup-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cleanup_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000);
$$);
```

The job uses a dedicated `CLEANUP_SECRET` rather than the service key because `pg_net` keeps request headers in
`net.http_request_queue` until the request is sent. Only the low-privilege cleanup secret can be exposed that way.
To trigger cleanup by hand, run
`curl -X POST -H "x-cleanup-secret: …" https://<ref>.supabase.co/functions/v1/cleanup-media`.

## 6. Running the database tests

```bash
npm run test:rls
```

The script needs the PostgreSQL 16 binaries in `/usr/lib/postgresql/16/bin`. Override the location with `PG_BIN=…`, and
the port (54329 by default) with `RLS_PG_PORT`. It works as follows:

1. It runs `initdb` into a temporary directory. When run as root, it runs the cluster as the `postgres` OS user.
2. It loads `tests/rls/supabase-stub.sql`, a minimal stand-in for hosted Supabase:
   * the roles `anon`, `authenticated`, `service_role` and `postgres` (non-superuser with `bypassrls`)
   * Supabase's default grants on `public`, which the migrations must revoke
   * `auth.users` with `auth.uid()`, `auth.role()` and `auth.jwt()` reading `request.jwt.claims`
   * a `storage` schema with buckets, objects, `foldername()` and RLS
   * `citext` and `pgcrypto`
3. It applies **all migrations as `postgres`** and then `seed.sql`.
4. It runs the checks (467 at the 2026-10-30 audit), each one as a request: `set local role authenticated` plus `request.jwt.claims` for each
   actor (owner, friend, stranger, signed out, blocked and moderator).
5. It prints the access matrix and a PASS/FAIL list, and exits non-zero if any check fails. Set `RLS_KEEP=1` to keep
   the cluster directory for inspection.

**What it covers:**

* Acceptance tests 9–13 and 15 at database level.
* Grant hygiene: no client write grants, no anon-executable definer functions, `search_path` pinned.
* Rate limits and cascading account deletion.

After the coaching suite, `tests/rls/audit.mjs` (backend audit, repair brief §7) runs with its own actors: the full
social journey, multiple/concurrent coaching requests, consent while pending, former and suspended coaches with
queued photo messages, custom exercises, coach-vs-AI proposals, export contents and coach-account deletion (§8.10).
Run several suites side by side with distinct ports: `RLS_PG_PORT=55429 npm run test:rls`,
`AI_PG_PORT=55439 node tests/rls/ai-run.mjs`.

**What it does not cover:** the real Auth (GoTrue) and Storage HTTP servers, signed-URL issuance, and the Edge Function
runtime. Those are exercised against a deployed project by `tests/live/backend-live.mjs` (setup in
`tests/live/README.md`; needs real test-account credentials in env vars). The JPEG/WebP inspector was checked separately against images generated by sharp (clean, EXIF, progressive,
lossless, oversized and PNG).

## 7. Deploying

```bash
npm i -g supabase                        # or use npx supabase
supabase login
supabase link --project-ref <project-ref>
supabase db push                          # applies supabase/migrations in order
node --experimental-strip-types scripts/gen-reference-seed.mts   # regenerate supabase/seed.sql from src/data
psql "$(supabase db url)" -f supabase/seed.sql   # or paste seed.sql into the SQL editor (idempotent)
supabase functions deploy finalize-post
supabase functions deploy delete-account
supabase functions deploy cleanup-media --no-verify-jwt
supabase secrets set CLEANUP_SECRET=<random>
```

**Single-file bundles** for deploying through the dashboard editor live in `supabase/functions-bundled/` (one per
function, imports of `_shared/*` inlined). Regenerate after changing a function:

```bash
for f in finalize-post delete-account cleanup-media ai-coach geocode finalize-coach-media; do
  npx esbuild supabase/functions/$f/index.ts --bundle --format=esm --platform=neutral --target=es2022 \
    --external:'npm:*' --external:'jsr:*' --outfile=supabase/functions-bundled/$f.ts
done
```

For local development, `supabase start` applies the migrations and `seed.sql` automatically, and
`supabase functions serve` runs the Edge Functions.

**Auth settings (hosted project):**

* Authentication → URL configuration: set the Site URL to the deployed origin and add
  `https://<your-domain>/auth/callback` (and `http://localhost:5173/auth/callback` for development) to the redirect URLs.
* Keep "Confirm email" on.
* Configure SMTP for production email.

**Moderators.** Grant the role in the SQL editor:
`insert into public.app_roles (user_id, role) values ('<auth user uuid>', 'moderator');`

**Adding functions later.** If you add a migration that creates `private` functions, re-run the statements of
`…07_lockdown.sql` (or add a new lockdown migration). Postgres grants EXECUTE to PUBLIC on every new function.

## 8. Coaching

Human coaches, the coach directory, coach/client tools and coaching messages. Migrations
`20261029000001_coaching_schema.sql` (tables, RLS, helpers, buckets), `…02_coaching_rpcs.sql` (RPCs) and
`…04_coaching_lockdown.sql` (must stay last). `…03_ai_coach.sql` (AI coach) sits between them and adds AI rows to
`program_proposals`. Client wrapper: `src/backend/coaching.ts` (implements `CoachingApi` from `coachingContract.ts`).
Names follow `docs/COACHING_INTERFACES.md`.

### 8.1 Schema

| Table | Holds | Direct SELECT (RLS) |
| --- | --- | --- |
| `coach_profiles` | Application + business profile. `city/region/country` are the coach's chosen business location (there is no home-address field). `status`, `suspended*`, `reviewed_at`, `approved_at`, `latest_feedback` are written only by admin RPCs | owner, admins |
| `coach_service_areas` | Declared areas (city / region / country); `lat/lng` only from the geocoder (`geo_source`), stored rounded to 3 decimals | owner, admins |
| `coach_qualifications` | Claims + private document path. A trigger returns an edited reviewed claim to `pending` | owner, admins |
| `coach_review_events` | Append-only log of every transition (submit, resubmit, claim change, every admin action) with actor, time, reason | owner, admins |
| `coaching_relationships` | `requested → active / declined / cancelled`, `active → ended`. One `active` per client, one `requested` per (client, coach), ≤ 3 open requests per client | client; coach unless suspended |
| `coaching_scopes` | Per-relationship sharing: `training`, `measurements`, `nutrition`, `checkins` (client-only writes) | participants |
| `program_proposals` | Coach (`relationship_id` set) and AI rows. Coach rows: `draft → sent → accepted / declined / withdrawn / superseded` | client (AI rows; coach rows once sent — a draft withdrawn unsent stays private) ; active coach (own) |
| `coach_feedback`, `coach_checkins` | Coach notes on sessions; client check-ins + coach response | participants; check-ins need scope `checkins` for the coach |
| `coach_messages`, `coach_message_reads` | 1:1 chat (client-generated id, server `seq`), read markers | readable participants (see 8.2) |
| `coaching_reports` | Reports about a coaching conversation/message (+ snapshot of the reported message) | admins |

`notifications.type` gained `coach_request, coach_request_accepted, coach_request_declined, coach_request_cancelled,
coach_ended, coach_message, coach_proposal, coach_proposal_response, coach_checkin, coach_feedback, coach_application,
coach_status`, plus nullable `relationship_id`, `coach_id`, `proposal_id`. They **never contain message text**.
`list_notifications` now also returns those three ids; visibility is unchanged (recipient only). Coaching
notifications respect `settings.notifications.coaching` (default on), are only created for accounts with a social
profile (the existing `recipient_id → profiles` foreign key), and new chat messages collapse into one unread
`coach_message` notification per conversation.

### 8.2 Authorization model

* **Active coach** = `status = 'approved' and not suspended` (`private.coach_is_active`). Evaluated against the current
  row on every request, so a suspension applies to the very next query even if the coach's JWT is still valid.
* **`private.coach_can_access(viewer, client, scope)`** = an `active` relationship (viewer is the coach) + active coach
  + the client's scope flag + no block in either direction. It is the only thing that grants a coach access to a
  client's private records. **Friendship never does.**
* **Relationship participation** (`private.is_relationship_participant(rel, viewer, writable)`): *writable* = status
  `active`, coach active, no block. *Readable* = participant, status `active/ended/declined/cancelled`, and the viewer
  is the client or the coach is not suspended.
* **Writes**: no table grants exist for clients; coaches have no write path to client records at all (`sync_push`
  always writes the caller's own rows). Every coaching RPC re-checks the relationship, so a queued offline write after
  revocation, ending, blocking or suspension is refused (42501 / P0001) — the client should surface that and drop or
  keep the draft locally.
* **Admins** (`app_roles.role = 'admin'`, `private.is_admin`) review applications and documents, suspend/reinstate and
  handle coaching reports. They get **no** access to client health tables or conversations (reports show only the
  reported message). An admin cannot review their own application.
* **Blocking** (either direction) ends active and cancels pending relationships between the pair (trigger on
  `blocks`); unblocking does not restore them.

**Coach access matrix** (verified by `npm run test:rls`; Y = can read):

| Resource | client | coach (active, scoped) | other coach | pending / rejected applicant | suspended coach | social friend | stranger | admin | anon |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| workouts, sets, programs + versions, activities, goals | Y | Y if `training` | · | · | · | · | · | · | · |
| measurements | Y | Y if `measurements` | · | · | · | · | · | · | · |
| food logs | Y | Y if `nutrition` | · | · | · | · | · | · | · |
| account_state (private profile/health) | Y | · (sees the intake snapshot instead) | · | · | · | · | · | · | · |
| check-ins | Y | Y if `checkins` | · | · | · | · | · | · | · |
| relationship + intake | Y | Y (pending: intake + intro only) | · | · | · (intake hidden) | · | · | · | · |
| messages + chat photos | Y | Y | · | · | · | · | · | · | · |
| qualification documents | — | own only | · | own only | own only | · | · | Y | · |
| applications queue, coaching reports | · | · | · | · | · | · | · | Y | · |

Pending request: the coach sees only the relationship (intake snapshot + intro message); every data panel is null,
and chat starts after acceptance. Coach policies on existing tables are additional `SELECT` policies OR'd with
"owner can read"; nothing was changed on `account_state`.

### 8.3 Application state machine

`draft → submitted` (validated: display name, bio ≥ 40 characters, ≥ 1 specialty, ≥ 1 language, country, ≥ 1 format,
≥ 1 service area when in-person) → admin `approve | request_changes (reason) | reject (reason)`;
`changes_requested | rejected → (edit) → submitted` again. Profile edits never change `status`; an approved coach stays
approved, but an edited reviewed qualification returns to `pending` and is not public until re-approved.
`suspend (reason)` / `reinstate` are independent of `status`. Every transition is logged in `coach_review_events` and
the applicant gets an in-app notification (`coach_application`, or `coach_status` for suspend/reinstate). Admins are
notified of new submissions. **Listing** (`listed`) and **accepting new clients** are coach-controlled and separate
from approval; the directory shows only approved, non-suspended, listed coaches. `accepting_clients = false` blocks
new requests but leaves existing clients alone.

### 8.4 RPCs (authenticated only)

| Area | RPCs |
| --- | --- |
| Roles | `my_roles()` → `{admin, moderator}` |
| Applicant | `get_my_coach_profile()`, `save_my_coach_profile(p)`, `submit_coach_application()`, `set_coach_listing(p_listed, p_accepting)`, `my_coach_review_events()` |
| Directory | `search_coaches(p)` → `{items, has_more, distance_available}`, `get_coach(p_coach)` |
| Relationships | `request_coaching(p_id, p_coach, p_intake, p_message, p_scopes)` (idempotent, client only), `cancel_coaching_request`, `respond_coaching_request(p_id, p_accept, p_message)` (coach only; accepting ends the client's previous coach with `end_reason = 'switched coach'` and cancels their other pending requests — see "Switching" below), `end_coaching(p_id, p_reason)`, `set_coaching_scopes`, `my_coaching_relationships()`, `coach_client_overview(p_id)` |
| Programs | `save_program_proposal(p)`, `send_program_proposal`, `withdraw_program_proposal`, `list_program_proposals(p)`, `get_program_proposal`, `respond_program_proposal(p_id, p_accept, p_program_id, p_version)` |
| Feedback / check-ins | `add_coach_feedback`, `list_coach_feedback`, `submit_checkin`, `list_checkins`, `respond_checkin` |
| Messages | `list_coach_messages(p_relationship, p_after_seq, p_limit)`, `send_coach_message(p_id, p_relationship, p_body, p_media, p_shared_from_ai)` (idempotent: same id → stored row, no second notification), `mark_coach_messages_read`, `unread_coaching_count()`, `report_coaching_content` |
| Admin | `admin_list_coach_applications(p_filter)`, `admin_get_coach_application`, `admin_review_coach(p_coach, p_action, p_reason, p_qualification)`, `admin_list_coaching_reports(p_status)`, `admin_resolve_coaching_report(p_id, p_action)` |
| Functions | `coaching_geocode_quota()` (geocode function); service-role only: `coach_media_pending`, `finalize_coach_message` |

**Switching and multiple requests.** A client may have up to 3 pending requests. Accepting one (a) ends the
client's current coach only if that coach was already active when the client sent this request — the request page
warns the client about exactly that switch — and (b) cancels every other pending request in the same transaction, so
an older request can never be accepted later and silently replace the coach the client chose since ("This request is
no longer pending."). If a request predates the client's current coaching (not reachable through the API; a guard for
legacy rows), acceptance is refused with hint `stale_request` and nothing changes. All changes to one client's requests
are serialized by a per-client advisory lock taken **before** any row lock, so two coaches accepting at the same moment
get one acceptance and one "no longer pending" (previously a deadlock error, fixed in `20261030000003_authz_fixes.sql`).

**Program proposals.** Revisions number per (relationship, base program). Sending supersedes older `sent` proposals
for the same base. Accepting requires `p_program_id`/`p_version` (the new version the client applies it as, in the
base program); when the base program exists on the server, its `current_version` must still be `base_version` (or
already `p_version` if the client pushed first) — otherwise the RPC raises "…stale…" (hint `stale`). Accepted
proposals record the applied ids. The coach never writes the client's program; the client applies the proposal
through the normal program/version flow, so recorded workouts are never changed.

**Directory search.** Place text (city / region / country) is matched case- and diacritic-insensitively
(`private.fold_text`) against service areas and the profile's business location. `match = 'local'` needs in-person
format and a matching area; with search coordinates (browser location or a geocoded place) an area with coordinates
also matches within its `radius_km` (or the search `radiusKm`, default 25 km), and `radiusKm` filters by distance.
`distance_km` is returned (rounded, at least 1) only when both the search point and a matched area have coordinates —
otherwise it is null; `distance_available` says whether any local result had one. Online coaches not matched locally
are returned as `match = 'remote'` when they are in the searched country, speak the filtered language, or no country
was given. Order: local by distance then name, then remote. `limit` ≤ 50. Public cards never include documents,
review state or suspension, and publish area coordinates at 2 decimals (≈1 km).

### 8.5 Storage

| Bucket | Limit / types | Path | Read | Write |
| --- | --- | --- | --- | --- |
| `coach-public` | 2 MiB, jpeg/webp | `{coach_id}/photo_{uuid}.jpg` | owner, admins, or anyone signed in when it is the current photo of an approved, non-suspended coach that is listed or already their coach | owner folder |
| `coach-docs` | 10 MiB, pdf/jpeg/png/webp | `{coach_id}/{qualification_id}/{filename}` | applicant + admins | owner folder |
| `coach-media` | 5 MiB, jpeg/webp | `{relationship_id}/{message_id}/{media_id}.jpg` and `_thumb.jpg` | readable participants (others' photos only once sent) | the sender, while writable, for a message still `awaiting_media`, at a declared media id |

Signed URLs: 300 s for photos/chat media, 60 s for documents (`coaching.ts`). The revocation limits in section 4
apply (already-issued URLs live until they expire).

### 8.6 Edge Functions

| Function | Auth | Does |
| --- | --- | --- |
| `geocode` | User JWT | `{query}` → `{available, results ≤ 5}` with lat/lng rounded to 3 decimals. `GEOCODER=nominatim` + `GEOCODER_CONTACT_EMAIL` (required by the OSM usage policy; optional `NOMINATIM_URL` for a self-hosted instance). Sends a descriptive User-Agent, throttles upstream calls to ≤ 1/s per instance, caches 24 h, limits users to 10/min (memory) and 60/h (`coaching_geocode_quota`). `GEOCODER=none` or unset → `{available:false, results:[]}`: the directory still works with town/region text search, just without distances. |
| `finalize-coach-media` | User JWT | `{messageId}`: checks sender + writable conversation, validates every image + thumbnail with `_shared/image.ts` (JPEG/WebP, no EXIF/GPS, image ≤ 5 MiB / 4096 px, thumb ≤ 512 KiB / 1024 px), then marks the message `sent` (fresh `seq`) and notifies the other side. Idempotent. `coachingApi.uploadMessageMedia` calls it after each upload; it succeeds once all declared photos are there. |

Deploy: `supabase functions deploy geocode` and `supabase functions deploy finalize-coach-media`;
`supabase secrets set GEOCODER=nominatim GEOCODER_CONTACT_EMAIL=you@example.com`. Public Nominatim is free but
limited to light use; for real traffic use a self-hosted Nominatim or a commercial geocoder behind the same function.

### 8.7 Rate limits (PT429)

| Action | Limit |
| --- | --- |
| Coaching requests | 10 per day per client (≤ 3 open at a time) |
| Coach messages | 120 per hour per user |
| Program proposals (new) | 20 per day per coach |
| Coach feedback | 200 per day per coach |
| Check-ins | 20 per day per client |
| Coaching reports | 20 per hour |
| Application submissions | 10 per day; profile saves 120 per hour |
| Geocoding | 60 per hour per user (+ 10/min per function instance) |

### 8.8 Suspension, ending and retention

* **Suspension** removes the listing and detail page, and immediately stops every coach read (client records,
  overview, intake, chat, proposals) and every coach action, even with an open session. Active clients get a
  `coach_status` notification and see `coach.suspended = true`; their workouts, accepted programs and chat history are
  untouched. **Reinstating** restores access.
* **Ending / switching / blocking** stops coach access on the next request; open proposals are withdrawn.
* **Message retention:** an ended conversation stays **read-only for both participants while both accounts exist**.
  A suspended coach loses read access (the client keeps it). Deleting either account cascades the relationship,
  its scopes, messages, read markers, feedback, check-ins, proposals and coaching notifications. `delete-account`
  removes the user's `coach-public` and `coach-docs` folders and the `coach-media` folder of every relationship they
  were part of before deleting the auth user. Known gaps: photos of a single message removed by an admin
  (`remove_message`) and photos/documents picked but never saved on the apply page stay in storage (unreferenced).

### 8.9 First admin (provisioning)

There is deliberately **no RPC that grants roles**: any such endpoint would be one bug away from privilege
escalation, and the first admin cannot be authorized by anyone. Grant it once in the Supabase SQL editor (runs as
`postgres`) or with the service role, using the person's auth user id (Authentication → Users):

```sql
insert into public.app_roles (user_id, role) values ('<auth user uuid>', 'admin') on conflict do nothing;
-- revoke:
delete from public.app_roles where user_id = '<auth user uuid>' and role = 'admin';
```

`app_roles` has RLS with no policies and no client grants, so no user can read or change roles through the API; the
app learns its own roles only through `my_roles()`. Admin RPCs refuse everyone else with 42501.

**Tests.** `npm run test:rls` runs the coaching matrix (`tests/rls/coaching.mjs`): applications, listing and
suspension, local/remote/radius/no-coordinate search, pending vs active scopes, other coach / friend / stranger /
admin / anon denial, revocation, ending, blocking and suspension against direct and queued writes, proposal
lifecycle with stale rejection, idempotent messaging, media finalization and account-deletion cascade. Not covered
locally: the real Storage/Auth HTTP servers, signed-URL issuance, the Edge Function runtime and the live Nominatim API.

### 8.10 Backend audit (repair brief §7, 2026-10-30)

Labels: **reproduced defect** (failing test before the fix), **source-confirmed concern** (read in code, not exploitable
or not tested end-to-end), **passed check**, **blocked verification** (needs the deployed project).

| Finding | Label | Fix / status |
| --- | --- | --- |
| Two coaches accepting two pending requests of the same client concurrently → `40P01 deadlock detected` for one of them (state stayed consistent) | reproduced defect (low) | lock order fixed in `respond_coaching_request`; test `audit coaching › concurrent acceptance…` |
| Old pending request accepted after the client started with another coach | passed check (cancelled by the acceptance); guard added for legacy rows (`stale_request`) | tests `audit coaching › requests to A and B…`, `› legacy/raced state…`, `› explicit switch still works…` |
| A coach draft withdrawn without being sent (also what ending/switching coaching does to open drafts) became readable by the client (RLS + `get/list_program_proposal`) | reproduced defect (low–medium: coach's unsent work) | client sees coach proposals only once sent (`sent_at`); test `audit programs › a coach draft withdrawn…` |
| `export_my_data` lacked coaching and AI data | reproduced defect (portability) | export v2; tests `audit export ›` (run.mjs) and `export ›` (ai-run.mjs) |
| Custom exercises: coach proposals carry exercise **ids only**; the server accepts catalog slugs and uuid-shaped (custom) ids without definitions; the coach program editor validates against the bundled catalog only, so a coach can't send own custom exercises, and revising a client plan that contains the client's custom exercises fails validation in the editor | source-confirmed limitation (UI gap, no exposure) | private catalogs stay private (tested); recommended UI follow-up: hide custom exercises in the coach picker and pass the client's custom ids through as opaque "client's own exercise" |
| AI proposal accepted over a coach-managed plan | passed check: stale rule both directions + `for_coach_review` never applicable (DB); the explicit "switch from coach" path is a client-side user choice by design | test `audit programs › coach and AI proposals…` |
| Already-issued signed URLs survive a revocation for their TTL (≤ 300 s) | source-confirmed, documented platform limit | §4 |
| `coach-public` photo readable by any client with any (also declined/cancelled) relationship row with that coach while approved | source-confirmed concern (low; business photo) | not changed |
| Admins can sign any object under `coach-docs`, including documents no longer referenced (removed claims, deleted coaches until `delete-account` removed them) | source-confirmed concern (low; admins are reviewers) | not changed |
| Secrets: no `sk-`/`sb_secret_`/service keys in `src`, `dist*` or `supabase/functions-bundled`; Edge Functions read keys only from `Deno.env`; the publishable key in the built bundle is expected | passed check (grep) | — |
| Deployed project: GoTrue, Storage HTTP, signed URLs, Edge Function runtime, real coach journey | blocked verification | `tests/live/backend-live.mjs` |

