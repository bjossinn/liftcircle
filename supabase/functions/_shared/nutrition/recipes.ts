/**
 * SHARED by the app (src/domain/nutrition/recipes.ts re-exports it) and the ai-coach function — one implementation.
 * Recipe nutrition, portion scaling, substitutions and allergen/diet derivation — computed from ingredients.
 * Pure functions; no React or persistence.
 */
import type { Allergen, DietTag, ID, Ingredient, Macros, MealSlot, ProteinGroup, Recipe, RecipeIngredient } from './types.ts';
// @ts-ignore Deno requires the .ts extension; the app tsconfig does not enable allowImportingTsExtensions.
import { catalog } from './catalog.ts';
// @ts-ignore see above
import { proteinFitSwaps } from './proteins.ts';
// @ts-ignore see above
export * from './proteins.ts';

const round = (n: number, decimals = 2) => {
  const f = 10 ** decimals;
  return Math.round((n + Number.EPSILON) * f) / f;
};

export type IngredientIndex = Map<ID, Ingredient>;
export type Swap = { from: ID; to: ID };

export const ALLERGEN_LABELS: Record<Allergen, string> = {
  milk: 'Milk',
  egg: 'Egg',
  fish: 'Fish',
  shellfish: 'Shellfish',
  tree_nuts: 'Tree nuts',
  peanuts: 'Peanuts',
  wheat: 'Wheat',
  gluten: 'Gluten',
  soy: 'Soy',
  sesame: 'Sesame',
  mustard: 'Mustard',
  celery: 'Celery',
};
export const DIET_TAG_LABELS: Record<DietTag, string> = {
  vegetarian: 'Vegetarian',
  vegan: 'Vegan',
  pescatarian: 'Pescatarian',
  dairy_free: 'Dairy-free',
  gluten_free: 'Gluten-free',
  high_protein: 'High protein',
};
export const MEAL_LABELS: Record<MealSlot, string> = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snack' };
export const MEAL_ORDER: MealSlot[] = ['breakfast', 'lunch', 'dinner', 'snack'];

/* ----------------------------------------------------------------- macros */
export const ZERO_MACROS: Macros = { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 };

export function macrosForGrams(ing: Ingredient, grams: number): Macros {
  const f = grams / 100;
  const p = ing.per100g;
  return { kcal: p.kcal * f, protein: p.protein * f, carbs: p.carbs * f, fat: p.fat * f, fiber: (p.fiber ?? 0) * f };
}
export function addMacros(a: Macros, b: Macros): Macros {
  return { kcal: a.kcal + b.kcal, protein: a.protein + b.protein, carbs: a.carbs + b.carbs, fat: a.fat + b.fat, fiber: (a.fiber ?? 0) + (b.fiber ?? 0) };
}
export function scaleMacros(m: Macros, f: number): Macros {
  return { kcal: m.kcal * f, protein: m.protein * f, carbs: m.carbs * f, fat: m.fat * f, fiber: (m.fiber ?? 0) * f };
}
/** kcal to whole numbers, grams to one decimal. This is the stored precision (log entries, plan totals). */
export function roundMacros(m: Macros): Macros {
  return { kcal: Math.round(m.kcal), protein: round(m.protein, 1), carbs: round(m.carbs, 1), fat: round(m.fat, 1), fiber: round(m.fiber ?? 0, 1) };
}

/**
 * The one display rule for macro numbers (recipe cards, plan items, day totals, the food log):
 * first round to the stored precision (kcal whole, grams 0.1), then to whole numbers.
 * Rounding the stored value — not the raw one — means a recipe card and the log entry made from it
 * always show the same number.
 */
export function displayMacro(v: number, key: 'kcal' | 'protein' | 'carbs' | 'fat' | 'fiber'): number {
  return key === 'kcal' ? Math.round(v) : round(round(v, 1), 0);
}

/* ----------------------------------------------------------- substitutions */
/**
 * Grams of the substitute per gram of the original. Most swaps are like-for-like by weight;
 * where the forms differ (raw mince vs dry lentils, bread vs crispbread, sauce bases) we use a practical ratio.
 */
