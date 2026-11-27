Item 11 Daily Use Polish
Share
Hard Earned — Item 11: Daily-use polish

Implementation contract for Claude Code. Source inspected read-only: bjossinn/liftcircle, main 5934d065ced822cf50c29f1d5c8c2bd5198627bc.

Scope and invariants
Implement only the Food Log landing, data-aware Progress disclosure, Settings grouping and CSV-test cleanup below. No new AI behavior, nutrition recommendations, targets, push rules, analytics events or top-level navigation.
No storage/schema/SQL migrations, automatic deletions, resets, cleanup, backfills or rewrites of user content. Preserve every existing route and capability, including user-initiated deletion/undo and their existing confirmations.
Derive presentation from the active account's local Dexie data. Keep guest/demo/account isolation, tombstones, outbox writes, backup compatibility and existing sync/consent gates. Opening a page or changing its view must not write settings or domain records.
No network prerequisite for food logging, local Progress or local settings. Keep the existing honest online requirements for AI settings, push subscription operations and cloud/account actions. Do not queue fabricated remote success.
Use existing domain calculations and progression rules. Unknown values remain unknown; an explicitly recorded numeric zero is data, never an absence test.
1. Food Log: Recent + Quick protein

Primary files: 
FoodLogPage.tsx, src/domain/nutrition/log.ts, src/db/repo.ts, src/features/nutrition/shared.tsx.

Landing and navigation
Replace the missing/invalid-tab fallback at FoodLogPage:48 from recipes to recent.
Keep all valid tab IDs and their existing meanings: recent, quick, foods, recipes, custom, saved. Display them in that order. quick remains the existing manual macro form.
The Recent panel renders, in order: Quick protein, then Recent items. Quick protein remains usable while Recent loads and when Recent is empty. Show only one Recent empty state.
Quick protein has three buttons, visibly +20 g, +30 g, +40 g, with foodLog.quickProtein.add as each full accessible label. One activation logs immediately; no modal or confirmation. “Other amount” opens tab=quick, focuses its protein input and does not log anything.
Keep food/recipe searches, custom foods, saved meals and Copy previous meal accessible. Do not reuse ProteinPicker.tsx: it edits diet preferences, not food records.
Preserve date and meal when changing tabs. Use account-timezone todayISO and account-timezone hour for the default meal. A valid existing date/meal deep link wins. Normalize invalid or future date parameters to today before rendering/writing; normalize an invalid meal to the default. No future log can be created through a crafted query string.
Write contract

Each preset creates one ordinary FoodLogEntry with source:{kind:'quick'}, protein:20|30|40, the selected date/meal and foodLog.quickProtein.entryName formatted in the current language. Do not add kcal/carbs/fat/grams/servings fields, infer calories from protein, or associate a food/allergen/supplement. This is numeric logging, not dietary advice. No target or nutrition opt-in is needed to use an explicitly opened food-log route.

Use entryDraftOf() for repeats: preserve the stored source, amounts and macro snapshot exactly; do not recalculate from a changed recipe/custom food.
Keep the existing Recent window (addDays(today,-30) through today, inclusive) and 25-distinct-item limit, independent of the selected log date. Exclude tombstones. Reuse the active account's DB only.
Extend quick-entry identity in recentItems() to include every macro's presence/value. 20/30/40 g must remain distinct; missing and zero must remain distinct. Use the same stable identity for React row keys so a just-logged item moving in the list does not lose keyboard focus.
Centralize logging in the existing log() handler: acquire a synchronous in-flight guard before awaits; capture DB/account/date/meal and allocate record IDs once; write the entire batch with existing saveRecordsAtomic() (including outbox). Disable submit controls while pending. Saved meals and Copy previous meal must be all-or-nothing. Release the guard on failure; intentional new taps after completion remain valid.
Show success only after the local transaction commits, using captured name/meal/date and the existing View day action. Offline success means local success, not cloud synchronization. Suppress stale feedback on account change; never retarget an in-flight write to another account's DB.
Catch load/save/delete/undo failures; retain editable input after failure. Existing explicit delete/undo behavior stays available. Do not filter historical food records because diet preferences changed; preserve recipe allergen warnings.
Localization

Localize every authored string in FoodLogPage and its reachable sheets/forms, not just the new landing. Use the JSON package below. Reuse today.logFood, progress.date, program.name, settings.unknown, aiCard.recipe.meal, aiCard.macro.*, common.back/cancel/save/retry/loading, and aiCard.undo.

Use mealLabel(slot, language), allergenLabel(allergen, language), macroLine(), numberText() and listText(); do not render English-only MEAL_LABELS/ALLERGEN_LABELS or concatenate English plural suffixes. Macro summaries must preserve missing-value semantics. Use tp for serving/item/yield families. Do not persist translated enum IDs.

2. Progress: show existing data, disclose unused metrics gradually

Primary files: 
ProgressPage.tsx, all seven *Section.tsx files, shared.ts, charts.tsx, src/domain/stats.ts. Add a small pure visibility.ts selector module; reuse existing stats/set-validation helpers rather than duplicating formulas.

