# Where we are (deployment) — updated 30 Oct 2026 (v0.3.0 repair release prepared)

Supabase project **LiftCircle** (display name, unchanged: renaming it is an owner task, see docs/BRAND_AUDIT.md; ref `haryomdlsgrgrnsbdxui`, region eu-west-1, org "bjossinn's Org").


## 28 Nov 2026: Pages open at the top (scroll reset on navigation) — v1.0.11

- Bug: tapping an exercise in the Library opened its detail page scrolled to the bottom. The window is the scroll
  container, Shell stays mounted and only `<Outlet />` swaps, and nothing reset `window.scrollY` on navigation, so the
  105-row list's position carried over and the browser clamped it to the bottom of the shorter page.
- Fix: `src/app/ScrollReset.tsx`, mounted in Shell before `<Outlet />` (sibling layout effects run in tree order, so page
  effects run after it). PUSH/REPLACE to a new pathname → top; search-only updates (library `?q=`/`?tab=`,
  `/settings?section=`, nutrition dates) keep the position; POP → the position saved for that history entry
  (`location.key`), retried for up to 1.5 s while a lazy page grows, stopped by user input; first load and `#hash`
  locations are left alone; `/feed` keeps restoring itself (FeedPage's own layout effect). `history.scrollRestoration`
  is set to `manual`. Deliberately not `<ScrollRestoration />` (it would jump on search-param updates and fight
  Settings' `scrollIntoView`).
- E2E `tests/e2e/scroll.spec.ts`: scrolled library → detail at the top → Back restores the list; typing in the library
  search keeps the position; `/settings?section=app` still lands on (and focuses) its heading, directly and from the index.
- Review fixes (same version): every history entry's position is seeded when it is reached and re-captured on the way
  out (the location effect's cleanup runs in the next commit before the old page's DOM is removed, so a scroll whose
  event hadn't fired yet still counts); a search-only REPLACE carries the position to the new key and drops the replaced
  key; at most 50 positions are kept (LRU, `ScrollPositions`). FeedPage now saves its scroll in a layout cleanup, which
  runs before ScrollReset's reset (its passive cleanup used to remember 0 after opening a post).
  Unit tests `tests/unit/scrollReset.test.tsx` (incl. Feed → post → Back with the social feature on); e2e adds an
  unscrolled list → detail → Back, search → detail → Back, and scroll-then-tap in the same frame.
- Also: fixed the stale `prone_pulldown` comment in `ExerciseGlyph.tsx` (it is a side view since v1.0.10).

## 28 Nov 2026: Glyph polish for the real 24 px size — v1.0.10

- Redrawn after checking every glyph at 24 px (1×) as well as 96 px: `prone_pulldown` (side view, face down on the
  floor, chest up, elbow pulled back; no frame), `standing_calf_raise` / `seated_calf_raise` (solid step block, foot
  angled up off it so the raised heel is obvious; no dashed line), `overhead_triceps_extension` (elbows up beside the
  head, forearms folded behind it in solid strokes, small dumbbell — no longer reads as an overhead press),
  `slider_leg_curl` (legs more extended, solid slider disc under the heels, standard 1.75 stroke), `bird_dog`
  (supporting hand and knee solid and on the floor), `leg_press` and `lying_fly` (fewer parts).
- Mapping unchanged. `npm run glyphs:sheet` is now cross-platform (`scripts/glyph-sheet.mjs` sets the env var);
  contact sheet and PNG regenerated.

## 28 Nov 2026: Per-exercise glyphs (76 movement pictograms + fallbacks) — v1.0.9

- Exercise tiles no longer pick their picture from the movement pattern alone (a push-up showed a bench press, a
  lateral raise / triceps pushdown / fly showed a curl, a leg curl or calf raise showed a leg extension, a
  chest-supported row showed a seated cable row, …). Every library exercise now has an explicit glyph key:
  `EXERCISE_GLYPHS` in `src/data/exerciseGlyphs.ts` (105 ids → 76 keys, from the ChatGPT audit on the temporary branch
  `temp-exercise-glyph-spec`; ids checked against the catalog, none needed fixing; that branch's spec/CSV are not merged).
- 79 hand-drawn 24×24 Direction B glyphs in `src/components/ExerciseGlyph.tsx` (stroke 1.75, `currentColor`, filled
  head, 0.35/0.6-opacity floors, cables and equipment): the 76 movement keys plus three kept on purpose —
  `conditioning_pulse` and `seated_forward_fold` (the old conditioning/mobility marks, now pattern fallbacks for custom
  exercises) and `neutral` (a dumbbell, last resort).
- Resolution (`exerciseGlyphKey`): library id → explicit key; custom exercises and unknown ids → `PATTERN_GLYPHS[pattern]`;
  anything else → `neutral`. Used by `ExerciseThumb` (lists, picker, compact logger row) and the exercise page header.
  Program-session marks still pass a pattern. `full.webp` + cues remain only on the exercise page and the expanded
  logger row. SVGs carry `data-glyph` (and `data-pattern` when known).
- Review: `docs/exercise-glyphs.html` (every key at 96 px and as the real 44 px tile in light and dark, with the
  exercises that use it) and `docs/screenshots/exercise-glyphs.png`. The sheet is generated from the live code; a unit
  test fails when it is stale — regenerate with `npm run glyphs:sheet`, then `npm run glyphs:png`.
- Tests: `tests/unit/exerciseGlyphs.test.tsx` (every catalog exercise resolves to a drawn key; no unknown ids; every key
  used or a reachable fallback; all glyphs distinct, 24×24, stroke 1.75, currentColor, in-bounds); e2e checks push-up,
  chest-supported row and lateral raise rows show their own glyphs.
- No migration, no backend change.

## 28 Nov 2026: Fully Icelandic app when the language is Icelandic — v1.0.8

- Dictionaries: 4,500 approved keys added to `en.ts` / `is.ts` (exercise names/aliases/setup/execution/mistakes, recipe
  names/steps/notes, ingredient names, amount/prep phrases, piece/category/protein-example labels, UI), Icelandic verbatim;
  concatenated UI sentences were merged into whole templates with named placeholders (fragment keys removed). 8,769 keys
  total (client + shared), identical in both languages.
- Catalog text stays canonical English in data and storage and is localized at display time through
  `src/data/catalogText.ts` (`exerciseDisplayName`, `exerciseAliases/Setup/Execution/Mistakes`, `recipeDisplayName`,
  `recipeSteps/Notes`, `ingredientDisplayName`, `foodDisplayText/PrepText`, `pieceLabel`, `ingredientCategoryLabel`,
  `proteinExampleText`). Custom exercises/foods and other user content are never translated.
- Exercise search indexes names and aliases in every app language plus English; sorting follows the UI language.
- Every screen that bypassed `t()` is wired (coaching, nutrition, social, activities, exercise library/detail, auth,
  install, session detail, templates, program page); push reminder/missed/rest texts use `push.*` keys; recipe/meal-plan
  screens use `mealLabel`/`allergenLabel`/`dietTagLabel`/`proteinGroupLabel` with the current language; shared meal-plan
  warnings/day status take an optional display language via `PlanContext` (server output unchanged, bundles regenerated).
- Workouts carry `nameEdited` (renamed template or renamed during the workout) so user-named sessions are never
  auto-translated; History search matches localized and stored titles; History shows each session's real mark.
- Review fixes: read-only workout labels (logger header, summary, history detail, coach client views) use
  `workoutDisplayName` (templateId + name + nameEdited); editable fields keep the stored name. Additive migration
  `supabase/migrations/20261201000001_client_overview_session_provenance.sql` adds `template_id` / `name_edited` to
  `coach_client_overview` recent sessions (same signature, grants kept) — apply it before deploying the app.
- Auth errors: `src/features/auth/authErrors.ts` maps Supabase auth error codes (and redirect `error_code`) to
  translated messages with a localized fallback; provider prose is never shown.
- Startup JS grew from ~873 KiB to ~2.0 MiB raw (230 → ~480 KiB gz) because both dictionaries ship in the entry chunk.
  Follow-up worth doing: lazy-load the Icelandic dictionary (or the catalog half) before first render.

## 28 Nov 2026: Direction B icons, pattern tiles in lists, distinct program-session marks — v1.0.7

- Direction B icon system (owner-approved mockup `icon-draft-B.png`): Lucide outlines at stroke 1.75 app-wide (`LucideProvider`
  in `src/main.tsx`), a strict 16 / 20 / 24 px grid, theme-token colours. New `src/components/Icon.tsx` (`Icon`, `IconTile`).
  `IconButton` sizes its icon itself (20 px; `iconSize="lg"` = 24 px for every back chevron); `Button` icons 16 px (20 px on
  `size="lg"` CTAs); tab bar icons 24 px (bottom tab bar kept). No `size-3`/`size-3.5`/`size-[22px]` left on Lucide icons.
- The 13 movement-pattern glyphs (`ExerciseGlyph.tsx`) are redrawn on a 24×24 grid for a 24 px mark in a 44 px tile.
- Exercise lists, the picker and the compact logger row always show the pattern tile (`ExerciseThumb`); `thumb.webp` is no
  longer requested (files stay on disk). `full.webp` + cues still show on the exercise page and in the expanded logger row.
- Program sessions get a deterministic mark (`src/domain/program/sessionMark.ts`, `SessionMarkTile` in `features/program/parts.tsx`):
  a family icon (upper, lower, push, pull, legs, full body, strength, walk, cardio/long/steady, mobility, conditioning) plus an
  A/B/C/D letter badge, derived from the generated id or the stored English name — so Upper A ≠ Upper B etc. Used on session
  cards, Train, Today and History. Cardio no longer reuses the walk icon; conditioning has its own mark.
- Today and Train show wizard session names in the display language (`displaySessionName`); stored data stays English.
- Icon-only controls keep a ≥ 44×44 px hit area (e2e `tests/e2e/icons.spec.ts` checks the main screens and the logger).
- No migration, no backend change.

## 28 Nov 2026: Exercise illustrations and technique cues (roadmap item 13, PR 2 of 3) — v1.0.5

- All 105 library exercises show a first-party, AI-generated illustration (made with ChatGPT; ours, no attribution):
  one 800×800 two-panel image (start | end position) on the exercise page and in the logger (tap the 44 px thumbnail
  next to the exercise name), and 256×256 thumbnails in exercise lists and the picker. Custom exercises keep the
  movement-pattern glyph; a failed load falls back to it (or hides the image and keeps the cues). A failure is
  remembered per image, so a swapped-in exercise is always tried.
- 4 short technique cues per exercise under the image, as i18n strings `exercise.cues.<id>.<n>`, in English and
  Icelandic (Icelandic made with ChatGPT from `cues-is.json` on branch `ai-exercise-media-v2`, pasted verbatim; a
  native-speaker review is still worthwhile).
- Files: `public/exercise-media/v2/<id>/{full,thumb}.webp` (~3.1 MB), from `hard-earned-exercise-media-v2.tar.gz`
  (branch `ai-exercise-media-v2`). Not precached; one Workbox runtime route (same-origin `/exercise-media/`,
  CacheFirst, cache `exercise-media-v2`, 220 entries / 90 days). `public/_headers` serves them immutable (versioned path).
- Owner task: check each AI image against its exercise for form/anatomy errors before release.
- The earlier Everkinetic (CC BY-SA) drawings and their credits page were removed. docs/THIRD_PARTY_MEDIA.md records
  the sources. Also fixed the Icelandic `import.error.dateOrder` wording. No migration, no backend change.

## 27 Nov 2026: CSV workout import from Strong and Hevy (roadmap item 13, PR 1 of 3) — v1.0.4

- Settings → Data → *Import from Strong or Hevy*: parsers for both CSV exports (auto-detected; comma/semicolon,
  quotes, decimal commas, kg/lb, warm-up/drop sets), exercise matching to the library (unmatched → custom exercises),
  a preview before anything is written, and one atomic write through the normal sync queue (`preferRemote`).
- Idempotent: each workout's id is a SHA-256 hash (source + start time + sets) shaped as a UUID; a workout whose
  `imported.key` (source + start time) exists on the device, even deleted, is skipped. Sessions carry an optional
  `imported` field (payload only; no migration, no backend change).
- Imports bypass the logger, so no cheers, auto-share, analytics "first workout" events or push sends.
- Review fixes: an exercise block whose library match can't hold the recorded values (weight on a timed exercise,
  rep-count Mountain Climbers) gets a compatible custom variant "<name> (Strong|Hevy)"; loaded carries/holds keep their
  weight. Slash dates use one order per file (from unambiguous dates; otherwise the preview asks; mixed files are
  rejected). The file, preview and write are bound to the account database they started in.
- Code: `src/features/import/`. New EN/IS strings under `import.*` (Icelandic awaits native review). Details:
  docs/USER_GUIDE.md "Backups & your data".

## 27 Nov 2026: Hotfix — `gpt-5.4` + tools needs `reasoning_effort: none`

- Live `ai-coach` calls after the gpt-5.4 switch failed with OpenAI HTTP 400 ("Function tools with reasoning_effort
  are not supported for gpt-5.4 in /v1/chat/completions"). Default effort is now `none` (0 reasoning allowance), and
  any gpt-5.4+ request with tools is forced to `none` regardless of `OPENAI_REASONING_EFFORT`. Verified live: tools,
  `tool_choice` and `json_schema` work, Icelandic is strong and natural.
- `medium` reasoning with tools on gpt-5.4+ requires a `/v1/responses` migration (not done). An
  `OPENAI_REASONING_EFFORT=low`/`medium` secret is now harmless on gpt-5.4+ but has no effect; remove it for clarity.
- Reminder copy unchanged (`gpt-5.4-mini` + `none`). Bundles regenerated: `ai-coach.ts`, `push-send.ts`. Deploys on
  merge; no migration. Details: docs/AI_COACH.md §4j.

## 27 Nov 2026: GPT-5 retirement — `gpt-5.4` for chat, `gpt-5.4-mini` for reminder copy

- OpenAI retires `gpt-5` and `gpt-5-mini` on 11 Dec 2026. The training assistant's OpenAI default is now `gpt-5.4`
  (`medium` effort at the time; now `none`, see the hotfix above); reminder push copy defaults to `gpt-5.4-mini` with
  `reasoning_effort: none` (0 reasoning tokens, `max_completion_tokens` 160; ~1.1 s live, where `gpt-5-mini` hit the
  3 s timeout). Both verified live on the owner's key.
- `minimal` / `none` are mapped per model (`compatibleReasoningEffort`): `minimal` only on gpt-5/-mini/-nano, `none`
  only on gpt-5.1+, otherwise `low`. All env overrides still win.
- Eval candidate `gpt-5.4-medium-structured` added. Dashboard bundles regenerated: `ai-coach.ts` and `push-send.ts`.
  Deploys on merge; no migration.
- Owner task: if `OPENAI_MODEL=gpt-5`/`gpt-5-mini` or `PUSH_COPY_MODEL=gpt-5-mini` is set as a function secret,
  remove it before 11 Dec 2026.
- Details: docs/AI_COACH.md §4i.

## 27 Nov 2026: Training assistant default reasoning is now `medium`

- After the owner tested Icelandic replies from coach voice v1, the OpenAI default is `gpt-5` with
  `OPENAI_REASONING_EFFORT=medium` (was `low`) and a 4,000-token reasoning allowance (was 2,000), so medium replies
  don't stop on `max_completion_tokens`. Explicit secrets still win: `OPENAI_REASONING_EFFORT=low` (2,000 tokens) or
  `OPENAI_MODEL=gpt-5-mini OPENAI_REASONING_EFFORT=low` are the faster, cheaper overrides; `off` sends no effort;
  `OPENAI_REASONING_TOKEN_ALLOWANCE` overrides the allowance (cap 16,000). If `OPENAI_REASONING_EFFORT=low` is set as
  a function secret, remove it to get `medium`. Higher cost and latency per message; no migration.
- Reminder push copy is unchanged (`gpt-5-mini`, `minimal`, 512).
- Tone smoke scorer: curly apostrophes (`Don’t push through…`) now count as negation.
- Dashboard bundles regenerated: `ai-coach.ts` and `push-send.ts`. Deploys on merge.
- Details: docs/AI_COACH.md §1, §4c, §4h.

## 27 Nov 2026: Coach voice v1 — GPT-5 default and an upbeat, emoji-friendly persona

- The training assistant's OpenAI default is now `gpt-5` at `low` reasoning (2,000 reasoning tokens), was `gpt-5-mini`
  (since raised to `medium`, see above).
  If `OPENAI_MODEL` is set as a function secret it still wins: to actually get the upgrade, remove it or set it to
  `gpt-5`; to go back, set `OPENAI_MODEL=gpt-5-mini`. Costs more per message than gpt-5-mini; no migration.
- New prompt (`PROMPT_VERSION` `2026-11-27.coach-voice-v1`): upbeat, warm and fun voice with 0–2 optional emojis,
  natural Icelandic register, a **calm safety voice** (no emojis, jokes, hype or pressure) for pain, exhaustion,
  distress, medical concerns and crisis in every style, and rewritten styles (Supportive stays the default; Strict is
  firm without scolding and never questions pain or tiredness).
- Reminder push copy keeps its own model (`gpt-5-mini`, `minimal` reasoning, 512 tokens; overrides such as gpt-5.1 get `low`, never `minimal`; `PUSH_COPY_MODEL` /
  `PUSH_COPY_REASONING_EFFORT` / `PUSH_COPY_REASONING_TOKEN_ALLOWANCE` override). Only the workout reminder may end with
  one 💪 or 🙌; missed-workout and food nudges stay emoji-free. Still off unless `PUSH_AI_COPY=on`.
- Dashboard bundles regenerated: `supabase/functions-bundled/ai-coach.ts` and `push-send.ts`. Deploys on merge.
- Owner tasks: run `node tests/live/coach-tone-live.mjs` (EN/IS tone smoke set) and, before turning on push copy,
  `node tests/live/push-copy-live.mjs`, with real keys; have a native speaker review the Icelandic. Optionally compare
  `gpt-5-low-structured` with the `gpt-5-mini` baseline in `tests/live/coach-eval.mjs`. None could run in the sandbox.
- Details: docs/AI_COACH.md §4h, docs/AI_PROMPT_RULES.md.

## 30 Nov 2026: Eval set, streaming status line and six-part prompt (roadmap item 10)

- One additive migration: `supabase/migrations/20261130000001_ai_cancellation.sql` (acknowledged Stop: request states,
  refunds, idempotent usage reports, a publication guard). Deploy Supabase applies it on merge, then deploys `ai-coach`.
  Until it is applied the app streams but shows no Stop button.
- Dashboard bundles regenerated: `supabase/functions-bundled/ai-coach.ts` and `push-send.ts`.
- Structured Outputs switch on automatically for supported models on the official endpoints (`AI_STRUCTURED_OUTPUT`,
  default `auto`; set `off` to keep plain-text replies). The production model is unchanged.
- Owner tasks: (1) run `node tests/live/ai-sse-smoke.mjs` against the deployed project with a synthetic test account;
  (2) run the eval with real keys (`node tests/live/coach-eval.mjs --repeat 3 --max-cost-usd 10 …`) and have a native
  speaker fill in the blind `review.csv` before choosing any model change. Neither could run in the build sandbox.
- Details: docs/AI_COACH.md §4g, docs/BACKEND.md §9b, docs/AI_PROMPT_RULES.md.

## 29 Nov 2026: Coach-initiated push notifications, phase 1 (roadmap item 9)

- One additive migration: `supabase/migrations/20261129000001_coach_push.sql` (daily limit, pause, revision and the
  off-by-default food-log reminder in `push_prefs`; dispatch state, claim tokens, expiry and a quota ledger for
  `push_jobs`; a sync-completed receipt). Deploy Supabase applies it on merge and then deploys `push-send`
  (migrations run first, so the new worker never meets the old schema). Until the migration is applied, the app shows
  "Coach notification settings aren’t available right now" and everything else keeps working.
- Dashboard bundles regenerated: `supabase/functions-bundled/push-send.ts` and `ai-coach.ts` (consent helpers moved
  to `_shared/ai/consent.ts`; behaviour unchanged).
- Generated reminder wording is OFF until you set the function secret `PUSH_AI_COPY=on`. Before that, run
  `node tests/live/push-copy-live.mjs` with the production provider key and have a native speaker review the
  Icelandic output. Without it every reminder uses the approved fallback text.
- Rollout is safe in either order: until the new `push-send` is live, the old one only receives rest/test/coaching/
  social pushes (legacy `push_claim_due`); coach reminders wait for the new worker (`push_claim_due_v2`).
- Details: docs/BACKEND.md §9a.

## 28 Nov 2026: State-aware training assistant (roadmap item 7)

- One additive migration: `supabase/migrations/20261128000001_ai_session_adjustment.sql`. It stores the new
  `session_adjustment` action, adds it to the analytics allowlist, and makes a NULL coach style read as Supportive.
- Deploy Supabase applies it on merge, then deploys the `ai-coach` function (migrations run first). The dashboard bundle
  `supabase/functions-bundled/ai-coach.ts` is regenerated for manual deploys. If the function goes out before the
  migration, the workout card still shows for that reply but isn't stored.
- Details: docs/AI_COACH.md §4f.

## 1 Nov 2026: Icelandic replies from the training assistant (v1.0.1)

- The assistant's prompt now says to reply in the user's language and to write natural Icelandic (docs/AI_COACH.md §4c).
- Deploys with Deploy Supabase on merge; no migration.
- Owner choice: the default model was `gpt-5-mini` at `low` reasoning, which is weak at Icelandic. Superseded by coach
  voice v1 (27 Nov 2026): the default became `gpt-5` at `low`, and is now `gpt-5` at `medium` (`low` is the cheaper override).

## 31 Oct 2026: Hard Earned rebrand (v1.0.0), PR waiting for your review

- What changed:
  - name, colours, icons, fonts, copy tone and "Training assistant" naming;
  - one additive migration (`supabase/migrations/20261105000001_hard_earned_brand_text.sql`) that renames
    server-generated push titles and two fallback names.
- Reports: docs/BRAND_AUDIT.md (counts, kept references, owner tasks) and docs/VERIFICATION_REPORT.md (commands,
  results, limits). Screenshots: docs/screenshots/hard-earned/.
- On merge: Deploy Supabase applies the migration and Netlify deploys the site. Installed apps pick up the new name and
  icon with the next update, but iOS keeps the old Home Screen icon until the app is removed and added again.
- Owner tasks (not changed here):
  - Supabase Auth email templates and sender name;
  - Netlify site name/domain;
  - GitHub repo name (optional);
  - Supabase project display name (optional).

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
1. Phone test: install, log a workout offline, feed post with photo, training assistant message (check platform.openai.com usage).
2. Optional: hourly cron for cleanup-media (docs/BACKEND.md §5) — needs the CLEANUP_SECRET in Vault.
3. Redeploys: rebuild with the two VITE_SUPABASE_* values and drag the new dist onto the site's Deploys page.
