/**
 * Food-log arithmetic. Missing values are UNKNOWN, never zero: totals report how many entries
 * lack each field so the UI can say "at least …".
 */
import type {
  Allergen, CustomFood, DietTag, FoodLogEntry, ID, Ingredient, MealSlot, NutritionTargets, Recipe, SyncFields, ProteinGroup } from '@/domain/types';
import { INGREDIENTS, PIECE_LABELS } from '@/data/ingredients';
import { RECIPES } from '@/data/recipes';
import { round } from '@/domain/units';
import {
  formatFraction, ingredientAllowed, macrosForGrams, MEAL_ORDER, recipeMatches, recipeNutrition, roundMacros,
  type IngredientIndex, type Swap, ingredientFitsProteinPrefs } from './recipes';

export type MacroKey = 'kcal' | 'protein' | 'carbs' | 'fat';
export const MACRO_KEYS: MacroKey[] = ['kcal', 'protein', 'carbs', 'fat'];
export type EntryDraft = Omit<FoodLogEntry, keyof SyncFields | 'date' | 'meal'>;

export interface DayTotals {
  /** Sum of KNOWN values only. */
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  entries: number;
  /** Entries with no value for that field (unknown, not zero). */
  missing: Record<MacroKey, number>;
}

export function dayTotals(entries: Pick<FoodLogEntry, MacroKey | 'deletedAt'>[]): DayTotals {
  const t: DayTotals = { kcal: 0, protein: 0, carbs: 0, fat: 0, entries: 0, missing: { kcal: 0, protein: 0, carbs: 0, fat: 0 } };
  for (const e of entries) {
    if (e.deletedAt) continue;
    t.entries++;
    for (const k of MACRO_KEYS) {
      const v = e[k];
      if (v == null || !isFinite(v)) t.missing[k]++;
      else t[k] += v;
    }
  }
  for (const k of MACRO_KEYS) t[k] = k === 'kcal' ? Math.round(t[k]) : round(t[k], 1);
  return t;
}

export interface RemainingRow {
  key: MacroKey;
  eaten: number;
  target?: number;
  /** target − eaten; undefined without a target. Negative = over. */
  remaining?: number;
  /** Some entries are missing this value, so `eaten` is a lower bound. */
  partial: boolean;
}

export function targetFor(t: NutritionTargets, key: MacroKey): number | undefined {
  if (t.mode === 'none') return undefined;
  if (key === 'protein') return t.proteinG;
  if (t.mode === 'protein_only') return undefined;
  return key === 'kcal' ? t.calories : key === 'carbs' ? t.carbsG : t.fatG;
}

export function remainingVsTargets(totals: DayTotals, targets: NutritionTargets): RemainingRow[] {
  return MACRO_KEYS.map((key) => {
    const target = targetFor(targets, key);
    const eaten = totals[key];
    return { key, eaten, target, remaining: target != null ? round(target - eaten, key === 'kcal' ? 0 : 1) : undefined, partial: totals.missing[key] > 0 };
  });
}

