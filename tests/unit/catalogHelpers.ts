/**
 * Helpers for the recipe catalogue checks (coverage, balance and near-duplicates). Everything is derived from the data:
 * protein groups from ingredients, the method from the steps, the base from the ingredient list.
 */
import { INGREDIENTS_BY_ID } from '@/data/ingredients';
import { featuredProteinGroups, mainProteinGroup, recipeNutrition } from '@/domain/nutrition/recipes';
import type { Recipe } from '@/domain/types';

export type Method = 'no-cook' | 'blend' | 'oven' | 'simmer' | 'pan' | 'other';

/** Cooking method from the steps: blended/no-cook, then oven, then simmered, then pan. */
export function methodOf(r: Recipe): Method {
  const text = r.steps.join(' ').toLowerCase();
  if (/\bblend/.test(text)) return 'blend';
  if (r.cookMinutes === 0) return 'no-cook';
  if (/\b(oven|bake|baking|roast|traybake|grill)/.test(text)) return 'oven';
  if (/\b(simmer|stew|poach|soup)/.test(text)) return 'simmer';
  if (/\b(fry|frying|fried|pan|skillet|wok|sear|griddle|toast)/.test(text)) return 'pan';
  return 'other';
}

/**
 * The recipe's base: its heaviest grain or starch; without one, its heaviest fruit; otherwise its heaviest vegetable or
 * legume that isn't the protein food itself.
 */
const JUICES = ['lemon-juice', 'lime-juice'];
export function baseOf(r: Recipe): string {
  const items = r.ingredients
    .filter((i) => !i.optional)
    .map((i) => ({ i, ing: INGREDIENTS_BY_ID.get(i.ingredientId)! }))
    .filter(({ ing }) => ing && !ing.proteinGroup && ing.category !== 'condiment' && ing.category !== 'fat' && !JUICES.includes(ing.id));
  for (const cats of [['grain'], ['fruit'], ['vegetable', 'legume', 'nut_seed', 'dairy']]) {
    const best = items.filter(({ ing }) => cats.includes(ing.category)).sort((a, b) => b.i.grams - a.i.grams)[0];
    if (best) return best.ing.id;
  }
  return 'none';
}

export const mainGroup = (r: Recipe) => mainProteinGroup(r) ?? 'none';
/** The single ingredient supplying the most protein (tofu and tempeh are different proteins, though one group). */
export function mainProteinFood(r: Recipe): string {
  const best = r.ingredients
    .filter((i) => !i.optional)
    .map((i) => ({ i, ing: INGREDIENTS_BY_ID.get(i.ingredientId)! }))
    .filter(({ ing }) => ing?.proteinGroup)
    .sort((a, b) => (b.ing.per100g.protein * b.i.grams) - (a.ing.per100g.protein * a.i.grams))[0];
  return best?.ing.id.replace(/-(raw|cooked|dry)$/, '') ?? 'none';
}
export const featured = (r: Recipe) => featuredProteinGroups(r);
/** The heaviest fruit or vegetable that isn't the base: what tells two otherwise similar dishes apart (banana vs berry oats). */
export function accentOf(r: Recipe): string {
  const base = baseOf(r);
  const best = r.ingredients
    .filter((i) => !i.optional && i.ingredientId !== base)
    .map((i) => ({ i, ing: INGREDIENTS_BY_ID.get(i.ingredientId)! }))
    .filter(({ ing }) => ing && !ing.proteinGroup && (ing.category === 'fruit' || ing.category === 'vegetable') && !['garlic', 'onion', 'lemon-juice', 'lime-juice', 'ginger'].includes(ing.id))
    .sort((a, b) => b.i.grams - a.i.grams)[0];
  return best?.ing.id ?? 'none';
}
/** Near-duplicate key: same main protein food (and other featured protein groups), same base, same method and same main fruit or vegetable. */
export const dupKey = (r: Recipe) => `${mainProteinFood(r)}${featured(r).filter((g) => g !== mainGroup(r)).map((g) => "&" + g).join("")} + ${baseOf(r)} + ${methodOf(r)} + ${accentOf(r)}`;

/** Jaccard similarity of the non-seasoning ingredient sets. */
export function similarity(a: Recipe, b: Recipe): number {
  const set = (r: Recipe) =>
    new Set(r.ingredients.map((i) => i.ingredientId).filter((id) => INGREDIENTS_BY_ID.get(id)?.category !== 'condiment' && id !== 'olive-oil' && id !== 'rapeseed-oil'));
  const x = set(a);
  const y = set(b);
  const inter = [...x].filter((id) => y.has(id)).length;
  return inter / (x.size + y.size - inter || 1);
}

export const proteinPerServing = (r: Recipe) => recipeNutrition(r).perServing.protein;
/** Meals ≥ 30 g protein per serving, snacks ≥ 15 g. */
export const isHighProtein = (r: Recipe) => proteinPerServing(r) >= (r.meal === 'snack' ? 15 : 30);