Data and empty-state rules
Read alive food logs regardless of settings.nutritionEnabled. This setting controls optional nutrition entry points, not access to historical Progress data. Include food dates in the “All” range boundary and food presence in the global empty test.
Keep separate all-history availability and selected-range inputs. Existing weekly goal computations still use the current account-timezone week. Do not accidentally feed unfiltered all-history food totals into range/week summaries.
Wait for accountReady and all required Dexie queries. Undefined/loading is never an empty account. Account changes must not flash the previous account's charts.
A genuinely new account gets one neutral global empty state. Do not mount seven empty sections beneath it.
Keep an always-available Add a record menu: workout (/train), activity (/train/activity/new), food (/nutrition/log), measurement sheet, goal sheet. Reuse train.historyLog, progress.logActivity, today.logFood, progress.addMeasurementGeneric, progress.addGoal. These actions remain available with no data or nutrition disabled.
Extract/reuse measurement and goal editor sheets independently of section visibility. Their existing validations, edit/delete confirmations and all measurement kinds/goal types stay intact.
Section	Show when all-history data exists	Internal disclosure
Consistency	An alive completed workout or activity	Keep existing completed-session semantics, including retained discomfort-only sessions. Plan existence alone is not eligibility. Show adherence only with a valid positive planned denominator; zero completions is valid. Hide the no-program recruitment block.
Exercise	exercisesWithHistory() has entries	Keep recorded exercises selectable. Render only supported series with actual values. Retain working-set/reps/time tables without load; hide nonexistent records and unavailable estimated-1RM charts. Preserve unknown-catalog exercise records with their stored names.
Volume	At least one countable working set	Working-set counts remain for bodyweight/timed work. Show only load buckets with applicable recorded load data; do not invent bodyweight or assisted-load volume. Show muscle charts only when mapped muscle data exists.
Activities	An alive activity	Keep minutes/history without distance. Distance needs a recorded finite value; pace/speed needs positive distance and duration and a supported activity type. Hide unused pace selectors/charts.
Body	An alive measurement	Offer only measured kinds in the chart selector. Start with bodyweight if present, otherwise the first available kind in the existing order. All seven kinds remain in the Add editor.
Nutrition	An alive food-log entry	Numeric protein zero counts as data. Without a protein target, show recorded grams/average with the target-free summary; omit target attainment. Unknown-protein-only entries get the compact explanation and a Food log link, not a zero-filled chart.
Goals	An alive goal	Include achieved/custom goals and goals with missing supporting measurements. Keep existing goal semantics independent of the range selector; do not hide protein goals when nutrition is disabled.
Keep this existing section order. If an eligible metric has no data in the selected period, show one compact period-empty message and Show all time control, not multiple empty cards or synthetic zero charts. All-time records and goals remain visible according to their existing semantics.
Keep a single real point visible; a trend is not required to qualify as data. Retain accessible chart summaries and data tables. Validate selectors against available choices after edits, tombstones, range/account changes; never select a removed option.
Keep useful, data-supported observations. Remove the generic “No workouts or activities logged yet” filler for food/body-only accounts. Localize observations(), goalProgress() and the remaining load notes/headers using the supplied keys. Preserve all calculations. Signed changes must use locale formatting, including plus/minus signs.
Use progress.proteinTrendWithoutTarget for target-free numeric protein data. Use progress.proteinUnknown for logs with no known protein. Reuse progress.targetMet, progress.proteinBelow, progress.dayCount.*, summary.pace/speed and existing record/unit labels.
3. Settings: five clear groups, existing controls

Primary files: 
SettingsPage.tsx, account.tsx; reuse PushSection.tsx, DataPage.tsx, AiSettingsPage.tsx, ThemeOptions and UpdateCheckRow without changing their ownership/save logic.

/settings becomes an index of exactly five navigation rows, in this order. Open details with ?section=...; these are views of the existing route, not new persisted settings.

section	Label	Controls retained
app	Language & display	Language, theme, all three unit selectors, week start, time zone and helper text.
training	Training & nutrition	Rest/default sets, both kg/lb increments and empty-bar weights, automatic rest/sound/vibration/wake lock, cheers/celebrations/RIR; nutrition toggle, targets, redo setup, program/schedule links.
coaching	Coach & notifications	Link to /coaching/ai/settings using ai.settings.title; complete existing PushSection, including device state, all per-type toggles, cap, quiet hours and snooze; all four in-app notification toggles separately.
privacy	Sharing & privacy	Discoverability, audience, auto-share audience and all five shared fields, analytics opt-out. Preserve these when Feed is hidden.
account	Account & data	All signed-in/expired/guest/demo/personal-mode branches, private name, social profile and guarded sign-out; /settings/data, update check, install, conditional demo entry, About and version.
Existing routes remain: /settings/data, /settings/data#sync, /install, /auth, /profile/edit, /coaching/ai/settings, /nutrition/targets, /onboarding, /train/program. Keep backup/export/import/sync/conflict recovery/storage protection/delete-account capabilities and confirmations unchanged.
Unknown section → index. Preserve legacy hashes: appearance-title/`language-title` open app; push-title/`coach-push-title`/`quiet-push-title`/`other-push-title` open coaching, then scroll/focus their existing heading. Hash targeting takes precedence over a conflicting section. Do not intercept /settings/data#sync.
Use real links, browser Back/Forward and refreshable query state. Group Back returns to the index: use history Back only when the entry came from that index; otherwise replace with /settings. Restore focus to the originating row; focus the detail heading on entry.
Lazy-mount a group on first visit, keep it mounted with hidden while this SettingsPage is active, and clear retained UI state on DB/account change. This preserves NumberInput/private-name drafts and pending writes. Blur/commit the focused control before explicit Back; do not prevent its blur handler. Save failures remain visible and preserve the draft. Do not mount PushSection on an untouched index or request permission merely by browsing groups.
Preserve functional nested updates and language-save success only after persistence. Language changes must not reset units, time zone, theme or content. Never copy AI/push preferences into account.settings or combine their separate transactions.
Wire settings.signOut into both hard-coded labels in account.tsx while retaining the complete unsynced-data sign-out flow.
4. CSV portability bonus

