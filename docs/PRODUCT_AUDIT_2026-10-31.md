# LiftCircle product and technical audit (31 Oct 2026, v0.7.2)

Scope: the whole app at `main` (v0.7.2, commit `989a4a4`), built on the 29 Oct audit (`docs/AUDIT_2026-10-29.md`).
This is documentation only. No code was changed.

**Evidence labels:** **ran** = run in this audit, with the result pasted. **clicked** = walked through in a browser.
**read** = from source or docs only. **Not verified** = needs access this audit didn't have, and says what is missing.

## TL;DR

1. **The engineering is unusually solid for a v0.x app.** The app is local-first, with an outbox/compare-and-swap sync, RLS on every table, and 482 real-Postgres RLS checks running in CI. It has 767 unit tests (all pass, 17 s), a strict CSP that is live (checked), and no secrets in the repo.
2. **The biggest risks are operational, not code.** (a) If the Supabase project is on the Free plan, there are no database backups, and the project can pause. (b) If Netlify is on the new credit-based Free plan, about 20 production deploys a month pause the site; this repo merged around 10 to `main` in two days. (c) Nothing alerts the owner when anything breaks: there is no error tracking and no uptime checks.
3. **A deploy trap is waiting.** Migrations dated `20261101`–`20261103` are already applied in production. Any migration created today or in the next few days gets an *earlier* timestamp, so `supabase db push` in the deploy workflow will refuse it.
4. **Merging to `main` deploys the production DB with no human gate.** The `production` environment has no required reviewers. The repo is public (the docs say private) and has auto-merge enabled. Netlify deploy previews also talk to the production Supabase project.
5. **AI cost and model.** The live setup uses OpenAI, whose default `gpt-5-mini` is now marked deprecated by OpenAI. There is only a per-user cap (40 requests/day) and no global spend cap or CAPTCHA, so cost is limited only by any provider-side budget.
6. **Startup bundle regressed.** The startup chunk went from 114 KB / 38 KB gzip (v0.3.0) to **337 KB / 100 KB gzip**. The exercise catalogue, generator and coaching API moved into it. Total first-load is about 301 KB gzip; Progress is 427 KB (Recharts).
7. **The UX is careful and honest but wordy.** Journeys score 2–4 out of 5. Onboarding and logging work well (4). Progress and nutrition setup have friction (3). **Find a coach is a dead end today: the production directory returns "No coaches found"** (2).
8. **Feature gaps that matter most vs Strong/Hevy/MyFitnessPal:** exercise demos, CSV import from Strong/Hevy, a plate calculator, share images, a barcode/food database, and Icelandic. Health sync, widgets and GPS need a native wrapper, not a PWA.
9. **Where LiftCircle is ahead:** AI coach + human coach + consent-scoped sharing + local-first + friends. Only Hevy has a coach marketplace, and none of the 10 competitors offer Icelandic. The best new ideas build on that (§5).
10. **The first five steps cost about four days:** fix migration naming, gate production deploys, set up backups and alerts, swap the AI model and add caps, fix nutrition setup and Progress defaults. Then do coach-directory bootstrapping, a plate calculator and share cards, and Strong/Hevy import (§6).

---

## 0. What was fixed since the 29 Oct audit

The v0.3.0 deploy package from the last audit is now live. Migrations `20261030000001–04` are recorded in `supabase/migrations` and the Deploy Supabase workflow succeeded on 30 Oct. The live site sends the CSP (checked: `script-src 'self' 'sha256-TJKc…'`, HSTS `max-age=31536000; includeSubDomains; preload`). Since then, five releases have landed:

