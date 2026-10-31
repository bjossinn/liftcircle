/**
 * training assistant fixes from live testing (0.7.0) — MOCKED provider (injected fetch), in-memory data, the app's REAL recipe
 * and ingredient catalog:
 *  - meal plans are built on the server from intent with the app's own planner (parity with the app), with nutrition
 *    shared and a protein target; a vague request still gets a plan; impossible constraints give a clear reason; a model
 *    that invents meals instead of calling the tool is overridden by a real plan;
 *  - find_recipes: tolerant matching and a non-empty fallback;
 *  - reply text vs action card consistency (contradiction corrected, consistent text untouched);
 *  - open request resume after "ok try now", including the "sharing changed" case;
 *  - link lead-in cleanup, human dates (text and week-plan warnings), chip pluralization, recipe links and the
 *    no-full-recipe rule.
 */
import { describe, expect, it } from 'vitest';
import { handleAiCoach, type CoachDeps } from '../../supabase/functions/_shared/ai/coach';
import { buildContext } from '../../supabase/functions/_shared/ai/context';
import { runTool, type ToolState } from '../../supabase/functions/_shared/ai/tools';
import { buildMealPlanAction, parseQuery, prefsFromAccountPayload } from '../../supabase/functions/_shared/ai/meals';
import { nutritionStatus } from '../../supabase/functions/_shared/ai/dataStatus';
import { findOpenRequest, isFollowUp } from '../../supabase/functions/_shared/ai/conversation';
import { extractOpenLinks, validateOpenLinks } from '../../supabase/functions/_shared/ai/appGuide';
import { datePair, humanDate, humanizeDates, shortDate } from '../../supabase/functions/_shared/ai/humanDates';
import { looksLikeFullRecipe, mealPlanConflict, summarizeWeekPlan, weekPlanConflict } from '../../supabase/functions/_shared/ai/postcheck';
import type {
  AccountStatePayload, ActiveProgramRow, AiDb, AiScopes, AiSettingsRow, FetchLike, MealPlanAction, RecordExchangeInput, RefExercise, RefIngredient,
  RefRecipe, SessionPayload, StoredExchange, StoredMessage, UserFacts, WeekAdjustmentAction,
} from '../../supabase/functions/_shared/ai/types';
import { RECIPES } from '@/data/recipes';
import { INGREDIENTS } from '@/data/ingredients';
import { generateMealPlan, planPrefsFrom } from '@/domain/nutrition/mealplan';
import { defaultAccountState } from '@/state/defaults';

/* ================================================================== fixtures */
const U = '11111111-1111-4111-8111-111111111111';
const P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const mid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = new Date('2026-10-29T10:00:00Z'); // Thursday; week Mon 26 Oct – Sun 1 Nov
const TODAY = '2026-10-29';
const REF_RECIPES = RECIPES as unknown as RefRecipe[];
const REF_INGREDIENTS = INGREDIENTS as unknown as RefIngredient[];
const ALL: AiScopes = { profile: true, training: true, measurements: false, nutrition: true };

