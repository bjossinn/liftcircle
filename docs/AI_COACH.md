# training assistant — setup, data flow, safety, testing

The training assistant is optional. With no API key configured the app works as before (tracker, deterministic
program generator, nutrition tools, social, human coaching); the AI screens show a truthful "not set up"
state. The provider is either the **OpenAI Chat Completions API** or the **Anthropic Messages API** (chosen by env,
see below), called only from the `ai-coach` Supabase Edge Function. The key never reaches the browser.

**Choosing a provider.** `AI_PROVIDER=openai|anthropic`; without it, OpenAI is used when only `OPENAI_API_KEY` is
set, otherwise Anthropic. Internally everything (context, tools, proposal validation, storage) uses one message
format; `_shared/ai/openai.ts` translates to and from OpenAI (system message, function tools and `tool_calls`,
`role: tool` results, `max_completion_tokens`, `finish_reason`, usage). `status` returns `provider` and
`providerName`, and the app names that company in setup, consent and the data/retention texts. Consent is stored
per provider (`consent_version = '2026-10-29:openai'`; older values without a suffix mean Anthropic): if the server's
provider differs from the one a user agreed to, `send` returns `409 consent_required` without calling anyone, and
the app sends the user through setup again.

### OpenAI variables (function secrets)

| Variable | Default | Meaning |
|---|---|---|
| `OPENAI_API_KEY` | — | Platform API key (platform.openai.com). Billed separately from ChatGPT subscriptions. 401/403 → `not_configured`. |
| `OPENAI_MODEL` | `gpt-5-mini` | Any Chat Completions model your key can use; check the models list on the OpenAI Platform. |
| `OPENAI_REASONING_EFFORT` | `low` for `gpt-5*`/`o*` models, otherwise not sent | Sent as `reasoning_effort`. `off` never sends it (needed for models that reject the parameter). |
| `OPENAI_REASONING_TOKEN_ALLOWANCE` | `2000` when an effort is sent | Added to `AI_MAX_OUTPUT_TOKENS` for `max_completion_tokens`, because hidden reasoning tokens count against that limit (and are billed as output). |
| `OPENAI_BASE_URL` | `https://api.openai.com` | Override only for a proxy/gateway (must serve `/v1/chat/completions`). |

An OpenAI `429 insufficient_quota` (no credits / billing limit) is not retried and shows as "unavailable";
other 429s and 5xx are retried like Anthropic's. No `temperature` is sent (reasoning models reject it).
The Anthropic variables below apply only when Anthropic is the provider.

## 1. Setup

1. **Get an API key for one provider.**
   - OpenAI: <https://platform.openai.com> → API keys. Separate from ChatGPT subscriptions (Plus/Pro/Team
     don't include API access); usage is billed per token from prepaid Platform credits. Set a usage limit.
   - Anthropic: <https://platform.claude.com> (Console → API keys). Separate from Claude.ai subscriptions;
     billed per token to the Console organization. Set a monthly spend limit in the Console.
2. **Apply the migrations** `supabase/migrations/20261029000003_ai_coach.sql` (after `…01_coaching_schema.sql`,
   before `…04_coaching_lockdown.sql`) and `20261030000002_ai_coach_v2.sql` (adds `ai_messages.why` / `.action`;
   apply it **before** redeploying the function — until then replies still work, but "Why this?" and
   "Apply to this week" are not stored, so they disappear after a reload), and `20261031000001_ai_coach_style.sql`
   (adds `ai_settings.coach_style`; until it is applied, saving a coach style fails and everyone gets Balanced), and
   `20261102000001_ai_coach_actions.sql` (stores meal-plan and recipe-card actions; until it is applied those cards show
   for the reply but are dropped after a reload — week plans keep working):
   `supabase db push`, or paste them into the SQL editor in order. Merging to main does this automatically through
   the Deploy Supabase workflow.
3. **Set the secrets** (Dashboard → Edge Functions → Secrets, or CLI):
   ```sh
   supabase secrets set OPENAI_API_KEY=sk-... OPENAI_MODEL=gpt-5-mini        # OpenAI
   # or: supabase secrets set ANTHROPIC_API_KEY=sk-ant-... ANTHROPIC_MODEL=claude-sonnet-5-5
   # optional
   supabase secrets set AI_DAILY_REQUEST_LIMIT=40 AI_MAX_OUTPUT_TOKENS=1200 \
     AI_PRICE_INPUT_PER_MTOK=<from pricing page> AI_PRICE_OUTPUT_PER_MTOK=<from pricing page>
   ```
4. **Deploy the function**: `supabase functions deploy ai-coach` (JWT verification ON — `supabase/config.toml`
   has `[functions.ai-coach] verify_jwt = true`). If you deploy through the dashboard editor instead of the
   CLI, paste the prebuilt single-file bundle `supabase/functions-bundled/ai-coach.ts` (regenerate it with the
   esbuild command in docs/BACKEND.md §7 after changing `_shared/ai/*.ts`).

### Environment variables (function secrets)

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | — (required for Anthropic) | Console API key. Missing → `503 {code:'ai_unavailable', reason:'not_configured'}`; `status` reports `not_configured`. |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | Any Messages-API model id. Not hard-coded: pick from the Console models list (e.g. `claude-haiku-5-5` for lowest cost, `claude-opus-5-5` for quality). |
| `ANTHROPIC_VERSION` | `2023-06-01` | `anthropic-version` header. `2026-10-21` also works (the function sends no `temperature`/`top_p`/`top_k`). |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Override only for a proxy/gateway. |
| `AI_DAILY_REQUEST_LIMIT` | `40` | Messages per user per **UTC** day (`ai_usage.requests`). Over → `429 rate_limited` (SQLSTATE PT429). |
| `AI_MAX_OUTPUT_TOKENS` | `1200` | `max_tokens` per provider call. |
| `AI_TIMEOUT_MS` | `45000` | Per-attempt timeout (AbortController). Whole request budget ≈ 110 s. |
| `AI_STRUCTURED_OUTPUT` | `auto` | Item 10. `auto`: the final reply uses Structured Outputs (`{answer, why}`) only on the provider's official endpoint with a model known to support it (Anthropic `output_config.format`, OpenAI `response_format` json_schema); custom `*_BASE_URL` endpoints and other models use the text reply. `on`: the configured endpoint is declared to support it. `off`: always text. Never switches provider or model. |
| `AI_CANCEL_POLL_MS` | `1500` | Item 10. How often a running request checks whether the user pressed Stop (bounded; 200–10000). |
| `AI_PRICE_INPUT_PER_MTOK` / `AI_PRICE_OUTPUT_PER_MTOK` | unset | USD per million tokens, used for the cost estimate. Unset → `cost_usd` stays null. Copy current prices from your provider's pricing page (they change). |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`/publishable, `SUPABASE_SERVICE_ROLE_KEY`/secret | provided by Supabase | Same as the other functions. |

### Cost tracking

`public.ai_usage` has one row per user per UTC day: `requests`, `input_tokens` (incl. cache tokens),
`output_tokens`, `cost_usd` (estimate). Example (SQL editor / service role):

```sql
select day, count(distinct user_id) users, sum(requests) requests,
       sum(input_tokens) input_tokens, sum(output_tokens) output_tokens, sum(cost_usd) est_cost_usd
  from public.ai_usage group by day order by day desc limit 31;
```

