/**
 * Protein preferences ("proteins I like / not for me"):
 *  - excluded groups never appear in plans, protein sides, substitutions, the shopping list, recipe lists or AI suggestions;
 *  - liked groups are picked more often, but other proteins still appear;
 *  - allergies still win over likes;
 *  - data saved before 0.9.0 (no proteinPrefs) plans exactly as before;
 *  - MOCKED AI: the context carries the preferences, find_recipes and propose_meal_plan filter by them.
 */
import { describe, expect, it } from 'vitest';
import { RECIPES, RECIPES_BY_ID } from '@/data/recipes';
import { INGREDIENTS, INGREDIENTS_BY_ID } from '@/data/ingredients';
import {
  allowedSubstitutes, cycleProteinChoice, featuredProteinGroups, mainProteinGroup, normalizeProteinPrefs, proteinChoice, proteinFitSwaps,
  recipeMatches, recipeProteinGroups, resolveIngredients,
} from '@/domain/nutrition/recipes';
import {
  allowedAddOns, buildShoppingList, generateMealPlan, planPrefsFrom, planWarnings, swapMeal, type PlanDraft, type PlanPrefs,
} from '@/domain/nutrition/mealplan';
import { proteinGapSuggestions } from '@/domain/nutrition/log';
import type { DietPrefs, MealSlot, ProteinGroup, Recipe } from '@/domain/types';
import { runTool, type ToolState } from '../../supabase/functions/_shared/ai/tools';
import { buildMealPlanAction } from '../../supabase/functions/_shared/ai/meals';
import { deriveFacts, buildContext } from '../../supabase/functions/_shared/ai/context';
import { nutritionStatus } from '../../supabase/functions/_shared/ai/dataStatus';
import type { AccountStatePayload, AiDb, RefIngredient, RefRecipe, UserFacts } from '../../supabase/functions/_shared/ai/types';

const WEEK = '2026-11-02';
const BASE_DIET: DietPrefs = { tags: [], allergens: [], dislikedIngredientIds: [], maxCookMinutes: 30, budget: 'any', mealsPerDay: 3 };
const prefs = (diet: Partial<DietPrefs> = {}, proteinG: number | undefined = 160, variant = 0): PlanPrefs =>
  planPrefsFrom({ ...BASE_DIET, ...diet }, { mode: proteinG ? 'protein_only' : 'none', proteinG }, true, variant);

/** Every ingredient a plan uses: recipes after swaps, plus protein sides. */
function planIngredientIds(plan: PlanDraft): string[] {
  const ids: string[] = [];
  for (const d of plan.days)
    for (const it of d.items) {
      ids.push(...resolveIngredients(RECIPES_BY_ID.get(it.recipeId)!, it.swaps).map((r) => r.ingredientId));
      ids.push(...(it.extras ?? []).map((e) => e.ingredientId));
    }
  return ids;
}
const groupOf = (id: string) => INGREDIENTS_BY_ID.get(id)?.proteinGroup;

/** 50 different settings: meals per day, targets, diets, budgets, cook times and regenerate variants. */
function settingsMatrix(): PlanPrefs[] {
  const out: PlanPrefs[] = [];
  const diets: Partial<DietPrefs>[] = [{}, { tags: ['pescatarian'] }, { tags: ['dairy_free'] }, { tags: ['gluten_free'] }, { budget: 'low' }];
  for (let i = 0; i < 50; i++) {
    const d = diets[i % diets.length];
    out.push(
      prefs(
        { ...d, mealsPerDay: 1 + (i % 6), maxCookMinutes: [15, 20, 30, 45, 60][i % 5], proteinPrefs: { liked: i % 3 === 0 ? ['tuna', 'chicken'] : [], excluded: ['prawns'] } },
        i % 4 === 0 ? undefined : 120 + (i % 5) * 20,
        i,
      ),
    );
  }
  return out;
}

