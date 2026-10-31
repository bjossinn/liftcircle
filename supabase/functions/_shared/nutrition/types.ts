/**
 * Nutrition types used by the shared recipe math and meal planner (pure; no Deno / npm imports).
 * Structurally identical to the app's definitions in src/domain/types.ts — tests/unit/aiCoachFixes.test.ts (parity) checks
 * that values flow both ways — so the app and the ai-coach function run one implementation on the same shapes.
 */
export type ID = string;
export type ISODate = string;

export type DietTag = 'vegetarian' | 'vegan' | 'pescatarian' | 'dairy_free' | 'gluten_free' | 'high_protein';
export type Allergen =
  | 'milk' | 'egg' | 'fish' | 'shellfish' | 'tree_nuts' | 'peanuts' | 'wheat' | 'gluten' | 'soy' | 'sesame' | 'mustard' | 'celery';
export type BudgetPref = 'low' | 'medium' | 'any';
export type MealSlot = 'breakfast' | 'lunch' | 'dinner' | 'snack';
/**
 * Protein groups for "proteins I like / not for me" preferences. An ingredient carries at most one. Separate from
 * allergens: an allergy is a safety filter, a protein preference is taste.
 */
export type ProteinGroup =
  | 'chicken' | 'turkey' | 'beef' | 'pork' | 'lamb'
  | 'white_fish' | 'oily_fish' | 'tuna' | 'prawns' | 'shellfish'
  | 'eggs' | 'dairy'
  | 'tofu_tempeh' | 'beans_lentils' | 'chickpeas'
  | 'whey' | 'plant_protein';

/** liked = rank and pick these more often; excluded = never use. Missing = no preference. */
export interface ProteinPrefs {
  liked: ProteinGroup[];
  excluded: ProteinGroup[];
}

export interface DietPrefs {
  tags: DietTag[];
  allergens: Allergen[];
  dislikedIngredientIds: ID[];
  maxCookMinutes: number;
  budget: BudgetPref;
  mealsPerDay: number;
  /** Optional; absent on data saved before 0.9.0 (= no preference). */
  proteinPrefs?: ProteinPrefs;
}

export interface Macros {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber?: number;
}

export interface Ingredient {
  id: ID;
  name: string;
  category: 'protein' | 'dairy' | 'grain' | 'legume' | 'vegetable' | 'fruit' | 'fat' | 'nut_seed' | 'condiment' | 'other';
  per100g: Macros;
  state: 'raw' | 'dry' | 'cooked' | 'as_sold';
  source: string;
  allergens: Allergen[];
  diet: { vegetarian: boolean; vegan: boolean; dairyFree: boolean; glutenFree: boolean; pescatarian: boolean };
  units?: Partial<Record<'piece' | 'cup' | 'tbsp' | 'tsp' | 'slice' | 'can', number>>;
  costTier: 1 | 2 | 3;
  /** The protein group this ingredient belongs to, if it is a protein food. */
  proteinGroup?: ProteinGroup;
}

export interface RecipeIngredient {
  ingredientId: ID;
  grams: number;
  display?: string;
  prep?: string;
  optional?: boolean;
}

export interface Recipe {
  id: ID;
  name: string;
  meal: MealSlot;
  servings: number;
  prepMinutes: number;
  cookMinutes: number;
  ingredients: RecipeIngredient[];
  steps: string[];
  substitutions: { ingredientId: ID; alternatives: ID[] }[];
  notes?: string;
}

export interface MealPlanExtra {
  ingredientId: ID;
  grams: number;
}
export interface MealPlanItem {
  id: ID;
  slot: MealSlot;
  recipeId: ID;
  servings: number;
  swaps?: { from: ID; to: ID }[];
  extras?: MealPlanExtra[];
}
/** The parts of a saved meal plan the planner reads and writes (the app's MealPlan adds sync fields). */
export interface MealPlanContent {
  weekStart: ISODate;
  days: { date: ISODate; items: MealPlanItem[] }[];
  shoppingChecked: ID[];
}

/** The parts of the app's NutritionTargets the planner reads. */
export interface NutritionTargetsLike {
  mode: 'none' | 'protein_only' | 'full' | 'manual';
  proteinG?: number;
  calories?: number;
}
