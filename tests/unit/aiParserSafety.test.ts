/**
 * Parser safety regressions (review of PR #24): restrictions the user states must survive everything else in the
 * message. Each case is run through the parser AND the real handler (handleAiCoach with a MOCKED provider and in-memory
 * db, as in aiIntentIcelandic.test.ts) with the app's REAL recipe and ingredient catalog. For every restriction a real
 * recipe that carries the restricted food is shown to be returned WITHOUT the restriction and left out WITH it — by
 * find_recipes (tool and handler) and by the server-built meal plan (fallback) — checked ingredient by ingredient
 * (optional ingredients, swaps and sides included).
 *
 *  P1-1  a question never cancels an allergy declared in another clause (both orders, both languages, every allergen);
 *  P1-2  an extender keeps a nut exclusion going ("þar á meðal jarðhnetur"), and a peanut mention relaxes the bare-nut
 *        exclusion only in an explicitly affirmative wanted-food clause ("but I love peanut butter");
 *  P2-3  approved vegan phrases ("án dýraafurða") set the vegan diet; negated ones ("ekki vegan") never do;
 *  P2-7  a food negation is not a refusal of the plan ("Ég borða ekki fisk og vil matseðil …"), and a question about the
 *        user's existing plan ("Er matseðillinn minn vegan?") never creates one.
 * Expected allergens below are written by hand from the allergen definitions, not from the parser's word lists.
 */
import { describe, expect, it } from 'vitest';
import { handleAiCoach, type CoachDeps } from '../../supabase/functions/_shared/ai/coach';
import { runTool, type ToolState } from '../../supabase/functions/_shared/ai/tools';
import { asksForMealPlan, dietTagsIn, parseExclusions, parseQuery } from '../../supabase/functions/_shared/ai/meals';
import { classifyIntent, classifyRequest } from '../../supabase/functions/_shared/ai/conversation';
import { nutritionStatus } from '../../supabase/functions/_shared/ai/dataStatus';
import type { AccountStatePayload, AiDb, AiScopes, AiSettingsRow, FetchLike, MealPlanAction, RefIngredient, RefRecipe, StoredMessage, UserFacts } from '../../supabase/functions/_shared/ai/types';
import { RECIPES } from '@/data/recipes';
import { INGREDIENTS } from '@/data/ingredients';

/* ================================================================== catalog */
const ALL_INGREDIENTS = INGREDIENTS as unknown as RefIngredient[];
const ALL_RECIPES = RECIPES as unknown as RefRecipe[];
const ING = new Map(ALL_INGREDIENTS.map((i) => [i.id, i]));
type Al = 'fish' | 'shellfish' | 'tree_nuts' | 'peanuts' | 'egg' | 'soy' | 'milk' | 'gluten' | 'sesame' | 'wheat' | 'mustard' | 'celery';
const withAllergen = (a: Al) => new Set(ALL_INGREDIENTS.filter((i) => (i.allergens ?? []).includes(a as never)).map((i) => i.id));
const notVegan = new Set(ALL_INGREDIENTS.filter((i) => i.diet?.vegan !== true).map((i) => i.id));
const fishIds = withAllergen('fish');
const union = (...s: Set<string>[]) => new Set(s.flatMap((x) => [...x]));

/* ================================================================== harness (as aiIntentIcelandic.test.ts) */
const U = '11111111-1111-4111-8111-111111111111';
const mid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = new Date('2026-11-26T12:00:00Z');
const TODAY = '2026-11-26';
const TZ = 'Atlantic/Reykjavik';
const ALL: AiScopes = { profile: true, training: true, measurements: false, nutrition: true };
function account(diet: Record<string, unknown> = {}): AccountStatePayload {
  return {
    settings: { units: { weight: 'kg' }, timeZone: TZ, weekStart: 1, nutritionEnabled: true },
    profile: { goal: 'build_muscle', diet: { tags: [], allergens: [], dislikedIngredientIds: [], maxCookMinutes: 120, mealsPerDay: 3, budget: 'any', ...diet } as never },
    nutrition: { mode: 'protein_only', proteinG: 180, proteinPerKg: 2 },
  };
}
const facts = (): UserFacts => ({
  units: 'kg', timeZone: TZ, weekStart: 1, equipment: null, excludedExerciseIds: [], limitations: [], allergens: [], dietTags: [], dislikedIngredientIds: [],
  maxCookMinutes: null, activeProgram: null,
});
const text = (t: string) => ({ id: 'm', model: 'claude-test', content: [{ type: 'text', text: t }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } });
const toolUse = (name: string, input: unknown) => ({ id: 'mt', model: 'claude-test', content: [{ type: 'tool_use', id: 'toolu_1', name, input }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 10 } });
function provider(replies: unknown[]) {
  const fetch: FetchLike = async () => {
    const body = replies.shift() ?? text('…');
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { fetch };
}
function conversationDb(recipes: RefRecipe[], acc: AccountStatePayload) {
  const messages: StoredMessage[] = [];
  const settings: AiSettingsRow = { enabled: true, paused: false, consentAt: '2026-10-01T00:00:00Z', scopes: ALL, scopesChangedAt: null, profileNotes: '' };
  let clock = Date.parse('2026-11-26T11:50:00Z');
  const db: AiDb = {
    getSettings: async () => settings,
    getExchange: async () => null,
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
      const at = (ms: number) => new Date(ms).toISOString();
      messages.push({ id: input.message.id, role: 'user', content: input.message.content, createdAt: at((clock += 1000)) });
      const reply: StoredMessage = { id: `r-${input.message.id}`, role: 'assistant', content: input.reply.content, createdAt: at((clock += 1000)), grounding: input.reply.grounding, proposalId: null, action: input.reply.action ?? null };
      messages.push(reply);
      return { reply, proposal: null, duplicate: false };
    },
    getExercises: async () => [],
    getRecipes: async () => recipes,
    getIngredients: async () => ALL_INGREDIENTS,
  };
  return db;
}
const deps = (db: AiDb, fetch: FetchLike): CoachDeps => ({
  db, fetch, env: (k) => (k === 'ANTHROPIC_API_KEY' ? 'sk-test' : undefined), now: () => NOW, sleep: async () => undefined, random: () => 0.5, log: () => undefined,
});
let seq = 500;
type Card = { id: string; omit?: string[]; swaps?: { from: string; to: string }[] };
type Reply = StoredMessage & { action?: { kind: string; recipes?: Card[]; days?: MealPlanAction['days'] } | null };
async function chat(t: string, replies: unknown[], recipes: RefRecipe[] = ALL_RECIPES, acc: AccountStatePayload = account()) {
  const p = provider(replies);
  const res = await handleAiCoach(deps(conversationDb(recipes, acc), p.fetch), U, { action: 'send', id: mid(seq++), text: t, mode: 'chat' });
  return res.body.reply as Reply;
}
/** find_recipes as the model would call it, with the user's words as the request text; returns the shown cards. */
async function findRecipes(input: Record<string, unknown>, requestText: string | undefined, recipes: RefRecipe[]) {
  const acc = account();
  const state: ToolState = { proposal: null, proposalAttempts: 0 };
  const ctx = { db: conversationDb(recipes, acc), facts: facts(), catalog: new Map(), state, messageId: mid(2), nutrition: nutritionStatus(acc, true), account: acc, today: TODAY, ...(requestText ? { requestText } : {}) };
  await runTool('find_recipes', input, ctx);
  return (ctx.state as ToolState & { recipes?: { recipes: Card[] } }).recipes?.recipes ?? [];
}
/** The ingredients a shown card really uses: omitted optional ones removed, swaps applied. */
const cardIngredients = (c: Card, recipes: RefRecipe[]) =>
  (recipes.find((x) => x.id === c.id)!.ingredients ?? []).filter((i) => !(c.omit ?? []).includes(i.ingredientId)).map((i) => c.swaps?.find((s) => s.from === i.ingredientId)?.to ?? i.ingredientId);