describe('protein preference values', () => {
  it('tri-state cycle: neutral → like → not for me → neutral; excluded wins and unknown groups are dropped', () => {
    let p = normalizeProteinPrefs(undefined);
    expect(proteinChoice(p, 'prawns')).toBe('neutral');
    p = cycleProteinChoice(p, 'prawns');
    expect(proteinChoice(p, 'prawns')).toBe('like');
    p = cycleProteinChoice(p, 'prawns');
    expect(proteinChoice(p, 'prawns')).toBe('exclude');
    expect(p).toEqual({ liked: [], excluded: ['prawns'] });
    p = cycleProteinChoice(p, 'prawns');
    expect(p).toEqual({ liked: [], excluded: [] });
    expect(normalizeProteinPrefs({ liked: ['tuna', 'eggs', 'nope' as ProteinGroup], excluded: ['tuna'] })).toEqual({ liked: ['eggs'], excluded: ['tuna'] });
  });

  it('every protein food has a group and milk/butter deliberately have none', () => {
    for (const i of INGREDIENTS) if (i.category === 'protein') expect(i.proteinGroup, i.id).toBeTruthy();
    expect(groupOf('milk')).toBeUndefined();
    expect(groupOf('butter')).toBeUndefined();
    expect(groupOf('skyr-plain')).toBe('dairy');
    expect(groupOf('shrimp-cooked')).toBe('prawns');
    expect(groupOf('mussels-cooked')).toBe('shellfish');
  });

  it('main protein: a prawn pasta is out for prawn-excluders; a recipe using an excluded group elsewhere is swapped if a substitute exists', () => {
    const pasta = RECIPES_BY_ID.get('garlic-prawn-pasta')!;
    expect(mainProteinGroup(pasta)).toBe('prawns');
    expect(proteinFitSwaps(pasta, ['prawns'])).toBeNull();
    expect(recipeMatches(pasta, { excludeProteinGroups: ['prawns'] })).toBe(false);
    // A synthetic recipe: chicken main, prawns as an optional add-on with a cod substitution → swapped, still eligible.
    const r: Recipe = {
      ...RECIPES_BY_ID.get('chicken-rice-broccoli-bowl')!,
      id: 'test-surf-turf',
      ingredients: [...RECIPES_BY_ID.get('chicken-rice-broccoli-bowl')!.ingredients, { ingredientId: 'shrimp-cooked', grams: 60, optional: true }],
      substitutions: [{ ingredientId: 'shrimp-cooked', alternatives: ['cod-raw'] }],
    };
    expect(proteinFitSwaps(r, ['prawns'])).toEqual([{ from: 'shrimp-cooked', to: 'cod-raw' }]);
    expect(recipeMatches(r, { excludeProteinGroups: ['prawns'] })).toBe(true);
    // …but not when the substitute is excluded too, or ruled out by an allergy.
    expect(proteinFitSwaps(r, ['prawns', 'white_fish'])).toBeNull();
    expect(recipeMatches(r, { excludeProteinGroups: ['prawns'], excludeAllergens: ['fish'] })).toBe(false);
  });
});

