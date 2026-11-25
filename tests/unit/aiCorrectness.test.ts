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
import { buildMealPlanAction, dietTagsIn, excludedIngredientIds, mealPlanIntentFromText, parseExclusions, parseQuery, stemWord, wantedDays } from '../../supabase/functions/_shared/ai/meals';
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
    expect(mealPlanIntentFromText('Make next week’s meal plan, no fish, two meals a day')).toMatchObject({ week: 'next', meals_per_day: 2, avoid: ['fish', 'shellfish'] });
    expect(mealPlanIntentFromText('meal plan for Monday and Friday, quick and vegan please')).toMatchObject({ days: ['monday', 'friday'], quick: true, diet: ['vegan'] });
    expect(mealPlanIntentFromText('Búðu til matarplan fyrir næstu viku, tvær máltíðir á dag, án fisks')).toMatchObject({ week: 'next', meals_per_day: 2, avoid: ['fish', 'shellfish'] });
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
    expect(parseExclusions('ég borða ekki svínakjöt eða sveppi').words).toEqual(['pork', 'mushroom']);
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

/* ================================================================== review of PR #16 (ChatGPT, 25 Nov) */
const toolUse = (name: string, input: unknown, id = 'toolu_1') => ({ id: 'mt', model: 'claude-test', content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 10 } });
function capturingProvider(replies: unknown[]) {
  const requests: { system: string; messages: { role: string; content: unknown }[] }[] = [];
  const fetch: FetchLike = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    const body = replies.shift() ?? text('…');
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { fetch, requests };
}
/** In-memory db whose history grows with every exchange (user message + stored reply, action and grounding kept). */
function conversationDb(opts: { messages?: StoredMessage[]; scopes?: AiScopes; scopesChangedAt?: string | null; acc?: AccountStatePayload } = {}) {
  const messages: StoredMessage[] = [...(opts.messages ?? [])];
  const settings: AiSettingsRow = { enabled: true, paused: false, consentAt: '2026-10-01T00:00:00Z', scopes: opts.scopes ?? ALL, scopesChangedAt: opts.scopesChangedAt ?? null, profileNotes: '' };
  const actions: (MealPlanAction | null)[] = [];
  let clock = Date.parse('2026-10-29T09:50:00Z');
  const db: AiDb = {
    ...makeDb([], opts.acc ?? account()).db,
    getSettings: async () => settings,
    getExchange: async () => null,
    getHistory: async (_u, after, limit) => messages.filter((m) => !after || m.createdAt > after).slice(-limit),
    recordExchange: async (_u, input) => {
      const at = (ms: number) => new Date(ms).toISOString();
      messages.push({ id: input.message.id, role: 'user', content: input.message.content, createdAt: at((clock += 1000)) });
      const reply: StoredMessage = { id: `r-${input.message.id}`, role: 'assistant', content: input.reply.content, createdAt: at((clock += 1000)), grounding: input.reply.grounding, proposalId: null, action: input.reply.action ?? null };
      messages.push(reply);
      actions.push((input.reply.action as MealPlanAction | null) ?? null);
      return { reply, proposal: null, duplicate: false };
    },
  };
  return { db, messages, actions, settings };
}
const allMessageText = (req: { system: string; messages: { content: unknown }[] }) => JSON.stringify(req.messages);
const nutsOrFish = (a: MealPlanAction) => planAllergens(a).filter((x) => x === 'fish' || x === 'shellfish' || x === 'tree_nuts');

describe('PR #16 review: a revoked category never re-enters history', () => {
  it('share nutrition → nutrition reply → revoke → training-only reply → share measurements: the nutrition exchange is not carried', async () => {
    const NUTRITION_REPLY = 'Your food log shows 142 g protein a day on average — about 40 g short of your 180 g target.';
    const messages: StoredMessage[] = [
      { id: 'u1', role: 'user', content: 'How is my protein this week?', createdAt: '2026-10-29T08:00:00Z' },
      { id: 'a1', role: 'assistant', content: NUTRITION_REPLY, createdAt: '2026-10-29T08:00:05Z', grounding: ['Profile & preferences', 'Nutrition targets & 7-day food log'], action: null },
      // 08:30 nutrition revoked (an earlier scopesChangedAt; only the latest is stored)
      { id: 'u2', role: 'user', content: 'Should I train legs tomorrow?', createdAt: '2026-10-29T09:00:00Z' },
      { id: 'a2', role: 'assistant', content: 'Yes, Full body B is tomorrow.', createdAt: '2026-10-29T09:00:05Z', grounding: ['Profile & preferences', '1 recent workout'], action: null },
    ];
    // 09:30 measurements shared — the latest change; nutrition still off.
    const conv = conversationDb({ messages, scopes: { profile: true, training: true, measurements: true, nutrition: false }, scopesChangedAt: '2026-10-29T09:30:00Z' });
    const { fetch, requests } = capturingProvider([text('Thanks — I can see your measurements now.')]);
    await handleAiCoach(deps(conv.db, fetch).d, U, send('ok, how is my weight trending?', 3));
    const sent = allMessageText(requests[0]);
    expect(sent).not.toContain('142 g protein');
    expect(sent).not.toContain('How is my protein this week?');
    expect(sent).toContain('Should I train legs tomorrow?'); // the training-only exchange is still carried
    expect(requests[0].system).not.toContain('142 g protein');
  });

  it('a reply with unknown grounding stops the carry-over too', async () => {
    const messages: StoredMessage[] = [
      { id: 'u1', role: 'user', content: 'Old question', createdAt: '2026-10-29T08:00:00Z' },
      { id: 'a1', role: 'assistant', content: 'Old answer with private data', createdAt: '2026-10-29T08:00:05Z', grounding: undefined as never, action: null },
      { id: 'u2', role: 'user', content: 'Newer question', createdAt: '2026-10-29T09:00:00Z' },
      { id: 'a2', role: 'assistant', content: 'Newer answer', createdAt: '2026-10-29T09:00:05Z', grounding: ['Profile & preferences'], action: null },
    ];
    const conv = conversationDb({ messages, scopesChangedAt: '2026-10-29T09:30:00Z' });
    const { fetch, requests } = capturingProvider([text('ok')]);
    await handleAiCoach(deps(conv.db, fetch).d, U, send('ok', 3));
    expect(allMessageText(requests[0])).not.toContain('Old answer with private data');
    expect(allMessageText(requests[0])).toContain('Newer answer');
  });
});