const SUB_RATIOS: Record<string, number> = {
  'beef-mince-10-raw>lentils-dry': 0.4,
  'lentils-dry>beef-mince-10-raw': 2.5,
  'lentils-dry>chickpeas-cooked': 2.4,
  'greek-yogurt-0>hummus': 0.5,
  'cottage-cheese>hummus': 0.4,
  'hummus>cottage-cheese': 2,
  'rye-bread>rye-crispbread': 0.6,
  'wholewheat-bread>rye-crispbread': 0.6,
  'rye-crispbread>wholewheat-bread': 1.6,
  'rye-crispbread>rye-bread': 1.6,
};
export function substitutionRatio(fromId: ID, toId: ID, byId: IngredientIndex = catalog().byId): number {
  const explicit = SUB_RATIOS[`${fromId}>${toId}`];
  if (explicit != null) return explicit;
  const a = byId.get(fromId);
  const b = byId.get(toId);
  if (a && b) {
    if (a.state === 'dry' && b.state === 'cooked') return 2.5;
    if (a.state === 'cooked' && b.state === 'dry') return 0.4;
  }
  return 1;
}

export interface ResolvedIngredient {
  ri: RecipeIngredient;
  ingredient: Ingredient | undefined;
  ingredientId: ID;
  /** Grams for the whole recipe at base servings, after any swap. */
  grams: number;
  swappedFrom?: ID;
}

/** Apply swaps (from → to) to a recipe's ingredient list. Unknown targets are ignored. */
export function resolveIngredients(recipe: Recipe, swaps: Swap[] = [], byId: IngredientIndex = catalog().byId): ResolvedIngredient[] {
  return recipe.ingredients.map((ri) => {
    const sw = swaps.find((s) => s.from === ri.ingredientId && byId.has(s.to));
    if (sw && sw.to !== ri.ingredientId) {
      return { ri, ingredientId: sw.to, ingredient: byId.get(sw.to), grams: ri.grams * substitutionRatio(sw.from, sw.to, byId), swappedFrom: ri.ingredientId };
    }
    return { ri, ingredientId: ri.ingredientId, ingredient: byId.get(ri.ingredientId), grams: ri.grams };
  });
}

/** Substitutes offered for an ingredient in this recipe. */
export function substitutesFor(recipe: Recipe, ingredientId: ID): ID[] {
  return recipe.substitutions.find((s) => s.ingredientId === ingredientId)?.alternatives ?? [];
}

/* --------------------------------------------------------------- nutrition */
export interface RecipeNutrition {
  /** For the requested servings. */
  total: Macros;
  /** Per single serving (independent of the requested servings). */
  perServing: Macros;
  servings: number;
  /** Ingredient ids that were not found (nutrition excluded). */
  missingIds: ID[];
}

export function recipeNutrition(
  recipe: Recipe,
  opts: { servings?: number; swaps?: Swap[]; byId?: IngredientIndex } = {},
): RecipeNutrition {
  const byId = opts.byId ?? catalog().byId;
  const servings = opts.servings ?? recipe.servings;
  let base = { ...ZERO_MACROS };
  const missingIds: ID[] = [];
  for (const r of resolveIngredients(recipe, opts.swaps, byId)) {
    if (!r.ingredient) {
      missingIds.push(r.ingredientId);
      continue;
    }
    base = addMacros(base, macrosForGrams(r.ingredient, r.grams));
  }
  const perServing = scaleMacros(base, 1 / recipe.servings);
  return { total: scaleMacros(perServing, servings), perServing, servings, missingIds };
}

/* ----------------------------------------------------------------- scaling */
const FRACTIONS: [number, string][] = [
  [0.25, '¼'],
  [1 / 3, '⅓'],
  [0.5, '½'],
  [2 / 3, '⅔'],
  [0.75, '¾'],
];
/** 1.5 → "1½", 0.33 → "⅓". Rounds to the nearest quarter/third. */
export function formatFraction(n: number): string {
  const whole = Math.floor(n + 1e-9);
  const frac = n - whole;
  let best: [number, string] = [0, ''];
  let bestDiff = frac;
  for (const f of FRACTIONS) {
    const d = Math.abs(frac - f[0]);
    if (d < bestDiff) {
      best = f;
      bestDiff = d;
    }
  }
  if (Math.abs(1 - frac) < bestDiff) return String(whole + 1);
  if (!best[1]) return String(whole);
  return whole === 0 ? best[1] : `${whole}${best[1]}`;
}

export function formatGrams(g: number): string {
  if (g >= 1000) return `${round(g / 1000, 2)} kg`;
  if (g >= 100) return `${Math.round(g / 5) * 5} g`;
  if (g >= 10) return `${Math.round(g)} g`;
  return `${round(g, 1)} g`;
}

const LIQUIDS = new Set(['milk', 'oat-drink', 'soy-drink', 'vegetable-stock', 'lemon-juice']);

