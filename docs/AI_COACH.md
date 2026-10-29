# AI coach — setup, data flow, safety, testing

The AI coach is optional. With no API key configured the app works as before (tracker, deterministic
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
   "Apply to this week" are not stored, so they disappear after a reload): `supabase db push`, or paste them into
   the SQL editor in order.
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
Console's usage/billing pages are the authority. Each chat message costs 1–3 provider calls (tool loop) and
roughly 3–8k input tokens (system rules + bounded context + up to 20 history turns).

## 2. Data flow

```
app ── RPC (user JWT) ──────────────► get/save_ai_settings, list_ai_messages, clear_ai_history,
                                      list_ai_proposals, respond_ai_proposal       (RLS: own rows)
app ── functions.invoke('ai-coach') ─► verify JWT → settings (enabled, not paused) → stored reply? (idempotent)
                                      → ai_check_and_count_usage (service) → build context from THIS user's rows
                                      → OpenAI Chat Completions or Anthropic Messages API (≤ 3 rounds, tools) → validate proposal
                                      → ai_record_exchange (service, atomic) → {reply, proposal}
```

**Sent to the provider per message** (only the categories the user enabled in AI coach settings):

| Category (scope) | Content |
|---|---|
| always | Fixed rules; the user's AI coach notes (`ai_settings.profile_notes`, user-editable, ≤ 4000 chars); up to the last 20 AI messages created **after** the last scope change (each ≤ 1500 chars, ≤ 12k chars total); the new message. |
| `profile` (default on) | Goal, experience, activity level, training days / available weekdays / session length / location, equipment, excluded exercises, limitation **areas** (names only), diet tags, allergens, max cook time, meals per day, units. |
| `training` (default on) | Active plan (sessions, prescriptions, baseline schedule, frequency, session time, managed-by), **this week** in the user's time zone and week start (planned sessions with dates and status incl. skips/moves, completed workouts this week, sessions left, free dates), last ≤ 10 completed workouts (date, name, duration, top set per exercise, discomfort flags), 28-day adherence, double-progression steps computed by the app's rule, up to 5 goals. |
| `measurements` (default off) | Bodyweight entries of the last 120 days summarized (latest, change over ≥ 3 weeks, last 8 entries). |
| `nutrition` (default off) | Stored targets (computed in the app by `computeNutritionTargets`) or "targets disabled" (under 18 / individualized), last 7 days of food-log totals with unknown ≠ zero. |

**Never sent / never read by the function:** email, display name, age, height, sex parameter, free-text
injury notes, photos, social posts/friends, human-coach messages, coach feedback/notes, check-ins, other
users' records. Account state and the active plan are read even when `profile`/`training` are off, but only
for server-side checks (allergen filtering in `find_recipes`, equipment/exclusion validation, coach-managed
detection) — their content is not put in the prompt. Measurement and food-log rows are not read at all
when their scope is off.

**Stored in your Supabase project:** `ai_settings` (consent time/version, scopes, notes), `ai_messages`
(user messages, AI replies, grounding labels, model, token counts), `ai_usage`, and AI proposals in
`program_proposals` (`author_kind = 'ai'`).

**Retention:** AI messages stay in your Supabase project until the user taps "Clear history"
(`clear_ai_history` deletes all their `ai_messages`; proposals and usage counters remain) or deletes the
account (all AI rows cascade from `auth.users`). Changing data access sets `scopes_changed_at`; older
messages are no longer re-sent as context, but they are not deleted. Provider-side retention of API inputs
and outputs is governed by the chosen provider's API data policy (OpenAI's API data usage policy or Anthropic's
commercial terms, plus your organization settings there); LiftCircle cannot delete data on the provider's side
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
- **Tools (≤ 3 provider rounds, last round `tool_choice: none`):** `find_recipes` (allergen/diet/dislike-
  filtered catalog search with macros computed from ingredient data), `exercise_alternatives` (equipment- and
  exclusion-filtered), `propose_program_change` (structured draft), `propose_week_adjustment` (this-week-only
  schedule change validated against the real plan and this week's workouts; see §4).
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

## 4. Coaching behaviour (v2, repair brief 29 Oct §3)

**Greeting.** An empty conversation (right after setup → chat, or any later empty conversation of an enabled,
consented user) opens with a short welcome rendered **by the app** from local, permitted data
(`src/features/coaching/ai/welcome.ts`): goal (profile shared), plan name / sessions per week / weekdays and this
week's done-vs-planned status (training shared), or "Training isn't shared…" / "no active plan yet". It makes no
model call, costs nothing and is never stored, so refreshes, reconnects and parallel tabs can't duplicate it.
Existing conversations load as before. Real coaching starts with the user's first message.

**Style** (system rules, `context.ts SYSTEM_RULES`): recommendation and next action first; routine answers one
short paragraph or 2–4 bullets (~40–100 words), longer only on request or for a full program; no intro or repeated
onboarding; decide from the plan instead of handing the decision back; at most one focused question and only when
missing information blocks a useful/safe answer. Optional reasoning goes after a `[[why]]` marker; the server
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
| Live OpenAI / Anthropic API | `OPENAI_API_KEY=… node tests/live/ai-live.mjs` (or `ANTHROPIC_API_KEY=…`; prints the two-sessions reply, Why, week plan and soft checks; without a key prints BLOCKED) | **not verified here** (no key; sandbox egress to api.openai.com refused). The script was run against a local OpenAI-format stub only. After deploying: run it with the real key, then send one chat message from the app and check `ai_usage`. |