const EXERCISES: RefExercise[] = [
  { id: 'goblet-squat', name: 'Goblet squat', pattern: 'squat', equipment: ['dumbbell'], tracking: 'weight_reps' },
  { id: 'dumbbell-row', name: 'Dumbbell row', pattern: 'horizontal_pull', equipment: ['dumbbell', 'bench'], tracking: 'weight_reps' },
];
const rx = (id: string, exerciseId: string) => ({ id, exerciseId, sets: 3, repMin: 8, repMax: 12, targetRir: 2, restSec: 90 });
function fullBodyPlan(): ActiveProgramRow {
  return {
    id: P1,
    payload: {
      id: P1, name: 'Full body 3x', active: true, currentVersion: 2, startDate: '2026-10-05', managedBy: { kind: 'self' },
      versions: [{
        version: 2,
        templates: [
          { id: 'fb-a', name: 'Full body A', kind: 'lifting', exercises: [rx('s1', 'goblet-squat')] },
          { id: 'fb-b', name: 'Full body B', kind: 'lifting', exercises: [rx('s1', 'dumbbell-row')] },
          { id: 'fb-c', name: 'Full body C', kind: 'lifting', exercises: [rx('s1', 'goblet-squat'), rx('s2', 'dumbbell-row')] },
        ],
        schedule: [{ weekday: 1, templateId: 'fb-a' }, { weekday: 3, templateId: 'fb-b' }, { weekday: 5, templateId: 'fb-c' }],
        weeks: 8,
      }],
      overrides: [],
      inputs: { equipment: ['dumbbell', 'bench'], excludedExerciseIds: [], sessionMinutes: 45, liftingDaysPerWeek: 3, availableWeekdays: [1, 2, 3, 4, 5] },
    },
  };
}
const MONDAY_DONE: SessionPayload = { id: 'sess-mon', name: 'Full body A', status: 'completed', date: '2026-10-26', programId: P1, templateId: 'fb-a', plannedDate: '2026-10-26', exercises: [] };

function account(over: { diet?: Record<string, unknown>; nutrition?: AccountStatePayload['nutrition']; nutritionEnabled?: boolean } = {}): AccountStatePayload {
  return {
    settings: { units: { weight: 'kg' }, timeZone: 'UTC', weekStart: 1, nutritionEnabled: over.nutritionEnabled ?? true },
    profile: { goal: 'build_muscle', diet: { tags: [], allergens: [], dislikedIngredientIds: [], maxCookMinutes: 30, mealsPerDay: 3, budget: 'any', ...over.diet } as never },
    nutrition: over.nutrition ?? { mode: 'protein_only', proteinG: 198, proteinPerKg: 2 },
  };
}

interface Data {
  scopes: AiScopes;
  scopesChangedAt?: string | null;
  account: AccountStatePayload | null;
  program: ActiveProgramRow | null;
  sessions: SessionPayload[];
  messages: StoredMessage[];
}
const data = (over: Partial<Data> = {}): Data => ({ scopes: ALL, account: account(), program: fullBodyPlan(), sessions: [MONDAY_DONE], messages: [], ...over });

function makeDb(d: Data) {
  const recorded: RecordExchangeInput[] = [];
  const exchanges = new Map<string, StoredExchange>();
  const settings: AiSettingsRow = { enabled: true, paused: false, consentAt: '2026-10-01T00:00:00Z', scopes: d.scopes, scopesChangedAt: d.scopesChangedAt ?? null, profileNotes: '' };
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
    getHistory: async (_u, after, limit) => d.messages.filter((m) => !after || m.createdAt > after).slice(-limit),
    recordExchange: async (_u, input) => {
      recorded.push(input);
      const reply: StoredMessage = { id: mid(700 + recorded.length), role: 'assistant', content: input.reply.content, createdAt: NOW.toISOString(), grounding: input.reply.grounding, proposalId: null };
      const ex = { reply, proposal: null, duplicate: false };
      exchanges.set(input.message.id, ex);
      return ex;
    },
    getExercises: async () => EXERCISES,
    getRecipes: async () => REF_RECIPES,
    getIngredients: async () => REF_INGREDIENTS,
  };
  return { db, recorded };
}

