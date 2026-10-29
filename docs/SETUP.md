# Setup guide

This guide assumes no prior Supabase experience. Personal mode needs only steps 1 and 5. Connected mode
(accounts, sync, friends, photos) needs all of them.

## 1. Run it locally

1. Install **Node.js 22** (nodejs.org) — `node -v` should print v20 or later.
2. In the project folder:
   ```bash
   npm install
   npm run dev
   ```
3. Open http://localhost:5173. You're in **Personal mode**: everything is stored in this browser.

To try the production build (service worker, offline, install prompt): `npm run build && npm run preview` → http://localhost:4173.

## 2. Create the backend (Supabase)

1. Sign up at https://supabase.com and click **New project**. Choose a region near your users, set a database password
   (keep it somewhere safe), and wait for the project to start.
2. Install the CLI and link the project (from the project folder):
   ```bash
   npx supabase login
   npx supabase link --project-ref <your-project-ref>     # the ref is in Project Settings → General
   ```
3. **Apply the migrations** (tables, row-level security, RPCs, storage buckets and policies):
   ```bash
   npx supabase db push
   ```
4. **Load the reference catalogs** (exercises, ingredients, recipes — read-only shared data):
   open *SQL Editor → New query*, paste the contents of `supabase/seed.sql` and run it. It's idempotent.
   (If you edit `src/data/*`, regenerate it with `node --experimental-strip-types scripts/gen-reference-seed.mts`.)
5. **Deploy the Edge Functions** (photo validation/publishing, account deletion, media cleanup):
   ```bash
   npx supabase functions deploy finalize-post
   npx supabase functions deploy delete-account
   npx supabase functions deploy cleanup-media --no-verify-jwt
   npx supabase secrets set CLEANUP_SECRET=$(openssl rand -hex 24)
   ```
   (Coaching and the AI coach add three more functions; see §7.)
   Then schedule `cleanup-media` hourly (Integrations → Cron), see docs/BACKEND.md §5.
   The service-role key is available to functions automatically — **never** put it in the app or `.env.local`.

## 3. Configure authentication

In the Supabase dashboard → **Authentication**:

1. **Sign In / Providers → Email**: enabled, **Confirm email: on**.
2. **URL Configuration**:
   - *Site URL*: your deployed address, e.g. `https://liftcircle.netlify.app`.
   - *Redirect URLs*: add `https://liftcircle.netlify.app/auth/callback` and, for development,
     `http://localhost:5173/auth/callback` and `http://localhost:4173/auth/callback`.
3. **Emails (SMTP)**: the built-in sender is rate-limited and meant for testing. For real users configure your own
   SMTP provider (Project Settings → Auth → SMTP).

Sign-up, sign-in, email verification and password reset all go through `/auth` and `/auth/callback` (PKCE flow).

## 4. Connect the app

1. Copy `.env.example` to `.env.local`.
2. From *Project Settings → API* copy the **Project URL** and the **anon / publishable key** into
   `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. Both are designed to be public; access is enforced by RLS.
3. Optionally set `VITE_PUBLIC_APP_URL` (used for shareable profile links).
4. Restart `npm run dev`. Settings → Account now offers *Create account / Sign in*.

**Private storage** is created by the migrations: buckets `post-media` and `avatars` are private
(`public = false`). The app only ever receives short-lived signed URLs (5 minutes), created after the database checks
that the viewer may see the post. Nothing needs configuring in the dashboard.

**Moderators**: run `insert into public.app_roles (user_id, role) values ('<user uuid>', 'moderator');` in the SQL
editor. The Moderation screen appears for that user under `/moderation`.

## 5. Deploy the app (Netlify, HTTPS)

PWAs require HTTPS; Netlify provides it automatically. `netlify.toml` already contains the build command, SPA routing
and cache headers (the service worker is never cached long-term).

1. Push the project to GitHub (or GitLab/Bitbucket).
2. On https://app.netlify.com → **Add new site → Import an existing project**, pick the repository.
   Netlify reads `netlify.toml`; leave the build settings as detected.
3. *Site configuration → Environment variables*: add `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
   (and `VITE_PUBLIC_APP_URL` = your site URL). Skip this for a Personal-mode deployment.
