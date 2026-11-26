/**
 * The training assistant's narrowly scoped server operations (pure). The model can only:
 *   - find_recipes:            search the shared recipe catalog, pre-filtered by THIS user's allergens/diet,
 *                              with per-serving macros computed from ingredient data;
 *   - exercise_alternatives:   list catalog substitutions that fit THIS user's equipment and exclusions;
 *   - propose_program_change:  submit a structured draft that the server validates and stores as a proposal;
 *   - propose_week_adjustment: a temporary, this-week-only schedule change (which planned sessions, on which
 *                              dates) validated against the real plan and this week's completed workouts;
 *   - propose_meal_plan:       a meal plan for this or next week from catalog recipes and protein sides that pass
 *                              THIS user's allergen/diet/dislike filters (needs Nutrition shared + a protein target);
 *   - propose_session_adjustment: TODAY'S WORKOUT ONLY (when the message came with a live-workout snapshot): swap one
 *                              exercise for a catalog alternative that fits the user, or shorten what is left to fit a
 *                              time budget. Validated here; applied on the device to that one session, never the plan.
 * find_recipes results are also kept as recipe cards (recipe_suggestions action). Every action is a suggestion the
 * user previews and applies on the device; nothing here writes to the user's records.
 * No tool reads or writes other users' data, settings, permissions, messages or coach records.
 */
import type { AccountStatePayload, AiDb, MealPlanAction, RecipeSuggestionsAction, RefExercise, RefIngredient, RefRecipe, SessionAdjustmentAction, UserFacts, WeekAdjustmentAction } from './types.ts';
import type { WorkoutContext } from './workout.ts';
// @ts-ignore Deno requires the .ts extension; the app tsconfig does not enable allowImportingTsExtensions.
import { pendingWorking, planShorten, remainingMinutes, WORKOUT_LIMITS } from './workout.ts';
import type { WeekState } from './week.ts';
// @ts-ignore Deno requires the .ts extension; the app tsconfig does not enable allowImportingTsExtensions.
import { validateWeekAdjustment } from './week.ts';
import type { NutritionStatus } from './dataStatus.ts';
// @ts-ignore see above
import { mealPlanBlocker } from './dataStatus.ts';
// @ts-ignore see above
import { buildMealPlanAction, excludedIngredientIds, explainNoRecipes, parseQuery, stemWord, totalMinutes, wordsMatch } from './meals.ts';
import type { NormProgram } from './validate.ts';
// @ts-ignore Deno requires the .ts extension; the app tsconfig does not enable allowImportingTsExtensions.
import { decideTarget, missingEquipment, normalizeProposedProgram, validateForUser, validateProposedProgram } from './validate.ts';
// @ts-ignore Deno requires the .ts extension; the app tsconfig does not enable allowImportingTsExtensions.
import { likedBonus, proteinFitSwaps } from '../nutrition/proteins.ts';
// @ts-ignore Deno requires the .ts extension; the app tsconfig does not enable allowImportingTsExtensions.
import { substitutionRatio } from '../nutrition/recipes.ts';
import type { Ingredient, ProteinGroup, Recipe } from '../nutrition/types.ts';

/** find_recipes → propose_meal_plan (→ one corrected attempt) → final text. */
export const MAX_TOOL_ROUNDS = 4;

const prescriptionSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Slot id, unique within the session (reuse existing slot ids when revising).' },
    exerciseId: { type: 'string', description: 'Catalog exercise id, e.g. "barbell-bench-press".' },
    sets: { type: 'integer', minimum: 1, maximum: 10 },
    repMin: { type: 'integer', minimum: 1, maximum: 100 },
    repMax: { type: 'integer', minimum: 1, maximum: 100 },
    targetRir: { type: 'integer', minimum: 0, maximum: 5, description: 'Reps in reserve.' },
    restSec: { type: 'integer', minimum: 0, maximum: 600 },
    priority: { type: 'integer', enum: [1, 2, 3], description: '1 main, 2 secondary, 3 accessory.' },
    warmup: { type: 'string' },
    alternatives: { type: 'array', items: { type: 'string' }, description: 'Catalog ids of substitutions.' },
    notes: { type: 'string' },
  },
  required: ['id', 'exerciseId', 'sets', 'repMin', 'repMax', 'targetRir', 'restSec'],
} as const;