const text = (t: string) => ({ id: 'm', model: 'claude-test', content: [{ type: 'text', text: t }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } });
const toolUse = (name: string, input: unknown, id = 'toolu_1') => ({ id: 'mt', model: 'claude-test', content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 10 } });
function provider(replies: unknown[]) {
  const requests: { system: string; messages: { role: string; content: unknown }[] }[] = [];
  const fetch: FetchLike = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    const body = replies.shift() ?? text('…');
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { fetch, requests };
}
function deps(db: AiDb, fetch: FetchLike) {
  const logs: { event: string; [k: string]: unknown }[] = [];
  const d: CoachDeps = { db, fetch, env: (k) => (k === 'ANTHROPIC_API_KEY' ? 'sk-test' : undefined), now: () => NOW, sleep: async () => undefined, random: () => 0.5, log: (event, fields) => logs.push({ event, ...fields }) };
  return { d, logs };
}
const send = (t: string, n = 1) => ({ action: 'send', id: mid(n), text: t, mode: 'chat' });
const facts = (over: Partial<UserFacts> = {}): UserFacts => ({
  units: 'kg', timeZone: 'UTC', weekStart: 1, equipment: null, excludedExerciseIds: [], limitations: [], allergens: [], dietTags: [], dislikedIngredientIds: [], maxCookMinutes: 30, activeProgram: null, ...over,
});
const planCtx = (acc: AccountStatePayload, over: Partial<Parameters<typeof buildMealPlanAction>[1]> = {}) => ({
  facts: facts(), account: acc, today: TODAY, nutrition: nutritionStatus(acc, true), messageId: mid(5), recipes: REF_RECIPES, ingredients: REF_INGREDIENTS, ...over,
});

