/**
 * training assistant v4 server logic — MOCKED provider (injected fetch) and in-memory data accessor:
 *  - answer length/format rules reach the prompt for every coach style; tidyReply keeps Markdown markers;
 *  - missing-data rules (sharing vs setup, both, partial help) with in-app links;
 *  - [[open:…]] links validated before storing;
 *  - in-app actions: recipe cards from find_recipes (meal plans are covered in aiCoachFixes.test.ts),
 *    recipe cards from find_recipes, one action per reply, new programs via propose_program_change
 *    (excluded exercises / stale base refused, coach-managed → for_coach_review).
 */
import { describe, expect, it } from 'vitest';
import { handleAiCoach, type CoachDeps } from '../../supabase/functions/_shared/ai/coach';
import { buildContext, COACH_STYLES } from '../../supabase/functions/_shared/ai/context';
import { tidyReply } from '../../supabase/functions/_shared/ai/reply';
import { runTool, TOOL_DEFS, type ToolState } from '../../supabase/functions/_shared/ai/tools';
import { mealPlanBlocker } from '../../supabase/functions/_shared/ai/dataStatus';
import type {
  AccountStatePayload, ActiveProgramRow, AiDb, AiScopes, AiSettingsRow, FetchLike, RecipeSuggestionsAction, RecordExchangeInput,
  RefExercise, RefIngredient, RefRecipe, SessionPayload, StoredExchange, StoredMessage, UserFacts,
} from '../../supabase/functions/_shared/ai/types';

/* ================================================================== fixtures */
const U = '11111111-1111-4111-8111-111111111111';
const P = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const mid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = new Date('2026-10-29T10:00:00Z'); // Thursday; week Mon 26 Oct – Sun 1 Nov

const EXERCISES: RefExercise[] = [
  { id: 'goblet-squat', name: 'Goblet squat', pattern: 'squat', equipment: ['dumbbell'], tracking: 'weight_reps', substitutions: [], stresses: ['knee'] },
  { id: 'dumbbell-bench-press', name: 'Dumbbell bench press', pattern: 'horizontal_push', equipment: ['dumbbell', 'bench'], tracking: 'weight_reps', substitutions: ['push-up'] },
  { id: 'push-up', name: 'Push-up', pattern: 'horizontal_push', equipment: ['bodyweight'], tracking: 'reps', substitutions: [] },
  { id: 'barbell-back-squat', name: 'Barbell back squat', pattern: 'squat', equipment: ['barbell', 'rack'], tracking: 'weight_reps', substitutions: [] },
];
const veg = { vegetarian: true, vegan: true, dairyFree: true, glutenFree: true, pescatarian: true };
const INGREDIENTS: RefIngredient[] = [
  { id: 'chicken', name: 'Chicken breast', per100g: { kcal: 165, protein: 31, carbs: 0, fat: 3.6 }, allergens: [], diet: { ...veg, vegetarian: false, vegan: false, pescatarian: false } },
  { id: 'rice', name: 'Rice, cooked', per100g: { kcal: 130, protein: 2.7, carbs: 28, fat: 0.3 }, allergens: [], diet: veg },
  { id: 'peanut-butter', name: 'Peanut butter', per100g: { kcal: 590, protein: 25, carbs: 20, fat: 50 }, allergens: ['peanuts'], diet: veg },
  { id: 'oats', name: 'Oats', per100g: { kcal: 380, protein: 13, carbs: 67, fat: 7 }, allergens: ['gluten'], diet: { ...veg, glutenFree: false } },
  { id: 'tuna', name: 'Tuna', per100g: { kcal: 116, protein: 26, carbs: 0, fat: 1 }, allergens: ['fish'], diet: { ...veg, vegetarian: false, vegan: false } },
  { id: 'skyr', name: 'Skyr', per100g: { kcal: 63, protein: 11, carbs: 4, fat: 0.2 }, allergens: ['milk'], diet: { ...veg, vegan: false, dairyFree: false } },
];
const RECIPES: RefRecipe[] = [
  { id: 'chicken-rice', name: 'Chicken and rice bowl', meal: 'lunch', servings: 2, prepMinutes: 10, cookMinutes: 15, ingredients: [{ ingredientId: 'chicken', grams: 300 }, { ingredientId: 'rice', grams: 400 }] },
  { id: 'pb-oats', name: 'Peanut butter oats', meal: 'breakfast', servings: 1, prepMinutes: 5, cookMinutes: 0, ingredients: [{ ingredientId: 'oats', grams: 60 }, { ingredientId: 'peanut-butter', grams: 30 }] },
  { id: 'tuna-rice', name: 'Tuna rice', meal: 'dinner', servings: 1, prepMinutes: 10, cookMinutes: 50, ingredients: [{ ingredientId: 'tuna', grams: 120 }, { ingredientId: 'rice', grams: 200 }] },
];

