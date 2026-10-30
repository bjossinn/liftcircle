/**
 * AI coach nutrition actions on the device (pure): a suggested meal plan ("Add to my meal plan") and recipe cards.
 * Shapes mirror supabase/functions/_shared/ai/types.ts (MealPlanAction, RecipeSuggestionsAction); the server validated
 * recipe ids, allergens/diet/dislikes and ranges, and the app re-checks against the current catalog here.
 *
 * Applying a meal plan:
 *  - each suggested day is balanced with the app's own balanceDay (portions and protein sides only), so what the card
 *    shows (planStatus totals vs targets) is exactly what gets saved;
 *  - mode 'replace' replaces the suggested days; 'empty' fills only days that have no meals yet;
 *  - items get ids `ai:<actionId>:<date>:<n>`, so applying again is a no-op (idempotent across devices) and Undo can
 *    remove exactly those items and put back what the suggested days held before (snapshot).
 */
import type { ID, ISODate, MealPlan, MealPlanItem, MealSlot } from '@/domain/types';
import { RECIPES_BY_ID } from '@/data/recipes';
import { INGREDIENTS_BY_ID } from '@/data/ingredients';
import { balanceDay, planStatus, type PlanDay, type PlanDraft, type PlanPrefs, type PlanStatus } from './mealplan';

export interface MealPlanSuggestion {
  kind: 'meal_plan';
  id: string;
  weekStart: ISODate;
  weekEnd: ISODate;
  days: { date: ISODate; items: { slot: MealSlot; recipeId: ID; name: string; servings: number; extras?: { ingredientId: ID; grams: number }[] }[] }[];
  targets: { proteinG: number; kcal: number | null };
  summary: string;
  warnings: string[];
}

export interface RecipeSuggestions {
  kind: 'recipe_suggestions';
  id: string;
  recipes: { id: ID; name: string; meal: MealSlot; totalMinutes: number; perServing: { kcal: number; protein_g: number; carbs_g: number; fat_g: number } }[];
}

const SLOTS: MealSlot[] = ['breakfast', 'lunch', 'dinner', 'snack'];
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const rec = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Defensive parse of a stored meal_plan action; unknown recipes/ingredients drop the whole action (never applicable). */
export function toMealPlanSuggestion(raw: unknown): MealPlanSuggestion | null {
  const a = rec(raw);
  if (!a || a.kind !== 'meal_plan' || typeof a.id !== 'string' || !isDate(a.weekStart) || !isDate(a.weekEnd) || !Array.isArray(a.days)) return null;
  const days: MealPlanSuggestion['days'] = [];
  for (const d of a.days.slice(0, 7)) {
    const day = rec(d);
    if (!day || !isDate(day.date) || day.date < a.weekStart || day.date > a.weekEnd || !Array.isArray(day.items)) return null;
    const items: MealPlanSuggestion['days'][number]['items'] = [];
    for (const x of day.items.slice(0, 6)) {
      const it = rec(x);
      if (!it || !SLOTS.includes(it.slot as MealSlot) || typeof it.recipeId !== 'string' || !RECIPES_BY_ID.has(it.recipeId)) return null;
      const servings = num(it.servings);
      if (!(servings >= 0.5 && servings <= 3)) return null;
      const extras = Array.isArray(it.extras)
        ? it.extras.map(rec).filter((e): e is Record<string, unknown> => !!e && typeof e.ingredientId === 'string' && INGREDIENTS_BY_ID.has(e.ingredientId) && num(e.grams) > 0)
          .slice(0, 1).map((e) => ({ ingredientId: String(e.ingredientId), grams: Math.min(300, num(e.grams)) }))
        : undefined;
      items.push({ slot: it.slot as MealSlot, recipeId: it.recipeId, name: typeof it.name === 'string' ? it.name : RECIPES_BY_ID.get(it.recipeId)!.name, servings, ...(extras?.length ? { extras } : {}) });
    }
    days.push({ date: day.date, items });
  }
  if (!days.length) return null;
  const t = rec(a.targets);
  return {
    kind: 'meal_plan',
    id: a.id,
    weekStart: a.weekStart,
    weekEnd: a.weekEnd,
    days,
    targets: { proteinG: num(t?.proteinG), kcal: typeof t?.kcal === 'number' ? t.kcal : null },
    summary: typeof a.summary === 'string' ? a.summary : '',
    warnings: Array.isArray(a.warnings) ? a.warnings.filter((w): w is string => typeof w === 'string').slice(0, 4) : [],
  };
}