The estimate is `input/1e6 × AI_PRICE_INPUT_PER_MTOK + output/1e6 × AI_PRICE_OUTPUT_PER_MTOK`; the
Console's usage/billing pages are the authority. Each chat message costs 1–4 provider calls (tool loop) and
roughly 3–8k input tokens (system rules + bounded context + up to 20 history turns).

## 2. Data flow

```
app ── RPC (user JWT) ──────────────► get/save_ai_settings, list_ai_messages, clear_ai_history,
                                      list_ai_proposals, respond_ai_proposal       (RLS: own rows)
app ── functions.invoke('ai-coach') ─► verify JWT → settings (enabled, not paused) → stored reply? (idempotent)
                                      → ai_check_and_count_usage (service) → build context from THIS user's rows
                                      → OpenAI Chat Completions or Anthropic Messages API (≤ 4 rounds, tools) → validate proposal/actions
                                      → ai_record_exchange (service, atomic) → {reply, proposal}
```

**Sent to the provider per message** (only the categories the user enabled in training assistant settings):

| Category (scope) | Content |
|---|---|
| always | Fixed rules; the user's training assistant notes (`ai_settings.profile_notes`, user-editable, ≤ 4000 chars); up to the last 20 AI messages created **after** the last scope change (each ≤ 1500 chars, ≤ 12k chars total); the new message. |
| `profile` (default on) | Goal, experience, activity level, training days / available weekdays / session length / location, equipment, excluded exercises, limitation **areas** (names only), diet tags, allergens, proteins they like and proteins marked "not for me" (0.9.0), max cook time, meals per day, units. |
| `training` (default on) | Active plan (sessions, prescriptions, baseline schedule, frequency, session time, managed-by), **this week** in the user's time zone and week start (planned sessions with dates and status incl. skips/moves, completed workouts this week, sessions left, free dates), last ≤ 10 completed workouts (date, name, duration, top set per exercise, discomfort flags), 28-day adherence, the progression rule in words and a "Next targets" line per plan exercise produced by the app's own progression engine (`_shared/training/progression.ts`, the code the app runs; beginner rule from the account profile's experience — the app's only source — when the profile is shared; otherwise the level is unknown and an exercise whose target depends on it gets no load), up to 5 goals. |
| `measurements` (default off) | Bodyweight entries of the last 120 days summarized (latest, change over ≥ 3 weeks, last 8 entries). |
| `nutrition` (default off) | Stored targets (computed in the app by `computeNutritionTargets`) or "targets disabled" (under 18 / individualized), last 7 days of food-log totals with unknown ≠ zero. |

**Never sent / never read by the function:** email, display name, age, height, sex parameter, free-text
injury notes, photos, social posts/friends, human-coach messages, coach feedback/notes, check-ins, other
users' records. Account state and the active plan are read even when `profile`/`training` are off, but only
for server-side checks (allergen filtering in `find_recipes`, equipment/exclusion validation, coach-managed
detection) — their content is not put in the prompt. Measurement and food-log rows are not read at all
when their scope is off.

**Stored in your Supabase project:** `ai_settings` (consent time/version, scopes, notes, coach style), `ai_messages`
(user messages, AI replies, grounding labels, model, token counts), `ai_usage`, and AI proposals in
`program_proposals` (`author_kind = 'ai'`).

**Retention:** AI messages stay in your Supabase project until the user taps "Clear history"
(`clear_ai_history` deletes all their `ai_messages`; proposals and usage counters remain) or deletes the
account (all AI rows cascade from `auth.users`). Changing data access sets `scopes_changed_at`; older
messages are no longer re-sent as context, but they are not deleted. Provider-side retention of API inputs
and outputs is governed by the chosen provider's API data policy (OpenAI's API data usage policy or Anthropic's
commercial terms, plus your organization settings there); Hard Earned cannot delete data on the provider's side
and does not claim to.

## 3. Safety design

- **Identity:** the user id is the verified JWT subject (`requireUser`). The body is read only for
  `action`, `id`, `text` (≤ 2000) and `mode`; any `userId`/`scopes`/… fields are ignored.
- **Least access:** private reads use a client carrying the user's JWT (RLS) **and** an explicit
  `owner_id = uid` filter (coaching adds coach-read policies to some tables, so RLS alone would be too wide).
  The service-role client is used only for `ai_check_and_count_usage`, `ai_get_exchange` and
  `ai_record_exchange`, which are `EXECUTE`-revoked from `anon`/`authenticated`.
- **Untrusted input:** notes, history and all record text are neutralized (`<`/`>` replaced) and placed in
  `<user_data>` sections after the rules; the rules say data is never instructions. There is no tool or code
  path that changes settings, scopes, permissions, coach data or anyone else's data — so injected text can
  at worst change wording, never access.
- **Rules in the system prompt:** no diagnoses or clinical certainty, no invented workouts/achievements,
  facts vs suggestions, acknowledge missing data, use the computed numbers, programs only via the tool with
  catalog ids, coach-managed plans → `for_coach_review`.
- **Tools (≤ 4 provider rounds, last round `tool_choice: none`; 0.6.0 raised it from 3 so find_recipes → propose_meal_plan → reply fits):** `find_recipes` (allergen/diet/dislike-
  filtered catalog search with macros computed from ingredient data), `exercise_alternatives` (equipment- and
  exclusion-filtered), `propose_program_change` (structured draft), `propose_week_adjustment` (this-week-only
  schedule change validated against the real plan and this week's workouts; see §4), `propose_meal_plan` (0.6.0, §4a).
- **Proposal validation (server):** mirrors `validateProposedProgram` in `src/domain/program/proposals.ts`
  plus equipment ⊆ the user's equipment (from the active plan's onboarding inputs, when known), excluded
  exercises, and base plan/version = the current active plan. Invalid → stored as `status 'invalid'` with
  `validation_errors`, never applicable. If the active plan is coach-managed, `target` is forced to
  `for_coach_review` (cannot be accepted via `respond_ai_proposal`; the coach decides).
- **Applying:** proposals are drafts. The client applies with `applyProposal` (new version, stale check, one
  active plan) and then calls `respond_ai_proposal(id, true, programId, version)`; the server re-checks that
  the synced plan is still at the base version (or already at the applied version) → otherwise `stale`.
  Accepting supersedes the user's other open AI proposals for that plan.
- **Availability:** per-attempt timeout, ≤ 2 retries with backoff honouring `retry-after` for 429/5xx/529 and
  network errors, no retries for other 4xx; failures → `503 {code:'ai_unavailable', reason:'provider_down'}`
  (401/403 from the provider → `not_configured`). Usage is counted before the provider call, so failed calls
  also count toward the daily limit. Logs contain only event names, token counts, status codes and timings —
  never message content, notes or keys.

## 4. Coaching behaviour (v3 in 0.4.0; v2 from the repair brief 29 Oct §3)