describe('excluded proteins never appear', () => {
  it('prawns excluded → zero prawn ingredients across 50 generated plans with different settings (meals, sides, swaps, shopping list)', () => {
    let meals = 0;
    for (const p of settingsMatrix()) {
      const { plan } = generateMealPlan(WEEK, p);
      meals += plan.days.reduce((n, d) => n + d.items.length, 0);
      expect(planIngredientIds(plan).filter((id) => groupOf(id) === 'prawns')).toEqual([]);
      const shopping = buildShoppingList(plan, RECIPES_BY_ID).flatMap((g) => g.items.map((i) => i.ingredientId));
      expect(shopping.filter((id) => groupOf(id) === 'prawns')).toEqual([]);
      // Swapping a meal keeps it out too.
      const first = plan.days[0].items[0];
      if (first) expect(planIngredientIds(swapMeal(plan, plan.days[0].date, first.id, p)).filter((id) => groupOf(id) === 'prawns')).toEqual([]);
    }
    expect(meals).toBeGreaterThan(500);
  });

  it('protein sides, substitutions, recipe lists and protein-gap ideas leave excluded groups out', () => {
    const p = prefs({ proteinPrefs: { liked: [], excluded: ['prawns', 'tuna', 'dairy'] } });
    for (const slot of ['breakfast', 'lunch', 'dinner', 'snack'] as MealSlot[])
      for (const a of allowedAddOns(slot, p)) expect(['prawns', 'tuna', 'dairy']).not.toContain(groupOf(a.ingredientId));
    // Unrestricted, prawns and tuna are offered as sides (so the filter is doing the work).
    expect(allowedAddOns('dinner', prefs()).map((a) => a.ingredientId)).toEqual(expect.arrayContaining(['shrimp-cooked', 'tuna-canned']));
    const smoked = RECIPES_BY_ID.get('smoked-salmon-cucumber-bites')!;
    expect(allowedSubstitutes(smoked, 'smoked-salmon', ['prawns'])).not.toContain('shrimp-cooked');
    expect(allowedSubstitutes(smoked, 'smoked-salmon', [])).toContain('shrimp-cooked');
    const list = RECIPES.filter((r) => recipeMatches(r, { excludeProteinGroups: ['prawns'] }));
    expect(list.length).toBeGreaterThan(RECIPES.length * 0.9);
    for (const r of list) expect(recipeProteinGroups(r, proteinFitSwaps(r, ['prawns']) ?? [])).not.toContain('prawns');
    const ideas = proteinGapSuggestions(40, { excludedProteins: ['dairy', 'tuna'] });
    expect(ideas.length).toBeGreaterThan(0);
    for (const s of ideas) {
      if (s.kind === 'food') expect(['dairy', 'tuna']).not.toContain(groupOf(s.id));
      else expect(featuredProteinGroups(RECIPES_BY_ID.get(s.id)!).some((g) => g === 'dairy' || g === 'tuna')).toBe(false);
    }
  });

  it('a saved plan that uses a protein marked later as "not for me" is flagged', () => {
    const before = generateMealPlan(WEEK, prefs()).plan;
    const used = new Set(before.days.flatMap((d) => d.items.flatMap((it) => recipeProteinGroups(RECIPES_BY_ID.get(it.recipeId)!))));
    const g = [...used][0];
    const w = planWarnings(before, prefs({ proteinPrefs: { liked: [], excluded: [g] } }));
    expect(w.some((x) => /which you marked Not for me/.test(x))).toBe(true);
  });

  it('too few recipes for a meal: the status says so instead of silently repeating', () => {
    const excluded: ProteinGroup[] = ['chicken', 'turkey', 'beef', 'pork', 'lamb', 'white_fish', 'oily_fish', 'tuna', 'prawns', 'shellfish', 'eggs', 'dairy', 'tofu_tempeh', 'chickpeas'];
    const p = prefs({ maxCookMinutes: 20, proteinPrefs: { liked: [], excluded } });
    const { plan, warnings } = generateMealPlan(WEEK, p);
    expect(plan.days.length).toBe(7);
    expect(warnings.some((w) => /^Only \d+ (breakfasts?|lunch(es)?|dinners?) fits? your choices, so some repeat this week: allow one more protein or a longer cook time\?$/.test(w))).toBe(true);
    expect(planWarnings(plan, prefs({ maxCookMinutes: 20 })).some((w) => /^Only \d+/.test(w))).toBe(false);
  });
});