export const TOOL_DEFS = [
  {
    name: 'find_recipes',
    description:
      "Search Hard Earned's recipe catalog. Matching is tolerant: words in recipe or ingredient names, synonyms (fish → cod/salmon/tuna), tags in the query (high protein, vegetarian, vegan, dairy-free, gluten-free, quick) and meal type. With no or a vague query it returns the best fits for the user's targets — it is never empty unless the user's own allergens/diet/dislikes/cook time exclude everything, and then it gives the reason. Results are filtered for the user's allergens, diet and dislikes, with per-serving macros computed from ingredient data, and appear as recipe cards in the app.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional, free text, e.g. "quick high protein breakfast", "chicken", "no-cook lunch".' },
        meal: { type: 'string', enum: ['breakfast', 'lunch', 'dinner', 'snack'] },
        min_protein_g: { type: 'number', description: 'Minimum protein per serving.' },
        max_results: { type: 'integer', minimum: 1, maximum: 5 },
      },
    },
  },
  {
    name: 'exercise_alternatives',
    description:
      "List catalog alternatives for an exercise that only use equipment the user has and are not on the user's excluded list. Marks alternatives that load an area the user asked to go easy on.",
    input_schema: {
      type: 'object',
      properties: { exercise_id: { type: 'string', description: 'Catalog exercise id to replace.' } },
      required: ['exercise_id'],
    },
  },
  {
    name: 'propose_program_change',
    description:
      'Submit a complete proposed training plan (or a revision of the active plan) as a DRAFT for the user to review. The server validates exercise ids, equipment, exclusions, sets/reps, schedule and the base plan version; invalid drafts are rejected with errors you can fix. Call at most once per reply unless fixing errors. Never claim the plan was applied.',
    input_schema: {
      type: 'object',
      properties: {
        base_program_id: { type: ['string', 'null'], description: 'Active plan program id when revising it; null for a brand-new plan.' },
        base_version: { type: ['integer', 'null'], description: 'Current version of the active plan being revised.' },
        target: { type: 'string', enum: ['apply', 'for_coach_review'], description: 'Use for_coach_review when the plan is coach-managed.' },
        change_summary: { type: 'array', items: { type: 'string' }, description: 'Short bullet list of what changes and why.' },
        message: { type: 'string', description: 'One-paragraph explanation shown with the proposal.' },
        program: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            weeks: { type: 'integer', minimum: 1, maximum: 52 },
            reviewWeek: { type: 'integer', minimum: 1, maximum: 52 },
            rationale: { type: 'array', items: { type: 'string' } },
            warnings: { type: 'array', items: { type: 'string' } },
            templates: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  focus: { type: 'string' },
                  kind: { type: 'string', enum: ['lifting', 'cardio', 'walk', 'mobility', 'conditioning'] },
                  estimatedMinutes: { type: 'integer' },
                  exercises: { type: 'array', items: prescriptionSchema },
                },
                required: ['id', 'name', 'exercises'],
              },
            },
            schedule: {
              type: 'array',
              items: {
                type: 'object',
                properties: { weekday: { type: 'integer', minimum: 0, maximum: 6, description: '0 = Sunday … 6 = Saturday' }, templateId: { type: 'string' } },
                required: ['weekday', 'templateId'],
              },
            },
          },
          required: ['name', 'weeks', 'templates', 'schedule'],
        },
      },
      required: ['program', 'change_summary'],
    },
  },
  {
    name: 'propose_week_adjustment',
    description:
      'THIS WEEK ONLY: choose which of the plan\'s remaining planned sessions the user does this week and on which dates, when their availability changes temporarily (e.g. "I can only train twice this week"). Already-completed workouts this week count toward total_sessions_this_week. Pick template ids from "Planned sessions still left this week"; dates must be today or later in this week, one per day. The user can tap "Apply to this week": unchosen sessions are skipped and chosen ones moved for this week only. The plan, its frequency, split and version never change, and next week reverts automatically. For a coach-managed plan this only moves/skips sessions; content changes still go to the coach.',
    input_schema: {
      type: 'object',
      properties: {
        total_sessions_this_week: { type: 'integer', minimum: 0, maximum: 7, description: 'Total workouts this week INCLUDING ones already completed.' },
        sessions: {
          type: 'array',
          description: 'The remaining sessions to do, in order.',
          items: {
            type: 'object',
            properties: {
              template_id: { type: 'string', description: 'Session id from the plan, e.g. the [id] after a session name.' },
              date: { type: 'string', description: 'YYYY-MM-DD within this week, today or later.' },
            },
            required: ['template_id', 'date'],
          },
        },
        adjustments: { type: 'array', items: { type: 'string' }, description: 'Optional small tweaks (≤ 2), e.g. "Add 2 sets of rows from Full body C to B". Shown as advice; not applied to the plan.' },
        summary: { type: 'string', description: 'One short sentence describing the week.' },
      },
      required: ['total_sessions_this_week', 'sessions'],
    },
  },
  {
    name: 'propose_meal_plan',
    description:
      "Build a meal plan and offer it to the user (\"Add to my meal plan\"). Pass INTENT only — the server picks catalog recipes, portions and protein sides with the app's own meal planner from the user's targets, diet, allergens, dislikes, cook-time and budget settings. Use it whenever the user wants a meal plan made or added; never present your own invented meals as the plan. Default days: the rest of this week (next week if fewer than 3 days are left). Needs Nutrition shared and a protein target; otherwise it returns the reason. Nothing changes until the user taps the button.",
    input_schema: {
      type: 'object',
      properties: {
        week: { type: 'string', enum: ['this', 'next'], description: 'Only if the user said which week.' },
        days: { type: 'array', items: { type: 'string' }, description: 'Only if the user named days: weekday names ("Wednesday") or YYYY-MM-DD dates.' },
        meals_per_day: { type: 'integer', minimum: 1, maximum: 6, description: 'Only if the user asked for a different number than their setting.' },
        quick: { type: 'boolean', description: 'User wants quick meals (≤ 15 min).' },
        diet: { type: 'array', items: { type: 'string', enum: ['vegetarian', 'vegan', 'pescatarian', 'dairy_free', 'gluten_free'] }, description: 'Extra diet rules for this plan.' },
        avoid: { type: 'array', items: { type: 'string' }, description: 'Foods to leave out for this plan, e.g. "fish", "mushrooms".' },
        preferences: { type: 'string', description: 'Any other wishes in the user\'s words, e.g. "high protein, quick lunches".' },
        summary: { type: 'string', description: 'One short sentence describing the plan.' },
      },
    },
  },
  {
    name: 'propose_session_adjustment',
    description:
      "TODAY'S WORKOUT ONLY, and only when the newest message comes with a workout snapshot (<user_data kind=\"workout\">). change \"swap\": replace one exercise that has sets left (session_exercise_id from the snapshot) with a catalog alternative (to_exercise_id, e.g. from exercise_alternatives) that fits the user's equipment, exclusions and areas to go easy on. change \"shorten\": fit what is left into the user's time (minutes); the server keeps the main lifts and trims accessories and later sets. Completed sets are never changed. The user sees the change and taps \"Apply to today's workout\" (with Undo); the saved plan never changes.",
    input_schema: {
      type: 'object',
      properties: {
        change: { type: 'string', enum: ['swap', 'shorten'] },
        session_exercise_id: { type: 'string', description: 'swap: the [id] of the exercise in the workout snapshot.' },
        to_exercise_id: { type: 'string', description: 'swap: catalog id of the replacement.' },
        minutes: { type: 'integer', minimum: 5, maximum: 180, description: 'shorten: minutes the user has left.' },
        summary: { type: 'string', description: 'One short sentence describing the change.' },
      },
      required: ['change'],
    },
  },
] as const;