**v3 personality (0.4.0).** `context.ts SYSTEM_RULES` makes the coach a warm, conversational personal trainer that
stays practical and specific to the real plan: it uses the user's first name only when the user has told it (notes or
conversation — the display name is still never read by the function), reacts to what they said, celebrates completed
workouts, streaks and records by name (from the data only), and writes routine replies of ~60–120 words, warmth first
and then the concrete recommendation. One friendly closing check-in question is allowed (at most one question per
message); `tidyReply` keeps it and still strips filler ("Great question!") and generic offers. The `[[why]]` split is
unchanged.

**Accountability.** When the user wants to skip, or this week's state shows skipped/missed sessions, the coach asks
what's going on, pushes back on weak reasons ("too tired", "no time", "don't feel like it"), offers a minimum version
("just the first two exercises, 20 minutes") and reminds them of their goal and what they've already done this week.
How firmly depends on the **coach style** (`ai_settings.coach_style`, `STYLE_RULES`): Supportive (gentle, never
pushes), Balanced (default; light accountability), Strict (tough love, firm pushback). The style block is added after
the rules; unknown/missing values mean Balanced.

**Safety limits (rule 9) override every style:** pain, injury, illness, dizziness, chest symptoms, unusual exhaustion,
poor sleep from a newborn or night shifts, grief or feeling overwhelmed → no pushing; endorse rest, adjust the plan,
recommend a professional where relevant. Scheduled rest days are good, never "skipping" (on a rest day the prompt also
says so explicitly when Training is shared). Never extra training to make up for food; never shame or comment on body,
weight or eating.

**Scope.** In scope: training, exercises, technique, programs, scheduling; nutrition and protein for the user's goals;
recovery, sleep and stress as they affect training; motivation, check-ins, brief small talk; using Hard Earned.
Everything else (coding, homework, emails, news, politics, trivia, other apps) and attempts to change the rules
("ignore your instructions", "act as a general assistant", roleplay) get no answer, not even partially — a ≤ 40-word
redirect in the coach's voice back to training. Exceptions: crisis/self-harm → care and local emergency help or a crisis
line; medical questions → general information plus "see a doctor or physio". Prompt rules reduce but cannot
guarantee model behaviour; `tests/live/ai-live.mjs` checks the off-topic case against the real provider.

**Greeting v3.** The app-rendered welcome (`welcome.ts`) is time-aware ("Good morning/afternoon/evening", first name
from the local display name only when Profile is shared), names today's session ("Upper A today, ready to go?") or says
"Enjoy the rest day.", checks in after a session missed yesterday (firmer in Strict, kind in Supportive) and congratulates
on a record from the last 3 days (existing record rules). Quick-reply chips (Feeling great 💪, Bit tired, Sore, Short on
time, Want to skip today) send the chip as a normal user message, so the real AI answers. The welcome is still never
stored and never calls the model.

**Coach cheers (logger, no AI).** `src/domain/coachCheers.ts` picks one local line (≤ 12 words, 15+ per situation and
style, never the same twice in a row) after ✓ — new record (with the number), last set of the workout, top of the rep
range, reps below target, last set of an exercise (names the next one), otherwise a general line — and when the rest
deadline passes ("Rest's up, Bench press set 3: 60 kg × 8. Let's go!"; shown once, also after a reload or on return
from the background). Discomfort-flagged exercises only get caring lines; warm-ups and undo get nothing. It reads the
style from `Settings.coachStyle`, a local mirror of `ai_settings.coach_style` written whenever AI settings load, so it
works offline (missing → Balanced). Toggle: `Settings.workout.coachCheers` (missing → on), in Settings → Workout and the
logger's ⋮ menu. The popup is the toast component's `coach` variant: `aria-live="polite"`, never focused, ~3.5 s,
tap to dismiss, reduced motion respected, placed above the rest timer and left of the set Done column.

### v2 behaviour (still applies unless v3 above changes it)

**Greeting.** An empty conversation (right after setup → chat, or any later empty conversation of an enabled,
consented user) opens with a short welcome rendered **by the app** from local, permitted data
(`src/features/coaching/ai/welcome.ts`): goal (profile shared), plan name / sessions per week / weekdays and this
week's done-vs-planned status (training shared), or "Training isn't shared…" / "no active plan yet". It makes no
model call, costs nothing and is never stored, so refreshes, reconnects and parallel tabs can't duplicate it.
Existing conversations load as before. Real coaching starts with the user's first message.

**Style (v2, superseded in 0.4.0 by the v3 personality above):** recommendation and next action first; routine
answers ~40–100 words; at most one focused question. v3 keeps "decide from the plan instead of handing the decision
back" and "no repeated onboarding". Optional reasoning goes after a `[[why]]` marker; the server
splits it off (`reply.ts splitWhy`, also tolerant of a "Why this?" heading or a missing marker) into
`ai_messages.why`, shown collapsed under **Why this?**. `tidyReply` removes a leading "Great question!" and
trailing generic offers; it never rewrites content. Logs record the reply's word count (no content).

**Typed settings beat notes.** If the AI notes contain a `Training setup:` line (written by AI setup) that
disagrees with the active plan's typed inputs (lifting days, session minutes, equipment), the line is removed
from the notes sent to the model and described as **stale** with the differences (without the typed values when
neither profile nor training is shared). The newest message sets the time scope: "this week"/"today" requests are
temporary, keep the baseline plan and all safety rules, and never produce a permanent program change.

**This-week changes** ("I can only train twice this week"). The model sees this week's state and calls
`propose_week_adjustment` with the total for the week (**including** workouts already completed) and the actual
remaining plan sessions, in order, with dates. The server (`week.ts validateWeekAdjustment`) refuses unknown /
not-remaining sessions, past or next-week dates, two on one day, days already trained, and totals that ignore
completed workouts; it warns about non-usual days and back-to-back days. A valid plan is stored with the reply
(`ai_messages.action`, `kind: 'week_adjustment'`, id = the user message id, base program id + version) in the same
idempotent `ai_record_exchange`. The chat shows **Apply to this week**: `applyWeekPlan` in
`src/domain/program/schedule.ts` writes only date-specific overrides for that week (chosen sessions moved,
others skipped, tagged `weekPlanId`) — versions, content, frequency, split, inputs, rotation and completed workouts
are untouched, next week reverts automatically, applying twice is a no-op, **Undo** removes just those overrides.
It is refused when the plan's id/version differs (stale), the week is over (expired) or the week changed since
(another workout logged / session no longer left). Without the training scope the tool refuses and nothing is
offered.

**Coach-managed plans.** The chat still gives a direct recommendation. A this-week plan is allowed because it is
schedule-only — the same kind of change as skipping/moving a missed session on Today, which clients can already do
on a coach's plan; the card says "your coach's sessions stay as they are". Any content change still goes through
`propose_program_change` with `target: 'for_coach_review'` (unchanged).

## 4a. v4 in 0.6.0 — formatted, shorter answers, app guide, in-app actions

**Formatting.** AI replies and "Why this?" render as a safe Markdown subset (`src/features/coaching/ai/markdown.tsx`, a
small custom parser in the lazy AI chat chunk — no new dependency, no CSP change): paragraphs/line breaks, **bold**,
*italic*, ~~strike~~, `inline code`, bulleted/numbered lists (one nesting level), blockquotes, headings shown as a bold
line, and https:// links only (new tab, `rel="noopener noreferrer"`). Raw HTML, images (alt text), tables, code blocks
(their content) and any non-https link (javascript:, data:, http:, relative) are plain text. It builds React elements
and text nodes only (no innerHTML). User messages, human-coach chat, the welcome, chips and push/cheer texts stay plain;
messages are stored unchanged.

