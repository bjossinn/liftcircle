# Brand audit: LiftCircle → Hard Earned (v1.0.0, 31 Oct 2026)

Source of truth: the brand kit in `brand/hard-earned/` (Hard_Earned_Brand_Guide.txt, hard-earned-tokens.css,
contrast-matrix.json, assets/asset-manifest.json). This is a rebrand, not a redesign: name, colours, icons, fonts and
copy tone changed; layouts, navigation, routes, features, data, training logic and the backend did not, apart from the
one additive text migration listed below.

**Result: zero current user-facing LiftCircle references remain in the app, its manifest, its notifications, its
Edge Functions or its active docs.** Every remaining match is a durable identifier, a historical record or a
deployment-dependent value, listed in the allowlist below. Two of those are visible outside the app until you change
external settings (owner tasks): the `liftcircle.netlify.app` address and the Supabase Auth email templates.

## 1. Rename counts

**Method (same before and after):** ripgrep, case-insensitive, pattern `lift[[:space:]_-]*circle`, counting every match
(`rg -i -o … | wc -l`) and matching files (`rg -i -l … | wc -l`), including hidden files, excluding `.git`, `node_modules`,
`dist`, `dev-dist`, `test-results`, `playwright-report` and the brand kit itself (`brand/hard-earned/**`, which describes
the rename and mentions the old name 18 times). Filenames were checked the same way (`rg --files | rg -i …`).

| | Occurrences | Files | Filenames |
|---|---|---|---|
| Before (branch base, after merging main) | 173 | 81 | 0 |
| After, before writing the two rebrand reports | 51 | 19 | 0 |
| After, final (including this audit and the verification report) | 82 | 22 | 0 |

