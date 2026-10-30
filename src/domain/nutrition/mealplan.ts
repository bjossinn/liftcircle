/**
 * Deterministic weekly meal plans and aggregated shopping lists.
 * The planner (selection, balancing, status, edits) lives in supabase/functions/_shared/nutrition/mealplan.ts so the
 * app and the ai-coach function build identical plans; this module re-exports it and adds the app-only shopping list.
 */
import type { ID, Ingredient, Recipe } from '@/domain/types';
import { INGREDIENTS_BY_ID, INGREDIENT_CATEGORY_LABELS, PURCHASE_FORM } from '@/data/ingredients';
import { formatGrams, friendlyAmount, resolveIngredients, type IngredientIndex, type Swap } from './recipes';
import type { PlanDraft } from '../../../supabase/functions/_shared/nutrition/mealplan';

export * from '../../../supabase/functions/_shared/nutrition/mealplan';

/* ------------------------------------------------------------ shopping list */
export interface ShoppingItem {
  ingredientId: ID;
  name: string;
  grams: number;
  display: string;
  recipeNames: string[];
  /** Converted from a cooked form to what you buy (e.g. cooked rice → dry rice). */
  convertedFrom?: ID;
}
export interface ShoppingGroup {
  category: Ingredient['category'];
  label: string;
  items: ShoppingItem[];
}

const CATEGORY_ORDER: Ingredient['category'][] = ['vegetable', 'fruit', 'protein', 'dairy', 'legume', 'grain', 'nut_seed', 'fat', 'condiment', 'other'];
export const PROTEIN_SIDES_LABEL = 'Protein sides';

/** Aggregate a plan's ingredients (recipes at their planned servings, plus protein sides) by purchase ingredient. */
export function buildShoppingList(plan: PlanDraft, recipesById: Map<ID, Recipe>, byId: IngredientIndex = INGREDIENTS_BY_ID): ShoppingGroup[] {
  const acc = new Map<ID, { grams: number; recipes: Set<string>; convertedFrom?: ID }>();
  const add = (ingredient: Ingredient, gramsIn: number, source: string) => {
    let id = ingredient.id;
    let grams = gramsIn;
    let convertedFrom: ID | undefined;
    const buy = PURCHASE_FORM[id];
    const buyIng = buy ? byId.get(buy) : undefined;
    if (buy && buyIng && buyIng.per100g.kcal > 0) {
      grams = grams * (ingredient.per100g.kcal / buyIng.per100g.kcal);
      convertedFrom = id;
      id = buy;
    }
    const cur = acc.get(id) ?? { grams: 0, recipes: new Set<string>() };
    cur.grams += grams;
    cur.recipes.add(source);
    if (convertedFrom) cur.convertedFrom = convertedFrom;
    acc.set(id, cur);
  };
  for (const day of plan.days) {
    for (const it of day.items) {
      const recipe = recipesById.get(it.recipeId);
      if (recipe) {
        const factor = it.servings / recipe.servings;
        for (const r of resolveIngredients(recipe, it.swaps as Swap[] | undefined, byId)) if (r.ingredient) add(r.ingredient, r.grams * factor, recipe.name);
      }
      for (const e of it.extras ?? []) {
        const ing = byId.get(e.ingredientId);
        if (ing && e.grams > 0) add(ing, e.grams, PROTEIN_SIDES_LABEL);
      }
    }
  }
  const groups = new Map<Ingredient['category'], ShoppingItem[]>();
  for (const [id, v] of acc) {
    const ing = byId.get(id)!;
    const friendly = ing.id === 'spices' ? 'to taste' : friendlyAmount(ing, v.grams);
    const display = ing.id === 'spices' ? 'to taste' : friendly ? `${friendly} (${formatGrams(v.grams)})` : formatGrams(v.grams);
    const list = groups.get(ing.category) ?? [];
    list.push({ ingredientId: id, name: ing.name, grams: v.grams, display, recipeNames: [...v.recipes].sort(), convertedFrom: v.convertedFrom });
    groups.set(ing.category, list);
  }
  return CATEGORY_ORDER.filter((c) => groups.has(c)).map((c) => ({
    category: c,
    label: INGREDIENT_CATEGORY_LABELS[c],
    items: groups.get(c)!.sort((a, b) => a.name.localeCompare(b.name)),
  }));
}

/** Plain-text list for copying/sharing. Checked items are omitted. */
export function shoppingListText(groups: ShoppingGroup[], checked: ID[] = [], title = 'Shopping list'): string {
  const lines = [title];
  for (const g of groups) {
    const items = g.items.filter((i) => !checked.includes(i.ingredientId));
    if (!items.length) continue;
    lines.push('', g.label);
    for (const i of items) lines.push(`- ${i.name}: ${i.display}`);
  }
  return lines.join('\n');
}