const version = {
  version: 2,
  templates: [{ id: 't-upper', name: 'Upper', kind: 'lifting', exercises: [{ id: 's1', exerciseId: 'dumbbell-bench-press', sets: 3, repMin: 8, repMax: 12, targetRir: 2, restSec: 120 }] }],
  schedule: [{ weekday: 1, templateId: 't-upper' }],
  weeks: 8,
  reviewWeek: 4,
};

interface Data {
  scopes: AiScopes;
  account: AccountStatePayload | null;
  program: ActiveProgramRow | null;
  sessions: SessionPayload[];
  coachStyle?: string;
}
const ALL: AiScopes = { profile: true, training: true, measurements: true, nutrition: true };
function data(over: Partial<Data> = {}): Data {
  return {
    scopes: ALL,
    account: {
      settings: { units: { weight: 'kg' }, timeZone: 'UTC', nutritionEnabled: true },
      profile: { goal: 'build_muscle', diet: { tags: [], allergens: ['peanuts'], dislikedIngredientIds: ['tuna'], maxCookMinutes: 30, mealsPerDay: 3 } },
      nutrition: { mode: 'full', proteinG: 150, calories: 2600, carbsG: 300, fatG: 80, proteinPerKg: 1.8 },
    },
    program: { id: P, payload: { id: P, name: 'Upper plan', active: true, currentVersion: 2, managedBy: { kind: 'self' }, versions: [version], inputs: { equipment: ['dumbbell', 'bench'], excludedExerciseIds: ['push-up'] } } },
    sessions: [{ id: 'sess-1', name: 'Upper', status: 'completed', date: '2026-10-26', exercises: [] }],
    ...over,
  };
}

function makeDb(d: Data) {
  const recorded: RecordExchangeInput[] = [];
  const exchanges = new Map<string, StoredExchange>();
  const settings: AiSettingsRow = { enabled: true, paused: false, consentAt: '2026-10-29T08:00:00Z', scopes: d.scopes, scopesChangedAt: null, profileNotes: '', coachStyle: d.coachStyle ?? null };
  const db: AiDb = {
    getSettings: async () => settings,
    getExchange: async (_u, id) => exchanges.get(id) ?? null,
    checkAndCountUsage: async () => 10,
    getUsage: async (_u, day) => ({ day, requests: 0, inputTokens: 0, outputTokens: 0, costUsd: null }),
    getAccountState: async () => d.account,
    getActiveProgram: async () => d.program,
    getRecentSessions: async () => d.sessions,
    getGoals: async () => [],
    getBodyweight: async () => [],
    getFoodLogs: async () => [],
    getHistory: async () => [],
    recordExchange: async (_u, input) => {
      recorded.push(input);
      const prev = exchanges.get(input.message.id);
      if (prev) return { ...prev, duplicate: true };
      const proposal = input.proposal ? { ...input.proposal, id: mid(500), status: input.proposal.validationErrors.length ? 'invalid' : 'sent', authorKind: 'ai' } : null;
      const reply: StoredMessage = { id: mid(700 + recorded.length), role: 'assistant', content: input.reply.content, createdAt: NOW.toISOString(), proposalId: proposal?.id ?? null, grounding: input.reply.grounding };
      const ex = { reply, proposal, duplicate: false };
      exchanges.set(input.message.id, ex);
      return ex;
    },
    getExercises: async () => EXERCISES,
    getRecipes: async () => RECIPES,
    getIngredients: async () => INGREDIENTS,
  };
  return { db, recorded };
}