describe('liked proteins and allergies', () => {
  const count = (g: ProteinGroup, liked: ProteinGroup[]) => {
    let n = 0;
    let total = 0;
    for (let v = 0; v < 8; v++) {
      const { plan } = generateMealPlan(WEEK, prefs({ mealsPerDay: 4, proteinPrefs: { liked, excluded: [] } }, 150, v));
      for (const d of plan.days)
        for (const it of d.items) {
          total++;
          if (featuredProteinGroups(RECIPES_BY_ID.get(it.recipeId)!).includes(g)) n++;
        }
    }
    return { n, total };
  };

  it('liked groups appear more often, and other proteins still appear for variety', () => {
    for (const g of ['tuna', 'pork', 'chickpeas'] as ProteinGroup[]) {
      const neutral = count(g, []);
      const liked = count(g, [g]);
      expect(liked.n, g).toBeGreaterThan(neutral.n);
      expect(liked.n, g).toBeLessThan(liked.total); // not every meal
    }
  });

  it('allergies win over likes: liking prawns with a shellfish allergy never plans prawns', () => {
    const p = prefs({ allergens: ['shellfish'], proteinPrefs: { liked: ['prawns', 'shellfish'], excluded: [] } });
    for (let v = 0; v < 5; v++) {
      const { plan } = generateMealPlan(WEEK, { ...p, variant: v });
      expect(planIngredientIds(plan).filter((id) => INGREDIENTS_BY_ID.get(id)!.allergens.includes('shellfish'))).toEqual([]);
    }
  });

  it('old data with no proteinPrefs plans exactly as before (no new fields, no swaps)', () => {
    const old = prefs();
    expect('proteinLiked' in old || 'proteinExcluded' in old).toBe(false);
    expect(prefs({ proteinPrefs: { liked: [], excluded: [] } })).toEqual(old);
    const a = generateMealPlan(WEEK, old);
    const b = generateMealPlan(WEEK, prefs({ proteinPrefs: { liked: [], excluded: [] } }));
    expect(b).toEqual(a);
    expect(a.plan.days.flatMap((d) => d.items).some((it) => 'swaps' in it)).toBe(false);
  });
});

/* ------------------------------------------------------------------ MOCKED AI */
const REF_RECIPES = RECIPES as unknown as RefRecipe[];
const REF_INGREDIENTS = INGREDIENTS as unknown as RefIngredient[];
const accountPayload = (proteinPrefs?: unknown): AccountStatePayload => ({
  settings: { units: { weight: 'kg' }, timeZone: 'UTC', weekStart: 1, nutritionEnabled: true },
  profile: { goal: 'build_muscle', diet: { tags: [], allergens: [], dislikedIngredientIds: [], maxCookMinutes: 30, mealsPerDay: 3, budget: 'any', ...(proteinPrefs ? { proteinPrefs } : {}) } as never },
  nutrition: { mode: 'protein_only', proteinG: 180, proteinPerKg: 2 },
});
const factsFor = (acc: AccountStatePayload): UserFacts => deriveFacts(acc, null);
const db = (acc: AccountStatePayload) =>
  ({
    getSettings: async () => ({ enabled: true, paused: false, consentAt: '2026-10-01T00:00:00Z', scopes: { profile: true, training: true, measurements: false, nutrition: true }, scopesChangedAt: null, profileNotes: '' }),
    getAccountState: async () => acc,
    getActiveProgram: async () => null,
    getRecentSessions: async () => [],
    getGoals: async () => [],
    getBodyweight: async () => [],
    getFoodLogs: async () => [],
    getHistory: async () => [],
    getExercises: async () => [],
    getRecipes: async () => REF_RECIPES,
    getIngredients: async () => REF_INGREDIENTS,
  }) as unknown as AiDb;

