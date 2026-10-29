/**
 * The AI coach's narrowly scoped server operations (pure). The model can only:
 *   - find_recipes:            search the shared recipe catalog, pre-filtered by THIS user's allergens/diet,
 *                              with per-serving macros computed from ingredient data;
 *   - exercise_alternatives:   list catalog substitutions that fit THIS user's equipment and exclusions;
 *   - propose_program_change:  submit a structured draft that the server validates and stores as a proposal;
 *   - propose_week_adjustment: a temporary, this-week-only schedule change (which planned sessions, on which
 *                              dates) validated against the real plan and this week's completed workouts.
 * No tool reads or writes other users' data, settings, permissions, messages or coach records.
 */
import type { AiDb, RefExercise, RefIngredient, RefRecipe, UserFacts, WeekAdjustmentAction } from './types.ts';
import type { WeekState } from './week.ts';
// @ts-ignore Deno requires the .ts extension; the app tsconfig does not enable allowImportingTsExtensions.
import { validateWeekAdjustment } from './week.ts';
import type { NormProgram } from './validate.ts';
// @ts-ignore Deno requires the .ts extension; the app tsconfig does not enable allowImportingTsExtensions.
import { decideTarget, missingEquipment, normalizeProposedProgram, validateForUser, validateProposedProgram } from './validate.ts';

export const MAX_TOOL_ROUNDS = 3;

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
      "Search LiftCircle's recipe catalog. Results are already filtered to exclude the user's allergens, diet restrictions and disliked ingredients, and include per-serving kcal/protein/carbs/fat computed from ingredient data. Use for meal ideas.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional words to match in the recipe name, e.g. "chicken", "oats".' },
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
            progressionNotes: { type: 'string' },
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

export function recipeFits(recipe: RefRecipe, ing: Map<string, RefIngredient>, facts: UserFacts): { ok: boolean; omit: string[] } {
  const allergens = new Set(facts.allergens);
  const disliked = new Set(facts.dislikedIngredientIds);
  const flags = facts.dietTags.map((t) => DIET_FLAG[t]).filter(Boolean);
  const omit: string[] = [];
  for (const ri of recipe.ingredients ?? []) {
    const i = ing.get(ri.ingredientId);
    if (!i) return { ok: false, omit }; // unknown ingredient → can't vouch for allergens
    const bad = (i.allergens ?? []).some((a) => allergens.has(a)) || disliked.has(i.id) || flags.some((f) => i.diet?.[f] !== true);
    if (bad) {
      if (ri.optional) omit.push(i.name);
      else return { ok: false, omit };
    }
  }
  return { ok: true, omit };
}

export function perServingMacros(recipe: RefRecipe, ing: Map<string, RefIngredient>, omitNames: string[] = []) {
  const tot = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  for (const ri of recipe.ingredients ?? []) {
    const i = ing.get(ri.ingredientId);
    if (!i || omitNames.includes(i.name) || ri.optional) continue; // optional extras not counted
    const f = (ri.grams ?? 0) / 100;
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
  const words = (typeof input.query === 'string' ? input.query : '').toLowerCase().split(/\s+/).filter((w) => w.length > 1).slice(0, 5);
  const meal = typeof input.meal === 'string' ? input.meal : null;
  const minP = typeof input.min_protein_g === 'number' ? input.min_protein_g : null;
  const max = Math.min(5, Math.max(1, typeof input.max_results === 'number' ? Math.round(input.max_results) : 3));
  const out = [];
  for (const r of recipes) {
    if (meal && r.meal !== meal) continue;
    const name = r.name.toLowerCase();
    const ingNames = (r.ingredients ?? []).map((x) => ing.get(x.ingredientId)?.name.toLowerCase() ?? '').join(' ');
    if (words.length && !words.some((w) => name.includes(w) || ingNames.includes(w))) continue;
    const minutes = (r.prepMinutes ?? 0) + (r.cookMinutes ?? 0);
    if (ctx.facts.maxCookMinutes != null && minutes > ctx.facts.maxCookMinutes) continue;
    const fit = recipeFits(r, ing, ctx.facts);
    if (!fit.ok) continue;
    const macros = perServingMacros(r, ing, fit.omit);
    if (minP != null && macros.protein_g < minP) continue;
    out.push({ id: r.id, name: r.name, meal: r.meal, total_minutes: minutes, per_serving: macros, ...(fit.omit.length ? { omit_optional: fit.omit } : {}) });
  }
  out.sort((a, b) => b.per_serving.protein_g - a.per_serving.protein_g);
  return {
    content: JSON.stringify({
      note: 'Filtered for the user\'s allergens, diet and dislikes. Macros are per serving, computed from ingredient data (optional extras excluded).',
      results: out.slice(0, max),
    }),
  };
}

/* ------------------------------------------------------------------ alternatives */
function exerciseAlternatives(input: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  const id = typeof input.exercise_id === 'string' ? input.exercise_id : '';
  const ex = ctx.catalog.get(id);
  if (!ex) return { content: JSON.stringify({ error: `Unknown exercise id "${id.slice(0, 100)}".` }), isError: true };
  const excluded = new Set(ctx.facts.excludedExerciseIds);
  const limits = new Set(ctx.facts.limitations);
  const pool = [...(ex.substitutions ?? []).map((s) => ctx.catalog.get(s)).filter((x): x is RefExercise => Boolean(x))];
  for (const c of ctx.catalog.values()) if (c.id !== ex.id && c.pattern && c.pattern === ex.pattern && !pool.includes(c)) pool.push(c);
  const results = pool
    .filter((c) => c.id !== ex.id && !excluded.has(c.id) && (!ctx.facts.equipment || missingEquipment(c, ctx.facts.equipment).length === 0))
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
      default:
        return { content: JSON.stringify({ error: `Unknown tool "${String(name).slice(0, 50)}".` }), isError: true };
    }
  } catch {
    return { content: JSON.stringify({ error: 'The tool failed. Answer without it.' }), isError: true };
  }
}