/** Every ingredient a planned meal uses: the whole recipe (optional ones too) with its swaps, plus sides. */
function planIngredients(it: MealPlanAction['days'][number]['items'][number], recipes: RefRecipe[]): string[] {
  const rec = recipes.find((x) => x.id === it.recipeId)!;
  return [...(rec.ingredients ?? []).map((i) => it.swaps?.find((s) => s.from === i.ingredientId)?.to ?? i.ingredientId), ...(it.extras ?? []).map((e) => e.ingredientId)];
}
const planOf = (r: Reply) => (r.action?.kind === 'meal_plan' ? r.action.days! : null);

/**
 * A real recipe carrying `banned` in a non-optional ingredient (breakfast first) and nothing else the request rules out
 * (`ruledOut`), so its rejection proves this restriction alone; plus recipes free of everything ruled out.
 */
function dangerous(banned: Set<string>, prefer: string = 'breakfast', ruledOut: Set<string> = banned) {
  const others = new Set([...ruledOut].filter((id) => !banned.has(id)));
  const carries = (x: RefRecipe) => (x.ingredients ?? []).some((i) => !i.optional && banned.has(i.ingredientId)) && !(x.ingredients ?? []).some((i) => others.has(i.ingredientId));
  const clean = (x: RefRecipe) => !(x.ingredients ?? []).some((i) => banned.has(i.ingredientId) || ruledOut.has(i.ingredientId));
  const cands = ALL_RECIPES.filter(carries).sort((a, b) => Number(b.meal === prefer) - Number(a.meal === prefer) || a.id.localeCompare(b.id));
  const r = cands.find((x) => ALL_RECIPES.some((y) => y.meal === x.meal && clean(y)))!;
  expect(r, 'a real recipe carries the restricted food').toBeDefined();
  const safe = ALL_RECIPES.find((y) => y.meal === r.meal && clean(y))!;
  const fillers = (['breakfast', 'lunch', 'dinner', 'snack'] as const).filter((m) => m !== r.meal).map((m) => ALL_RECIPES.find((x) => x.meal === m && clean(x))!);
  return { r, safe, fillers, clean };
}

/**
 * The safety proof for one restriction. `neutral` is the same request without the restriction (it must surface the
 * dangerous recipe); `restricted` states the restriction (it must never surface it). `planPrefix` turns a message into a
 * meal-plan request (empty when the message already asks for one).
 */
async function proveExcluded(label: string, banned: Set<string>, neutral: string, restricted: string, planPrefix: string, prefer?: string, ruledOut?: Set<string>) {
  const { r, safe, fillers } = dangerous(banned, prefer, ruledOut);
  const dirty = (ids: string[]) => ids.filter((id) => banned.has(id));
  const pair = [r, safe];

  // find_recipes (tool): the model searches FOR the dangerous recipe.
  expect((await findRecipes({ query: r.name, max_results: 5 }, neutral, pair)).map((c) => c.id), `${label}: baseline find_recipes returns ${r.id}`).toContain(r.id);
  const cards = await findRecipes({ query: r.name, max_results: 5 }, restricted, pair);
  expect(cards.map((c) => c.id), `${label}: ${r.id} returned despite the restriction`).not.toContain(r.id);
  for (const c of cards) expect(dirty(cardIngredients(c, pair)), `${label}: card ${c.id}`).toEqual([]);

  // The same through the handler (a plan request is answered with a plan: its baseline is the plan check below).
  if (!asksForMealPlan(neutral)) {
    const h0 = await chat(neutral, [toolUse('find_recipes', { query: r.name, max_results: 5 }), text('Hér eru hugmyndir.')], pair);
    expect((h0.action?.recipes ?? []).map((c) => c.id), `${label}: handler baseline returns ${r.id}`).toContain(r.id);
  }
  const h1 = await chat(restricted, [toolUse('find_recipes', { query: r.name, max_results: 5 }), text('Hér eru hugmyndir.')], pair);
  expect(h1.action?.kind === 'meal_plan' ? [] : (h1.action?.recipes ?? []).map((c) => c.id), `${label}: handler returned ${r.id}`).not.toContain(r.id);
  for (const c of h1.action?.recipes ?? []) expect(dirty(cardIngredients(c, pair)), `${label}: handler card ${c.id}`).toEqual([]);
  for (const d of planOf(h1) ?? []) for (const it of d.items) expect(dirty(planIngredients(it, pair)), `${label}: handler plan ${it.recipeId}`).toEqual([]);

  // Meal-plan fallback (the model doesn't call propose_meal_plan; the server builds the plan from the user's words).
  const acc4 = account({ mealsPerDay: 4 });
  const only = [r, ...fillers];
  const p0 = await chat(`${planPrefix}${neutral}`.trim(), [text('Hér er planið.')], only, acc4);
  expect(planOf(p0)?.some((d) => d.items.some((it) => it.recipeId === r.id)), `${label}: baseline plan uses ${r.id}`).toBe(true);
  const p1 = await chat(`${planPrefix}${restricted}`.trim(), [text('Hér er planið.')], only, acc4);
  for (const d of planOf(p1) ?? []) for (const it of d.items) expect(dirty(planIngredients(it, only)), `${label}: restricted plan ${it.recipeId}`).toEqual([]);
  const p2 = await chat(`${planPrefix}${restricted}`.trim(), [text('Hér er planið.')], [r, safe, ...fillers], acc4);
  expect(planOf(p2), `${label}: a plan is still built`).not.toBeNull();
  for (const d of planOf(p2)!) for (const it of d.items) expect(dirty(planIngredients(it, [r, safe, ...fillers])), `${label}: plan ${it.recipeId}`).toEqual([]);
  // Full catalog: still safe.
  const full = await chat(`${planPrefix}${restricted}`.trim(), [text('Hér er planið.')]);
  expect(planOf(full), `${label}: full-catalog plan`).not.toBeNull();
  for (const d of planOf(full)!) for (const it of d.items) expect(dirty(planIngredients(it, ALL_RECIPES)), `${label}: ${d.date} ${it.recipeId}`).toEqual([]);
}