describe('PR #16 review: explicit food exclusions are never dropped', () => {
  it.each([
    ['no fish, no nuts', ['fish', 'shellfish', 'tree_nuts']],
    ['án fisks, án hneta', ['fish', 'shellfish', 'tree_nuts']],
    ['no tree nuts', ['tree_nuts']],
    ['without any nuts', ['tree_nuts']],
    ['without gluten, soy or nuts', ['gluten', 'soy', 'tree_nuts']],
    ['ekki fisk og engar hnetur', ['fish', 'shellfish', 'tree_nuts']],
  ])('parse: %s', (t, expected) => {
    expect(parseExclusions(t).allergens.sort()).toEqual([...expected].sort());
  });

  it.each([
    ['Make a meal plan for next week, no fish, no nuts'],
    ['Búðu til matarplan fyrir næstu viku, án fisks, án hneta'],
  ])('fallback plan for "%s" contains no fish or nut recipe or side', async (msg) => {
    const conv = conversationDb();
    const { fetch } = capturingProvider([text('Here: salmon Monday, nut granola Tuesday …')]);
    const res = await handleAiCoach(deps(conv.db, fetch).d, U, send(msg));
    const action = (res.body.reply as StoredMessage).action as MealPlanAction;
    expect(action.kind).toBe('meal_plan');
    expect(action.weekStart).toBe('2026-11-02');
    expect(action.days.length).toBe(7);
    expect(nutsOrFish(action)).toEqual([]);
  });

  it('tool path: the model calls propose_meal_plan without the user’s "no fish, no nuts" — the plan still honours it', async () => {
    const conv = conversationDb();
    const { fetch } = capturingProvider([toolUse('propose_meal_plan', { week: 'next' }), text('Here’s your week.')]);
    const res = await handleAiCoach(deps(conv.db, fetch).d, U, send('Make a meal plan for next week, no fish, no nuts'));
    const action = (res.body.reply as StoredMessage).action as MealPlanAction;
    expect(action.kind).toBe('meal_plan');
    expect(nutsOrFish(action)).toEqual([]);
  });
});

