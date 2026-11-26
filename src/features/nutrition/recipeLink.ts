/**
 * Link to a recipe screen carrying ingredient swaps as ?swap=from:to,… — substitutes and optional ingredients left out
 * (`from:__left_out__`). The recipe screen (RecipeDetailPage linkSwaps) accepts only substitutes the recipe lists, so the
 * swaps saved on a meal-plan item or shown on a training-assistant recipe card come back exactly as saved.
 */
import type { ID } from '@/domain/types';
import type { Swap } from '@/domain/nutrition/recipes';

export function recipeLink(recipeId: ID, swaps: readonly Swap[] | undefined = []): string {
  const base = `/nutrition/recipes/${encodeURIComponent(recipeId)}`;
  const sw = swaps ?? [];
  return sw.length ? `${base}?swap=${sw.map((s) => `${encodeURIComponent(s.from)}:${encodeURIComponent(s.to)}`).join(',')}` : base;
}