| Version | What changed | Effect on old findings |
|---|---|---|
| 0.3.1 (#3) | Update check when the page becomes visible | — |
| 0.4.0 | AI coach v3: styles, on-topic scope, **coach cheers** in the logger (`src/domain/coachCheers.ts`) | A2 (style) improved; live model behaviour was tested by the owner ("fixes from live testing", #7) |
| 0.5.0 (#5) | **Web Push**: reminders, rest-over alerts, coaching/social, missed-session nudges (`push-send` function, pg_cron) | Closes BUILD_STATUS "not in v1: push notifications" |
| 0.6.0 (#6) | AI coach v4: short formatted answers, app guide with deep links, in-app actions (programs, meal plans, recipes) | — |
| 0.7.0–0.7.2 (#7–#9) | 60 more recipes (84 total), recipe prep-guide page, Check for updates button, meal plan "today first" | N1–N6 retained |
| Infra | GitHub repo + CI (typecheck, unit, build, RLS, AI-DB, push-DB) + `deploy-supabase.yml`; Netlify Git deploys | Closes the 29 Oct "deploys need the owner to paste SQL" gap |

**Still open from 29 Oct** (re-checked in source):

- No physical-device or screen-reader pass (`docs/DEVICE_CHECKS.md` §1 is all "blocked").
- No ESLint config.
- Coach revision can't read the client's current plan contents.
- Chat history is limited to the latest 200 messages, and messaging polls.
- 0-rep sets are accepted on the server.
- `cleanup-media` is not scheduled (`HANDOFF.md` "Still to do 2").

**Doc drift:**

- `BUILD_STATUS.md` still says "version 0.3.0" and 573 tests.
- `README.md:41-43` still says 251 unit / 223 RLS / 10 e2e. The real numbers are 767 / 482 / 26.
- `HANDOFF.md` still describes manual SQL-editor and drag-and-drop deploys.
- `docs/GITHUB.md:3` says the repo is private. `gh api` says `"visibility":"public"`.

---

## 1. How it's built

### 1.1 Architecture

| Layer | What | Where |
|---|---|---|
| Client | React 19 + react-router 7 SPA, Tailwind 4, 59 lazy routes (`src/app/routes.tsx`), 6 tabs (Today, Train, Feed, Nutrition, Progress, Coaching) | `src/features/**` |
| Domain | Pure TS: generator, splits, schedule, progression, stats, set validation, nutrition, coach cheers, push schedule | `src/domain/**` (rule: no React/Dexie/network, `docs/CONVENTIONS.md`) |
| Local DB | Dexie/IndexedDB, **one database per account** (`guest`, `demo`, user id), 18 tables incl. `outbox`, `conflicts`, `pendingPosts`, `coachOutbox` | `src/db/db.ts` |
| Sync | Outbox ops coalesced per record, server versions, `sync_push`/`sync_pull` CAS, conflicts surfaced to the user, tombstones, lost-response hash recognition | `src/sync/engine.ts`, `docs/BACKEND.md` |
| Backend | Supabase Postgres (19 migrations), RLS on all tables, typed private projections, social and coaching RPCs, 5 private buckets, signed URLs (300 s) | `supabase/migrations/**` |
| Edge Functions | `finalize-post`, `finalize-coach-media` (server-side image validation), `delete-account`, `cleanup-media`, `geocode` (Nominatim), `ai-coach`, `push-send`. All `verify_jwt=false` because of ECC signing keys; each user-facing one calls `requireUser()` in code | `supabase/functions/**`, `supabase/config.toml` |
| AI | `ai-coach` → OpenAI Chat Completions or Anthropic Messages (picked by env), tool calls, server-side validation of proposals, per-user daily limit, usage/cost table; shared nutrition planner with the app (`_shared/nutrition/*` re-exported by `src/domain/nutrition`) | `supabase/functions/_shared/ai/*` |
| Push | Device computes the next 14 days of reminders and uploads jobs; `pg_cron` calls `push-send` every **15 s** via `pg_net`; VAPID signing in-function | `20261101000001_push_notifications.sql:431-440`, `_shared/push/*` |
| PWA | vite-plugin-pwa `generateSW`, precache only (no runtime caching of Supabase/media), user-controlled updates that wait for an active workout | `vite.config.ts`, `src/pwa/*` |

**Assessment:** the layering is clean and the boundaries are documented in `docs/INTERFACES.md`. The most valuable design decision is "the device is the source of truth, the server is a backup and the place for sharing". It keeps logging instant and offline, and makes Personal mode free.

### 1.2 Code health

- **Size:** about 48k lines of TS/TSX in `src` and 6.2k in `supabase/functions`.
  - Largest files: `src/data/recipes.ts` (2,189), `src/data/exercises.ts` (1,193), `src/features/train/SessionPage.tsx` (1,113), `src/domain/program/generator.ts` (894), `src/backend/coaching.ts` (878).
  - `SessionPage.tsx` is the one file that is getting hard to change safely: logger, rest timer, cheers, push, sheets and finish flow all live in one component.
- **Type safety:** `strict`, `noUnusedLocals/Parameters` are on.
  - 16 `as any`/`@ts-ignore`/`@ts-expect-error` in `src`, mostly Deno `.ts` import shims. 0 TODO/FIXME.
  - **Edge Functions are never type-checked by Deno.** CI runs `tsc` for the app only, and there is no `deno check` step.
  - **No linter** (no ESLint/Biome config).
- **Duplication:**
  - Nutrition logic is shared properly between app and function.
  - The server week matcher `_shared/ai/week.ts` is still a "simplified copy" of `src/domain/program/schedule.ts` (29 Oct A3).
  - `supabase/functions-bundled/*.ts` are hand-regenerated single-file copies. `push-send.ts` and `delete-account.ts` bundles are older than their sources (git: bundle `c53056f`/`c1297f5` vs source `cc391f1`). CI deploys from source, so the bundles are only a dashboard fallback that can silently be stale.
  - `supabase/seed.sql` duplicates `src/data/*` (generated by `scripts/gen-reference-seed.mts`; nothing checks it is up to date).
- **Dead or unreachable code:** `public.export_my_data()` (v2, coaching + AI data; `20261030000003_authz_fixes.sql:157`) **is not called anywhere in `src`**. The server-side export exists, but users can't reach it (§1.5).
- **Test coverage gaps:**
  - The 26 Playwright e2e tests are **not in CI** (`ci.yml` comment). `units-backup.spec.ts` is a known failure on `main` too, and it is not tracked as an issue.
  - Nothing tests the deployed Edge Functions in Deno.
  - The social UI has never run against a live backend (`tests/live/*` print BLOCKED without credentials).
  - Push delivery has only been checked end to end by the owner's own test notification (Not verified here).
  - There is no test for "every new function calls `requireUser`". With `verify_jwt=false` everywhere, that is the one convention a new function must not forget.

#### Unit test results (ran)

```
npx vitest run --reporter=default --reporter=json
 Test Files  47 passed (47)
      Tests  767 passed (767)
   Duration  17.25s (transform 4.05s, setup 3.68s, import 11.22s, tests 17.96s, environment 71.64s)
CI (run 41066894699, 30 Oct): vitest step 22 s; whole job 1m46s; test:rls 482/482, test:ai-db 21/21, test:push-db 14/14
```

| Slowest files | Time | Tests |
|---|---|---|
| `tests/unit/loggingUi.test.ts` | 5.6 s | 16 |
| `tests/unit/pwaUpdate.test.ts` | 3.2 s | 14 |
| `tests/unit/aiUi.test.ts` | 2.7 s | 26 |
| `tests/unit/coachCheersUi.test.ts` | 1.6 s | 8 |
| `tests/unit/coachingDirectory.test.ts` | 1.2 s | 30 |

No single test took more than 1.5 s.

**Timing- or date-dependent tests.** None failed in this run or in the last 30 CI runs; the one CI failure was a real regression that CI caught, below. These tests are still the likely future flakes:

- `coachCheersUi.test.ts:178,195,211` seed a rest deadline at `Date.now() + 50…120 ms`, then rely on real timers (`tick(150)`). This is wall-clock dependent on a loaded CI runner.
- `aiUi.test.ts:85`, `recipesUi.test.ts:74` and `coachCheersUi.test.ts:63` use hand-rolled polling `waitFor` loops with timeouts.
- `aiUi.test.ts:676,772` use the real `todayISO()` to build a meal plan for "today"/this week. They depend on the real calendar date, while the rest of that file freezes time at `aiUi.test.ts:465`.
- `program.test.ts:383` asserts `|startedAt − Date.now()| < 5000`. That is harmless.

Most other date-sensitive tests pass explicit dates (for example `aiCoachFixes.test.ts:37 TODAY='2026-10-29'`) or freeze time (`mealplanUi.test.ts:83`). That is good practice.

**CI history (ran `gh run list -L 30`):** all green except:

- PR run 40993634558 (push-db: 3 failures from a payload validation change). It was caught before merge, which is CI doing its job.
- Two Deploy Supabase runs on 29 Oct that failed during first-time secret setup.

**E2E:** not run in this audit (each run rebuilds and runs serially, about 5 min). `units-backup.spec.ts` is the known pre-existing failure, also on `main`.

### 1.3 Dependencies (ran)

**`npm audit`:** 10 vulnerabilities (2 low, 8 moderate). **All are in build tooling**: `vite-plugin-pwa → workbox-build → @rollup/plugin-node-resolve/deepmerge, glob/minimatch, ejs/jake/filelist`. `npm audit --omit=dev` reports **0 vulnerabilities**. The suggested `npm audit fix --force` *downgrades* vite-plugin-pwa to 1.1.0, so don't run it. Wait for vite-plugin-pwa 2.x / workbox 8.

| Advisory | Package (range) | Severity | Reaches the browser? |
|---|---|---|---|
| GHSA-gcqx-w48m-w2h4 prototype poisoning | deepmerge ≥4.2.0 | moderate | No (build only) |
| GHSA-3g3m-2fjr-6pw4 AbortSignal bypass | glob 3.0.0–14.0.1 | moderate | No |
| GHSA-g3hv-75wg-m249 ReDoS | minimatch <11.0.1 | moderate | No |
| (chain) | ejs 3.1.2–4.0.1, jake, filelist, rollup-plugin-off-main-thread, workbox-build, vite-plugin-pwa ≥1.2.0 | low–moderate | No |

**`npm outdated`:**

| Package | Current | Wanted | Latest | Note |
|---|---|---|---|---|
| @playwright/test | 1.63.0 | 1.64.1 | 1.64.1 | patch, safe |
| @types/node | 26.6.5 | 26.6.6 | 26.6.6 | safe |
| fake-indexeddb | 6.2.6 | 6.2.7 | 6.2.7 | safe |
| lucide-react | 1.63.0 | 1.65.0 | 1.65.0 | safe |
| @vitejs/plugin-react | 5.2.0 | 5.2.0 | **6.1.2** | major, goes with Vite 8 |
| vite | 7.3.7 | 7.3.7 | **8.3.5** | major |
| vite-plugin-pwa | 1.3.0 | 1.3.0 | **2.0.0** | major, likely clears the audit chain |
| vitest | 4.1.12 | 4.1.12 | **5.0.5** | major |
| react-router | 7.18.5 | 7.18.5 | **8.5.1** | major, data-router API changes |
| typescript | 5.9.3 | 5.9.3 | **7.0.2** | major (Go-based compiler), test before adopting |
| jsdom | 30.1.3 | 30.1.3 | 29.1.1 | "latest" tag is lower; ignore |

`node_modules` here is a junction to another checkout, so "Current" reflects that install. The lockfile is the source of truth.

Other dependency notes:

- `.npmrc legacy-peer-deps=true` hides peer conflicts.
- `deploy-supabase.yml:42` uses `supabase/setup-cli` with **`version: latest`**, so a CLI release can change deploy behaviour without a commit. Pin it.

### 1.4 Performance

**Build (ran):** `npm run build`. On this Windows checkout it first failed the CSP inline-hash check, because `index.html` has CRLF line endings locally (`core.autocrlf=true`). This is a local Windows quirk; CI on Linux passes. I normalised `index.html` to LF to measure, then reverted it with `git checkout index.html`.

| Chunk | Raw | Gzip | Loaded |
|---|---|---|---|
| `index-*.js` (app startup) | **337.2 KB** | **100.1 KB** | every start |
| `vendor-react` | 316.5 KB | 100.9 KB | every start |
| `vendor-backend` (supabase-js) | 223.7 KB | 58.6 KB | every start (even Personal mode) |
| `vendor-dexie` | 101.0 KB | 33.1 KB | every start |
| `index-*.css` | 41.9 KB | 8.2 KB | every start |
| **First load total** | **≈1,020 KB** | **≈301 KB** | |
| `ProgressPage` (Recharts + redux toolkit + d3 + immer) | 427.0 KB | 124.8 KB | lazy |
| `schemas` (zod backup schema) | 92.4 KB | 26.2 KB | lazy |
| `recipes` | 80.5 KB | 14.9 KB | lazy |
| `AiChatPage` | 44.3 KB | 15.6 KB | lazy |
| `mealplan` | 37.0 KB | 13.5 KB | lazy |
| PWA precache | 178 entries, **2,531 KiB** | | first visit (v0.3.0: 186 entries, 2.39 MB) |

**Regression:** the startup chunk is 3× what `docs/DEVICE_CHECKS.md` §4 recorded (114 KB / 38 KB gzip). A sourcemap breakdown (ran) shows what is in it now:

- `src/data/exercises.ts` (106 KB of source)
- `domain/program/generator.ts` (44 KB)
- `backend/coaching.ts` (36 KB)
- `domain/stats.ts` (34 KB)
- **`domain/coachCheers.ts` (28 KB)**: logger-only text, now in every start
- `backend/social.ts` (23 KB)
- lucide icons (23 KB)

First-load bytes are about the same as before (≈301 vs ≈312 KB gzip), because the code moved rather than grew. However, an app-only release now makes every installed PWA re-download about 100 KB gzip instead of 38 KB, and parse time on low-end Android grows. Fix: lazy-import `coachCheers` from `SessionPage`, the coaching/social backends from their pages, and the exercise catalogue behind `useExercises()`.

**Slow screens (read: reasoning from code, not profiled):**

- **Logger re-renders every second.** `SessionPage.tsx:158` `useNow(1000)` re-renders the whole 1,113-line component tree with no `memo` on the rows, and `RestBar` adds a 250 ms tick (`:977`). In 29 Oct, tap-to-DOM was measured at 96–160 ms on emulated 4× CPU, which is acceptable today but will degrade with long sessions. Fix: move the clock into a small `<Elapsed/>` component and memoise exercise cards.
- **Progress loads everything.** `ProgressPage.tsx:67-69` live-queries **all** completed sessions, activities and measurements, then computes every section. After 2–3 years of 4×/week (about 500 sessions × about 20 sets) this is tens of thousands of set objects on each open and on any write to those tables. Fix: compute per-range, cache weekly aggregates in `kv`, or move work to a worker.
- **Today page.** `useAllSessions()` (`src/features/train/hooks.ts:21`) loads and sorts every session including the active one, on every visit.
- **Logger history.** `SessionPage.tsx:157` loads all completed sessions for "last time" hints. Dexie 4's range-scoped live queries should keep active-set writes from re-running it (Not verified by profiling).
- **History list** is capped at 300 rows (`HistoryPage.tsx:183`), and the feed uses an IntersectionObserver for pagination. Neither needs virtualisation yet.
- **Settings** renders a `<select>` with about 400 time zones on one long page. It works, but is slow to scroll and to use with a screen reader.

### 1.5 Security and privacy posture

**Strong points (read, plus ran where noted):**

- RLS on all tables with least-privilege grants.
- 482 Postgres checks in CI, including a 321-cell coaching access matrix (ran via CI logs).
- Private buckets, 300 s signed URLs, and a server-side re-check of image dimensions and EXIF in `finalize-post` / `finalize-coach-media`.
- **No secrets in the repo:** ran `git grep` for `sk-`, `sb_secret_`, JWTs and VAPID private keys; nothing found. `netlify.toml` carries only the publishable key and the VAPID *public* key, both public by design.
- CSP, HSTS, COOP, frame-ancestors none (live headers checked).
- Account deletion removes storage and cascades.
- The AI provider is named in consent, and consent is re-asked on a provider switch.

**Gaps:**

| # | Gap | Evidence | Fix |
|---|---|---|---|
| S1 | **Repo is public** while docs say private. No secret is exposed, but the full RLS logic, admin flows and project ref are readable. That is fine if intentional (security by RLS), but decide it deliberately | `gh api repos/bjossinn/liftcircle` → `visibility: public`; `docs/GITHUB.md:3` | Either make it private or update the docs and add `SECURITY.md` |
| S2 | **Production DB deploys without approval.** The `production` environment has `protection_rules: []`. `allow_auto_merge: true` plus the "main needs CI" ruleset means a green PR merges straight into a production migration | `gh api …/environments` | Add yourself as a required reviewer on `production` (the docs already recommend it) |
| S3 | **No global AI spend cap; open sign-up; no CAPTCHA.** The only throttle is `AI_DAILY_REQUEST_LIMIT` = 40 per user (`_shared/ai/coach.ts:91`). Disposable-email accounts multiply that | `supabase/config.toml [auth]`, no captcha | Add `AI_GLOBAL_DAILY_LIMIT` (count today's `ai_usage` rows), set a hard budget at the provider, enable Supabase Auth CAPTCHA (Turnstile) |
| S4 | **`verify_jwt=false` on every function.** Safe today because each user function calls `requireUser()` (checked: ai-coach, delete-account, finalize-*, geocode; cleanup-media and push-send use shared secrets). One forgotten call in a future function makes it public | `supabase/config.toml` | A unit test that greps every `functions/*/index.ts` for `requireUser(` or a secret check |
| S5 | **Server data export is unreachable.** Users can download their *device* backup, but there is no button for `export_my_data()` (posts, comments, coaching messages, AI chats held only on the server). This weakens a GDPR Art. 15/20 request | `grep export_my src` → nothing | Add "Download my server data" in Settings → Your data |
| S6 | **Deploy previews use the production backend.** `netlify.toml [build.environment]` sets the prod Supabase URL for all contexts, so every PR preview signs in to, and writes to, production | `netlify.toml` | `[context.deploy-preview.environment]` pointing to a staging project, or Personal mode for previews |
| S7 | **VAPID rotation fails silently.** `refreshPushSubscription` (`src/pwa/push.ts:131-143`) re-subscribes only when no subscription exists. It never compares `sub.options.applicationServerKey` with the current key, so after rotating, old subscriptions get 401/403 (not 404/410) and count as failures forever | read | Compare keys; unsubscribe and re-subscribe on mismatch |
| S8 | Orphaned media accumulates: `cleanup-media` is not scheduled (owner TODO), plus the known leftovers from 29 Oct | `HANDOFF.md` | Schedule it hourly with pg_cron (same pattern as push) |

### 1.6 Operational setup

| Area | State | Verified? |
|---|---|---|
| CI | `ci.yml`: typecheck, vitest, build, RLS/AI/push DB suites on PG16, about 1m45s per run. No e2e, no Deno check, no lint | ran `gh run view` |
| Site deploy | Netlify Git integration, `npm ci && npm run build`, deploy previews on PRs | read (`docs/GITHUB.md`) |
| Backend deploy | `deploy-supabase.yml` on pushes to `main` touching `supabase/**`: `migration list`, `db push`, `functions deploy` (**all** functions every time) | ran (`gh run list`: 4 green deploys) |
| Deploy ordering | Netlify and the Supabase workflow run **independently**. A PR that needs a new migration can go live on the site before the migration lands (30–40 s), or with a failed migration | read |
| **Migration timestamps** | `20261101000001_push_notifications.sql`, `20261102000001_ai_coach_actions.sql` and `20261103000001_more_recipes.sql` are dated in the *future* and already applied in production (Deploy Supabase 30 Oct 05:39 ✓). `supabase migration new` today produces `20261031…`, which sorts before `20261103`. Per the Supabase CLI, `db push` then refuses ("local migration files to be inserted before the last migration on remote") unless run with `--include-all` | read; CLI behaviour per docs, not run |
| Local Supabase vs CI | `supabase/config.toml` `major_version = 17`, CI tests on PostgreSQL **16** | read |
| Backups | **Depends on plan.** Supabase Free has no backups and no PITR; Pro ($25/month) has daily backups kept 7 days | Not verified: no Supabase dashboard access |
| Monitoring and alerting | **None.** No client error reporting (only a local storage-error hook, `src/pwa/health.ts:126`), no uptime checks, no alert on function errors, push failures or AI spend, no log drain | read |
| Pausing | Supabase Free projects pause after 1 week of inactivity. Whether the 15-second pg_cron traffic counts as activity: Not verified | Not verified |

**Costs and limits.** Public docs, opened 31 Oct 2026. Which plan this project is on is **not verified**.

| Service | Free plan limits | How LiftCircle uses it |
|---|---|---|
| Supabase Free ([pricing](https://supabase.com/pricing)) | 500 MB DB, 5 GB egress (+5 GB cached), 1 GB storage, 50k MAU, 500k Edge Function invocations/month, pause after 1 inactive week, no backups | **The push cron alone is 4/min × 60 × 24 × 30 ≈ 172,800 invocations/month (≈35% of the quota)** before any user traffic. Photos at 2048 px plus thumbnails will hit 1 GB storage at roughly a few thousand posts (estimate). Pro is $25/month |
| Netlify Free, credit-based ([pricing](https://www.netlify.com/pricing/), [credits](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/how-credits-work/)) | 300 credits/month, a hard limit. 15 credits per production deploy (≈20 deploys), 20 credits/GB bandwidth. **When credits run out, sites are paused ("Site not available")**. Deploy previews are free. Personal plan $9/month (1,000 credits) | `main` received about 10 merges on 29–30 Oct. At that pace, about 20 production deploys exhaust Free in roughly a week. Legacy Free (100 GB, 300 build minutes) behaves differently. Not verified which plan the account has |
| OpenAI `gpt-5-mini` ([model page](https://developers.openai.com/api/docs/models/gpt-5-mini)) | $0.25 input / $2.00 output per M tokens. **Now marked deprecated** | It is the code default (`_shared/ai/provider.ts:19`) and, per `HANDOFF.md`, the live provider (OPENAI_API_KEY set). At about 6k input + 600 output tokens per message, that is ≈$0.003/message, so the 40/day cap is ≈$0.12/user/day |
| Anthropic Sonnet 5.5 ([pricing](https://platform.claude.com/docs/en/about-claude/pricing)) | $2 input / $10 output per M tokens | Default if both keys are set (`provider.ts:17`). ≈$0.018/message, so the cap is ≈$0.72/user/day |
| Nominatim (public) | ≤1 request/s, light use only | Fine for a handful of coaches; self-host or switch for real traffic |

### 1.7 Risks ranked by severity

| Sev | Risk | Fix |
|---|---|---|
| **Critical if on Supabase Free** (otherwise Medium) | No database backups. Server-only data (posts, coaching messages, AI chats, other users' devices' unsynced history) is unrecoverable after a bad migration or deletion | Upgrade to Pro (daily backups), **or** a nightly GitHub Action `pg_dump` (secret `SUPABASE_DB_URL` already exists) to encrypted storage; test a restore once |
| High | Next migration blocked by future-dated filenames | Name new migrations `20261104…` or later until the calendar catches up, and document the rule in `docs/GITHUB.md`; optionally a CI check that new migrations sort after the newest existing one |
| High | Netlify Free credit exhaustion pauses the whole site | Check the plan. If credit-based Free, batch merges or move to Personal ($9) |
| High | Production DB auto-deploys without approval (S2), plus deploy previews on the production backend (S6) | Required reviewer on `production`; a staging Supabase project for previews |
| High | No error tracking or alerting: the owner learns about breakage from users | Sentry (or similar) free tier in the client and functions; an uptime monitor on the site and `ai-coach`/`push-send` health; email alert on failed workflow runs (GitHub notifications) |
| High | AI: deprecated default model, no global cap, no CAPTCHA (S3) | Set `OPENAI_MODEL` to a current model; global daily cap; provider budget; Turnstile |
| Medium | Startup chunk regression (38 → 100 KB gzip) | Lazy-load `coachCheers`, coaching/social backends and the exercise catalogue |
| Medium | E2E not in CI; known failing `units-backup.spec.ts`; no Deno type check; Supabase CLI `latest` | Add Playwright (Chromium only) and `deno check supabase/functions/*/index.ts` to CI; fix or quarantine the spec; pin the CLI version |
| Medium | Site and DB deploy race | Make the Netlify production build wait on a "backend deployed" commit status, or deploy the site from the same workflow after `db push` |
| Medium | Server export unreachable (S5); VAPID rotation silent failure (S7); orphaned media (S8) | As in the table above |
| Medium | Push cron uses about 35% of Free function invocations | Have pg_cron call `push-send` only when `push_jobs` has due rows (check in SQL before `net.http_post`), or run every minute |
| Medium | Empty coach directory makes a whole tab feel broken | §3.8 / §5 idea 1 |
| Low | Dev-only npm audit findings; outdated majors | Wait for vite-plugin-pwa 2 and upgrade in one PR |
| Low | `functions-bundled` drift; seed drift | Generate both in CI, or delete the bundles now that CI deploys |
| Low | Logger re-render every second; Progress full-table loads | §1.4 |
| Low | Doc drift (BUILD_STATUS, README counts, HANDOFF, GITHUB "private") | One docs PR |

---

## 2. How it's set up for the owner

| Task | How today | Ease | What's missing |
|---|---|---|---|
| **Deploy** | Merge a PR to `main`: Netlify builds the site, and the workflow pushes migrations and redeploys every function | Easy | An approval gate; ordering between site and DB; a changelog/tag per release (versions live only in `package.json` and commit titles) |
| **Roll back the site** | Netlify → Deploys → pick an earlier deploy → "Publish deploy" (instant). Installed PWAs pick it up via the hourly or on-focus update check (`src/pwa/update.ts`) | Easy (Not verified: no Netlify dashboard access) | A runbook line saying a site rollback does **not** roll back the DB |
| **Roll back DB migrations** | No down migrations; forward-fix only. Every migration so far is additive (good) | Hard | Backups (§1.7), a "write the revert SQL in the PR description" convention, a restore drill |
| **Roll back Edge Functions** | Revert the PR (the workflow redeploys all functions from the new `main`), or run the workflow manually on an older ref. `db push` is a no-op if there are no new files | Medium | A documented one-liner: `supabase functions deploy ai-coach --project-ref …` from a tag |
| **Rotate Supabase keys** | Publishable key: in `netlify.toml` (committed), so change it in the dashboard, edit, merge. Secret keys: functions read them from env (auto-injected). DB password: also update the `SUPABASE_DB_URL` GitHub secret | Medium | A runbook. `CLEANUP_SECRET` and `PUSH_CRON_SECRET` live in **both** function secrets and Vault, so they must be changed in both places (`docs/SETUP.md` §9 mentions Vault for push only) |
| **Rotate VAPID** | Change secrets and `netlify.toml`, then redeploy | **Breaks existing subscriptions silently** (S7) | Code fix plus a runbook saying "users must reopen the app" |
| **Rotate the AI key** | `supabase secrets set OPENAI_API_KEY=…`, effective immediately | Easy | — |
| **Restore a user's data** | A user restores their own JSON backup (Settings → Your data). Cloud data comes back by signing in on a new device | Easy for users | No owner-side restore without backups |
| **Onboard a developer** | `npm install && npm run dev` gives full Personal mode with zero setup. Excellent | Easy | Connected-mode development needs their own Supabase project or `supabase start` (PG17 locally vs PG16 in tests). No `CONTRIBUTING.md`. Docs are thorough but partly stale (§0) |

**Missing for a solo owner, in priority order:**

1. Backups and a restore drill.
2. Error tracking (client and functions).
3. Uptime and push/AI health alerts.
4. A staging Supabase project for deploy previews and migration rehearsal (Supabase Branching needs Pro).
5. Runbooks: rollback, key rotation, "site is paused", "AI bill spiking", "user asks for data / deletion".
6. A release tag and changelog.

---

## 3. User-friendliness

**How:**

- I **clicked** through a local production build (`vite preview`, Personal mode, guest data, 375×812 emulation): onboarding, first workout, finish/summary, Progress, nutrition setup, meal plan, settings, install page.
- I **clicked** the live site as a guest for the coaching hub and coach directory (read-only).
- Connected-mode journeys (friends, AI chat, notifications permission) were **read** from source. I didn't create accounts.
- The service worker couldn't register inside the embedded browser ("Offline mode couldn't be set up"), which is an environment artifact. Offline behaviour was not re-tested.

Tap counts assume default answers.

### 3.1 Onboarding (clicked): 4/5

- **Flow:** Today "Set up my plan" → 12 steps → plan preview → "Accept & start" lands on Today with the next session. **Minimum 13 taps** plus typing a name.
- **Good:**
  - Sensible defaults everywhere, and "Skip" on body details.
  - The "why we ask" copy is excellent.
  - Explicit split choice with a recommendation.
  - Calibration instead of 1RM guessing.
  - "You can start it early — it'll count for this planned session" on a rest day.
- **Friction:**
  - 12 steps is long for a first run. Steps 8–10 (activities you enjoy, exercises to leave out, known weights, go-easy areas, everyday activity) could collapse into one optional "Fine-tune" step.
  - The plan preview repeats the same "calibrate" and "other lifts" legends under **every** session (3× in a 3-day plan) and shows "RIR 3" on Plank.
  - The progress bar plus "Step 6 of 12" with "Start over" next to Back invites accidental resets. There is no confirmation shown in this pass (not verified).
- **Fixes:**
  - Cut to about 7 steps with the optional details behind "Customise more".
  - Show legends once at the top.
  - Hide RIR for timed holds.
  - Show "Your first session: today/Monday" as the result-screen headline.

### 3.2 First workout (clicked): 4/5

- **First set:** tap kg (1), type, tap reps (2), type, ✓ (3). **The next sets carry values: 1 tap each.** Rest starts automatically. Finish takes 2 taps; the summary is next.
- **Good:**
  - A large bottom rest bar (−15/+15/pause/restart/skip).
  - Values typed without blur are saved (29 Oct W1 fixed).
  - Clear "17 unticked sets won't be saved" warning.
- **Friction:**
  - A first-time user sees a **green "Calibrate" box on every exercise** (6 boxes, about 40 words each). That is wall-of-text in the gym; one session-level banner would do.
  - Calibrate-mode warm-up rows show reps (8, 4) with an empty kg field and no hint of what to load.
  - Sets prefilled by carry-over but not ticked are dropped at Finish. The dialog warns, but "Finish" is the primary button, so a user who forgot to tick loses sets. Offer "Mark the 1 filled set done" in the dialog.
  - The summary screen leads with jargon ("per-hand dumbbells ×2; unilateral ×2… aren't comparable") on what should be a celebration (the parallel visual-refresh PR adds celebrations).
- **Accessibility:**
  - Warm-up rows are all labelled "Set W" ("Mark set W done" ×2, `read_page`), so screen-reader users can't tell them apart. Use "Warm-up 1/2".
  - Not verified on VoiceOver or TalkBack.

### 3.3 Logging a full session (clicked and read): 4/5

- **Taps:** an 18-set session is about 18 ✓ taps plus about 6–12 field edits plus the occasional ±2.5 kg quick-load. That is competitive with Strong and Hevy.
- **Already there:** supersets, swap with equipment-aware alternatives, RIR column (optional), notes, discomfort flag, coach cheers (offline, free), wake lock.
- **Missing:**
  - A plate calculator, which both Strong and Hevy have.
  - A "previous" column on the first visit (expected).
  - A quick "skip exercise".
- **Performance:** the logger re-renders every second (§1.4). Fine on desktop. Not verified on low-end Android.
- **Fixes:**
  - A plate calculator sheet from the kg field.
  - "Warm-up 1/2" labels.
  - Collapse completed exercises.

### 3.4 Checking progress (clicked): 3/5

- **Friction:**
  - The default range is **3 months even for a brand-new user**, so after the first workout it shows "1 workout… over 14 weeks, about 0.1 sessions per week" and a mostly empty chart. That is demotivating.
  - "Plan adherence: No planned sessions in this period yet" right after doing the planned session early.
  - Axes like "0, 0.025, 0.05" sets per week.
  - "Top working set went from 40 kg on Sat 31 Oct to 40 kg on Sat 31 Oct."
  - One very long page (consistency, exercise, records, volume, method notes, cardio, body, goals) with methodology prose inline ("Epley", "per hand ×2").
  - Bodyweight logging is buried at the bottom.
- **Fixes:**
  - Default the range to `min(account age, 3 mo)`.
  - A "first weeks" empty state ("Log 2 more sessions to see trends").
  - Integer axes for sets.
  - Collapse "How we calculate this".
  - Split into tabs: Training, Body, Goals.

### 3.5 Nutrition setup and meal plan (clicked): 3/5

- **Path:** Nutrition tab → "Protein target only" (1) → **lands on "No targets set. Add targets"** (2) → Targets says "Add your current weight…". Its "Log your weight" link (`TargetsPage.tsx:176`, `min-h-9` = 36 px, below the 44 px rule) **navigates to `/progress`**, where Bodyweight is at the bottom of a long page. Then: find "Add bodyweight" (≈3–4 taps), navigate back to Targets, Save (≈2), Meal plan (1), Generate (1).
- **About 11 taps across 4 screens** before a plan exists. The weight entered in onboarding is used if given, but onboarding lets you skip it.
- **Meal plan:** generated on a **Saturday**, it builds the current week. Only Sat and Sun are visible, and 5 past days sit under "Earlier this week". Offer "This week from today" vs "Next week".
- **Good:**
  - Honest protein-only mode with calories "for information".
  - Allergen disclaimer.
  - Shopping list.
  - Icelandic-friendly recipes (skyr, haddock).
- **Fixes:**
  - An inline weight field on Targets.
  - Choosing "Protein target only" should open Targets directly.
  - The week picker at generation.
  - Make "Log your weight" a sheet, not a navigation.

### 3.6 Adding a friend and sharing (read): 3/5

- **Path:** Settings → Create account → confirm email (leave the app) → back → create a profile (username) → Friends → "Find by username" (**exact username only**, `FriendsPage.tsx:295-296`, placeholder `exact_username`) or share the profile link (`navigator.share`, `social/common.tsx:292`).
- **About 10+ taps plus an email round-trip** before the first request.
- **Sharing after a workout is good:** inline on the summary, per-field choice, Friends/Only me, offline queue.
- **Friction:**
  - Exact-match search with no feedback on near misses.
  - No QR code, so in-person "add me at the gym" is clumsy.
  - In Personal mode the **Feed tab is a permanent dead end** ("Sharing needs an account"), one of six tabs.
- **Fixes:**
  - "Invite a friend" share sheet as the primary action (link plus QR).
  - Hide the Feed tab in Personal mode, or turn it into an account pitch with a demo feed.
  - Case-insensitive suggestions.

### 3.7 AI coach (read; live guest gate clicked): 4/5

- **Path:** account → Coaching → AI coach → 4-step setup (what it does → goal/experience/areas → categories + coach style → review and consent) → chat. About 8–10 taps.
- **Good:**
  - A free, app-rendered greeting with quick replies ("Feeling great 💪", "Short on time").
  - Short answers with "Why this?".
  - Actions you apply yourself (Apply to this week, Add meal plan, Undo).
  - Clear data-category consent.
  - It explains *why* it can't see something and links to the fix.
- **Friction:**
  - The setup re-asks goal and experience already given in onboarding (it prefills, but it is still a step).
  - AI responses can't be tested offline, and the "Coaching" tab label hides the AI coach for people who don't want a human coach.
- **Not verified:** model quality and latency on the current live model.
- **Fixes:**
  - Skip setup step 2 when the profile is complete.
  - Show an "Ask the coach" entry on Today and in the logger's ⋮ menu.

### 3.8 Finding a human coach (clicked live as guest): 2/5

- **Result:** Coaching → "Browse approved coaches" → Find a coach → **"No coaches found"** in production with no filters. The country select lists about 250 countries and defaults to "Any country", not the user's locale.
- The copy is honest and the privacy explanation is excellent, but today this is a dead end for 100% of users.
- **Fixes:**
  - Until N approved coaches exist, replace the search with "Bring your own coach" (invite your existing PT) and "Become a coach".
  - Default the country from `navigator.language` / time zone.
  - Keep the AI coach as the visible alternative.

### 3.9 Installing and turning on notifications (clicked and read): 3/5

- **Install:** `/install` shows platform-specific steps (emulation showed Android only; iOS steps are in source). The PWA install prompt exists.
- **Notifications:** Settings has **two sections, "Notifications" (in-app: friends, likes, comments, coaching) and "Push notifications"**, which is confusing. Push needs an account, and on iPhone it needs a home-screen install first (correct per WebKit). There is no contextual ask at moments of value, such as after the first workout ("Remind me before Monday's session?") or the first time the rest timer runs in the background.
- **Taps:** Settings → scroll about 3 screens → Turn on → OS prompt → test. About 4 taps plus scrolling.
- **Not verified:** a real iPhone or Android install, standalone launch, or push delivery.
- **Fixes:**
  - Merge into one "Notifications" section with push channel toggles.
  - Contextual prompts.
  - A "Notifications" row on the install-success screen.

| Journey | Score | How checked |
|---|---|---|
| Onboarding | 4 | clicked |
| First workout | 4 | clicked |
| Full session | 4 | clicked plus read |
| Progress | 3 | clicked |
| Nutrition + meal plan | 3 | clicked |
| Friends + sharing | 3 | read |
| AI coach | 4 | read (guest gate clicked live) |
| Human coach | 2 | clicked live |
| Install + notifications | 3 | clicked partly plus read |

---

## 4. Missing features vs competitors

Competitor columns come from official sites, help centres and App Store listings, collected 31 Oct 2026. "?" in the sources means not documented, not absent. Sources:

- [Strong](https://apps.apple.com/us/app/strong-workout-tracker-gym-log/id464254577)
- [Hevy features](https://www.hevyapp.com/features/), [Hevy Strong import](https://help.hevyapp.com/hc/en-us/articles/35687878672663-Importing-Strong-Data-into-Hevy)
- [Fitbod](https://apps.apple.com/us/app/fitbod-gym-fitness-planner/id1041517543), [Fitbod recovery](https://fitbod.me/blog/muscle-recovery/)
- [JEFIT](https://apps.apple.com/us/app/jefit-gym-workout-tracker/id449810000)
- [Strava](https://apps.apple.com/us/app/strava-run-bike-walk/id426826309)
- [NTC](https://apps.apple.com/us/app/nike-training-club-wellness/id301521403)
- [Fitness+](https://www.apple.com/apple-fitness-plus/)
- [MyFitnessPal](https://apps.apple.com/us/app/myfitnesspal-calorie-counter/id341232718)
- [Cronometer](https://apps.apple.com/us/app/cronometer-calorie-counter/id1145935738)
- [MacroFactor](https://apps.apple.com/us/app/macrofactor-macro-tracker/id1553503471), [MF plate calculator](https://help.macrofactorapp.com/en/articles/313-using-the-plate-calculator)

The LiftCircle column was checked in code.

| Feature | Apps that have it (documented) | LiftCircle | Value | Effort |
|---|---|---|---|---|
| Barcode scanning + large food DB | MyFitnessPal, Cronometer, MacroFactor | **No**: 102 bundled ingredients, custom foods, recipes (`src/data/ingredients.ts`) | High for nutrition users | L (Open Food Facts API + camera barcode via `BarcodeDetector`, which is Chromium-only; iOS needs a JS decoder) |
| Apple Health / Health Connect sync | Strong, Hevy, Fitbod, Strava, NTC, MFP, Cronometer, MacroFactor | **No**. A PWA can't reach HealthKit or Health Connect (native SDKs only, [Health Connect](https://developer.android.com/health-and-fitness/guides/health-connect)) | Med–High | L (Capacitor wrapper + store apps) |
| Widgets / Live Activities | Strong, Hevy, JEFIT, Cronometer (widgets); Strong, Hevy, JEFIT (lock screen) | **No**. Not available to PWAs; the Badging API works on iOS 16.4+ home-screen apps ([WebKit](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)) | Med | S for a badge; L (native) for widgets |
| Plate calculator | Strong, Hevy, MacroFactor Workouts | **No** (grep: none) | Med | S |
| 1RM calculator | Strong, Hevy, JEFIT | **Partial**: Epley e1RM in Progress and records (`domain/stats.ts`), no standalone calculator or %-of-1RM table | Med | S |
| Supersets UI | Strong, Hevy, JEFIT | **Yes**: exercise menu "superset with next", rest only after the group (`SessionPage.tsx:225-228`) | — | — |
| Exercise videos/animations | Strong, Hevy, Fitbod, JEFIT, NTC, Fitness+ | **No**: text cues plus a pattern glyph placeholder (`ExerciseGlyph`) | High | L (licensing or filming 105 movements) |
| Body-part heatmap | Fitbod (recovery), JEFIT (muscle map) | **Partial**: weekly sets per muscle bar chart (`VolumeSection.tsx`) | Med | M (SVG body map from existing per-muscle data) |
| Progress photos | Strong, Hevy, JEFIT | **No** (photos only in feed posts) | Med | M (private, local-first; optional sync to a private bucket) |
| Shareable workout image | Hevy, JEFIT | **No**: in-app snapshot posts only | Med (organic growth) | S–M (canvas card + `navigator.share` with files) |
| Challenges / leaderboards | Hevy, JEFIT, Strava, Fitness+ | **No** | Low–Med | M |
| Wearables / heart rate | All 10 | **Partial**: manual HR fields on activities. Web Bluetooth HR straps work on Chrome Android only, not iOS ([caniuse](https://caniuse.com/web-bluetooth)) | Med | L |
| GPS runs | Strava | **No** (manual activities) | Low (Strava owns this) | M, unreliable in a PWA when locked |
| Deload suggestions | Fitbod, JEFIT | **Partial**: 6–8 week block with a review week (`generator.ts:804`), "review recovery" progression flag | Med | S (turn the review week into an explicit deload offer) |
| Rest-day suggestions | ? (not documented) | **Partial**: planned rest days, missed-session rescheduling, AI coach treats rest as rest | Low | S |
| Import from Strong/Hevy (CSV) | Hevy (imports Strong) | **No**: JSON restore of own backups only | High for switchers | M |
| Offline exercise media | Hevy | n/a (no media). All text works offline | Low until media exists | — |
| Multiple languages / Icelandic | Strava 22, MFP 20, Hevy 16 … **none list Icelandic** | **No**: English only, no i18n layer (strings inline in JSX) | Med (High in Iceland) | L (string extraction, about 59 screens, plus AI replies in Icelandic) |
| AI coach | Fitbod, JEFIT, Strava, MFP, Cronometer, MacroFactor (algorithmic) | **Yes** (chat + actions + consent) | — | — |
| Human coach marketplace | Hevy Coach | **Yes** (directory empty in production) | — | — |

---

## 5. New ideas most apps don't have (ranked)

Ideas 1, 3 and 4 also help cold-start the coach marketplace.

1. **Bring your own coach (invite link).**
   - *Problem:* the directory is empty. Most people who want a coach already know one.
   - *How:* "Invite my coach" creates a link. The coach signs up through it, skips public listing, and the relationship starts with the client's chosen scopes. Admin review is required only to be *listed*.
   - *Why competitors don't:* Hevy Coach is coach-first (coaches bring clients). Client-first invites with consent scopes are rare.
   - *Clutter risk:* low. One button on Coaching; the directory hides until it has coaches.
2. **AI copilot for human coaches.**
   - *Problem:* coaches spend their time on weekly reviews.
   - *How:* for each client the AI drafts "this week: 3/3 sessions, bench +2.5 kg, sleep notes; suggested tweak…" from **only** the scopes the client granted. The coach edits and sends. Builds on the existing `for_coach_review` proposals.
   - *Why competitors don't:* nobody has both AI and a consent-scoped coach relationship.
   - *Clutter risk:* none for clients; it lives in the coach dashboard.
3. **"Short on time / gym is busy" one-tap session reshape.**
   - *Problem:* plans break in real life.
   - *How:* at Start, offer "I have 25 min" or "No barbell free". This reuses the generator's time-budget trim and `adaptSessionExercise`, and works offline with no AI call.
   - *Why competitors don't:* Fitbod regenerates whole workouts; most loggers don't adapt.
   - *Clutter risk:* hide it behind a secondary link under Start.
4. **Circle accountability (private, small).**
   - *Problem:* feeds are noisy, but accountability works.
   - *How:* pick 1–4 friends as your circle. Push "Sara finished Upper A — your turn today?" and a shared weekly ring (sessions done vs planned). No public leaderboard.
   - *Why competitors don't:* they optimise for public social graphs.
   - *Clutter risk:* opt-in, and lives on Today as one row.
5. **Consent ledger: "who saw what".**
   - *Problem:* trust is the barrier to sharing health data with coaches and AI.
   - *How:* a timeline of every coach or AI access by category and time, from server logs plus local AI context summaries, with "revoke" inline.
   - *Why competitors don't:* there is no incentive. Here it is a differentiator.
   - *Clutter risk:* goes under Settings → Data & privacy.
6. **Discomfort-to-return plan.**
   - *Problem:* "felt discomfort" currently just pauses progression.
   - *How:* after 2 flags the coach (AI or human) offers a 2-week ramp with alternatives, never medical advice, using the existing substitution constraints.
   - *Clutter risk:* triggered only by the flag.
7. **Offline in-session autoregulation.**
   - *Problem:* a user logs RIR 0 on set 1 of 3.
   - *How:* a local rule suggests "drop 5% for the next sets?" as a cheer-style chip, free and offline, in the coach style.
   - *Clutter risk:* only when the RIR column is on.
8. **Share a plan with a friend.**
   - *Problem:* "send me your program".
   - *How:* a link containing a template snapshot. The friend previews and imports it as a new program version (the proposal preview UI exists).
   - *Clutter risk:* goes in the program ⋮ menu.
9. **Sunday review card.**
   - *Problem:* weekly reflection drives retention.
   - *How:* a deterministic local summary (sessions, PRs, protein days) with an optional "Ask the coach about my week" button. The AI is optional, so no cost by default.
   - *Clutter risk:* one card, dismissible.
10. **Local grocery shopping list (Icelandic first).**
    - *Problem:* shopping lists don't match local products.
    - *How:* map ingredients to common Bónus/Krónan items and units, then export or share.
    - *Clutter risk:* goes on the shopping list page only. Low priority until i18n.
11. **Coach-approved AI.**
    - *Problem:* clients with a human coach still want quick answers between check-ins.
    - *How:* the coach sets rules ("no load changes, nutrition ok"), and the AI answers within them and flags changes to the coach.
    - *Clutter risk:* invisible unless a coach enables it.

---

## 6. Recommendations

### 6.1 Top 10 roadmap (quick wins first)

| # | Item | Size |
|---|---|---|
| 1 | **Unblock and gate deploys:** name new migrations after `20261103`; add a required reviewer on `production`; pin the Supabase CLI; add `deno check` and Playwright (Chromium) to CI; fix or quarantine `units-backup.spec.ts` | S (1 day) |
| 2 | **Backups and alerts:** confirm the Supabase and Netlify plans (Pro is $25/month; Netlify Personal is $9 if on credit Free); nightly `pg_dump` if staying Free; Sentry free tier in client and functions; uptime checks; GitHub failure emails | S (1 day) |
| 3 | **AI safety rails:** current `OPENAI_MODEL`; global daily cap; provider budget; Turnstile on sign-up; a `requireUser` lint test | S (1 day) |
| 4 | **Nutrition setup fixes:** "Protein only" opens Targets; inline weight; "this week from today / next week" at generation; 44 px links | S (1 day) |
| 5 | **Progress for new users:** adaptive default range, empty states, integer axes, collapsible method notes; "Warm-up 1/2" labels; single calibration banner in the logger | S (1–2 days) |
| 6 | **Startup bundle:** lazy-load `coachCheers`, coaching/social backends and the catalogue; memoise logger rows. Target startup chunk ≤ 45 KB gzip | S–M (1–2 days) |
| 7 | **Coach cold start:** "Bring your own coach" invite (idea 1); hide an empty directory; default the country | M (3–5 days) |
| 8 | **Gym utilities:** plate calculator, 1RM/% table, shareable workout image card (canvas + Web Share) | M (3 days) |
| 9 | **Strong/Hevy CSV import** into the existing atomic import pipeline (`repo.saveRecordsAtomic`, zod schemas) | M (3–4 days) |
| 10 | **Ops hygiene:** server data export button (S5), VAPID key check (S7), schedule `cleanup-media`, push cron only when due, staging project for deploy previews, docs refresh (BUILD_STATUS/README/HANDOFF/GITHUB) | M (3 days) |

After these: an SVG muscle map (M), progress photos (M), Icelandic i18n (L; no competitor has it), and exercise demos (L).

### 6.2 What NOT to build (to stay focused)

- **GPS run/ride tracking.** Strava owns it, and PWAs lose GPS when locked. Keep manual activities and a future Health import.
- **Public leaderboards and global challenges.** They conflict with the privacy-first design. Use small private circles instead (idea 4).
- **An in-house food database or barcode corpus.** If needed, query Open Food Facts on demand. Don't maintain data.
- **A native app wrapper,** until there is evidence users churn for lack of Health sync or widgets. It doubles release work for a solo owner.
- **Video classes / Fitness+-style content.** Short demo loops at most.
- **Realtime chat (websockets).** Polling plus push is enough for coach messaging at this scale, and avoids CSP and cost changes.
- **More AI personas or features before the model is pinned and capped.** Polish the three styles and actions instead.
- **Calorie-burn estimates from wearables, streak shaming, or "ideal weight".** They contradict the app's honest tone.
- **The visual refresh.** Two themes (Midnight/Daylight), celebrations and a first-launch theme picker are already in progress in a parallel PR, so this audit does not cover them.

---

## Appendix: commands and what couldn't be verified

**Ran:**

- `npm audit`, `npm audit --omit=dev`, `npm outdated`
- `npm run build` (failed CSP hash on CRLF `index.html` → LF normalised locally, `npx vite build` OK → reverted with `git checkout index.html`)
- `npx vite build --sourcemap --outDir <scratch>` (chunk composition)
- `npx vitest run` with the JSON reporter
- `gh run list`, `gh run view` (CI and deploy timings, failure logs), `gh api` (visibility, environments, rulesets)
- `git grep` for secrets
- `vite preview` plus browser walk-through
- Live guest checks of `/coaching`, `/coaching/find` and the response headers

**Not run:**

- `npm run test:e2e` (slow; `units-backup.spec.ts` is a known failure on `main`).
- `test:rls`, `test:ai-db` and `test:push-db` (need PostgreSQL). Results were taken from CI run 41066894699.

**Not verified:**

- Which Supabase and Netlify plans the project uses.
- Whether backups exist.
- Whether the push cron is actually scheduled in production and delivering.
- Live AI model quality, latency and spend.
- Netlify rollback UI.
- Supabase CLI out-of-order refusal (from docs, not run).
- Physical iPhone/Android install, offline, keyboard, background audio.
- VoiceOver/TalkBack.
- Logger and Progress performance on low-end devices.
- Connected-mode UI journeys (friends, AI chat, push permission).
- Free-plan pause behaviour with pg_cron traffic.
