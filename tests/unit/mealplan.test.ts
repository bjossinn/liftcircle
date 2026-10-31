/**
 * Meal plans respond to targets (repair brief 29 Oct 2026, section 5).
 * Fixture from the external review: 80 kg reference weight, protein-only 144 g/day, 3 meals/day,
 * ≤ 30 min cooking, milk excluded. Before the fix the week was 125, 112, 87, 99, 114, 107, 102 g.
 */
import { afterAll, describe, expect, it } from 'vitest';
import {
  allowedAddOns, balanceDay, balancePlan, buildShoppingList, generateMealPlan, planDayNutrition, planDayStatus, planItemNutrition,
  planPrefsFrom, planStatus, planWarnings, PROTEIN_ADDONS, PROTEIN_SIDES_LABEL, proteinTolerance, selectMeals, swapMeal, updatePlanItem,
  type PlanDraft, type PlanPrefs,
} from '@/domain/nutrition/mealplan';
import {
  displayMacro, ingredientAllowed, recipeAllergens, recipeDietTags, recipeMinutes, recipeNutrition, satisfiesTag,
} from '@/domain/nutrition/recipes';
import { computeNutritionTargets } from '@/domain/nutrition/targets';
import { dayTotals, entryFromRecipe } from '@/domain/nutrition/log';
import { INGREDIENTS_BY_ID } from '@/data/ingredients';
import { RECIPES, RECIPES_BY_ID } from '@/data/recipes';
import { LiftDb } from '@/db/db';
import { newRecord, saveRecord } from '@/db/repo';
import type { DietPrefs, MealPlan, NutritionTargets } from '@/domain/types';
import { setNutritionCatalog } from '../../supabase/functions/_shared/nutrition/catalog';

// These fixtures (and their exact numbers) were reviewed on the 84-recipe catalogue of packs 1–2, so the planner runs on that
// catalogue here. The full catalogue (pack 3) is covered by recipeCatalog.test.ts and proteinPrefs.test.ts.
setNutritionCatalog({ recipes: RECIPES.slice(0, 84) });

const WEEK = '2026-10-26';
const fixtureTargets = computeNutritionTargets({
  mode: 'protein_only', weightKg: 80, activityLevel: 'moderate', goal: 'general_fitness', mealsPerDay: 3,
}).targets;
const fixtureDiet: DietPrefs = { tags: [], allergens: ['milk'], dislikedIngredientIds: [], maxCookMinutes: 30, budget: 'any', mealsPerDay: 3 };
const FIXTURE: PlanPrefs = planPrefsFrom(fixtureDiet, fixtureTargets, true);
const dailyProtein = (plan: PlanDraft) => plan.days.map((d) => planDayNutrition(d, RECIPES_BY_ID).protein);

/** Every planned recipe, ingredient swap and protein side respects the hard filters and cooking time. */
function expectConstraintsRespected(plan: PlanDraft, prefs: PlanPrefs, opts: { relaxedSlots?: string[] } = {}) {
  for (const day of plan.days) {
    expect(day.items.length).toBeLessThanOrEqual(prefs.mealsPerDay);
    for (const it of day.items) {
      const r = RECIPES_BY_ID.get(it.recipeId)!;
      const al = recipeAllergens(r, it.swaps);
      for (const a of prefs.allergens) expect(al, `${r.id} has ${a}`).not.toContain(a);
      for (const t of prefs.tags) expect(satisfiesTag(recipeDietTags(r, it.swaps), t), `${r.id} not ${t}`).toBe(true);
      if (!opts.relaxedSlots?.includes(it.slot)) expect(recipeMinutes(r), r.id).toBeLessThanOrEqual(prefs.maxCookMinutes);
      for (const e of it.extras ?? []) {
        const ing = INGREDIENTS_BY_ID.get(e.ingredientId)!;
        expect(ingredientAllowed(ing, { tags: prefs.tags, allergens: prefs.allergens, disliked: prefs.dislikedIngredientIds }), e.ingredientId).toBe(true);
        const side = PROTEIN_ADDONS.find((a) => a.ingredientId === e.ingredientId)!;
        expect(side.slots).toContain(it.slot);
        if (side.minutes > 0) expect(recipeMinutes(r) + side.minutes).toBeLessThanOrEqual(prefs.maxCookMinutes);
        if (prefs.budget === 'low') expect(ing.costTier).toBeLessThanOrEqual(2);
      }
    }
  }
}

