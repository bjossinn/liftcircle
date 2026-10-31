/**
 * Coverage, balance and variety of the whole recipe catalogue (pack 3 brought it to ~270 recipes). Everything is derived
 * from ingredient data: protein groups, diet tags and protein per serving. A recipe "features" a protein group when the
 * group is its main protein or supplies at least a quarter of its protein (featuredProteinGroups).
 */
import { describe, expect, it } from 'vitest';
import { RECIPES } from '@/data/recipes';
import { INGREDIENTS } from '@/data/ingredients';
import { PROTEIN_GROUPS, isSimpleRecipe, recipeDietTags, recipeProteinGroups, satisfiesTag } from '@/domain/nutrition/recipes';
import type { DietTag, MealSlot, ProteinGroup, Recipe } from '@/domain/types';
import { dupKey, featured, isHighProtein, mainGroup, similarity } from './catalogHelpers';

const has = (r: Recipe, t: DietTag) => satisfiesTag(recipeDietTags(r), t);
const count = (f: (r: Recipe) => boolean) => RECIPES.filter(f).length;
const share = (n: number) => n / RECIPES.length;

/** Minimum recipes featuring each group: breakfast + snack, lunch, dinner. */
const STANDARD = { bs: 4, lunch: 6, dinner: 8 };
/**
 * Documented exceptions (lower minimums):
 * - turkey, lamb, other shellfish: fewer everyday supermarket options; turkey/lamb rarely suit breakfast or snacks.
 * - prawns: capped at ~4 % of the catalogue (below), which leaves room for at most ~10 recipes in total.
 * - beef and white fish at breakfast/snack: only a couple make sense (a hash, a kedgeree-style bowl).
 * - whey and plant protein powder: shakes, oats, pancakes and snacks only, never lunch or dinner.
 */
const MINIMUMS: Record<ProteinGroup, { bs: number; lunch: number; dinner: number }> = {
  chicken: STANDARD,
  turkey: { bs: 2, lunch: 4, dinner: 5 },
  beef: { bs: 2, lunch: 6, dinner: 8 },
  pork: STANDARD,
  lamb: { bs: 0, lunch: 4, dinner: 5 },
  white_fish: { bs: 1, lunch: 6, dinner: 8 },
  oily_fish: STANDARD,
  tuna: STANDARD,
  prawns: { bs: 1, lunch: 3, dinner: 5 },
  shellfish: { bs: 0, lunch: 3, dinner: 4 },
  eggs: STANDARD,
  dairy: STANDARD,
  tofu_tempeh: STANDARD,
  beans_lentils: STANDARD,
  chickpeas: STANDARD,
  whey: { bs: 6, lunch: 0, dinner: 0 },
  plant_protein: { bs: 4, lunch: 0, dinner: 0 },
};

describe('recipe catalogue coverage', () => {
  it('has about 3× the 84 recipes of 0.8 (target ~250)', () => {
    expect(RECIPES.length).toBeGreaterThanOrEqual(240);
    expect(RECIPES.length).toBeLessThanOrEqual(290);
  });

  it.each(PROTEIN_GROUPS)('%s: enough breakfasts/snacks, lunches and dinners', (g) => {
    const n = (meals: MealSlot[]) => count((r) => meals.includes(r.meal) && featured(r).includes(g));
    const min = MINIMUMS[g];
    expect(n(['breakfast', 'snack']), `${g} breakfast/snack`).toBeGreaterThanOrEqual(min.bs);
    expect(n(['lunch']), `${g} lunch`).toBeGreaterThanOrEqual(min.lunch);
    expect(n(['dinner']), `${g} dinner`).toBeGreaterThanOrEqual(min.dinner);
  });

  it('balance: no protein group is the main protein of more than 15 % of recipes; prawns appear in at most 4 %', () => {
    for (const g of PROTEIN_GROUPS) expect(share(count((r) => mainGroup(r) === g)), g).toBeLessThanOrEqual(0.15);
    expect(share(count((r) => recipeProteinGroups(r).includes('prawns')))).toBeLessThanOrEqual(0.04);
  });

  it('meal types: ~25 % breakfast, ~25 % lunch, ~35 % dinner, ~15 % snack (± 5 points)', () => {
    const pct = (m: MealSlot) => share(count((r) => r.meal === m));
    expect(pct('breakfast')).toBeGreaterThanOrEqual(0.2);
    expect(pct('breakfast')).toBeLessThanOrEqual(0.3);
    expect(pct('lunch')).toBeGreaterThanOrEqual(0.2);
    expect(pct('lunch')).toBeLessThanOrEqual(0.3);
    expect(pct('dinner')).toBeGreaterThanOrEqual(0.3);
    expect(pct('dinner')).toBeLessThanOrEqual(0.4);
    expect(pct('snack')).toBeGreaterThanOrEqual(0.1);
    expect(pct('snack')).toBeLessThanOrEqual(0.2);
  });

  it('diets, protein, speed and batch cooking', () => {
    expect(count((r) => has(r, 'vegetarian'))).toBeGreaterThanOrEqual(50);
    expect(count((r) => has(r, 'vegan'))).toBeGreaterThanOrEqual(30);
    expect(count((r) => has(r, 'dairy_free'))).toBeGreaterThanOrEqual(50);
    expect(count((r) => has(r, 'gluten_free'))).toBeGreaterThanOrEqual(50);
    expect(count(isHighProtein)).toBeGreaterThanOrEqual(80);
    expect(count((r) => r.cookMinutes === 0 || r.prepMinutes + r.cookMinutes <= 10)).toBeGreaterThanOrEqual(40);
    expect(count((r) => r.servings === 4)).toBeGreaterThanOrEqual(20);
  });

  it('every recipe added in pack 3 is simple (≤ 8 main ingredients, ≤ 20 min hands-on, 3–6 steps)', () => {
    for (const r of RECIPES.slice(84)) {
      expect(isSimpleRecipe(r), r.id).toBe(true);
      expect(r.steps.length, r.id).toBeGreaterThanOrEqual(3);
    }
  });

  it('every ingredient carries allergen, diet and (for protein foods) protein-group flags', () => {
    for (const i of INGREDIENTS) {
      expect(Array.isArray(i.allergens), i.id).toBe(true);
      expect(Object.keys(i.diet).sort(), i.id).toEqual(['dairyFree', 'glutenFree', 'pescatarian', 'vegan', 'vegetarian']);
      if (i.category === 'protein') expect(i.proteinGroup, i.id).toBeTruthy();
    }
  });
});

describe('variety', () => {
  it('no near-duplicates: same main protein food + featured groups + base + method + main fruit/veg', () => {
    const seen = new Map<string, string>();
    const dups: string[] = [];
    for (const r of RECIPES) {
      const k = dupKey(r);
      if (seen.has(k)) dups.push(`${seen.get(k)} ~ ${r.id} (${k})`);
      else seen.set(k, r.id);
    }
    expect(dups).toEqual([]);
  });

  it('no two recipes have very similar ingredient lists (≥ 80 % the same)', () => {
    const close: string[] = [];
    for (let i = 0; i < RECIPES.length; i++)
      for (let j = i + 1; j < RECIPES.length; j++) {
        const s = similarity(RECIPES[i], RECIPES[j]);
        if (s >= 0.8) close.push(`${RECIPES[i].id} ~ ${RECIPES[j].id} (${Math.round(s * 100)}%)`);
      }
    expect(close).toEqual([]);
  });
});