describe('PR #16 review: a negated weekday is left out, never made the only day', () => {
  it('"next week, not Friday" → six days, Friday 6 Nov not among them (fallback)', async () => {
    const conv = conversationDb();
    const { fetch } = capturingProvider([text('Sure, here it is.')]);
    const res = await handleAiCoach(deps(conv.db, fetch).d, U, send('Make a meal plan for next week, not Friday'));
    const action = (res.body.reply as StoredMessage).action as MealPlanAction;
    expect(action.days.map((d) => d.date)).toEqual(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-07', '2026-11-08']);
  });

  it('tool path: the model asks for Friday anyway → Friday is dropped', async () => {
    const conv = conversationDb();
    const { fetch } = capturingProvider([toolUse('propose_meal_plan', { week: 'next', days: ['thursday', 'friday'] }), text('Done.')]);
    const res = await handleAiCoach(deps(conv.db, fetch).d, U, send('Meal plan for Thursday next week, ekki föstudag'));
    const action = (res.body.reply as StoredMessage).action as MealPlanAction;
    expect(action.days.map((d) => d.date)).toEqual(['2026-11-05']);
  });

  it('every remaining day ruled out → an honest reason, no plan', () => {
    const acc = account();
    const ctx = { facts: facts(), account: acc, today: TODAY, nutrition: nutritionStatus(acc, true), messageId: mid(5), recipes: REF_RECIPES, ingredients: REF_INGREDIENTS, requestText: 'just Friday, not Friday' };
    const built = buildMealPlanAction({ week: 'next', days: ['friday'] }, ctx);
    expect(built.action).toBeNull();
    expect(built.errors[0]).toMatch(/asked to leave out/);
  });
});

describe('PR #16 review: a delivered follow-up closes the original request', () => {
  it('request → blocked → "Já, prófaðu núna" → plan → "Takk": exactly one meal plan, no second fallback', async () => {
    const conv = conversationDb();
    // 1. request; the model replies with a missing-data style message (blocked) — no plan
    const p1 = capturingProvider([text('I can’t see your nutrition yet. You can share it under training assistant settings.')]);
    // Avoid the fallback on turn 1 by asking for something the fallback doesn't build: the model blocks it itself.
    conv.settings.scopes = { ...ALL, nutrition: false };
    await handleAiCoach(deps(conv.db, p1.fetch).d, U, send('Make me a meal plan for next week, no fish', 1));
    expect(conv.actions).toEqual([null]);
    // 2. the user shares nutrition and says "já, prófaðu núna" → the server resumes the original request
    conv.settings.scopes = ALL;
    const p2 = capturingProvider([text('Já, hér er það.')]);
    const r2 = await handleAiCoach(deps(conv.db, p2.fetch).d, U, send('Já, prófaðu núna', 2));
    const plan = (r2.body.reply as StoredMessage).action as MealPlanAction;
    expect(plan.kind).toBe('meal_plan');
    expect(plan.weekStart).toBe('2026-11-02');
    expect(nutsOrFish(plan).filter((x) => x !== 'tree_nuts')).toEqual([]);
    // 3. "Takk" → no open request any more, no plan, no fallback
    const p3 = capturingProvider([text('Gott að heyra!')]);
    const { d, logs } = deps(conv.db, p3.fetch);
    const r3 = await handleAiCoach(d, U, send('Takk', 3));
    expect((r3.body.reply as StoredMessage).action ?? null).toBeNull();
    expect(conv.actions.filter(Boolean)).toHaveLength(1);
    expect(logs.some((l) => l.event === 'ai_reply_replaced')).toBe(false);
    expect(p3.requests[0].system).not.toMatch(/Open request:/);
  });

  it('findOpenRequest looks at every later reply, not only the first', () => {
    const h: StoredMessage[] = [
      { id: 'u1', role: 'user', content: 'make a meal plan for next week', createdAt: 't1' },
      { id: 'a1', role: 'assistant', content: 'I can’t see your nutrition yet.', createdAt: 't2' },
      { id: 'u2', role: 'user', content: 'já, prófaðu núna', createdAt: 't3' },
      { id: 'a2', role: 'assistant', content: 'Here.', createdAt: 't4', action: { kind: 'meal_plan' } as never },
    ];
    expect(findOpenRequest(h)).toBeNull();
    expect(findOpenRequest(h.slice(0, 3))).toMatchObject({ intent: 'meal_plan', blocked: true });
    expect(isFollowUp('Takk')).toBe(false);
    expect(isFollowUp('Thanks!')).toBe(false);
  });
});

describe('PR #16 review: find_recipes keeps the user’s restriction when the model drops it', () => {
  it.each([
    ['Breakfast ideas please, no fish', { query: 'breakfast', max_results: 5 }, ['fish', 'shellfish']],
    ['Muesli ideas, án hneta', { query: 'muesli', max_results: 5 }, ['tree_nuts']],
  ])('user: "%s", model query %j → recipe cards without %j', async (userText, toolInput, banned) => {
    // Baseline: the model's query alone returns banned recipes (so the test means something).
    const runAlone = await runTool('find_recipes', toolInput, { db: makeDb().db, facts: facts(), catalog: new Map(), state: { proposal: null, proposalAttempts: 0 }, messageId: mid(2), nutrition: nutritionStatus(account(), true), account: account() });
    expect((JSON.parse(runAlone.content).results as { id: string }[]).some((r) => allergensOf(r.id).some((a) => banned.includes(a)))).toBe(true);
    const conv = conversationDb();
    const { fetch } = capturingProvider([toolUse('find_recipes', toolInput), text('Here are a few.')]);
    const res = await handleAiCoach(deps(conv.db, fetch).d, U, send(userText));
    const cards = ((res.body.reply as StoredMessage).action as unknown as { kind: string; recipes: { id: string }[] });
    expect(cards.kind).toBe('recipe_suggestions');
    expect(cards.recipes.length).toBeGreaterThan(0);
    for (const r of cards.recipes) expect(allergensOf(r.id).filter((a) => banned.includes(a)), r.id).toEqual([]);
  });
});

/* ================================================================== re-review of PR #16 (ChatGPT, 25 Nov) */
describe('PR #16 re-review: trailing words never erase a restriction', () => {
  it.each([
    ['no nuts in my meals', ['tree_nuts'], 'nuts'],
    ['no fish for dinner', ['fish', 'shellfish'], 'fish'],
    ['engar hnetur í máltíðunum', ['tree_nuts'], 'hnetur'],
    ['enginn fiskur í kvöldmatinn', ['fish', 'shellfish'], 'fiskur'],
  ])('parse: %s', (t, allergens, food) => {
    const ex = parseExclusions(t);
    expect(ex.allergens.sort()).toEqual([...allergens].sort());
    // …and the food is never turned into a word to search FOR.
    expect(parseQuery(t).words).not.toContain(food);
    expect(parseQuery(t).words.some((w) => food.startsWith(w))).toBe(false);
  });

  it.each([
    ['Breakfast ideas, no fish for breakfast', { query: 'breakfast', max_results: 5 }, ['fish', 'shellfish']],
    ['Morgunmatur, enginn fiskur í morgunmatinn', { query: 'breakfast', max_results: 5 }, ['fish', 'shellfish']],
    ['Muesli please, no nuts in my meals', { query: 'muesli', max_results: 5 }, ['tree_nuts']],
    ['Múslí, engar hnetur í máltíðunum', { query: 'muesli', max_results: 5 }, ['tree_nuts']],
  ])('recipe cards for "%s" (model query %j) contain none of %j', async (userText, toolInput, banned) => {
    const conv = conversationDb();
    const { fetch } = capturingProvider([toolUse('find_recipes', toolInput), text('Here are a few.')]);
    const res = await handleAiCoach(deps(conv.db, fetch).d, U, send(userText));
    const cards = (res.body.reply as StoredMessage).action as unknown as { kind: string; recipes: { id: string }[] };
    expect(cards.kind).toBe('recipe_suggestions');
    expect(cards.recipes.length).toBeGreaterThan(0);
    for (const r of cards.recipes) expect(allergensOf(r.id).filter((a) => banned.includes(a)), r.id).toEqual([]);
  });
});

describe('PR #16 re-review: food names never become weekdays', () => {
  it.each(['no fries', 'no satay', 'no monkfish', 'no sunflower seeds', 'no sundae', 'ekki laugardagsnammi', 'engin sunnudagssteik'])('%s rules out no day', (t) => {
    expect(parseExclusions(t).days).toEqual([]);
  });
  it.each([
    ['not Fri', ['friday']], ['not on Sundays', ['sunday']], ['ekki á mánudögum', ['monday']], ['ekki á föstudaginn', ['friday']], ['nema um helgar', ['saturday', 'sunday']],
  ])('real days still match: %s', (t, days) => {
    expect(parseExclusions(t).days).toEqual(days);
  });
  it('"next week, no fries" plans all seven days', async () => {
    const conv = conversationDb();
    const { fetch } = capturingProvider([text('Sure.')]);
    const res = await handleAiCoach(deps(conv.db, fetch).d, U, send('Make a meal plan for next week, no fries'));
    const action = (res.body.reply as StoredMessage).action as MealPlanAction;
    expect(action.days.map((d) => d.date)).toEqual(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']);
  });
});

describe('PR #16 re-review: a negated diet is never made mandatory', () => {
  it.each([
    ["I'm not vegan; suggest chicken dinners", { query: 'chicken dinners', max_results: 5 }],
    ['Ég er ekki vegan, stingdu upp á kjúklingakvöldmat', { query: 'chicken dinner', max_results: 5 }],
  ])('"%s" → chicken recipes, no vegan constraint', async (userText, toolInput) => {
    const conv = conversationDb();
    const { fetch } = capturingProvider([toolUse('find_recipes', toolInput), text('Try these.')]);
    const res = await handleAiCoach(deps(conv.db, fetch).d, U, send(userText));
    const cards = (res.body.reply as StoredMessage).action as unknown as { kind: string; recipes: { id: string }[] };
    expect(cards.kind).toBe('recipe_suggestions');
    expect(cards.recipes.length).toBeGreaterThan(0);
    expect(cards.recipes.some((r) => RECIPES.find((x) => x.id === r.id)!.ingredients.some((i) => i.ingredientId.includes('chicken')))).toBe(true);
  });
  it('parsing: negated diet names are statements; "no dairy" / "no gluten" are still requests', () => {
    expect(parseQuery("I'm not vegan; suggest chicken dinners").diet).toEqual([]);
    expect(parseQuery('ekki vegan').diet).toEqual([]);
    expect(parseQuery('Ég er ekki grænmetisæta').diet).toEqual([]);
    expect(parseExclusions("I'm not gluten-free, just no nuts").allergens).toEqual(['tree_nuts']);
    expect(parseQuery('vegan dinner').diet).toEqual(['vegan']);
    expect(parseQuery('no dairy please').diet).toEqual(['dairy_free']);
    expect(parseExclusions('no gluten').allergens).toEqual(['gluten']);
    expect(mealPlanIntentFromText("Meal plan for next week, I'm not vegan").diet).toBeUndefined();
  });
});

describe('PR #16 re-review: a reason clause never breaks a weekday negation', () => {
  it.each([
    ['Make a meal plan for next week, not Friday because I eat out'],
    ['Matarplan fyrir næstu viku, ekki föstudag því ég fer út að borða'],
  ])('"%s" → six days, Friday 6 Nov left out', async (msg) => {
    expect(parseExclusions(msg).days).toEqual(['friday']);
    const conv = conversationDb();
    const { fetch } = capturingProvider([text('Here it is.')]);
    const res = await handleAiCoach(deps(conv.db, fetch).d, U, send(msg));
    const action = (res.body.reply as StoredMessage).action as MealPlanAction;
    expect(action.days.map((d) => d.date)).toEqual(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-07', '2026-11-08']);
  });
});

/* ================================================================== exclusion parser corpus (all review rounds) */
/**
 * One table for every phrasing raised in the three ChatGPT reviews of PR #16 plus the probes that passed, in English and
 * Icelandic. For each phrase:
 *  - allergens / foods / diet: exactly what is ruled out and which diet tags are ASKED for (negated diets never count);
 *  - search: words the recipe search must still look for; ruled-out tokens must never be search words;
 *  - days: the weekdays a meal plan for next week actually gets (dates checked; default all seven);
 *  - and, whenever something is ruled out, the real recipes chosen (find_recipes cards and the planned meals) contain none of it.
 */
type Al = 'fish' | 'shellfish' | 'tree_nuts' | 'peanuts' | 'egg' | 'soy' | 'milk' | 'gluten';
interface Case {
  phrase: string;
  allergens?: Al[];
  foods?: string[];
  diet?: string[];
  search?: string[];
  days?: string[];
  /** An ingredient the user WANTS: never ruled out, and a search for it (with the phrase as the user's words) finds recipes with it. */
  wanted?: string;
}
const FISH: Al[] = ['fish', 'shellfish'];
const WEEK = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const NOT_FRI = WEEK.filter((d) => d !== 'friday');
const WEEKDAYS_ONLY = WEEK.slice(0, 5);
const CORPUS: Case[] = [
  // review 1
  { phrase: 'no fish, no nuts', allergens: [...FISH, 'tree_nuts'] },
  { phrase: 'án fisks, án hneta', allergens: [...FISH, 'tree_nuts'] },
  { phrase: 'no tree nuts', allergens: ['tree_nuts'] },
  { phrase: 'engar trjáhnetur', allergens: ['tree_nuts'] },
  { phrase: 'without any nuts', allergens: ['tree_nuts'] },
  { phrase: 'án nokkurra hneta', allergens: ['tree_nuts'] },
  { phrase: 'not Friday', days: NOT_FRI },
  { phrase: 'ekki föstudag', days: NOT_FRI },
  { phrase: 'no fish, two meals a day', allergens: FISH },
  { phrase: 'enginn fiskur, tvær máltíðir á dag', allergens: FISH },
  // review 2
  { phrase: 'no nuts in my meals', allergens: ['tree_nuts'] },
  { phrase: 'engar hnetur í máltíðunum', allergens: ['tree_nuts'] },
  { phrase: 'no fish for dinner', allergens: FISH },
  { phrase: 'enginn fiskur í kvöldmatinn', allergens: FISH },
  { phrase: 'no fries', foods: ['fries'] },
  { phrase: 'no satay', foods: ['satay'] },
  { phrase: 'no monkfish', foods: ['monkfish'] },
  { phrase: 'ekki laugardagsnammi', foods: ['laugardagsnammi'] },
  { phrase: 'engin sunnudagssteik', foods: ['sunnudagssteik'] },
  { phrase: "I'm not vegan; suggest chicken dinners", search: ['chicken'] },
  { phrase: 'Ég er ekki vegan, stingdu upp á kjúklingakvöldmat' },
  { phrase: 'not Friday because I eat out', days: NOT_FRI },
  { phrase: 'ekki föstudag því ég fer út að borða', days: NOT_FRI },
  // review 3
  { phrase: 'no nuts at all or eggs', allergens: ['tree_nuts', 'egg'] },
  { phrase: 'alls engar hnetur eða egg', allergens: ['tree_nuts', 'egg'] },
  { phrase: 'no nuts at all, eggs or soy', allergens: ['tree_nuts', 'egg', 'soy'] },
  { phrase: 'alls engar hnetur, egg eða soja', allergens: ['tree_nuts', 'egg', 'soy'] },
  { phrase: 'no sunday roast', foods: ['sunday roast'] },
  { phrase: 'enga sunnudagssteik', foods: ['sunnudagssteik'] },
  { phrase: 'nothing on weekends', days: WEEKDAYS_ONLY },
  { phrase: 'ekkert um helgar', days: WEEKDAYS_ONLY },
  // probes that passed in review 3
  { phrase: 'not vegan but no meat', foods: ['meat'] },
  { phrase: 'ekki vegan en ekkert kjöt', foods: ['meat'] },
  { phrase: 'no peanut butter for breakfast', allergens: ['peanuts'] },
  { phrase: 'ekkert hnetusmjör í morgunmat', allergens: ['peanuts'] },
  { phrase: 'not Friday and no fish', allergens: FISH, days: NOT_FRI },
  { phrase: 'ekki föstudag og engan fisk', allergens: FISH, days: NOT_FRI },
  { phrase: 'not gluten-free but no dairy', allergens: ['milk'], diet: ['dairy_free'] },
  { phrase: 'ekki glútenlaus en engar mjólkurvörur', allergens: ['milk'] },
  // days asked FOR, and things that rule out nothing
  { phrase: 'Meal plan for Monday and Friday, no fish', allergens: FISH, days: ['monday', 'friday'], search: [] },
  { phrase: 'matarplan fyrir þriðjudag og helgina, án hneta', allergens: ['tree_nuts'], days: ['tuesday', 'saturday', 'sunday'] },
  { phrase: 'vegan dinner, no soy', allergens: ['soy'], diet: ['vegan'] },
  { phrase: 'vegan kvöldmatur án soja', allergens: ['soy'], diet: ['vegan'] },
  { phrase: 'no more than 20 minutes' },
  { phrase: 'ekki meira en 20 mínútur' },
  { phrase: 'an apple and a banana', search: ['apple', 'banana'] },
  { phrase: 'not too spicy' },
  // review 4: a positive "with"/"með" ends the negation; "nothing with nuts" still rules nuts out
  { phrase: 'Breakfast without nuts and with eggs', allergens: ['tree_nuts'], search: ['egg'], wanted: 'egg' },
  { phrase: 'Find dinner without dairy, with chicken', allergens: ['milk'], search: ['chicken'], wanted: 'chicken' },
  { phrase: 'án hneta, með eggjum', allergens: ['tree_nuts'], search: ['eggjum'], wanted: 'egg' },
  { phrase: 'Morgunmatur án hneta og með eggjum', allergens: ['tree_nuts'], wanted: 'egg' },
  { phrase: 'Kvöldmatur án mjólkurvara, með kjúklingi', allergens: ['milk'], wanted: 'chicken' },
  { phrase: 'nothing with nuts', allergens: ['tree_nuts'] },
  { phrase: 'ekkert með hnetum', allergens: ['tree_nuts'] },
  { phrase: 'no fish, with rice', allergens: FISH, search: ['rice'], wanted: 'rice' },
  // review 4: day words with possessives and suffixes keep the schedule; foods stay foods
  { phrase: 'Make a weekend-only meal plan', days: ['saturday', 'sunday'] },
  { phrase: "Friday's dinners", days: ['friday'] },
  { phrase: 'Friday’s dinners', days: ['friday'] },
  { phrase: 'Saturday-ish is fine', days: ['saturday'] },
  { phrase: 'bara um helgar', days: ['saturday', 'sunday'] },
  { phrase: 'helgarplán', days: ['saturday', 'sunday'] },
  { phrase: 'bara föstudag', days: ['friday'] },
  { phrase: 'a satay-only lunch' },
  { phrase: 'fries’s fine' },
  { phrase: 'sunnudagssteik-only' },
  // review 5: clarifiers extend a negation; "nothing with X or with/containing Y" keeps Y excluded
  { phrase: 'No nuts, including peanuts', allergens: ['tree_nuts', 'peanuts'] },
  { phrase: 'no nuts including peanuts', allergens: ['tree_nuts', 'peanuts'] },
  { phrase: 'no nuts (incl. peanuts)', allergens: ['tree_nuts', 'peanuts'] },
  { phrase: 'Nothing with peanuts or containing milk', allergens: ['peanuts', 'milk'] },
  { phrase: 'nothing with nuts or with eggs', allergens: ['tree_nuts', 'egg'] },
  { phrase: 'no nuts or anything containing milk', allergens: ['tree_nuts', 'milk'] },
  { phrase: 'no nuts, such as almonds', allergens: ['tree_nuts'] },
  { phrase: 'no nuts like almonds or cashews', allergens: ['tree_nuts'] },
  { phrase: 'no nuts, especially peanuts', allergens: ['tree_nuts', 'peanuts'] },
  { phrase: 'no nuts, even peanuts', allergens: ['tree_nuts', 'peanuts'] },
  { phrase: 'no nuts, e.g. almonds', allergens: ['tree_nuts'] },
  { phrase: 'án hneta, þar með talið jarðhnetur', allergens: ['tree_nuts', 'peanuts'] },
  { phrase: 'engar hnetur, eins og möndlur', allergens: ['tree_nuts'] },
  { phrase: 'ekkert sem inniheldur mjólk', allergens: ['milk'] },
  { phrase: 'ekkert með hnetum eða sem inniheldur mjólk', allergens: ['tree_nuts', 'milk'] },
  { phrase: 'ekkert með hnetum eða með eggjum', allergens: ['tree_nuts', 'egg'] },
  { phrase: 'engar hnetur, jafnvel ekki jarðhnetur', allergens: ['tree_nuts', 'peanuts'] },
  { phrase: 'engar hnetur, sérstaklega ekki jarðhnetur', allergens: ['tree_nuts', 'peanuts'] },
  { phrase: 'án hneta, t.d. möndlur', allergens: ['tree_nuts'] },
];

/** Review 6 self-review: affirmative clauses, clarifiers, positive with/með, diets and weekdays (EN + IS), checked by hand. */
const SELF_REVIEW: Case[] = [
  { phrase: 'No nuts, I like eggs for breakfast', allergens: ['tree_nuts'], search: ['egg'], wanted: 'egg' },
  { phrase: 'No fish, I like chicken', allergens: FISH, search: ['chicken'], wanted: 'chicken' },
  { phrase: "no nuts, I'd like eggs please", allergens: ['tree_nuts'], wanted: 'egg' },
  { phrase: 'no dairy, we love salmon', allergens: ['milk'], diet: ['dairy_free'], wanted: 'salmon' },
  { phrase: 'nothing spicy, I want rice', wanted: 'rice' },
  { phrase: "no peanuts and I'm fine with eggs", allergens: ['peanuts'], wanted: 'egg' },
  { phrase: 'no nuts like almonds, but I love peanut butter', allergens: ['tree_nuts'], wanted: 'peanut' },
  { phrase: 'no shellfish such as prawns; tuna is fine', allergens: ['shellfish'], wanted: 'tuna' },
  { phrase: 'without gluten, I prefer rice', allergens: ['gluten'], wanted: 'rice' },
  { phrase: 'no eggs, I eat fish', allergens: ['egg'], search: ['fish'], wanted: 'salmon' },
  { phrase: 'no pork, we like beef', foods: ['pork'], wanted: 'beef' },
  { phrase: 'skip mushrooms, I love onions', foods: ['mushrooms'], wanted: 'onion' },
  { phrase: 'no nuts, especially cashews, I want chicken', allergens: ['tree_nuts'], wanted: 'chicken' },
  { phrase: 'no fish, with chicken please', allergens: FISH, wanted: 'chicken' },
  { phrase: "nothing with nuts, I'd like porridge", allergens: ['tree_nuts'], search: ['porridge'] },
  { phrase: 'no eggs including egg whites, I like turkey', allergens: ['egg'], wanted: 'turkey' },
  { phrase: 'not Friday, I eat out then', days: NOT_FRI },
  { phrase: 'no meat but I eat fish', foods: ['meat'], search: ['fish'] },
  { phrase: "I'm vegetarian, no eggs", diet: ['vegetarian'], allergens: ['egg'] },
  { phrase: "I'm not vegetarian, no pork though", foods: ['pork'] },
  { phrase: 'vegan, nothing with soy or containing gluten', diet: ['vegan'], allergens: ['soy', 'gluten'] },
  { phrase: 'dairy-free and no nuts, I love bananas', diet: ['dairy_free'], allergens: ['milk', 'tree_nuts'], wanted: 'banana' },
  { phrase: 'Meal plan for weekdays only, no nuts', allergens: ['tree_nuts'], days: WEEKDAYS_ONLY },
  { phrase: 'only Monday and Wednesday, no fish please', allergens: FISH, days: ['monday', 'wednesday'] },
  { phrase: "Tuesday's and Thursday's meals, without nuts", allergens: ['tree_nuts'], days: ['tuesday', 'thursday'] },
  { phrase: 'no satay, I like chicken', foods: ['satay'], wanted: 'chicken' },
  { phrase: 'no fries or chips, I want salmon', foods: ['fries', 'chips'], wanted: 'salmon' },
  { phrase: 'nothing containing gluten, such as bread, I like rice', allergens: ['gluten'], foods: ['bread'], wanted: 'rice' },
  { phrase: 'no nuts. I like eggs.', allergens: ['tree_nuts'], wanted: 'egg' },
  { phrase: "no fish and I'd love some chicken", allergens: FISH, wanted: 'chicken' },
  { phrase: "without milk, we'd like oats", allergens: ['milk'], wanted: 'oats' },
  { phrase: 'no nuts, even peanuts, but eggs are great', allergens: ['tree_nuts', 'peanuts'], wanted: 'egg' },
  { phrase: 'no eggs like I said', allergens: ['egg'] },
  { phrase: 'no nuts or seeds, I love eggs', allergens: ['tree_nuts'], foods: ['seeds'], wanted: 'egg' },
  { phrase: "nothing with fish, or prawns, I'm fine with chicken", allergens: FISH, wanted: 'chicken' },
  { phrase: 'no beef including mince; we like chicken', foods: ['beef', 'mince'], wanted: 'chicken' },
  { phrase: 'no tuna, salmon is fine', foods: ['tuna'], wanted: 'salmon' },
  { phrase: 'no eggs and no milk, I want chicken', allergens: ['egg', 'milk'], wanted: 'chicken' },
  { phrase: 'I like chicken, but no nuts', allergens: ['tree_nuts'], wanted: 'chicken' },
  { phrase: "I don't like fish but I love chicken", allergens: FISH, wanted: 'chicken' },
  { phrase: "I can't have gluten, I want rice", allergens: ['gluten'], wanted: 'rice' },
  { phrase: 'nothing with dairy; with chicken please', allergens: ['milk'], wanted: 'chicken' },
  { phrase: 'Make it pescatarian, no shellfish', diet: ['pescatarian'], allergens: ['shellfish'] },
  { phrase: 'no lactose, I like rice', allergens: ['milk'], wanted: 'rice' },
  { phrase: "no mushrooms, we're happy with beef", foods: ['mushrooms'], wanted: 'beef' },
  { phrase: "don't add nuts, I'd like yogurt", allergens: ['tree_nuts'], wanted: 'yogurt' },
  { phrase: 'Engar hnetur, ég vil egg í morgunmat', allergens: ['tree_nuts'], wanted: 'egg' },
  { phrase: 'Enginn fiskur, mér finnst kjúklingur góður', allergens: FISH, wanted: 'chicken' },
  { phrase: 'án hneta, ég elska egg', allergens: ['tree_nuts'], wanted: 'egg' },
  { phrase: 'Engin mjólk, við viljum lax', allergens: ['milk'], wanted: 'salmon' },
  { phrase: 'ekkert sterkt, ég vil hrísgrjón', wanted: 'rice' },
  { phrase: 'engar jarðhnetur en egg eru fín', allergens: ['peanuts'], wanted: 'egg' },
  { phrase: 'engar hnetur eins og möndlur, en ég elska hnetusmjör', allergens: ['tree_nuts'], wanted: 'peanut' },
  { phrase: 'enginn skelfiskur eins og rækjur, túnfiskur er í lagi', allergens: ['shellfish'], wanted: 'tuna' },
  { phrase: 'ekki föstudag, ég borða úti þá', days: NOT_FRI },
  { phrase: 'bara virka daga, engar hnetur', allergens: ['tree_nuts'], days: WEEKDAYS_ONLY },
  { phrase: 'mánudag og miðvikudag, án fisks', allergens: FISH, days: ['monday', 'wednesday'] },
  { phrase: 'ekkert svínakjöt, við borðum nautakjöt', foods: ['pork'], wanted: 'beef' },
  { phrase: 'engir sveppir, ég elska lauk', foods: ['mushroom'], wanted: 'onion' },
  { phrase: 'ekkert með hnetum, ég vil hafragraut', allergens: ['tree_nuts'], wanted: 'oats' },
  { phrase: 'án eggja, þar með talið eggjahvítur, ég vil kalkún', allergens: ['egg'], wanted: 'turkey' },
  { phrase: 'ekkert glúten, ég vil hrísgrjón', allergens: ['gluten'], wanted: 'rice' },
  { phrase: 'Ég er grænmetisæta, engin egg', diet: ['vegetarian'], allergens: ['egg'] },
  { phrase: 'ég er ekki grænmetisæta en ekkert svínakjöt', foods: ['pork'] },
  { phrase: 'vegan, ekkert með soja eða sem inniheldur glúten', diet: ['vegan'], allergens: ['soy', 'gluten'] },
  { phrase: 'mjólkurlaust og engar hnetur, ég elska banana', diet: ['dairy_free'], allergens: ['milk', 'tree_nuts'], wanted: 'banana' },
  { phrase: 'þriðjudag og fimmtudag, án hneta', allergens: ['tree_nuts'], days: ['tuesday', 'thursday'] },
  { phrase: 'enginn fiskur og ég myndi vilja kjúkling', allergens: FISH, wanted: 'chicken' },
  { phrase: 'án mjólkur, við viljum hafra', allergens: ['milk'], wanted: 'oats' },
  { phrase: 'engar hnetur, jafnvel ekki jarðhnetur, en egg eru frábær', allergens: ['tree_nuts', 'peanuts'], wanted: 'egg' },
  { phrase: 'engin egg eins og ég sagði', allergens: ['egg'] },
  { phrase: 'ekki laugardag, við förum út', days: WEEK.filter((d) => d !== 'saturday') },
  { phrase: 'ég vil kjúkling en engar hnetur', allergens: ['tree_nuts'], wanted: 'chicken' },
  { phrase: 'ég borða ekki fisk en elska kjúkling', allergens: FISH, wanted: 'chicken' },
  { phrase: 'ekkert með fiski, eða rækjum, mér finnst kjúklingur fínn', allergens: FISH, wanted: 'chicken' },
  { phrase: 'ekkert nautakjöt þar með talið hakk, við viljum kjúkling', foods: ['beef', 'mince'], wanted: 'chicken' },
  { phrase: 'enginn túnfiskur, lax er í lagi', foods: ['tuna'], wanted: 'salmon' },
  { phrase: 'engin egg og engin mjólk, ég vil kjúkling', allergens: ['egg', 'milk'], wanted: 'chicken' },
  { phrase: 'ég get ekki borðað glúten, ég vil hrísgrjón', allergens: ['gluten'], wanted: 'rice' },
  { phrase: 'Hafðu það pescatarian, enginn skelfiskur', diet: ['pescatarian'], allergens: ['shellfish'] },
  { phrase: 'ekki setja hnetur, ég vil jógúrt', allergens: ['tree_nuts'], wanted: 'yogurt' },
];
CORPUS.push(...SELF_REVIEW);
const NEXT_WEEK: Record<string, string> = { monday: '2026-11-02', tuesday: '2026-11-03', wednesday: '2026-11-04', thursday: '2026-11-05', friday: '2026-11-06', saturday: '2026-11-07', sunday: '2026-11-08' };
const usedIngredients = (recipeId: string) => RECIPES.find((r) => r.id === recipeId)!.ingredients.filter((i) => !i.optional).map((i) => i.ingredientId);

describe('exclusion parser corpus (EN + IS, every review phrasing)', () => {
  it.each(CORPUS.map((c) => [c.phrase, c] as const))('%s', async (_phrase, c) => {
    const ex = parseExclusions(c.phrase);
    expect(ex.allergens.sort(), 'allergens').toEqual([...(c.allergens ?? [])].sort());
    expect(ex.words.sort(), 'foods').toEqual([...(c.foods ?? [])].sort());
    expect(dietTagsIn(c.phrase).sort(), 'diet').toEqual([...(c.diet ?? [])].sort());
    // Search terms: what must be looked for is there; nothing ruled out is ever looked FOR.
    const words = parseQuery(c.phrase).words;
    for (const w of c.search ?? []) expect(words, `search ${w}`).toContain(w);
    for (const r of ex.raw) expect(words, `ruled-out "${r}" searched for`).not.toContain(stemWord(r));

    // Plan dates for "meal plan for next week" + the phrase (fallback intent + the user's words, as in the handler).
    const msg = `Meal plan for next week. ${c.phrase}`;
    const acc = account();
    const built = buildMealPlanAction(mealPlanIntentFromText(msg), {
      facts: facts(), account: acc, today: TODAY, nutrition: nutritionStatus(acc, true), messageId: mid(9), recipes: REF_RECIPES, ingredients: REF_INGREDIENTS, requestText: msg,
    });
    expect(built.errors, 'plan errors').toEqual([]);
    expect(built.action!.days.map((d) => d.date), 'plan dates').toEqual((c.days ?? WEEK).map((d) => NEXT_WEEK[d]));

    // Real recipes: nothing ruled out appears in the plan or in find_recipes cards.
    const bannedAl = new Set<string>(c.allergens ?? []);
    const bannedIng = new Set(excludedIngredientIds(c.foods ?? [], REF_INGREDIENTS));
    if (bannedAl.size || bannedIng.size) {
      for (const day of built.action!.days)
        for (const it of day.items) {
          expect(allergensOf(it.recipeId).filter((a) => bannedAl.has(a)), `${day.date} ${it.recipeId}`).toEqual([]);
          expect(usedIngredients(it.recipeId).filter((i) => bannedIng.has(i)), `${day.date} ${it.recipeId}`).toEqual([]);
          for (const e of it.extras ?? []) {
            expect((ING.get(e.ingredientId)?.allergens ?? []).filter((a) => bannedAl.has(a)), e.ingredientId).toEqual([]);
            expect(bannedIng.has(e.ingredientId), e.ingredientId).toBe(false);
          }
        }
      const out = await runTool('find_recipes', { query: '', max_results: 5 }, {
        db: makeDb().db, facts: facts(), catalog: new Map(), state: { proposal: null, proposalAttempts: 0 }, messageId: mid(2), nutrition: nutritionStatus(acc, true), account: acc, requestText: c.phrase,
      });
      const results = JSON.parse(out.content).results as { id: string }[];
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(allergensOf(r.id).filter((a) => bannedAl.has(a)), r.id).toEqual([]);
        expect(usedIngredients(r.id).filter((i) => bannedIng.has(i)), r.id).toEqual([]);
      }
    }

    // A wanted ingredient is never ruled out, and searching for it (as the model would) finds recipes that use it.
    if (c.wanted) {
      // The main ingredient of that name (egg → egg, oats → oats-dry, yogurt → greek-yogurt-0); related ones such as
      // egg noodles may legitimately be ruled out by another restriction (gluten).
      const primary = INGREDIENTS.find((i) => i.id === c.wanted) ?? INGREDIENTS.find((i) => i.id.startsWith(c.wanted!)) ?? INGREDIENTS.find((i) => i.id.includes(c.wanted!));
      expect(primary, 'fixture').toBeDefined();
      expect((primary!.allergens ?? []).filter((a) => ex.allergens.includes(a as never)), `${primary!.id} ruled out by allergen`).toEqual([]);
      expect(excludedIngredientIds(ex.words, REF_INGREDIENTS), `${primary!.id} ruled out by food`).not.toContain(primary!.id);
      const out = await runTool('find_recipes', { query: c.wanted, max_results: 5 }, {
        db: makeDb().db, facts: facts(), catalog: new Map(), state: { proposal: null, proposalAttempts: 0 }, messageId: mid(3), nutrition: nutritionStatus(acc, true), account: acc, requestText: c.phrase,
      });
      const found = JSON.parse(out.content).results as { id: string }[];
      expect(found.some((r) => usedIngredients(r.id).some((i) => i.includes(c.wanted!))), `recipes with ${c.wanted}`).toBe(true);
    }
  });

  it('wantedDays only counts whole day words no negation used', () => {
    expect(wantedDays('Meal plan for Monday and Friday')).toEqual(['monday', 'friday']);
    expect(wantedDays('no sunday roast')).toEqual([]);
    expect(wantedDays('engin sunnudagssteik, ekki laugardagsnammi')).toEqual([]);
    expect(wantedDays('not Friday, but Saturday is fine')).toEqual(['saturday']);
    expect(wantedDays("Friday's and Sunday’s dinners")).toEqual(['friday', 'sunday']);
    expect(wantedDays('weekend-only')).toEqual(['saturday', 'sunday']);
    expect(wantedDays('fries-only, satay’s, sunnudagssteik-only, frisbee')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ safety net: every corpus exclusion, end to end */
/**
 * For EVERY corpus row that rules something out, the handler runs against the real catalog plus one "testbad" recipe per
 * excluded allergen/food (built from an ingredient carrying it). Two paths: the model searches find_recipes for exactly
 * those recipes, and the meal-plan fallback builds next week. No testbad recipe — and nothing ruled out — may ever be
 * returned. A restriction the parser drops in the future fails here, loudly, for that phrase.
 */
const ALLERGEN_INGREDIENT = (a: string) => INGREDIENTS.find((i) => (i.allergens ?? []).includes(a as never))!;
function fixtureFor(c: Case) {
  const extraIngredients: RefIngredient[] = [];
  const bad: { ingredientId: string; label: string }[] = [];
  for (const a of c.allergens ?? []) bad.push({ ingredientId: ALLERGEN_INGREDIENT(a).id, label: a });
  for (const f of c.foods ?? []) {
    const ids = excludedIngredientIds([f], REF_INGREDIENTS);
    if (ids.length) bad.push({ ingredientId: ids[0], label: f });
    else {
      const id = `testbad-ing-${f.replace(/[^a-z0-9]+/gi, '-')}`;
      extraIngredients.push({ ...(INGREDIENTS.find((i) => i.id === 'chicken-breast-raw') ?? INGREDIENTS[0]), id, name: f, allergens: [] } as unknown as RefIngredient);
      bad.push({ ingredientId: id, label: f });
    }
  }
  const template = RECIPES[0];
  const extraRecipes = bad.flatMap((b, n) =>
    (['breakfast', 'lunch', 'dinner', 'snack'] as const).map((meal) => ({
      ...template, id: `testbad-${n}-${meal}`, name: `Testbad${n} ${b.label} ${meal}`, meal, prepMinutes: 5, cookMinutes: 5, substitutions: [],
      ingredients: [{ ingredientId: b.ingredientId, grams: 250, display: '250 g' }],
    })),
  ) as unknown as RefRecipe[];
  return { recipes: [...REF_RECIPES, ...extraRecipes], ingredients: [...REF_INGREDIENTS, ...extraIngredients], bad: new Set(bad.map((b) => b.ingredientId)), badList: bad };
}

describe('safety net: no corpus exclusion is ever returned by the handler', () => {
  const rows = CORPUS.filter((c) => (c.allergens?.length ?? 0) + (c.foods?.length ?? 0) > 0);
  it.each(rows.map((c) => [c.phrase, c] as const))('%s', async (_p, c) => {
    const fx = fixtureFor(c);
    const banned = new Set<string>(c.allergens ?? []);
    const isBad = (recipeId: string) => {
      const r = fx.recipes.find((x) => x.id === recipeId)!;
      const ids = (r.ingredients ?? []).filter((i) => !i.optional).map((i) => i.ingredientId);
      return recipeId.startsWith('testbad') || ids.some((id) => fx.bad.has(id)) || ids.some((id) => (ING.get(id)?.allergens ?? []).some((a) => banned.has(a)));
    };
    const conv = conversationDb();
    conv.db.getRecipes = async () => fx.recipes;
    conv.db.getIngredients = async () => fx.ingredients;

    // Per excluded allergen/food n: the fixture works (without the user's words, a search for "testbad<n>" returns
    // exactly that ingredient's recipes), and with them the model searching FOR those recipes never gets one back.
    const acc = account();
    for (const [n, b] of fx.badList.entries()) {
      const query = `testbad${n}`;
      const baseline = await runTool('find_recipes', { query, max_results: 5 }, {
        db: conv.db, facts: facts(), catalog: new Map(), state: { proposal: null, proposalAttempts: 0 }, messageId: mid(4), nutrition: nutritionStatus(acc, true), account: acc,
      });
      const base = JSON.parse(baseline.content).results as { id: string }[];
      expect(base.some((r) => r.id.startsWith(`testbad-${n}-`)), `fixture baseline for ${b.label} (${b.ingredientId})`).toBe(true);

      const p1 = capturingProvider([toolUse('find_recipes', { query, max_results: 5 }), text('Here you go.')]);
      const r1 = await handleAiCoach(deps(conv.db, p1.fetch).d, U, send(c.phrase, 10 + n));
      // (A phrase that itself asks for a meal plan gets the plan card instead of recipe cards: check whichever came back.)
      const a1 = (r1.body.reply as StoredMessage).action as unknown as { kind: string; recipes?: { id: string }[]; days?: MealPlanAction['days'] } | null;
      const shown = a1?.kind === 'meal_plan' ? a1.days!.flatMap((d) => d.items.map((it) => it.recipeId)) : (a1?.recipes ?? []).map((r) => r.id);
      expect(shown.length, `recipes were shown (${b.label})`).toBeGreaterThan(0);
      for (const id of shown) expect(isBad(id), `${b.label}: returned ${id}`).toBe(false);
    }

    // 2. The meal-plan fallback for next week.
    const p2 = capturingProvider([text('Here is your plan.')]);
    const r2 = await handleAiCoach(deps(conv.db, p2.fetch).d, U, send(`Make a meal plan for next week. ${c.phrase}`, 2));
    const plan = (r2.body.reply as StoredMessage).action as MealPlanAction | null;
    expect(plan?.kind, 'a plan was built').toBe('meal_plan');
    for (const d of plan!.days)
      for (const it of d.items) {
        expect(isBad(it.recipeId), `${d.date} ${it.recipeId}`).toBe(false);
        for (const e of it.extras ?? []) expect(fx.bad.has(e.ingredientId) || (ING.get(e.ingredientId)?.allergens ?? []).some((a) => banned.has(a)), `${d.date} side ${e.ingredientId}`).toBe(false);
      }
  });
});
