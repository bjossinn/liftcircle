/**
 * Training assistant correctness fixes (1.0.2) — MOCKED provider (injected fetch), in-memory data, the app's REAL
 * recipe and ingredient catalog. Found in the cross-review of 25 Nov 2026:
 *  1. the Supabase adapter's getHistory now returns `action` and `grounding`, so follow-ups ("ok, try now") and the
 *     sharing-changed check work against the real database, not only the in-memory test db;
 *  2. the meal-plan fallback (model didn't call propose_meal_plan) keeps the user's own constraints — "no fish, two
 *     meals a day, next week" — and says honestly when they can't be met, instead of an unrestricted default plan;
 *  3. find_recipes treats a request's diet words and "no …"/"without …"/"án …" as hard constraints: the fallback steps
 *     loosen words, meal type, quick and protein, never those; a ruled-out word is never searched FOR;
 *  4. Icelandic: allergen/diet words, "án", follow-ups ("já, prófaðu núna") and "matarplan" are understood.
 */
import { describe, expect, it } from 'vitest';
import { handleAiCoach, type CoachDeps } from '../../supabase/functions/_shared/ai/coach';
import { runTool, type ToolState } from '../../supabase/functions/_shared/ai/tools';
import { buildMealPlanAction, mealPlanIntentFromText, parseExclusions, parseQuery } from '../../supabase/functions/_shared/ai/meals';
import { nutritionStatus } from '../../supabase/functions/_shared/ai/dataStatus';
import { classifyIntent, findOpenRequest, isFollowUp } from '../../supabase/functions/_shared/ai/conversation';
import { createSupabaseAiDb, historyMessage, type SbClient } from '../../supabase/functions/_shared/ai/supabaseDb';
import type {
  AccountStatePayload, AiDb, AiScopes, AiSettingsRow, FetchLike, MealPlanAction, RecordExchangeInput, RefIngredient, RefRecipe, StoredExchange,
  StoredMessage, UserFacts,
} from '../../supabase/functions/_shared/ai/types';
import { RECIPES } from '@/data/recipes';
import { INGREDIENTS } from '@/data/ingredients';

const U = '11111111-1111-4111-8111-111111111111';
const mid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = new Date('2026-10-29T10:00:00Z'); // Thursday; week Mon 26 Oct – Sun 1 Nov
const TODAY = '2026-10-29';
const REF_RECIPES = RECIPES as unknown as RefRecipe[];
const REF_INGREDIENTS = INGREDIENTS as unknown as RefIngredient[];
const ING = new Map(INGREDIENTS.map((i) => [i.id, i]));
const ALL: AiScopes = { profile: true, training: true, measurements: false, nutrition: true };

function account(diet: Record<string, unknown> = {}): AccountStatePayload {
  return {
    settings: { units: { weight: 'kg' }, timeZone: 'UTC', weekStart: 1, nutritionEnabled: true },
    profile: { goal: 'build_muscle', diet: { tags: [], allergens: [], dislikedIngredientIds: [], maxCookMinutes: 30, mealsPerDay: 3, budget: 'any', ...diet } as never },
    nutrition: { mode: 'protein_only', proteinG: 180, proteinPerKg: 2 },
  };
}
const facts = (over: Partial<UserFacts> = {}): UserFacts => ({
  units: 'kg', timeZone: 'UTC', weekStart: 1, equipment: null, excludedExerciseIds: [], limitations: [], allergens: [], dietTags: [], dislikedIngredientIds: [], maxCookMinutes: 30, activeProgram: null, ...over,
});