describe('MOCKED AI coach: protein preferences', () => {
  const excl = { liked: ['tuna'], excluded: ['prawns', 'pork'] };

  it('the nutrition context includes likes and "not for me" proteins, worded as a preference, not an allergy', async () => {
    const acc = accountPayload(excl);
    expect(factsFor(acc)).toMatchObject({ proteinLiked: ['tuna'], proteinExcluded: ['pork', 'prawns'] });
    expect(factsFor(accountPayload())).toMatchObject({ proteinLiked: [], proteinExcluded: [] });
    const ctx = await buildContext({ db: db(acc), uid: 'u', settings: { enabled: true, paused: false, scopes: { profile: true, training: true, measurements: false, nutrition: true }, profileNotes: '' }, text: 'dinner ideas?', mode: 'chat', now: new Date('2026-10-29T10:00:00Z') } as never);
    expect(ctx.system).toMatch(/Proteins they like \(prefer these\): Tuna/);
    expect(ctx.system).toMatch(/Proteins they don't eat \("not for me": a taste preference, not an allergy; never suggest them\): Pork & ham, Prawns/);
    expect(ctx.system).toMatch(/mention it \("since you don't eat prawns…"\) only when it's relevant/);
  });

  it('find_recipes never returns excluded proteins, ranks liked ones first, and explains when choices empty everything', async () => {
    const acc = accountPayload(excl);
    const run = async (input: Record<string, unknown>, a = acc) => {
      const state: ToolState = { proposal: null, proposalAttempts: 0 };
      const out = await runTool('find_recipes', input, { db: db(a), facts: factsFor(a), catalog: new Map(), state, messageId: 'm1', nutrition: nutritionStatus(a, true), account: a });
      return JSON.parse(out.content);
    };
    const prawns = await run({ query: 'prawn', max_results: 5 });
    for (const r of prawns.results) expect(featuredProteinGroups(RECIPES_BY_ID.get(r.id)!)).not.toContain('prawns');
    const unrestricted = await run({ query: 'prawn', max_results: 5 }, accountPayload());
    expect(unrestricted.results.some((r: { id: string }) => mainProteinGroup(RECIPES_BY_ID.get(r.id)!) === 'prawns')).toBe(true);
    const tunaCount = (res: { results: { id: string }[] }) => res.results.filter((r) => featuredProteinGroups(RECIPES_BY_ID.get(r.id)!).includes('tuna')).length;
    let liked = 0;
    let neutral = 0;
    for (const meal of ['breakfast', 'lunch', 'dinner', 'snack']) {
      const res = await run({ meal, max_results: 5 });
      for (const r of res.results) expect(recipeProteinGroups(RECIPES_BY_ID.get(r.id)!, [])).not.toContain('pork');
      liked += tunaCount(res);
      neutral += tunaCount(await run({ meal, max_results: 5 }, accountPayload()));
    }
    expect(liked).toBeGreaterThan(neutral);
    const all = accountPayload({ liked: [], excluded: ['chicken', 'turkey', 'beef', 'pork', 'lamb', 'white_fish', 'oily_fish', 'tuna', 'prawns', 'shellfish', 'eggs', 'dairy', 'tofu_tempeh', 'beans_lentils', 'chickpeas', 'whey', 'plant_protein'] });
    const none = await run({ query: 'dinner' }, { ...all, profile: { ...all.profile, diet: { ...(all.profile!.diet as object), maxCookMinutes: 10 } as never } });
    if (none.results.length === 0) expect(none.reason).toMatch(/not for me/);
  });

  it('propose_meal_plan builds plans without excluded proteins (meals, swaps and sides)', () => {
    const acc = accountPayload(excl);
    const { action, errors } = buildMealPlanAction(
      { week: 'next' } as never,
      { facts: factsFor(acc), account: acc, today: '2026-10-29', nutrition: nutritionStatus(acc, true), messageId: 'm2', recipes: REF_RECIPES, ingredients: REF_INGREDIENTS },
    );
    expect(errors).toEqual([]);
    for (const d of action!.days)
      for (const it of d.items) {
        const groups = recipeProteinGroups(RECIPES_BY_ID.get(it.recipeId)!, it.swaps ?? []);
        expect(groups).not.toContain('prawns');
        expect(groups).not.toContain('pork');
        for (const e of it.extras ?? []) expect(['prawns', 'pork']).not.toContain(groupOf(e.ingredientId));
      }
  });
});