const IS_PLAN = 'Matseðill fyrir næstu viku. ';
const EN_PLAN = 'Meal plan for next week. ';

/* ================================================================== P1-1 */
// "Ég er með ofnæmi fyrir …" (approved declaration) + approved inflected forms; English equivalents.
const DECLARED: { allergen: Al; is: string; en: string }[] = [
  { allergen: 'milk', is: 'Ég er með ofnæmi fyrir mjólk.', en: "I'm allergic to milk." },
  { allergen: 'egg', is: 'Ég er með ofnæmi fyrir eggjum.', en: "I'm allergic to eggs." },
  { allergen: 'peanuts', is: 'Ég er með ofnæmi fyrir jarðhnetum.', en: "I'm allergic to peanuts." },
  { allergen: 'tree_nuts', is: 'Ég er með ofnæmi fyrir trjáhnetum.', en: "I'm allergic to tree nuts." },
  { allergen: 'fish', is: 'Ég er með ofnæmi fyrir fiski.', en: "I'm allergic to fish." },
  { allergen: 'gluten', is: 'Ég er með ofnæmi fyrir glúteni.', en: "I'm allergic to gluten." },
  { allergen: 'soy', is: 'Ég er með ofnæmi fyrir soja.', en: "I'm allergic to soy." },
  { allergen: 'sesame', is: 'Ég er með ofnæmi fyrir sesamfræjum.', en: "I'm allergic to sesame." },
  { allergen: 'shellfish', is: 'Ég er með ofnæmi fyrir skelfiski.', en: "I'm allergic to shellfish." },
];
const QUESTION = { is: 'Hvað mælirðu með í morgunmat?', en: 'What is a good high-protein breakfast?' };

describe('P1-1: a question never erases an allergy declared in the same message', () => {
  it('the reviewer case: the declaration survives the question, and the question alone still declares nothing', () => {
    expect(parseExclusions('Ég er með ofnæmi fyrir mjólk. Hvað mælirðu með í morgunmat?').allergens).toContain('milk');
    expect(parseExclusions('Hvað mælirðu með í morgunmat? Ég er með ofnæmi fyrir mjólk.').allergens).toContain('milk');
    expect(parseExclusions("I'm allergic to milk. What should I eat for breakfast?").allergens).toContain('milk');
    expect(parseExclusions('Ég er með ofnæmi fyrir mjólk, hvað mælirðu með í morgunmat?').allergens).toContain('milk');
    expect(parseExclusions('Hvað mælirðu með, ég er með hnetuofnæmi?').allergens).toEqual(expect.arrayContaining(['peanuts', 'tree_nuts']));
    // Questions ABOUT a food or an allergy still declare nothing.
    expect(parseExclusions('Hvað eru jarðhnetur?').allergens).toEqual([]);
    expect(parseExclusions('Hvað er hnetuofnæmi?').allergens).toEqual([]);
    expect(parseExclusions('What is a peanut allergy?').allergens).toEqual([]);
    expect(parseExclusions('Er ég með ofnæmi fyrir mjólk?').allergens).toEqual([]);
    // A diet stated next to a question is kept; a diet only asked about is not.
    expect(dietTagsIn('Ég er vegan. Hvað mælirðu með í morgunmat?')).toEqual(['vegan']);
    expect(dietTagsIn('Segðu mér hvað vegan þýðir.')).toEqual([]);
  });

  for (const d of DECLARED) {
    const banned = withAllergen(d.allergen);
    for (const [lang, decl, q, prefix] of [['is', d.is, QUESTION.is, IS_PLAN], ['en', d.en, QUESTION.en, EN_PLAN]] as const) {
      for (const order of ['declaration first', 'question first'] as const) {
        const msg = order === 'declaration first' ? `${decl} ${q}` : `${q} ${decl}`;
        it(`${d.allergen} (${lang}, ${order}): "${msg}"`, async () => {
          const ex = parseExclusions(msg);
          expect(ex.allergens, 'declared allergen ruled out').toContain(d.allergen);
          expect(parseQuery(msg).exclude.allergens).toContain(d.allergen);
          // "fish" conservatively rules out shellfish too.
          await proveExcluded(`${d.allergen}/${lang}/${order}`, banned, q, msg, prefix, undefined, d.allergen === 'fish' ? union(banned, withAllergen('shellfish')) : banned);
        });
      }
    }
  }
});

