/**
 * SHARED by the app and the ai-coach function. Protein preferences ("proteins I like / not for me").
 * - excluded = never use: a recipe whose main protein is excluded is out; any other ingredient from an excluded group
 *   must be swappable for an allowed substitute (the swap is applied automatically), otherwise the recipe is out.
 * - liked = prefer: ranked higher and picked more often; other proteins still appear for variety.
 * Kept separate from allergens: an allergy is a safety filter, this is taste.
 */
import type { Ingredient, ProteinGroup, ProteinPrefs, Recipe } from './types.ts';
// @ts-ignore Deno requires the .ts extension; the app tsconfig does not enable allowImportingTsExtensions.
import { catalog } from './catalog.ts';
// @ts-ignore see above
import type { IngredientIndex, Swap } from './recipes.ts';

export const PROTEIN_GROUPS: ProteinGroup[] = [
  'chicken', 'turkey', 'beef', 'pork', 'lamb',
  'white_fish', 'oily_fish', 'tuna', 'prawns', 'shellfish',
  'eggs', 'dairy',
  'tofu_tempeh', 'beans_lentils', 'chickpeas',
  'whey', 'plant_protein',
];

export const PROTEIN_GROUP_LABELS: Record<ProteinGroup, string> = {
  chicken: 'Chicken',
  turkey: 'Turkey',
  beef: 'Beef',
  pork: 'Pork & ham',
  lamb: 'Lamb',
  white_fish: 'White fish',
  oily_fish: 'Salmon & oily fish',
  tuna: 'Tuna',
  prawns: 'Prawns',
  shellfish: 'Other shellfish',
  eggs: 'Eggs',
  dairy: 'Dairy',
  tofu_tempeh: 'Tofu & tempeh',
  beans_lentils: 'Beans & lentils',
  chickpeas: 'Chickpeas',
  whey: 'Whey protein',
  plant_protein: 'Plant protein powder',
};

/** Short examples shown under each chip's name and used by the coach. */
export const PROTEIN_GROUP_EXAMPLES: Record<ProteinGroup, string> = {
  chicken: 'breast, thigh',
  turkey: 'mince, breast',
  beef: 'mince, steak',
  pork: 'tenderloin, chops, ham',
  lamb: 'mince, leg',
  white_fish: 'cod, haddock, saithe',
  oily_fish: 'salmon, mackerel, sardines',
  tuna: 'canned tuna',
  prawns: 'prawns, shrimp',
  shellfish: 'mussels, squid',
  eggs: 'whole eggs, egg whites',
  dairy: 'skyr, cottage cheese, Greek yogurt, cheese',
  tofu_tempeh: 'tofu, tempeh',
  beans_lentils: 'lentils, beans, edamame',
  chickpeas: 'chickpeas, hummus',
  whey: 'whey protein powder',
  plant_protein: 'pea protein powder',
};

const KNOWN = new Set<string>(PROTEIN_GROUPS);

/** Clean preferences: known groups only, no duplicates, and a group can't be both liked and excluded (excluded wins). */
export function normalizeProteinPrefs(p: Partial<ProteinPrefs> | null | undefined): ProteinPrefs {
  const excluded = PROTEIN_GROUPS.filter((g) => p?.excluded?.includes(g));
  const liked = PROTEIN_GROUPS.filter((g) => p?.liked?.includes(g) && !excluded.includes(g));
  return { liked, excluded };
}
export function hasProteinPrefs(p: Partial<ProteinPrefs> | null | undefined): boolean {
  const n = normalizeProteinPrefs(p);
  return n.liked.length + n.excluded.length > 0;
}

export type ProteinChoice = 'like' | 'exclude' | 'neutral';
export function proteinChoice(p: Partial<ProteinPrefs> | null | undefined, g: ProteinGroup): ProteinChoice {
  const n = normalizeProteinPrefs(p);
  return n.excluded.includes(g) ? 'exclude' : n.liked.includes(g) ? 'like' : 'neutral';
}
/** Tri-state chip cycle: neutral → like → not for me → neutral. */
export function cycleProteinChoice(p: Partial<ProteinPrefs> | null | undefined, g: ProteinGroup): ProteinPrefs {
  return setProteinChoice(p, g, ({ neutral: 'like', like: 'exclude', exclude: 'neutral' } as const)[proteinChoice(p, g)]);
}
export function setProteinChoice(p: Partial<ProteinPrefs> | null | undefined, g: ProteinGroup, choice: ProteinChoice): ProteinPrefs {
  const n = normalizeProteinPrefs(p);
  const liked = n.liked.filter((x) => x !== g);
  const excluded = n.excluded.filter((x) => x !== g);
  if (choice === 'like') liked.push(g);
  if (choice === 'exclude') excluded.push(g);
  return normalizeProteinPrefs({ liked, excluded });
}

export function proteinGroupOf(id: string, byId: IngredientIndex = catalog().byId): ProteinGroup | undefined {
  const g = byId.get(id)?.proteinGroup;
  return g && KNOWN.has(g) ? g : undefined;
}

