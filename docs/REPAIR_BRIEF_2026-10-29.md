# Repair & audit brief (user request, 29 Oct 2026)

Work inside the existing project (do not restart or redesign). Preserve accounts, production data, existing
features, styling, routing, offline support and PWA installation. Additive migrations, focused changes, edit readable
source only. An external review (28 Oct, v0.2.0) produced the findings below: reproduce each against current code;
don't treat an untested concern as a confirmed vulnerability. Audit-checklist labels: reproduced defect,
source-confirmed concern, user requirement, passed check, blocked verification.

## 2. Explicit workout-split selection (required product change)
Today the generator forces full-body for 2 lifting days, and for 3 days when experience is new/returning;
"Show alternative" shuffles exercises without offering another split. Implement a visible split selector:
- 1 lifting session/week: full-body may be the sole structure.
- ≥2 sessions: always offer a meaningful non-full-body option. 2 days: Full-body A/B and Upper/Lower.
  3 days: Full-body and a suitable alternative (Upper/Lower/Full-body or Push/Pull/Legs). Higher frequencies: suitable
  choices, a recommended default and a short tradeoff explanation.
- Experience may change exercise difficulty, sets, volume and the recommendation, never hide every non-full-body choice.
- Distinguish lifting days from total activity days; review the endurance/supporting-strength branch so it doesn't bypass this.
- Persist an explicit split preference in the draft and program inputs; preserve it through Back/Next, review edits,
  refresh, resume, regeneration and final acceptance. Separate "Change split" from "Shuffle exercises".
- When the day count changes, show which structures fit and keep the user's intent where possible. Never use hidden
  variant parity as the source of the selected split.
- Tests: every experience level at 2 and 3 days; a fresh wizard and a restored draft with the same visible inputs produce
  the same structure.