/** A household-measure description of an amount, or null when none fits. */
export function friendlyAmount(ing: Ingredient, grams: number): string | null {
  const u = ing.units ?? {};
  const piece = catalog().pieceLabels[ing.id];
  if (u.piece && piece) {
    const n = grams / u.piece;
    if (n >= 0.2) {
      const r = n >= 3 ? Math.round(n) : Math.round(n * 2) / 2;
      const nn = r === 0 ? 0.5 : r;
      return `${formatFraction(nn)} ${nn > 1 ? piece[1] : piece[0]}`;
    }
  }
  if (u.slice) {
    const n = Math.max(0.5, Math.round((grams / u.slice) * 2) / 2);
    return `${formatFraction(n)} slice${n > 1 ? 's' : ''}`;
  }
  if (u.can && grams >= u.can * 0.4) {
    const n = Math.round((grams / u.can) * 2) / 2;
    return `${formatFraction(n)} can${n > 1 ? 's' : ''}`;
  }
  if (LIQUIDS.has(ing.id) && grams >= 50) return `${Math.round(grams / 10) * 10} ml`;
  if (u.tsp && grams < (u.tbsp ?? u.tsp * 3)) {
    const n = grams / u.tsp;
    if (n >= 0.25) return `${formatFraction(n)} tsp`;
  }
  if (u.tbsp && grams <= u.tbsp * 4) {
    const n = grams / u.tbsp;
    if (n >= 0.25) return `${formatFraction(n)} tbsp`;
  }
  if (u.cup && grams >= u.cup * 0.25 && grams <= u.cup * 4) return `${formatFraction(grams / u.cup)} cup${grams / u.cup > 1.1 ? 's' : ''}`;
  return null;
}

export interface ScaledIngredient extends ResolvedIngredient {
  /** Grams at the requested servings. */
  scaledGrams: number;
  display: string;
}

/**
 * Scale a recipe's ingredients to `servings` (with optional swaps).
 * 2× servings doubles every gram amount; per-serving nutrition is unchanged.
 */
export function scaleRecipe(recipe: Recipe, servings: number, swaps: Swap[] = [], byId: IngredientIndex = catalog().byId): { factor: number; ingredients: ScaledIngredient[] } {
  const factor = servings / recipe.servings;
  const ingredients = resolveIngredients(recipe, swaps, byId).map((r) => {
    const scaledGrams = r.grams * factor;
    let display: string;
    if (factor === 1 && !r.swappedFrom && r.ri.display) display = r.ri.display;
    else if (r.ingredient) display = friendlyAmount(r.ingredient, scaledGrams) ?? formatGrams(scaledGrams);
    else display = formatGrams(scaledGrams);
    return { ...r, scaledGrams, display };
  });
  return { factor, ingredients };
}

/* ------------------------------------------------------- allergens & diets */
export function recipeAllergens(recipe: Recipe, swaps: Swap[] = [], byId: IngredientIndex = catalog().byId): Allergen[] {
  const set = new Set<Allergen>();
  for (const r of resolveIngredients(recipe, swaps, byId)) r.ingredient?.allergens.forEach((a) => set.add(a));
  return (Object.keys(ALLERGEN_LABELS) as Allergen[]).filter((a) => set.has(a));
}

/** Diet tags derived from ingredients. high_protein = ≥ 20 g protein and ≥ 25 % of energy from protein per serving. */
export function recipeDietTags(recipe: Recipe, swaps: Swap[] = [], byId: IngredientIndex = catalog().byId): DietTag[] {
  const items = resolveIngredients(recipe, swaps, byId);
  const all = (k: keyof Ingredient['diet']) => items.every((r) => r.ingredient?.diet[k] === true);
  const tags: DietTag[] = [];
  const vegan = all('vegan');
  const vegetarian = all('vegetarian');
  if (vegan) tags.push('vegan');
  if (vegetarian) tags.push('vegetarian');
  if (all('pescatarian') && !vegetarian) tags.push('pescatarian');
  if (all('dairyFree')) tags.push('dairy_free');
  if (all('glutenFree')) tags.push('gluten_free');
  const { perServing } = recipeNutrition(recipe, { swaps, byId });
  if (perServing.protein >= 20 && perServing.kcal > 0 && (perServing.protein * 4) / perServing.kcal >= 0.25) tags.push('high_protein');
  return tags;
}

/** Does a recipe satisfy a requested diet tag? (vegetarian is satisfied by vegan; pescatarian by vegetarian.) */
export function satisfiesTag(tags: DietTag[], wanted: DietTag): boolean {
  if (tags.includes(wanted)) return true;
  if (wanted === 'vegetarian') return tags.includes('vegan');
  if (wanted === 'pescatarian') return tags.includes('vegetarian') || tags.includes('vegan');
  return false;
}