const text = (t: string) => ({ id: 'm', model: 'claude-test', content: [{ type: 'text', text: t }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } });
const toolUse = (name: string, input: unknown, id = 'toolu_1') => ({
  id: 'mt', model: 'claude-test', content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 10 },
});
function provider(replies: unknown[]) {
  const requests: { system: string; tools: { name: string }[] }[] = [];
  const fetch: FetchLike = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    const body = replies.shift() ?? text('…');
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { fetch, requests };
}
const deps = (db: AiDb, fetch: FetchLike): CoachDeps => ({ db, fetch, env: (k) => (k === 'ANTHROPIC_API_KEY' ? 'sk-test' : undefined), now: () => NOW, sleep: async () => undefined, random: () => 0.5 });
const send = (t: string, n = 1) => ({ action: 'send', id: mid(n), text: t, mode: 'chat' });
const ctxFor = (d: Data) => buildContext({ db: makeDb(d).db, uid: U, settings: { enabled: true, paused: false, scopes: d.scopes, profileNotes: '', coachStyle: d.coachStyle ?? null }, text: 'hi', mode: 'chat', now: NOW });
const facts = (over: Partial<UserFacts> = {}): UserFacts => ({
  units: 'kg', timeZone: 'UTC', weekStart: 1, equipment: ['dumbbell', 'bench'], excludedExerciseIds: ['push-up'], limitations: [], allergens: ['peanuts'], dietTags: [],
  dislikedIngredientIds: ['tuna'], maxCookMinutes: 30, activeProgram: null, ...over,
});

