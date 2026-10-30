/**
 * Default catalog for the shared nutrition code. The app registers its bundled recipes and ingredients once
 * (src/domain/nutrition/recipes.ts); the ai-coach function registers the reference rows it loaded from the database
 * and also passes them explicitly. Functions that take an optional catalog fall back to this one.
 */
import type { ID, Ingredient, Recipe } from './types.ts';

export interface NutritionCatalog {
  byId: Map<ID, Ingredient>;
  recipes: Recipe[];
  /** Singular/plural labels for counted ingredients (e.g. eggs), used by friendlyAmount. */
  pieceLabels: Partial<Record<ID, [string, string]>>;
}

let current: NutritionCatalog = { byId: new Map(), recipes: [], pieceLabels: {} };

export function setNutritionCatalog(c: Partial<NutritionCatalog>): void {
  current = { ...current, ...c };
}
export function catalog(): NutritionCatalog {
  return current;
}