export interface PendingProposal {
  baseProgramId: string | null;
  baseVersion: number | null;
  program: NormProgram;
  changeSummary: string[];
  message: string | null;
  target: 'apply' | 'for_coach_review';
  validationErrors: string[];
}

export interface ToolState {
  proposal: PendingProposal | null;
  proposalAttempts: number;
  weekPlan?: WeekAdjustmentAction | null;
  weekAttempts?: number;
  mealPlan?: MealPlanAction | null;
  mealPlanAttempts?: number;
  /** Recipe cards from the latest find_recipes call with results. */
  recipes?: RecipeSuggestionsAction | null;
  /** Today's workout change (swap / shorten). */
  sessionAdjustment?: SessionAdjustmentAction | null;
  sessionAdjustmentAttempts?: number;
}

export interface ToolContext {
  db: AiDb;
  facts: UserFacts;
  catalog: Map<string, RefExercise>;
  state: ToolState;
  /** This week's plan state (null when Training isn't shared). */
  week?: WeekState | null;
  trainingShared?: boolean;
  /** The user message id of this exchange (used as the week plan's id → idempotent apply). */
  messageId?: string;
  /** Today in the user's time zone. */
  today?: string;
  /** Nutrition sharing/setup status (propose_meal_plan refuses without sharing and a protein target). */
  nutrition?: NutritionStatus;
  /** The user's account state (diet, targets) — read for the meal planner and recipe ranking, never sent wholesale. */
  account?: AccountStatePayload | null;
  /**
   * The user's own words for this request (the message, plus the original request for a follow-up). Their diet words and
   * exclusions are enforced by find_recipes and propose_meal_plan even when the model's tool input leaves them out.
   */
  requestText?: string;
  /** The live-workout snapshot sent with this message (null when none, or when Training isn't shared). */
  workout?: WorkoutContext | null;
}