/* ================================================================== length & format */
describe('MOCKED ai-coach v4: shorter, formatted answers', () => {
  it('length and formatting rules reach the prompt for every coach style', async () => {
    for (const style of COACH_STYLES) {
      const ctx = await ctxFor(data({ coachStyle: style }));
      expect(ctx.system, style).toMatch(/Default 40–90 words\. The main answer comes first/);
      expect(ctx.system, style).toMatch(/talk like a person texting a client, not an article/);
      expect(ctx.system, style).toMatch(/No preambles, don't repeat the question/);
      expect(ctx.system, style).toMatch(/Want the full breakdown\?/);
      expect(ctx.system, style).toMatch(/\*\*bold\*\* for key numbers and exercise or recipe names/);
      expect(ctx.system, style).toMatch(/No headings, tables or code blocks/);
      expect(ctx.system, style).toContain(`Coach style: ${style.toUpperCase()}`);
    }
  });

  it('tidyReply keeps Markdown markers intact', () => {
    const md = '**Bench: 32.5 kg × 8** today.\n\n- *Squat* 3 × 8\n- ~~Deadlift~~ swap for RDL\n1. Warm up\n\n`goblet-squat`\n> rest well\n[[open:/train/program|Open program]]';
    expect(tidyReply(md)).toBe(md);
    expect(tidyReply('Great question! **Do 3 sets.**\n\nLet me know if you have any other questions.')).toBe('**Do 3 sets.**');
  });
});

/* ================================================================== missing data */
describe('MOCKED ai-coach v4: missing-data rules', () => {
  it('nutrition not shared → sharing hint with the training assistant settings link (and no nutrition values)', async () => {
    const ctx = await ctxFor(data({ scopes: { ...ALL, nutrition: false } }));
    expect(ctx.system).toMatch(/Nutrition: NOT shared with you\. Say "I can't see your nutrition yet\. You can share it under training assistant settings\."/);
    expect(ctx.system).toContain('[[open:/coaching/ai/settings|Change what the coach can see]]');
    expect(ctx.system).not.toMatch(/protein 150 g\/day/);
    expect(mealPlanBlocker(ctx.nutrition)).toMatch(/isn't shared/);
  });

  it('shared but no targets → setup hint with the targets link', async () => {
    const d = data();
    d.account!.nutrition = { mode: 'none' };
    const ctx = await ctxFor(d);
    expect(ctx.system).toMatch(/Nutrition: shared, but no nutrition targets are set \[\[open:\/nutrition\/targets\|Set your targets\]\]/);
    expect(mealPlanBlocker(ctx.nutrition)).toMatch(/No protein target/);
  });

  it('nutrition turned off in Settings → names the toggle and links Settings', async () => {
    const d = data();
    d.account!.settings!.nutritionEnabled = false;
    const ctx = await ctxFor(d);
    expect(ctx.system).toMatch(/"Nutrition features" is turned off in Settings → Plan & nutrition \[\[open:\/settings\|Open Settings\]\]/);
  });

  it('both missing → sharing first, then setup', async () => {
    const d = data({ scopes: { ...ALL, nutrition: false } });
    d.account!.nutrition = { mode: 'none' };
    const ctx = await ctxFor(d);
    const line = ctx.system.split('\n').find((l) => l.startsWith('- Nutrition:'))!;
    expect(line.indexOf('Training assistant settings')).toBeLessThan(line.indexOf('Set your targets'));
    expect(line).toMatch(/mention it second/);
  });

  it('partial: protein target only → still help (protein-only meal plan) and say so', async () => {
    const d = data();
    d.account!.nutrition = { mode: 'protein_only', proteinG: 140 };
    const ctx = await ctxFor(d);
    expect(ctx.system).toMatch(/only a protein target is set .*Still help — e\.g\. a meal plan built for the protein target only — and say so/);
    expect(mealPlanBlocker(ctx.nutrition)).toBeNull();
  });

  it('training not shared / no program → share link, or onboarding link', async () => {
    expect((await ctxFor(data({ scopes: { ...ALL, training: false } }))).system).toMatch(/Training \(plan, workouts, records\): NOT shared with you/);
    expect((await ctxFor(data({ program: null }))).system).toContain('[[open:/onboarding|Set up a plan]]');
  });

  it('the app guide is in the prompt', async () => {
    const ctx = await ctxFor(data());
    expect(ctx.system).toMatch(/App guide \(path — what you do there/);
    expect(ctx.system).toMatch(/- \/coaching\/ai\/settings — Training assistant settings: what the AI can see/);
  });
});

/* ================================================================== links */
describe('MOCKED ai-coach v4: in-app links are validated before storing', () => {
  it('keeps valid links (incl. known ids), strips invented paths; recipe links count separately', async () => {
    const m = makeDb(data());
    const { fetch } = provider([
      text('Turn it on in Settings.\n[[open:/settings|Open Settings]]\n[[open:/secret/admin|Admin]]\n[[open:/train/history/sess-1|Last workout]]\n[[open:/nutrition/recipes/chicken-rice|Bowl]]'),
    ]);
    const res = await handleAiCoach(deps(m.db, fetch), U, send('where do I turn on nutrition?'));
    const content = (res.body.reply as StoredMessage).content;
    expect(content).toContain('[[open:/settings|Open Settings]]');
    expect(content).toContain('[[open:/train/history/sess-1|Last workout]]');
    expect(content).not.toContain('/secret/admin');
    expect(content).toContain('[[open:/nutrition/recipes/chicken-rice|Bowl]]'); // recipe links have their own limit (3)
    expect(m.recorded[0].reply.content).toBe(content);
  });
});

/* ================================================================== recipes (meal plans: aiCoachFixes.test.ts) */
describe('MOCKED ai-coach v4: recipe cards', () => {
  it('find_recipes results become a recipe_suggestions action (allergen-filtered, server macros)', async () => {
    const m = makeDb(data());
    const { fetch } = provider([toolUse('find_recipes', {}), text('Try the **Chicken and rice bowl**.')]);
    const res = await handleAiCoach(deps(m.db, fetch), U, send('lunch ideas?'));
    const action = (res.body.reply as StoredMessage).action as RecipeSuggestionsAction;
    expect(action.kind).toBe('recipe_suggestions');
    expect(action.recipes.map((r) => r.id)).toEqual(['chicken-rice']); // pb-oats (peanuts) and tuna-rice (disliked, too slow) filtered
    expect(action.recipes[0].perServing).toEqual({ kcal: 508, protein_g: 51.9, carbs_g: 56, fat_g: 6 });
  });

  it('the user’s own constraints exclude everything → no card, and the reason names the constraint', async () => {
    const state: ToolState = { proposal: null, proposalAttempts: 0 };
    const out = await runTool('find_recipes', { query: 'zzz' }, { db: makeDb(data()).db, facts: facts({ maxCookMinutes: 5 }), catalog: new Map(), state, messageId: mid(3) });
    expect(state.recipes ?? null).toBeNull();
    expect(JSON.parse(out.content).reason).toMatch(/5-minute cooking limit/);
  });
});

/* ================================================================== programs */
const program = (exerciseId = 'dumbbell-bench-press') => ({
  name: 'Full body 2×', weeks: 6, templates: [{ id: 'fb', name: 'Full body', exercises: [{ id: 'x1', exerciseId, sets: 3, repMin: 8, repMax: 12, targetRir: 2, restSec: 90 }] }],
  schedule: [{ weekday: 2, templateId: 'fb' }, { weekday: 5, templateId: 'fb' }],
});

describe('MOCKED ai-coach v4: programs from the chat', () => {
  it('a brand-new program (base null) is stored as an applicable proposal ("Add to my program")', async () => {
    const m = makeDb(data({ program: null }));
    const { fetch } = provider([toolUse('propose_program_change', { base_program_id: null, base_version: null, change_summary: ['New 2-day plan'], program: program() }), text('Want me to put this in your app?')]);
    const res = await handleAiCoach(deps(m.db, fetch), U, send('build me a 2-day program'));
    expect(m.recorded[0].proposal).toMatchObject({ baseProgramId: null, baseVersion: null, target: 'apply', validationErrors: [] });
    expect((res.body.proposal as { status: string }).status).toBe('sent');
  });

  it('excluded exercise, wrong equipment and a stale base version are refused', async () => {
    const run = async (input: Record<string, unknown>) => {
      const ctx = await ctxFor(data());
      const state: ToolState = { proposal: null, proposalAttempts: 0 };
      await runTool('propose_program_change', input, { db: makeDb(data()).db, facts: ctx.facts, catalog: ctx.catalog, state });
      return state.proposal!.validationErrors.join(' ');
    };
    expect(await run({ change_summary: ['x'], program: program('push-up') })).toMatch(/exclud/i);
    expect(await run({ change_summary: ['x'], program: program('barbell-back-squat') })).toMatch(/equipment/i);
    expect(await run({ base_program_id: P, base_version: 1, change_summary: ['x'], program: program() })).toMatch(/version|changed|current/i);
  });

  it('coach-managed active plan → even a new program becomes for_coach_review', async () => {
    const d = data();
    d.program!.payload.managedBy = { kind: 'coach' };
    const m = makeDb(d);
    const { fetch } = provider([toolUse('propose_program_change', { base_program_id: null, target: 'apply', change_summary: ['New plan'], program: program() }), text('Your coach decides.')]);
    await handleAiCoach(deps(m.db, fetch), U, send('new program please'));
    expect(m.recorded[0].proposal?.target).toBe('for_coach_review');
  });

  it('tool list includes the meal plan tool', () => {
    expect(TOOL_DEFS.map((t) => t.name)).toEqual(['find_recipes', 'exercise_alternatives', 'propose_program_change', 'propose_week_adjustment', 'propose_meal_plan']);
  });
});
