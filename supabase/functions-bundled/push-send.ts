// supabase/functions/_shared/http.ts
var corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cleanup-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
var HttpError = class extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
  status;
  details;
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function handler(fn) {
  return async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
    try {
      return await fn(req);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, details: e.details ?? null }, e.status);
      console.error(e);
      return json({ error: "Something went wrong on the server. Please try again." }, 500);
    }
  };
}

// supabase/functions/_shared/supabase.ts
import { createClient } from "npm:@supabase/supabase-js@2";
function env(name) {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}
function supabaseUrl() {
  return env("SUPABASE_URL");
}
function serviceKeys() {
  const keys = [Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), Deno.env.get("SUPABASE_SECRET_KEY")];
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") keys.push(...Object.values(parsed));
    } catch {
      keys.push(raw);
    }
  }
  return keys.filter((k) => Boolean(k));
}
var admin = null;
function adminClient() {
  if (!admin) {
    const key = serviceKeys()[0];
    if (!key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SECRET_KEYS");
    admin = createClient(supabaseUrl(), key, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return admin;
}

// supabase/functions/_shared/i18n/messages.en.ts
var SHARED_EN = {
  "aiCard.meal.breakfast": "Breakfast",
  "aiCard.meal.dinner": "Dinner",
  "aiCard.meal.lunch": "Lunch",
  "aiCard.meal.snack": "Snack",
  "aiCard.quantity.can.one": "{{count}} can",
  "aiCard.quantity.can.other": "{{count}} cans",
  "aiCard.quantity.egg.one": "{{count}} egg",
  "aiCard.quantity.egg.other": "{{count}} eggs",
  "aiCard.quantity.pieces": "{{count}} pieces",
  "aiCard.side.amount": "{{amount}} {{food}}",
  "aiCard.side.chicken": "roast chicken breast",
  "aiCard.side.cottageCheese": "cottage cheese",
  "aiCard.side.edamame": "edamame beans",
  "aiCard.side.egg.one": "hard-boiled",
  "aiCard.side.egg.other": "hard-boiled",
  "aiCard.side.lentils": "cooked lentils",
  "aiCard.side.pieces.one": "{{amount}} ({{food}})",
  "aiCard.side.pieces.other": "{{amount}} ({{food}})",
  "aiCard.side.shrimp": "cooked prawns",
  "aiCard.side.skyr": "plain skyr",
  "aiCard.side.tempeh": "tempeh",
  "aiCard.side.tofu": "firm tofu",
  "aiCard.side.tuna": "tuna in water",
  "aiCard.side.yogurt": "fat-free Greek yogurt",
  "aiServer.allergen.celery": "Celery",
  "aiServer.allergen.egg": "Egg",
  "aiServer.allergen.fish": "Fish",
  "aiServer.allergen.gluten": "Gluten",
  "aiServer.allergen.milk": "Milk",
  "aiServer.allergen.mustard": "Mustard",
  "aiServer.allergen.peanuts": "Peanuts",
  "aiServer.allergen.sesame": "Sesame",
  "aiServer.allergen.shellfish": "Shellfish",
  "aiServer.allergen.soy": "Soy",
  "aiServer.allergen.tree_nuts": "Tree nuts",
  "aiServer.allergen.wheat": "Wheat",
  "aiServer.auth.signIn": "You need to be signed in.",
  "aiServer.blocker.autoTargetsDisabled": "Automatic nutrition targets are turned off for this user (under 18 or individualized guidance). Do not build a target-based meal plan; suggest a doctor or registered dietitian.",
  "aiServer.blocker.linkSettings": "Open Settings",
  "aiServer.blocker.linkTargets": "Set your targets",
  "aiServer.blocker.noProteinTarget": "No protein target is set. Tell the user to set targets first {{link}}.",
  "aiServer.blocker.nutritionDisabled": 'Nutrition features are turned off in the app. Tell the user to turn on "Nutrition features" in Settings \u2192 Plan & nutrition {{link}}.',
  "aiServer.blocker.nutritionNotShared": "Nutrition isn't shared with the training assistant. Tell the user they can share it under training assistant settings {{link}}.",
  "aiServer.constraints.causeAllergen": "avoiding {{allergen}}",
  "aiServer.constraints.causeDiet": "the {{diet}} setting",
  "aiServer.constraints.causeProtein": 'the proteins marked "not for me"',
  "aiServer.constraints.causeSkipped": "the skipped ingredients",
  "aiServer.constraints.causeTime": "the {{minutes}}-minute cooking limit",
  "aiServer.constraints.exclude.celery": "no Celery",
  "aiServer.constraints.exclude.egg": "no Egg",
  "aiServer.constraints.exclude.fish": "no Fish",
  "aiServer.constraints.exclude.gluten": "no Gluten",
  "aiServer.constraints.exclude.milk": "no Milk",
  "aiServer.constraints.exclude.mustard": "no Mustard",
  "aiServer.constraints.exclude.peanuts": "no Peanuts",
  "aiServer.constraints.exclude.sesame": "no Sesame",
  "aiServer.constraints.exclude.shellfish": "no Shellfish",
  "aiServer.constraints.exclude.soy": "no Soy",
  "aiServer.constraints.exclude.tree_nuts": "no Tree nuts",
  "aiServer.constraints.exclude.wheat": "no Wheat",
  "aiServer.constraints.maxTime": "\u2264 {{minutes}} min",
  "aiServer.constraints.noAllergen": "no {{allergen}}",
  "aiServer.constraints.noProtein": "no {{proteins}}",
  "aiServer.constraints.none": "no constraints",
  "aiServer.constraints.skipped.one": "{{count}} skipped ingredient",
  "aiServer.constraints.skipped.other": "{{count}} skipped ingredients",
  "aiServer.context.exerciseFallback": "Exercise",
  "aiServer.context.explainActive": "Explain this: why does the app suggest \u201C{{shownTarget}}\u201D for {{exerciseName}} today?",
  "aiServer.context.explainActiveGeneric": "Explain this: how is today\u2019s workout going, and what should I aim for next?",
  "aiServer.context.explainCompleted": "Explain this: why is my next target for {{exerciseName}} \u201C{{shownTarget}}\u201D?",
  "aiServer.context.explainCompletedGeneric": "Explain this: what do my next targets from this workout mean?",
  "aiServer.context.explainExercise": "Explain this: how should I approach {{exerciseName}} today, and why?",
  "aiServer.context.shorten": "Short on time: I have about {{minutes}} minutes left. Please shorten the rest of today\u2019s workout ({{sessionName}}).",
  "aiServer.context.swap": "Equipment busy: the equipment for {{exerciseName}} is taken. What can I do instead, just for today?",
  "aiServer.context.thisExercise": "this exercise",
  "aiServer.diet.dairy_free": "Dairy-free",
  "aiServer.diet.gluten_free": "Gluten-free",
  "aiServer.diet.high_protein": "High protein",
  "aiServer.diet.pescatarian": "Pescatarian",
  "aiServer.diet.vegan": "Vegan",
  "aiServer.diet.vegetarian": "Vegetarian",
  "aiServer.error.consentRequired": "The training assistant now uses {{provider}}. Review what\u2019s sent and agree again in training assistant setup.",
  "aiServer.error.dailyLimit": "You\u2019ve reached today\u2019s training assistant limit.",
  "aiServer.error.disabled": "The training assistant is turned off. Turn it on in training assistant settings.",
  "aiServer.error.emptyMessage": "Write a message first.",
  "aiServer.error.inProgress": "Still answering this message. It will appear in a moment.",
  "aiServer.error.invalidMessageId": "A valid message id is required.",
  "aiServer.error.messageTooLong": "Messages can be at most {{max}} characters.",
  "aiServer.error.notConfigured": "The training assistant is not configured on this server.",
  "aiServer.error.paused": "The training assistant is paused. Resume it in training assistant settings.",
  "aiServer.error.unknownAction": "Unknown action.",
  "aiServer.mealPlan.allExcludedNext": "Every day left in next week is one you asked to leave out.",
  "aiServer.mealPlan.allExcludedThis": "Every day left in this week is one you asked to leave out.",
  "aiServer.mealPlan.conflictingMeal": "The planner produced a meal that conflicts with the user's settings; nothing was offered.",
  "aiServer.mealPlan.conflictingSide": "The planner produced a side that conflicts with the user's settings; nothing was offered.",
  "aiServer.mealPlan.dateRange": "{{start}} to {{end}}",
  "aiServer.mealPlan.daysUnavailableNext": "None of those days are left in next week ({{start}} to {{end}}).",
  "aiServer.mealPlan.daysUnavailableThis": "None of those days are left in this week ({{start}} to {{end}}).",
  "aiServer.mealPlan.noDays": "No days are left this week; ask for next week instead.",
  "aiServer.mealPlan.slow.one": "{{count}} meal take longer than {{minutes}} minutes.",
  "aiServer.mealPlan.slow.other": "{{count}} meals take longer than {{minutes}} minutes.",
  "aiServer.mealPlan.summary.one": "Here's your meal plan for {{span}} ({{count}} day) \u2014 tap **Add to my meal plan** to put it in the app.",
  "aiServer.mealPlan.summary.other": "Here's your meal plan for {{span}} ({{count}} days) \u2014 tap **Add to my meal plan** to put it in the app.",
  "aiServer.mealPlan.thisWeek": "this week",
  "aiServer.mealPlan.timeRelaxed": "No {{slot}} recipe fits {{minutes}} minutes, so some take longer.",
  "aiServer.mealSlotFor.breakfast": "breakfast",
  "aiServer.mealSlotFor.dinner": "dinner",
  "aiServer.mealSlotFor.lunch": "lunch",
  "aiServer.mealSlotFor.snack": "snack",
  "aiServer.proposal.addReview": "I've drafted {{plan}} \u2014 tap **Add to my program \u2014 review** to preview and add it.",
  "aiServer.proposal.coachReview": "I've drafted {{plan}} as a suggestion for your coach to review.",
  "aiServer.proposal.invalid": "I couldn\u2019t build a plan that fits your equipment and settings this time \u2014 tell me what to change and I\u2019ll try again.",
  "aiServer.proposal.schedule.one": "**{{name}}** ({{count}} session a week)",
  "aiServer.proposal.schedule.other": "**{{name}}** ({{count}} sessions a week)",
  "aiServer.protein.beans_lentils": "Beans & lentils",
  "aiServer.protein.beef": "Beef",
  "aiServer.protein.chicken": "Chicken",
  "aiServer.protein.chickpeas": "Chickpeas",
  "aiServer.protein.dairy": "Dairy",
  "aiServer.protein.eggs": "Eggs",
  "aiServer.protein.lamb": "Lamb",
  "aiServer.protein.oily_fish": "Salmon & oily fish",
  "aiServer.protein.plant_protein": "Plant protein powder",
  "aiServer.protein.pork": "Pork & ham",
  "aiServer.protein.prawns": "Prawns",
  "aiServer.protein.shellfish": "Other shellfish",
  "aiServer.protein.tofu_tempeh": "Tofu & tempeh",
  "aiServer.protein.tuna": "Tuna",
  "aiServer.protein.turkey": "Turkey",
  "aiServer.protein.whey": "Whey protein",
  "aiServer.protein.white_fish": "White fish",
  "aiServer.recipes.noMatch": "Nothing in the catalog fits {{constraints}}.",
  "aiServer.recipes.noMatchCauses": "Nothing in the catalog fits {{constraints}}. It's {{causes}} that rules everything out.",
  "aiServer.recipes.one": "Here is a recipe that fit \u2014 tap one to open it.",
  "aiServer.recipes.other": "Here are {{count}} recipes that fit \u2014 tap one to open it.",
  "aiServer.reply.empty": "Sorry \u2014 I couldn\u2019t put together a reply. Please try asking again.",
  "aiServer.reply.mealPlanFailed": "I couldn't build that meal plan with what you asked for: {{reason}}",
  "aiServer.reply.sharingAcknowledged": "Thanks \u2014 I can see your {{scopes}} now.",
  "aiServer.scope.measurements": "Measurements",
  "aiServer.scope.nutrition": "Nutrition",
  "aiServer.scope.profile": "Profile & preferences",
  "aiServer.scope.training": "Training",
  "aiServer.session.allDone": "Every set is already done: nothing left to shorten.",
  "aiServer.session.alreadyFinished": "This workout is already finished; there is nothing left to change today.",
  "aiServer.session.alreadyFits": "What is left (about {{remaining}} min) already fits in {{minutes}} minutes: no change needed. Tell the user they can finish as planned.",
  "aiServer.session.alreadyLater": "{{exerciseName}} is already later in today's workout; pick another.",
  "aiServer.session.askMinutes": 'minutes is required for "shorten" (ask the user how long they have).',
  "aiServer.session.canFinishHere": "Less than one more set fits in that time. Finishing here is a good session too.",
  "aiServer.session.completedSetsStay.one": "Sets you already did stay with {{fromName}}; the remaining {{count}} move to {{toName}}.",
  "aiServer.session.completedSetsStay.other": "Sets you already did stay with {{fromName}}; the remaining {{count}} move to {{toName}}.",
  "aiServer.session.customExercise": "{{exerciseName}} is a custom exercise, so a swap can't be checked here. Suggest one in text; the user can use Swap exercise.",
  "aiServer.session.estimate": " (about {{minutes}} min left)",
  "aiServer.session.excluded": "{{exerciseName}} is on the user's excluded list.",
  "aiServer.session.exerciseDone": "Every set of {{exerciseName}} is already done: nothing to swap.",
  "aiServer.session.fewerSets.one": "{{count}} fewer set",
  "aiServer.session.fewerSets.other": "{{count}} fewer sets",
  "aiServer.session.limitedArea": "{{exerciseName}} loads an area the user asked to go easy on ({{areas}}); pick another.",
  "aiServer.session.missingEquipment": "{{exerciseName}} needs equipment the user doesn't have ({{equipment}}).",
  "aiServer.session.noChanges": "no changes",
  "aiServer.session.noSnapshot": 'No workout snapshot came with this message: this tool only works from the workout screen ("Short on time" / "Equipment busy").',
  "aiServer.session.notAlternative": "{{toName}} isn't an alternative for {{fromName}}: pick a listed substitution or the same movement pattern for the same muscles (call exercise_alternatives).",
  "aiServer.session.sameExercise": "The replacement is the same exercise.",
  "aiServer.session.shortenSummary": "A shorter workout for today: {{changes}}{{estimate}}. Tap Apply to today's workout to use it. Your plan stays the same.",
  "aiServer.session.skipExercises": "skip {{names}}",
  "aiServer.session.swapSummary": "For today: {{toName}} instead of {{fromName}}. Tap Apply to today's workout to make the swap. Your plan stays the same.",
  "aiServer.session.trainingNotShared": "Training isn't shared, so the workout can't be changed from here.",
  "aiServer.week.allDone": "Everything planned this week is already done.",
  "aiServer.week.alreadyCompleted.one": "The user already completed {{count}} workout this week; total_sessions_this_week counts those, so it must be at least {{count}}.",
  "aiServer.week.alreadyCompleted.other": "The user already completed {{count}} workouts this week; total_sessions_this_week counts those, so it must be at least {{count}}.",
  "aiServer.week.alreadyTrained": "The user already trained on {{date}}; pick another day.",
  "aiServer.week.apply": "Tap **Apply to this week** to use it.",
  "aiServer.week.body": "Here's this week: {{changes}}.",
  "aiServer.week.consecutiveDays": "Back-to-back days ({{dates}}): keep the effort a little lower on the second.",
  "aiServer.week.countInvalid": "total_sessions_this_week must be a whole number 0\u20137.",
  "aiServer.week.invalidDate": 'Date "{{date}}" must be between {{start}} and {{end}} (today or later, this week only).',
  "aiServer.week.moves": "**{{name}}** moves to {{date}}",
  "aiServer.week.noActivePlan": "The user has no active plan to adjust.",
  "aiServer.week.notShared": "Training data is not shared, so this week cannot be planned. Answer in text and suggest sharing Training in training assistant settings.",
  "aiServer.week.notUsualDay": "{{date}} is not one of your usual training days.",
  "aiServer.week.skipped.one": "{{names}} is skipped this week",
  "aiServer.week.skipped.other": "{{names}} are skipped this week",
  "aiServer.week.stays": "**{{name}}** stays on {{date}}",
  "aiServer.week.twoOnSameDay": "Two sessions on {{date}}; use one session per day.",
  "progression.action.add_reps": "Add reps",
  "progression.action.calibrate": "Calibrate",
  "progression.action.discomfort_hold": "No increase",
  "progression.action.hold": "Hold",
  "progression.action.increase_distance": "Further",
  "progression.action.increase_duration": "Longer",
  "progression.action.increase_load": "Increase load",
  "progression.action.reduce_assistance": "Less assistance",
  "progression.action.review_recovery": "Review recovery",
  "progression.addedLoad": "+{{load}}",
  "progression.alternatives": "See alternatives",
  "progression.apply": "Apply",
  "progression.assistance": "{{load}} assistance",
  "progression.bodyweight": "bodyweight",
  "progression.calibrate": "find your starting load",
  "progression.chooseTargets": "Choose targets for the remaining sets",
  "progression.confirmEffort": "Effort wasn\u2019t logged. Did those sets feel like about {{rir}} reps left in the tank? If yes, apply; if not, keep previous.",
  "progression.customize": "Customize",
  "progression.effort.notRecorded": "Effort wasn\u2019t logged, so this is based on reps and load only. Increase only if those sets felt like about {{rir}} reps left in the tank.",
  "progression.effort.partial": "Effort was logged for only some sets. Increase only if they felt like about {{rir}} reps left in the tank.",
  "progression.effort.recorded": "Effort was at the target level.",
  "progression.effortCaveat": "Effort wasn\u2019t logged: increase only if those sets felt like about {{rir}} reps left in the tank.",
  "progression.hide": "Hide",
  "progression.hideAria": "Hide this tip (your sets stay as they are)",
  "progression.keepPrevious": "Keep previous",
  "progression.less": "Less",
  "progression.metres": "{{metres}} m",
  "progression.next": "Next: {{target}}",
  "progression.reason.addReps": "Aim for one more rep on your lowest sets until every set reaches {{repMax}}.",
  "progression.reason.addRepsLoaded": "Same load ({{load}}); aim for one more rep on your lowest sets until every set reaches {{repMax}}.",
  "progression.reason.addRepsSameLoad": "Same load; aim for one more rep on your lowest sets until every set reaches {{repMax}}.",
  "progression.reason.assistedAddReps": "Same assistance; aim for one more rep on your lowest sets until every set reaches {{repMax}}.",
  "progression.reason.assistedHold": "Keep the same assistance and aim for {{repMin}} reps on every set.",
  "progression.reason.confirmTop": "Top of the range on every set. Repeat this load once more to confirm, then we\u2019ll suggest an increase.",
  "progression.reason.decline": "Performance has dipped over your last {{sessions}} sessions. Consider sleep, stress and food, or reduce workload for a week (for example one fewer set or a slightly lighter load).",
  "progression.reason.discomfort": "You flagged discomfort recently, so we won\u2019t suggest an increase. Keep it comfortable, use less load, or try an alternative exercise. If pain persists, consider a qualified professional.",
  "progression.reason.firstLoad": "No known load yet: start light and add small jumps until a set of {{repMin}}\u2013{{repMax}} feels like about {{rir}} reps left in the tank. Log that as your starting load.",
  "progression.reason.firstReps": "First time: stop each set with about {{rir}} reps left in the tank and log your reps. We\u2019ll build from there.",
  "progression.reason.firstTime": "First time: do what feels comfortable and log it. We\u2019ll build from there.",
  "progression.reason.harderVariation": "You\u2019ve reached {{repMax}} reps on every set twice. Ready for a harder variation or a little added load, or keep adding reps if you prefer.",
  "progression.reason.holdDistance": "Keep the same distance until it feels comfortable on every set.",
  "progression.reason.holdDuration": "Aim for {{seconds}} s on every set with good form.",
  "progression.reason.holdLoad": "Hold the load and aim for at least {{repMin}} reps on all {{sets}} sets.",
  "progression.reason.increaseDistance": "Completed twice: add about 10 % distance while keeping the same comfortable effort.",
  "progression.reason.increaseDuration": "You held {{seconds}} s on every set twice. Try {{nextSeconds}} s.",
  "progression.reason.increaseLoadedBeginner": "You reached {{repMax}} reps on all {{sets}} sets at {{load}} in your last session (beginner rule: one successful session is enough). Try {{nextLoad}} and aim for {{repMin}} reps, then build back up.",
  "progression.reason.increaseLoadedStandard": "You reached {{repMax}} reps on all {{sets}} sets at {{load}} in two sessions. Try {{nextLoad}} and aim for {{repMin}} reps, then build back up.",
  "progression.reason.increaseUnloadedBeginner": "You reached {{repMax}} reps on all {{sets}} sets in your last session (beginner rule: one successful session is enough). Try adding {{nextLoad}} and aim for {{repMin}} reps, then build back up.",
  "progression.reason.increaseUnloadedStandard": "You reached {{repMax}} reps on all {{sets}} sets in two sessions. Try adding {{nextLoad}} and aim for {{repMin}} reps, then build back up.",
  "progression.reason.logAssistance": "Log the assistance you use. Enough that sets end with about 2\u20133 reps left in the tank.",
  "progression.reason.logDuration": "Keep logging your times. We\u2019ll build from there.",
  "progression.reason.missingLoad": "No load logged last time. Pick a weight that leaves about 2\u20133 reps in the tank and log it.",
  "progression.reason.reduceAssistanceBeginner": "Top of the range in your last session (beginner rule) with {{load}} assistance. Use less assistance ({{nextLoad}}) and aim for {{repMin}} reps. Less help is progress.",
  "progression.reason.reduceAssistanceStandard": "Top of the range twice with {{load}} assistance. Use less assistance ({{nextLoad}}) and aim for {{repMin}} reps. Less help is progress.",
  "progression.reason.unassisted": "You\u2019ve outgrown the assistance. Try the unassisted version (or the lightest band) and aim for the bottom of the range.",
  "progression.reps.one": "{{count}} rep",
  "progression.reps.other": "{{count}} reps",
  "progression.rule.beginner": "Progression: because you\u2019re new to lifting (or returning), one good session is enough. When you reach the top of the rep range on every set at the target effort (if you don\u2019t log effort, we ask you to confirm it first), we suggest the smallest practical load increase and you start again near the bottom of the range. If you change your experience level to intermediate or advanced, the app waits for two such sessions in a row.",
  "progression.rule.standard": "Progression uses double progression: when you reach the top of the rep range on every set at the target effort in two sessions (if you don\u2019t log effort, we ask you to confirm it first), we suggest the smallest practical load increase and you start again near the bottom of the range.",
  "progression.seconds": "{{seconds}} s",
  "progression.suggestion": "Progression suggestion",
  "progression.why": "Why?",
  "push.coachFood.body": "Want to update your food log? Do it whenever it suits you.",
  "push.coachFood.title": "Hard Earned",
  "push.coachMissed.body": "Plans change. Open Today and choose what works for you.",
  "push.coachMissed.title": "Hard Earned",
  "push.coachWorkout.body": "When it suits you, open Today to see your workout.",
  "push.coachWorkout.title": "Hard Earned",
  "workout.meta.equipment.band": "Band",
  "workout.meta.equipment.barbell": "Barbell",
  "workout.meta.equipment.bench": "Bench",
  "workout.meta.equipment.bodyweight": "Bodyweight",
  "workout.meta.equipment.cable": "Cable",
  "workout.meta.equipment.cardio_machine": "Cardio machine",
  "workout.meta.equipment.dip_station": "Dip station",
  "workout.meta.equipment.dumbbell": "Dumbbells",
  "workout.meta.equipment.ez_bar": "EZ bar",
  "workout.meta.equipment.kettlebell": "Kettlebell",
  "workout.meta.equipment.machine": "Machine",
  "workout.meta.equipment.pullup_bar": "Pull-up bar",
  "workout.meta.equipment.rack": "Rack",
  "workout.meta.equipment.smith": "Smith machine",
  "workout.meta.limitation.ankle": "Ankles",
  "workout.meta.limitation.elbow": "Elbows",
  "workout.meta.limitation.hip": "Hips",
  "workout.meta.limitation.knee": "Knees",
  "workout.meta.limitation.lower_back": "Lower back",
  "workout.meta.limitation.neck": "Neck",
  "workout.meta.limitation.shoulder": "Shoulders",
  "workout.meta.limitation.wrist": "Wrists",
  "workout.validation.distanceLong": "That distance looks too long.",
  "workout.validation.distanceNonnegative": "Distance must be zero or more.",
  "workout.validation.distanceOrTime": "Enter a distance or a time.",
  "workout.validation.enterAddedWeight": "Enter the added weight (0 for none).",
  "workout.validation.enterAssistance": "Enter the assistance (0 for none).",
  "workout.validation.enterNumber": "Enter a number.",
  "workout.validation.enterPerformance": "Enter reps, time or distance.",
  "workout.validation.enterWeight": "Enter the weight used.",
  "workout.validation.exerciseIndex": "Exercise {{index}}",
  "workout.validation.maximum": "Must be {{max}} or less.",
  "workout.validation.minimum": "Must be at least {{min}}.",
  "workout.validation.missingSets": "Exercise {{index}}: missing sets.",
  "workout.validation.noExerciseList": "Session has no exercise list.",
  "workout.validation.nonnegative": "Must be zero or more.",
  "workout.validation.notSession": "Not a workout session.",
  "workout.validation.oneRep": "Enter at least 1 rep.",
  "workout.validation.positiveTime": "Enter a time above 0.",
  "workout.validation.repsHigh": "That rep count looks too high.",
  "workout.validation.repsNonnegative": "Reps must be zero or more.",
  "workout.validation.rirRange": "RIR must be between 0 and 10.",
  "workout.validation.rpeRange": "RPE must be between 1 and 10.",
  "workout.validation.setErrors": "{{exercise}}, set {{index}}: {{errors}}",
  "workout.validation.timeLong": "That time looks too long.",
  "workout.validation.timeNonnegative": "Time must be zero or more.",
  "workout.validation.weightHigh": "That weight looks too high.",
  "workout.validation.weightNonnegative": "Weight must be zero or more.",
  "workout.validation.wholeNumber": "Use a whole number.",
  "workout.validation.wholeReps": "Reps must be a whole number."
};

// supabase/functions/_shared/i18n/messages.is.ts
var SHARED_IS = {
  "aiCard.meal.breakfast": "Morgunmatur",
  "aiCard.meal.dinner": "Kv\xF6ldmatur",
  "aiCard.meal.lunch": "H\xE1degismatur",
  "aiCard.meal.snack": "Millim\xE1l",
  "aiCard.quantity.can.one": "{{count}} d\xF3s",
  "aiCard.quantity.can.other": "{{count}} d\xF3sir",
  "aiCard.quantity.egg.one": "{{count}} egg",
  "aiCard.quantity.egg.other": "{{count}} egg",
  "aiCard.quantity.pieces": "{{count}} stk.",
  "aiCard.side.amount": "{{food}}: {{amount}}",
  "aiCard.side.chicken": "steikt kj\xFAklingabringa",
  "aiCard.side.cottageCheese": "kotas\xE6la",
  "aiCard.side.edamame": "edamame-baunir",
  "aiCard.side.egg.one": "har\xF0so\xF0i\xF0 egg",
  "aiCard.side.egg.other": "har\xF0so\xF0in egg",
  "aiCard.side.lentils": "so\xF0nar linsubaunir",
  "aiCard.side.pieces.one": "{{food}}: {{amount}}",
  "aiCard.side.pieces.other": "{{food}}: {{amount}}",
  "aiCard.side.shrimp": "so\xF0nar r\xE6kjur",
  "aiCard.side.skyr": "hreint skyr",
  "aiCard.side.tempeh": "tempeh",
  "aiCard.side.tofu": "stinnt t\xF3f\xFA",
  "aiCard.side.tuna": "t\xFAnfiskur \xED vatni",
  "aiCard.side.yogurt": "fitulaus gr\xEDsk j\xF3g\xFArt",
  "aiServer.allergen.celery": "Seller\xED",
  "aiServer.allergen.egg": "Egg",
  "aiServer.allergen.fish": "Fiskur",
  "aiServer.allergen.gluten": "Gl\xFAten",
  "aiServer.allergen.milk": "Mj\xF3lk",
  "aiServer.allergen.mustard": "Sinnep",
  "aiServer.allergen.peanuts": "Jar\xF0hnetur",
  "aiServer.allergen.sesame": "Sesam",
  "aiServer.allergen.shellfish": "Skelfiskur",
  "aiServer.allergen.soy": "Soja",
  "aiServer.allergen.tree_nuts": "Trj\xE1hnetur",
  "aiServer.allergen.wheat": "Hveiti",
  "aiServer.auth.signIn": "\xDE\xFA \xFEarft a\xF0 skr\xE1 \xFEig inn.",
  "aiServer.blocker.autoTargetsDisabled": "Sl\xF6kkt er \xE1 sj\xE1lfvirkum n\xE6ringarmarkmi\xF0um hj\xE1 \xFE\xE9r, svo \xE9g get ekki b\xFAi\xF0 til matse\xF0il \xFAt fr\xE1 \xFEeim. F\xE1\xF0u lei\xF0s\xF6gn hj\xE1 l\xE6kni e\xF0a n\xE6ringarfr\xE6\xF0ingi.",
  "aiServer.blocker.linkSettings": "Opna stillingar",
  "aiServer.blocker.linkTargets": "Stilla markmi\xF0",
  "aiServer.blocker.noProteinTarget": "Pr\xF3teinmarkmi\xF0 hefur ekki veri\xF0 stillt. Stilltu markmi\xF0in fyrst. {{link}}",
  "aiServer.blocker.nutritionDisabled": "Sl\xF6kkt er \xE1 n\xE6ringareiginleikum. \xDE\xFA getur kveikt \xE1 \xFEeim \xED Stillingar \u2192 \xC1\xE6tlun og n\xE6ring. {{link}}",
  "aiServer.blocker.nutritionNotShared": "\xDE\xFA deilir ekki n\xE6ringarg\xF6gnum me\xF0 \xC6fingaa\xF0sto\xF0. \xDE\xFA getur breytt \xFEv\xED \xED stillingum \xC6fingaa\xF0sto\xF0ar. {{link}}",
  "aiServer.constraints.causeAllergen": "a\xF0 sleppa \xFEessum ofn\xE6misvaldi: {{allergen}}",
  "aiServer.constraints.causeDiet": "matar\xE6\xF0isstillingin \u201E{{diet}}\u201C",
  "aiServer.constraints.causeProtein": "pr\xF3teingjafarnir sem \xFE\xFA vilt sleppa",
  "aiServer.constraints.causeSkipped": "hr\xE1efnin sem \xFE\xFA vilt sleppa",
  "aiServer.constraints.causeTime": "t\xEDmam\xF6rkin, {{minutes}} m\xEDn\xFAtur",
  "aiServer.constraints.exclude.celery": "\xE1n seller\xEDs",
  "aiServer.constraints.exclude.egg": "\xE1n eggja",
  "aiServer.constraints.exclude.fish": "\xE1n fisks",
  "aiServer.constraints.exclude.gluten": "\xE1n gl\xFAtens",
  "aiServer.constraints.exclude.milk": "\xE1n mj\xF3lkur",
  "aiServer.constraints.exclude.mustard": "\xE1n sinneps",
  "aiServer.constraints.exclude.peanuts": "\xE1n jar\xF0hneta",
  "aiServer.constraints.exclude.sesame": "\xE1n sesams",
  "aiServer.constraints.exclude.shellfish": "\xE1n skelfisks",
  "aiServer.constraints.exclude.soy": "\xE1n soja",
  "aiServer.constraints.exclude.tree_nuts": "\xE1n trj\xE1hneta",
  "aiServer.constraints.exclude.wheat": "\xE1n hveitis",
  "aiServer.constraints.maxTime": "\u2264 {{minutes}} m\xEDn.",
  "aiServer.constraints.noAllergen": "Sleppa: {{allergen}}",
  "aiServer.constraints.noProtein": "\xFEessir pr\xF3teingjafar undanskildir: {{proteins}}",
  "aiServer.constraints.none": "engar takmarkanir",
  "aiServer.constraints.skipped.one": "{{count}} hr\xE1efni sleppt",
  "aiServer.constraints.skipped.other": "{{count}} hr\xE1efnum sleppt",
  "aiServer.context.exerciseFallback": "\xC6fing",
  "aiServer.context.explainActive": "\xDAtsk\xFDr\xF0u \xFEetta: Af hverju leggur appi\xF0 til \u201E{{shownTarget}}\u201C \xED dag fyrir \xFEessa \xE6fingu: {{exerciseName}}?",
  "aiServer.context.explainActiveGeneric": "\xDAtsk\xFDr\xF0u \xFEetta: Hvernig gengur \xE6fingin \xED dag og a\xF0 hverju \xE6tti \xE9g a\xF0 stefna n\xE6st?",
  "aiServer.context.explainCompleted": "\xDAtsk\xFDr\xF0u \xFEetta: Af hverju er n\xE6sta markmi\xF0 \u201E{{shownTarget}}\u201C \xED \xFEessari \xE6fingu: {{exerciseName}}?",
  "aiServer.context.explainCompletedGeneric": "\xDAtsk\xFDr\xF0u \xFEetta: Hva\xF0 \xFE\xFD\xF0a n\xE6stu markmi\xF0 eftir \xFEessa \xE6fingu?",
  "aiServer.context.explainExercise": "\xDAtsk\xFDr\xF0u \xFEetta: Hvernig \xE6tti \xE9g a\xF0 haga \xFEessari \xE6fingu \xED dag og af hverju? \xC6fing: {{exerciseName}}.",
  "aiServer.context.shorten": "L\xEDtill t\xEDmi: \xC9g hef um {{minutes}} m\xEDn\xFAtur eftir. Styttu \xFEa\xF0 sem er eftir af \xE6fingunni \xED dag ({{sessionName}}).",
  "aiServer.context.swap": "B\xFAna\xF0ur upptekinn: \xC9g kemst ekki \xED b\xFAna\xF0inn fyrir \xFEessa \xE6fingu: {{exerciseName}}. Hva\xF0 get \xE9g gert \xED sta\xF0inn, bara \xED dag?",
  "aiServer.context.thisExercise": "\xFEessa \xE6fingu",
  "aiServer.diet.dairy_free": "\xC1n mj\xF3lkurvara",
  "aiServer.diet.gluten_free": "Gl\xFAtenlaust",
  "aiServer.diet.high_protein": "Pr\xF3teinr\xEDkt",
  "aiServer.diet.pescatarian": "Gr\xE6nmetisf\xE6\xF0i me\xF0 fiski",
  "aiServer.diet.vegan": "Vegan",
  "aiServer.diet.vegetarian": "Gr\xE6nmetisf\xE6\xF0i",
  "aiServer.error.consentRequired": "\xC6fingaa\xF0sto\xF0 notar n\xFA {{provider}}. Far\xF0u yfir hva\xF0a g\xF6gn ver\xF0a send og sta\xF0festu sam\xFEykki \xFEitt aftur \xED uppsetningu \xC6fingaa\xF0sto\xF0ar.",
  "aiServer.error.dailyLimit": "\xDE\xFA hefur n\xE1\xF0 daglegu h\xE1marki skilabo\xF0a \xED \xC6fingaa\xF0sto\xF0.",
  "aiServer.error.disabled": "Sl\xF6kkt er \xE1 \xC6fingaa\xF0sto\xF0. Kveiktu \xE1 henni \xED stillingum \xC6fingaa\xF0sto\xF0ar.",
  "aiServer.error.emptyMessage": "Skrifa\xF0u skilabo\xF0 fyrst.",
  "aiServer.error.inProgress": "Enn er veri\xF0 a\xF0 svara \xFEessum skilabo\xF0um. Svari\xF0 birtist eftir augnablik.",
  "aiServer.error.invalidMessageId": "Ekki t\xF3kst a\xF0 senda skilabo\xF0in. Reyndu aftur.",
  "aiServer.error.messageTooLong": "Skilabo\xF0 mega vera a\xF0 h\xE1marki {{max}} stafir.",
  "aiServer.error.notConfigured": "\xC6fingaa\xF0sto\xF0 er ekki tilt\xE6k eins og er.",
  "aiServer.error.paused": "\xC6fingaa\xF0sto\xF0 er \xED bi\xF0. Virkja\xF0u hana aftur \xED stillingum \xC6fingaa\xF0sto\xF0ar.",
  "aiServer.error.unknownAction": "\xD3\xFEekkt a\xF0ger\xF0.",
  "aiServer.mealPlan.allExcludedNext": "\xDE\xFA ba\xF0st um a\xF0 sleppa \xF6llum d\xF6gunum \xED n\xE6stu viku.",
  "aiServer.mealPlan.allExcludedThis": "\xDE\xFA ba\xF0st um a\xF0 sleppa \xF6llum d\xF6gunum sem eru eftir \xED \xFEessari viku.",
  "aiServer.mealPlan.conflictingMeal": "M\xE1lt\xED\xF0in uppfyllti ekki stillingarnar \xFE\xEDnar, svo engin tillaga var birt.",
  "aiServer.mealPlan.conflictingSide": "Me\xF0l\xE6ti\xF0 uppfyllti ekki stillingarnar \xFE\xEDnar, svo engin tillaga var birt.",
  "aiServer.mealPlan.dateRange": "{{start}} til {{end}}",
  "aiServer.mealPlan.daysUnavailableNext": "Enginn \xFEessara daga er \xED n\xE6stu viku ({{start}} til {{end}}).",
  "aiServer.mealPlan.daysUnavailableThis": "Enginn \xFEessara daga er eftir \xED \xFEessari viku ({{start}} til {{end}}).",
  "aiServer.mealPlan.noDays": "Engir dagar eru eftir \xED \xFEessari viku. Biddu um matse\xF0il fyrir n\xE6stu viku.",
  "aiServer.mealPlan.slow.one": "{{count}} m\xE1lt\xED\xF0 tekur lengri t\xEDma en {{minutes}} m\xEDn\xFAtur.",
  "aiServer.mealPlan.slow.other": "{{count}} m\xE1lt\xED\xF0ir taka lengri t\xEDma en {{minutes}} m\xEDn\xFAtur.",
  "aiServer.mealPlan.summary.one": "H\xE9r er matse\xF0ill fyrir {{count}} dag ({{span}}). \xDDttu \xE1 **B\xE6ta vi\xF0 matse\xF0ilinn minn** til a\xF0 vista hann \xED appinu.",
  "aiServer.mealPlan.summary.other": "H\xE9r er matse\xF0ill fyrir {{count}} daga ({{span}}). \xDDttu \xE1 **B\xE6ta vi\xF0 matse\xF0ilinn minn** til a\xF0 vista hann \xED appinu.",
  "aiServer.mealPlan.thisWeek": "\xFEessa viku",
  "aiServer.mealPlan.timeRelaxed": "Engin uppskrift fyrir {{slot}} r\xFAmast innan {{minutes}} m\xEDn\xFAtna, svo sumar taka lengri t\xEDma.",
  "aiServer.mealSlotFor.breakfast": "morgunmat",
  "aiServer.mealSlotFor.dinner": "kv\xF6ldmat",
  "aiServer.mealSlotFor.lunch": "h\xE1degismat",
  "aiServer.mealSlotFor.snack": "millim\xE1l",
  "aiServer.proposal.addReview": "\xC9g hef sett saman \xFEessa till\xF6gu: {{plan}}. \xDDttu \xE1 **Sko\xF0a \xE1\xF0ur en b\xE6tt er vi\xF0 \xE6finga\xE1\xE6tlun** til a\xF0 fara yfir hana.",
  "aiServer.proposal.coachReview": "\xC9g hef sett saman \xFEessa till\xF6gu fyrir \xFEj\xE1lfarann \xFEinn til yfirfer\xF0ar: {{plan}}.",
  "aiServer.proposal.invalid": "\xC9g n\xE1\xF0i ekki a\xF0 b\xFAa til \xE6finga\xE1\xE6tlun sem passar vi\xF0 b\xFAna\xF0inn \xFEinn og stillingar. Seg\xF0u m\xE9r hverju m\xE1 breyta og \xE9g reyni aftur.",
  "aiServer.proposal.schedule.one": "**{{name}}** ({{count}} \xE6fing \xE1 viku)",
  "aiServer.proposal.schedule.other": "**{{name}}** ({{count}} \xE6fingar \xE1 viku)",
  "aiServer.protein.beans_lentils": "Baunir og linsubaunir",
  "aiServer.protein.beef": "Nautakj\xF6t",
  "aiServer.protein.chicken": "Kj\xFAklingur",
  "aiServer.protein.chickpeas": "Kj\xFAklingabaunir",
  "aiServer.protein.dairy": "Mj\xF3lkurv\xF6rur",
  "aiServer.protein.eggs": "Egg",
  "aiServer.protein.lamb": "Lambakj\xF6t",
  "aiServer.protein.oily_fish": "Lax og feitur fiskur",
  "aiServer.protein.plant_protein": "Jurtapr\xF3teinduft",
  "aiServer.protein.pork": "Sv\xEDnakj\xF6t og skinka",
  "aiServer.protein.prawns": "R\xE6kjur",
  "aiServer.protein.shellfish": "Annar skelfiskur",
  "aiServer.protein.tofu_tempeh": "T\xF3f\xFA og tempeh",
  "aiServer.protein.tuna": "T\xFAnfiskur",
  "aiServer.protein.turkey": "Kalk\xFAnn",
  "aiServer.protein.whey": "Mysupr\xF3tein",
  "aiServer.protein.white_fish": "Hv\xEDtur fiskur",
  "aiServer.recipes.noMatch": "Engin uppskrift \xED safninu uppfyllir \xFEessar kr\xF6fur: {{constraints}}.",
  "aiServer.recipes.noMatchCauses": "Engin uppskrift \xED safninu uppfyllir \xFEessar kr\xF6fur: {{constraints}}. \xDEa\xF0 sem \xFAtilokar uppskriftirnar er: {{causes}}.",
  "aiServer.recipes.one": "H\xE9r er uppskrift sem passar. \xDDttu \xE1 hana til a\xF0 opna hana.",
  "aiServer.recipes.other": "H\xE9r eru {{count}} uppskriftir sem passa. \xDDttu \xE1 uppskrift til a\xF0 opna hana.",
  "aiServer.reply.empty": "\xDEv\xED mi\xF0ur t\xF3kst m\xE9r ekki a\xF0 svara. Pr\xF3fa\xF0u a\xF0 spyrja aftur.",
  "aiServer.reply.mealPlanFailed": "\xC9g n\xE1\xF0i ekki a\xF0 b\xFAa til matse\xF0il sem uppfyllir \xF3skirnar \xFE\xEDnar: {{reason}}",
  "aiServer.reply.sharingAcknowledged": "Takk, n\xFA hef \xE9g a\xF0gang a\xF0 \xFEessum g\xF6gnum: {{scopes}}.",
  "aiServer.scope.measurements": "M\xE6lingar",
  "aiServer.scope.nutrition": "N\xE6ring",
  "aiServer.scope.profile": "Pr\xF3f\xEDll og \xF3skir",
  "aiServer.scope.training": "\xC6fingar",
  "aiServer.session.allDone": "\xD6llum settum er loki\xF0. \xDEa\xF0 er ekkert eftir til a\xF0 stytta.",
  "aiServer.session.alreadyFinished": "\xDEessari \xE6fingu er \xFEegar loki\xF0. \xDEa\xF0 er ekkert eftir til a\xF0 breyta \xED dag.",
  "aiServer.session.alreadyFits": "\xDEa\xF0 sem er eftir tekur um {{remaining}} m\xEDn\xFAtur og r\xFAmast innan {{minutes}} m\xEDn\xFAtna. \xDE\xFA getur kl\xE1ra\xF0 \xE6finguna samkv\xE6mt \xE1\xE6tlun.",
  "aiServer.session.alreadyLater": "\xDEessi \xE6fing er \xFEegar \xE1 dagskr\xE1 s\xED\xF0ar \xED dag: {{exerciseName}}. Veldu a\xF0ra \xE6fingu.",
  "aiServer.session.askMinutes": "Hversu margar m\xEDn\xFAtur hefur\xF0u eftir fyrir \xE6finguna?",
  "aiServer.session.canFinishHere": "T\xEDminn dugar ekki fyrir heilt sett \xED vi\xF0b\xF3t. \xDE\xFA m\xE1tt alveg lj\xFAka \xE6fingunni h\xE9r.",
  "aiServer.session.completedSetsStay.one": "Lokin sett haldast \xE1 fyrri \xE6fingunni: {{fromName}}. Setti\xF0 sem er eftir ({{count}}) f\xE6rist \xE1 n\xFDju \xE6finguna: {{toName}}.",
  "aiServer.session.completedSetsStay.other": "Lokin sett haldast \xE1 fyrri \xE6fingunni: {{fromName}}. Settin sem eru eftir ({{count}}) f\xE6rast \xE1 n\xFDju \xE6finguna: {{toName}}.",
  "aiServer.session.customExercise": "\xDEetta er eigin \xE6fing: {{exerciseName}}. \xC9g get ekki sta\xF0fest hva\xF0a \xE6fing hentar \xED sta\xF0inn. \xDE\xFA getur nota\xF0 \u201ESkipta um \xE6fingu\u201C til a\xF0 velja a\xF0ra.",
  "aiServer.session.estimate": " (um {{minutes}} m\xEDn. eftir)",
  "aiServer.session.excluded": "\xDE\xFA hefur vali\xF0 a\xF0 sleppa \xFEessari \xE6fingu: {{exerciseName}}.",
  "aiServer.session.exerciseDone": "\xD6llum settum er loki\xF0 \xED \xFEessari \xE6fingu: {{exerciseName}}. \xDEa\xF0 er ekkert eftir til a\xF0 skipta \xFAt.",
  "aiServer.session.fewerSets.one": "{{count}} f\xE6rra sett",
  "aiServer.session.fewerSets.other": "{{count}} f\xE6rri sett",
  "aiServer.session.limitedArea": "\xDEessi \xE6fing reynir \xE1 sv\xE6\xF0i sem \xFE\xFA vilt hl\xEDfa: {{exerciseName}} ({{areas}}). Veldu a\xF0ra \xE6fingu.",
  "aiServer.session.missingEquipment": "\xDEessi \xE6fing \xFEarfnast b\xFAna\xF0ar sem \xFE\xFA hefur ekki a\xF0gang a\xF0: {{exerciseName}} ({{equipment}}).",
  "aiServer.session.noChanges": "engar breytingar",
  "aiServer.session.noSnapshot": "Uppl\xFDsingar um \xE6finguna fylgdu ekki skilabo\xF0unum. Opna\xF0u \xE6finguna og veldu \u201EL\xEDtill t\xEDmi\u201C e\xF0a \u201EB\xFAna\xF0ur upptekinn\u201C.",
  "aiServer.session.notAlternative": "\xDEessi skipti henta ekki: {{fromName}} \u2192 {{toName}}. Veldu \xE6fingu me\xF0 samb\xE6rilega hreyfingu sem vinnur s\xF6mu v\xF6\xF0va.",
  "aiServer.session.sameExercise": "N\xFDja \xE6fingin er s\xFA sama og s\xFA sem \xE1 a\xF0 skipta \xFAt.",
  "aiServer.session.shortenSummary": "Styttri \xE6fing \xED dag: {{changes}}{{estimate}}. \xDDttu \xE1 \u201ENota \xED \xE6fingu dagsins\u201C. \xC6finga\xE1\xE6tlunin breytist ekki.",
  "aiServer.session.skipExercises": "sleppa \xFEessum \xE6fingum: {{names}}",
  "aiServer.session.swapSummary": "\xCD dag: {{fromName}} \u2192 {{toName}}. \xDDttu \xE1 \u201ENota \xED \xE6fingu dagsins\u201C til a\xF0 skipta. \xC6finga\xE1\xE6tlunin breytist ekki.",
  "aiServer.session.trainingNotShared": "\xDE\xFA deilir ekki \xE6fingag\xF6gnum, svo ekki er h\xE6gt a\xF0 breyta \xE6fingunni h\xE9\xF0an.",
  "aiServer.week.allDone": "\xD6llum fyrirhugu\xF0um \xE6fingum vikunnar er loki\xF0.",
  "aiServer.week.alreadyCompleted.one": "\xDE\xFA hefur \xFEegar loki\xF0 {{count}} \xE6fingu \xED vikunni. Heildarfj\xF6ldinn m\xE1 ekki vera l\xE6gri en {{count}}.",
  "aiServer.week.alreadyCompleted.other": "\xDE\xFA hefur \xFEegar loki\xF0 {{count}} \xE6fingum \xED vikunni. Heildarfj\xF6ldinn m\xE1 ekki vera l\xE6gri en {{count}}.",
  "aiServer.week.alreadyTrained": "\xC6fing er \xFEegar skr\xE1\xF0 \xFEennan dag: {{date}}. Veldu annan dag.",
  "aiServer.week.apply": "\xDDttu \xE1 **Nota fyrir \xFEessa viku** til a\xF0 nota breytingarnar.",
  "aiServer.week.body": "Svona ver\xF0ur vikan: {{changes}}.",
  "aiServer.week.consecutiveDays": "\xC6fingar tvo daga \xED r\xF6\xF0 ({{dates}}): haf\xF0u \xE1lagi\xF0 a\xF0eins minna seinni daginn.",
  "aiServer.week.countInvalid": "Fj\xF6ldi \xE6finga \xED vikunni \xFEarf a\xF0 vera heil tala fr\xE1 0 til 7.",
  "aiServer.week.invalidDate": "Dagsetningin {{date}} \xFEarf a\xF0 vera fr\xE1 {{start}} til {{end}}, \xED dag e\xF0a s\xED\xF0ar \xED \xFEessari viku.",
  "aiServer.week.moves": "**{{name}}** f\xE6rist {{date}}",
  "aiServer.week.noActivePlan": "\xDE\xFA ert ekki me\xF0 virka \xE6finga\xE1\xE6tlun til a\xF0 breyta.",
  "aiServer.week.notShared": "\xDE\xFA deilir ekki \xE6fingag\xF6gnum, svo \xE9g get ekki breytt \xE6fingavikunni. \xDE\xFA getur deilt \xFEeim \xED stillingum \xC6fingaa\xF0sto\xF0ar.",
  "aiServer.week.notUsualDay": "{{date}} er ekki einn af venjulegu \xE6fingad\xF6gunum \xFE\xEDnum.",
  "aiServer.week.skipped.one": "{{names}} fellur ni\xF0ur \xFEessa viku",
  "aiServer.week.skipped.other": "{{names}} falla ni\xF0ur \xFEessa viku",
  "aiServer.week.stays": "**{{name}}** ver\xF0ur \xE1fram {{date}}",
  "aiServer.week.twoOnSameDay": "Tv\xE6r \xE6fingar eru \xE1\xE6tla\xF0ar sama dag, {{date}}. Veldu eina \xE6fingu \xE1 dag.",
  "progression.action.add_reps": "Fj\xF6lga endurtekningum",
  "progression.action.calibrate": "Finna vi\xF0mi\xF0",
  "progression.action.discomfort_hold": "Engin aukning",
  "progression.action.hold": "Halda \xF3breyttu",
  "progression.action.increase_distance": "Lengri vegalengd",
  "progression.action.increase_duration": "Lengri t\xEDmi",
  "progression.action.increase_load": "Auka \xFEyngd",
  "progression.action.reduce_assistance": "Minni a\xF0sto\xF0",
  "progression.action.review_recovery": "Huga a\xF0 endurheimt",
  "progression.addedLoad": "+{{load}}",
  "progression.alternatives": "Sj\xE1 a\xF0ra kosti",
  "progression.apply": "Nota till\xF6gu",
  "progression.assistance": "{{load}} a\xF0sto\xF0",
  "progression.bodyweight": "eigin \xFEyngd",
  "progression.calibrate": "finndu byrjunar\xFEyngdina",
  "progression.chooseTargets": "Veldu markmi\xF0 fyrir settin sem eftir eru",
  "progression.confirmEffort": "\xC1reynsla var ekki skr\xE1\xF0. Fannst \xFE\xE9r \xFE\xFA eiga um {{rir}} \xED varasj\xF3\xF0i \xED lok \xFEessara setta? Ef svo er skaltu nota till\xF6guna. Annars skaltu halda fyrri gildum.",
  "progression.customize": "A\xF0laga",
  "progression.effort.notRecorded": "\xC1reynsla var ekki skr\xE1\xF0 og \xFEv\xED byggir tillagan a\xF0eins \xE1 endurtekningum og \xFEyngd. Auktu a\xF0eins ef \xFE\xE9r fannst \xFE\xFA eiga um {{rir}} \xED varasj\xF3\xF0i \xED lok settanna.",
  "progression.effort.partial": "\xC1reynsla var a\xF0eins skr\xE1\xF0 \xED sumum settum. Auktu a\xF0eins ef \xFE\xE9r fannst \xFE\xFA eiga um {{rir}} \xED varasj\xF3\xF0i \xED lok settanna.",
  "progression.effort.recorded": "\xC1reynslan var eins og \xE1\xE6tla\xF0 var.",
  "progression.effortCaveat": "\xC1reynsla var ekki skr\xE1\xF0. Auktu a\xF0eins ef \xFE\xE9r fannst \xFE\xFA eiga um {{rir}} \xED varasj\xF3\xF0i \xED lok \xFEessara setta.",
  "progression.hide": "Fela",
  "progression.hideAria": "Fela \xE1bendinguna (settin haldast \xF3breytt)",
  "progression.keepPrevious": "Halda fyrri gildum",
  "progression.less": "Minna",
  "progression.metres": "{{metres}} m",
  "progression.next": "N\xE6st: {{target}}",
  "progression.reason.addReps": "Reyndu a\xF0 b\xE6ta vi\xF0 einni endurtekningu \xED settunum me\xF0 f\xE6star endurtekningar \xFEar til \xFE\xFA n\xE6r\xF0 {{repMax}} \xED \xF6llum settum.",
  "progression.reason.addRepsLoaded": "Haltu s\xF6mu \xFEyngd ({{load}}). Reyndu a\xF0 b\xE6ta vi\xF0 einni endurtekningu \xED settunum me\xF0 f\xE6star endurtekningar \xFEar til \xFE\xFA n\xE6r\xF0 {{repMax}} \xED \xF6llum settum.",
  "progression.reason.addRepsSameLoad": "Haltu s\xF6mu \xFEyngd. Reyndu a\xF0 b\xE6ta vi\xF0 einni endurtekningu \xED settunum me\xF0 f\xE6star endurtekningar \xFEar til \xFE\xFA n\xE6r\xF0 {{repMax}} \xED \xF6llum settum.",
  "progression.reason.assistedAddReps": "Haltu s\xF6mu a\xF0sto\xF0. Reyndu a\xF0 b\xE6ta vi\xF0 einni endurtekningu \xED settunum me\xF0 f\xE6star endurtekningar \xFEar til \xFE\xFA n\xE6r\xF0 {{repMax}} \xED \xF6llum settum.",
  "progression.reason.assistedHold": "Haltu s\xF6mu a\xF0sto\xF0 og stefndu \xE1 a\xF0 n\xE1 {{repMin}} \xED \xF6llum settum.",
  "progression.reason.confirmTop": "\xDE\xFA n\xE1\xF0ir efri m\xF6rkum endurtekningabilsins \xED \xF6llum settum. Endurtaktu \xFEetta einu sinni enn me\xF0 s\xF6mu \xFEyngd. \xDE\xE1 leggjum vi\xF0 til aukningu.",
  "progression.reason.decline": "Frammista\xF0an hefur dala\xF0 s\xED\xF0ustu {{sessions}} \xE6fingar. Huga\xF0u a\xF0 svefni, streitu og n\xE6ringu, e\xF0a minnka\xF0u \xE1lagi\xF0 \xED viku, til d\xE6mis me\xF0 einu f\xE6rra setti e\xF0a a\xF0eins minni \xFEyngd.",
  "progression.reason.discomfort": "\xDE\xFA skr\xE1\xF0ir n\xFDlega \xF3\xFE\xE6gindi og \xFEv\xED leggjum vi\xF0 ekki til aukningu. Haltu \xE1lagi innan \xFE\xE6gindamarka, minnka\xF0u \xFEyngdina e\xF0a pr\xF3fa\xF0u a\xF0ra \xE6fingu. Ef verkir halda \xE1fram skaltu leita til heilbrig\xF0isstarfsf\xF3lks.",
  "progression.reason.firstLoad": "Engin \xFEyngd hefur veri\xF0 skr\xE1\xF0: byrja\xF0u l\xE9tt og \xFEyngdu \xED litlum skrefum \xFEar til \xFE\xFA \xE1tt um {{rir}} \xED varasj\xF3\xF0i eftir {{repMin}}\u2013{{repMax}} endurtekningar. Skr\xE1\xF0u \xFEa\xF0 sem byrjunar\xFEyngd.",
  "progression.reason.firstReps": "Fyrsta skipti: h\xE6ttu hverju setti \xFEegar \xFE\xFA g\xE6tir teki\xF0 um {{rir}} \xED vi\xF0b\xF3t og skr\xE1\xF0u endurtekningarnar. Vi\xF0 byggjum \xE1 \xFEv\xED.",
  "progression.reason.firstTime": "Fyrsta skipti: ger\xF0u \xFEa\xF0 sem \xFE\xE9r finnst \xFE\xE6gilegt og skr\xE1\xF0u \xFEa\xF0. Vi\xF0 byggjum \xE1 \xFEv\xED.",
  "progression.reason.harderVariation": "\xDE\xFA hefur tvisvar n\xE1\xF0 {{repMax}} \xED \xF6llum settum. Pr\xF3fa\xF0u erfi\xF0ara afbrig\xF0i e\xF0a b\xE6ttu vi\xF0 sm\xE1\xFEyngd. \xDE\xFA getur l\xEDka haldi\xF0 \xE1fram a\xF0 fj\xF6lga endurtekningum.",
  "progression.reason.holdDistance": "Haltu s\xF6mu vegalengd \xFEar til h\xFAn er \xFE\xE6gileg \xED \xF6llum settum.",
  "progression.reason.holdDuration": "Stefndu \xE1 {{seconds}} sek. \xED \xF6llum settum me\xF0 g\xF3\xF0ri t\xE6kni.",
  "progression.reason.holdLoad": "Haltu s\xF6mu \xFEyngd og stefndu \xE1 a\xF0 n\xE1 a\xF0 minnsta kosti {{repMin}} \xED \xF6llum {{sets}} settunum.",
  "progression.reason.increaseDistance": "\xDE\xFA hefur loki\xF0 \xFEessu tvisvar. Lengdu vegalengdina um 10% og haltu \xE1laginu \xE1fram \xFE\xE6gilegu.",
  "progression.reason.increaseDuration": "\xDE\xFA hefur tvisvar n\xE1\xF0 {{seconds}} sek. \xED \xF6llum settum. Pr\xF3fa\xF0u {{nextSeconds}} sek.",
  "progression.reason.increaseLoadedBeginner": "\xDE\xFA n\xE1\xF0ir {{repMax}} \xED \xF6llum {{sets}} settunum me\xF0 {{load}} \xE1 s\xED\xF0ustu \xE6fingu. Fyrir byrjendur n\xE6gir ein vel heppnu\xF0 \xE6fing. Pr\xF3fa\xF0u {{nextLoad}}, stefndu fyrst \xE1 a\xF0 n\xE1 {{repMin}} \xED hverju setti og fj\xF6lga\xF0u svo endurtekningum aftur.",
  "progression.reason.increaseLoadedStandard": "\xDE\xFA n\xE1\xF0ir {{repMax}} \xED \xF6llum {{sets}} settunum me\xF0 {{load}} \xE1 tveimur \xE6fingum. Pr\xF3fa\xF0u {{nextLoad}}, stefndu fyrst \xE1 a\xF0 n\xE1 {{repMin}} \xED hverju setti og fj\xF6lga\xF0u svo endurtekningum aftur.",
  "progression.reason.increaseUnloadedBeginner": "\xDE\xFA n\xE1\xF0ir {{repMax}} \xED \xF6llum {{sets}} settunum \xE1 s\xED\xF0ustu \xE6fingu. Fyrir byrjendur n\xE6gir ein vel heppnu\xF0 \xE6fing. Pr\xF3fa\xF0u a\xF0 b\xE6ta vi\xF0 {{nextLoad}}, stefndu fyrst \xE1 a\xF0 n\xE1 {{repMin}} \xED hverju setti og fj\xF6lga\xF0u svo endurtekningum aftur.",
  "progression.reason.increaseUnloadedStandard": "\xDE\xFA n\xE1\xF0ir {{repMax}} \xED \xF6llum {{sets}} settunum \xE1 tveimur \xE6fingum. Pr\xF3fa\xF0u a\xF0 b\xE6ta vi\xF0 {{nextLoad}}, stefndu fyrst \xE1 a\xF0 n\xE1 {{repMin}} \xED hverju setti og fj\xF6lga\xF0u svo endurtekningum aftur.",
  "progression.reason.logAssistance": "Skr\xE1\xF0u a\xF0sto\xF0ina sem \xFE\xFA notar. Veldu n\xE6ga a\xF0sto\xF0 til a\xF0 eiga um 2\u20133 endurtekningar \xED varasj\xF3\xF0i \xED lok setts.",
  "progression.reason.logDuration": "Haltu \xE1fram a\xF0 skr\xE1 t\xEDmana. Vi\xF0 byggjum \xE1 \xFEeim.",
  "progression.reason.missingLoad": "Engin \xFEyngd var skr\xE1\xF0 s\xED\xF0ast. Veldu \xFEyngd sem skilur eftir um 2\u20133 endurtekningar \xED varasj\xF3\xF0i og skr\xE1\xF0u hana.",
  "progression.reason.reduceAssistanceBeginner": "\xDE\xFA n\xE1\xF0ir efri m\xF6rkum endurtekningabilsins \xE1 s\xED\xF0ustu \xE6fingu me\xF0 {{load}} a\xF0sto\xF0. Fyrir byrjendur n\xE6gir ein vel heppnu\xF0 \xE6fing. Minnka\xF0u a\xF0sto\xF0ina \xED {{nextLoad}} og stefndu \xE1 a\xF0 n\xE1 {{repMin}} \xED hverju setti. Minni a\xF0sto\xF0 er framf\xF6r.",
  "progression.reason.reduceAssistanceStandard": "\xDE\xFA hefur tvisvar n\xE1\xF0 efri m\xF6rkum endurtekningabilsins me\xF0 {{load}} a\xF0sto\xF0. Minnka\xF0u a\xF0sto\xF0ina \xED {{nextLoad}} og stefndu \xE1 a\xF0 n\xE1 {{repMin}} \xED hverju setti. Minni a\xF0sto\xF0 er framf\xF6r.",
  "progression.reason.unassisted": "\xDE\xFA \xFEarft ekki lengur \xFEessa a\xF0sto\xF0. Pr\xF3fa\xF0u \xE1n a\xF0sto\xF0ar e\xF0a me\xF0 l\xE9ttustu teygjunni og stefndu \xE1 ne\xF0ri m\xF6rk endurtekningabilsins.",
  "progression.reps.one": "{{count}} endurtekning",
  "progression.reps.other": "{{count}} endurtekningar",
  "progression.rule.beginner": "Framvinda: \xFEar sem \xFE\xFA ert a\xF0 byrja \xED styrktar\xFEj\xE1lfun e\xF0a koma aftur eftir hl\xE9 n\xE6gir ein g\xF3\xF0 \xE6fing. \xDEegar \xFE\xFA n\xE6r\xF0 efri m\xF6rkum endurtekningabilsins \xED \xF6llum settum vi\xF0 \xE1\xE6tla\xF0a \xE1reynslu leggjum vi\xF0 til minnstu raunh\xE6fu \xFEyngdaraukningu. \xDE\xE1 byrjar\xF0u aftur n\xE1l\xE6gt ne\xF0ri m\xF6rkum bilsins. Ef \xE1reynsla var ekki skr\xE1\xF0 bi\xF0jum vi\xF0 \xFEig fyrst um a\xF0 sta\xF0festa hana. Ef \xFE\xFA breytir reynslustiginu \xED mi\xF0lungs e\xF0a mikla reynslu b\xED\xF0ur appi\xF0 eftir tveimur sl\xEDkum \xE6fingum \xED r\xF6\xF0.",
  "progression.rule.standard": "Vi\xF0 notum tv\xF6falda framvindu: fyrst fj\xF6lgar\xF0u endurtekningum, s\xED\xF0an \xFEyngir\xF0u. \xDEegar \xFE\xFA n\xE6r\xF0 efri m\xF6rkum endurtekningabilsins \xED \xF6llum settum vi\xF0 \xE1\xE6tla\xF0a \xE1reynslu \xE1 tveimur \xE6fingum leggjum vi\xF0 til minnstu raunh\xE6fu \xFEyngdaraukningu. \xDE\xE1 byrjar\xF0u aftur n\xE1l\xE6gt ne\xF0ri m\xF6rkum bilsins. Ef \xE1reynsla var ekki skr\xE1\xF0 bi\xF0jum vi\xF0 \xFEig fyrst um a\xF0 sta\xF0festa hana.",
  "progression.seconds": "{{seconds}} sek.",
  "progression.suggestion": "Tillaga um framvindu",
  "progression.why": "Af hverju?",
  "push.coachFood.body": "Viltu b\xE6ta vi\xF0 matarskr\xE1ninguna? Ger\xF0u \xFEa\xF0 \xFEegar \xFE\xE9r hentar.",
  "push.coachFood.title": "Hard Earned",
  "push.coachMissed.body": "\xC1\xE6tlanir geta breyst. Opna\xF0u \xCD dag og veldu \xFEa\xF0 sem hentar \xFE\xE9r.",
  "push.coachMissed.title": "Hard Earned",
  "push.coachWorkout.body": "Opna\xF0u \xCD dag \xFEegar \xFE\xE9r hentar og sko\xF0a\xF0u \xE6finguna \xFE\xEDna.",
  "push.coachWorkout.title": "Hard Earned",
  "workout.meta.equipment.band": "Teygja",
  "workout.meta.equipment.barbell": "St\xF6ng",
  "workout.meta.equipment.bench": "Bekkur",
  "workout.meta.equipment.bodyweight": "Eigin \xFEyngd",
  "workout.meta.equipment.cable": "Togst\xF6\xF0",
  "workout.meta.equipment.cardio_machine": "\xDEolt\xE6ki",
  "workout.meta.equipment.dip_station": "D\xFDfust\xF6\xF0",
  "workout.meta.equipment.dumbbell": "Handl\xF3\xF0",
  "workout.meta.equipment.ez_bar": "EZ-st\xF6ng",
  "workout.meta.equipment.kettlebell": "Ketilbjalla",
  "workout.meta.equipment.machine": "T\xE6ki",
  "workout.meta.equipment.pullup_bar": "Upph\xEDfingarst\xF6ng",
  "workout.meta.equipment.rack": "Hn\xE9beygjugrind",
  "workout.meta.equipment.smith": "Smith-t\xE6ki",
  "workout.meta.limitation.ankle": "\xD6kklar",
  "workout.meta.limitation.elbow": "Olnbogar",
  "workout.meta.limitation.hip": "Mja\xF0mir",
  "workout.meta.limitation.knee": "Hn\xE9",
  "workout.meta.limitation.lower_back": "Mj\xF3bak",
  "workout.meta.limitation.neck": "H\xE1ls",
  "workout.meta.limitation.shoulder": "Axlir",
  "workout.meta.limitation.wrist": "\xDAlnli\xF0ir",
  "workout.validation.distanceLong": "\xDEessi vegalengd vir\xF0ist of l\xF6ng.",
  "workout.validation.distanceNonnegative": "Vegalengd m\xE1 ekki vera undir n\xFAlli.",
  "workout.validation.distanceOrTime": "Skr\xE1\xF0u vegalengd e\xF0a t\xEDma.",
  "workout.validation.enterAddedWeight": "Skr\xE1\xF0u vi\xF0b\xF3tar\xFEyngdina (0 ef engin).",
  "workout.validation.enterAssistance": "Skr\xE1\xF0u a\xF0sto\xF0ina (0 ef engin).",
  "workout.validation.enterNumber": "Sl\xE1\xF0u inn t\xF6lu.",
  "workout.validation.enterPerformance": "Skr\xE1\xF0u endurtekningar, t\xEDma e\xF0a vegalengd.",
  "workout.validation.enterWeight": "Skr\xE1\xF0u \xFEyngdina sem \xFE\xFA nota\xF0ir.",
  "workout.validation.exerciseIndex": "\xC6fing {{index}}",
  "workout.validation.maximum": "M\xE1 ekki vera meira en {{max}}.",
  "workout.validation.minimum": "Ver\xF0ur a\xF0 vera a\xF0 minnsta kosti {{min}}.",
  "workout.validation.missingSets": "\xC6fing {{index}}: sett vantar.",
  "workout.validation.noExerciseList": "\xC6fingaskr\xE1ninguna vantar \xE6fingalista.",
  "workout.validation.nonnegative": "M\xE1 ekki vera undir n\xFAlli.",
  "workout.validation.notSession": "\xDEetta er ekki \xE6fingaskr\xE1ning.",
  "workout.validation.oneRep": "Skr\xE1\xF0u a\xF0 minnsta kosti eina endurtekningu.",
  "workout.validation.positiveTime": "Skr\xE1\xF0u t\xEDma sem er meiri en 0.",
  "workout.validation.repsHigh": "\xDEessi fj\xF6ldi endurtekninga vir\xF0ist of mikill.",
  "workout.validation.repsNonnegative": "Fj\xF6ldi endurtekninga m\xE1 ekki vera undir n\xFAlli.",
  "workout.validation.rirRange": "Endurtekningar \xED varasj\xF3\xF0i ver\xF0a a\xF0 vera \xE1 bilinu 0\u201310.",
  "workout.validation.rpeRange": "\xC1reynsla (RPE) ver\xF0ur a\xF0 vera \xE1 bilinu 1\u201310.",
  "workout.validation.setErrors": "{{exercise}}, sett {{index}}: {{errors}}",
  "workout.validation.timeLong": "\xDEessi t\xEDmi vir\xF0ist of langur.",
  "workout.validation.timeNonnegative": "T\xEDmi m\xE1 ekki vera undir n\xFAlli.",
  "workout.validation.weightHigh": "\xDEessi \xFEyngd vir\xF0ist of mikil.",
  "workout.validation.weightNonnegative": "\xDEyngd m\xE1 ekki vera undir n\xFAlli.",
  "workout.validation.wholeNumber": "Nota\xF0u heila t\xF6lu.",
  "workout.validation.wholeReps": "Fj\xF6ldi endurtekninga ver\xF0ur a\xF0 vera heil tala."
};

// supabase/functions/_shared/i18n/core.ts
var localeFor = (language) => language === "is" ? "is-IS" : "en-GB";
var nfCache = /* @__PURE__ */ new Map();
function numberText(value, language, maxDecimals = 2, grouping = false) {
  if (!Number.isFinite(value)) return "\u2013";
  const k = `${language}|${maxDecimals}|${grouping}`;
  let nf = nfCache.get(k);
  if (!nf) {
    nf = new Intl.NumberFormat(localeFor(language), { maximumFractionDigits: maxDecimals, useGrouping: grouping });
    nfCache.set(k, nf);
  }
  return nf.format(Object.is(value, -0) ? 0 : value);
}
var prCache = /* @__PURE__ */ new Map();
function countCategory(count, language) {
  let pr = prCache.get(language);
  if (!pr) {
    pr = new Intl.PluralRules(localeFor(language));
    prCache.set(language, pr);
  }
  return pr.select(count);
}
var PH = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;
function interpolate(template, values = {}, language = "en") {
  return template.replace(PH, (_, key) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) throw new Error(`Missing interpolation value: ${key}`);
    const v = values[key];
    return typeof v === "number" ? numberText(v, language) : String(v);
  });
}
function makeTranslator(language, en, is, onMissing) {
  const dict = language === "is" ? is : en;
  const lookup = (key) => {
    const v = dict[key] ?? en[key];
    if (v === void 0 || language === "is" && dict[key] === void 0) onMissing?.(key);
    return v ?? "";
  };
  const t = (key, params) => interpolate(lookup(key), params, language);
  const tp = (base, count, params) => {
    const cat = countCategory(count, language);
    const key = `${base}.${cat}` in dict ? `${base}.${cat}` : `${base}.other`;
    return interpolate(lookup(key), { count, ...params }, language);
  };
  const has = (key) => key in dict || key in en;
  return { language, t, tp, has };
}
function sharedT(language, onMissing) {
  return makeTranslator(language, SHARED_EN, SHARED_IS, onMissing);
}

// supabase/functions/_shared/ai/openai.ts
function toOpenAiMessages(system, messages) {
  const out = [{ role: "system", content: system }];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const texts = m.content.filter((b) => b.type === "text").map((b) => b.text);
    if (m.role === "assistant") {
      const calls = m.content.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      out.push({ role: "assistant", content: texts.join("\n") || null, ...calls.length ? { tool_calls: calls } : {} });
    } else {
      for (const b of m.content) {
        if (b.type === "tool_result") {
          out.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.is_error ? `ERROR: ${b.content}` : b.content });
        }
      }
      if (texts.length) out.push({ role: "user", content: texts.join("\n") });
    }
  }
  return out;
}
function toOpenAiTools(tools) {
  return (tools ?? []).map((t) => {
    const d = t;
    return { type: "function", function: { name: d.name, description: d.description ?? "", parameters: d.input_schema ?? { type: "object", properties: {} } } };
  });
}
function toOpenAiRequest(req, opts) {
  const tools = toOpenAiTools(req.tools);
  const choice = req.tool_choice?.type === "any" ? "required" : req.tool_choice?.type;
  return {
    model: opts.model,
    messages: toOpenAiMessages(req.system, req.messages),
    max_completion_tokens: opts.maxTokens,
    ...opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {},
    ...tools.length ? { tools, ...choice ? { tool_choice: choice } : {} } : {}
  };
}
function fromOpenAiResponse(data) {
  const d = data;
  const choice = d?.choices?.[0];
  if (!choice || !choice.message || typeof choice.message !== "object") return null;
  const msg = choice.message;
  const content = [];
  const text = typeof msg.content === "string" ? msg.content : typeof msg.refusal === "string" ? msg.refusal : "";
  if (text.trim()) content.push({ type: "text", text });
  for (const raw of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
    const c = raw;
    if (typeof c?.id !== "string" || typeof c.function?.name !== "string") continue;
    let input = {};
    if (typeof c.function.arguments === "string" && c.function.arguments.trim()) {
      try {
        input = JSON.parse(c.function.arguments);
      } catch {
        input = { _invalid_json: true };
      }
    }
    content.push({ type: "tool_use", id: c.id, name: c.function.name, input });
  }
  const hasTools = content.some((b) => b.type === "tool_use");
  const fr = choice.finish_reason;
  const stop_reason = hasTools && (fr === "tool_calls" || fr === "stop" || !fr) ? "tool_use" : fr === "length" ? "max_tokens" : "end_turn";
  return {
    id: d?.id,
    model: d?.model,
    content,
    stop_reason,
    usage: { input_tokens: d?.usage?.prompt_tokens, output_tokens: d?.usage?.completion_tokens }
  };
}
function isOpenAiQuotaError(bodyText) {
  try {
    const e = JSON.parse(bodyText)?.error;
    return e?.code === "insufficient_quota" || e?.type === "insufficient_quota";
  } catch {
    return false;
  }
}

