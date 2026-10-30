/**
 * Recipe nutrition, portion scaling, substitutions and allergen/diet derivation — computed from ingredients.
 * The implementation lives in supabase/functions/_shared/nutrition/recipes.ts so the app and the ai-coach function
 * use the same math; this module registers the bundled catalog as the default and re-exports everything.
 */
import { INGREDIENTS_BY_ID, PIECE_LABELS } from '@/data/ingredients';
import { RECIPES } from '@/data/recipes';
import { setNutritionCatalog } from '../../../supabase/functions/_shared/nutrition/catalog';

setNutritionCatalog({ byId: INGREDIENTS_BY_ID, recipes: RECIPES, pieceLabels: PIECE_LABELS });

export * from '../../../supabase/functions/_shared/nutrition/recipes';
