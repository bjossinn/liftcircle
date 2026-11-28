# Where we are (deployment) — updated 30 Oct 2026 (v0.3.0 repair release prepared)

Supabase project **LiftCircle** (display name, unchanged: renaming it is an owner task, see docs/BRAND_AUDIT.md; ref `haryomdlsgrgrnsbdxui`, region eu-west-1, org "bjossinn's Org").


## 28 Nov 2026: Exercise illustrations (roadmap item 13, PR 2 of 3) — v1.0.5

- 45 of 105 library exercises show start/end line drawings: a 44 px thumbnail in the workout logger (tap to expand,
  frames alternate with a pause button; reduced motion shows both side by side), the full illustration on the exercise
  page, and thumbnails in exercise lists/picker. Custom and unmapped exercises keep the movement-pattern glyph; a failed
  image load falls back to it too.
- **Source: Everkinetic, CC BY-SA 4.0** (credited next to each illustration). The brief's preferred
  yuhonas/free-exercise-db photos were **not used**: their Unlicense is unverifiable and at least one photo shows
  Bodybuilding.com branding (details and evidence: docs/THIRD_PARTY_MEDIA.md). Owner decision if that should change.
- Mapping: `src/data/exerciseMedia.json` (reviewed by eye; `tests/unit/exerciseMedia.test.ts` checks paths, sizes and
  movement/equipment sanity). Files: `public/exercise-media/v1/` (~1.9 MB, 86 frames ≤ 30 KB + thumbs), built by
  `scripts/build-exercise-media.mjs`. Not precached; one Workbox runtime route (same-origin `/exercise-media/`,
  CacheFirst, 200 entries / 90 days). `public/_headers` serves them immutable (versioned path).
- New EN/IS strings under `exercise.visual.*` (Icelandic awaits native review). Also fixed the Icelandic
  `import.error.dateOrder` wording. No migration, no backend change.

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