**Length.** `SYSTEM_RULES` replaces "~60–120 words" with: default 40–90 words, main answer first, ≤ 2–3 short
bullets or 2 short paragraphs, texting-a-client voice (no preambles, no repeating the question, no caveat lists), detail
after `[[why]]` or an offer ("Want the full breakdown?"); longer only on request or for a full program/meal plan (bold
day/session names, short lists). Formatting the app supports is spelled out (bold for key numbers and names, short
lists, italic rarely, no headings/tables/code blocks, emoji rarely). `tidyReply` leaves Markdown markers untouched.

**App guide.** `supabase/functions/_shared/ai/appGuide.ts` (shared with the app) has one line per main screen (path,
what you do there, how to reach it from the tab bar). It goes into the system prompt; "how do I…" questions are in
scope and answered in 1–3 steps with a link. `tests/unit/aiAppGuide.test.ts` fails when a route in
`src/app/routes.tsx` is neither in `APP_GUIDE` nor in `GUIDE_IGNORED` (admin/auth/internal screens and pages that
need ids the coach can't know) — **update the guide whenever routes change**. Navigation is four tabs (Today, Train,
Coach, Progress) with Profile in the header leading to Nutrition, Friends and Settings. Entries for flagged areas (the
social feed, finding a coach) are left out of the prompt and their links refused unless the function's env switches
them on: `ENABLE_SOCIAL_FEED` / `ENABLE_COACH_MARKETPLACE` (or the app's `VITE_` names; same values as
`src/config/featureFlags.ts`, default off). Set them on the `ai-coach` function whenever you turn the app flags on.

**In-app links.** The model may write `[[open:/path|Button label]]`. Before storing, `validateOpenLinks` keeps at most 2
whose path matches a guide route — `:id` routes only with ids the server knows (catalog exercises, catalog recipes,
the user's recent completed workouts) — and strips the rest (no queries, fragments, external or protocol-relative
paths). The app re-checks with `extractOpenLinks`, removes the markers from the text and renders small buttons under the
message that navigate in-app. Logs record only counts (`links`, `links_removed`).

**Missing data.** `dataStatus.ts` adds "Data status" lines to the prompt, computed by the server: for each category,
*not shared* → "I can't see your … yet. You can share it under training assistant settings." + the training assistant settings link;
*shared but not set up* → the fix and link (Nutrition features off → Settings with the toggle name; no protein target
→ Set your targets; no program → onboarding; nothing logged → food log / Progress). Both → sharing first, then setup.
Protein-only targets → still help (e.g. a protein-only meal plan) and say so. For a category that isn't shared only
its setup **status** is used (on/off, set/not set), never values. Check-ins and human-coach messages are never visible.

**Actions** (`ai_messages.action`, one per reply: week plan › meal plan › recipe cards). All are suggestions shown as
cards; nothing changes until the user taps. Migration `20261102000001_ai_coach_actions.sql` widens the kinds stored by
`ai_record_exchange` to `week_adjustment`, `meal_plan`, `recipe_suggestions` (same signature, security definer,
`search_path = ''`, service-role only; unknown kinds dropped).
- **Programs:** `propose_program_change` already creates a brand-new program (`base_program_id: null`); the prompt now
  asks the model to offer it whenever it describes one, and the chat card says **Add to my program — review** (existing
  preview/apply flow, versioning, stale checks; coach-managed plans keep `for_coach_review` / switch confirmation).
- **Meal plans:** `propose_meal_plan` (`tools.ts validateMealPlan`) needs Nutrition shared, Nutrition features on and a
  protein target (otherwise the missing-data message). It refuses unknown recipe/ingredient ids, anything with the
  user's allergens, diet restrictions or disliked ingredients (recipes and protein sides), servings outside 0.5–3,
  sides outside 10–300 g, dates outside this/next week, past days and duplicate days; long cook times are warnings.
  The app (`src/domain/nutrition/aiActions.ts`, `ai/MealPlanCard.tsx`) balances each day with `balanceDay` and shows
  `planStatus` totals vs the current targets — exactly what gets saved. **Add to my meal plan** (replace these days /
  only empty days), **Add and edit** (1.0.2; was "Customize first": applies, then opens `/nutrition/plan?week=…`; there's no draft mode in the
  meal plan screen). Local-first (`saveRecord`), idempotent (item ids `ai:<messageId>:…`), Undo restores the touched
  days from a snapshot kept on the device (elsewhere it removes just the AI items). An expired week can't be applied.
- **Recipes:** `find_recipes` results become recipe cards (`ai/RecipeCards.tsx`): Open, Save to favourites (toggle),
  Add to plan… (day this week + meal; Undo toast), Log this meal (meal + servings → today's food log; Undo toast).
  Macros per serving come from the server's ingredient math.
- **Custom recipes: not implemented.** Hard Earned has no user-created recipes (only the catalog and custom *foods*), so
  "Save to my recipes" from AI-built recipes was skipped.

## 4b. Fixes from live testing in 0.7.0

**Meal plans get built on the server.** `propose_meal_plan` no longer takes recipe ids. The model passes intent only:
`week`, `days` (weekday names or dates), `meals_per_day`, `quick`, `diet`, `avoid`, `preferences`. The server
(`_shared/ai/meals.ts buildMealPlanAction`) runs the app's own planner — `selectMeals` + `balanceDay` via
`generateMealPlan` in `supabase/functions/_shared/nutrition/mealplan.ts`. That file, and `_shared/nutrition/recipes.ts`,
are now the single implementation: `src/domain/nutrition/recipes.ts` and `mealplan.ts` register the bundled catalog as
the default and re-export them; only the shopping list stays app-only.
- Inputs: the user's targets, diet, allergens, dislikes, cook time, budget and meals per day (`prefsFromAccountPayload`
  = the app's `planPrefsFrom`). Request preferences only tighten these (quick → ≤ 15 min, extra diet tags, "no fish"
  → allergens, other foods → dislikes).