## 3. AI coach: greet immediately, coach directly
Greeting: after activation, open the conversation and immediately show a brief personalized welcome from permitted
saved context; same when an enabled, consented user opens an existing empty conversation. An app-rendered contextual
welcome is acceptable (later coaching must use the real AI). If persisted/model-generated, make creation idempotent
(refresh, reconnect, simultaneous tabs: no duplicate messages or charges). Existing conversations resume normally. Only
known facts; never claim to have reviewed workouts that don't exist or weren't shared.
Style: lead with the recommendation and next action; routine answers a short paragraph or 2–4 bullets (~40–100 words);
expand when asked or when a complete program needs it. No long intro, no repeated onboarding, don't hand the decision
back. One focused follow-up only when missing info blocks a useful/appropriate answer; don't end every answer with a
question. Detailed reasoning behind a "Why this?" expansion or on request.
Required regression — saved 3-session plan, user says "I can only train twice this week". The AI must: (1) treat it as
this week's temporary availability; (2) check the actual current program, sessions completed this week, available days,
equipment, exclusions, limitations, session time; (3) recommend exactly which actual sessions to do, in order, with any
small adjustment; (4) count an already-completed session toward the two; (5) say the usual 3-session schedule resumes
next week; (6) offer "Apply to this week" if a schedule change can be applied; (7) not ask upper/lower/full-body when the
plan suffices. No hard-coded workouts; choose from the real plan.
Context: inspect the server ai-coach function, system instructions, context builder, structured proposals and memory
summaries (client empty-state text alone won't fix it). Resolve conflicts between active program inputs and free-text
"Training setup:" notes — prefer explicit typed current settings. Respect the newest request's time scope while keeping
safety constraints and the baseline plan. Reuse the scheduler's date-specific overrides; extend deliberately if temporary
content changes are needed. "This week only" must not rewrite baseline frequency, long-term split or completed history.
Proposals stay reviewable and version-aware; stale AI proposals can't overwrite newer programs; human-coach-managed plan
rules stay, while chat still gives a direct recommendation.
Tests: immediate greeting, duplicate prevention, concise responses, incomplete/shared context, stale notes, partly
completed week, next-week reversion, human-coach-managed plans. Real provider test when configured; label mocks.

## 4. Workout input persistence & validation
- Live: save 20 kg, type 25 kg leaving the field focused, reload → 20 kg. Replace blur-only persistence with
  controlled/draft handling (short debounce or local draft); blur/Enter/navigation/completion flush; unload not the only
  safeguard. Don't remount active inputs (focus/cursor). Preserve decimal/comma, empty drafts, unit precision. Storage
  errors visible without discarding the session. Tests: type then refresh, navigate, background, reopen, complete a set
  before the debounced write; weight, reps, duration and other fields using the same component.
- Live: 20 kg / 0 reps can be marked done, counts as completed, starts rest, copies 0 reps forward. Shared domain
  validation used by logging, historical edits, import and server writes: positive whole reps for rep-based completed
  sets; positive duration/distance per tracking mode; reject negative/non-finite; keep valid zero added weight / zero
  assistance; decide explicitly whether loaded exercises need a load or allow "load not recorded" — missing load must not
  become a known zero or create misleading PRs/volume; incomplete drafts stay editable but aren't completed work. Invalid
  sets don't inflate working-set counts, PRs, adherence, progression. Tests: warm-ups, assistance, bodyweight, timed,
  distance/time, corrected historical records.
- Live: swapping untouched Prone floor pulldown → Plank changes fields to seconds but keeps a rep prescription. Map
  compatible substitutions explicitly; rebuild prescriptions, set fields, targets, load conventions, warm-ups when the
  tracking type changes; never reinterpret completed records. Default alternatives respect available equipment,
  exclusions, movement constraints; explicit "Show all exercises" override. Tests: rep→time, time→rep,
  weighted→assisted, per-hand/unilateral, distance/time.
- Progression: consistent Apply / Keep previous / Customize (or equally clear); Dismiss must not imply reversal if it only
  hides text. Don't say "at the target effort" when RIR/RPE wasn't recorded. Fix barbell warm-ups whose hard-coded
  20 kg/45 lb floor can exceed the working load; feasible bar settings; physical load preserved across unit changes.

## 5. Meal plans respond to targets
Fixture: 80 kg, protein-only 144 g/day, 3 meals/day, ≤30 min cooking, milk excluded → week gave 125,112,87,99,114,107,102 g.
After selecting meals, compute daily totals and reconcile with the objective: portion changes, recipe swaps or concrete
additions within exclusions/allergies, meal count, cook time, budget. If impossible, show the gap and practical changes;
never relax allergens. Warnings derived/persisted so they survive refresh. Recalculate after swaps, portions,
substitutions, target changes, manual edits; shopping list consistent. Protein-only: no invented calorie target or energy
claims; calories informational; consistent rounding across cards, logging, totals. Tests: the fixture, multiple
constraints, impossible constraints, manual changes, reload.

## 6. Backup, auth and draft reliability
- Import: validate entity schemas, nested fields, IDs, references, versions, finite numbers, sizes before writing;
  atomic (or rollback/resume-safe); intelligible preview with explicit merge/replace rules; singleton account/settings/
  nutrition handled intentionally (not skipped just because an account record exists). Tests: malformed, truncated,
  newer-version, duplicate, partially failing imports against existing data.
- CSV export: neutralize formula-leading user text; keep numeric columns numeric.
- Auth: Feed "Create an account to share with friends" opens signup, not signin; keep return destination for Feed/
  Coaching. "Back to sign in" after signup/recovery success must switch mode to signin. Privacy info reachable from
  account creation; claims match implemented behaviour.
- Coach composer drafts (text + attachments) survive navigation/reload, scoped by account + relationship, permission
  recheck before send (the sent/queued outbox is not a draft store).
- Clarify "always private" wording: selected info can be shared with an authorized coach or AI service only under consent.

## 7. Backend audit (deployed)
Isolated test accounts for member, friend, stranger, applicant, approved coach, former/suspended/blocked coach, admin.
DB/API/storage-level authorization for private records, social visibility (incl. changes), full social journey,
coach application/documents, search eligibility/locality/remote/geolocation denial, pending vs active access with
category consent, revocation/suspension/termination with open sessions, multiple pending requests (accepting an old
request must not replace a newly active coach without current agreement), message retries/notifications/attachments/
retention/revoked queued ops, custom coach exercises surviving assignment without exposing a private catalog,
proposal/acceptance/versioning incl. AI/human conflicts, export/deletion/media cleanup, AI context isolation, secrets,
usage limits, provider failures. One complete human-coach journey and one live AI journey (incl. the two-session case).
A visible publishable key or downloadable admin code isn't a vulnerability by itself. If credentials are unavailable,
finish accessible repairs, give exact setup + reproducible tests, mark checks blocked.

## 8. Offline, sync, mobile UI, installation
Production build: first-load caching and truthful offline-ready/error states; offline log/refresh/reopen/finish; expired
auth pauses sync but keeps logging; idempotent outbox, conflicts, tombstones, account switching; safe DB migrations and
updates during an active workout; rest timer from timestamps; no private backend responses/signed media URLs in SW caches.
Surface SW registration/storage failures without breaking the tracker. Layouts at 360/375/390/430 + tablet/desktop:
six tabs, safe areas, keyboard overlap, numeric inputs, modals, long names, overflow, tap targets, contrast, focus,
SR labels, reduced motion. Reduce repeated explanatory text in plan + workout flow (keep sets/reps/rest/next action/cues;
long text expandable). Clarify human vs AI coaching choices before the sign-in gate; consider public preview of approved
coach profiles (requests/private data stay authenticated). Document real-device checks. Measure compressed transfer,
startup/parse, interaction; optimize only demonstrated bottlenecks. Review security headers and a compatible CSP.

## 9. Deliver
Fixes + additive migrations; focused tests with commands/results; findings matrix (severity, reproduction, cause,
source, fix, verification, limits); capability matrix (local / real backend / blocked); updated setup notes and
BUILD_STATUS.md; concise ready-vs-external summary. Honest outcomes.