// supabase/functions/_shared/ai/provider.ts
var DEFAULT_MODEL = "claude-sonnet-5-5";
var DEFAULT_API_VERSION = "2023-06-01";
var DEFAULT_OPENAI_MODEL = "gpt-5-mini";
function resolveProvider(env2) {
  const get = (k) => env2(k)?.trim() || void 0;
  const explicit = get("AI_PROVIDER")?.toLowerCase();
  const provider = explicit === "openai" || explicit === "anthropic" ? explicit : get("OPENAI_API_KEY") && !get("ANTHROPIC_API_KEY") ? "openai" : "anthropic";
  if (provider === "openai") {
    const apiKey2 = get("OPENAI_API_KEY");
    if (!apiKey2) return null;
    const model = get("OPENAI_MODEL") ?? DEFAULT_OPENAI_MODEL;
    const reasoning = /^(gpt-5|o\d)/i.test(model);
    const effortEnv = get("OPENAI_REASONING_EFFORT")?.toLowerCase();
    const reasoningEffort = effortEnv === "off" ? void 0 : effortEnv ?? (reasoning ? "low" : void 0);
    const allowance = Number(get("OPENAI_REASONING_TOKEN_ALLOWANCE"));
    return {
      provider,
      apiKey: apiKey2,
      model,
      baseUrl: get("OPENAI_BASE_URL"),
      reasoningEffort,
      reasoningAllowance: reasoningEffort ? Number.isFinite(allowance) && allowance >= 0 ? Math.min(16e3, Math.floor(allowance)) : 2e3 : 0
    };
  }
  const apiKey = get("ANTHROPIC_API_KEY");
  if (!apiKey) return null;
  return { provider, apiKey, model: get("ANTHROPIC_MODEL") ?? DEFAULT_MODEL, baseUrl: get("ANTHROPIC_BASE_URL"), apiVersion: get("ANTHROPIC_VERSION") };
}
var AiUnavailableError = class extends Error {
  constructor(reason, kind, status) {
    super(reason === "not_configured" ? "The training assistant is not configured on the server." : "The training assistant is unavailable right now.");
    this.reason = reason;
    this.kind = kind;
    this.status = status;
    this.name = "AiUnavailableError";
  }
  reason;
  kind;
  status;
  code = "ai_unavailable";
};
var RETRYABLE = (s) => s === 429 || s === 408 || s >= 500;
var MAX_RETRY_AFTER_MS = 2e4;
function parseRetryAfter(v, now) {
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1e3;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - now) : null;
}
async function createMessage(cfg, req) {
  const now = cfg.now ?? Date.now;
  const sleep = cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const random = cfg.random ?? Math.random;
  const timeoutMs = cfg.timeoutMs ?? 45e3;
  const maxRetries = Math.max(0, Math.min(5, cfg.maxRetries ?? 2));
  const deadline = cfg.deadline ?? now() + timeoutMs * (maxRetries + 1) + 1e4;
  const openai = cfg.provider === "openai";
  const body = JSON.stringify(
    openai ? toOpenAiRequest(req, { model: cfg.model, maxTokens: cfg.maxTokens + (cfg.reasoningAllowance ?? 0), reasoningEffort: cfg.reasoningEffort }) : {
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      system: req.system,
      messages: req.messages,
      ...req.tools?.length ? { tools: req.tools } : {},
      ...req.tools?.length && req.tool_choice ? { tool_choice: req.tool_choice } : {}
    }
  );
  const headers = openai ? { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" } : { "x-api-key": cfg.apiKey, "anthropic-version": cfg.apiVersion || DEFAULT_API_VERSION, "content-type": "application/json" };
  const url = openai ? `${(cfg.baseUrl ?? "https://api.openai.com").replace(/\/+$/, "")}/v1/chat/completions` : `${(cfg.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "")}/v1/messages`;
  let last = new AiUnavailableError("provider_down", "deadline");
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const remaining = deadline - now();
    if (remaining <= 1e3) throw last.kind === "deadline" ? last : new AiUnavailableError("provider_down", last.kind, last.status);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Math.min(timeoutMs, remaining));
    let retryAfterMs = null;
    try {
      const res = await cfg.fetch(url, { method: "POST", headers, body, signal: ctl.signal });
      if (res.ok) {
        let data;
        try {
          data = await res.json();
        } catch {
          throw new AiUnavailableError("provider_down", "bad_response", res.status);
        }
        const d = openai ? fromOpenAiResponse(data) : data;
        if (!d || !Array.isArray(d.content)) throw new AiUnavailableError("provider_down", "bad_response", res.status);
        return d;
      }
      const errText = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) throw new AiUnavailableError("not_configured", "http", res.status);
      if (openai && res.status === 429 && isOpenAiQuotaError(errText)) throw new AiUnavailableError("provider_down", "quota", res.status);
      if (!RETRYABLE(res.status)) throw new AiUnavailableError("provider_down", "http", res.status);
      last = new AiUnavailableError("provider_down", "http", res.status);
      retryAfterMs = parseRetryAfter(res.headers.get("retry-after"), now());
    } catch (e) {
      if (e instanceof AiUnavailableError) {
        if (e !== last) throw e;
      } else if (ctl.signal.aborted) {
        throw new AiUnavailableError("provider_down", "timeout");
      } else {
        last = new AiUnavailableError("provider_down", "network");
      }
    } finally {
      clearTimeout(timer);
    }
    if (attempt === maxRetries) break;
    const backoff = Math.round(800 * 2 ** attempt * (0.75 + random() * 0.5));
    const wait = Math.min(MAX_RETRY_AFTER_MS, Math.max(backoff, retryAfterMs ?? 0));
    if (now() + wait + 2e3 > deadline) break;
    await sleep(wait);
  }
  throw last;
}

