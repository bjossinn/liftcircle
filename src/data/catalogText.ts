/**
 * Display text for the bundled catalogs (exercises, recipes, ingredients) in the app language.
 *
 * Catalog data stays canonical English (ids, stored names, imports, AI context). These helpers look up the approved
 * translation at DISPLAY time (`exercise.*`, `recipe.*`, `food.*` keys) and fall back to the catalog English when a
 * key is missing. User content is never translated: custom exercises, custom foods and stored free text are shown as
 * typed. Same pattern as `localizeGeneratedText` for generated program text.
 */
import type { Exercise, ID, Ingredient, ProteinGroup, Recipe } from '@/domain/types';
import { EN, getLanguage, hasKey, t, tKey, type Language, type MessageKey } from '@/i18n';
import { EXERCISES } from './exercises';
import { INGREDIENTS_BY_ID, PIECE_LABELS } from './ingredients';
import { RECIPES_BY_ID } from './recipes';

const BUNDLED_EXERCISES = new Map(EXERCISES.map((e) => [e.id, e]));

/* --------------------------------------------------------------- exercises */

/** True for an exercise from the read-only catalog (custom exercises are user content). */
export function isBundledExercise(ex: Pick<Exercise, 'id' | 'custom'>): boolean {
  return !ex.custom && BUNDLED_EXERCISES.has(ex.id);
}

/**
 * Name to show for an exercise (object or id). Catalog exercises are translated; custom exercises keep the name the
 * user typed; an unknown id reads "Unknown exercise" in the current language.
 */
export function exerciseDisplayName(ex: Exercise | ID | undefined | null, byId?: Map<ID, Exercise>, lang: Language = getLanguage()): string {
  const obj = typeof ex === 'string' ? (byId?.get(ex) ?? BUNDLED_EXERCISES.get(ex)) : ex;
  if (!obj) return t('workout.unknownExercise', undefined, lang);
  if (!isBundledExercise(obj)) return obj.name;
  return tKey(`exercise.name.${obj.id}`, obj.name, undefined, lang);
}

/** "Also called" names. Catalog: translated aliases in catalog order (English fallback per alias). Custom: as typed. */
export function exerciseAliases(ex: Exercise, lang: Language = getLanguage()): string[] {
  if (!isBundledExercise(ex)) return ex.aliases;
  return ex.aliases.map((a, i) => tKey(`exercise.alias.${ex.id}.${i + 1}`, a, undefined, lang));
}

export function exerciseSetup(ex: Exercise, lang: Language = getLanguage()): string {
  return isBundledExercise(ex) ? tKey(`exercise.setup.${ex.id}`, ex.setup, undefined, lang) : ex.setup;
}

export function exerciseExecution(ex: Exercise, lang: Language = getLanguage()): string {
  return isBundledExercise(ex) ? tKey(`exercise.execution.${ex.id}`, ex.execution, undefined, lang) : ex.execution;
}

export function exerciseMistakes(ex: Exercise, lang: Language = getLanguage()): string[] {
  if (!isBundledExercise(ex)) return ex.mistakes;
  return ex.mistakes.map((m, i) => tKey(`exercise.mistake.${ex.id}.${i + 1}`, m, undefined, lang));
}

/* ----------------------------------------------------------------- recipes */

type RecipeRef = Pick<Recipe, 'id' | 'name'> | ID;
const recipeOf = (r: RecipeRef) => (typeof r === 'string' ? RECIPES_BY_ID.get(r) : r);

/** True for a recipe from the bundled catalog. */
export function isBundledRecipe(id: ID | undefined | null): boolean {
  return !!id && RECIPES_BY_ID.has(id);
}

/** Recipe name in the app language; non-catalog recipes (or a stored snapshot `fallback`) are shown as given. */
export function recipeDisplayName(r: RecipeRef | undefined | null, lang: Language = getLanguage(), fallback?: string): string {
  if (!r) return fallback ?? '';
  const obj = recipeOf(r);
  const english = obj?.name ?? fallback ?? (typeof r === 'string' ? r : '');
  const id = typeof r === 'string' ? r : r.id;
  return isBundledRecipe(id) ? tKey(`recipe.name.${id}`, english, undefined, lang) : english;
}