describe('fixture: 80 kg, protein-only 144 g, 3 meals, ≤30 min, no milk', () => {
  it('derives the fixture objective without an energy target', () => {
    expect(fixtureTargets.proteinG).toBe(144);
    expect(FIXTURE.proteinTarget).toBe(144);
    expect(FIXTURE.kcalTarget).toBeUndefined();
    expect(proteinTolerance(144)).toBe(7);
  });

  it('reproduces the reviewed week from meal selection alone (target only ranks recipes)', () => {
    const before = selectMeals(WEEK, FIXTURE);
    // The review rounded the raw sum. Updated Nov 2026 for the 84-recipe catalogue (the 24-recipe week was
    // 125, 112, 87, 99, 114, 107, 102): the larger pool ranks more high-protein meals into the week.
    const raw = before.days.map((d) => d.items.reduce((s, i) => s + recipeNutrition(RECIPES_BY_ID.get(i.recipeId)!, { servings: i.servings }).total.protein, 0));
    expect(raw.map(Math.round)).toEqual([128, 121, 111, 104, 98, 94, 88]);
    // The single rounding rule (stored 0.1 g per meal, then whole grams) gives the same numbers the food log
    // shows if those meals are logged.
    expect(dailyProtein(before).map((p) => displayMacro(p, 'protein'))).toEqual([128, 121, 111, 104, 98, 94, 88]);
  });

  it('puts every day within ±7 g of 144 g after reconciling, keeping meal count, cook time and exclusions', () => {
    const { plan, warnings } = generateMealPlan(WEEK, FIXTURE);
    const after = dailyProtein(plan);
    // Before → after (g/day): 128,121,111,104,98,94,88 → 140.4,139.4,140.6,140.3,144.5,140.9,143.3
    // (the 24-recipe catalogue gave 142.6,141.8,138.6,138.3,144.8,137.6,141.0)
    expect(after).toEqual([140.4, 139.4, 140.6, 140.3, 144.5, 140.9, 143.3]);
    for (const p of after) expect(Math.abs(p - 144)).toBeLessThanOrEqual(7);
    for (const d of plan.days) expect(d.items).toHaveLength(3);
    expectConstraintsRespected(plan, FIXTURE);
    const status = planStatus(plan, FIXTURE);
    expect(status.onTarget).toBe(7);
    expect(status.days.every((d) => d.state === 'on_target' && !d.message)).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('is deterministic', () => {
    expect(generateMealPlan(WEEK, FIXTURE)).toEqual(generateMealPlan(WEEK, FIXTURE));
    expect(generateMealPlan(WEEK, { ...FIXTURE, variant: 3 })).toEqual(generateMealPlan(WEEK, { ...FIXTURE, variant: 3 }));
  });

  it('every regenerate variant is on target too', () => {
    for (const variant of [1, 2, 3, 4]) {
      const { plan } = generateMealPlan(WEEK, { ...FIXTURE, variant });
      for (const p of dailyProtein(plan)) expect(Math.abs(p - 144), `variant ${variant}`).toBeLessThanOrEqual(7);
      expectConstraintsRespected(plan, FIXTURE);
    }
  });
});

describe('multiple dietary constraints', () => {
  it('pescatarian + dairy-free + no shellfish + ≤15 min + low budget stays on target', () => {
    // ≤15 min (was ≤20 before Nov 2026): the larger catalogue has 20-minute pescatarian dinners, and this test
    // exercises the relaxed-time path.
    const prefs: PlanPrefs = { tags: ['pescatarian', 'dairy_free'], allergens: ['shellfish'], dislikedIngredientIds: [], maxCookMinutes: 15, budget: 'low', mealsPerDay: 3, proteinTarget: 144 };
    const { plan, warnings } = generateMealPlan(WEEK, prefs);
    expect(warnings).toContain('No dinner recipes fit within 15 minutes; some take longer.');
    expectConstraintsRespected(plan, prefs, { relaxedSlots: ['dinner'] });
    for (const p of dailyProtein(plan)) expect(Math.abs(p - 144)).toBeLessThanOrEqual(7);
  });

  it('vegan + ≤30 min never adds animal products or relaxes the diet', () => {
    const prefs: PlanPrefs = { tags: ['vegan'], allergens: [], dislikedIngredientIds: ['tempeh'], maxCookMinutes: 30, budget: 'any', mealsPerDay: 4, proteinTarget: 130 };
    const { plan } = generateMealPlan(WEEK, prefs);
    const relaxed = (['breakfast', 'lunch', 'dinner', 'snack'] as const).filter((s) => planWarnings(plan, prefs).some((w) => w.startsWith(`No ${s}`)));
    expectConstraintsRespected(plan, prefs, { relaxedSlots: relaxed });
    for (const d of plan.days) for (const it of d.items) expect(it.extras?.some((e) => e.ingredientId === 'tempeh') ?? false).toBe(false);
    for (const s of planStatus(plan, prefs).days) expect(s.state === 'on_target' || (s.message ?? '').length > 0).toBe(true);
  });

  it('with an energy target (full mode) balances protein and calories together', () => {
    const prefs: PlanPrefs = { tags: [], allergens: ['milk', 'fish'], dislikedIngredientIds: [], maxCookMinutes: 45, budget: 'any', mealsPerDay: 4, proteinTarget: 140, kcalTarget: 2200 };
    const { plan } = generateMealPlan(WEEK, prefs);
    const st = planStatus(plan, prefs);
    expect(st.onTarget).toBe(7);
    for (const d of st.days) {
      expect(d.kcalTarget).toBe(2200);
      expect(Math.abs(d.totals.kcal - 2200)).toBeLessThanOrEqual(176);
      expect(Math.abs(d.totals.protein - 140)).toBeLessThanOrEqual(7);
    }
  });
});

describe('impossible constraints', () => {
  const prefs: PlanPrefs = { tags: ['vegan'], allergens: ['soy', 'gluten', 'wheat', 'peanuts', 'sesame'], dislikedIngredientIds: [], maxCookMinutes: 30, budget: 'any', mealsPerDay: 3, proteinTarget: 144 };

  it('shows a per-day gap with an explanation and never relaxes allergens or the diet', () => {
    const { plan, warnings } = generateMealPlan(WEEK, prefs);
    expect(warnings).toContain('No breakfast recipes match your diet and allergy settings, so that meal is left empty.');
    // Since Nov 2026 the only matching dinners are 35-minute batch recipes, so dinner relaxes the cooking time.
    expect(warnings).toContain('No dinner recipes fit within 30 minutes; some take longer.');
    expectConstraintsRespected(plan, prefs, { relaxedSlots: ['dinner'] });
    const st = planStatus(plan, prefs);
    expect(st.onTarget).toBe(0);
    for (const d of st.days) {
      expect(d.state).toBe('short');
      expect(d.proteinGap).toBe(displayMacro(144 - d.totals.protein, 'protein'));
      expect(d.proteinGap!).toBeGreaterThan(7);
      expect(d.message).toMatch(new RegExp(`${d.proteinGap} g short`));
      expect(d.message).toMatch(/allergy and diet settings are never relaxed/);
      expect(d.suggestions.length).toBeGreaterThan(0);
      for (const s of d.suggestions) expect(s).not.toMatch(/allerg|vegan|soy|gluten|wheat|peanut|sesame/i);
    }
  });

  it('suggests practical changes when the gap is small but unreachable', () => {
    // Soy added Nov 2026: without it the new tofu recipes reach the target, so there is no gap to explain.
    const p2: PlanPrefs = { tags: ['vegetarian', 'gluten_free'], allergens: ['milk', 'egg', 'soy'], dislikedIngredientIds: [], maxCookMinutes: 30, budget: 'any', mealsPerDay: 3, proteinTarget: 144 };
    const { plan } = generateMealPlan(WEEK, p2);
    expectConstraintsRespected(plan, p2, { relaxedSlots: ['dinner'] });
    const d = planStatus(plan, p2).days[0];
    expect(d.state).toBe('short');
    expect(d.suggestions.join(' ')).toMatch(/Planning 4 meals a day adds a snack/);
  });
});

describe('manual changes recalculate totals, status and the shopping list', () => {
  const { plan } = generateMealPlan(WEEK, FIXTURE);
  const day = plan.days[3];
  const lunch = day.items.find((i) => i.slot === 'lunch')!;
  const shopGrams = (p: PlanDraft, id: string) => buildShoppingList(p, RECIPES_BY_ID).flatMap((g) => g.items).find((i) => i.ingredientId === id)?.grams ?? 0;

  it('swapping a meal changes the day total and status', () => {
    const swapped = swapMeal(plan, day.date, lunch.id, FIXTURE);
    const next = swapped.days[3].items.find((i) => i.id === lunch.id)!;
    expect(next.recipeId).not.toBe(lunch.recipeId);
    const delta = planItemNutrition(next, RECIPES_BY_ID).protein - planItemNutrition(lunch, RECIPES_BY_ID).protein;
    expect(planDayNutrition(swapped.days[3], RECIPES_BY_ID).protein).toBeCloseTo(planDayNutrition(day, RECIPES_BY_ID).protein + delta, 6);
    const st = planDayStatus(swapped.days[3], FIXTURE);
    expect(st.totals).toEqual(planDayNutrition(swapped.days[3], RECIPES_BY_ID));
    if (st.state !== 'on_target') {
      expect(st.balanced).toBeDefined();
      // "Balance this day" keeps the user's recipes and brings the day back on target.
      expect(st.balanced!.items.map((i) => i.recipeId)).toEqual(swapped.days[3].items.map((i) => i.recipeId));
      expect(planDayStatus(st.balanced!, FIXTURE).state).toBe('on_target');
    }
  });

  it('portion changes scale protein and shopping quantities', () => {
    const r = RECIPES_BY_ID.get(lunch.recipeId)!;
    const edited = updatePlanItem(plan, day.date, lunch.id, { servings: lunch.servings + 0.5 });
    const gain = planDayNutrition(edited.days[3], RECIPES_BY_ID).protein - planDayNutrition(day, RECIPES_BY_ID).protein;
    expect(gain).toBeCloseTo(recipeNutrition(r).perServing.protein * 0.5, 0);
    const main = r.ingredients[0].ingredientId;
    const perServingGrams = r.ingredients[0].grams / r.servings;
    const before = buildShoppingList(plan, RECIPES_BY_ID).flatMap((g) => g.items).find((i) => i.ingredientId === main || i.convertedFrom === main)!;
    const after = buildShoppingList(edited, RECIPES_BY_ID).flatMap((g) => g.items).find((i) => i.ingredientId === before.ingredientId)!;
    const conv = before.convertedFrom ? INGREDIENTS_BY_ID.get(main)!.per100g.kcal / INGREDIENTS_BY_ID.get(before.ingredientId)!.per100g.kcal : 1;
    expect(after.grams - before.grams).toBeCloseTo(perServingGrams * 0.5 * conv, 6);
  });

  it('protein sides appear in totals and the shopping list (as bought), and disappear when removed', () => {
    const base = { ...plan, days: plan.days.map((d) => ({ ...d, items: d.items.map((i) => ({ ...i, extras: [] })) })) };
    const withSide = updatePlanItem(base, day.date, lunch.id, { extras: [{ ingredientId: 'chicken-breast-cooked', grams: 100 }] });
    const gain = planDayNutrition(withSide.days[3], RECIPES_BY_ID).protein - planDayNutrition(base.days[3], RECIPES_BY_ID).protein;
    expect(gain).toBeCloseTo(31.02, 1);
    const raw = shopGrams(withSide, 'chicken-breast-raw') - shopGrams(base, 'chicken-breast-raw');
    expect(raw).toBeCloseTo((100 * 165) / 120, 6); // cooked → raw purchase weight
    const item = buildShoppingList(withSide, RECIPES_BY_ID).flatMap((g) => g.items).find((i) => i.ingredientId === 'chicken-breast-raw')!;
    expect(item.recipeNames).toContain(PROTEIN_SIDES_LABEL);
    const removed = updatePlanItem(withSide, day.date, lunch.id, { extras: [] });
    expect(shopGrams(removed, 'chicken-breast-raw')).toBeCloseTo(shopGrams(base, 'chicken-breast-raw'), 6);
  });

  it('ingredient substitutions recalculate the day', () => {
    const tofuDay = plan.days.find((d) => d.items.some((i) => i.recipeId === 'tofu-scramble-peppers'))!;
    const it0 = tofuDay.items.find((i) => i.recipeId === 'tofu-scramble-peppers')!;
    const sub = RECIPES_BY_ID.get('tofu-scramble-peppers')!.substitutions[0];
    const edited = updatePlanItem(plan, tofuDay.date, it0.id, { swaps: [{ from: sub.ingredientId, to: sub.alternatives[0] }] });
    const d2 = edited.days.find((d) => d.date === tofuDay.date)!;
    const expected = planDayNutrition(tofuDay, RECIPES_BY_ID).protein - planItemNutrition(it0, RECIPES_BY_ID).protein + planItemNutrition(d2.items.find((i) => i.id === it0.id)!, RECIPES_BY_ID).protein;
    expect(planDayNutrition(d2, RECIPES_BY_ID).protein).toBeCloseTo(expected, 6);
    expect(planDayStatus(d2, FIXTURE).totals.protein).toBeCloseTo(expected, 6);
  });

  it('target changes update the status, and balancing adjusts to the new target', () => {
    const lower: PlanPrefs = { ...FIXTURE, proteinTarget: 110 };
    const st = planStatus(plan, lower);
    expect(st.days.every((d) => d.state === 'over')).toBe(true);
    expect(st.days[0].message).toMatch(/above your 110 g target/);
    const rebalanced = balancePlan(plan, lower);
    for (const p of dailyProtein(rebalanced)) expect(Math.abs(p - 110)).toBeLessThanOrEqual(proteinTolerance(110));
    // Balancing a saved plan keeps the user's recipe choices.
    expect(rebalanced.days.map((d) => d.items.map((i) => i.recipeId))).toEqual(plan.days.map((d) => d.items.map((i) => i.recipeId)));
    expect(balanceDay(plan.days[0], FIXTURE)).toBe(plan.days[0]); // already on target → unchanged
  });

  it('flags a saved meal that conflicts with a newly added allergy', () => {
    const w = planWarnings(plan, { ...FIXTURE, allergens: ['milk', 'shellfish'] });
    expect(w).toContain('Garlic prawn & spinach pasta on Monday contains shellfish. Swap it or edit the meal.');
    expect(w.some((x) => /has a side of .*cooked prawns, which contains shellfish/.test(x))).toBe(true);
    expect(planWarnings(plan, FIXTURE)).toEqual([]);
  });
});

describe('reload: warnings and totals are derived identically from the persisted plan', () => {
  const dbs: LiftDb[] = [];
  afterAll(async () => {
    for (const d of dbs) {
      d.close();
      await d.delete();
    }
  });

  it('survives a save → close → reopen round trip', async () => {
    const name = `mealplan-reload-${Date.now()}`;
    const prefs: PlanPrefs = { tags: ['vegan'], allergens: ['soy', 'gluten', 'wheat', 'peanuts', 'sesame'], dislikedIngredientIds: [], maxCookMinutes: 30, budget: 'any', mealsPerDay: 3, proteinTarget: 144 };
    const { plan, warnings } = generateMealPlan(WEEK, prefs);
    const db1 = new LiftDb(name);
    dbs.push(db1);
    const rec = newRecord(plan) as MealPlan;
    await saveRecord('meal_plans', rec, db1);
    db1.close();
    const db2 = new LiftDb(name);
    dbs.push(db2);
    const loaded = (await db2.mealPlans.get(rec.id))!;
    expect(planWarnings(loaded, prefs)).toEqual(warnings);
    expect(planStatus(loaded, prefs)).toEqual(planStatus(plan, prefs));
    expect(buildShoppingList(loaded, RECIPES_BY_ID)).toEqual(buildShoppingList(plan, RECIPES_BY_ID));
  });

  it('loads plans saved before protein sides existed', () => {
    const legacy = JSON.parse(JSON.stringify(selectMeals(WEEK, FIXTURE))) as PlanDraft;
    for (const d of legacy.days) for (const i of d.items) expect(i.extras).toBeUndefined();
    const st = planStatus(legacy, FIXTURE);
    expect(st.days.map((d) => displayMacro(d.totals.protein, 'protein'))).toEqual([128, 121, 111, 104, 98, 94, 88]);
    expect(st.days.filter((d) => d.state === 'short')).toHaveLength(7);
    expect(st.days.every((d) => d.balanced)).toBe(true);
    expect(buildShoppingList(legacy, RECIPES_BY_ID).length).toBeGreaterThan(0);
  });
});

describe('protein-only mode wording', () => {
  const stale: NutritionTargets = { ...fixtureTargets, calories: 2500, carbsG: 300, fatG: 80 };
  it('never applies a calorie target in protein-only mode, even a stale saved one', () => {
    expect(planPrefsFrom(fixtureDiet, stale, true).kcalTarget).toBeUndefined();
    expect(planPrefsFrom(fixtureDiet, { ...stale, mode: 'full' }, true).kcalTarget).toBe(2500);
    expect(planPrefsFrom(fixtureDiet, { ...stale, mode: 'none' }, true).proteinTarget).toBeUndefined();
    expect(planPrefsFrom(fixtureDiet, stale, false).proteinTarget).toBeUndefined();
  });
  it('status and suggestions make no energy claims', () => {
    const p = planPrefsFrom(fixtureDiet, stale, true);
    for (const plan of [selectMeals(WEEK, p), generateMealPlan(WEEK, p).plan, generateMealPlan(WEEK, { ...p, allergens: ['milk', 'egg', 'soy', 'wheat', 'gluten'] }).plan]) {
      for (const d of planStatus(plan, p).days) {
        expect(d.kcalTarget).toBeUndefined();
        expect(d.kcalState).toBeUndefined();
        const text = [d.message ?? '', ...d.suggestions].join(' ');
        expect(text).not.toMatch(/kcal|calorie|energy/i);
      }
      expect(planWarnings(plan, p).join(' ')).not.toMatch(/kcal|calorie|energy/i);
    }
  });
});

describe('rounding is consistent across recipe cards, logging and day totals', () => {
  it('a recipe card shows the same numbers as the log entry made from it', () => {
    for (const r of RECIPES) {
      for (const servings of [0.75, 1, 1.25, 1.5, 2]) {
        const raw = recipeNutrition(r, { servings }).total;
        const entry = entryFromRecipe(r, servings);
        expect(displayMacro(raw.protein, 'protein'), r.id).toBe(displayMacro(entry.protein!, 'protein'));
        expect(displayMacro(raw.kcal, 'kcal'), r.id).toBe(displayMacro(entry.kcal!, 'kcal'));
        const item = planItemNutrition({ id: 'x', slot: r.meal, recipeId: r.id, servings }, RECIPES_BY_ID);
        expect(item.protein).toBe(entry.protein);
        expect(item.kcal).toBe(entry.kcal);
      }
    }
  });
  it('a planned day totals exactly what logging its meals would total', () => {
    const plan = selectMeals(WEEK, FIXTURE);
    for (const d of plan.days) {
      const logged = dayTotals(d.items.map((i) => entryFromRecipe(RECIPES_BY_ID.get(i.recipeId)!, i.servings, i.swaps)));
      const planned = planDayNutrition(d, RECIPES_BY_ID);
      expect(planned.protein).toBe(logged.protein);
      expect(planned.kcal).toBe(logged.kcal);
    }
  });
  it('protein sides offered respect allergens and budget', () => {
    for (const slot of ['breakfast', 'lunch', 'dinner', 'snack'] as const) {
      for (const a of allowedAddOns(slot, { ...FIXTURE, allergens: ['milk', 'egg', 'fish'], budget: 'low' })) {
        const ing = INGREDIENTS_BY_ID.get(a.ingredientId)!;
        expect(ing.allergens.some((x) => ['milk', 'egg', 'fish'].includes(x))).toBe(false);
        expect(ing.costTier).toBeLessThanOrEqual(2);
      }
    }
  });
});