function makeDb(messages: StoredMessage[] = [], acc: AccountStatePayload = account(), scopesChangedAt: string | null = null) {
  const recorded: RecordExchangeInput[] = [];
  const exchanges = new Map<string, StoredExchange>();
  const settings: AiSettingsRow = { enabled: true, paused: false, consentAt: '2026-10-01T00:00:00Z', scopes: ALL, scopesChangedAt, profileNotes: '' };
  const db: AiDb = {
    getSettings: async () => settings,
    getExchange: async (_u, id) => exchanges.get(id) ?? null,
    checkAndCountUsage: async () => 10,
    getUsage: async (_u, day) => ({ day, requests: 0, inputTokens: 0, outputTokens: 0, costUsd: null }),
    getAccountState: async () => acc,
    getActiveProgram: async () => null,
    getRecentSessions: async () => [],
    getGoals: async () => [],
    getBodyweight: async () => [],
    getFoodLogs: async () => [],
    getHistory: async (_u, after, limit) => messages.filter((m) => !after || m.createdAt > after).slice(-limit),
    recordExchange: async (_u, input) => {
      recorded.push(input);
      const reply: StoredMessage = { id: mid(700 + recorded.length), role: 'assistant', content: input.reply.content, createdAt: NOW.toISOString(), grounding: input.reply.grounding, proposalId: null, action: input.reply.action ?? null };
      const ex = { reply, proposal: null, duplicate: false };
      exchanges.set(input.message.id, ex);
      return ex;
    },
    getExercises: async () => [],
    getRecipes: async () => REF_RECIPES,
    getIngredients: async () => REF_INGREDIENTS,
  };
  return { db, recorded };
}
const text = (t: string) => ({ id: 'm', model: 'claude-test', content: [{ type: 'text', text: t }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } });
function provider(replies: unknown[]) {
  const fetch: FetchLike = async () => {
    const body = replies.shift() ?? text('…');
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { fetch };
}
function deps(db: AiDb, fetch: FetchLike) {
  const logs: { event: string; [k: string]: unknown }[] = [];
  const d: CoachDeps = { db, fetch, env: (k) => (k === 'ANTHROPIC_API_KEY' ? 'sk-test' : undefined), now: () => NOW, sleep: async () => undefined, random: () => 0.5, log: (event, fields) => logs.push({ event, ...fields }) };
  return { d, logs };
}
const send = (t: string, n = 1) => ({ action: 'send', id: mid(n), text: t, mode: 'chat' });
const allergensOf = (recipeId: string) => RECIPES.find((r) => r.id === recipeId)!.ingredients.filter((i) => !i.optional).flatMap((i) => ING.get(i.ingredientId)?.allergens ?? []);
const planAllergens = (a: MealPlanAction) =>
  a.days.flatMap((d) => d.items.flatMap((it) => [...allergensOf(it.recipeId), ...(it.extras ?? []).flatMap((e) => ING.get(e.ingredientId)?.allergens ?? [])]));

/* ================================================================== 1. history from the real adapter */
describe('Supabase adapter: getHistory returns action and grounding', () => {
  it('selects both columns and maps them', async () => {
    const selects: string[] = [];
    const rows = [
      { id: 'r1', role: 'assistant', content: 'Here.', created_at: '2026-10-29T09:00:05Z', proposal_id: null, grounding: ['Profile & preferences', 7], action: { kind: 'meal_plan', id: 'x' } },
      { id: 'u1', role: 'user', content: 'make a meal plan', created_at: '2026-10-29T09:00:00Z', proposal_id: null, grounding: [], action: null },
    ];
    const builder = () => {
      const b: Record<string, unknown> = {};
      for (const op of ['eq', 'is', 'gte', 'gt', 'order', 'limit']) b[op] = () => b;
      b.select = (cols: string) => {
        selects.push(cols);
        return b;
      };
      b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(res);
      return b;
    };
    const client: SbClient = { from: builder, rpc: () => Promise.resolve({ data: null, error: null }) };
    const history = await createSupabaseAiDb(client, client).getHistory(U, null, 20);
    expect(selects[0]).toMatch(/\bgrounding\b/);
    expect(selects[0]).toMatch(/\baction\b/);
    expect(history.map((m) => m.id)).toEqual(['u1', 'r1']); // oldest first
    expect(history[1]).toMatchObject({ grounding: ['Profile & preferences'], action: { kind: 'meal_plan' } });
    // A delivered meal plan closes the request, so "ok" doesn't regenerate it.
    expect(findOpenRequest(history)).toBeNull();
  });

  it('malformed stored values are dropped, never passed on', () => {
    expect(historyMessage({ id: 'a', role: 'assistant', content: 'x', created_at: 't', proposal_id: null, grounding: 'oops', action: ['x'] })).toMatchObject({ grounding: [], action: null });
    expect(historyMessage({ id: 'a', role: 'assistant', content: 'x', created_at: 't', proposal_id: null, action: { no: 'kind' } }).action).toBeNull();
  });
});

/* ================================================================== 2. meal-plan fallback keeps the request */
describe('meal-plan fallback keeps what the user asked for', () => {
  it('reads meals per day, week, days, quick, diet and exclusions from the user’s words (English and Icelandic)', () => {
    expect(mealPlanIntentFromText('Make next week’s meal plan, no fish, two meals a day')).toMatchObject({ week: 'next', meals_per_day: 2, avoid: ['fish'] });
    expect(mealPlanIntentFromText('meal plan for Monday and Friday, quick and vegan please')).toMatchObject({ days: ['monday', 'friday'], quick: true, diet: ['vegan'] });
    expect(mealPlanIntentFromText('Búðu til matarplan fyrir næstu viku, tvær máltíðir á dag, án fisks')).toMatchObject({ week: 'next', meals_per_day: 2, avoid: ['fisks'] });
    expect(mealPlanIntentFromText('matarplan fyrir þriðjudag og helgina')).toMatchObject({ days: ['tuesday', 'saturday', 'sunday'] });
    // Nothing stated → nothing set (the user's saved settings apply).
    const plain = mealPlanIntentFromText('make me a meal plan');
    expect(plain.meals_per_day).toBeUndefined();
    expect(plain.avoid).toBeUndefined();
  });

  it('a model that skips the tool still yields a plan that honours "no fish, two meals a day, next week"', async () => {
    const m = makeDb();
    const { fetch } = provider([text('Sure! Mon: salmon bowl, Tue: cod tacos …')]);
    const { d, logs } = deps(m.db, fetch);
    const res = await handleAiCoach(d, U, send('Make next week’s meal plan, no fish, two meals a day'));
    const action = (res.body.reply as StoredMessage).action as MealPlanAction;
    expect(action.kind).toBe('meal_plan');
    expect(action.weekStart).toBe('2026-11-02');
    for (const day of action.days) expect(day.items).toHaveLength(2);
    expect(planAllergens(action)).not.toContain('fish');
    expect(planAllergens(action)).not.toContain('shellfish');
    expect((res.body.reply as StoredMessage).content).not.toMatch(/salmon|cod/i);
    expect(logs.find((l) => l.event === 'ai_reply_replaced')).toMatchObject({ reason: 'meal_plan_fallback' });
  });

  it('a follow-up ("já, prófaðu núna") resumes the ORIGINAL request with its constraints', async () => {
    const history: StoredMessage[] = [
      { id: mid(80), role: 'user', content: 'Make a meal plan for next week without fish, two meals a day', createdAt: '2026-10-29T09:00:00Z' },
      { id: mid(81), role: 'assistant', content: 'I can’t see your nutrition yet. You can share it under training assistant settings.', createdAt: '2026-10-29T09:00:05Z', grounding: ['Profile & preferences'], action: null },
    ];
    const m = makeDb(history);
    const { fetch } = provider([text('Frábært, hér kemur það.')]);
    const res = await handleAiCoach(deps(m.db, fetch).d, U, send('Já, prófaðu núna'));
    const action = (res.body.reply as StoredMessage).action as MealPlanAction;
    expect(action.kind).toBe('meal_plan');
    expect(action.weekStart).toBe('2026-11-02');
    for (const day of action.days) expect(day.items).toHaveLength(2);
    expect(planAllergens(action)).not.toContain('fish');
  });

  it('impossible constraints → an honest reply and no plan (never an unrestricted default)', async () => {
    const everyProtein = ['chicken', 'turkey', 'beef', 'pork', 'lamb', 'white_fish', 'oily_fish', 'tuna', 'prawns', 'shellfish', 'eggs', 'dairy', 'tofu_tempeh', 'beans_lentils', 'chickpeas', 'whey', 'plant_protein'];
    const m = makeDb([], account({ proteinPrefs: { liked: [], excluded: everyProtein } }));
    const { fetch } = provider([text('Here you go: tofu stir fry every day.')]);
    const { d, logs } = deps(m.db, fetch);
    const res = await handleAiCoach(d, U, send('make me a meal plan for next week'));
    const reply = res.body.reply as StoredMessage;
    expect(reply.action ?? null).toBeNull();
    expect(reply.content).toMatch(/^I couldn't build that meal plan with what you asked for: Nothing in the catalog fits/);
    expect(logs.find((l) => l.event === 'ai_reply_replaced')).toMatchObject({ reason: 'meal_plan_fallback_failed' });
  });

  it('buildMealPlanAction: "no fish" in the model’s own preferences is a real exclusion (regex no longer leaks)', () => {
    const acc = account();
    const ctx = { facts: facts(), account: acc, today: TODAY, nutrition: nutritionStatus(acc, true), messageId: mid(5), recipes: REF_RECIPES, ingredients: REF_INGREDIENTS };
    const built = buildMealPlanAction({ week: 'next', preferences: ['without fish or nuts please'] }, ctx);
    expect(built.action).not.toBeNull();
    const al = planAllergens(built.action!);
    expect(al).not.toContain('fish');
    expect(al).not.toContain('tree_nuts');
    // Mentioning fish positively rules nothing out.
    const withFish = buildMealPlanAction({ week: 'next', preferences: ['I love fish'] }, ctx);
    expect(planAllergens(withFish.action!)).toContain('fish');
  });
});

/* ================================================================== 3. find_recipes never relaxes explicit restrictions */
describe('find_recipes: a request’s restrictions are hard constraints', () => {
  const run = async (input: Record<string, unknown>, f: Partial<UserFacts> = {}) => {
    const state: ToolState = { proposal: null, proposalAttempts: 0 };
    const out = await runTool('find_recipes', input, { db: makeDb().db, facts: facts(f), catalog: new Map(), state, messageId: mid(2), nutrition: nutritionStatus(account(), true), account: account() });
    return JSON.parse(out.content) as { results: { id: string }[]; reason?: string; note?: string; fallback?: string };
  };
  const isVegan = (id: string) => RECIPES.find((r) => r.id === id)!.ingredients.filter((i) => !i.optional).every((i) => ING.get(i.ingredientId)!.diet.vegan);

  it('parseExclusions: English, Icelandic and "X-free"; "an apple" is not a negation', () => {
    expect(parseExclusions('no fish').allergens).toEqual(expect.arrayContaining(['fish', 'shellfish']));
    expect(parseExclusions('without nuts or eggs').allergens).toEqual(expect.arrayContaining(['tree_nuts', 'egg']));
    expect(parseExclusions('vegan morgunmatur án glútens og hneta').allergens).toEqual(expect.arrayContaining(['gluten', 'tree_nuts']));
    expect(parseExclusions('nut-free snack').allergens).toContain('tree_nuts');
    expect(parseExclusions('mjólkurlaus kvöldmatur').allergens).toContain('milk');
    expect(parseExclusions('an apple and a banana').raw).toEqual([]);
    expect(parseExclusions('no pork').words).toEqual(['pork']);
    expect(parseExclusions('no more than 20 minutes').words).toEqual([]);
  });

  it('a ruled-out word is never searched for', () => {
    const q = parseQuery('dinner without salmon');
    expect(q.words).not.toContain('salmon');
    expect(q.exclude.words).toContain('salmon');
  });

  it('"vegan" in the request survives every fallback step', async () => {
    // "sushi" matches nothing, so the search falls back — but only to vegan recipes.
    const r = await run({ query: 'vegan sushi', max_results: 5 });
    expect(r.results.length).toBeGreaterThan(0);
    for (const x of r.results) expect(isVegan(x.id)).toBe(true);
    expect(r.fallback).toMatch(/restrictions still apply|No recipe matched/);
  });

  it('"no fish" excludes fish and shellfish recipes; "án hneta" excludes nuts', async () => {
    const fish = await run({ query: 'dinner, no fish', max_results: 5 }, { maxCookMinutes: 60 });
    for (const x of fish.results) {
      expect(allergensOf(x.id)).not.toContain('fish');
      expect(allergensOf(x.id)).not.toContain('shellfish');
    }
    const nuts = await run({ query: 'morgunmatur án hneta', max_results: 5 }, { maxCookMinutes: 60 });
    for (const x of nuts.results) expect(allergensOf(x.id)).not.toContain('tree_nuts');
  });

  it('nothing fits the request’s restrictions → empty with the reason, never relaxed', async () => {
    // Vegan + these ≤ 5 min matches nothing; the user's settings alone (only the 5-minute limit) would match plenty.
    const r = await run({ query: 'vegan, without gluten, soy, nuts or peanuts' }, { maxCookMinutes: 5 });
    expect(r.results).toEqual([]);
    expect(r.reason).toMatch(/Nothing in the catalog fits/);
    expect(r.note).toMatch(/never relax a restriction/);
  });

  it('without restrictions in the request, behaviour is unchanged (fallback to best fits)', async () => {
    const r = await run({ query: 'sushi' });
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.fallback).toMatch(/No recipe matched "sushi"/);
  });
});

/* ================================================================== 4. Icelandic follow-ups and intents */
describe('Icelandic follow-ups and intents', () => {
  it('understands short Icelandic follow-ups and "matarplan"', () => {
    for (const t of ['Já', 'já takk', 'Já, prófaðu núna', 'endilega', 'gerðu það', 'reyndu aftur', 'Búin að deila']) expect(isFollowUp(t), t).toBe(true);
    for (const t of ['Hvað á ég að æfa í dag?', 'Ég er með verk í hnénu']) expect(isFollowUp(t), t).toBe(false);
    expect(classifyIntent('Búðu til matarplan fyrir vikuna')).toBe('meal_plan');
    expect(classifyIntent('Getur þú gert matseðil fyrir mig')).toBe('meal_plan');
  });
});