export function recipeSteps(r: Recipe, lang: Language = getLanguage()): string[] {
  if (!isBundledRecipe(r.id)) return r.steps;
  return r.steps.map((s, i) => tKey(`recipe.step.${r.id}.${i + 1}`, s, undefined, lang));
}

export function recipeNotes(r: Recipe, lang: Language = getLanguage()): string | undefined {
  if (!r.notes) return r.notes;
  return isBundledRecipe(r.id) ? tKey(`recipe.notes.${r.id}`, r.notes, undefined, lang) : r.notes;
}

/* ------------------------------------------------------------- ingredients */

/** Ingredient name in the app language (catalog id or object); unknown ids / custom foods are shown as given. */
export function ingredientDisplayName(ing: Pick<Ingredient, 'id' | 'name'> | ID | undefined | null, lang: Language = getLanguage(), fallback?: string): string {
  if (!ing) return fallback ?? '';
  const id = typeof ing === 'string' ? ing : ing.id;
  const english = (typeof ing === 'string' ? INGREDIENTS_BY_ID.get(ing)?.name : ing.name) ?? fallback ?? id;
  return INGREDIENTS_BY_ID.has(id) ? tKey(`food.ingredient.${id}`, english, undefined, lang) : english;
}

/**
 * Lookup of the shared amount/prep phrase keys by their exact English text ("½ cup" → food.display.1_2_cup). The
 * catalog repeats the same phrases many times, so one key covers every identical occurrence.
 */
function phraseIndex(prefix: string): Map<string, MessageKey> {
  const m = new Map<string, MessageKey>();
  for (const [k, v] of Object.entries(EN)) if (k.startsWith(prefix)) m.set(v, k as MessageKey);
  return m;
}

let displayIdx: Map<string, MessageKey> | null = null;
let prepIdx: Map<string, MessageKey> | null = null;

/** Catalog amount text ("½ cup", "2 eggs") in the app language; text without a key is shown as given. */
export function foodDisplayText(display: string | undefined, lang: Language = getLanguage()): string | undefined {
  if (!display) return display;
  displayIdx ??= phraseIndex('food.display.');
  const k = displayIdx.get(display);
  return k ? t(k, undefined, lang) : display;
}

/** Catalog prep text ("diced", "dry") in the app language; text without a key is shown as given. */
export function foodPrepText(prep: string | undefined, lang: Language = getLanguage()): string | undefined {
  if (!prep) return prep;
  prepIdx ??= phraseIndex('food.prep.');
  const k = prepIdx.get(prep);
  return k ? t(k, undefined, lang) : prep;
}

/** Piece noun for a counted ingredient ("egg" / "eggs", "egg" / "egg"), or undefined when it isn't counted in pieces. */
export function pieceLabel(id: ID, count: number, lang: Language = getLanguage()): string | undefined {
  const en = PIECE_LABELS[id];
  if (!en) return undefined;
  const one = count === 1 || (lang === 'is' && count % 10 === 1 && count % 100 !== 11);
  return tKey(`food.piece.${id}.${one ? 'one' : 'other'}`, one ? en[0] : en[1], undefined, lang);
}

/** Shopping-list section label for an ingredient category. */
export function ingredientCategoryLabel(category: Ingredient['category'], lang: Language = getLanguage()): string {
  return tKey(`food.category.${category}`, category, undefined, lang);
}

/** Example foods for a protein group chip ("Chicken, turkey"), or undefined when there are none. */
export function proteinExampleText(group: ProteinGroup, lang: Language = getLanguage()): string | undefined {
  const k = `food.proteinExample.${group}`;
  return hasKey(k) ? t(k, undefined, lang) : undefined;
}
