# Build status

_Last updated: 30 Oct 2026 · version 0.3.0 (repair & audit release — see “v0.3.0 repairs” below and docs/AUDIT_2026-10-29.md; 0.2.0 added human coaches, coach directory and AI coach)_

Status labels used here: ✅ **tested** means an automated test ran and passed; 🟡 **built, not tested here** means it is implemented but could only be checked by reading the code or by a manual pass in an emulated browser; ⏳ **needs your setup** means it needs external accounts or physical devices.

## Verification results (all run in this build environment, 29–30 Oct 2026, v0.3.0)

| Suite | Command | Result |
|---|---|---|
| TypeScript (app + tooling + tests) | `npm run typecheck` | ✅ 0 errors |
| Unit tests (Vitest, jsdom + fake-indexeddb; backends **mocked**) | `npx vitest run` | ✅ **573 / 573** in 33 files |
| Database / RLS (real PostgreSQL 16 with Supabase auth/storage stubs, all 15 migrations) | `npm run test:rls` | ✅ **478 / 478**; coaching matrix 321/321 cells; 24 audit + 9 public-preview tests |
| AI coach database checks (same throwaway PostgreSQL) | `npm run test:ai-db` | ✅ **19 / 19** |
| Browser e2e (Playwright, Chromium, Pixel 7 emulation, production build + service worker) | `npm run test:e2e` | ✅ **25 / 25** |
| Production build | `npm run build` | ✅ (PWA precache 186 entries, ~2.4 MB; CSP inline-hash check passes) |
| Live schema vs repo | `tests/live/schema-fingerprint.sql` in the SQL editor vs `node tests/live/schema-fingerprint.mjs` | ✅ identical at migration 20261029000004 (164 functions, 71 policies + expressions, 45 tables' RLS, grants, 5 buckets); deploy file reproduces the full-repo fingerprint |
| Live anonymous surface (HTTPS, publishable key only) | browser checks | ✅ tables 401/42501, private RPCs refused, storage lists empty, OpenAPI 401 |
| Live backend journeys (member, friend, stranger, coach, admin) | `node tests/live/backend-live.mjs` | ⏳ written, **not run**: needs test accounts and the v0.3.0 deploy |
| Live OpenAI call (two-sessions-this-week case) | `node tests/live/ai-live.mjs` | ⏳ **never run here** — every AI test used a mocked provider |

An independent review of the sync, auth and logger code found 6 real bugs: lost-response handling, conflict resolution using a stale snapshot, conflicts not counted as unsynced at sign-out, a stale conflict copy, the sign-out default, and a finish-flow race. All 6 are fixed, and each fix has a regression test.

## Acceptance criteria (§18)

| # | Criterion | Status / evidence |
|---|---|---|
| 1 | Onboarding → schedule matches equipment, days, session length | ✅ e2e `onboarding.spec` + 84 generator/schedule/progression unit tests. These include a sweep over 1,280 input combinations: only chosen days, only owned equipment, one session per day. |
| 2 | Skip nutrition, full tracker still works | ✅ e2e |
| 3 | Workout survives reload, navigation, offline, reopening; same sets and timer | ✅ e2e (rest-timer deadline recalculated after reload) + `sessionOps` unit tests |
| 4 | Template edits keep history; historical edits update stats | ✅ unit (`stats`: edited set changes summaries/records; program versions never touch sessions) + e2e history edit |
| 5 | Unit changes keep actual values; load conventions consistent | ✅ e2e (135 lb → 61.2 kg → 135 lb exactly) + unit (per-hand ×2, unilateral, machine kept separate) |
| 6 | Progression: achieved reps / missed / discomfort | ✅ unit (`progression.test.ts`) |
| 7 | Protein, Mifflin, recipe scaling, pace arithmetic | ✅ unit (100 kg × 1.8 = 180 g; 1780 / 1320.25 kcal; 5:00 /km, 8:03 /mi) |
| 8 | Export/import restores without duplicates | ✅ e2e (wipe device → restore) + unit |
| 9 | Two accounts become friends, share photo post, like, comment | ✅ at database level (`test:rls`). ⏳ Over real HTTP/Storage/Edge Functions: `test:live` |
| 10 | Stranger can't read post/comments/media/health records via direct API | ✅ DB level (RLS + storage policies). ⏳ live |
| 11 | Friend can't read unshared workouts, measurements, food logs, Only-me posts, also after Friends → Only me | ✅ DB level. ⏳ live |
| 12 | Block/unfriend changes access; no impersonation; can't accept own request | ✅ DB level. ⏳ live |
| 13 | Repeated taps, expired sessions, upload retries, reconnection don't duplicate | ✅ e2e double-tap Finish; unit: sync idempotency/lost response/auth pause; pending-post state machine; DB: idempotent RPCs |
| 14 | Failed photo upload keeps workout and offers recovery | ✅ unit (pending posts never touch records; retry/cancel). 🟡 UI checked manually |
| 15 | Account switching, deletion, stale offline writes don't leak/resurrect | ✅ unit (ops never sent under another account; tombstones win; guest import only into the authenticated DB) + DB (cascade delete) |
| 16 | PWA files, install, standalone, offline navigation, updates | ✅ manifest/icons/SW, offline navigation (e2e). 🟡 The "Update available" banner is implemented (it waits while a workout is active) but no e2e test covers it. ⏳ Real iPhone/Android install and standalone launch need physical devices. |

## Feature status

**Done (all §3–§17 areas):**

- **Foundation**
  - Design system with a dark graphite theme and light/system themes.
  - Six tabs (Coaching added in 0.2.0) plus secondary navigation, a persistent "Resume workout" bar, offline/update/sync banners, safe areas, focus states, reduced motion.
- **Accounts**
  - Email sign-up, verification, sign-in and password reset (PKCE flow).
  - Persistent sessions.
  - An expired session pauses backup without touching local data.
  - Guest → account import with a preview and no duplicates.
  - Sign-out with explicit handling of unsynced data.
  - Real account deletion.
- **Settings:** units, theme, week start, time zone, rest/workout defaults, notifications, discoverability, sharing/auto-share, nutrition toggle, data page, demo dataset in its own database.
- **Onboarding:** 12 steps with saved progress and validation; review and edit; result screen with rationale; alternatives and regenerate; a manual path; under-18 and individualized-nutrition rules.
- **Program generator:** deterministic, 1–6 lifting-day splits, easy-day fill, endurance-first plans, time budget trimming, calibration (no load guessing), a 6–8 week block with a review week, missed-session rescheduling, version history, and manual/custom routines.
- **Progression:** double progression, plus separate rules for bodyweight, assisted, timed and distance work, a "review recovery" flag on decline, and discomfort suppression.
- **Exercise library:** 105 original exercises with search, filters, favourites, recent, custom exercises, a substitution flow and load-convention notes.
- **Workout logger**
  - One-tap ✓ with undo; values carry to the next set; quick ± load; copy set; warm-up, drop and timed sets; RPE/RIR; supersets; reorder and swap; notes; discomfort flag.
  - Deadline-based rest timer (extend, skip, pause, reset) with sound, vibration and wake lock where supported; session pause/resume.
  - Finish flow and summary with records; history calendar with search; editing and deleting past sessions (with an offer to remove the shared post); templates.
- **Activities:** 12 types with relevant fields, pace/speed, optional labelled energy estimate, templates, interval timer.
- **Progress:** consistency/adherence, exercise charts, PRs (labelled e1RM), working sets per muscle, volume with its conventions shown, cardio, bodyweight with a 7-day average, measurements, protein consistency, goals, factual observations.
- **Nutrition:** protein-only or full targets with the calculation shown, 102 ingredients, 84 recipes computed from their ingredients, scaling, substitutions, food logging (quick, recipe, food, custom, saved, copy), weekly meal plan, shopping list.
- **Backend**
  - 7 migrations, owner-only private tables with typed projections and normalized session tables, global versioning, `sync_push` / `sync_pull` compare-and-swap.
  - Social schema, RLS everywhere with least-privilege grants, rate limits, trigger-created notifications, reports with a server-authorized moderator role.
  - Private storage buckets and policies.
  - Three Edge Functions: finalize-post, delete-account, cleanup-media.
- **Social client**
  - Profiles, friends (find by exact username or link), feed with pagination, posts with up to 4 photos, likes, comments, notifications, report/block, moderation queue.
  - Snapshot sharing with per-field choice, Friends/Only-me audiences, opt-in auto-share.
  - Offline "Waiting to upload" queue with retry and cancel.
- **Photos:** client resize to 2048 px plus a 480 px thumbnail, re-encoded to JPEG (EXIF/GPS stripped and asserted), size and pixel limits; the server validates again in finalize-post.
- **PWA:** manifest, original icons (192, 512, maskable, Apple touch), Workbox precache of the app shell and bundled data, no runtime caching of Supabase/media, user-controlled updates, install prompt and iOS instructions.
- **Backups:** versioned JSON backup and restore with preview, CSV exports, a persistent-storage request.

## v0.3.0 repairs (29–30 Oct 2026)

Full findings matrix, capability matrix and commands: **docs/AUDIT_2026-10-29.md**.

- **Split choice:** an explicit split selector (2 days: Full-body A/B or Upper/Lower; 3 days: Full body, Upper/Lower/Full
  or Push/Pull/Legs; more at higher frequencies) saved in the draft and the program; "Change split" is separate from
  "Shuffle exercises"; no hidden variant parity.
- **AI coach:** an immediate, app-rendered welcome; short direct answers with a "Why this?" expansion; this week's real
  plan state in context; typed settings beat stale notes; temporary week plans ("I can only train twice this week")
  with **Apply to this week** / Undo, never touching the baseline plan.
- **Logging:** typed values saved without blur (debounce + local draft + flush on every exit); shared set validation
  (no 0-rep completed sets, no negatives); substitutions rebuild prescriptions and respect equipment/limitations
  ("Show all exercises" override); warm-ups never exceed the working load (bar weight in Settings); honest effort
  wording; Apply / Keep previous / Customize.
- **Meal plans:** each day balanced to the protein target with portions and protein sides; per-day gaps and suggestions
  persist across reloads; calories informational in protein-only mode; one rounding rule.
- **Backup/auth:** validated, atomic import with explicit merge/replace and per-part settings choice; CSV formula
  neutralisation; sign-up CTAs keep the return destination; "Back to sign in" fixed; privacy summary at sign-up;
  coach composer drafts survive navigation/reload.
- **Backend:** set-validation trigger, AI v2 storage, concurrent-acceptance deadlock and stale-request guard, unsent coach
  drafts hidden from clients, export v2 with coaching/AI data, public read-only coach preview for guests.
- **PWA/mobile:** storage/IndexedDB/service-worker health banners, no update reload mid-workout, ≥44 px targets, dialog
  names, AA contrast tokens, CSP + HSTS + COOP, vendor chunks (startup chunk 900 → 114 KB).

**Deploy status:** the four new migrations, the `ai-coach` function and the new site are **built but not deployed** —
production deploys need the owner (steps in docs/SETUP.md §8 and HANDOFF.md).

## Coaching extension (29 Oct 2026)

Built as an additive extension: 4 new migrations (`20261029000001…04`), 3 new Edge Functions (`geocode`,
`finalize-coach-media`, `ai-coach`), one Dexie upgrade (v2 adds the `coachOutbox` table only), a 6th tab
**Coaching**, and 19 new screens. No existing table, migration or screen was redesigned.
Contracts: docs/COACHING_INTERFACES.md · backend: docs/BACKEND.md §8 · AI: docs/AI_COACH.md · setup: docs/SETUP.md §7.

**What's in it**

- **Applications & admin review:** draft → submitted → changes requested / approved / rejected, resubmission, review
  feedback, audit trail (`coach_review_events`), suspend/reinstate, private qualification documents (applicant +
  admins only), reviewed claims that change go back to pending. First admin is granted in SQL only (no RPC can grant
  roles). Admin screens: application queue and detail, coaching reports (`/coaching/admin/reports`).
- **Directory:** town/region/country search, optional "Use my location" (asked on tap, rounded, never put in the URL),
  format/specialty/language/accepting filters, radius only when real coordinates exist, rounded distance only when
  calculable, local vs remote labelling. Geocoding via the `geocode` function (Nominatim or none). No sample coaches,
  ratings or testimonials.
- **Requests & relationships:** intake prefilled from the user's own goals (codes only, no injury notes), intro
  message, per-category sharing (training, measurements, nutrition, check-ins), requested/active/declined/cancelled/
  ended, one primary coach with switching, revoke/end/block/suspension enforced server-side on the next request —
  including queued offline messages, which re-check permission before sending.
- **Coach tools:** dashboard (clients, requests, unread, adherence from permitted records), client detail panels that
  respect each scope, program builder reusing the existing editor and exercise catalog, proposals with change
  summaries, client preview and acceptance into the normal Train/Today/logger flow, workout feedback (never edits
  results), check-ins.
- **Messaging:** persisted before "Sent", server ordering (`seq`), unread counts, idempotent retries (no duplicate
  messages or notifications), offline outbox, photo attachments through a conversation-scoped private bucket with
  server validation, block/report. Notifications carry ids only, never message text; they appear in the existing
  notifications screen and can be turned off (Settings → Notifications → Coaching updates).
- **One active plan:** `Program.managedBy` marks self / coach / AI. Today, Train and the program screen label coach and
  AI plans; "Make it self-managed" is an explicit choice. Accepting creates a new version (stale proposals are refused
  on the device *and* on the server); an AI suggestion can't replace a coach-managed plan unless the user switches.
- **AI coach:** setup + consent (to the named provider; a later provider switch asks users to agree again) with data-category controls, pause/disable, persistent chat with labelled AI
  messages, grounding chips, suggested questions, check-in review, structured proposals validated server-side
  (exercise ids, owned equipment, exclusions, ranges, schedule, base version), pending suggestions list. The provider
  (OpenAI Chat Completions or Anthropic Messages API, chosen by env) is called only from the `ai-coach` function (key in function secrets), with per-user daily limits,
  bounded context, timeouts, bounded retries and per-day usage/cost tracking. Missing key, rate limit or outage →
  truthful state; nothing else is affected.

**Requirement §10 tests — what ran, and how**

| # | Requirement | Evidence (✅ ran here · mocked = no real server/provider) |
|---|---|---|
| 1 | Submit / resubmit; pending & rejected invisible, no client access | ✅ `test:rls` coach §1 (9 checks) · ✅ unit submit-rule mirror |
| 2 | Approval → eligible listing; suspension revokes access despite a session | ✅ `test:rls` coach §2 (4 checks, existing-session case included) |
| 3 | Location search, remote filters, denied geolocation | ✅ `test:rls` coach §3 (5) · ✅ unit (mocked API): URL encode/decode, rounding, denied/timeout/unsupported geolocation, null distances, FindCoachPage render with denied location |
| 4 | Pending → intake only; active → consented data only | ✅ `test:rls` coach §4 (6) incl. scope change on the very next query |
| 5 | Other coach / friend / stranger can't read records, messages, documents | ✅ `test:rls` coach §5 + 17×10 access matrix (321 cells) |
| 6 | Revocation, termination, blocking vs direct and queued writes | ✅ `test:rls` coach §6 (4) · ✅ unit (mocked API): outbox re-checks the relationship before sending |
| 7 | Coach creates, assigns, revises a program via the existing flow; history unchanged | ✅ `test:rls` coach §7 (5) · ✅ unit: `applyProposal` (new version, single active plan, history untouched), accept flow on real Dexie |
| 8 | Messaging persists; retries don't duplicate | ✅ `test:rls` coach §8 (4) · ✅ unit (mocked API): outbox lost-response retry, same id |
| 9 | AI uses only the right user's permitted context; tampered ids / malicious notes | ✅ unit **mocked** (`ai.test.ts`: verified-uid context, revoked scopes not read, injection in notes/history) · ✅ `ai-run` RLS |
| 10 | AI proposals stay drafts, stale rejected, no silent replacement of a coach plan | ✅ unit **mocked** (server validation + `for_coach_review` forcing) · ✅ `ai-run` (stale refused, review-only can't be accepted) · ✅ unit UI (explicit switch + confirm) |
| 11 | Missing credentials, rate limits, outages leave the app usable | ✅ unit **mocked** provider (503 not_configured, 429 retry, 5xx/529/timeout, daily limit; OpenAI: request/response translation, tool round, out-of-credits not retried, per-provider consent) · ✅ e2e `coaching.spec` (no backend: truthful states, tracker still works) |
| 12 | Existing logging, offline recovery, social, nutrition, PWA | ✅ all previous suites unchanged and passing (e2e 10/10 original + unit + RLS 223 original checks) |

**Not verified (needs your project / keys):** real Storage uploads and signed URLs for coach photos, documents and chat
photos; the three new Edge Functions in the Deno runtime; a real OpenAI or Anthropic API call (cost, latency, model behaviour);
live Nominatim; email delivery of nothing new (coaching notifications are in-app only).

**Known limitations**

- A coach revising a client's plan starts from the coach's last accepted proposal: the API returns the client's
  current program name/version but not its contents. If the client edited the plan since, the comparison is marked
  approximate and the client's device rejects it as out of date. Fix: a `client_program(relationship)` RPC gated by
  the training scope.
- Accepting a proposal can be refused by the server until the new local plan version has synced; the coach flow shows
  Retry, the AI flow retries up to 5 times and drops permanent refusals.
- Chat history loads the latest 200 messages (no "load earlier"); check-ins aren't queued offline (the form keeps its
  contents); messaging polls, no realtime.
- Storage leftovers: photos/documents picked but never saved on the apply page, and photos of a single message an admin
  removes, stay in storage unreferenced (account deletion does remove all of a user's coaching files).
- "Export my data" includes coaching and AI records from v0.3.0 (export v2, once migration 000003 is deployed); clearing AI
  history keeps proposals and usage counts; nothing can be deleted on the AI provider's side (stated in the app).
- AI usage is counted before the provider call (failed calls use quota); usage days are UTC; the server-side
  progression check covers weighted lifts only.

## Not yet tested here, and limitations

1. **The live Supabase stack has not been exercised.** Untested pieces: real GoTrue email flows, Storage HTTP uploads and signed URLs, the Edge Function runtime (Deno isn't available here, so the functions haven't even been type-checked by Deno), and Supabase Cron. To test them, run `npm run test:live` against your project.
2. **The social UI has only been checked offline.** It was exercised under jsdom with a mocked API, and its signed-out/Personal-mode states in a real browser. It has not been tested against a live backend.
3. **No physical-device testing.** Untested: iOS/Android home-screen install, standalone launch, background audio/vibration while the phone is locked (best effort by design).
4. **Multi-tab account switching.** Before each push the client checks that the current Supabase session belongs to the account that queued the op. `sync_push` itself has no expected-owner check (rows are always owned by `auth.uid()`). Possible server-side hardening: an `p_expected_owner` parameter.
5. **Things that will look odd.** A deleted custom exercise shows as "Unknown exercise" in old workouts (the delete dialog warns about this). The calendar shows past weeks using the current program version's schedule.
6. **Not included in v1**, as the spec allows: push notifications, GPS tracking/wearables, a live food database or barcode lookup, account suspension in social moderation. (AI and human coaching were added in 0.2.0.)
7. **Bundle size.** Fixed in 0.3.0: vendor chunks (react, supabase-js, dexie) split out; startup chunk 114 KB.

## Setup blockers (need you)

- A Supabase project: `supabase db push` (now 15 migrations), load `seed.sql`, deploy 6 functions, set `CLEANUP_SECRET`, configure auth redirect URLs and SMTP. See docs/SETUP.md §2–4 and §7.
- First admin: one SQL insert into `public.app_roles` (docs/SETUP.md §7.3).
- Optional: `GEOCODER` secrets for distance search; an **OpenAI Platform API key** (or Anthropic Console key) for the AI coach — API use is billed per token, separately from ChatGPT/Claude.ai subscriptions.
- A Netlify site with the two `VITE_SUPABASE_*` env vars. See docs/SETUP.md §5.
- Three confirmed test users for `npm run test:live`.

## Continuing development

- The code is organised by slice; see docs/INTERFACES.md for the cross-module contracts and docs/CONVENTIONS.md for the rules.
- Before handing off, run `npm run typecheck && npm test && npm run test:all`.
- After changing an Edge Function, regenerate `supabase/functions-bundled/` (command in docs/BACKEND.md §7).
- If you add a migration that creates `private` functions, re-apply the lockdown (docs/BACKEND.md §7).