/* ================================================================== P1-2 */
const peanutIds = withAllergen('peanuts');
const treeNutIds = withAllergen('tree_nuts');
describe('P1-2: nut exclusions — every approved extender, and peanuts relaxed only when explicitly wanted', () => {
  const KEEPS_PEANUTS: [string, string][] = [
    ['Engar hnetur, þar á meðal jarðhnetur', 'is'],
    ['Morgunmatur án hneta, þar með taldar jarðhnetur', 'is'],
    ['No nuts, peanut butter is not okay', 'en'],
    ['Engar hnetur, hnetusmjör er ekki í lagi', 'is'],
    ["No nuts, peanut butter isn't okay", 'en'],
    ['Engar hnetur. Hvað með hnetusmjör?', 'is'],
    ['No nuts. What about peanut butter?', 'en'],
    ['Engar hnetur, til dæmis jarðhnetur', 'is'],
    ['Engar hnetur, meðal annars jarðhnetur', 'is'],
    ['Engar hnetur, einkum jarðhnetur', 'is'],
  ];
  it.each(KEEPS_PEANUTS)('"%s" rules out peanuts AND tree nuts', (msg) => {
    const ex = parseExclusions(msg);
    expect(ex.allergens).toEqual(expect.arrayContaining(['peanuts', 'tree_nuts']));
    // Nothing excluded is searched FOR (a question may still name it; the exclusion above wins as a hard filter).
    expect(parseQuery(msg).words.filter((w) => (msg.includes('?') ? /meðal|taldar|okay/ : /peanut|meðal|taldar|okay/).test(w))).toEqual([]);
  });

  it('every approved extender (isLexicon negation.extenders) extends a nut exclusion to peanuts', async () => {
    const { IS_VOCAB } = await import('../../supabase/functions/_shared/ai/isLexicon');
    for (const ext of IS_VOCAB.negation.extenders) {
      expect(parseExclusions(`Engar hnetur, ${ext} jarðhnetur`).allergens, ext).toEqual(expect.arrayContaining(['peanuts', 'tree_nuts']));
      expect(parseExclusions(`Morgunmatur án hneta ${ext} jarðhnetur`).allergens, ext).toEqual(expect.arrayContaining(['peanuts', 'tree_nuts']));
    }
  });

  it('peanuts are relaxed only in an explicitly affirmative wanted-food clause', () => {
    for (const msg of ['No nuts like almonds, but I love peanut butter', 'Engar hnetur eins og möndlur, ég vil hnetusmjör', 'No nuts, but peanut butter is fine']) {
      const ex = parseExclusions(msg);
      expect(ex.allergens, msg).toContain('tree_nuts');
      expect(ex.allergens, msg).not.toContain('peanuts');
    }
  });

  for (const [msg, lang] of KEEPS_PEANUTS.slice(0, 4)) {
    it(`handler + catalog: "${msg}" never returns a peanut recipe; tree nuts stay out too`, async () => {
      const prefix = lang === 'is' ? IS_PLAN : EN_PLAN;
      const neutral = lang === 'is' ? 'Morgunmatur' : 'Breakfast';
      await proveExcluded(`peanuts: ${msg}`, peanutIds, neutral, msg, prefix, undefined, union(peanutIds, treeNutIds));
      await proveExcluded(`tree nuts: ${msg}`, treeNutIds, neutral, msg, prefix, undefined, union(peanutIds, treeNutIds));
    });
  }
});

/* ================================================================== P2-3 */
describe('P2-3: approved vegan phrases set the vegan diet; negated ones never do', () => {
  it('diet phrases', () => {
    expect(dietTagsIn('Finndu uppskriftir án dýraafurða')).toEqual(['vegan']);
    expect(dietTagsIn('Matur alfarið úr jurtaríkinu')).toEqual(['vegan']);
    expect(dietTagsIn('Ég vil veganmat')).toEqual(['vegan']);
    expect(dietTagsIn('Ég er ekki vegan, finndu kjúklingarétti')).toEqual([]);
    expect(dietTagsIn('Það þarf ekki að vera vegan')).toEqual([]);
    expect(dietTagsIn('ekki lengur vegan')).toEqual([]);
    expect(dietTagsIn('Það þarf ekki að vera glútenlaust')).toEqual([]);
    expect(parseQuery('Finndu uppskriftir án dýraafurða').diet).toEqual(['vegan']);
  });

  it('handler + catalog: "Finndu uppskriftir án dýraafurða" never returns chicken, skyr or any other animal product', async () => {
    const chicken = new Set(ALL_INGREDIENTS.filter((i) => i.proteinGroup === 'chicken').map((i) => i.id));
    const skyr = new Set(ALL_INGREDIENTS.filter((i) => /skyr/i.test(i.name)).map((i) => i.id));
    expect(chicken.size && skyr.size).toBeTruthy();
    await proveExcluded('vegan (chicken)', chicken, 'Finndu uppskriftir', 'Finndu uppskriftir án dýraafurða', IS_PLAN, 'dinner', notVegan);
    await proveExcluded('vegan (skyr)', skyr, 'Finndu uppskriftir', 'Finndu uppskriftir án dýraafurða', IS_PLAN, undefined, notVegan);
    // Nothing shown or planned under the vegan request carries any animal product.
    const cards = await findRecipes({ query: '', max_results: 5 }, 'Finndu uppskriftir án dýraafurða', ALL_RECIPES);
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) expect(cardIngredients(c, ALL_RECIPES).filter((id) => notVegan.has(id)), c.id).toEqual([]);
    const plan = planOf(await chat(`${IS_PLAN}Finndu uppskriftir án dýraafurða`, [text('Hér er planið.')]));
    expect(plan).not.toBeNull();
    for (const d of plan!) for (const it of d.items) expect(planIngredients(it, ALL_RECIPES).filter((id) => notVegan.has(id)), it.recipeId).toEqual([]);
  });

  it('"Ég er ekki vegan" does not restrict: chicken recipes are still found', async () => {
    const cards = await findRecipes({ query: 'chicken', max_results: 5 }, 'Ég er ekki vegan, finndu kjúklingarétti', ALL_RECIPES);
    expect(cards.some((c) => cardIngredients(c, ALL_RECIPES).some((id) => ING.get(id)?.proteinGroup === 'chicken'))).toBe(true);
  });
});