Occurrences replaced in product files: 173 → 53 (122 replaced, then 2 restored where they name real external things:
the Supabase project's display name and the GitHub repo, items 16 and 19). The final 82, by category:

| Category | Occurrences | Files |
|---|---|---|
| Current user-facing | **0** | 0 |
| Compatibility (durable identifiers kept on purpose; items 1–6) | 11 | 7 |
| Historical records (applied migrations, dated audit and deploy files, a local folder name; items 7–12, 17, 18) | 35 | 10 |
| Deployment-dependent (live URL, external names, server job names; items 13–16, 19) | 7 | 4 |
| Rebrand documentation (this file and docs/VERIFICATION_REPORT.md quoting the kept values) | 29 | 2 |

(HANDOFF.md has both historical and deployment-dependent lines, so the file counts add up to 23 across categories.)

The rebuilt app (`dist/`) contains only the compatibility identifiers: the backup format id, the IndexedDB name and the
push tag default. `dist/index.html` and `dist/manifest.webmanifest` contain none.

## 2. Allowlist of kept references

| # | Path : line | Value | Category | Why it stays | Visible impact | Migration needed |
|---|---|---|---|---|---|---|
| 1 | `src/db/db.ts:140` | `` `liftcircle:${accountKey}` `` | Compatibility | IndexedDB (Dexie) database name. Renaming would orphan every device's local workouts. | None (internal) | Only with a copy-and-verify migration; not planned |
| 2 | `tests/e2e/logging.spec.ts:72` | `'liftcircle:guest'` | Compatibility | Test of item 1 | None | Follows item 1 |
| 3 | `src/features/settings/backupSchema.ts:2, 25` | `'liftcircle-backup'` (constant + its comment) | Compatibility | Format id written inside backup files. Older backups and older app versions must keep importing. | None: the download *filename* is now `hard-earned-backup-<date>.json` | Could accept an alias later; not needed |
| 4 | `tests/unit/importExport.test.ts:18, 64, 96, 237`, `tests/unit/backup.test.ts:51` | `'liftcircle-backup'` | Compatibility | Tests of item 3 | None | Follows item 3 |
| 5 | `public/push-sw.js:30` | default tag `'liftcircle'` | Compatibility | Push-notification tag scheme (kept by request; the tag groups notifications on a device) | None (tags aren't shown) | No |
| 6 | `supabase/config.toml:3` | `project_id = "liftcircle"` | Compatibility | Local Supabase CLI project id | None | No |
| 7 | `supabase/migrations/20261028000001_foundation.sql:1, 4` | comments | Historical | Applied migration; never edited | None | No |
| 8 | `supabase/migrations/20261028000005_social_rpcs.sql:768`, `20261030000003_authz_fixes.sql:159`, `deploy/2026-10-30_migrations.sql:374` | `'liftcircle-server-export'` | Historical + compatibility | Applied migrations / historical deploy file; the server export format id stays (exports are matched on it) | None (format id inside a JSON export) | No |
| 9 | `supabase/migrations/20261028000006_storage_and_service.sql` (8), `20261029000001_coaching_schema.sql` (11) | storage policy names `"liftcircle …"` | Historical | Applied migrations; policy names are internal identifiers | None | No |
| 10 | `supabase/migrations/20261029000002_coaching_rpcs.sql:139, 189` | `'LiftCircle member'`, `'LiftCircle review team'` | Historical (superseded) | Applied migration; **replaced at runtime** by `20261105000001_hard_earned_brand_text.sql` | None once that migration is deployed | Deploys on merge (Deploy Supabase) |
| 11 | `supabase/migrations/20261101000001_push_notifications.sql:261, 291` | push titles `'LiftCircle'` | Historical (superseded) | Same: re-created with `'Hard Earned'` by the new migration | None once deployed. Already-queued coaching pushes sent in the minutes around the deploy may still show the old title | Deploys on merge |
| 12 | `supabase/migrations/20261101000001_push_notifications.sql:98` | tag default `'liftcircle'` | Historical + compatibility | Push tag scheme (item 5) | None | No |
| 13 | `supabase/migrations/20261101000001_push_notifications.sql:438, 439`, `docs/SETUP.md:210` | cron job `'liftcircle-push-send'` | Deployment-dependent | pg_cron job name on the live database; renaming would leave a duplicate job | None | No |
| 14 | `docs/BACKEND.md:294` | cron job `'liftcircle-cleanup-media'` | Deployment-dependent | Same, for the optional cleanup job | None | No |
| 15 | `docs/SETUP.md:51, 52`, `HANDOFF.md:31` | `https://liftcircle.netlify.app` | Deployment-dependent | The live site address (kept by request; URLs are real destinations) | **Visible** in the browser address bar and in auth emails until the owner changes the Netlify site name/domain | Owner task |
| 16 | `HANDOFF.md:3` | Supabase project **LiftCircle** | Deployment-dependent | Records the project's current display name | Dashboard only | Owner task |
| 17 | `HANDOFF.md:27, 38` | `liftcircle-site` | Historical | Name of the existing local build folder on the laptop | None | Rename the folder whenever convenient |
| 18 | `docs/AUDIT_2026-10-29.md:3, 164` | URL, `liftcircle-site` | Historical | Dated audit record (kept by request) | None | No |
| 19 | `docs/GITHUB.md:17` | repo `bjossinn/liftcircle` | Deployment-dependent | The GitHub repository's real name (kept by request) | None in the app | Owner task (optional) |

Other durable identifiers kept that don't contain the old name, but are brand-derived (`lc` = LiftCircle):
- localStorage keys `lc-theme`, `lc-theme-choice`, `lc-theme-applied`, `lc-theme-picked`, `lc-auth`, `lc-auth-return`,
  `lc-demo`, `lc-last-account`, `lc-progress-range`, `lc-rest-cheer-shown`, `lc-persist-notice-dismissed`,
  `lc-sw-notice-dismissed`, `lc-push-device`, `lc-push-prefs`, `lc-push-subscription-changed`, `lc-push-uploaded`, and the
  sessionStorage prefix `lc-celebrated:`. Renaming would reset saved preferences and sign-in state.
- PWA manifest `id: '/'`, `start_url: '/'`, `scope: '/'` (installed apps stay the same app).
- Service-worker caches: Workbox's default precache name (no brand in it); cache revisions come from the build hashes.
- Supabase project ref, tables, buckets (`post-media`, `avatars`, `coach-public`, `coach-docs`, `coach-media`), Edge
  Function names (`ai-coach`, `push-send`, …), secrets; the GitHub repo name `bjossinn/liftcircle`; git history.

Renamed internal identifiers (all consumers updated in the same change): `package.json` name `hard-earned`, the Vite
plugin `hard-earned-csp-inline-script-check`, the window event `hard-earned:coaching-unread`, `BRAND` constants
(`src/config/brand.ts`), CSV/JSON export filenames, the geocoder user agent `HardEarned/1.0`, `.env.example` placeholder.

## 3. Owner tasks (external settings not changed here)

1. **Supabase Auth email templates and sender name** (Authentication → Emails / SMTP): replace "LiftCircle" in the
   subject lines, bodies and sender display name. Keep the confirmation/reset links as they are.
2. **Netlify site name / domain**: `liftcircle.netlify.app` stays until you rename the site or add a custom domain.
   After a change, update Supabase Auth → URL configuration (Site URL and redirect URLs) and `VITE_PUBLIC_APP_URL`.
3. **GitHub repo name** (`bjossinn/liftcircle`): optional; GitHub redirects the old URL. Update the Netlify link if you
   rename it.
4. **Supabase project display name** ("LiftCircle"): optional; Settings → General. The project ref doesn't change.

## 4. Surfaces covered

- **App shell and navigation:** tab bar (selected tab = accent ink + pill), top actions, banners (offline, update,
  storage health, sync), route error page, resume bar.
- **First run and setup:** theme picker (Dark / Light / Match my phone), welcome/onboarding (brand moment, the guide's
  setup questions), setup complete toast, result step.
- **Today, Train, active workout** (set rows ≥ 56 px, ✓ targets 48 px, completed sets in the success colour,
  rest timer), workout summary ("Workout saved." with "Every set adds up."), history (empty state from the guide),
  session detail and the delete dialog ("Delete this workout?" / "Keep workout" / "Delete workout").
- **Progress:** charts with the kit's five series (colour, marker shape and line style), neutral body-weight wording,
  goals, records.
- **Nutrition:** targets, food log, meal plan, recipes, shopping list, the protein picker.
- **Social:** feed, friends, profiles, sharing text ("… on Hard Earned"), moderation, notifications.
- **Coaching:** hub, find a coach, coach profile, apply ("Apply to be listed"), "Listed coach" status, workspace
  ("Your coaching workspace", empty client list), client tools, messages, check-ins, proposals, plan attribution
  ("Assigned by [coach]"), session note ("How did this session feel?").
- **Training assistant (AI):** name everywhere (hub, chat header, setup, settings, proposals, errors, badge kept),
  "Assistant style" (Supportive / Balanced / Strict, behaviour unchanged), system prompt self-description and a voice
  rule, welcome lines, Strict wording without "No excuses"/"You fell behind".
- **Notifications:** push titles (client-scheduled and server-generated), reminder and missed-session texts,
  test notification, coach cheers library (no exclamation marks, no guilt), service-worker defaults and icon.
- **Settings and account:** appearance, workout cheers, celebrations, notifications, data/backup (filenames),
  install page (brand moment), About (brand moment and about paragraph), privacy summary, auth screens.
- **Metadata and assets:** page title, description, Apple web-app title, theme-color per theme (inline script and CSP
  hash updated), manifest name/short name/description/colours/icons, favicons, Apple touch icon, maskable icon,
  in-app mark (1024 master), fonts.
- **Edge Functions and database text:** AI prompts and tool descriptions, push payload default, geocoder user agent,
  one additive migration for four SQL functions' user-visible strings. Bundles in `supabase/functions-bundled/`
  regenerated for `ai-coach`, `geocode` and `push-send`.
- **Docs:** user guide, AI coach doc, setup, backend, conventions, device checks, sources, handoff, build status.

Not applicable in this repo: native apps, store listings, localisation files (the app is English-only), transactional
email templates (they live in Supabase Auth, owner task 1).

## 5. Token decisions

All kit roles are mapped 1:1 (checked by `tests/unit/themeContrast.test.ts` against contrast-matrix.json). Roles the
kit doesn't define, chosen to pass AA and recorded here:
- `surface-3` (a fourth surface level): dark `#2D3135`, light `#EDE9E2`. It sits between surface and raised so the
  muted text still passes (4.6:1 dark, 5.1:1 light).
- Soft status fills (`danger-soft`, `warn-soft`, `success-soft`, …): the status colour at 8–14 % opacity over the card;
  text on them is checked composited.
- Supporting accents reuse kit chart colours: `accent-2` = chart 3 (blue), `celebrate` = chart 5 / warning (gold),
  `streak` = accent ink.
- The playful card colour washes (`tint-*`) are now plain (`none`), per "do not make every panel orange".

## 6. Unsupported or unresolved

- iOS keeps the old Home Screen icon and name until the app is removed and added again (platform behaviour).
- `npm run test:rls` and `npm run test:ai-db` need a local PostgreSQL 16, which this machine doesn't have; CI runs them.
- The brand kit zip was in Downloads, not in the repo, so there was no zip to delete in this commit.