4. **Deploy**. Then put the final URL into Supabase's Site URL / Redirect URLs (step 3).
5. Optional custom domain: *Domain management → Add domain*; Netlify provisions the certificate.

Alternative without Git: `npm run build`, then drag the `dist/` folder onto Netlify's *Deploys* page
(environment variables must be set before building in that case, e.g. in `.env.local`).

## 6. Verify

```bash
npm run test:all
```

Then the live check against your own project (creates posts, then deletes them):

1. In *Authentication → Users → Add user*, create three users with "Auto confirm" ticked.
2. Run:
   ```bash
   LC_TEST_A=a@example.com:passwordA LC_TEST_B=b@example.com:passwordB LC_TEST_C=c@example.com:passwordC npm run test:live
   ```
   It checks friend requests (incl. "stranger can't accept"), a photo post through Storage and `finalize-post`,
   likes/comments, stranger and friend isolation of posts, media and private records, audience changes and blocking.

Finally, on a real phone: open the HTTPS site, install it (docs/USER_GUIDE.md), launch from the home screen, log a set,
turn on airplane mode, reload, keep logging.

## 7. Coaching and the AI coach (added 29 Oct 2026)

Everything below is optional: without it, the Coaching tab truthfully says what isn't available and the rest of the
app keeps working. Details: docs/BACKEND.md §8 (coaching), docs/AI_COACH.md (AI coach).

1. **Apply the 4 new migrations, in this order** (additive; no existing table is rewritten):
   `20261029000001_coaching_schema.sql`, `…02_coaching_rpcs.sql`, `…03_ai_coach.sql`, `…04_coaching_lockdown.sql`.
   With the CLI, `npx supabase db push` applies only these. In the dashboard, paste each file into the SQL editor in
   that order; the editor warns that a statement enables RLS / deletes rows inside a function body — both are expected.
   `…04` must run last (it re-applies the function lockdown).
2. **Deploy the 3 new Edge Functions** and the updated `delete-account` (now also removes coach photos, qualification
   documents and chat photos):
   ```bash
   npx supabase functions deploy geocode
   npx supabase functions deploy finalize-coach-media
   npx supabase functions deploy ai-coach
   npx supabase functions deploy delete-account
   ```
   All four keep JWT verification ON. Without the CLI, paste the single-file bundles from
   `supabase/functions-bundled/` (`geocode.ts`, `finalize-coach-media.ts`, `ai-coach.ts`, `delete-account.ts`) into
   *Edge Functions → Deploy new function → Via editor*, using those names.
3. **Make yourself the first admin** (reviews coach applications and coaching reports). There is no way to do this
   from the app, by design. Find your user id under *Authentication → Users*, then in the SQL editor:
   ```sql
   insert into public.app_roles (user_id, role) values ('<your auth user uuid>', 'admin') on conflict do nothing;
   ```
   The admin screens are under *Coaching → Coach administration*. Admins can review applications and documents,
   approve, request changes, reject, suspend and reinstate, and handle reports. They get no general access to client
   health records.
4. **Location search (optional distance).** Without a geocoder, "Look for a coach" searches by town/region/country
   text and never shows distances. To enable place suggestions, "Use my location" and distance:
   ```bash
   npx supabase secrets set GEOCODER=nominatim GEOCODER_CONTACT_EMAIL=you@example.com
   ```
   Public OpenStreetMap Nominatim is free for light use only (≤ 1 request/s, identify your app). For real traffic, set
   `NOMINATIM_URL` to a self-hosted Nominatim, or put a commercial geocoder behind the same `geocode` function.