/* ================================================================== P2-7 */
describe('P2-7: a food negation is not a refusal; a question about my plan never creates one', () => {
  it('classification', () => {
    for (const msg of ['Ég borða ekki fisk og vil matseðil fyrir næstu viku', "I don't eat fish and want a meal plan for next week"]) {
      expect(classifyRequest(msg), msg).toBe('meal_plan');
      expect(classifyIntent(msg), msg).toBe('meal_plan');
      expect(asksForMealPlan(msg), msg).toBe(true);
      expect(parseExclusions(msg).allergens, msg).toContain('fish');
    }
    for (const msg of ['Er matseðillinn minn vegan?', 'Is my meal plan vegan?']) {
      expect(classifyRequest(msg), msg).toBe('explain_existing_meal_plan');
      expect(asksForMealPlan(msg), msg).toBe(false);
      expect(dietTagsIn(msg), msg).toEqual([]);
    }
    // Refusals of the plan itself stay refusals.
    for (const msg of ['Ekki búa til matseðil ennþá', 'Ég vil ekki matseðil', "I don't want a meal plan", 'Do not make a meal plan']) expect(classifyRequest(msg), msg).toBe('declined');
    // Requests that mention my plan but ask to make/change it are still requests.
    for (const msg of ['Gerðu matseðil fyrir næstu viku', 'Make my meal plan for next week', 'Change my meal plan to vegan']) expect(classifyRequest(msg), msg).toBe('meal_plan');
  });

  for (const [msg, neutral] of [
    ['Ég borða ekki fisk og vil matseðil fyrir næstu viku', 'Ég vil matseðil fyrir næstu viku'],
    ["I don't eat fish and want a meal plan for next week", 'I want a meal plan for next week'],
  ] as const) {
    it(`handler + catalog: "${msg}" builds next week's plan without fish`, async () => {
      const full = await chat(msg, [text('Hér er planið.')]);
      expect(full.action?.kind).toBe('meal_plan');
      expect(full.action!.days!.map((d) => d.date)[0]).toBe('2026-11-30');
      await proveExcluded(`fish: ${msg}`, fishIds, neutral, msg, '', 'dinner', union(fishIds, withAllergen('shellfish')));
    });
  }

  for (const [msg, create] of [['Er matseðillinn minn vegan?', 'Gerðu matseðil fyrir næstu viku'], ['Is my meal plan vegan?', 'Make me a meal plan for next week']] as const) {
    it(`handler: "${msg}" does not create a plan (while "${create}" does)`, async () => {
      expect((await chat(create, [text('Hér er planið.')])).action?.kind).toBe('meal_plan');
      const r = await chat(msg, [text('Já.')]);
      expect(r.action ?? null).toBeNull();
    });
  }
});

/* ================================================================== review 2: P1 */
// Allergies stated as a CONDITION inside a recommendation / recipe question are restrictions; only a question whose topic
// is the allergen or the allergy itself (or "Am I allergic …?") declares nothing.
const milkIds = withAllergen('milk');
describe('P1 (review 2): an allergy inside a recommendation question is a restriction', () => {
  const CASES: { allergen: Al; neutral: string; restricted: string; lang: 'is' | 'en' }[] = [
    { allergen: 'peanuts', neutral: 'What breakfast do you recommend?', restricted: 'What breakfast do you recommend for my peanut allergy?', lang: 'en' },
    { allergen: 'milk', neutral: 'Hvað mælirðu með í morgunmat?', restricted: 'Hvað mælirðu með í morgunmat ef maður er með mjólkurofnæmi?', lang: 'is' },
    { allergen: 'milk', neutral: 'Which breakfast is best?', restricted: 'Which breakfast is best with a milk allergy?', lang: 'en' },
    { allergen: 'milk', neutral: 'Hvað er gott í morgunmat?', restricted: 'Hvað er gott í morgunmat fyrir mann með mjólkurofnæmi?', lang: 'is' },
    { allergen: 'egg', neutral: 'What do you recommend for breakfast?', restricted: "I'm allergic to eggs — what do you recommend for breakfast?", lang: 'en' },
    { allergen: 'egg', neutral: 'Hvað mælirðu með í morgunmat?', restricted: 'Hvað mælirðu með í morgunmat ef ég er með ofnæmi fyrir eggjum?', lang: 'is' },
    { allergen: 'milk', neutral: 'What breakfast do you recommend?', restricted: 'What breakfast without milk do you recommend?', lang: 'en' },
    { allergen: 'milk', neutral: 'Hvaða morgunmat mælirðu með?', restricted: 'Hvaða morgunmat án mjólkur mælirðu með?', lang: 'is' },
  ];
  it('parser: the condition is kept; informational questions declare nothing', () => {
    for (const c of CASES) {
      expect(parseExclusions(c.restricted).allergens, c.restricted).toContain(c.allergen);
      expect(parseQuery(c.restricted).exclude.allergens, c.restricted).toContain(c.allergen);
      expect(parseExclusions(c.neutral).allergens, c.neutral).toEqual([]);
    }
    expect(parseExclusions('What breakfast do you recommend for my nut allergy?').allergens).toEqual(expect.arrayContaining(['peanuts', 'tree_nuts']));
    expect(parseExclusions('Hvað mælirðu með í morgunmat ef maður er með hnetuofnæmi?').allergens).toEqual(expect.arrayContaining(['peanuts', 'tree_nuts']));
    for (const msg of ['Hvað eru jarðhnetur?', 'Is peanut butter healthy?', 'Er ég með ofnæmi fyrir mjólk?', 'Am I allergic to milk?', 'Do I have a nut allergy?', 'What is a peanut allergy?',
      'Hvað er hnetuofnæmi?', 'Hvað er ofnæmi fyrir jarðhnetum?']) expect(parseExclusions(msg).allergens, msg).toEqual([]);
  });

  for (const c of CASES) {
    it(`handler + catalog (${c.lang}): "${c.restricted}" never shows or plans ${c.allergen}`, async () => {
      await proveExcluded(`${c.allergen}: ${c.restricted}`, withAllergen(c.allergen), c.neutral, c.restricted, c.lang === 'is' ? IS_PLAN : EN_PLAN);
    });
  }

  it('handler + catalog: the reviewer cases on the full catalog — no peanut recipes, no milk recipes', async () => {
    for (const [msg, banned] of [['What breakfast do you recommend for my peanut allergy?', peanutIds], ['Hvað mælirðu með í morgunmat ef maður er með mjólkurofnæmi?', milkIds]] as const) {
      const cards = await findRecipes({ query: 'breakfast', max_results: 5 }, msg, ALL_RECIPES);
      expect(cards.length, msg).toBeGreaterThan(0);
      for (const c of cards) expect(cardIngredients(c, ALL_RECIPES).filter((id) => banned.has(id)), `${msg}: ${c.id}`).toEqual([]);
      const h = await chat(msg, [toolUse('find_recipes', { query: 'peanut butter', max_results: 5 }), text('Hér eru hugmyndir.')]);
      for (const c of h.action?.recipes ?? []) expect(cardIngredients(c, ALL_RECIPES).filter((id) => banned.has(id)), `${msg}: handler ${c.id}`).toEqual([]);
    }
  });

  it('an informational question does not restrict: "Is peanut butter healthy?" still finds peanut butter', async () => {
    const { r, safe } = dangerous(peanutIds);
    for (const msg of ['Is peanut butter healthy?', 'Hvað eru jarðhnetur?', 'Am I allergic to peanuts?']) {
      expect((await findRecipes({ query: r.name, max_results: 5 }, msg, [r, safe])).map((c) => c.id), msg).toContain(r.id);
    }
  });
});