/** Protein grams per group from the recipe's non-optional ingredients (after swaps). */
export function proteinByGroup(recipe: Recipe, swaps: Swap[] = [], byId: IngredientIndex = catalog().byId): Map<ProteinGroup, number> {
  const out = new Map<ProteinGroup, number>();
  for (const ri of recipe.ingredients) {
    if (ri.optional) continue;
    const sw = swaps.find((s) => s.from === ri.ingredientId && byId.has(s.to));
    const ing = byId.get(sw ? sw.to : ri.ingredientId);
    const g = ing?.proteinGroup;
    if (!ing || !g || !KNOWN.has(g)) continue;
    out.set(g, (out.get(g) ?? 0) + (ing.per100g.protein * ri.grams) / 100);
  }
  return out;
}

/** The group supplying the most protein, or undefined for recipes without a protein food (e.g. porridge). */
export function mainProteinGroup(recipe: Recipe, swaps: Swap[] = [], byId: IngredientIndex = catalog().byId): ProteinGroup | undefined {
  let best: [ProteinGroup, number] | undefined;
  for (const [g, p] of proteinByGroup(recipe, swaps, byId)) if (!best || p > best[1] + 1e-9 || (Math.abs(p - best[1]) < 1e-9 && g < best[0])) best = [g, p];
  return best?.[0];
}

/** Groups that supply at least a quarter of the recipe's protein (the main group always counts). */
export function featuredProteinGroups(recipe: Recipe, swaps: Swap[] = [], byId: IngredientIndex = catalog().byId): ProteinGroup[] {
  let total = 0;
  for (const ri of recipe.ingredients) {
    if (ri.optional) continue;
    const ing = byId.get(swaps.find((s) => s.from === ri.ingredientId)?.to ?? ri.ingredientId);
    if (ing) total += (ing.per100g.protein * ri.grams) / 100;
  }
  const main = mainProteinGroup(recipe, swaps, byId);
  const by = proteinByGroup(recipe, swaps, byId);
  return PROTEIN_GROUPS.filter((g) => g === main || (by.get(g) ?? 0) >= 0.25 * total);
}

/** Every group used anywhere in the recipe, optional ingredients included (after swaps). */
export function recipeProteinGroups(recipe: Recipe, swaps: Swap[] = [], byId: IngredientIndex = catalog().byId): ProteinGroup[] {
  const set = new Set<ProteinGroup>();
  for (const ri of recipe.ingredients) {
    const sw = swaps.find((s) => s.from === ri.ingredientId && byId.has(s.to));
    const g = proteinGroupOf(sw ? sw.to : ri.ingredientId, byId);
    if (g) set.add(g);
  }
  return PROTEIN_GROUPS.filter((g) => set.has(g));
}

/**
 * How a recipe can fit the excluded groups: [] if it already fits, the swaps that make it fit (each excluded
 * ingredient replaced by its first allowed substitute), or null if it can't (its main protein is excluded, or an
 * excluded ingredient has no allowed substitute). `allowed` applies the user's other filters (allergens, diet, dislikes).
 */
export function proteinFitSwaps(
  recipe: Recipe,
  excluded: ProteinGroup[] | undefined,
  allowed: (ing: Ingredient) => boolean = () => true,
  byId: IngredientIndex = catalog().byId,
): Swap[] | null {
  if (!excluded?.length) return [];
  const main = mainProteinGroup(recipe, [], byId);
  if (main && excluded.includes(main)) return null;
  const swaps: Swap[] = [];
  for (const ri of recipe.ingredients) {
    const g = proteinGroupOf(ri.ingredientId, byId);
    if (!g || !excluded.includes(g)) continue;
    const alts = recipe.substitutions.find((s) => s.ingredientId === ri.ingredientId)?.alternatives ?? [];
    const to = alts.find((a) => {
      const ing = byId.get(a);
      if (!ing || !allowed(ing)) return false;
      const ag = ing.proteinGroup;
      return !ag || !excluded.includes(ag);
    });
    if (!to) return null;
    swaps.push({ from: ri.ingredientId, to });
  }
  return swaps;
}

/** An ingredient a user with these exclusions may be offered (sides, substitutes). */
export function ingredientFitsProteinPrefs(ing: Ingredient, excluded: ProteinGroup[] | undefined): boolean {
  return !ing.proteinGroup || !excluded?.includes(ing.proteinGroup);
}

/** Ranking bonus for liked proteins: more for the main protein, a little for a featured one. */
export function likedBonus(recipe: Recipe, liked: ProteinGroup[] | undefined, byId: IngredientIndex = catalog().byId): number {
  if (!liked?.length) return 0;
  const main = mainProteinGroup(recipe, [], byId);
  if (main && liked.includes(main)) return LIKED_MAIN_BONUS;
  return featuredProteinGroups(recipe, [], byId).some((g) => liked.includes(g)) ? LIKED_FEATURED_BONUS : 0;
}
export const LIKED_MAIN_BONUS = 0.45;
export const LIKED_FEATURED_BONUS = 0.2;

/** "prawns", "pork & ham and lamb": excluded groups in lower case for sentences. */
export function proteinListText(groups: ProteinGroup[]): string {
  const names = groups.map((g) => PROTEIN_GROUP_LABELS[g].toLowerCase());
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