/** Even split of a daily protein target across meals (integer grams summing to the total). */
export function proteinDistribution(proteinG: number, mealsPerDay: number): number[] {
  const n = Math.min(6, Math.max(1, Math.round(mealsPerDay)));
  const total = Math.round(proteinG);
  const base = Math.floor(total / n);
  const extra = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

export function groupByMeal<T extends { meal: MealSlot; createdAt: number }>(entries: T[]): { meal: MealSlot; entries: T[] }[] {
  return MEAL_ORDER.map((meal) => ({ meal, entries: entries.filter((e) => e.meal === meal).sort((a, b) => a.createdAt - b.createdAt) }));
}

/* ---------------------------------------------------------- entry builders */
function cleanMacros(m: { kcal: number; protein: number; carbs: number; fat: number }) {
  const r = roundMacros({ ...m, fiber: 0 });
  return { kcal: r.kcal, protein: r.protein, carbs: r.carbs, fat: r.fat };
}

export function entryFromRecipe(recipe: Recipe, servings: number, swaps: Swap[] = [], byId?: IngredientIndex): EntryDraft {
  const n = recipeNutrition(recipe, { servings, swaps, byId });
  return { name: recipe.name, source: { kind: 'recipe', refId: recipe.id }, servings, ...cleanMacros(n.total) };
}

export function entryFromIngredient(ing: Ingredient, grams: number): EntryDraft {
  return { name: ing.name, source: { kind: 'ingredient', refId: ing.id }, grams: round(grams, 1), ...cleanMacros(macrosForGrams(ing, grams)) };
}

/** `amount` is in the food's `per.unit` (g, ml, or servings). Unknown macros stay unknown. */
export function entryFromCustom(food: Pick<CustomFood, 'id' | 'name' | 'brand' | 'per' | 'macros'>, amount: number): EntryDraft {
  const f = food.per.amount > 0 ? amount / food.per.amount : 0;
  const scale = (v: number | undefined, d: number) => (v == null ? undefined : round(v * f, d));
  return {
    name: food.brand ? `${food.name} (${food.brand})` : food.name,
    source: { kind: 'custom', refId: food.id },
    ...(food.per.unit === 'serving' ? { servings: amount } : { grams: amount }),
    kcal: scale(food.macros.kcal, 0),
    protein: scale(food.macros.protein, 1),
    carbs: scale(food.macros.carbs, 1),
    fat: scale(food.macros.fat, 1),
  };
}

/** The reusable part of a logged entry (for copying, saved meals, recents). */
export function entryDraftOf(e: EntryDraft): EntryDraft {
  const d: EntryDraft = { name: e.name, source: { ...e.source } };
  if (e.servings != null) d.servings = e.servings;
  if (e.grams != null) d.grams = e.grams;
  for (const k of MACRO_KEYS) if (e[k] != null) d[k] = e[k];
  return d;
}

/** Rescale an entry's amount; macros scale proportionally, unknowns stay unknown. */
export function rescaleEntry<T extends Partial<EntryDraft>>(e: T, factor: number): T {
  const s = (v: number | undefined, d: number) => (v == null ? undefined : round(v * factor, d));
  return {
    ...e,
    servings: e.servings != null ? round(e.servings * factor, 2) : undefined,
    grams: e.grams != null ? round(e.grams * factor, 1) : undefined,
    kcal: s(e.kcal, 0),
    protein: s(e.protein, 1),
    carbs: s(e.carbs, 1),
    fat: s(e.fat, 1),
  };
}

/** Distinct recently logged items, newest first. */
export function recentItems<T extends FoodLogEntry>(entries: T[], limit = 20): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const e of [...entries].sort((a, b) => b.createdAt - a.createdAt)) {
    if (e.deletedAt) continue;
    const key = `${e.source.kind}:${e.source.refId ?? e.name.toLowerCase()}:${e.servings ?? ''}:${e.grams ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}

/* ----------------------------------------------------- protein-gap helpers */
export interface GapSuggestion {
  kind: 'food' | 'recipe';
  id: ID;
  name: string;
  /** "200 g", "2 eggs", "1 serving". */
  amount: string;
  grams?: number;
  servings?: number;
  protein: number;
  kcal: number;
}

/**
 * Food-based ideas to close a protein gap (no supplements). Respects diet tags, allergens and dislikes;
 * prefers foods with the most protein per kcal and, when known, those that fit the remaining calories.
 */
export function proteinGapSuggestions(
  gapG: number,
  opts: { tags?: DietTag[]; allergens?: Allergen[]; dislikedIngredientIds?: ID[]; excludedProteins?: ProteinGroup[]; remainingKcal?: number; ingredients?: Ingredient[]; recipes?: Recipe[]; limit?: number } = {},
): GapSuggestion[] {
  if (!(gapG > 0)) return [];
  const limit = opts.limit ?? 4;
  const want = Math.min(gapG, 35);
  const filter = { tags: opts.tags, allergens: opts.allergens, disliked: opts.dislikedIngredientIds };
  const foods: GapSuggestion[] = [];
  for (const ing of opts.ingredients ?? INGREDIENTS) {
    const p = ing.per100g;
    const readyToEat = ing.state === 'cooked' || ing.state === 'as_sold' || ing.id === 'egg';
    if (!readyToEat || p.protein < 8 || p.kcal <= 0 || (p.protein * 4) / p.kcal < 0.3) continue;
    if (!ingredientAllowed(ing, filter) || !ingredientFitsProteinPrefs(ing, opts.excludedProteins)) continue;
    let grams = (want / p.protein) * 100;
    let amount: string;
    const piece = ing.units?.piece;
    const label = PIECE_LABELS[ing.id];
    if (piece && label) {
      const n = Math.min(4, Math.max(1, Math.ceil(grams / piece)));
      grams = n * piece;
      amount = `${formatFraction(n)} ${n > 1 ? label[1] : label[0]}`;
    } else {
      grams = Math.min(250, Math.max(50, Math.round(grams / 25) * 25));
      amount = `${grams} g`;
    }
    const m = macrosForGrams(ing, grams);
    if (opts.remainingKcal != null && m.kcal > Math.max(opts.remainingKcal, 0) + 50) continue;
    foods.push({ kind: 'food', id: ing.id, name: ing.name, amount, grams, protein: round(m.protein, 1), kcal: Math.round(m.kcal) });
  }
  foods.sort((a, b) => b.protein / Math.max(1, b.kcal) - a.protein / Math.max(1, a.kcal) || a.name.localeCompare(b.name));
  const recipes: GapSuggestion[] = [];
  for (const r of opts.recipes ?? RECIPES) {
    if (!recipeMatches(r, { tags: opts.tags, excludeAllergens: opts.allergens, dislikedIngredientIds: opts.dislikedIngredientIds, excludeProteinGroups: opts.excludedProteins })) continue;
    const ps = recipeNutrition(r, { servings: 1 }).perServing;
    if (ps.protein < 15) continue;
    if (opts.remainingKcal != null && ps.kcal > Math.max(opts.remainingKcal, 0) + 50) continue;
    recipes.push({ kind: 'recipe', id: r.id, name: r.name, amount: '1 serving', servings: 1, protein: round(ps.protein, 1), kcal: Math.round(ps.kcal) });
  }
  // Snacks first, then by protein density.
  const meal = new Map((opts.recipes ?? RECIPES).map((r) => [r.id, r.meal]));
  recipes.sort((a, b) => Number(meal.get(b.id) === 'snack') - Number(meal.get(a.id) === 'snack') || b.protein / b.kcal - a.protein / a.kcal);
  const nFoods = Math.max(1, limit - Math.min(2, recipes.length));
  return [...foods.slice(0, nFoods), ...recipes.slice(0, limit - Math.min(nFoods, foods.length))].slice(0, limit);
}