/* ================================================================== review 2: P2-3 */
describe('P2-3 (review 2): any question about my existing plan never creates a plan', () => {
  const QUESTIONS = ['Hversu mikið prótein er í matseðlinum mínum?', 'Hvaða uppskriftir eru í matseðlinum mínum?', 'Hvenær er fiskur í matseðlinum?', 'Segðu mér hversu mikið prótein er í matseðlinum mínum',
    'How much protein is in my meal plan?', 'How many meals are in my meal plan?', 'Which recipes are in my meal plan?', 'When is fish in my current meal plan?'];
  it('classification', () => {
    for (const msg of QUESTIONS) {
      expect(classifyRequest(msg), msg).toBe('explain_existing_meal_plan');
      expect(asksForMealPlan(msg), msg).toBe(false);
    }
    // Explicit create / change verbs still ask for one — also next to a question or a possessive that isn't the plan's.
    for (const msg of ['Gerðu matseðil fyrir næstu viku', 'Breyttu matseðlinum mínum', 'Make my meal plan for next week', 'Can you change my meal plan?', 'Could you do my meal plan?',
      'Meal plan for next week. What breakfast do you recommend for my peanut allergy?', 'Matseðill fyrir næstu viku. Hvað mælirðu með í morgunmat ef maður er með mjólkurofnæmi?']) {
      expect(classifyRequest(msg), msg).toBe('meal_plan');
    }
  });
  for (const msg of ['Hversu mikið prótein er í matseðlinum mínum?', 'How much protein is in my meal plan?', 'Hvaða uppskriftir eru í matseðlinum mínum?', 'Which recipes are in my meal plan?']) {
    it(`handler: "${msg}" does not create a plan`, async () => {
      const r = await chat(msg, [text('Um 180 g.')]);
      expect(r.action ?? null).toBeNull();
    });
  }
});

/* ================================================================== review 2: P2-6 */
describe('P2-6 (review 2): a wanted peanut butter with a modifier stays wanted; tree nuts stay out', () => {
  const WANTED: [string, 'is' | 'en'][] = [
    ['No nuts, but I like peanut butter without sugar', 'en'],
    ['Engar hnetur, en ég vil hnetusmjör án sykurs', 'is'],
    ['No nuts, but I love peanut butter with banana', 'en'],
    ['No nuts, but I love crunchy peanut butter', 'en'],
    ['Engar hnetur, en ég vil hnetusmjör með banana', 'is'],
  ];
  it('parser', () => {
    for (const [msg] of WANTED) {
      const ex = parseExclusions(msg);
      expect(ex.allergens, msg).toEqual(['tree_nuts']);
      // "without sugar" rules out sugar only — never the peanut butter it describes.
      expect(ex.words.filter((w) => !/^(?:sugar|sykurs)$/.test(w)), msg).toEqual([]);
      expect(parseQuery(msg).words, msg).toContain('peanut butter');
    }
    // A negation of the wanting, of the copula, or of nuts in the modifier relaxes nothing.
    for (const msg of ["No nuts, I don't like peanut butter", 'Engar hnetur, ég vil ekki hnetusmjör', 'No nuts, but I like peanut butter without almonds', 'No nuts, but I like peanut butter that is not okay'])
      expect(parseExclusions(msg).allergens, msg).toEqual(expect.arrayContaining(['peanuts', 'tree_nuts']));
  });
  for (const [msg, lang] of WANTED.slice(0, 2)) {
    it(`handler + catalog: "${msg}" finds peanut butter and never tree nuts`, async () => {
      const cards = await findRecipes({ query: 'peanut butter', max_results: 5 }, msg, ALL_RECIPES);
      expect(cards.some((c) => cardIngredients(c, ALL_RECIPES).some((id) => peanutIds.has(id))), 'peanut butter still found').toBe(true);
      for (const c of cards) expect(cardIngredients(c, ALL_RECIPES).filter((id) => treeNutIds.has(id)), c.id).toEqual([]);
      await proveExcluded(`tree nuts: ${msg}`, treeNutIds, lang === 'is' ? 'Morgunmatur' : 'Breakfast', msg, lang === 'is' ? IS_PLAN : EN_PLAN);
      // The meal-plan fallback keeps peanut butter wanted: with a peanut (tree-nut-free) snack as the only snack, it is planned.
      const uses = (x: RefRecipe, ids: Set<string>) => (x.ingredients ?? []).some((i) => ids.has(i.ingredientId));
      const pbSnack = ALL_RECIPES.find((x) => x.meal === 'snack' && uses(x, peanutIds) && !uses(x, treeNutIds))!;
      expect(pbSnack).toBeDefined();
      const others = (['breakfast', 'lunch', 'dinner'] as const).map((m) => ALL_RECIPES.find((x) => x.meal === m && !uses(x, treeNutIds) && !uses(x, peanutIds))!);
      const plan = planOf(await chat(`${lang === 'is' ? IS_PLAN : EN_PLAN}${msg}`, [text('Hér er planið.')], [...others, pbSnack], account({ mealsPerDay: 4 })));
      expect(plan, 'plan built').not.toBeNull();
      expect(plan!.some((d) => d.items.some((it) => it.recipeId === pbSnack.id)), 'peanut butter snack planned').toBe(true);
      for (const d of plan!) for (const it of d.items) expect(planIngredients(it, [...others, pbSnack]).filter((id) => treeNutIds.has(id)), it.recipeId).toEqual([]);
    });
  }
});