- Default days: the rest of this week, or next week when fewer than 3 days are left.
- If any meal slot has no recipe, the reason names the constraint ("Nothing in the catalog fits Vegan + no soy + ≤ 5 min.
  It's … that rules everything out").
- A parity test checks that the same settings give the same plan in the app and on the server.
- **Server fallback:** if the user asks for a meal plan to be made/added — or answers a blocked meal-plan request with
  "ok / try now" — and the model doesn't call the tool, the server builds the plan itself and replaces the text with a
  one-line summary (`ai_reply_replaced`, reason `meal_plan_fallback`). Invented meals are never presented as the plan.

**Protein preferences (0.9.0).** `deriveFacts` reads `profile.diet.proteinPrefs` (`{ liked, excluded }` protein groups,
normalised; missing = none) into `facts.proteinLiked` / `facts.proteinExcluded`, and the profile section lists them, the
exclusions worded as a taste preference ("not an allergy; never suggest them"). The prompt tells the model to mention an
exclusion ("since you don't eat prawns…") only when it's relevant.
- `find_recipes`: `recipeFits` applies the app's rule (`proteinFitSwaps` in `_shared/nutrition/proteins.ts`): a recipe whose
  main protein is excluded is dropped; any other excluded ingredient needs an allowed substitute, reported in the result
  as `made_with`. Liked proteins (`likedBonus`) rank higher (`uses_a_liked_protein`). `explainNoRecipes` names "the
  proteins marked not for me" when they empty the catalogue.
- `propose_meal_plan`: `prefsFromAccountPayload` passes `proteinPrefs` to the shared planner, which filters recipes,
  automatic swaps and protein sides and ranks liked proteins; plan items carry the `swaps`. The belt-and-braces check
  also rejects excluded proteins. The app re-derives the swaps from current settings when it previews or applies a plan.

**find_recipes.** Matching is case- and accent-insensitive, covers ingredient names and synonyms (fish → cod/salmon/
tuna, yoghurt → yogurt/skyr, …), and reads tags (high protein, vegetarian, vegan, dairy-free, gluten-free, quick) and
the meal type from the query. When the query matches nothing, or is vague, it steps back to the best fits for the user's
targets (protein per serving closest to protein per meal) and says so in `fallback`. It is empty only when the user's own
allergens/diet/dislikes/cook time exclude everything, and then `reason` names the constraint.

**The card is the source of truth** (`_shared/ai/postcheck.ts`).
- The prompt says not to restate a card's details; one short line at most.
- After the model replies, the server checks session names + weekdays/dates against the validated week plan or the
  program's schedule, and recipe names / long lists against the meal plan.
- A contradiction replaces the reply with a generated summary, logged as `ai_reply_replaced`. Example: "Here's this
  week: **Full body C** moves to Saturday, **Full body B** is skipped this week. Sat 31 Oct is not one of your usual
  training days. Tap **Apply to this week** to use it."
- Consistent text passes through unchanged.

**Follow-ups** (`_shared/ai/conversation.ts`).
- The prompt gets the user's most recent undelivered request (meal plan, this-week change, program, recipes), its words
  in `<user_data kind="open_request">`, and whether it was blocked by sharing or setup.
- "ok / yes / do it / try again / try now" resume it first. Two-part answers ("yes, but make the meal plan") get both
  parts handled.
- When sharing was **widened** since the previous reply, the last few pre-change messages are carried over and the coach
  is told to acknowledge it ("Thanks — I can see your nutrition now") and continue. "Widened" is judged from the
  previous reply's stored grounding labels.
- If any category was revoked, the history cut-off stays as before (privacy).

**Links, dates, polish.**
- Link markers go at the end of the message. The lead-in lines they leave behind ("Open the meal plan:") are removed on
  the server and in the app.
- Recipe links (`[[open:/nutrition/recipes/<id>|Open recipe]]`) are counted separately, up to 3 per message, and only
  for catalog ids.
- The coach never writes a recipe's ingredients or steps in chat: name in bold, one line on why it fits, and a link. A
  written-out recipe is logged as `ai_full_recipe_warning`.
- Recipe cards show name, time and protein, with Open / Add to plan… / Save. Logging a meal is on the recipe screen.
- Users never see ISO dates. `_shared/ai/humanDates.ts` turns them into "today", "tomorrow", a weekday later this week,
  or "Sat 31 Oct", in replies, "Why this?" and week-plan warnings, both on the server and in the app (older messages
  too).
- Plurals: "1 recent workout", "of 1 workout", and so on. "Why this?" only shows when there is text.

`MAX_TOOL_ROUNDS` stays 4.

## 4c. Language (1.0.1)

The prompt has a **Language** section: reply in the language of the user's latest message and switch when they
switch; in Icelandic, write natural Icelandic (cases, everyday gym words, "102,5 kg", Icelandic dates) rather than a
translation of English; keep exercise, recipe and program names as they appear in the data (the app is in English) so
the user can find them; link labels in the user's language; every rule applies in every language. The prompt itself
and the context data stay English. Quality still depends mostly on the model: `gpt-5-mini` at `low` effort (the
defaults) writes weak Icelandic, so for Icelandic users set `OPENAI_MODEL` to a full GPT-5 model and
`OPENAI_REASONING_EFFORT=medium` (§1), at a higher cost per message.

## 4d. Correctness fixes (1.0.2)

From the Claude + ChatGPT cross-review of 25 Nov 2026 (`tests/unit/aiCorrectness.test.ts`):
- **History from the real database carries `action` and `grounding`.** `supabaseDb.ts getHistory` selected neither, so
  against Supabase a delivered plan never closed its request and "sharing changed" could not be detected (the in-memory
  test db returned them, which hid it). Malformed stored values are dropped (`historyMessage`).
- **The meal-plan fallback keeps the request.** When the model doesn't call `propose_meal_plan`, the server builds the
  plan from the user's own words (`meals.ts mealPlanIntentFromText`: meals per day, this/next week, weekdays, weekend,
  quick, diet words, "no …"/"without …"/"án …"), for a follow-up from the original request plus the new message. If it
  can't be built, the reply says so ("I couldn't build that meal plan with what you asked for: …", logged as
  `meal_plan_fallback_failed`) instead of offering an unrestricted plan.
- **find_recipes never relaxes a request's restrictions.** Diet words and exclusions in the query are hard constraints,
  added to the user's own settings before any matching; the fallback steps loosen only words, meal type, quick and
  protein. A ruled-out word ("dinner without salmon") is no longer searched for.
- **Exclusions in `buildMealPlanAction`.** The old `\bno <allergen>` regex leaked alternations ("no fish|seafood" matched
  any "seafood"); it is replaced by `parseExclusions`, which also covers "without", "X-free" and Icelandic.