export function recipeMinutes(recipe: Recipe): number {
  return recipe.prepMinutes + recipe.cookMinutes;
}

/** "Quick" recipe filter: total prep + cook time in minutes. */
export const QUICK_MINUTES = 15;

/**
 * A simple everyday recipe: ≤ 20 min hands-on (prepMinutes), ≤ 8 non-optional ingredients and ≤ 6 steps.
 * Cooking time may be longer (a batch chilli simmers on its own).
 */
export function isSimpleRecipe(recipe: Recipe): boolean {
  return recipe.prepMinutes <= 20 && recipe.ingredients.filter((i) => !i.optional).length <= 8 && recipe.steps.length >= 1 && recipe.steps.length <= 6;
}

/** Gram-weighted average ingredient cost tier (seasonings excluded), 1–3. */
export function recipeCostTier(recipe: Recipe, byId: IngredientIndex = catalog().byId): number {
  let g = 0;
  let w = 0;
  for (const ri of recipe.ingredients) {
    const ing = byId.get(ri.ingredientId);
    if (!ing || ing.category === 'condiment') continue;
    g += ri.grams;
    w += ri.grams * ing.costTier;
  }
  return g > 0 ? round(w / g, 2) : 1;
}

export interface RecipeFilter {
  query?: string;
  meal?: MealSlot;
  tags?: DietTag[];
  excludeAllergens?: Allergen[];
  dislikedIngredientIds?: ID[];
  maxMinutes?: number;
  /** Protein groups marked "not for me": the recipe must fit them (possibly via an automatic swap, see proteinFitSwaps). */
  excludeProteinGroups?: ProteinGroup[];
}

export function recipeMatches(recipe: Recipe, f: RecipeFilter, byId: IngredientIndex = catalog().byId): boolean {
  if (f.meal && recipe.meal !== f.meal) return false;
  if (f.maxMinutes != null && recipeMinutes(recipe) > f.maxMinutes) return false;
  if (f.query) {
    const q = f.query.trim().toLowerCase();
    if (q) {
      const hay = [recipe.name, ...recipe.ingredients.map((i) => byId.get(i.ingredientId)?.name ?? '')].join(' ').toLowerCase();
      if (!q.split(/\s+/).every((w) => hay.includes(w))) return false;
    }
  }
  if (f.excludeAllergens?.length) {
    const al = recipeAllergens(recipe, [], byId);
    if (f.excludeAllergens.some((a) => al.includes(a))) return false;
  }
  if (f.dislikedIngredientIds?.length && recipe.ingredients.some((i) => f.dislikedIngredientIds!.includes(i.ingredientId))) return false;
  if (f.tags?.length) {
    const tags = recipeDietTags(recipe, [], byId);
    if (!f.tags.every((t) => satisfiesTag(tags, t))) return false;
  }
  if (f.excludeProteinGroups?.length) {
    const allowed = (ing: Ingredient) => ingredientAllowed(ing, { tags: f.tags, allergens: f.excludeAllergens, disliked: f.dislikedIngredientIds });
    if (proteinFitSwaps(recipe, f.excludeProteinGroups, allowed, byId) === null) return false;
  }
  return true;
}

/** Substitutes offered for an ingredient, without protein groups the user marked "not for me". */
export function allowedSubstitutes(recipe: Recipe, ingredientId: ID, excluded: ProteinGroup[] = [], byId: IngredientIndex = catalog().byId): ID[] {
  return substitutesFor(recipe, ingredientId).filter((id) => {
    const g = byId.get(id)?.proteinGroup;
    return !g || !excluded.includes(g);
  });
}

/** Ingredient passes a user's diet tags, allergens and dislikes. */
export function ingredientAllowed(ing: Ingredient, f: { tags?: DietTag[]; allergens?: Allergen[]; disliked?: ID[] }): boolean {
  if (f.allergens?.some((a) => ing.allergens.includes(a))) return false;
  if (f.disliked?.includes(ing.id)) return false;
  for (const t of f.tags ?? []) {
    if (t === 'vegan' && !ing.diet.vegan) return false;
    if (t === 'vegetarian' && !ing.diet.vegetarian) return false;
    if (t === 'pescatarian' && !ing.diet.pescatarian) return false;
    if (t === 'dairy_free' && !ing.diet.dairyFree) return false;
    if (t === 'gluten_free' && !ing.diet.glutenFree) return false;
  }
  return true;
}