/* ================================================================== review 3: P1 */
// A question that asks what to EAT keeps every allergy / intolerance / avoidance phrase in it as a restriction, whoever
// it is about and without a possessive or a condition word. Only definitional and self-diagnostic questions declare nothing.
describe('P1 (review 3): an allergy in a what-to-eat question is a restriction, whoever it is about', () => {
  const nuts = union(peanutIds, treeNutIds);
  const CASES: { msg: string; neutral: string; allergens: Al[]; lang: 'is' | 'en' }[] = [
    { msg: 'What should someone allergic to peanuts eat for breakfast?', neutral: 'What should someone eat for breakfast?', allergens: ['peanuts'], lang: 'en' },
    { msg: 'What breakfast can someone allergic to peanuts eat?', neutral: 'What breakfast can someone eat?', allergens: ['peanuts'], lang: 'en' },
    { msg: 'What can a person with a peanut allergy eat for breakfast?', neutral: 'What can a person eat for breakfast?', allergens: ['peanuts'], lang: 'en' },
    { msg: 'What should my kid with a peanut allergy eat for breakfast?', neutral: 'What should my kid eat for breakfast?', allergens: ['peanuts'], lang: 'en' },
    { msg: 'Which breakfast recipes are good for a friend who is allergic to peanuts?', neutral: 'Which breakfast recipes are good for a friend?', allergens: ['peanuts'], lang: 'en' },
    { msg: 'What should people with a nut allergy have for breakfast?', neutral: 'What should people have for breakfast?', allergens: ['peanuts', 'tree_nuts'], lang: 'en' },
    { msg: 'What should someone who avoids peanuts eat for breakfast?', neutral: 'What should someone eat for breakfast?', allergens: ['peanuts'], lang: 'en' },
    { msg: 'Hvað getur einhver með hnetuofnæmi borðað í morgunmat?', neutral: 'Hvað mælirðu með í morgunmat?', allergens: ['peanuts', 'tree_nuts'], lang: 'is' },
    { msg: 'Hvað er gott í morgunmat fyrir fólk með hnetuofnæmi?', neutral: 'Hvað er gott í morgunmat?', allergens: ['peanuts', 'tree_nuts'], lang: 'is' },
  ];
  const INFORMATIONAL = ['What is a peanut allergy?', 'Hvað er hnetuofnæmi?', 'Hvað er ofnæmi fyrir jarðhnetum?', 'Hvað eru jarðhnetur?', 'Is peanut butter healthy?',
    'Am I allergic to peanuts?', 'Do I have a nut allergy?', 'Er ég með ofnæmi fyrir jarðhnetum?', 'What does peanut allergy mean?'];

  it('parser: the restriction is kept; definitional and self-diagnostic questions declare nothing', () => {
    for (const c of CASES) {
      expect([...parseExclusions(c.msg).allergens].sort(), c.msg).toEqual([...c.allergens].sort());
      expect(parseQuery(c.msg).exclude.allergens, c.msg).toEqual(expect.arrayContaining(c.allergens));
      // The allergen is never a search word.
      expect(parseQuery(c.msg).words.filter((w) => /peanut|hnet|nut/.test(w)), c.msg).toEqual([]);
      expect(parseExclusions(c.neutral).allergens, c.neutral).toEqual([]);
    }
    for (const msg of INFORMATIONAL) expect(parseExclusions(msg).allergens, msg).toEqual([]);
  });

  for (const c of CASES) {
    it(`handler + catalog (${c.lang}): "${c.msg}"`, async () => {
      const ruledOut = c.allergens.includes('tree_nuts') ? nuts : peanutIds;
      await proveExcluded(`peanuts: ${c.msg}`, peanutIds, c.neutral, c.msg, c.lang === 'is' ? IS_PLAN : EN_PLAN, undefined, ruledOut);
    });
  }

  it('the reviewer cases on the full catalog: the peanut-butter smoothies appear without the allergy and never with it', async () => {
    const PB = ['chocolate-peanut-protein-smoothie', 'vegan-peanut-strawberry-smoothie'];
    for (const id of PB) expect(ALL_RECIPES.find((x) => x.id === id), id).toBeDefined();
    for (const [msg, neutral] of [CASES[0], CASES[1]].map((c) => [c.msg, c.neutral])) {
      const base = await findRecipes({ query: 'peanut butter smoothie', max_results: 10 }, neutral, ALL_RECIPES);
      expect(base.map((c) => c.id).filter((id) => PB.includes(id)).length, `${neutral}: baseline`).toBeGreaterThan(0);
      const cards = await findRecipes({ query: 'peanut butter smoothie', max_results: 10 }, msg, ALL_RECIPES);
      expect(cards.map((c) => c.id).filter((id) => PB.includes(id)), msg).toEqual([]);
      for (const c of cards) expect(cardIngredients(c, ALL_RECIPES).filter((id) => peanutIds.has(id)), `${msg}: ${c.id}`).toEqual([]);
      const h = await chat(msg, [toolUse('find_recipes', { query: 'peanut butter smoothie', max_results: 10 }), text('Here are some ideas.')]);
      for (const c of h.action?.recipes ?? []) expect(cardIngredients(c, ALL_RECIPES).filter((id) => peanutIds.has(id)), `${msg}: handler ${c.id}`).toEqual([]);
      expect((h.action?.recipes ?? []).map((c) => c.id).filter((id) => PB.includes(id)), msg).toEqual([]);
    }
  });

  it('definitional and self-diagnostic questions do not restrict: peanut recipes are still found', async () => {
    const { r, safe } = dangerous(peanutIds);
    for (const msg of INFORMATIONAL) {
      expect((await findRecipes({ query: r.name, max_results: 5 }, msg, [r, safe])).map((c) => c.id), msg).toContain(r.id);
    }
  });
});