In tests/unit/coachEvalReview.test.ts, replace the unconditional Python CSV subprocess with a standard dev-only Node parser:

TypeScript
import { parse } from 'csv-parse/sync';
const parsed = parse(sheet.csv) as string[][];

Add csv-parse to devDependencies and lockfile only. Keep exact assertions for ten columns, quotes, commas, LF/CRLF, multiline text, Icelandic, empty cells and review-code matching. Do not use a homemade parser or the serializer as its own oracle. No runtime import, AI behavior, bundle or translation changes are needed for this bonus. API: https://csv.js.org/parse/api/sync/

5. Offline, accessibility and acceptance tests
All controls: keyboard operation, visible focus, 44px touch targets, translated labels/ARIA, screen-reader status after a local save and errors announced once. Food tabs use roving focus plus Arrow/Home/End and Enter/Space behavior with correctly linked tab panels. Hidden settings groups are absent from the accessibility tree.
Preserve focus after one-tap reordering; sheet/dialog focus returns to its trigger. Do not rely on color alone or remove chart data tables. Respect reduced motion and mobile safe areas.
Numbers: existing NumberInput/numberText/loadText/date/list helpers; is-IS decimal comma, locale dates and 24-hour times. Language is independent of units/time zone. No parsing localized display strings into storage, no translated canonical enum values.
Pure tests: section/submetric visibility; zero versus unknown; quick-entry dedupe; all-time food boundary; no changes to existing stats formulas.
FoodLog UI: default/invalid/all valid tabs; date/meal deep links; all presets; Other amount focus; repeat snapshot preservation; slow-write double click; failed write then retry; atomic multi-entry rollback; tombstones/loading; account switch; guest/offline outbox; all reachable EN/IS forms and warnings.
Progress UI: completely empty, food-only, nutrition disabled, missing target, zero protein, unknown protein, old food history, one-point measurement, waist-only, bodyweight/timed/assisted-zero sets, discomfort-only session, unknown-catalog exercise, cardio without distance, achieved/custom/protein goals, no selected-period data, deleting last selected metric, loading/account switch; all first-entry editors reachable.
Settings UI: all five groups and every existing control/link, direct query and hashes, Back/Forward/refresh, typed draft then Back, failure retention, account/demo/expired states, independent language/units, full Push behavior including cap/snooze with device push off, and existing backup/restore/consent/sign-out safety tests.
Copy: store the two approved JSON blocks below unchanged as fixtures. Assert exact key/value equality with CLIENT_EN/CLIENT_IS for every supplied key, full dictionary key parity and per-key placeholder parity. Existing keys not in these blocks must be unchanged. Test representative EN/IS rendered output, not only fixture equality. No invented Icelandic or silent English fallback for authored interface text.
Allow raw stored names, user notes, recipe/ingredient names, brands/source citations, standard units/symbols only. Raw/dry/cooked, household measures, meal/allergen enums, label/estimate and UI strings are not that exception. New default record names are localized only at creation; never rename historical records on language change.
Run typecheck, full unit tests and production build; keep bundle parity tests green. Add focused browser coverage for FoodLog → add, Progress → first measurement/goal, and Settings group navigation in both languages. Verify the CSV unit test on Windows without Python. No new DB migration/suite is required; existing regression suites must remain green.
6. Exact copy contract

Merge the following flat JSON objects into CLIENT_EN and CLIENT_IS respectively. They contain 158 entries per language: 154 new keys and four updated keys (progress.emptyTitle, progress.emptyHelp, progress.consistencySummary, progress.proteinTrend). The Icelandic values of the last two are preserved from main. Use the count-neutral summaries in both languages instead of ad-hoc English singular branches.

Every value is final authored copy. Keep punctuation, Unicode, accents and {{placeholders}} exactly. Use existing tp/Intl.PluralRules for .one/.other (including Icelandic 1/11/21); do not select plurals with count === 1. Food serving labels are noun forms after the count-neutral Portion:/`Skammtur:` prefix. {{current}} and {{target}} in goal load/weight summaries include formatted units; other numeric placeholders are locale-formatted numeric values. {{change}} is a signed, locale-formatted number. Lists use listText; meal/allergen placeholders use the existing localized enum labels, never guessed inflections.