export function toRecipeSuggestions(raw: unknown): RecipeSuggestions | null {
  const a = rec(raw);
  if (!a || a.kind !== 'recipe_suggestions' || typeof a.id !== 'string' || !Array.isArray(a.recipes)) return null;
  const recipes = a.recipes.map(rec).filter((r): r is Record<string, unknown> => !!r && typeof r.id === 'string' && RECIPES_BY_ID.has(r.id)).slice(0, 5).map((r) => {
    const cat = RECIPES_BY_ID.get(String(r.id))!;
    const p = rec(r.perServing);
    return {
      id: cat.id,
      name: cat.name,
      meal: cat.meal,
      totalMinutes: num(r.totalMinutes, cat.prepMinutes + cat.cookMinutes),
      perServing: { kcal: num(p?.kcal), protein_g: num(p?.protein_g), carbs_g: num(p?.carbs_g), fat_g: num(p?.fat_g) },
    };
  });
  return recipes.length ? { kind: 'recipe_suggestions', id: a.id, recipes } : null;
}

/* ------------------------------------------------------------------ meal plan preview + apply */
export const aiItemPrefix = (actionId: string) => `ai:${actionId}:`;

/** The suggested days as plan days (item ids tagged), each balanced with the app's own balanceDay. */
export function suggestedDays(s: MealPlanSuggestion, prefs: PlanPrefs): PlanDay[] {
  return s.days.map((d, i) =>
    balanceDay(
      {
        date: d.date,
        items: d.items.map<MealPlanItem>((it, n) => ({
          id: `${aiItemPrefix(s.id)}${d.date}:${n}`,
          slot: it.slot,
          recipeId: it.recipeId,
          servings: it.servings,
          ...(it.extras?.length ? { extras: it.extras } : {}),
        })),
      },
      prefs,
      { dayIndex: i },
    ),
  );
}

/** What the card shows: each suggested day's totals vs the current targets (planStatus of the balanced days). */
export function previewMealPlan(s: MealPlanSuggestion, prefs: PlanPrefs): { days: PlanDay[]; status: PlanStatus } {
  const days = suggestedDays(s, prefs);
  return { days, status: planStatus({ weekStart: s.weekStart, days, shoppingChecked: [] }, prefs) };
}

export const isMealPlanApplied = (plan: Pick<MealPlan, 'days'> | null | undefined, actionId: string) =>
  !!plan?.days.some((d) => d.items.some((i) => i.id.startsWith(aiItemPrefix(actionId))));

export type MealPlanApplyMode = 'replace' | 'empty';

function weekDays(weekStart: ISODate): ISODate[] {
  const d = new Date(`${weekStart}T00:00:00Z`);
  return Array.from({ length: 7 }, (_, i) => new Date(d.getTime() + i * 86_400_000).toISOString().slice(0, 10));
}

/**
 * The plan to save after applying (or null when nothing would change). `existing` is the saved plan for that week, if
 * any. Returns the snapshot of the days it touched so Undo can restore them.
 */
export function applyMealPlanSuggestion(
  existing: PlanDraft | null,
  s: MealPlanSuggestion,
  mode: MealPlanApplyMode,
  prefs: PlanPrefs,
): { plan: PlanDraft; touched: ISODate[]; snapshot: PlanDay[]; alreadyApplied: boolean } | null {
  if (isMealPlanApplied(existing, s.id)) return { plan: existing!, touched: [], snapshot: [], alreadyApplied: true };
  const base: PlanDraft = existing ?? { weekStart: s.weekStart, days: weekDays(s.weekStart).map((date) => ({ date, items: [] })), shoppingChecked: [] };
  const byDate = new Map(base.days.map((d) => [d.date, d]));
  const touched: ISODate[] = [];
  const snapshot: PlanDay[] = [];
  for (const day of suggestedDays(s, prefs)) {
    const cur = byDate.get(day.date);
    if (mode === 'empty' && cur && cur.items.length > 0) continue;
    touched.push(day.date);
    snapshot.push(cur ?? { date: day.date, items: [] });
    byDate.set(day.date, day);
  }
  if (!touched.length) return null;
  const dates = [...new Set([...base.days.map((d) => d.date), ...touched])].sort();
  return { plan: { ...base, days: dates.map((d) => byDate.get(d)!) }, touched, snapshot, alreadyApplied: false };
}

/**
 * Undo: removes this suggestion's items; days in the snapshot get their earlier meals back (unless the user added
 * other meals there since — those are kept).
 */
export function undoMealPlanSuggestion<P extends PlanDraft>(plan: P, actionId: string, snapshot: PlanDay[] = []): P {
  const prefix = aiItemPrefix(actionId);
  const prev = new Map(snapshot.map((d) => [d.date, d]));
  return {
    ...plan,
    days: plan.days.map((d) => {
      if (!d.items.some((i) => i.id.startsWith(prefix))) return d;
      const kept = d.items.filter((i) => !i.id.startsWith(prefix));
      return { ...d, items: kept.length ? kept : prev.get(d.date)?.items ?? [] };
    }),
  };
}