/* ================================================================== review 3: P2 (wanted peanut butter, Icelandic "með") */
describe('P2 (review 3): "án hneta, með hnetusmjöri" keeps peanut butter wanted; tree nuts stay out', () => {
  it('parser', () => {
    for (const msg of ['Morgunmatur án hneta, með hnetusmjöri', 'Morgunmatur án hneta og með hnetusmjöri']) {
      expect(parseExclusions(msg).allergens, msg).toEqual(['tree_nuts']);
      expect(parseQuery(msg).words, msg).toContain('peanut butter');
    }
    // "ekkert með … eða með …" stays negative throughout; a negated or asked "með" relaxes nothing.
    for (const msg of ['Engar hnetur, ekkert með hnetusmjöri eða með möndlum', 'Engar hnetur, með hnetusmjöri?', 'Án hneta, með hnetusmjöri er ekki í lagi'])
      expect(parseExclusions(msg).allergens, msg).toEqual(expect.arrayContaining(['peanuts', 'tree_nuts']));
  });

  it('handler + catalog: "Morgunmatur án hneta, með hnetusmjöri" returns a peanut-butter recipe and never tree nuts', async () => {
    const msg = 'Morgunmatur án hneta, með hnetusmjöri';
    const cards = await findRecipes({ query: 'peanut butter', max_results: 5 }, msg, ALL_RECIPES);
    expect(cards.some((c) => cardIngredients(c, ALL_RECIPES).some((id) => peanutIds.has(id))), 'peanut butter found (tool)').toBe(true);
    for (const c of cards) expect(cardIngredients(c, ALL_RECIPES).filter((id) => treeNutIds.has(id)), c.id).toEqual([]);
    const h = await chat(msg, [toolUse('find_recipes', { query: 'peanut butter', max_results: 5 }), text('Hér eru hugmyndir.')]);
    expect((h.action?.recipes ?? []).some((c) => cardIngredients(c, ALL_RECIPES).some((id) => peanutIds.has(id))), 'peanut butter found (handler)').toBe(true);
    for (const c of h.action?.recipes ?? []) expect(cardIngredients(c, ALL_RECIPES).filter((id) => treeNutIds.has(id)), `handler ${c.id}`).toEqual([]);
    await proveExcluded(`tree nuts: ${msg}`, treeNutIds, 'Morgunmatur', msg, IS_PLAN);
  });

  it('handler + catalog: "Engar hnetur, ekkert með hnetusmjöri eða með möndlum" rules out peanuts and tree nuts', async () => {
    const msg = 'Engar hnetur, ekkert með hnetusmjöri eða með möndlum';
    const nuts = union(peanutIds, treeNutIds);
    await proveExcluded(`peanuts: ${msg}`, peanutIds, 'Morgunmatur', msg, IS_PLAN, undefined, nuts);
    await proveExcluded(`tree nuts: ${msg}`, treeNutIds, 'Morgunmatur', msg, IS_PLAN, undefined, nuts);
  });
});

/* ================================================================== review 3: P2 (forced propose_meal_plan) */
describe('P2 (review 3): a model-issued propose_meal_plan never creates a plan for a question about my plan', () => {
  for (const [msg, create] of [
    ['Hversu mikið prótein er í matseðlinum mínum?', 'Gerðu matseðil fyrir næstu viku'],
    ['How much protein is in my meal plan?', 'Make me a meal plan for next week'],
    ['Er matseðillinn minn vegan?', 'Breyttu matseðlinum mínum'],
  ] as const) {
    it(`forced tool: "${msg}" gets no plan, "${create}" gets one`, async () => {
      const asked = await chat(msg, [toolUse('propose_meal_plan', { week: 'next' }), text('Um 180 g.')]);
      expect(asked.action ?? null, msg).toBeNull();
      const made = await chat(create, [toolUse('propose_meal_plan', { week: 'next' }), text('Hér er planið.')]);
      expect(made.action?.kind, create).toBe('meal_plan');
    });
  }

  it('the tool result tells the model to answer about the existing meal plan; program proposals are not blocked', async () => {
    const acc = account();
    const ctx = (userText: string) => ({ db: conversationDb(ALL_RECIPES, acc), facts: facts(), catalog: new Map(), state: { proposal: null, proposalAttempts: 0 } as ToolState,
      messageId: mid(3), nutrition: nutritionStatus(acc, true), account: acc, today: TODAY, requestText: userText, userText });
    const meal = ctx('Hversu mikið prótein er í matseðlinum mínum?');
    const out = await runTool('propose_meal_plan', { week: 'next' }, meal);
    expect(JSON.parse(out.content).status).toBe('no_action');
    expect(meal.state.mealPlan ?? null).toBeNull();
    // Program proposals are not guarded: a complaint about the program can still get a change offered.
    for (const msg of ['Why is my program 5 days? I can only train 3', 'Hversu mörg sett eru í æfingaáætluninni minni?']) {
      const prog = ctx(msg);
      const p = await runTool('propose_program_change', { program: { name: 'X', days: [] } }, prog);
      expect(JSON.parse(p.content).status, msg).not.toBe('no_action');
      expect(prog.state.proposal, msg).not.toBeNull();
    }
    // A request to make one is not blocked.
    const make = ctx('Gerðu matseðil fyrir næstu viku');
    expect(JSON.parse((await runTool('propose_meal_plan', { week: 'next' }, make)).content).status).toBe('offered');
  });
});