EN
JSON
{
  "foodLog.tab.recent": "Recent",
  "foodLog.tab.quick": "Quick entry",
  "foodLog.tab.recipes": "Recipes",
  "foodLog.tab.foods": "Foods",
  "foodLog.tab.custom": "Custom foods",
  "foodLog.tab.saved": "Saved meals",
  "foodLog.ways": "Ways to log",
  "foodLog.add": "Add",
  "foodLog.log": "Log",
  "foodLog.viewDay": "View day",
  "foodLog.added": "Added: {{name}}. {{meal}} · {{date}}.",
  "foodLog.saveError": "Could not save. Please try again.",
  "foodLog.loadError": "Could not load your food log. Please try again.",
  "foodLog.deleteError": "Could not delete. Please try again.",
  "foodLog.undoError": "Could not undo. Please try again.",
  "foodLog.copyPrevious": "Copy this meal from the previous day",
  "foodLog.copyEmpty": "Nothing logged for this meal on {{date}}.",
  "foodLog.quickProtein.title": "Quick protein",
  "foodLog.quickProtein.help": "Log protein only. Calories, carbs and fat stay unknown.",
  "foodLog.quickProtein.add": "Add {{grams}} g protein",
  "foodLog.quickProtein.other": "Other amount",
  "foodLog.quickProtein.entryName": "Quick protein · {{grams}} g",
  "foodLog.quick.description": "Description (optional)",
  "foodLog.quick.placeholder": "e.g. Lunch at the canteen",
  "foodLog.quick.required": "Enter calories or protein (or both).",
  "foodLog.quick.entryName": "Quick entry",
  "foodLog.quick.carbsOptional": "Carbs (optional)",
  "foodLog.quick.fatOptional": "Fat (optional)",
  "foodLog.unknownHelp": "Values you leave empty stay unknown, not zero.",
  "foodLog.recipes.search": "Search recipes",
  "foodLog.recipes.empty": "No recipes found",
  "foodLog.recipes.emptyHelp": "Try a different word.",
  "foodLog.recipes.perServing": "Per serving: {{macros}}",
  "foodLog.recipes.contains": "Allergens: {{allergens}}",
  "foodLog.recipes.servingsEaten": "Servings eaten",
  "foodLog.recipes.portions": "Common portions",
  "foodLog.recipes.estimate.one": "Estimated from generic ingredient data. The recipe makes {{count}} serving.",
  "foodLog.recipes.estimate.other": "Estimated from generic ingredient data. The recipe makes {{count}} servings.",
  "foodLog.recipes.view": "View recipe",
  "foodLog.foods.search": "Search foods",
  "foodLog.foods.empty": "No foods found",
  "foodLog.foods.emptyHelp": "Try another word, or create a custom food.",
  "foodLog.foods.per100g": "Per 100 g: {{macros}}",
  "foodLog.foods.amount": "Amount",
  "foodLog.foods.measures": "Household measures",
  "foodLog.foods.source": "Source: {{source}}",
  "foodLog.foods.state.raw": "Raw",
  "foodLog.foods.state.dry": "Dry",
  "foodLog.foods.state.cooked": "Cooked",
  "foodLog.foods.stateHelp.raw": "Values are for raw food. Weigh it raw for the best estimate.",
  "foodLog.foods.stateHelp.dry": "Values are for dry food. Weigh it dry for the best estimate.",
  "foodLog.foods.stateHelp.cooked": "Values are for cooked food. Weigh it cooked for the best estimate.",
  "foodLog.foods.measure.piece": "1 piece ({{grams}} g)",
  "foodLog.foods.measure.cup": "1 cup ({{grams}} g)",
  "foodLog.foods.measure.tbsp": "1 tbsp ({{grams}} g)",
  "foodLog.foods.measure.tsp": "1 tsp ({{grams}} g)",
  "foodLog.foods.measure.slice": "1 slice ({{grams}} g)",
  "foodLog.foods.measure.can": "1 can ({{grams}} g)",
  "foodLog.custom.new": "New custom food",
  "foodLog.custom.edit": "Edit custom food",
  "foodLog.custom.empty": "No custom foods yet",
  "foodLog.custom.emptyHelp": "Add foods you eat often, using the values from the package label.",
  "foodLog.custom.per": "Portion: {{amount}} {{unit}} · {{macros}}",
  "foodLog.custom.label": "Label",
  "foodLog.custom.estimate": "Estimate",
  "foodLog.editNamed": "Edit {{name}}",
  "foodLog.deleteNamed": "Delete {{name}}",
  "foodLog.deleted": "Deleted {{name}}",
  "foodLog.custom.servings": "Servings",
  "foodLog.custom.amountUnit": "Amount ({{unit}})",
  "foodLog.custom.fromLabel": "Values from a package label. Missing values stay unknown.",
  "foodLog.custom.fromEstimate": "Values are your estimate. Missing values stay unknown.",
  "foodLog.custom.nameRequired": "Enter a name",
  "foodLog.custom.amountRequired": "Enter an amount",
  "foodLog.custom.macrosRequired": "Enter at least calories or protein",
  "foodLog.custom.updated": "Custom food updated",
  "foodLog.custom.saved": "Custom food saved",
  "foodLog.custom.brand": "Brand (optional)",
  "foodLog.custom.valuesPer": "Values per",
  "foodLog.custom.unit": "Unit",
  "foodLog.custom.grams": "Grams",
  "foodLog.custom.millilitres": "Millilitres",
  "foodLog.custom.serving.one": "serving",
  "foodLog.custom.serving.other": "servings",
  "foodLog.custom.labelValues": "Values from a package label",
  "foodLog.custom.labelHelp": "Turn off if these are your own estimate.",
  "foodLog.saved.title": "Save this meal",
  "foodLog.saved.defaultName": "My meal",
  "foodLog.saved.first": "Log some items in this meal first, then save them together for next time.",
  "foodLog.saved.items": "Items: {{items}}",
  "foodLog.saved.save": "Save meal",
  "foodLog.saved.saved": "Saved: {{name}}",
  "foodLog.saved.empty": "No saved meals",
  "foodLog.saved.emptyHelp": "Saved meals let you log a usual breakfast or lunch in one tap.",
  "foodLog.itemCount.one": "{{count}} item",
  "foodLog.itemCount.other": "{{count}} items",
  "foodLog.logNamed": "Log {{name}}",
  "foodLog.recent.empty": "Nothing recent",
  "foodLog.recent.emptyHelp": "Items you log will appear here for one-tap logging.",
  "foodLog.recent.again": "Log {{name}} again",
  "foodLog.copyLabel": "Meal from the previous day",
  "progress.actions": "Add a record",
  "progress.addMeasurementGeneric": "Add a measurement",
  "progress.showAllTime": "Show all time",
  "progress.periodEmpty": "No data in this period.",
  "progress.proteinUnknown": "Food is logged, but its protein amount is unknown.",
  "progress.loggedProtein": "Logged protein",
  "progress.proteinTrendWithoutTarget": "Days with protein logged: {{logged}}. Average on those days: {{average}} g. Days without protein values: {{noData}}.",
  "progress.emptyTitle": "Your progress will appear here",
  "progress.emptyHelp": "Log a workout, activity, food or measurement, or add a goal. Only recorded data appears here.",
  "progress.add": "Add",
  "progress.entry": "Entry",
  "progress.bestSet": "Best set",
  "progress.setsPerWeekLabel": "Sets per week",
  "progress.noWorkingSetsPeriod": "No working sets in this period.",
  "progress.paceTrend": "Pace trend",
  "progress.speedTrend": "Speed trend",
  "progress.dateNotFuture": "Choose a date that is not in the future.",
  "progress.plannedSessionCount": "{{completed}} of {{planned}} planned sessions",
  "progress.completedOfPlanned": "{{completed}} of {{planned}}",
  "progress.loadNote.perHand": "Weight is per dumbbell or kettlebell.",
  "progress.loadNote.stack": "Weight is the machine or cable stack setting.",
  "progress.loadNote.added": "Weight is the load added to your bodyweight.",
  "progress.loadNote.assistance": "Weight is the assistance. Less is progress.",
  "progress.minutesUnit": "min",
  "progress.goalStatus.workouts": "Workouts this week: {{current}} of {{target}}.",
  "progress.goalStatus.minutes": "Activity minutes this week: {{current}} of {{target}}.",
  "progress.goalStatus.proteinTargetMissing": "Set a protein target to track this goal.",
  "progress.goalStatus.proteinDays": "Protein target days this week: {{current}} of {{target}}.",
  "progress.goalStatus.proteinDaysMissing": "Protein target days this week: {{current}} of {{target}}. Days without logs: {{missing}}.",
  "progress.goalStatus.noExerciseSets": "No sets logged for {{exercise}} yet.",
  "progress.goalStatus.assistance": "Least assistance: {{current}} · target: {{target}}.",
  "progress.goalStatus.load": "Best: {{current}} · target: {{target}}.",
  "progress.goalStatus.weightMissing": "Add a bodyweight entry to track this goal.",
  "progress.goalStatus.weight": "7-day average: {{current}} · target: {{target}}.",
  "progress.goalStatus.custom": "Mark this goal as achieved when you reach it.",
  "progress.insight.planned": "Planned sessions completed this week: {{completed}} of {{planned}}.",
  "progress.insight.workouts": "Workouts logged this week: {{count}}.",
  "progress.insight.activities": "Other activities logged this week: {{count}}.",
  "progress.insight.both": "Logged this week: workouts {{workouts}} · other activities {{activities}}.",
  "progress.insight.minutes": "Activity this week: {{minutes}} min ({{change}} min versus last week).",
  "progress.insight.sets": "Working sets this week: {{current}} (last week: {{previous}}).",
  "progress.insight.weight": "7-day average bodyweight: {{weight}} {{unit}}.",
  "progress.insight.weightChange": "7-day average bodyweight: {{weight}} {{unit}} ({{change}} {{unit}} versus last week).",
  "progress.insight.lastSession": "Days since your last logged session: {{count}}.",
  "settings.group.app.title": "Language & display",
  "settings.group.app.description": "Language, appearance, units and dates.",
  "settings.group.training.title": "Training & nutrition",
  "settings.group.training.description": "Workout defaults, rest timer, program and nutrition.",
  "settings.group.coaching.title": "Coach & notifications",
  "settings.group.coaching.description": "Training assistant, reminders and notifications.",
  "settings.group.privacy.title": "Sharing & privacy",
  "settings.group.privacy.description": "Sharing, visibility and product analytics.",
  "settings.group.account.title": "Account & data",
  "settings.group.account.description": "Account, backups, sync and app information.",
  "settings.signOut": "Sign out",
  "progress.consistencySummary": "Workouts: {{workouts}} · other activities: {{activities}} · weeks: {{weeks}}. Sessions per week on average: {{average}}.",
  "progress.proteinTrend": "Protein target: {{target}} g. Logged days: {{logged}}; target reached: {{met}}. Average on logged days: {{average}} g. Days without protein logs: {{noData}}. These appear as no data, not zero."
}
IS
JSON
{
  "foodLog.tab.recent": "Nýlega skráð",
  "foodLog.tab.quick": "Flýtiskráning",
  "foodLog.tab.recipes": "Uppskriftir",
  "foodLog.tab.foods": "Matvæli",
  "foodLog.tab.custom": "Mín matvæli",
  "foodLog.tab.saved": "Vistaðar máltíðir",
  "foodLog.ways": "Skráningaraðferðir",
  "foodLog.add": "Bæta við",
  "foodLog.log": "Skrá",
  "foodLog.viewDay": "Skoða daginn",
  "foodLog.added": "Skráð: {{name}}. {{meal}} · {{date}}.",
  "foodLog.saveError": "Ekki tókst að vista. Reyndu aftur.",
  "foodLog.loadError": "Ekki tókst að sækja matarskráninguna. Reyndu aftur.",
  "foodLog.deleteError": "Ekki tókst að eyða. Reyndu aftur.",
  "foodLog.undoError": "Ekki tókst að afturkalla. Reyndu aftur.",
  "foodLog.copyPrevious": "Afrita þessa máltíð frá deginum áður",
  "foodLog.copyEmpty": "Ekkert var skráð fyrir þessa máltíð {{date}}.",
  "foodLog.quickProtein.title": "Skrá prótein",
  "foodLog.quickProtein.help": "Þetta skráir aðeins prótein. Önnur næringargildi eru áfram óþekkt.",
  "foodLog.quickProtein.add": "Skrá {{grams}} g af próteini",
  "foodLog.quickProtein.other": "Annað magn",
  "foodLog.quickProtein.entryName": "Prótein · {{grams}} g",
  "foodLog.quick.description": "Lýsing (valfrjálst)",
  "foodLog.quick.placeholder": "T.d. hádegismatur í mötuneytinu",
  "foodLog.quick.required": "Sláðu inn hitaeiningar eða prótein, eða hvort tveggja.",
  "foodLog.quick.entryName": "Flýtiskráning",
  "foodLog.quick.carbsOptional": "Kolvetni (valfrjálst)",
  "foodLog.quick.fatOptional": "Fita (valfrjálst)",
  "foodLog.unknownHelp": "Gildi sem þú skilur eftir auð eru óþekkt, ekki núll.",
  "foodLog.recipes.search": "Leita að uppskriftum",
  "foodLog.recipes.empty": "Engar uppskriftir fundust",
  "foodLog.recipes.emptyHelp": "Prófaðu annað leitarorð.",
  "foodLog.recipes.perServing": "Í hverjum skammti: {{macros}}",
  "foodLog.recipes.contains": "Ofnæmisvaldar: {{allergens}}",
  "foodLog.recipes.servingsEaten": "Fjöldi skammta sem þú borðaðir",
  "foodLog.recipes.portions": "Algengar skammtastærðir",
  "foodLog.recipes.estimate.one": "Áætlað út frá almennum næringargildum hráefna. Uppskriftin gefur {{count}} skammt.",
  "foodLog.recipes.estimate.other": "Áætlað út frá almennum næringargildum hráefna. Uppskriftin gefur {{count}} skammta.",
  "foodLog.recipes.view": "Skoða uppskrift",
  "foodLog.foods.search": "Leita að matvælum",
  "foodLog.foods.empty": "Engin matvæli fundust",
  "foodLog.foods.emptyHelp": "Prófaðu annað leitarorð eða bættu við eigin matvöru.",
  "foodLog.foods.per100g": "Í 100 g: {{macros}}",
  "foodLog.foods.amount": "Magn",
  "foodLog.foods.measures": "Algengar mælieiningar",
  "foodLog.foods.source": "Heimild: {{source}}",
  "foodLog.foods.state.raw": "Hrátt",
  "foodLog.foods.state.dry": "Þurrt",
  "foodLog.foods.state.cooked": "Eldað",
  "foodLog.foods.stateHelp.raw": "Gildin eiga við hrá matvæli. Vigtaðu þau hrá til að fá sem nákvæmasta áætlun.",
  "foodLog.foods.stateHelp.dry": "Gildin eiga við þurr matvæli. Vigtaðu þau þurr til að fá sem nákvæmasta áætlun.",
  "foodLog.foods.stateHelp.cooked": "Gildin eiga við elduð matvæli. Vigtaðu þau eftir eldun til að fá sem nákvæmasta áætlun.",
  "foodLog.foods.measure.piece": "1 stykki ({{grams}} g)",
  "foodLog.foods.measure.cup": "1 bolli ({{grams}} g)",
  "foodLog.foods.measure.tbsp": "1 msk. ({{grams}} g)",
  "foodLog.foods.measure.tsp": "1 tsk. ({{grams}} g)",
  "foodLog.foods.measure.slice": "1 sneið ({{grams}} g)",
  "foodLog.foods.measure.can": "1 dós ({{grams}} g)",
  "foodLog.custom.new": "Ný matvara",
  "foodLog.custom.edit": "Breyta matvöru",
  "foodLog.custom.empty": "Engar eigin matvörur enn",
  "foodLog.custom.emptyHelp": "Bættu við matvælum sem þú borðar oft og notaðu næringargildin á umbúðunum.",
  "foodLog.custom.per": "Skammtur: {{amount}} {{unit}} · {{macros}}",
  "foodLog.custom.label": "Af umbúðum",
  "foodLog.custom.estimate": "Áætlað",
  "foodLog.editNamed": "Breyta: {{name}}",
  "foodLog.deleteNamed": "Eyða: {{name}}",
  "foodLog.deleted": "Eytt: {{name}}",
  "foodLog.custom.servings": "Skammtar",
  "foodLog.custom.amountUnit": "Magn ({{unit}})",
  "foodLog.custom.fromLabel": "Gildin eru af umbúðum. Gildi sem vantar eru áfram óþekkt.",
  "foodLog.custom.fromEstimate": "Gildin eru þín áætlun. Gildi sem vantar eru áfram óþekkt.",
  "foodLog.custom.nameRequired": "Sláðu inn heiti",
  "foodLog.custom.amountRequired": "Sláðu inn magn",
  "foodLog.custom.macrosRequired": "Sláðu inn að minnsta kosti hitaeiningar eða prótein",
  "foodLog.custom.updated": "Matvara uppfærð",
  "foodLog.custom.saved": "Matvara vistuð",
  "foodLog.custom.brand": "Vörumerki (valfrjálst)",
  "foodLog.custom.valuesPer": "Gildi miðast við",
  "foodLog.custom.unit": "Eining",
  "foodLog.custom.grams": "Grömm",
  "foodLog.custom.millilitres": "Millilítrar",
  "foodLog.custom.serving.one": "skammtur",
  "foodLog.custom.serving.other": "skammtar",
  "foodLog.custom.labelValues": "Gildi af umbúðum",
  "foodLog.custom.labelHelp": "Slökktu ef gildin eru þín eigin áætlun.",
  "foodLog.saved.title": "Vista þessa máltíð",
  "foodLog.saved.defaultName": "Máltíðin mín",
  "foodLog.saved.first": "Skráðu fyrst mat í þessa máltíð. Síðan geturðu vistað færslurnar saman fyrir næsta skipti.",
  "foodLog.saved.items": "Innihald: {{items}}",
  "foodLog.saved.save": "Vista máltíð",
  "foodLog.saved.saved": "Vistað: {{name}}",
  "foodLog.saved.empty": "Engar vistaðar máltíðir",
  "foodLog.saved.emptyHelp": "Vistaðu til dæmis venjulega morgunmatinn eða hádegismatinn þinn og skráðu hann næst með einni snertingu.",
  "foodLog.itemCount.one": "{{count}} færsla",
  "foodLog.itemCount.other": "{{count}} færslur",
  "foodLog.logNamed": "Skrá: {{name}}",
  "foodLog.recent.empty": "Ekkert nýlega skráð",
  "foodLog.recent.emptyHelp": "Það sem þú skráir birtist hér svo þú getir skráð það aftur með einni snertingu.",
  "foodLog.recent.again": "Skrá aftur: {{name}}",
  "foodLog.copyLabel": "Máltíð frá deginum áður",
  "progress.actions": "Bæta við skráningu",
  "progress.addMeasurementGeneric": "Skrá mælingu",
  "progress.showAllTime": "Sýna frá upphafi",
  "progress.periodEmpty": "Engin gögn á þessu tímabili.",
  "progress.proteinUnknown": "Matur hefur verið skráður en próteinmagnið er óþekkt.",
  "progress.loggedProtein": "Skráð prótein",
  "progress.proteinTrendWithoutTarget": "Dagar með próteinskráningu: {{logged}}. Meðaltal á þeim dögum: {{average}} g. Dagar án próteingilda: {{noData}}.",
  "progress.emptyTitle": "Framfarirnar þínar birtast hér",
  "progress.emptyHelp": "Skráðu æfingu, hreyfingu, mat eða mælingu, eða bættu við markmiði. Hér birtast aðeins skráð gögn.",
  "progress.add": "Bæta við",
  "progress.entry": "Færsla",
  "progress.bestSet": "Besta sett",
  "progress.setsPerWeekLabel": "Sett á viku",
  "progress.noWorkingSetsPeriod": "Engin vinnusett á þessu tímabili.",
  "progress.paceTrend": "Tími á vegalengd",
  "progress.speedTrend": "Þróun hraða",
  "progress.dateNotFuture": "Veldu dagsetningu sem er ekki í framtíðinni.",
  "progress.plannedSessionCount": "Skipulagðar æfingar: {{completed}} af {{planned}} lokið",
  "progress.completedOfPlanned": "{{completed}} af {{planned}}",
  "progress.loadNote.perHand": "Þyngdin miðast við hvert handlóð eða hverja ketilbjöllu.",
  "progress.loadNote.stack": "Þyngdin er stillingin á tækinu eða kapalvélinni.",
  "progress.loadNote.added": "Þyngdin er viðbótarþyngd umfram líkamsþyngd.",
  "progress.loadNote.assistance": "Þyngdin sýnir aðstoðina. Minni aðstoð merkir framfarir.",
  "progress.minutesUnit": "mín.",
  "progress.goalStatus.workouts": "Æfingar í þessari viku: {{current}} af {{target}}.",
  "progress.goalStatus.minutes": "Mínútur í hreyfingu í þessari viku: {{current}} af {{target}}.",
  "progress.goalStatus.proteinTargetMissing": "Stilltu próteinmarkmið til að fylgjast með þessu markmiði.",
  "progress.goalStatus.proteinDays": "Dagar sem próteinmarkmiði var náð í þessari viku: {{current}} af {{target}}.",
  "progress.goalStatus.proteinDaysMissing": "Dagar sem próteinmarkmiði var náð í þessari viku: {{current}} af {{target}}. Dagar án skráningar: {{missing}}.",
  "progress.goalStatus.noExerciseSets": "Engin sett skráð enn fyrir æfinguna: {{exercise}}.",
  "progress.goalStatus.assistance": "Minnsta aðstoð: {{current}} · markmið: {{target}}.",
  "progress.goalStatus.load": "Besta: {{current}} · markmið: {{target}}.",
  "progress.goalStatus.weightMissing": "Skráðu líkamsþyngd til að fylgjast með þessu markmiði.",
  "progress.goalStatus.weight": "7 daga meðaltal: {{current}} · markmið: {{target}}.",
  "progress.goalStatus.custom": "Merktu við þegar markmiðinu er náð.",
  "progress.insight.planned": "Skipulagðar æfingar í þessari viku: {{completed}} af {{planned}} lokið.",
  "progress.insight.workouts": "Skráðar æfingar í þessari viku: {{count}}.",
  "progress.insight.activities": "Önnur hreyfing skráð í þessari viku: {{count}}.",
  "progress.insight.both": "Skráð í þessari viku: æfingar {{workouts}} · önnur hreyfing {{activities}}.",
  "progress.insight.minutes": "Hreyfing í þessari viku: {{minutes}} mín. ({{change}} mín. frá síðustu viku).",
  "progress.insight.sets": "Vinnusett í þessari viku: {{current}} (í síðustu viku: {{previous}}).",
  "progress.insight.weight": "Meðallíkamsþyngd síðustu 7 daga: {{weight}} {{unit}}.",
  "progress.insight.weightChange": "Meðallíkamsþyngd síðustu 7 daga: {{weight}} {{unit}} ({{change}} {{unit}} frá síðustu viku).",
  "progress.insight.lastSession": "Dagar frá síðustu skráðu æfingu: {{count}}.",
  "settings.group.app.title": "Tungumál og birting",
  "settings.group.app.description": "Tungumál, útlit, mælieiningar og dagsetningar.",
  "settings.group.training.title": "Æfingar og næring",
  "settings.group.training.description": "Sjálfgefin gildi fyrir æfingar, hvíldartímamælir, æfingaáætlun og næring.",
  "settings.group.coaching.title": "Þjálfari og tilkynningar",
  "settings.group.coaching.description": "Æfingaaðstoð, áminningar og tilkynningar.",
  "settings.group.privacy.title": "Deiling og persónuvernd",
  "settings.group.privacy.description": "Deiling, sýnileiki og notkunarmælingar.",
  "settings.group.account.title": "Reikningur og gögn",
  "settings.group.account.description": "Reikningur, öryggisafrit, samstilling og upplýsingar um appið.",
  "settings.signOut": "Skrá út",
  "progress.consistencySummary": "Æfingar: {{workouts}} · önnur hreyfing: {{activities}} · vikur: {{weeks}}. Æfingar á viku að meðaltali: {{average}}.",
  "progress.proteinTrend": "Próteinmarkmið: {{target}} g. Dagar með skráningu: {{logged}}; markmiði náð: {{met}}. Meðaltal á skráðum dögum: {{average}} g. Dagar án próteinskráningar: {{noData}}. Þeir birtast án gagna, ekki sem núll."
}