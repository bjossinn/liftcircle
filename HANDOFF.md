# Where we are (deployment) — updated 30 Oct 2026 (v0.3.0 repair release prepared)

Supabase project **LiftCircle** (ref `haryomdlsgrgrnsbdxui`, region eu-west-1, org "bjossinn's Org").

## Done
- [x] All 11 migrations applied via the SQL editor (44 tables, RLS on all, buckets `post-media`, `avatars`,
      `coach-public`, `coach-docs`, `coach-media`), history recorded in `supabase_migrations.schema_migrations`.
- [x] Reference catalogs seeded: 105 exercises, 74 ingredients, 24 recipes.
- [x] Edge Functions deployed from `supabase/functions-bundled/` (29 Oct): finalize-post, delete-account,
      cleanup-media, geocode, finalize-coach-media, ai-coach. Each answers 401 without a sign-in.
- [x] Live build (Supabase URL + publishable key baked in) at `Claude outputs/liftcircle-site/` on the laptop,
      with `_redirects` (SPA routing) and `_headers` (geolocation allowed for "Use my location").

- [x] Function JWT switches off, secrets set (OPENAI_API_KEY, CLEANUP_SECRET, GEOCODER, GEOCODER_CONTACT_EMAIL).
- [x] Live at https://liftcircle.netlify.app; Supabase Site URL + redirect URLs set.
- [x] First account is admin.

## v0.3.0 repair release — waiting for you (production deploys need the owner)
Full report: docs/AUDIT_2026-10-29.md. Live schema was verified identical to the repo before the release.
1. SQL editor → paste `deploy/2026-10-30_migrations.sql` → Run (one transaction, 4 additive migrations, no data changes).
2. Edge Functions → `ai-coach` → paste `supabase/functions-bundled/ai-coach.ts` → Deploy (keep Verify JWT off).
3. Netlify Deploys → drag the new `liftcircle-site` folder (built with the two VITE_SUPABASE_* values).
4. Check: rerun `tests/live/schema-fingerprint.sql` (fn row 170 / b8b7412d…), AI chat "I can only train twice this
   week" → "Apply to this week" card, DevTools console has no "Refused to…" CSP errors.

## Still to do
1. Phone test: install, log a workout offline, feed post with photo, AI coach message (check platform.openai.com usage).
2. Optional: hourly cron for cleanup-media (docs/BACKEND.md §5) — needs the CLEANUP_SECRET in Vault.
3. Redeploys: rebuild with the two VITE_SUPABASE_* values and drag the new dist onto the site's Deploys page.