5. **AI coach (optional, paid per use).** Pick **one** provider. Either way the key lives only in the function
   secrets — never in `.env.local` or Netlify — and the app tells users which company receives their data.

   **OpenAI** (platform.openai.com → API keys). A ChatGPT Plus/Pro/Team subscription does **not** include API access;
   the API is billed separately per token from prepaid credits on the OpenAI Platform. Set a usage limit there.
   ```bash
   npx supabase secrets set OPENAI_API_KEY=sk-...                   # alone, this selects OpenAI
   npx supabase secrets set OPENAI_MODEL=gpt-5-mini                 # optional; any Chat Completions model your key can use
   ```
   **Anthropic** (platform.claude.com → API keys; a Claude.ai subscription doesn't include API access either):
   ```bash
   npx supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
   npx supabase secrets set ANTHROPIC_MODEL=claude-sonnet-5-5       # optional
   ```
   With both keys set, `AI_PROVIDER=openai` or `AI_PROVIDER=anthropic` decides (default Anthropic). Shared, optional:
   ```bash
   npx supabase secrets set AI_DAILY_REQUEST_LIMIT=40 AI_MAX_OUTPUT_TOKENS=1200 \
     AI_PRICE_INPUT_PER_MTOK=<$ per M input tokens> AI_PRICE_OUTPUT_PER_MTOK=<$ per M output tokens>
   ```
   Prices are only used for the cost estimate in `public.ai_usage`; copy them from your provider's pricing page. A chat
   message is typically 1–3 API calls with a few thousand input tokens. Without a key, the AI coach screens say
   "not set up" and nothing is sent anywhere. Users agree to one named provider: if you switch provider later, each
   user is asked to review and agree again before anything is sent to the new one.
6. **Nothing to change in Netlify**: the app still only needs `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. Rebuild
   and redeploy so users get the new screens.

## 8. Upgrading an existing project to v0.3.0 (30 Oct 2026)

v0.3.0 adds four migrations (`20261030000001_set_validation`, `…02_ai_coach_v2`, `…03_authz_fixes`,
`…04_public_coach_preview`). All are additive: no table is dropped, no row is rewritten, existing invalid workout rows
are grandfathered.

- **With the CLI:** `supabase db push`, then `supabase functions deploy ai-coach`.
- **Without the CLI (dashboard):** paste `deploy/2026-10-30_migrations.sql` into the SQL editor and Run. It applies the
  four files in order inside one transaction and records them in `supabase_migrations.schema_migrations`. Then open
  Edge Functions → `ai-coach`, replace the code with `supabase/functions-bundled/ai-coach.ts` and Deploy (Verify JWT
  stays **off**). Order matters: database first, then the function.
- **Site:** `VITE_SUPABASE_URL=… VITE_SUPABASE_ANON_KEY=… npm run build` and upload `dist/` to Netlify. The build now
  ships a Content-Security-Policy in `public/_headers`; if you change the inline script in `index.html` the build fails
  and prints the new hash to paste there. If you use a different Supabase project, change its origin in the CSP too.
- **Verify:** run `tests/live/schema-fingerprint.sql` in the SQL editor and compare with
  `node tests/live/schema-fingerprint.mjs` locally (identical rows = deployed schema matches the repo). Optional live
  journeys: `tests/live/README.md`.

## Troubleshooting

- **"Accounts aren't enabled in this version"** — `.env.local` (or Netlify env vars) missing, or the app was built before
  they were set. Rebuild.
- **Email link opens but doesn't sign in** — the exact `/auth/callback` URL is missing from Redirect URLs.
- **`npm install` peer-dependency error** — keep the `.npmrc` (`legacy-peer-deps=true`).
- **Photos fail with "required update"** — the `finalize-post` function isn't deployed.
- **Coaching says "Coaching isn't available right now"** — the 2026-10-29 migrations aren't applied yet (§7.1).
- **"Admins only" on the admin screen** — your user id isn't in `public.app_roles` with role `admin` (§7.3).
- **AI coach says "not set up"** — no `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` function secret (or `AI_PROVIDER` names a provider without a key), the key is invalid, or `ai-coach` isn't deployed (§7.5).
- **AI coach says "unavailable" with OpenAI** — often out of API credits (billing is separate from ChatGPT), or `OPENAI_MODEL` names a model your key can't use. The function logs `kind: quota` or the HTTP status, never message content.
- **Chat photos stay "Uploading…"** — `finalize-coach-media` isn't deployed.
