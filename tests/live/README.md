# Live backend authorization checks (deployed Supabase project)

`tests/live/backend-live.mjs` runs the key authorization checks of `docs/BACKEND.md` against the **deployed**
project over HTTPS — PostgREST tables and RPCs, Storage (upload / signed URLs) and the Edge Functions — with one real
test account per role. It complements the local database suite (`npm run test:rls`, `node tests/rls/ai-run.mjs`),
which proves the same rules against a throwaway Postgres but cannot exercise GoTrue, the Storage server, signed-URL
issuance or the Edge Function runtime.

Status in the build sandbox: **blocked** (the sandbox cannot reach `*.supabase.co`). Run it from a machine that can.

## 1. Accounts

Create these confirmed users in the project (Authentication → Users → Add user, "Auto confirm"). Use dedicated test
accounts, never real people's accounts.

| Env var | Role in the run |
| --- | --- |
| `LC_MEMBER` | Member / client: private records, shares a post, requests coaching, accepts a program |
| `LC_FRIEND` | Becomes the member's accepted friend |
| `LC_STRANGER` | Unrelated account (also the one deleted with `LC_LIVE_DELETE_ACCOUNT=1`) |
| `LC_APPLICANT` | Applies as a coach during the run; after approval it is the journey's coach |
| `LC_COACH_B` | Second coach: multiple pending requests; approved by the admin during the run if needed |
| `LC_ADMIN` | Admin (role granted in step 3) |

Each variable is `email:password`. Pass them on the command line or from a password manager; **never commit them**
and never put them in `.env.local` (that file is for the browser build).

## 2. Migrations and functions

Deploy everything first (docs/BACKEND.md §7), including `supabase/migrations/20261030000003_authz_fixes.sql`, and
the functions `finalize-post`, `finalize-coach-media`, `delete-account`, `cleanup-media`, `geocode`, `ai-coach`.
Without the 20261030000003 migration the export check reports BLOCKED (old export without coaching/AI data).

## 3. Grant the admin role (SQL editor, once)

```sql
insert into public.app_roles (user_id, role)
select id, 'admin' from auth.users where email = '<admin test email>' on conflict do nothing;
```

## 4. Coach approval without an admin account (optional fallback)

The script approves the applicant through the admin RPC (`admin_review_coach`). If you run it without `LC_ADMIN`,
the approval check reports BLOCKED; approve in the SQL editor instead, then run the script again:

```sql
update public.coach_profiles set status = 'approved', reviewed_at = now(), approved_at = now()
 where user_id = (select id from auth.users where email = '<applicant test email>') and status = 'submitted';
```

## 5. Run

```bash
LC_SUPABASE_URL=https://<ref>.supabase.co LC_SUPABASE_ANON_KEY=<publishable key> \
LC_MEMBER='member@example.com:…' LC_FRIEND='friend@example.com:…' LC_STRANGER='stranger@example.com:…' \
LC_APPLICANT='coach@example.com:…' LC_COACH_B='coachb@example.com:…' LC_ADMIN='admin@example.com:…' \
node tests/live/backend-live.mjs
```

Options: `LC_LIVE_ONLY=anon,private,social,coach,coaching,export,ai,cleanup` (comma list),
`LC_LIVE_AI=1` (sends two real AI messages, costs tokens: needs AI consent saved for the member and a provider key),
`LC_LIVE_DELETE_ACCOUNT=1` (calls `delete-account` for the stranger; recreate the account afterwards),
`LC_LIVE_TIMEOUT_MS` (per request, default 20000).

Output: one line per check — `PASS`, `FAIL` (exit code 1) or `BLOCKED` (missing credentials or component). Re-runs
are safe: the script resets the member's open coaching and uses fresh ids.

## 6. What it covers

| Area | Checks |
| --- | --- |
| anon | no private tables / RPCs / feed / coach search / export; reference catalog public; every Edge Function refuses calls without a user JWT; `cleanup-media` refuses the publishable key |
| private | member's workouts, sets, measurements, food logs, account state, programs invisible to friend, stranger, admin, coaches without a relationship; syncing a finished workout creates no post |
| social | friend request (idempotent, stranger cannot accept); Friends post with photo: path rules, `finalize-post`, retries; friend feed card + signed URL that downloads; stranger/anon denied; like/comment retries → one row and one notification each; Friends → Only me revokes post, comments, media rows and new signed URLs (prints what an earlier URL returns — documented ≤ 300 s limit) |
| coach | application + restricted document (applicant and admin only), not listed before approval, no self-approval, admin approval, admin has no health-record access, directory town search without geolocation (no invented distance), remote listing, no private columns |
| coaching | request with category consent (idempotent), pending = intake only; acceptance → exactly the consented categories; the second pending request is cancelled and cannot be accepted later; private messages (idempotent, notifications without text, photo through `finalize-coach-media`, outsiders denied); proposal → client acceptance → completed workout → coach sees the plan and session; stale proposal refused; scope revocation and ending with the coach's session still open |
| export | `export_my_data` coaching + AI sections; coach export without the client's intake or records |
| ai | `ai-coach` status (no secrets in the response); optional live journey incl. "I can only train twice this week" + idempotent resend — judge the reply text manually against docs/REPAIR_BRIEF §3 |
| cleanup | post deletion stops signing; optional `delete-account` |

Not automated here: suspension of a live coach (do it by hand: `admin_review_coach(..., 'suspend', 'test')` as the admin,
then repeat the coaching read checks with the coach's existing session — they must fail immediately; reinstate after),
blocking, and moderation of reports (covered by the local suite).