// supabase/functions/_shared/ai/consent.ts
function consentProvider(version) {
  if (!version) return null;
  const tail = version.includes(":") ? version.slice(version.lastIndexOf(":") + 1).toLowerCase() : "anthropic";
  return tail === "openai" || tail === "anthropic" ? tail : null;
}
function consentedProvider(s) {
  if (!s?.consentAt) return null;
  return consentProvider(s.consentVersion || "2026-10-29");
}

// supabase/functions/_shared/ai/lang.ts
var IS_LETTERS = /[ðþæÐÞÆ]/;
var IS_WORDS = /* @__PURE__ */ new Set([
  "\xE9g",
  "eg",
  "og",
  "ekki",
  "er",
  "a\xF0",
  "vi\xF0",
  "mig",
  "m\xE9r",
  "mer",
  "takk",
  "j\xE1",
  "ja",
  "nei",
  "fyrir",
  "viku",
  "vikuna",
  "n\xE6stu",
  "\xFEessa",
  "hva\xF0",
  "hvernig",
  "get",
  "vil",
  "ger\xF0u",
  "pr\xF3fa\xF0u",
  "n\xFAna",
  "nuna",
  "matarplan",
  "\xE6fing",
  "\xE6fingu",
  "\xE6fingar",
  "\xED",
  "\xE1",
  "um",
  "me\xF0",
  "\xE1n",
  "e\xF0a",
  "l\xEDka",
  "mj\xF6g",
  "svo",
  "h\xE6",
  "hall\xF3",
  "endilega",
  "kannski",
  "bara",
  "\xE9g",
  "\xFE\xFA",
  "\xFEetta",
  "\xFEa\xF0",
  "dag",
  "morgun",
  "engar",
  "enginn",
  "engin",
  "ekkert",
  // Icelandic localization (item 8): question words and common request words without í/á/ð/þ/æ that alone show Icelandic.
  "af",
  "hverju",
  "hvers",
  "vegna",
  "hvar",
  "hver",
  "hven\xE6r",
  "getur\xF0u",
  "getur",
  "vantar",
  "langar",
  "mig",
  "m\xEDn",
  "minn",
  "mitt",
  "nei",
  "n\xFA",
  "l\xEDka",
  "uppskrift",
  "uppskriftir",
  "matse\xF0il",
  "matse\xF0ill",
  "nema",
  "eftir",
  "n\xE6st",
  "\xFAtsk\xFDr\xF0u",
  "hj\xE1lpina",
  "k\xE6rlega",
  "allt",
  "lagi",
  "enn\xFE\xE1",
  "reyndu",
  "aftur"
]);
var EN_WORDS = /* @__PURE__ */ new Set([
  // ("ok"/"okay" are left out: Icelanders say them too, so they decide nothing.)
  "i",
  "the",
  "and",
  "is",
  "to",
  "my",
  "me",
  "you",
  "what",
  "how",
  "can",
  "please",
  "week",
  "today",
  "tomorrow",
  "make",
  "plan",
  "thanks",
  "yes",
  "no",
  "want",
  "with",
  "without",
  "for",
  "this",
  "next",
  "do",
  "it",
  "a",
  "an",
  "of",
  "in",
  "on",
  "i'm",
  "don't",
  "hi",
  "hello",
  "try",
  "again",
  "now"
]);
function detectLang(text) {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return null;
  if (IS_LETTERS.test(t)) return "is";
  const words = t.match(/[\p{L}'’]+/gu) ?? [];
  let is = 0;
  let en = 0;
  for (const w of words) {
    if (IS_WORDS.has(w)) is++;
    if (EN_WORDS.has(w.replace("\u2019", "'"))) en++;
  }
  if (/[áéíóúýö]/.test(t) && is >= 1) return "is";
  if (is > en) return "is";
  if (en > 0) return "en";
  return null;
}

// supabase/functions/_shared/push/copy.ts
var COACH_KINDS = ["workout_reminder", "missed_nudge", "food_unlogged"];
var isCoachKind = (k) => COACH_KINDS.includes(k);
var COPY_MAX_CODE_POINTS = 140;
var COPY_TIMEOUT_MS = 3e3;
var COPY_MIN_BUDGET_MS = 1200;
var KEYS = {
  workout_reminder: { title: "push.coachWorkout.title", body: "push.coachWorkout.body" },
  missed_nudge: { title: "push.coachMissed.title", body: "push.coachMissed.body" },
  food_unlogged: { title: "push.coachFood.title", body: "push.coachFood.body" }
};
var COACH_URL = { workout_reminder: "/", missed_nudge: "/", food_unlogged: "/nutrition/log" };
var COACH_TAG = { workout_reminder: "workout", missed_nudge: "workout", food_unlogged: "food" };
function coachTitle(kind, language) {
  return sharedT(language).t(KEYS[kind].title);
}
function fallbackBody(kind, language) {
  return sharedT(language).t(KEYS[kind].body);
}
function fallbackCopy(kind, language) {
  return { title: coachTitle(kind, language), body: fallbackBody(kind, language), language, source: "fallback" };
}
function aiCopyAllowed(kind, ai, provider) {
  if (!ai || !provider || !ai.enabled || ai.paused) return false;
  if (consentedProvider({ consentAt: ai.consentAt ?? null, consentVersion: ai.consentVersion ?? null }) !== provider) return false;
  return kind === "food_unlogged" ? ai.nutrition === true : ai.training === true;
}
var codePoints = (s) => [...s].length;
var IS_CHARS = /[áðéíóúýþæöÁÐÉÍÓÚÝÞÆÖ]/;
var FORBIDDEN = [
  // guilt, shame, compensation, pressure
  /\b(skipp\w*|miss(ed|ing)|fail\w*|lazy|guilt\w*|asham\w*|shame\w*|excuse\w*|make up for|catch up|compensat\w*|burn (it )?off|earn (it|your)|no excuses?|must|have to|should|don[’']?t give up|push (yourself|through))\b/i,
  /\b(didn[’']?t|did not|haven[’']?t|have not|forgot to|forgotten to) (eat|train|work ?out|exercise|log|do)\b/i,
  // exercise prescriptions and named exercises / activities
  /\b(try|do|add|get in|squeeze in|start with) (some|a few|\d+|an? (quick|short|easy|light))\b/i,
  /\b(squat\w*|lunge\w*|push-?ups?|pull-?ups?|sit-?ups?|crunch\w*|plank\w*|burpee\w*|deadlift\w*|bench\w*|press(es)?|curls?|rows?|jog\w*|run(s|ning)?|sprint\w*|cardio|hiit|stretch\w*|yoga|walk(s|ing)?|steps|laps?|cycl\w*|swim\w*|hike\w*)\b/i,
  // eating prescriptions, foods and targets
  /\b(eat|eating|ate|drink|drinking|snack\w*|meal\w*|breakfast|lunch|dinner|protein|carb\w*|fat|fats|sugar\w*|calori\w*|kcal|macro\w*|diet\w*|fasting|hungry|portion\w*|water|vegetables?|fruit\w*)\b/i,
  // measurements, units, weight, health
  /\b(gram\w*|kilo\w*|kg|lbs?|pounds?|weigh\w*|bmi|reps?|sets?|minutes?|mins?|hours?|km|miles?|calf|injur\w*|pain\w*|sick\w*|ill(ness)?|health\w*|body)\b/i,
  // Icelandic: guilt/skipping, exercises/activities, eating/food/targets, units/health
  /(slepp|misst|samvisk|skamm|leti|lat(ur|ir)\b|bæta upp|vinna upp|brenn|verður að|þarft að|átt að|hnébeygj|armbeygj|upphífing|kviðæfing|planka|réttstöð|bekkpress|hlaup|skokk|sprett|ganga\b|göngu|teygj|jóga|hjól|synd|borða|borðaðu|drekk|snarl|máltíð|morgunmat|hádegismat|kvöldmat|prótein|kolvetn|fitu|sykur|hitaeining|kalorí|megrun|fast[aið]|svang|vatn|grænmeti|ávext|kíló|grömm|gramm|þyngd|vigt|endurtekning|lot(a|ur)\b|mínút|klukkutím|meiðsl|verk(ur|i)\b|veik|heilsu|líkam|gerðu nokkr|prófaðu nokkr)/i,
  /\d/,
  /\p{Extended_Pictographic}|\p{Emoji_Presentation}|[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/u,
  /(https?:|www\.|[<>*_#`[\]{}|\\~^=@$%&+])/i
];
function aiCopyEnabled(env2) {
  return env2?.("PUSH_AI_COPY")?.trim().toLowerCase() === "on";
}
function validateCopy(raw, language) {
  let parsed;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== "body") return null;
  const body = parsed.body;
  if (typeof body !== "string") return null;
  const text = body.trim();
  if (!text || text !== body || /[\r\n\t]/.test(text) || codePoints(text) > COPY_MAX_CODE_POINTS) return null;
  if (FORBIDDEN.some((re) => re.test(text))) return null;
  const detected = detectLang(text);
  if (language === "is" ? !IS_CHARS.test(text) || detected === "en" : IS_CHARS.test(text) || detected === "is") return null;
  return text;
}
var TOPIC = {
  workout_reminder: "a planned training day today; invite them to open Today in the app to see their workout",
  missed_nudge: "a planned workout from yesterday that is still open; plans change, invite them to open Today and choose what works",
  food_unlogged: "an optional prompt to update their food log; it is fine to do it whenever it suits them"
};
var COPY_SYSTEM = [
  'You write the body text of one push notification for a fitness app. Reply with exactly one JSON object: {"body": "..."} and nothing else.',
  "Only invite the person to open the app when it suits them; do not name any exercise, activity, food, drink, meal, amount or body part.",
  `The body is plain text, one sentence or two short ones, at most ${COPY_MAX_CODE_POINTS} characters, with no emoji, links, numbers, markdown or quotes.`,
  "Tone: always warm, supportive and low-pressure. The person decides if and when to act.",
  "Never use guilt or shame, never suggest compensating or making up for anything, never prescribe exercises, durations, foods, calories or targets,",
  "and never state or imply that the person skipped, missed or failed to train or eat (you do not know that).",
  "Do not mention names, workouts, foods, body measurements or health. Write in the requested language only; for Icelandic, write natural, correct Icelandic."
].join(" ");
async function writeCopy(deps, kind, language, ai, budgetMs) {
  const fb = fallbackCopy(kind, language);
  const provider = resolveProvider(deps.env);
  if (!provider) return { ...fb, reason: "not_configured", modelCalled: false };
  if (!aiCopyAllowed(kind, ai, provider.provider)) return { ...fb, reason: "not_allowed", modelCalled: false };
  if (!aiCopyEnabled(deps.env)) return { ...fb, reason: "not_allowed", modelCalled: false };
  const timeout = Math.min(COPY_TIMEOUT_MS, Math.floor(budgetMs));
  if (!(timeout >= COPY_MIN_BUDGET_MS)) return { ...fb, reason: "budget", modelCalled: false };
  const now = deps.now ?? Date.now;
  const effort = deps.env("PUSH_COPY_REASONING_EFFORT")?.trim().toLowerCase();
  try {
    const res = await createMessage(
      {
        provider: provider.provider,
        apiKey: provider.apiKey,
        model: deps.env("PUSH_COPY_MODEL")?.trim() || provider.model,
        baseUrl: provider.baseUrl,
        apiVersion: provider.apiVersion,
        reasoningEffort: provider.reasoningEffort ? effort === "off" ? void 0 : effort || provider.reasoningEffort : void 0,
        reasoningAllowance: provider.reasoningEffort ? Math.min(provider.reasoningAllowance ?? 0, 512) : 0,
        maxTokens: 160,
        timeoutMs: timeout,
        maxRetries: 0,
        deadline: now() + timeout,
        fetch: deps.fetch,
        now
      },
      {
        system: COPY_SYSTEM,
        messages: [
          {
            role: "user",
            content: JSON.stringify({
              reminder: TOPIC[kind],
              language: language === "is" ? "Icelandic (is)" : "English (en)",
              tone: "supportive",
              reference: fb.body
            })
          }
        ]
      }
    );
    const usage = { inputTokens: Number(res.usage?.input_tokens) || 0, outputTokens: Number(res.usage?.output_tokens) || 0 };
    const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const body = res.stop_reason === "max_tokens" ? null : validateCopy(text, language);
    if (!body) return { ...fb, reason: "invalid", modelCalled: true, usage };
    return { title: fb.title, body, language, source: "ai", modelCalled: true, usage };
  } catch {
    return { ...fb, reason: "provider", modelCalled: true };
  }
}
function finalizeCopy(kind, copy, language, aiStillAllowed) {
  if (copy && copy.language === language && typeof copy.body === "string" && copy.body) {
    if (copy.source === "fallback" && copy.body === fallbackBody(kind, language)) return fallbackCopy(kind, language);
    if (copy.source === "ai" && aiStillAllowed && validateCopy(JSON.stringify({ body: copy.body }), language) === copy.body) {
      return { title: coachTitle(kind, language), body: copy.body, language, source: "ai" };
    }
  }
  return fallbackCopy(kind, language);
}

// supabase/functions/_shared/push/send.ts
function authorizePush(given, secret) {
  if (!secret || !given || given.length !== secret.length) return false;
  let r = 0;
  for (let i = 0; i < secret.length; i++) r |= secret.charCodeAt(i) ^ given.charCodeAt(i);
  return r === 0;
}
function tzParts(ms, timeZone) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}
function safeZone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz || "UTC" });
    return tz || "UTC";
  } catch {
    return "UTC";
  }
}
function offsetAt(ms, timeZone) {
  const p = tzParts(ms, timeZone);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1e3) * 1e3;
}
function zonedToUtc(date, hhmm, timeZone) {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let t = guess - offsetAt(guess, timeZone);
  t = guess - offsetAt(t, timeZone);
  return new Date(t);
}
var toMin = (hhmm, fallback) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm ?? "");
  return m ? +m[1] % 24 * 60 + +m[2] : fallback;
};
function quietUntil(now, prefs) {
  const tz = safeZone(prefs?.timeZone);
  const start = toMin(prefs?.quietStart, 22 * 60);
  const end = toMin(prefs?.quietEnd, 7 * 60);
  if (start === end) return null;
  const p = tzParts(now.getTime(), tz);
  const m = p.h * 60 + p.mi;
  const inQuiet = start > end ? m >= start || m < end : m >= start && m < end;
  if (!inQuiet) return null;
  const today = `${p.y}-${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
  const endStr = `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`;
  let at = zonedToUtc(today, endStr, tz);
  if (at.getTime() <= now.getTime()) {
    const next = new Date(Date.UTC(p.y, p.mo - 1, p.d) + 864e5).toISOString().slice(0, 10);
    at = zonedToUtc(next, endStr, tz);
  }
  return at;
}
var QUIET_EXEMPT = ["rest_over", "test"];
function sendOptionsFor(job) {
  const topic = job.payload.tag?.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || void 0;
  switch (job.kind) {
    case "rest_over":
      return { ttl: 300, urgency: "high", topic };
    case "test":
      return { ttl: 600, urgency: "normal", topic };
    case "workout_reminder":
    case "missed_nudge":
    case "food_unlogged": {
      const left = job.expiresAt ? Math.floor((Date.parse(job.expiresAt) - Date.now()) / 1e3) : 3 * 3600;
      return { ttl: Math.max(60, Math.min(3 * 3600, Number.isFinite(left) ? left : 3 * 3600)), urgency: "normal", topic };
    }
    default:
      return { ttl: 24 * 3600, urgency: "normal", topic };
  }
}
async function deliver(deps, job, payload) {
  const body = JSON.stringify({ title: payload.title || "Hard Earned", body: payload.body ?? "", url: payload.url || "/", tag: payload.tag || job.kind });
  let ok = 0;
  let gone = 0;
  let unknown = 0;
  for (const sub of job.subscriptions) {
    let status = 0;
    try {
      status = await deps.send(sub, body, sendOptionsFor(job));
    } catch {
      status = 0;
    }
    if (status >= 200 && status < 300) ok++;
    if (status === 404 || status === 410) gone++;
    if (status === 0) unknown++;
    if (status > 0) await deps.db.subscriptionResult(sub.endpoint, status);
  }
  if (ok > 0) return "sent";
  if (gone === job.subscriptions.length) return "gone";
  return unknown > 0 ? "ambiguous" : "failed";
}
async function processJob(deps, job) {
  const now = deps.now();
  const base = { id: job.id, ...job.token ? { token: job.token } : {} };
  if (!QUIET_EXEMPT.includes(job.kind)) {
    const until = quietUntil(now, job.prefs);
    if (until) return { ...base, status: "deferred", fireAt: until.toISOString() };
  }
  if (!job.subscriptions.length) return { ...base, status: "dropped" };
  const d = await deliver(deps, job, job.payload);
  if (d === "sent") return { ...base, status: "sent" };
  if (d === "gone") return { ...base, status: "dropped" };
  return { ...base, status: "retry" };
}
var asLang = (v) => v === "is" ? "is" : "en";
async function processCoachJob(deps, job, budgetMs, stats) {
  const kind = job.kind;
  const token = job.token;
  const dbCheck = deps.db.check?.bind(deps.db);
  if (!token || !dbCheck) return { id: job.id, ...token ? { token } : {}, status: "release" };
  const check = (stage, copy2) => dbCheck(job.id, token, stage, copy2 ?? null).catch(() => null);
  const base = { id: job.id, token };
  const expires = job.expiresAt ? Date.parse(job.expiresAt) : NaN;
  const notOk = (r) => ({ ...base, status: "skipped", reason: r.status === "discard" ? r.reason ?? "discard" : r.status });
  const now0 = deps.now();
  if (Number.isFinite(expires) && now0.getTime() >= expires) return { ...base, status: "discarded", reason: "expired" };
  const until = quietUntil(now0, job.prefs);
  if (until) {
    if (Number.isFinite(expires) && until.getTime() >= expires) return { ...base, status: "discarded", reason: "quiet_hours" };
    return { ...base, status: "deferred", fireAt: until.toISOString() };
  }
  if (!job.subscriptions.length) return { ...base, status: "dropped" };
  const started = deps.now().getTime();
  const prep = await check("prepare");
  if (!prep) return { ...base, status: "release" };
  if (prep.status !== "ok") return notOk(prep);
  const language = asLang(prep.language);
  const flagOn = !!deps.copy && aiCopyEnabled(deps.copy.env);
  const provider = flagOn && deps.copy ? resolveProvider(deps.copy.env)?.provider ?? null : null;
  const allowed = (ai) => flagOn && aiCopyAllowed(kind, ai ?? null, provider);
  let copy;
  if (job.copy && (job.copy.source === "fallback" || job.copy.source === "ai")) {
    copy = finalizeCopy(kind, job.copy, language, allowed(prep.ai));
  } else if (deps.copy && flagOn) {
    const remaining = budgetMs - (deps.now().getTime() - started) - 2e3;
    const r = await writeCopy(deps.copy, kind, language, prep.ai ?? null, remaining);
    if (stats) {
      if (r.modelCalled) stats.modelCalls++;
      stats.inputTokens += r.usage?.inputTokens ?? 0;
      stats.outputTokens += r.usage?.outputTokens ?? 0;
    }
    copy = r;
  } else {
    copy = finalizeCopy(kind, null, language, false);
  }
  const attempt = { body: copy.body, language: copy.language, source: copy.source };
  const fin = await check("dispatch", attempt);
  if (!fin) return { ...base, status: "release" };
  if (fin.status !== "ok") return notOk(fin);
  const finalCopy = finalizeCopy(kind, copy, asLang(fin.language), allowed(fin.ai));
  if (stats) finalCopy.source === "ai" ? stats.aiCopy++ : stats.fallbackCopy++;
  const cached = { body: finalCopy.body, language: finalCopy.language, source: finalCopy.source };
  const d = await deliver(deps, job, { title: finalCopy.title, body: finalCopy.body, url: COACH_URL[kind], tag: COACH_TAG[kind] });
  if (d === "sent") return { ...base, status: "sent", copy: cached };
  if (d === "gone") return { ...base, status: "dropped" };
  if (d === "ambiguous") return { ...base, status: "ambiguous", copy: cached };
  return { ...base, status: "retry", copy: cached };
}
async function runPushSend(deps, opts = {}) {
  const batch = opts.batch ?? 50;
  const budget = opts.budgetMs ?? 2e4;
  const maxBatches = opts.maxBatches ?? 10;
  const started = deps.now().getTime();
  const left = () => budget - (deps.now().getTime() - started);
  const summary = { claimed: 0, sent: 0, deferred: 0, retry: 0, dropped: 0, ambiguous: 0, discarded: 0, released: 0, skipped: 0, generated: 0, cleaned: 0 };
  const stats = { modelCalls: 0, aiCopy: 0, fallbackCopy: 0, inputTokens: 0, outputTokens: 0 };
  const count = (r) => {
    const key = r.status === "release" ? "released" : r.status;
    summary[key]++;
  };
  if (deps.db.generate) {
    try {
      summary.generated = await deps.db.generate();
    } catch {
    }
  }
  for (let b = 0; b < maxBatches && left() > 0; b++) {
    const jobs = await deps.db.claimDue(batch);
    if (!jobs.length) break;
    summary.claimed += jobs.length;
    const quick = [];
    for (const job of jobs.filter((j) => !isCoachKind(j.kind))) {
      const r = left() > 0 ? await processJob(deps, job) : { id: job.id, ...job.token ? { token: job.token } : {}, status: "release" };
      quick.push(r);
      count(r);
    }
    if (quick.length) await deps.db.finish(quick);
    const coach = [];
    for (const job of jobs.filter((j) => isCoachKind(j.kind))) {
      const remaining = left();
      const r = remaining > 0 ? await processCoachJob(deps, job, remaining, stats) : { id: job.id, ...job.token ? { token: job.token } : {}, status: "release" };
      count(r);
      if (r.status !== "skipped") coach.push(r);
    }
    if (coach.length) await deps.db.finish(coach);
    if (jobs.length < batch) break;
  }
  summary.cleaned = await deps.db.cleanup();
  deps.log?.("push_send", { ...summary, ...stats });
  return { ...summary, ...stats };
}

// supabase/functions/_shared/push/webpush.ts
var enc = new TextEncoder();
function b64urlDecode(s) {
  const b64 = s.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 ? "=".repeat(4 - b64.length % 4) : "";
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlEncode(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
var buf = (u) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength);
async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", buf(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, buf(data)));
}
function ecJwk(publicRaw, privateRaw) {
  if (publicRaw.length !== 65 || publicRaw[0] !== 4) throw new Error("Expected a 65-byte uncompressed P-256 public key.");
  const jwk = { kty: "EC", crv: "P-256", x: b64urlEncode(publicRaw.slice(1, 33)), y: b64urlEncode(publicRaw.slice(33, 65)), ext: true };
  if (privateRaw) jwk.d = b64urlEncode(privateRaw);
  return jwk;
}
async function encryptPayload(plaintext, sub, opts = {}) {
  const uaPublic = b64urlDecode(sub.p256dh);
  const authSecret = b64urlDecode(sub.auth);
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const rs = opts.recordSize ?? 4096;
  if (plaintext.length + 1 + 16 > rs) throw new Error("Push payload too large.");
  let asPrivate;
  let asPublic;
  if (opts.sender) {
    asPublic = b64urlDecode(opts.sender.publicKey);
    asPrivate = await crypto.subtle.importKey("jwk", ecJwk(asPublic, b64urlDecode(opts.sender.privateKey)), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  } else {
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    asPrivate = pair.privateKey;
    asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  }
  const uaKey = await crypto.subtle.importKey("jwk", ecJwk(uaPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asPrivate, 256));
  const prkKey = await hmac(authSecret, ecdhSecret);
  const keyInfo = concat(enc.encode("WebPush: info"), new Uint8Array([0]), uaPublic, asPublic);
  const ikm = await hmac(prkKey, concat(keyInfo, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode("Content-Encoding: aes128gcm"), new Uint8Array([0, 1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode("Content-Encoding: nonce"), new Uint8Array([0, 1])))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", buf(cek), { name: "AES-GCM" }, false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(nonce), tagLength: 128 }, key, buf(concat(plaintext, new Uint8Array([2])))));
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, rs);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ct);
}
async function vapidAuthorization(endpoint, vapid, nowSec = Math.floor(Date.now() / 1e3)) {
  const aud = new URL(endpoint).origin;
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64urlEncode(enc.encode(JSON.stringify({ aud, exp: nowSec + 12 * 3600, sub: vapid.subject })));
  const pub = b64urlDecode(vapid.publicKey);
  const key = await crypto.subtle.importKey("jwk", ecJwk(pub, b64urlDecode(vapid.privateKey)), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, buf(enc.encode(`${header}.${claims}`))));
  return `vapid t=${header}.${claims}.${b64urlEncode(sig)}, k=${vapid.publicKey}`;
}
async function sendWebPush(sub, payload, vapid, fetchImpl, opts = {}) {
  const body = await encryptPayload(enc.encode(payload), sub);
  const headers = {
    Authorization: await vapidAuthorization(sub.endpoint, vapid),
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    TTL: String(Math.max(0, Math.round(opts.ttl ?? 3600))),
    Urgency: opts.urgency ?? "normal"
  };
  if (opts.topic && /^[A-Za-z0-9_-]{1,32}$/.test(opts.topic)) headers.Topic = opts.topic;
  const res = await fetchImpl(sub.endpoint, { method: "POST", headers, body });
  return res.status;
}

// supabase/functions/push-send/index.ts
Deno.serve(handler(async (req) => {
  if (!authorizePush(req.headers.get("x-push-secret"), Deno.env.get("PUSH_CRON_SECRET"))) throw new HttpError(401, "Not authorized.");
  const vapid = {
    publicKey: Deno.env.get("VAPID_PUBLIC_KEY") ?? "",
    privateKey: Deno.env.get("VAPID_PRIVATE_KEY") ?? "",
    subject: Deno.env.get("VAPID_SUBJECT") ?? ""
  };
  if (!vapid.publicKey || !vapid.privateKey || !vapid.subject) throw new HttpError(503, "VAPID keys are not configured.");
  const admin2 = adminClient();
  const rpc = async (fn, args) => {
    const { data, error } = await admin2.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  };
  const summary = await runPushSend({
    db: {
      claimDue: (limit) => rpc("push_claim_due_v2", { p_limit: limit }),
      finish: async (results) => void await rpc("push_finish", { p_results: results }),
      subscriptionResult: async (endpoint, status) => void await rpc("push_subscription_result", { p_endpoint: endpoint, p_status: status }),
      cleanup: () => rpc("push_cleanup", {}),
      check: (id, token, stage, copy) => rpc("push_check", { p_id: id, p_token: token, p_stage: stage, p_copy: copy ?? null }),
      generate: () => rpc("push_generate_food", {})
    },
    copy: { env: (name) => Deno.env.get(name), fetch: (url, init) => fetch(url, init) },
    send: (sub, payload, opts) => sendWebPush(sub, payload, vapid, (url, init) => fetch(url, { ...init, body: init.body, signal: AbortSignal.timeout(1e4) }), opts),
    now: () => /* @__PURE__ */ new Date(),
    // Content-free log: counts and token usage only (never notification text).
    log: (event, fields) => console.log(JSON.stringify({ event, ...fields }))
  });
  return json(summary);
}));