export interface ToolOutcome {
  content: string;
  isError?: boolean;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/* ------------------------------------------------------------------ recipes */
const DIET_FLAG: Record<string, keyof NonNullable<RefIngredient['diet']>> = {
  vegetarian: 'vegetarian',
  vegan: 'vegan',
  pescatarian: 'pescatarian',
  dairy_free: 'dairyFree',
  gluten_free: 'glutenFree',
};

/**
 * Whether a recipe fits the hard constraints. Optional ingredients that don't fit are left out (omit: names, omitIds:
 * ids). `swappable` (1.0.3) lists ingredient ids THIS request ruled out by name ("pancakes without raspberries"): a
 * non-optional one that is not a protein may be replaced by an alternative the recipe itself lists, when that
 * alternative fits every constraint. Allergens, diet, proteins and the user's own dislikes are never swapped here:
 * those still exclude the recipe.
 */
export function recipeFits(
  recipe: RefRecipe, ing: Map<string, RefIngredient>, facts: UserFacts, swappable: ReadonlySet<string> = new Set(),
): { ok: boolean; omit: string[]; omitIds?: string[]; swaps?: { from: string; to: string }[] } {
  const allergens = new Set(facts.allergens);
  const disliked = new Set(facts.dislikedIngredientIds);
  const flags = facts.dietTags.map((t) => DIET_FLAG[t]).filter(Boolean);
  const fits = (i: RefIngredient) => !(i.allergens ?? []).some((a) => allergens.has(a)) && !disliked.has(i.id) && flags.every((f) => i.diet?.[f] === true);
  const omit: string[] = [];
  const omitIds: string[] = [];
  const asked: { from: string; to: string }[] = [];
  for (const ri of recipe.ingredients ?? []) {
    const i = ing.get(ri.ingredientId);
    if (!i) return { ok: false, omit }; // unknown ingredient → can't vouch for allergens
    if (fits(i)) continue;
    // Only an ingredient THIS request named, and that is otherwise fine (no allergen, diet or own-dislike problem), may be
    // left out or swapped. Anything restricted rules the recipe out, optional or not: the app shows and plans whole
    // recipes, so an omitted allergen could come back (review of PR #17).
    // (`swappable` never holds the user's own dislikes; clearing the id skips only the request's own exclusion.)
    if (!swappable.has(i.id) || !fits({ ...i, id: '' })) return { ok: false, omit };
    if (ri.optional) {
      omit.push(i.name);
      omitIds.push(i.id);
      continue;
    }
    // Proteins are never swapped this way: "no meat" / "no fish" rules out "Turkey pitta", not turns it into a tofu one.
    const to = !i.proteinGroup
      ? (recipe.substitutions ?? []).find((s) => s.ingredientId === i.id)?.alternatives.map((a) => ing.get(a)).find((a): a is RefIngredient => !!a && fits(a))
      : undefined;
    if (!to) return { ok: false, omit };
    asked.push({ from: i.id, to: to.id });
  }
  const extra = { ...(omitIds.length ? { omitIds } : {}) };
  // Proteins marked "not for me": the same rule as the app (main protein excluded → out; any other use needs an allowed swap).
  if (facts.proteinExcluded?.length) {
    // Checked on the recipe as it will be made (request swaps applied), so a swap never brings an excluded protein in.
    const made = asked.length || omitIds.length
      ? {
          ...recipe,
          ingredients: (recipe.ingredients ?? [])
            .filter((ri) => !omitIds.includes(ri.ingredientId))
            .map((ri) => ({ ...ri, ingredientId: asked.find((s) => s.from === ri.ingredientId)?.to ?? ri.ingredientId })),
        }
      : recipe;
    const swaps = proteinFitSwaps(
      made as unknown as Recipe,
      facts.proteinExcluded as ProteinGroup[],
      (i) => fits(i as unknown as RefIngredient),
      ing as unknown as Map<string, Ingredient>,
    );
    if (swaps === null) return { ok: false, omit };
    // A protein swap on an ingredient that was itself swapped in would chain swaps the app can't store: leave it out.
    if (swaps.some((s) => asked.some((a) => a.to === s.from))) return { ok: false, omit };
    if (swaps.length || asked.length) return { ok: true, omit, ...extra, swaps: [...asked, ...swaps] };
  }
  return asked.length ? { ok: true, omit, ...extra, swaps: asked } : { ok: true, omit, ...extra };
}

/** Recipe with a liked protein as its main protein or a featured one (same rule as the app's ranking). */
export function likedRecipe(r: RefRecipe, ing: Map<string, RefIngredient>, facts: UserFacts): boolean {
  return likedBonus(r as unknown as Recipe, facts.proteinLiked as ProteinGroup[], ing as unknown as Map<string, Ingredient>) > 0;
}
const LIKED_GRAMS = 8;

export function perServingMacros(recipe: RefRecipe, ing: Map<string, RefIngredient>, omitNames: string[] = [], swaps: { from: string; to: string }[] = []) {
  const tot = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  for (const ri of recipe.ingredients ?? []) {
    const to = swaps.find((s) => s.from === ri.ingredientId)?.to;
    const i = ing.get(to ?? ri.ingredientId);
    if (!i || omitNames.includes(i.name) || ri.optional) continue; // optional extras not counted
    // A swap uses the app's quantity conversion (e.g. dry couscous → cooked quinoa), so the card matches the recipe screen.
    const f = ((ri.grams ?? 0) * (to ? substitutionRatio(ri.ingredientId, to, ing as unknown as Map<string, Ingredient>) : 1)) / 100;
    tot.kcal += (i.per100g.kcal ?? 0) * f;
    tot.protein += (i.per100g.protein ?? 0) * f;
    tot.carbs += (i.per100g.carbs ?? 0) * f;
    tot.fat += (i.per100g.fat ?? 0) * f;
  }
  const s = recipe.servings > 0 ? recipe.servings : 1;
  return {
    kcal: Math.round(tot.kcal / s),
    protein_g: Math.round((tot.protein / s) * 10) / 10,
    carbs_g: Math.round((tot.carbs / s) * 10) / 10,
    fat_g: Math.round((tot.fat / s) * 10) / 10,
  };
}

async function findRecipes(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const [recipes, ingredients] = await Promise.all([ctx.db.getRecipes(), ctx.db.getIngredients()]);
  const ing = new Map(ingredients.map((i) => [i.id, i]));
  const intent = parseQuery(typeof input.query === 'string' ? input.query : '');
  // Restrictions the USER stated count even if the model's query dropped them ("no nuts" → query "breakfast ideas").
  if (ctx.requestText) {
    const said = parseQuery(ctx.requestText);
    intent.diet = [...new Set([...intent.diet, ...said.diet])];
    intent.exclude = {
      allergens: [...new Set([...intent.exclude.allergens, ...said.exclude.allergens])],
      words: [...new Set([...intent.exclude.words, ...said.exclude.words])],
      raw: [...new Set([...intent.exclude.raw, ...said.exclude.raw])],
      days: [],
    };
    intent.words = intent.words.filter((w) => !said.exclude.raw.some((r) => stemWord(r) === w));
  }
  const meal = typeof input.meal === 'string' && ['breakfast', 'lunch', 'dinner', 'snack'].includes(input.meal) ? input.meal : intent.meal;
  const minP = typeof input.min_protein_g === 'number' ? input.min_protein_g : intent.highProtein ? (meal === 'snack' ? 15 : 25) : null;
  const max = Math.min(5, Math.max(1, typeof input.max_results === 'number' ? Math.round(input.max_results) : 3));

  // 1. Hard constraints — never relaxed: the user's own settings (allergens, diet, dislikes, cook time) PLUS what this
  //    request rules out ("vegan", "gluten-free", "no fish", "án hneta"). Only the softer parts of a request (words,
  //    meal type, quick, protein) are loosened in step 2.
  const fromRequest = intent.diet.length > 0 || intent.exclude.allergens.length > 0 || intent.exclude.words.length > 0;
  const hard: UserFacts = fromRequest
    ? {
        ...ctx.facts,
        dietTags: [...new Set([...ctx.facts.dietTags, ...intent.diet])],
        allergens: [...new Set([...ctx.facts.allergens, ...intent.exclude.allergens])],
        dislikedIngredientIds: [...new Set([...ctx.facts.dislikedIngredientIds, ...excludedIngredientIds(intent.exclude.words, ingredients)])],
      }
    : ctx.facts;
  // Ingredients ruled out by name in THIS request (not the user's own dislikes): a recipe may swap them (recipeFits).
  const askedOut = new Set(fromRequest ? excludedIngredientIds(intent.exclude.words, ingredients).filter((x) => !ctx.facts.dislikedIngredientIds.includes(x)) : []);
  const allowed: { r: RefRecipe; omit: string[]; omitIds?: string[]; swaps?: { from: string; to: string }[]; macros: ReturnType<typeof perServingMacros>; minutes: number; liked: boolean }[] = [];
  for (const r of recipes) {
    const minutes = totalMinutes(r);
    if (hard.maxCookMinutes != null && minutes > hard.maxCookMinutes) continue;
    const fit = recipeFits(r, ing, hard, askedOut);
    if (!fit.ok) continue;
    allowed.push({ r, omit: fit.omit, omitIds: fit.omitIds, swaps: fit.swaps, macros: perServingMacros(r, ing, fit.omit, fit.swaps), minutes, liked: likedRecipe(r, ing, hard) });
  }
  if (!allowed.length) {
    const reason = explainNoRecipes(
      { allergens: hard.allergens, dietTags: hard.dietTags, disliked: hard.dislikedIngredientIds, maxMinutes: hard.maxCookMinutes, meal: null, proteinExcluded: hard.proteinExcluded },
      recipes, ing, hard,
    );
    return {
      content: JSON.stringify({
        results: [],
        reason,
        note: fromRequest
          ? 'Nothing in the catalog fits the user\'s settings together with the restrictions in this request. Say so plainly and name the reason; never relax a restriction and never invent recipes.'
          : 'The user\'s own settings exclude every recipe. Explain this reason; don\'t invent recipes.',
      }),
    };
  }

  // 2. What this search asked for, loosened step by step until something matches (never past the user's constraints).
  const want = (x: (typeof allowed)[number], o: { words: boolean; meal: boolean; extras: boolean }) =>
    (!o.meal || !meal || x.r.meal === meal) &&
    (!o.extras || ((!intent.quick || x.minutes <= 15) && (minP == null || x.macros.protein_g >= minP))) &&
    (!o.words || wordsMatch(x.r, intent.words, ing));
  const steps = [
    { words: true, meal: true, extras: true, note: null as string | null },
    { words: false, meal: true, extras: true, note: intent.words.length ? `No recipe matched "${intent.words.join(' ')}"; these are the closest fits for the rest of the request.` : null },
    { words: false, meal: true, extras: false, note: `Nothing matched every part of the request; these are the best fits for the user's targets for that meal${fromRequest ? ' (its diet and "no …" restrictions still apply)' : ''}.` },
    { words: false, meal: false, extras: false, note: `Nothing matched the request; these are the best fits for the user's targets${fromRequest ? ' (its diet and "no …" restrictions still apply)' : ''}.` },
  ];
  let picked: typeof allowed = [];
  let note: string | null = null;
  for (const s of steps) {
    picked = allowed.filter((x) => want(x, s));
    if (picked.length) {
      note = s.note;
      break;
    }
  }
  // Best fit for the targets: protein per serving close to the user's protein per meal (else most protein).
  const meals = (ctx.account?.profile?.diet?.mealsPerDay as number | undefined) ?? 3;
  const perMeal = ctx.nutrition?.proteinG ? ctx.nutrition.proteinG / Math.max(1, meals) : null;
  const vague = !intent.words.length || note != null;
  // Liked proteins count as being LIKED_GRAMS closer to the target (vague searches) or rank first among equals (specific ones).
  const likedBoost = (x: (typeof allowed)[number]) => (x.liked ? LIKED_GRAMS : 0);
  picked.sort((a, b) =>
    vague && perMeal != null && minP == null
      ? Math.abs(a.macros.protein_g - perMeal) - likedBoost(a) - (Math.abs(b.macros.protein_g - perMeal) - likedBoost(b)) || a.r.id.localeCompare(b.r.id)
      : vague
        ? b.macros.protein_g + likedBoost(b) - (a.macros.protein_g + likedBoost(a)) || a.r.id.localeCompare(b.r.id)
        : b.macros.protein_g - a.macros.protein_g || a.r.id.localeCompare(b.r.id),
  );
  const shown = picked.slice(0, max).map((x) => ({
    id: x.r.id, name: x.r.name, meal: x.r.meal, total_minutes: x.minutes, per_serving: x.macros, ...(x.omit.length ? { omit_optional: x.omit } : {}),
    ...(x.swaps?.length ? { made_with: x.swaps.map((s) => `${ing.get(s.to)?.name ?? s.to} instead of ${ing.get(s.from)?.name ?? s.from}`) } : {}),
    ...(x.liked ? { uses_a_liked_protein: true } : {}),
  }));
  ctx.state.recipes = {
    kind: 'recipe_suggestions',
    id: ctx.messageId ?? '',
    // The card says what was left out or swapped, and Add to plan / Open carry the swaps (1.0.3).
    recipes: picked.slice(0, max).map((x, k) => ({
      id: shown[k].id, name: shown[k].name, meal: shown[k].meal, totalMinutes: shown[k].total_minutes, perServing: shown[k].per_serving,
      ...(x.omitIds?.length ? { omit: x.omitIds } : {}),
      ...(x.swaps?.length ? { swaps: x.swaps } : {}),
    })),
  };
  return {
    content: JSON.stringify({
      note: 'Filtered for the user\'s allergens, diet, dislikes and proteins marked "not for me" (made_with lists automatic swaps for those and for ingredients this request asked to leave out; omit_optional lists optional extras left out). The cards show these swaps and omissions. Macros are per serving, computed from ingredient data (optional extras excluded).',
      ...(note ? { fallback: note } : {}),
      results: shown,
      shown_to_user: 'These appear as recipe cards under your reply (Open, Add to plan, Save). Link a recipe with [[open:/nutrition/recipes/<id>|Open recipe]]; never write out its ingredients or steps.',
    }),
  };
}

/* ------------------------------------------------------------------ alternatives */
/** Listed substitutions first, then the same movement pattern; only equipment the user has, never excluded exercises. */
export function alternativesFor(ex: RefExercise, catalog: Map<string, RefExercise>, facts: UserFacts): RefExercise[] {
  const excluded = new Set(facts.excludedExerciseIds);
  const pool = [...(ex.substitutions ?? []).map((s) => catalog.get(s)).filter((x): x is RefExercise => Boolean(x))];
  for (const c of catalog.values()) if (c.id !== ex.id && c.pattern && c.pattern === ex.pattern && !pool.includes(c)) pool.push(c);
  return pool.filter((c) => c.id !== ex.id && !excluded.has(c.id) && (!facts.equipment || missingEquipment(c, facts.equipment).length === 0));
}

function exerciseAlternatives(input: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  const id = typeof input.exercise_id === 'string' ? input.exercise_id : '';
  const ex = ctx.catalog.get(id);
  if (!ex) return { content: JSON.stringify({ error: `Unknown exercise id "${id.slice(0, 100)}".` }), isError: true };
  const limits = new Set(ctx.facts.limitations);
  const results = alternativesFor(ex, ctx.catalog, ctx.facts)
    .slice(0, 8)
    .map((c) => ({
      id: c.id,
      name: c.name,
      equipment: c.equipment,
      pattern: c.pattern,
      listed_substitution: (ex.substitutions ?? []).includes(c.id),
      ...((c.stresses ?? []).some((s) => limits.has(s)) ? { loads_area_to_go_easy_on: (c.stresses ?? []).filter((s) => limits.has(s)) } : {}),
    }));
  return {
    content: JSON.stringify({
      for: { id: ex.id, name: ex.name },
      equipment_known: Boolean(ctx.facts.equipment),
      results,
    }),
  };
}

/* ------------------------------------------------------------------ proposals */
function proposeProgramChange(input: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  ctx.state.proposalAttempts++;
  if (ctx.state.proposalAttempts > 2) {
    return { content: JSON.stringify({ status: 'rejected', errors: ['Only one proposal (plus one corrected attempt) per reply.'] }), isError: true };
  }
  const program = normalizeProposedProgram(input.program);
  const baseProgramId = typeof input.base_program_id === 'string' && input.base_program_id ? input.base_program_id.slice(0, 100) : null;
  const bv = input.base_version;
  const baseVersion = typeof bv === 'number' && Number.isInteger(bv) ? bv : null;
  const target = decideTarget(input.target, ctx.facts);
  const errors = [
    ...validateProposedProgram(program, new Set(ctx.catalog.keys())),
    ...validateForUser({ program, baseProgramId, baseVersion }, ctx.facts, ctx.catalog),
  ];
  const changeSummary = (Array.isArray(input.change_summary) ? input.change_summary : [])
    .filter((x): x is string => typeof x === 'string').map((x) => x.trim().slice(0, 300)).filter(Boolean).slice(0, 12);
  ctx.state.proposal = {
    baseProgramId,
    baseVersion: baseProgramId ? baseVersion : null,
    program,
    changeSummary: changeSummary.length ? changeSummary : ['AI-suggested plan update.'],
    message: typeof input.message === 'string' ? input.message.trim().slice(0, 2000) || null : null,
    target,
    validationErrors: [...new Set(errors)].slice(0, 30),
  };
  if (errors.length) {
    return {
      content: JSON.stringify({ status: 'invalid', errors: ctx.state.proposal.validationErrors, note: 'Fix these and call again once, or explain to the user without a proposal.' }),
      isError: true,
    };
  }
  return {
    content: JSON.stringify({
      status: 'stored_as_draft',
      target,
      note: target === 'for_coach_review'
        ? 'Saved as a suggestion for the user to discuss with their human coach. It will not change the plan.'
        : 'Saved as a draft. The user must review and accept it; nothing has changed yet.',
    }),
  };
}

/* ------------------------------------------------------------------ this week */
function proposeWeekAdjustment(input: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  ctx.state.weekAttempts = (ctx.state.weekAttempts ?? 0) + 1;
  if (ctx.state.weekAttempts > 2) {
    return { content: JSON.stringify({ status: 'rejected', errors: ['Only one week adjustment (plus one corrected attempt) per reply.'] }), isError: true };
  }
  const { action, errors } = validateWeekAdjustment(input, {
    facts: ctx.facts,
    week: ctx.week ?? null,
    trainingShared: ctx.trainingShared === true,
    messageId: ctx.messageId ?? '',
  });
  if (!action) {
    return { content: JSON.stringify({ status: 'invalid', errors, note: 'Fix these and call again once, or answer in text without it.' }), isError: true };
  }
  ctx.state.weekPlan = action;
  return {
    content: JSON.stringify({
      status: 'offered',
      sessions: action.sessions.map((s) => ({ name: s.name, date: s.date })),
      skipped: action.skipped.map((s) => s.name),
      warnings: action.warnings,
      note: 'The user sees an "Apply to this week" button. Nothing has changed yet; next week reverts to the usual plan automatically.',
    }),
  };
}

/* ------------------------------------------------------------------ today's workout */
const clip = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * Validate a today-only workout change against the snapshot, the catalog and the user's constraints. Pure: also used by
 * the reply fallback (coach.ts) when the model answered a "Short on time" / "Equipment busy" request without the tool.
 */
export function buildSessionAdjustment(
  input: Record<string, unknown>,
  ctx: Pick<ToolContext, 'catalog' | 'facts' | 'messageId'> & { workout?: WorkoutContext | null; trainingShared?: boolean },
): { action: SessionAdjustmentAction | null; errors: string[] } {
  const w = ctx.workout;
  if (!w) return { action: null, errors: ['No workout snapshot came with this message: this tool only works from the workout screen ("Short on time" / "Equipment busy").'] };
  if (ctx.trainingShared === false) return { action: null, errors: ['Training isn\'t shared, so the workout can\'t be changed from here.'] };
  if (w.status !== 'active') return { action: null, errors: ['This workout is already finished; there is nothing left to change today.'] };
  const change = input.change === 'swap' || input.change === 'shorten' ? input.change : null;
  if (!change) return { action: null, errors: ['change must be "swap" or "shorten".'] };
  const base = { kind: 'session_adjustment' as const, id: ctx.messageId ?? '', sessionId: w.sessionId, summary: clip(input.summary, 300), warnings: [] as string[] };

  if (change === 'shorten') {
    const m = typeof input.minutes === 'number' && Number.isFinite(input.minutes) ? Math.round(input.minutes) : w.minutesLeft;
    if (m == null) return { action: null, errors: ['minutes is required for "shorten" (ask the user how long they have).'] };
    const minutes = Math.min(WORKOUT_LIMITS.maxMinutes, Math.max(WORKOUT_LIMITS.minMinutes, m));
    if (!w.exercises.some((e) => pendingWorking(e) > 0)) return { action: null, errors: ['Every set is already done: nothing left to shorten.'] };
    const plan = planShorten(w, minutes);
    if (plan.fits) return { action: null, errors: [`What is left (about ${remainingMinutes(w)} min) already fits in ${minutes} minutes: no change needed. Tell the user they can finish as planned.`] };
    const warnings: string[] = [];
    if (plan.estimatedMinutes === 0) warnings.push('Less than one more set fits in that time. Finishing here is a good session too.');
    return { action: { ...base, change, minutes, estimatedMinutes: plan.estimatedMinutes, removeSets: plan.removeSets, dropExercises: plan.dropExercises, warnings }, errors: [] };
  }

  const seId = typeof input.session_exercise_id === 'string' ? input.session_exercise_id : w.focusId ?? '';
  const se = w.exercises.find((e) => e.id === seId);
  if (!se) return { action: null, errors: [`Unknown session_exercise_id "${seId.slice(0, 100)}": use an [id] from the workout snapshot.`] };
  if (pendingWorking(se) === 0) return { action: null, errors: [`Every set of ${se.name} is already done: nothing to swap.`] };
  const toId = typeof input.to_exercise_id === 'string' ? input.to_exercise_id : '';
  const to = ctx.catalog.get(toId);
  if (!to) return { action: null, errors: [`Unknown to_exercise_id "${toId.slice(0, 100)}": use a catalog id from exercise_alternatives.`] };
  const errors: string[] = [];
  if (to.id === se.exerciseId) errors.push('The replacement is the same exercise.');
  if (ctx.facts.excludedExerciseIds.includes(to.id)) errors.push(`${to.name} is on the user's excluded list.`);
  if (ctx.facts.equipment) {
    const missing = missingEquipment(to, ctx.facts.equipment);
    if (missing.length) errors.push(`${to.name} needs equipment the user doesn't have (${missing.join(', ')}).`);
  }
  const easy = (to.stresses ?? []).filter((x) => ctx.facts.limitations.includes(x));
  if (easy.length) errors.push(`${to.name} loads an area the user asked to go easy on (${easy.join(', ')}); pick another.`);
  if (w.exercises.some((e) => e.id !== se.id && e.exerciseId === to.id && pendingWorking(e) > 0)) errors.push(`${to.name} is already later in today's workout; pick another.`);
  if (errors.length) return { action: null, errors };
  const from = ctx.catalog.get(se.exerciseId);
  const warnings = se.sets.some((x) => x.done) ? [`Sets you already did stay with ${se.name}; the remaining ${pendingWorking(se)} move to ${to.name}.`] : [];
  return {
    action: {
      ...base,
      change,
      swap: { sessionExerciseId: se.id, fromExerciseId: se.exerciseId, fromName: from?.name ?? se.name, toExerciseId: to.id, toName: to.name },
      removeSets: [],
      dropExercises: [],
      warnings,
    },
    errors: [],
  };
}

function proposeSessionAdjustment(input: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  ctx.state.sessionAdjustmentAttempts = (ctx.state.sessionAdjustmentAttempts ?? 0) + 1;
  if (ctx.state.sessionAdjustmentAttempts > 2) {
    return { content: JSON.stringify({ status: 'rejected', errors: ['Only one workout change (plus one corrected attempt) per reply.'] }), isError: true };
  }
  const { action, errors } = buildSessionAdjustment(input, ctx);
  if (!action) return { content: JSON.stringify({ status: 'invalid', errors, note: 'Fix these and call again once, or answer in text without it.' }), isError: true };
  ctx.state.sessionAdjustment = action;
  return {
    content: JSON.stringify({
      status: 'offered',
      change: action.change,
      ...(action.swap ? { swap: `${action.swap.fromName} → ${action.swap.toName}` } : {}),
      ...(action.change === 'shorten' ? { dropped: action.dropExercises.map((d) => d.name), fewer_sets: action.removeSets.map((r) => `${r.name}: ${r.count} fewer`), estimated_minutes: action.estimatedMinutes } : {}),
      warnings: action.warnings,
      note: 'The user sees the change with "Apply to today\'s workout" and Undo. Nothing has changed yet, and the saved plan never changes. Reply in one or two short lines; don\'t list the changes again.',
    }),
  };
}

/* ------------------------------------------------------------------ meal plans */
const NO_NUTRITION: NutritionStatus = { shared: false, enabled: null, autoDisabled: false, proteinG: null, kcal: null, macros: false };

async function proposeMealPlan(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  ctx.state.mealPlanAttempts = (ctx.state.mealPlanAttempts ?? 0) + 1;
  if (ctx.state.mealPlanAttempts > 2) {
    return { content: JSON.stringify({ status: 'rejected', errors: ['Only one meal plan (plus one corrected attempt) per reply.'] }), isError: true };
  }
  const nutrition = ctx.nutrition ?? NO_NUTRITION;
  const [recipes, ingredients] = mealPlanBlocker(nutrition) ? [[], []] : await Promise.all([ctx.db.getRecipes(), ctx.db.getIngredients()]);
  const { action, errors, adjusted } = buildMealPlanAction(input, {
    facts: ctx.facts, account: ctx.account ?? null, today: ctx.today ?? new Date().toISOString().slice(0, 10), nutrition, messageId: ctx.messageId ?? '', recipes, ingredients,
    requestText: ctx.requestText,
  });
  if (!action) return { content: JSON.stringify({ status: 'not_built', errors, note: 'Tell the user exactly this reason (with its link if any). Do not invent meals.' }), isError: true };
  ctx.state.mealPlan = action;
  return {
    content: JSON.stringify({
      status: 'offered',
      days: action.days.length,
      ...(adjusted.length ? { adjusted } : {}),
      note: 'The plan is shown as a card with each day\'s meals and totals vs targets, plus "Add to my meal plan". Reply in one or two short lines (e.g. "Here\'s your week — tap Add to my meal plan to put it in the app."). Do not list the meals; the card shows them.',
    }),
  };
}

export async function runTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const input = obj(rawInput);
  try {
    switch (name) {
      case 'find_recipes':
        return await findRecipes(input, ctx);
      case 'exercise_alternatives':
        return exerciseAlternatives(input, ctx);
      case 'propose_program_change':
        return proposeProgramChange(input, ctx);
      case 'propose_week_adjustment':
        return proposeWeekAdjustment(input, ctx);
      case 'propose_meal_plan':
        return await proposeMealPlan(input, ctx);
      case 'propose_session_adjustment':
        return proposeSessionAdjustment(input, ctx);
      default:
        return { content: JSON.stringify({ error: `Unknown tool "${String(name).slice(0, 50)}".` }), isError: true };
    }
  } catch {
    return { content: JSON.stringify({ error: 'The tool failed. Answer without it.' }), isError: true };
  }
}