/* ================================================================== 1. meal plans */
describe('MOCKED meal plans are built on the server', () => {
  it('parity: the server plan equals the app planner for the same settings (default and a restrictive diet)', () => {
    for (const diet of [{}, { tags: ['vegetarian'], allergens: ['milk'], budget: 'low', maxCookMinutes: 20, mealsPerDay: 4 }]) {
      const app = defaultAccountState();
      app.settings.nutritionEnabled = true;
      app.nutrition = { ...app.nutrition, mode: 'protein_only', proteinG: 198 };
      app.profile.diet = { ...app.profile.diet, ...(diet as object) };
      const payload = account({ diet: diet as Record<string, unknown> });
      const appPrefs = planPrefsFrom(app.profile.diet, app.nutrition, true);
      expect(prefsFromAccountPayload(payload)).toEqual(appPrefs);
      const appPlan = generateMealPlan('2026-11-02', appPrefs).plan;
      const { action } = buildMealPlanAction({ week: 'next' }, planCtx(payload));
      expect(action!.days.map((d) => ({ date: d.date, items: d.items.map(({ name: _n, ...it }) => it) }))).toEqual(
        appPlan.days.map((d) => ({ date: d.date, items: d.items.map((it) => ({ slot: it.slot, recipeId: it.recipeId, servings: it.servings, ...(it.extras?.length ? { extras: it.extras } : {}) })) })),
      );
    }
  });

  it('nutrition shared + 198 g target: propose_meal_plan with intent only → a meal_plan action for the rest of this week, reply is one short line', async () => {
    const m = makeDb(data());
    const { fetch } = provider([toolUse('propose_meal_plan', {}), text('Here’s your week — tap Add to my meal plan to put it in the app.')]);
    const { d } = deps(m.db, fetch);
    const res = await handleAiCoach(d, U, send('make a meal plan for the week and add it'));
    const action = (res.body.reply as StoredMessage).action as MealPlanAction;
    expect(action.kind).toBe('meal_plan');
    expect(action.days.map((x) => x.date)).toEqual(['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
    expect(action.targets.proteinG).toBe(198);
    const ids = new Set(RECIPES.map((r) => r.id));
    expect(action.days.every((x) => x.items.length > 0 && x.items.every((i) => ids.has(i.recipeId)))).toBe(true);
    expect((res.body.reply as StoredMessage).content).toBe('Here’s your week — tap Add to my meal plan to put it in the app.');
  });

  it('fewer than 3 days left → next week by default; named days and meals per day are honoured', () => {
    const { action } = buildMealPlanAction({}, planCtx(account(), { today: '2026-10-31' }));
    expect(action!.weekStart).toBe('2026-11-02');
    expect(action!.days).toHaveLength(7);
    const picked = buildMealPlanAction({ days: ['Friday', 'saturday'], meals_per_day: 2 }, planCtx(account())).action!;
    expect(picked.days.map((x) => x.date)).toEqual(['2026-10-30', '2026-10-31']);
    expect(picked.days.every((x) => x.items.length === 2)).toBe(true);
  });

  it('preferences tighten, never relax: "no fish", quick, vegetarian', () => {
    const { action } = buildMealPlanAction({ avoid: ['fish'], quick: true, diet: ['vegetarian'] }, planCtx(account()));
    const byId = new Map(INGREDIENTS.map((i) => [i.id, i]));
    for (const it of action!.days.flatMap((x) => x.items)) {
      const r = RECIPES.find((x) => x.id === it.recipeId)!;
      const ings = r.ingredients.filter((x) => !x.optional).map((x) => byId.get(x.ingredientId)!);
      expect(ings.some((i) => i.allergens.includes('fish')), r.name).toBe(false);
      expect(ings.every((i) => i.diet.vegetarian), r.name).toBe(true);
    }
  });

  it('impossible constraints → no plan and a clear reason naming the constraint', () => {
    const acc = account({ diet: { tags: ['vegan'], allergens: ['soy', 'gluten', 'tree_nuts', 'peanuts'], dislikedIngredientIds: ['black-beans-cooked'], maxCookMinutes: 5 } });
    const r = buildMealPlanAction({}, planCtx(acc));
    expect(r.action).toBeNull();
    expect(r.errors[0]).toMatch(/^Nothing in the catalog fits Vegan \+ no soy/);
  });

  it('without sharing or targets → the missing-data reason with its link (no plan)', () => {
    expect(buildMealPlanAction({}, planCtx(account(), { nutrition: { ...nutritionStatus(account(), false) } })).errors[0]).toMatch(/training assistant settings/);
    const none = account({ nutrition: { mode: 'none' } });
    expect(buildMealPlanAction({}, planCtx(none)).errors[0]).toMatch(/Set your targets/);
  });

  it('vague request + a model that invents meals instead of calling the tool → the server builds a real plan and replaces the text', async () => {
    const m = makeDb(data());
    const { fetch } = provider([text('I can’t access the recipe catalog from here, but try this:\n- Mon: oats\n- Tue: chicken salad\n- Wed: pasta')]);
    const { d, logs } = deps(m.db, fetch);
    const res = await handleAiCoach(d, U, send('make me a meal plan for this week and add it'));
    const reply = res.body.reply as StoredMessage;
    expect((reply.action as MealPlanAction).kind).toBe('meal_plan');
    expect(reply.content).toMatch(/^Here's your meal plan for today to Sunday \(4 days\) — tap \*\*Add to my meal plan\*\*/);
    expect(reply.content).not.toMatch(/catalog|oats|pasta/);
    expect(logs.find((l) => l.event === 'ai_reply_replaced')).toMatchObject({ reason: 'meal_plan_fallback' });
  });

  it('the prompt forbids saying tools are unavailable and inventing meals as the plan', async () => {
    const { requests, fetch } = provider([text('ok')]);
    await handleAiCoach(deps(makeDb(data()).db, fetch).d, U, send('hi'));
    expect(requests[0].system).toMatch(/Never say a tool or the recipe catalog is unavailable unless a tool call actually returned an error/);
    expect(requests[0].system).toMatch(/Never present your own invented meals as the plan/);
    expect(requests[0].system).toMatch(/call propose_meal_plan with their intent only/);
  });
});

/* ================================================================== find_recipes */
describe('MOCKED find_recipes: tolerant matching and a non-empty fallback', () => {
  const run = async (input: Record<string, unknown>, f: Partial<UserFacts> = {}) => {
    const state: ToolState = { proposal: null, proposalAttempts: 0 };
    const out = await runTool('find_recipes', input, { db: makeDb(data()).db, facts: facts(f), catalog: new Map(), state, messageId: mid(2), nutrition: nutritionStatus(account(), true), account: account() });
    return { body: JSON.parse(out.content), state };
  };
  it('case- and accent-insensitive, ingredient names and synonyms (fish → cod/salmon/tuna)', async () => {
    const a = await run({ query: 'CHÍCKEN' });
    expect(a.body.results.length).toBeGreaterThan(0);
    expect(a.body.results.every((r: { name: string }) => /chicken/i.test(r.name) || RECIPES.find((x) => x.id === (r as unknown as { id: string }).id)!.ingredients.some((i) => i.ingredientId.includes('chicken')))).toBe(true);
    const fish = await run({ query: 'fish dinner' }, { maxCookMinutes: 60 });
    expect(fish.body.fallback).toBeUndefined();
    expect(fish.body.results.some((r: { name: string }) => /cod|salmon|tuna|prawn/i.test(r.name))).toBe(true);
  });
  it('tags in the query: vegan, quick, high protein, meal type', async () => {
    expect(parseQuery('quick high-protein vegan breakfast')).toMatchObject({ meal: 'breakfast', diet: ['vegan'], quick: true, highProtein: true });
    const v = await run({ query: 'vegan' });
    const byId = new Map(INGREDIENTS.map((i) => [i.id, i]));
    for (const r of v.body.results as { id: string }[]) expect(RECIPES.find((x) => x.id === r.id)!.ingredients.filter((i) => !i.optional).every((i) => byId.get(i.ingredientId)!.diet.vegan)).toBe(true);
  });
  it('vague or unmatched query → best fits for the targets (never empty), with a note', async () => {
    const vague = await run({});
    expect(vague.body.results).toHaveLength(3);
    const odd = await run({ query: 'sushi' });
    expect(odd.body.results.length).toBeGreaterThan(0);
    expect(odd.body.fallback).toMatch(/No recipe matched "sushi"/);
    expect(odd.state.recipes?.recipes.length).toBeGreaterThan(0);
  });
  it('empty only when the user’s own settings exclude everything — and says which', async () => {
    const r = await run({}, { dietTags: ['vegan'], allergens: ['soy', 'gluten', 'tree_nuts', 'peanuts'], maxCookMinutes: 5 });
    expect(r.body.results).toEqual([]);
    expect(r.body.reason).toMatch(/Nothing in the catalog fits Vegan \+ no soy .*≤ 5 min/);
  });
});

/* ================================================================== 2. text vs card */
const weekAction = (): WeekAdjustmentAction => ({
  kind: 'week_adjustment', id: mid(1), baseProgramId: P1, baseVersion: 2, managedBy: 'self', weekStart: '2026-10-26', weekEnd: '2026-11-01', targetSessions: 2,
  completed: [{ date: '2026-10-26', name: 'Full body A' }],
  sessions: [{ templateId: 'fb-c', name: 'Full body C', date: '2026-10-31', plannedDate: '2026-10-30' }],
  skipped: [{ templateId: 'fb-b', name: 'Full body B', plannedDate: '2026-10-28' }],
  adjustments: [], warnings: ['Sat 31 Oct is not one of your usual training days.'], summary: '',
});

describe('MOCKED reply text must match the action card', () => {
  it('detects contradictions; consistent text passes', () => {
    const a = weekAction();
    expect(weekPlanConflict('Do **Full body C** on Sat and **Full body B** on Sun.', a, TODAY)).toMatch(/Full body B is skipped/);
    expect(weekPlanConflict('Full body C on Friday works.', a, TODAY)).toMatch(/another day/);
    expect(weekPlanConflict('Full body C moves to Saturday; Full body B is skipped this week.', a, TODAY)).toBeNull();
    expect(weekPlanConflict('Here’s your week — tap Apply to this week.', a, TODAY)).toBeNull();
    expect(summarizeWeekPlan(a, TODAY)).toBe('Here\'s this week: **Full body C** moves to Saturday, **Full body B** is skipped this week. Sat 31 Oct is not one of your usual training days. Tap **Apply to this week** to use it.');
  });

  it('end to end: a contradicting reply is replaced by the generated summary and logged; a consistent one is kept', async () => {
    const plan = { total_sessions_this_week: 2, sessions: [{ template_id: 'fb-c', date: '2026-10-31' }] };
    const m1 = makeDb(data());
    const p1 = provider([toolUse('propose_week_adjustment', plan), text('Do **Full body C** on Sat and **Full body B** on Sun.')]);
    const r1 = deps(m1.db, p1.fetch);
    const res1 = await handleAiCoach(r1.d, U, send('I can only train twice this week'));
    expect((res1.body.reply as StoredMessage).content).toMatch(/^Here's this week: \*\*Full body C\*\* moves to Saturday, \*\*Full body B\*\* is skipped this week\./);
    expect(r1.logs.find((l) => l.event === 'ai_reply_replaced')).toMatchObject({ reason: 'week_plan_conflict' });

    const m2 = makeDb(data());
    const ok = 'Two this week: Full body C moves to Saturday and Full body B is skipped.';
    const res2 = await handleAiCoach(deps(m2.db, provider([toolUse('propose_week_adjustment', plan), text(ok)]).fetch).d, U, send('I can only train twice this week'));
    expect((res2.body.reply as StoredMessage).content).toBe(ok);
  });

  it('meal plan text that lists meals or names a recipe not in the plan is a conflict', () => {
    const a: MealPlanAction = { kind: 'meal_plan', id: 'x', weekStart: '2026-10-26', weekEnd: '2026-11-01', targets: { proteinG: 198, kcal: null }, summary: '', warnings: [],
      days: [{ date: TODAY, items: [{ slot: 'lunch', recipeId: RECIPES[6].id, name: RECIPES[6].name, servings: 1 }] }] };
    expect(mealPlanConflict(`Lunch is ${RECIPES[7].name}.`, a, RECIPES.map((r) => r.name))).toMatch(/isn't in the plan/);
    expect(mealPlanConflict('- Mon: a\n- Tue: b\n- Wed: c', a, [])).toMatch(/restates/);
    expect(mealPlanConflict('Here’s your week — tap Add to my meal plan.', a, RECIPES.map((r) => r.name))).toBeNull();
  });
});

/* ================================================================== 3. open request */
describe('MOCKED follow-ups resume the open request', () => {
  const blockedExchange = (grounding: string[]): StoredMessage[] => [
    { id: mid(80), role: 'user', content: 'make a meal plan for the week and add it', createdAt: '2026-10-29T09:00:00Z' },
    { id: mid(81), role: 'assistant', content: 'I can’t see your nutrition yet. You can share it under training assistant settings.\n[[open:/coaching/ai/settings|Change what the coach can see]]', createdAt: '2026-10-29T09:00:05Z', grounding },
  ];

  it('findOpenRequest / isFollowUp', () => {
    expect(isFollowUp('Ok try now')).toBe(true);
    expect(isFollowUp('yes, but make the meal plan')).toBe(true);
    expect(isFollowUp('How should I progress my bench press next week?')).toBe(false);
    expect(findOpenRequest(blockedExchange(['Profile & preferences']))).toEqual({ text: 'make a meal plan for the week and add it', intent: 'meal_plan', blocked: true });
    const delivered = [...blockedExchange([]).slice(0, 1), { id: 'r', role: 'assistant' as const, content: 'Here.', createdAt: 'x', action: { kind: 'meal_plan' } as never }];
    expect(findOpenRequest(delivered)).toBeNull();
  });

  it('sharing changed (nutrition added): the history is carried over, the coach is told to thank and resume, and "Ok try now" ends in a meal plan', async () => {
    const d = data({ scopesChangedAt: '2026-10-29T09:30:00Z', messages: blockedExchange(['Profile & preferences', '1 recent workout', 'Active plan: Full body 3x (v2)']) });
    const m = makeDb(d);
    // The model drifts to an unrelated offer and doesn't call the tool — the server still resumes the meal plan.
    const { fetch, requests } = provider([text('Want me to adjust this week so you can fit in Full body B?')]);
    const { d: dp, logs } = deps(m.db, fetch);
    const res = await handleAiCoach(dp, U, send('Ok try now'));
    expect(requests[0].system).toMatch(/Sharing changed since your previous reply: the user now also shares nutrition\. Start with a brief thanks \(e\.g\. "Thanks — I can see your nutrition now"\)/);
    expect(requests[0].system).toMatch(/Open request: .*asked for a meal plan .*blocked by missing sharing or setup\. The newest message is a short follow-up: resume THIS request now/);
    expect(requests[0].system).toContain('<user_data kind="open_request">\nmake a meal plan for the week and add it\n</user_data>');
    expect(JSON.stringify(requests[0].messages)).toContain('make a meal plan for the week and add it');
    expect(((res.body.reply as StoredMessage).action as MealPlanAction).kind).toBe('meal_plan');
    expect(logs.find((l) => l.event === 'ai_send')).toMatchObject({ open_request: 'meal_plan', replaced: 'meal_plan_fallback' });
    expect((res.body.reply as StoredMessage).content).toMatch(/^Thanks — I can see your nutrition now. Here's your meal plan/);
  });

  it('a category was revoked → the old history stays cut off (privacy) even for a follow-up', async () => {
    const d = data({ scopes: { ...ALL, training: false }, scopesChangedAt: '2026-10-29T09:30:00Z', messages: blockedExchange(['Profile & preferences', '1 recent workout']) });
    const ctx = await buildContext({ db: makeDb(d).db, uid: U, settings: { enabled: true, paused: false, scopes: d.scopes, scopesChangedAt: d.scopesChangedAt, profileNotes: '' }, text: 'ok try now', mode: 'chat', now: NOW });
    expect(JSON.stringify(ctx.messages)).not.toContain('make a meal plan');
    expect(ctx.system).not.toMatch(/Sharing changed since your previous reply/);
  });

  it('the follow-up rules are in the prompt (two-part answers handled together)', async () => {
    const ctx = await buildContext({ db: makeDb(data()).db, uid: U, settings: { enabled: true, paused: false, scopes: ALL, profileNotes: '' }, text: 'hi', mode: 'chat', now: NOW });
    expect(ctx.system).toMatch(/"try now" and similar short replies resume the open request/);
    expect(ctx.system).toMatch(/\("yes, but make the meal plan"\), handle both parts in this reply/);
  });
});

/* ================================================================== 4–6. links, dates, chips, recipes */
describe('MOCKED links, dates, chips and recipe links', () => {
  it('link lead-in lines are removed (server and app) and links go to the end', () => {
    const raw = 'Here are some picks.\n\nOpen recipes to pick or browse:\n[[open:/nutrition/recipes|Recipes]]\n\nAlso check this. Open the meal-plan screen: [[open:/nutrition/plan|Meal plan]]\nOpen settings:';
    const server = validateOpenLinks(raw, {});
    expect(server.text).toBe('Here are some picks.\n\nAlso check this.\n[[open:/nutrition/recipes|Recipes]]\n[[open:/nutrition/plan|Meal plan]]');
    const app = extractOpenLinks(raw);
    expect(app.text).toBe('Here are some picks.\n\nAlso check this.');
    expect(app.links.map((l) => l.path)).toEqual(['/nutrition/recipes', '/nutrition/plan']);
  });

  it('recipe links: kept for catalog ids (up to 3), stripped for unknown ids', () => {
    const known = { recipe: new Set(RECIPES.map((r) => r.id)) };
    const ids = RECIPES.slice(0, 4).map((r) => r.id);
    const r = validateOpenLinks(`${ids.map((id) => `**x** [[open:/nutrition/recipes/${id}|Open recipe]]`).join('\n')}\n[[open:/nutrition/recipes/made-up-dish|Open recipe]]`, known);
    expect(r.kept.map((k) => k.path)).toEqual(ids.slice(0, 3).map((id) => `/nutrition/recipes/${id}`));
    expect(r.text).not.toContain('made-up-dish');
  });

  it('no full recipes in chat: the rule is in the prompt and a written-out recipe is logged as a warning', async () => {
    const recipe = 'Here’s how:\n**Ingredients**\n- 200 g chicken\n- 100 g rice\n- 1 tbsp oil\n\n1. Cook the rice.\n2. Fry the chicken.';
    expect(looksLikeFullRecipe(recipe)).toBe(true);
    expect(looksLikeFullRecipe(`**${RECIPES[0].name}** — 34 g protein, 15 min\n[[open:/nutrition/recipes/${RECIPES[0].id}|Open recipe]]`)).toBe(false);
    const { fetch, requests } = provider([text(recipe)]);
    const { d, logs } = deps(makeDb(data()).db, fetch);
    await handleAiCoach(d, U, send('how do I make the chicken bowl?'));
    expect(requests[0].system).toMatch(/never write a recipe's ingredient list or steps in chat, even when asked how to make it/);
    expect(requests[0].system).toMatch(/\[\[open:\/nutrition\/recipes\/<id>\|Open recipe\]\]/);
    expect(logs.some((l) => l.event === 'ai_full_recipe_warning')).toBe(true);
  });

  it('human dates: helpers, reply text and week-plan warnings', async () => {
    expect(humanDate('2026-10-29', TODAY)).toBe('today');
    expect(humanDate('2026-10-30', TODAY)).toBe('tomorrow');
    expect(humanDate('2026-10-31', TODAY)).toBe('Saturday');
    expect(humanDate('2026-11-10', TODAY)).toBe('Tue 10 Nov');
    expect(humanDate('2026-11-03', TODAY)).toBe('Tue 3 Nov'); // next week → no bare weekday
    expect(humanDate('2026-11-01', TODAY, 0)).toBe('Sun 1 Nov'); // weeks starting Sunday end on Saturday
    expect(shortDate('2026-10-31')).toBe('Sat 31 Oct');
    expect(datePair('2026-10-30', '2026-10-31')).toBe('Fri 30 and Sat 31 Oct');
    expect(humanizeDates('Do it on Sat 2026-10-31, or 2026-10-30. [[open:/train/history/2026-10-26|x]]', TODAY)).toBe('Do it on Sat 31 Oct, or tomorrow. [[open:/train/history/2026-10-26|x]]');
    const { fetch } = provider([text('Rest on 2026-10-30 and train 2026-11-03.')]);
    const res = await handleAiCoach(deps(makeDb(data()).db, fetch).d, U, send('when should I rest?'));
    expect((res.body.reply as StoredMessage).content).toBe('Rest on tomorrow and train Tue 3 Nov.');
    // week plan warnings are written with human dates by the server
    const p = provider([toolUse('propose_week_adjustment', { total_sessions_this_week: 3, sessions: [{ template_id: 'fb-b', date: '2026-10-30' }, { template_id: 'fb-c', date: '2026-10-31' }] }), text('ok')]);
    const r2 = await handleAiCoach(deps(makeDb(data()).db, p.fetch).d, U, send('I can only train three times this week'));
    const w = ((r2.body.reply as StoredMessage).action as WeekAdjustmentAction).warnings;
    expect(w).toContain('Sat 31 Oct is not one of your usual training days.');
    expect(w).toContain('Back-to-back days (Fri 30 and Sat 31 Oct): keep the effort a little lower on the second.');
    expect(w.join(' ')).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('chip pluralization: "1 recent workout" vs "2 recent workouts"', async () => {
    const one = await buildContext({ db: makeDb(data()).db, uid: U, settings: { enabled: true, paused: false, scopes: ALL, profileNotes: '' }, text: 'hi', mode: 'chat', now: NOW });
    expect(one.grounding).toContain('1 recent workout');
    const two = await buildContext({ db: makeDb(data({ sessions: [MONDAY_DONE, { ...MONDAY_DONE, id: 's2', date: '2026-10-23' }] })).db, uid: U, settings: { enabled: true, paused: false, scopes: ALL, profileNotes: '' }, text: 'hi', mode: 'chat', now: NOW });
    expect(two.grounding).toContain('2 recent workouts');
  });
});