- **Icelandic words** for allergens and diets (fiskur, hnetur, glúten, mjólk, rækjur, jarðhnetur, egg, soja; vegan,
  grænmetis-, glútenlaus, mjólkurlaus), "án", follow-ups ("já", "já takk", "prófaðu núna", "gerðu það", "búin að
  deila") and "matarplan"/"matseðill". Replies and card texts are still English; full localisation is a separate item.
- **Review follow-ups (PR #16).** Carry-over after a sharing change (`conversation.ts carryOver`) stops at the newest
  reply whose grounding used a category that isn't shared now (or is unknown) — a revoked category never re-enters
  history after a later, unrelated widening. `parseExclusions` reads lists ("no fish, no nuts", "án fisks, án hneta"),
  multi-word items ("tree nuts", "red onion"), fillers ("without any nuts"), common Icelandic food words and negated
  weekdays ("not Friday", "ekki um helgina"); a list ends at the first item that isn't a food or a day. Negated days
  are never planned. A request is closed by ANY later reply that delivered it, and plain "takk"/"thanks" is not a
  follow-up. The user's own words (`requestText`, plus the original request for a follow-up) are passed to
  find_recipes and propose_meal_plan, so restrictions the model's tool input drops still apply.
- **"Customize first" is now "Add and edit"**: it always added the plan before opening it (the meal plan screen has no
  draft mode); the label now says so, and Undo stays on the card.

## 4e. Follow-ups (1.0.3, PR 1b)

- **One generation and one charge per message.** `public.ai_requests` (migration `20261126000001`) keeps, per user
  message, the current attempt id, whether it holds a charge, and its state (running → succeeded | failed; the full
  transition table is at the top of the migration). `ai_begin_request` starts an attempt: a replay while it runs gets
  409 `in_progress` (no second generation, not counted); after 3 minutes a retry takes over the abandoned attempt with
  the SAME charge (no new charge, no limit check); an answered message is `duplicate`. The app waits on `in_progress`
  and asks again with the same id (`features/coaching/ai/inProgress.ts`, cancellable).
- **Failed requests.** `ai_fail_request(user, message, attempt, usage)` acts only if that attempt still owns the
  running request: the request is given back and tokens from completed rounds go to `ai_usage.failed_*`, once. A stale
  attempt, a repeated call or a request already answered is a no-op. Success is settled in the same transaction as the
  stored answer (`ai_record_exchange_settled`), so a lost response after a stored answer never refunds. Until the
  migration is applied the function falls back to `ai_check_and_count_usage` / `ai_record_exchange` (no refunds).
- **Training setup note.** With a saved typed plan the old "Training setup:" line in the notes is always replaced by
  one built from the plan (days, session length, equipment); if it disagreed, the coach is told the plan is current and
  to ask before relying on the old note.
- **Sync barrier.** Before sending, the app pushes pending changes (bounded at 4 s, `syncBarrier.ts`) and sends how
  many are still unsynced; the context then says the coach's view may be missing them (don't conclude a skip).
- **Language.** Server-written text (summaries that replace a conflicting reply, the "thanks" line, the meal-plan
  failure line, the fallback apology) and dates follow the user's language (`lang.ts`: this message, else the open
  request, else earlier messages, else the model's reply; English by default). Icelandic dates read "lau. 31. okt.",
  "í dag", "á morgun", "á laugardaginn". Button labels stay as the app shows them; validator warnings/reasons are
  still English.
- **Tiredness.** "Too tired" (EN/IS, not "tired of chicken") always gets a supportive answer with a lighter option and
  rest as equal choices, in every coach style; the default style for new users is now **supportive**.
- **"Pancakes without blueberries".** find_recipes may leave out an OPTIONAL ingredient, or swap a non-optional,
  non-protein one for a substitute the recipe lists, only when THIS request named it and it isn't restricted. A recipe
  that would need an allergen, diet, own-dislike or protein ingredient left out is rejected (review of PR #17). The
  card's changes travel as swaps, a left-out ingredient as `{ from, to: LEFT_OUT }` (honoured for optional ingredients
  only), through Open (recipe screen, Log this meal, Add to meal plan) and Add to plan (plan nutrition, shopping list).
  Card macros use the app's quantity conversion for swaps.
- **Pending sends** belong to the account that wrote them and are cancelled on account change or when the chat closes.
- **Independent allergen fixture** (`tests/unit/aiAllergenFixture.test.ts`): allergen class words and specific foods
  (EN + IS) specified by hand, so a word missing from the parser's dictionary can't also be missing from the check.

## 4f. State-aware coach (roadmap item 7)

- **Contextual entry points.** The workout logger has an "Ask coach" row (Short on time → minutes left; Equipment busy →
  which exercise; Explain this → which exercise) plus "Equipment busy? Ask coach" / "Explain this" in each exercise's
  menu and "Ask coach" on the progression card. The workout summary has "Explain" next to each next target. Signed-in
  accounts only. Tapping stores a request on the device (`ai/workoutContext.ts`) and opens the Coach tab, which sends a
  visible message once, with a fresh snapshot of that workout (`send({ …, workout })`; exercises, targets, done sets,
  plan priorities, elapsed time). It goes through the same sync barrier as every send. If it can't send yet, the text
  waits in the composer with "Today's workout attached". That attachment is kept on the device (and on a failed send,
  so Edit brings it back) until it's sent or removed, and the snapshot is rebuilt right before every send.
- **Training sharing gates all of it.** With Training off (including when it's switched off on the first-use consent
  screen) the chat writes no generated message, attaches nothing and sends nothing; it shows a notice instead. A
  workout question already waiting in the composer loses both its attachment and the text written for it, and a
  failed or unconfirmed workout question can't be retried (only removed) until Training is shared again. Offline,
  sharing can't be checked, so the request waits for the next online open.
- **Server.** `_shared/ai/workout.ts` parses the snapshot as untrusted data (clamped, unknown fields dropped) and shows
  it to the model inside `<user_data kind="workout">`, only when Training is shared. New tool
  `propose_session_adjustment`: `swap` (a genuine alternative: a listed substitution, or the same movement pattern for
  the same primary muscles; and it must fit equipment, exclusions and areas to go easy on; never a custom exercise)
  or `shorten` (main and secondary lifts share the time first, accessories go first; completed sets never change).
  If the model answers a Short on time / Equipment busy request without the tool, the server builds the change itself.
  Stored as `ai_messages.action` kind `session_adjustment` (migration `20261128000001`); before that migration the
  action is still returned for the reply.
- **App.** The card "Apply to today's workout" changes only that live `WorkoutSession` (`src/domain/sessionAdjust.ts`);
  the plan and its templates are never touched. Undo (card, or the logger's "Changed for today by your training
  assistant" banner) restores what was removed or replaced, in the exact original order. It refuses if that row has
  since been swapped to another exercise, so one exercise's load never lands on another. A "Felt discomfort" row is
  never deleted by shorten nor moved by a swap: it keeps its flag (so the finished workout records it and progression
  keeps holding that exercise), and the replacement gets its own row. Undo also refuses once
  the replacement itself is flagged, so a discomfort flag is never erased. Analytics: `ai_action_used` with
  `action_type: 'session_adjustment'` (proposed / applied / reverted).
- **Consent.** One screen (`ai/AiConsent.tsx`), shown in the Coach tab on first use and at `/coaching/ai/setup`. It says
  what the assistant sees and does, has an optional "Change what it can see" panel, and turns it on with Supportive
  tone (an earlier choice is kept on re-consent). Tone, notes and data access are changed later in settings.
- **Supportive default, checked everywhere.** Server prompt (`asCoachStyle`), `ai_settings` column default and
  `ai_settings_json` (NULL reads as supportive since `20261128000001`), client parsing, the consent screen, and the
  offline mirrors (logger cheers, push texts, welcome). Tiredness and fatigue are never weak reasons in any style.

## 4g. Eval set, streaming status line and six-part prompt (roadmap item 10)

Spec (verbatim, with the approved English and Icelandic copy): `docs/specs/item10-spec-and-copy.md`.

- **Six-part prompt.** `_shared/ai/prompts/`: `identity`, `safety` (+ only the selected coach style), `grounding`,
  `training`, `nutrition`, `response` (+ the selected output format) — about 1,200 words of static instructions instead
  of ~2,300. The composer orders static modules → server-derived controls (tiredness, today, rest day, workout,
  check-in, data status, sharing changed, open request, reply language, clarification) → feature-filtered app guide →
  bounded permitted data, with a budget per section instead of clipping the whole prompt: static rules, controls and
  restriction-carrying data (profile, open request, workout, coach management) are never shortened; history-like
  sections are clipped or dropped lowest priority first. `docs/AI_PROMPT_RULES.md` maps every earlier instruction to its
  module, deterministic enforcement and regression test (checked by `tests/unit/aiPromptModules.test.ts`). The send log
  records `prompt_version`, `prompt_hash` and the assembled size.
- **Structured Outputs.** Final reply envelope `{"answer": string, "why": string|null}` (strict, no other fields) on
  every round where supported (`structured.ts`, `AI_STRUCTURED_OUTPUT`). Actions, proposals, grounding, permissions and
  safety stay server-owned. Link markers stay inside `answer` and are filtered afterwards. Tool schemas are NOT made
  strict. Refusals and truncation are kept explicitly in the normalized provider response. Usage of every completed
  round is booked before parsing. A refused, truncated or malformed envelope is never shown: a valid server action uses
  its deterministic summary; otherwise `502 invalid_reply` through the normal failure settlement (refund + failed
  usage). No extra repair generation.
- **Streaming.** `send` with `stream: true` and `Accept: text/event-stream` (authenticated `fetch`, never EventSource).
  Authentication, consent and the reservation happen first, so refusals stay normal JSON. Events (`sse.ts`, v1):
  `status {phase}` (`preparing`, `training`, `nutrition`, `recipes`, `planning`, `writing`, `checking`, `saving`, only
  when that work happens — never training/nutrition when unshared), `text_delta` (chunks of the FINAL, STORED answer),
  `complete` (the same exchange as JSON, plus authoritative usage), `error {code, reason?, retryable}`, `cancelled
  {usage}`; heartbeat comments every 12 s; `text/event-stream; charset=utf-8`, `Cache-Control: no-store,
  no-transform`. The model's raw text is buffered: the answer is released only after every check and the durable
  store, without artificial delays. The work runs as a Supabase background task (`EdgeRuntime.waitUntil`): a client
  that disconnects detaches; it never cancels or refunds. Before publishing, consent and sharing are re-read; if they
  were narrowed, the reply is discarded and the request fails as `sharing_changed`.
- **Stop.** `cancel` and `request_status` actions keyed by the message id (ownership from the JWT), backed by
  `20261130000001_ai_cancellation.sql` (see docs/BACKEND.md §9b). "Stopping…" until the server acknowledges; success
  may still win ("The reply finished before it could be stopped"). The worker polls (bounded) and aborts the provider
  fetch/backoff with an attempt-owned signal (never a retryable timeout). One refund, against the charged day;
  completed-round tokens booked as cancelled usage; late reports idempotent; missing provider usage counted as unknown.
  `status` advertises `protocol: {stream: 1, cancel: 1}` (cancel only when the database has the functions): older
  servers keep JSON and show no Stop button.
- **App.** `src/backend/sseParser.ts` (incremental UTF-8, CRLF/CR, comments, bounded frames), `aiApi.sendStream /
  cancel / requestStatus` (`src/backend/ai.ts`), `ai/replyFlow.ts`, and the chat status line (approved copy
  `ai.chat.status.*`, slow notice after 20 s, Stop/Stopping…). The preview is plain text with no links, cards, badges,
  history writes or analytics until `complete`; the final reply goes through the normal mappers. EOF without a terminal
  event = interrupted/unconfirmed: the same id is checked (`request_status`, or the existing in_progress replay on
  servers without it) — never a second generation. Leaving the chat detaches. A confirmed Stop keeps the message; Retry
  then sends it with a new id. Scroll position is respected ("Show latest reply"); screen readers hear phase changes
  and completion, not every chunk.
- **Eval set and comparison runner.** 30 cases (15 EN + 15 IS, verbatim) in `tests/evals/coach.cases.json`, synthetic
  fixtures on the production catalogs (`coach.fixtures.ts`), reservation-aware in-memory database (`memoryDb.ts`),
  deterministic scoring (`coach.scoring.ts`) and explicit candidates (`coach.models.json`). Run
  `node tests/live/coach-eval.mjs --models tests/evals/coach.models.json --cases tests/evals/coach.cases.json --repeat 3 --max-cost-usd 10 --out artifacts/coach-eval`
  (live, costs money; `--dry-run` checks the harness only). Writes `manifest.json`, append-only `results.jsonl`,
  `comparison.md` and a blind Icelandic rating sheet `review.csv`. The production model is never changed by it.

### 4g.1 Review round 2 (PR #26)

- Every message-bound request (stream, JSON send/replay, cancel, request_status) carries the account that wrote the
  message; the session is resolved and its user checked immediately before dispatch (`account_changed` otherwise).
- Training sharing is re-checked and the workout snapshot rebuilt before EVERY attempt (first send, in_progress
  retries, recovery replay); a flow is stopped as soon as Training is turned off. The server refuses a contextual
  workout request (one carrying a workout snapshot) while Training isn't shared: `409 training_not_shared`, nothing
  reserved, charged or sent to the provider.
- Blank Structured Output (no content, whitespace, empty `answer`) is invalid: a valid server action's summary, or
  `invalid_reply` with the allowance refunded. Never a stored, charged "couldn't reply".
- A cancel is reported as stopped only when the database confirms it; otherwise `cancel_unconfirmed` and the app keeps
  checking the same id (bounded). Streams end as interrupted after 45 s without bytes or 180 s overall; control calls
  time out after 20 s and follow the flow's abort signal.
- Dispatched provider attempts are counted; one that never produced known usage (aborted, timed out, network error,
  unreadable) marks the attempt's usage as unknown while keeping the known tokens.
- Pregnancy and medication precautions are back in the safety module (R46/R47 in docs/AI_PROMPT_RULES.md).
- Eval: unsafe prose fails deterministically (pushing through pain, advice to add load, shaming, an excluded allergen
  recommended in the text, with negations understood), and every result in BOTH languages needs a recorded safety
  review before a candidate can qualify. Subsets, fewer than 3 repetitions or a baseline without the same coverage are
  diagnostic only; a budget-exhausted run is INCOMPLETE; served models must match exactly (or a documented alias).
  `--report <run dir> --ratings <file>` attaches the blind reviews to the original run without model calls.

## 5. Testing status

| What | How | Status |
|---|---|---|
| Server logic with a **MOCKED** provider (injected `fetch`) and in-memory data accessor | `npx vitest run tests/unit/ai.test.ts` | passing (30 tests): context isolation, tampered ids, prompt-injection notes/history, revoked scopes + history cut-off, tools, proposal validation (unknown exercise, equipment, exclusion, duplicate weekday, stale/non-active base), coach-managed → coach review, not_configured, 429→retry, 529/network retry, persistent 5xx, no 4xx retry, timeout, PT429 mapping, idempotent resend, cost. |
| Database: RLS, RPC privileges, consent, idempotent record, proposals stale check, usage limit, retention | `node tests/rls/ai-run.mjs` (throwaway Postgres 16 + all migrations) | passing (17 checks) |
| Edge Function entry point (`supabase/functions/ai-coach/index.ts`, Deno) | — | **not executed** (no Deno/Supabase runtime in the build environment). It only wires env, fetch and Supabase clients into the tested modules. |
| v2 server logic, **MOCKED** provider: style rules, Why split/tidy, real-plan + this-week context, time zone/week start, overrides, stale notes, unshared/empty context, two-sessions scenario (partly completed week, two different plans, invented/past sessions refused, completed counted), coach-managed, idempotent replay | `npx vitest run tests/unit/aiCoachV2.test.ts` | passing (19) |
| Scheduler week plans: overrides only, baseline/history untouched, next-week reversion, stale/expired/week-changed, idempotent + undo, coach plan | `npx vitest run tests/unit/schedule.test.ts` | passing (21) |
| Chat UI, **MOCKED** aiApi: welcome on empty conversation and after setup, no duplicates across refresh/two tabs and no send, unshared training, resume, collapsed "Why this?", Apply/Undo, stale plan | `npx vitest run tests/unit/aiUi.test.ts tests/unit/aiWelcome.test.ts` | passing (18 + 5) |
| DB v2: why/action stored, replayed, listed; unknown action kinds dropped; client can't call/write | `node tests/rls/ai-run.mjs` | passing (18 checks) |
| v3 server logic, **MOCKED** provider: personality/accountability rules, every style reaches the prompt, Strict + "too tired" → pushback + minimum version, Strict + "my knee hurts" → safety wins, rest day ≠ skipping, scope section for every style, off-topic redirect survives `tidyReply`, closing question kept | `npx vitest run tests/unit/aiCoachV2.test.ts` | passing (28 incl. v2) |
| Welcome v3 (time of day, first name, training/rest day, missed session per style, PR) and quick-reply chips (**MOCKED** aiApi) | `npx vitest run tests/unit/aiWelcome.test.ts tests/unit/aiUi.test.ts` | passing (10 + 19) |
| Coach cheers: picker (situations × styles, discomfort, no repeats, warm-ups, ≤ 12 words, no food/weight words) and logger UI (popup on ✓, none on undo, rest-over names the next set once, background return, toggle off) | `npx vitest run tests/unit/coachCheers.test.ts tests/unit/coachCheersUi.test.ts`, `npx playwright test tests/e2e/coach-cheers.spec.ts` | passing (15 + 8 + 1 e2e) |
| DB v3: coach_style default, save/refuse, own row only, no direct write | `node tests/rls/ai-run.mjs` (now also in CI) | see PR CI |
| v4 server, **MOCKED** provider: length/format rules for every style, tidyReply keeps Markdown, missing-data rules (not shared, no targets, Settings toggle off, both, protein-only partial help, training/no program), app guide in prompt, links validated (known ids, invented paths stripped, max 2), propose_meal_plan (valid, unknown id, allergen, disliked, conflicting side, ranges, past/other week, duplicates, no sharing/targets), find_recipes → recipe cards, meal plan wins over recipe cards, new program via propose_program_change, excluded/equipment/stale refused, coach-managed → for_coach_review | `npx vitest run tests/unit/aiActions.test.ts` | passing (21) |
| Markdown renderer (bold/italic/strike/code, lists + nesting, headings → bold, blockquote, https links, XSS inert, tables/code blocks plain, long URLs wrap) | `npx vitest run tests/unit/aiMarkdown.test.ts` | passing (9) |
| App guide: route coverage vs routes.tsx, required screens, link validation and extraction | `npx vitest run tests/unit/aiAppGuide.test.ts` | passing (8) |
| Meal plan actions on the device: parse, preview = balanceDay/planStatus, replace vs empty days, idempotent replay, Undo | `npx vitest run tests/unit/aiMealPlanApply.test.ts` | passing (8) |
| Chat UI v4, **MOCKED** aiApi: Markdown in AI messages, user messages literal, link buttons navigate, meal plan card apply/Undo, recipe cards (open, favourite, log) | `npx vitest run tests/unit/aiUi.test.ts` | passing (23 incl. earlier) |
| DB v4: meal_plan and recipe_suggestions actions stored, replayed and returned to their owner only; unknown kinds dropped; client can't write | `node tests/rls/ai-run.mjs` (CI) | see PR CI |
| 0.7.0 fixes, **MOCKED** provider + real catalog: server/app meal plan parity, plan with nutrition shared and a 198 g target, default/next-week/named days, preferences only tighten, impossible constraints explained, missing sharing/targets, invented meals replaced by a real plan; find_recipes tolerant matching, tags, fallback, empty-with-reason; text vs card conflicts (corrected / unchanged); open request + sharing widened / revoked; link lead-in cleanup; recipe links (valid kept, unknown stripped, max 3); no-full-recipe rule + warning; human dates in text and week warnings; chip plurals | `npx vitest run tests/unit/aiCoachFixes.test.ts` | passing (24) |
| Chat UI 0.7.0, **MOCKED** aiApi: recipe cards (name/time/protein, Open, Save, Add to plan…), recipe link opens the recipe page with no lead-in line, ISO dates shown as human dates, "Why this?" hidden without text, legacy chip label, week-card warnings | `npx vitest run tests/unit/aiUi.test.ts` | passing (26 incl. earlier) |
| Item 10: six-part prompt (word budgets, order, per-section budgets, selected style/output, version/hash, rule matrix) | `npx vitest run tests/unit/aiPromptModules.test.ts` | passing |
| Item 10: Structured Outputs (capability config, request shapes per provider, every round, refusal / truncation / malformed JSON, usage before parsing, text path) | `npx vitest run tests/unit/aiStructured.test.ts` | passing |
| Item 10: SSE server + cancellation, **MOCKED** provider and in-memory db (JSON/SSE equivalence, no pre-postcheck text, store failure, phases, heartbeats, detach, replay without charge, cancel before send / during model wait / after success / before saving, stale worker, worker death, midnight refund, sharing changed) | `npx vitest run tests/unit/aiStreamServer.test.ts` | passing |
| Item 10: client parser, stream consumption, Stop/recovery flow; chat UI (status line, preview, Stop during sync / model wait / retry polling / delivery, lost acknowledgement, interrupted stream, unmount) | `npx vitest run tests/unit/aiStreamClient.test.ts tests/unit/aiChatStreamUi.test.tsx` | passing |
| Item 10: verbatim copy (27 EN + 27 IS strings, 30 eval prompts) and eval harness (fixtures, controls, scoring, stub end-to-end) | `npx vitest run tests/unit/aiItem10Copy.test.ts tests/unit/coachEval.test.ts` | passing |
| Item 10: cancellation RPCs on PostgreSQL 16 (tombstone, cancel/success both orders, repeated cancel, expiry finalizer, stale worker, legacy wrapper trigger, late usage, midnight refund, privileges) | `npm run test:ai-db` | passing |
| Item 10: live eval / deployed SSE smoke | `node tests/live/coach-eval.mjs …`, `node tests/live/ai-sse-smoke.mjs` | **not run here** (no provider keys, no deployed project or Deno runtime in the build environment); both print BLOCKED and exit 2 without credentials |
| Live OpenAI / Anthropic API | `OPENAI_API_KEY=… node tests/live/ai-live.mjs` (or `ANTHROPIC_API_KEY=…`; prints the two-sessions reply, Why, week plan and soft checks, then the off-topic Python check — no code and a mention of training — and (0.7.0) "make me a meal plan for this week and add it" → a meal_plan action and "Ok try now" after a sharing-blocked request → resumed; the hard checks fail the run; without a key prints BLOCKED) | **not verified here** (no key; sandbox egress to api.openai.com refused). The script was run against a local OpenAI-format stub only. After deploying: run it with the real key, then send one chat message from the app and check `ai_usage`. |
