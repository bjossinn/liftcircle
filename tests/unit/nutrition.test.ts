import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_FACTORS, allocateMacros, computeNutritionTargets, mifflinStJeor, proteinTarget, reconcileMacros, type TargetInput,
} from '@/domain/nutrition/targets';
import {
  recipeAllergens, recipeDietTags, recipeNutrition, resolveIngredients, scaleRecipe, satisfiesTag, substitutionRatio,
} from '@/domain/nutrition/recipes';
import { buildShoppingList, generateMealPlan, planDayNutrition, swapMeal, type PlanPrefs } from '@/domain/nutrition/mealplan';
import { dayTotals, entryFromCustom, proteinDistribution, proteinGapSuggestions, remainingVsTargets, rescaleEntry } from '@/domain/nutrition/log';
import { INGREDIENTS, INGREDIENTS_BY_ID } from '@/data/ingredients';
import { RECIPES, RECIPES_BY_ID } from '@/data/recipes';
import type { NutritionTargets, Recipe } from '@/domain/types';

const base: TargetInput = { activityLevel: 'moderate', goal: 'general_fitness', mode: 'full', mealsPerDay: 3, age: 30, weightKg: 80, heightCm: 180, sexParam: 'male' };

describe('protein', () => {
  it('100 kg × 1.8 g/kg = 180 g', () => {
    expect(proteinTarget(100, 1.8)).toBe(180);
    expect(proteinTarget(100)).toBe(180);
    expect(proteinTarget(72.5, 1.6)).toBe(116);
  });
  it('uses the selected reference weight and explains it', () => {
    const r = computeNutritionTargets({ ...base, mode: 'protein_only', weightKg: 110, referenceWeightKg: 100, referenceWeightSource: 'goal' });
    expect(r.targets.proteinG).toBe(180);
    expect(r.targets.referenceWeightKg).toBe(100);
    expect(r.targets.referenceWeightSource).toBe('goal');
    expect(r.explanation.join(' ')).toContain('100 kg × 1.8 g/kg = 180 g');
    expect(r.explanation.join(' ')).toContain('goal weight you chose');
    expect(r.targets.calories).toBeUndefined();
  });
  it('defaults to current weight and warns above 2.2 g/kg', () => {
    const r = computeNutritionTargets({ ...base, mode: 'protein_only', weightKg: 100, proteinPerKg: 2.5 });
    expect(r.targets.proteinG).toBe(250);
    expect(r.targets.referenceWeightSource).toBe('current');
    expect(r.warnings.join(' ')).toMatch(/isn't automatically better/);
  });
  it('explains missing weight instead of inventing one', () => {
    const r = computeNutritionTargets({ ...base, mode: 'protein_only', weightKg: undefined });
    expect(r.targets.proteinG).toBeUndefined();
    expect(r.warnings.join(' ')).toMatch(/Add your current weight/);
  });
});

describe('Mifflin–St Jeor', () => {
  it('male: 80 kg, 180 cm, 30 y = 1780', () => {
    expect(mifflinStJeor({ weightKg: 80, heightCm: 180, age: 30, sex: 'male' })).toBe(1780);
  });
  it('female: 60 kg, 165 cm, 30 y = 1320.25', () => {
    expect(mifflinStJeor({ weightKg: 60, heightCm: 165, age: 30, sex: 'female' })).toBe(1320.25);
  });
});

describe('energy and macros', () => {
  it('applies the activity factor separately from resting energy', () => {
    expect(ACTIVITY_FACTORS).toEqual({ sedentary: 1.2, light: 1.375, moderate: 1.55, very: 1.725, extra: 1.9 });
    const r = computeNutritionTargets(base);
    expect(r.targets.restingKcal).toBe(1780);
    expect(r.targets.activityFactor).toBe(1.55);
    expect(r.targets.goalAdjustPct).toBe(0);
    expect(r.targets.calories).toBe(Math.round((1780 * 1.55) / 10) * 10); // 2760
    const custom = computeNutritionTargets({ ...base, activityFactor: 1.3 });
    expect(custom.targets.calories).toBe(Math.round((1780 * 1.3) / 10) * 10);
  });
  it('applies goal adjustments: +5 % muscle gain, −10 % fat loss, editable', () => {
    const m = 1780 * 1.55;
    expect(computeNutritionTargets({ ...base, goal: 'build_muscle' }).targets.calories).toBe(Math.round((m * 1.05) / 10) * 10);
    expect(computeNutritionTargets({ ...base, goal: 'lose_fat' }).targets.calories).toBe(Math.round((m * 0.9) / 10) * 10);
    expect(computeNutritionTargets({ ...base, goal: 'lose_fat', goalAdjustPct: -5 }).targets.calories).toBe(Math.round((m * 0.95) / 10) * 10);
    // aggressive cuts are clamped
    const agg = computeNutritionTargets({ ...base, goalAdjustPct: -40 });
    expect(agg.targets.goalAdjustPct).toBe(-20);
  });
  it('macro energy reconciles with calories (4/4/9) within rounding', () => {
    const t = computeNutritionTargets(base).targets;
    expect(t.proteinG).toBe(144);
    const energy = t.proteinG! * 4 + t.carbsG! * 4 + t.fatG! * 9;
    expect(Math.abs(energy - t.calories!)).toBeLessThanOrEqual(2);
    expect(t.fatG).toBe(Math.round((t.calories! * 0.275) / 9));
    expect(reconcileMacros({ calories: t.calories, proteinG: t.proteinG, carbsG: t.carbsG, fatG: t.fatG }).ok).toBe(true);
  });
  it('flags incompatible targets instead of negative carbs', () => {
    const s = allocateMacros(1200, 250, 100);
    expect(s.incompatible).toBe(true);
    expect(s.carbsG).toBeNull();
    const r = computeNutritionTargets({ ...base, weightKg: 60, heightCm: 150, age: 60, sexParam: 'female', activityLevel: 'sedentary', goal: 'lose_fat', proteinPerKg: 3, referenceWeightKg: 120, referenceWeightSource: 'custom' });
    expect(r.targets.carbsG).toBeUndefined();
    expect(r.warnings.join(' ')).toMatch(/incompatible/);
    const bad = reconcileMacros({ calories: 2000, proteinG: 150, carbsG: 300, fatG: 90 });
    expect(bad.ok).toBe(false);
  });
  it('explains missing inputs for calories and still gives protein', () => {
    const r = computeNutritionTargets({ ...base, heightCm: undefined, sexParam: undefined });
    expect(r.targets.calories).toBeUndefined();
    expect(r.targets.proteinG).toBe(144);
    expect(r.warnings.join(' ')).toMatch(/height/);
  });
});

describe('safety rules', () => {
  it('under 18 → no calorie or weight-loss prescription', () => {
    const r = computeNutritionTargets({ ...base, age: 16, goal: 'lose_fat' });
    expect(r.targets.autoDisabledReason).toBe('under_18');
    expect(r.targets.calories).toBeUndefined();
    expect(r.targets.goalAdjustPct).toBeUndefined();
    expect(r.targets.mode).toBe('manual');
  });
  it('individualized nutrition → nothing generated', () => {
    const r = computeNutritionTargets({ ...base, individualizedNutrition: true });
    expect(r.targets.autoDisabledReason).toBe('individualized');
    expect(r.targets.proteinG).toBeUndefined();
    expect(r.targets.calories).toBeUndefined();
  });
});

describe('recipes', () => {
  const bowl = RECIPES_BY_ID.get('skyr-berry-oat-bowl')!;
  it('computes nutrition from ingredients', () => {
    let kcal = 0;
    let protein = 0;
    for (const ri of bowl.ingredients) {
      const ing = INGREDIENTS_BY_ID.get(ri.ingredientId)!;
      kcal += (ing.per100g.kcal * ri.grams) / 100;
      protein += (ing.per100g.protein * ri.grams) / 100;
    }
    const n = recipeNutrition(bowl);
    expect(n.perServing.kcal).toBeCloseTo(kcal / bowl.servings, 6);
    expect(n.perServing.protein).toBeCloseTo(protein / bowl.servings, 6);
    expect(n.missingIds).toEqual([]);
  });
  it('2× servings doubles grams; per-serving unchanged', () => {
    const r = RECIPES_BY_ID.get('chicken-rice-broccoli-bowl')!;
    const s1 = scaleRecipe(r, r.servings);
    const s2 = scaleRecipe(r, r.servings * 2);
    s2.ingredients.forEach((ing, i) => expect(ing.scaledGrams).toBeCloseTo(s1.ingredients[i].scaledGrams * 2, 6));
    const n1 = recipeNutrition(r);
    const n2 = recipeNutrition(r, { servings: r.servings * 2 });
    expect(n2.perServing.kcal).toBeCloseTo(n1.perServing.kcal, 6);
    expect(n2.total.kcal).toBeCloseTo(n1.total.kcal * 2, 6);
  });
  it('recalculates nutrition and allergens after a substitution', () => {
    const swaps = [{ from: 'skyr-plain', to: 'soy-yogurt' }];
    const before = recipeNutrition(bowl);
    const after = recipeNutrition(bowl, { swaps });
    const skyr = INGREDIENTS_BY_ID.get('skyr-plain')!;
    const soy = INGREDIENTS_BY_ID.get('soy-yogurt')!;
    expect(after.perServing.protein).toBeCloseTo(before.perServing.protein + (2 * (soy.per100g.protein - skyr.per100g.protein)), 6);
    expect(recipeAllergens(bowl)).toContain('milk');
    expect(recipeAllergens(bowl, swaps)).not.toContain('milk');
    expect(recipeAllergens(bowl, swaps)).toContain('soy');
    expect(satisfiesTag(recipeDietTags(bowl, swaps), 'vegan')).toBe(false); // honey
  });
  it('uses ratios when forms differ (raw mince → dry lentils)', () => {
    const chilli = RECIPES_BY_ID.get('beef-bean-chilli')!;
    expect(substitutionRatio('beef-mince-10-raw', 'lentils-dry')).toBe(0.4);
    const res = resolveIngredients(chilli, [{ from: 'beef-mince-10-raw', to: 'lentils-dry' }]);
    expect(res[0].grams).toBe(160);
    expect(recipeDietTags(chilli, [{ from: 'beef-mince-10-raw', to: 'lentils-dry' }])).toContain('vegan');
  });
  it('derives allergens and diets from ingredients', () => {
    expect(recipeAllergens(RECIPES_BY_ID.get('garlic-prawn-pasta')!)).toEqual(expect.arrayContaining(['shellfish', 'wheat', 'gluten']));
    expect(recipeAllergens(RECIPES_BY_ID.get('egg-hummus-rye')!)).toEqual(expect.arrayContaining(['egg', 'sesame']));
    expect(recipeDietTags(RECIPES_BY_ID.get('red-lentil-soup')!)).toEqual(expect.arrayContaining(['vegan', 'dairy_free', 'gluten_free']));
    expect(INGREDIENTS_BY_ID.get('skyr-plain')!.allergens).toContain('milk');
    expect(INGREDIENTS_BY_ID.get('tofu-firm')!.allergens).toContain('soy');
    expect(INGREDIENTS_BY_ID.get('rye-bread')!.allergens).toEqual(expect.arrayContaining(['wheat', 'gluten']));
  });
});

describe('meal plan & shopping list', () => {
  const prefs: PlanPrefs = { tags: [], allergens: ['milk', 'fish'], dislikedIngredientIds: [], maxCookMinutes: 45, budget: 'any', mealsPerDay: 4, proteinTarget: 140, kcalTarget: 2200 };
  it('is deterministic and excludes allergens', () => {
    const a = generateMealPlan('2026-10-26', prefs);
    const b = generateMealPlan('2026-10-26', prefs);
    expect(a).toEqual(b);
    expect(a.plan.days).toHaveLength(7);
    for (const d of a.plan.days) {
      expect(d.items).toHaveLength(4);
      for (const it of d.items) {
        const al = recipeAllergens(RECIPES_BY_ID.get(it.recipeId)!);
        expect(al).not.toContain('milk');
        expect(al).not.toContain('fish');
      }
    }
  });
  it('respects diet tags and cook time', () => {
    const { plan } = generateMealPlan('2026-10-26', { ...prefs, allergens: [], tags: ['vegan'], maxCookMinutes: 30 });
    for (const d of plan.days)
      for (const it of d.items) {
        const r = RECIPES_BY_ID.get(it.recipeId)!;
        expect(recipeDietTags(r)).toContain('vegan');
        expect(r.prepMinutes + r.cookMinutes).toBeLessThanOrEqual(30);
      }
  });
  it('swaps a meal to a different suitable recipe', () => {
    const { plan } = generateMealPlan('2026-10-26', prefs);
    const day = plan.days[0];
    const item = day.items.find((i) => i.slot === 'dinner')!;
    const swapped = swapMeal(plan, day.date, item.id, prefs);
    const next = swapped.days[0].items.find((i) => i.id === item.id)!;
    expect(next.recipeId).not.toBe(item.recipeId);
    expect(RECIPES_BY_ID.get(next.recipeId)!.meal).toBe('dinner');
    expect(recipeAllergens(RECIPES_BY_ID.get(next.recipeId)!)).not.toContain('fish');
  });
  it('aggregates the shopping list by ingredient with grams summed', () => {
    const r: Recipe = RECIPES_BY_ID.get('chicken-rice-broccoli-bowl')!;
    const plan = {
      weekStart: '2026-10-26',
      shoppingChecked: [],
      days: [
        { date: '2026-10-26', items: [{ id: 'a', slot: 'lunch' as const, recipeId: r.id, servings: 1 }] },
        { date: '2026-10-27', items: [{ id: 'b', slot: 'lunch' as const, recipeId: r.id, servings: 2 }] },
      ],
    };
    const groups = buildShoppingList(plan, RECIPES_BY_ID);
    const items = groups.flatMap((g) => g.items);
    const chicken = items.find((i) => i.ingredientId === 'chicken-breast-raw')!;
    expect(chicken.grams).toBeCloseTo(150 + 300, 6);
    const broccoli = items.find((i) => i.ingredientId === 'broccoli')!;
    expect(broccoli.grams).toBeCloseTo(450, 6);
    expect(groups.find((g) => g.category === 'protein')!.items.map((i) => i.ingredientId)).toContain('chicken-breast-raw');
    expect(new Set(items.map((i) => i.ingredientId)).size).toBe(items.length);
    const day = planDayNutrition(plan.days[1], RECIPES_BY_ID);
    // Plan totals use the stored precision (kcal whole, grams 0.1), same as a food-log entry.
    expect(Math.abs(day.kcal - recipeNutrition(r, { servings: 2 }).total.kcal)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(day.protein - recipeNutrition(r, { servings: 2 }).total.protein)).toBeLessThanOrEqual(0.05);
  });
  it('converts cooked ingredients to the purchase form', () => {
    const r: Recipe = { id: 'x', name: 'X', meal: 'lunch', servings: 1, prepMinutes: 1, cookMinutes: 0, steps: ['a'], substitutions: [], ingredients: [{ ingredientId: 'rice-white-cooked', grams: 365 }] };
    const groups = buildShoppingList({ weekStart: '2026-10-26', shoppingChecked: [], days: [{ date: '2026-10-26', items: [{ id: 'a', slot: 'lunch', recipeId: 'x', servings: 1 }] }] }, new Map([['x', r]]));
    const item = groups[0].items[0];
    expect(item.ingredientId).toBe('rice-white-dry');
    expect(item.grams).toBeCloseTo(130, 6);
  });
});

describe('food log', () => {
  const targets: NutritionTargets = { mode: 'full', proteinG: 150, proteinPerKg: 1.8, calories: 2400, carbsG: 280, fatG: 75, mealsPerDay: 3, updatedAt: 0 };
  it('treats missing values as unknown, not zero', () => {
    const t = dayTotals([
      { kcal: 500, protein: 30, carbs: 50, fat: 20 },
      { kcal: 300, protein: undefined, carbs: undefined, fat: undefined },
      { kcal: undefined, protein: 25, carbs: undefined, fat: undefined },
    ]);
    expect(t.kcal).toBe(800);
    expect(t.protein).toBe(55);
    expect(t.entries).toBe(3);
    expect(t.missing).toEqual({ kcal: 1, protein: 1, carbs: 2, fat: 2 });
    const rows = remainingVsTargets(t, targets);
    const p = rows.find((r) => r.key === 'protein')!;
    expect(p.remaining).toBe(95);
    expect(p.partial).toBe(true);
    expect(remainingVsTargets(dayTotals([]), { ...targets, mode: 'protein_only' }).find((r) => r.key === 'kcal')!.target).toBeUndefined();
  });
  it('keeps unknown custom-food macros unknown when scaling', () => {
    const e = entryFromCustom({ id: 'c', name: 'Bar', per: { amount: 1, unit: 'serving' }, macros: { kcal: 200, protein: 20 } }, 2);
    expect(e.kcal).toBe(400);
    expect(e.protein).toBe(40);
    expect(e.carbs).toBeUndefined();
    expect(rescaleEntry(e, 0.5).fat).toBeUndefined();
  });
  it('distributes protein across meals', () => {
    expect(proteinDistribution(180, 3)).toEqual([60, 60, 60]);
    expect(proteinDistribution(145, 4).reduce((a, b) => a + b, 0)).toBe(145);
  });
  it('suggests foods that respect allergies to close a protein gap', () => {
    const s = proteinGapSuggestions(40, { allergens: ['milk'], tags: ['vegetarian'] });
    expect(s.length).toBeGreaterThan(0);
    for (const x of s) {
      if (x.kind === 'food') {
        const ing = INGREDIENTS_BY_ID.get(x.id)!;
        expect(ing.allergens).not.toContain('milk');
        expect(ing.diet.vegetarian).toBe(true);
      } else {
        expect(recipeAllergens(RECIPES_BY_ID.get(x.id)!)).not.toContain('milk');
      }
      expect(x.protein).toBeGreaterThan(0);
    }
    expect(proteinGapSuggestions(0)).toEqual([]);
  });
});

describe('data integrity', () => {
  it('has 275 complete recipes with resolvable ingredients', () => {
    expect(RECIPES).toHaveLength(275);
    expect(new Set(RECIPES.map((r) => r.id)).size).toBe(275);
    const counts = { breakfast: 0, lunch: 0, dinner: 0, snack: 0 };
    let veg = 0;
    let df = 0;
    for (const r of RECIPES) {
      counts[r.meal]++;
      expect(r.steps.length).toBeGreaterThan(0);
      expect(r.ingredients.length).toBeGreaterThan(1);
      expect(r.servings).toBeGreaterThan(0);
      for (const ri of r.ingredients) {
        expect(INGREDIENTS_BY_ID.has(ri.ingredientId), `${r.id}: ${ri.ingredientId}`).toBe(true);
        expect(ri.grams).toBeGreaterThan(0);
      }
      for (const s of r.substitutions) {
        expect(r.ingredients.some((i) => i.ingredientId === s.ingredientId), `${r.id} sub ${s.ingredientId}`).toBe(true);
        s.alternatives.forEach((a) => expect(INGREDIENTS_BY_ID.has(a), `${r.id} alt ${a}`).toBe(true));
      }
      const tags = recipeDietTags(r);
      if (satisfiesTag(tags, 'vegetarian')) veg++;
      if (tags.includes('dairy_free')) df++;
    }
    expect(counts).toEqual({ breakfast: 59, lunch: 75, dinner: 101, snack: 40 });
    expect(veg).toBeGreaterThanOrEqual(8);
    expect(df).toBeGreaterThanOrEqual(8);
  });
  it('ingredients have sane per-100 g values that roughly reconcile (Atwater)', () => {
    expect(INGREDIENTS.length).toBeGreaterThanOrEqual(55);
    expect(new Set(INGREDIENTS.map((i) => i.id)).size).toBe(INGREDIENTS.length);
    for (const i of INGREDIENTS) {
      const { kcal, protein, carbs, fat } = i.per100g;
      expect(protein + carbs + fat, i.id).toBeLessThanOrEqual(101);
      if (i.id === 'spices') continue;
      const atwater = protein * 4 + carbs * 4 + fat * 9;
      // Fibre-rich foods (crispbread, chia, cocoa) sit below 4/4/9 because fibre yields little energy, so 4/4/9 on
      // available carbohydrate (carbs − fibre) is accepted too.
      // Low-energy foods (lemon juice, vegetables) use food-specific factors, so allow a small absolute gap.
      const near = (a: number) => Math.abs(a - kcal) <= 15 || Math.abs(a - kcal) / kcal < 0.3;
      const ok = near(atwater) || near(atwater - (i.per100g.fiber ?? 0) * 4);
      expect(ok, `${i.id}: ${kcal} kcal vs 4/4/9 ${Math.round(atwater)}`).toBe(true);
      expect(i.source.length).toBeGreaterThan(10);
    }
  });
});
