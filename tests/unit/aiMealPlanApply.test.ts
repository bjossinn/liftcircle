/**
 * AI meal plan suggestions on the device (src/domain/nutrition/aiActions.ts): the card's totals are planStatus of the
 * days as balanceDay leaves them; apply replaces or fills days, is idempotent, and Undo restores the earlier meals.
 */
import { describe, expect, it } from 'vitest';
import { RECIPES, RECIPES_BY_ID } from '@/data/recipes';
import { balanceDay, planDayNutrition, type PlanDraft, type PlanPrefs } from '@/domain/nutrition/mealplan';
import {
  applyMealPlanSuggestion, isMealPlanApplied, previewMealPlan, toMealPlanSuggestion, toRecipeSuggestions, undoMealPlanSuggestion, type MealPlanSuggestion,
} from '@/domain/nutrition/aiActions';

const lunch = RECIPES.find((r) => r.meal === 'lunch')!;
const dinner = RECIPES.find((r) => r.meal === 'dinner')!;
const breakfast = RECIPES.find((r) => r.meal === 'breakfast')!;
const PREFS: PlanPrefs = { tags: [], allergens: [], dislikedIngredientIds: [], maxCookMinutes: 60, budget: 'medium', mealsPerDay: 3, proteinTarget: 150, kcalTarget: 2600 };
const WEEK = '2026-10-26';

const raw = (over: Record<string, unknown> = {}) => ({
  kind: 'meal_plan', id: 'msg-1', weekStart: WEEK, weekEnd: '2026-11-01', targets: { proteinG: 150, kcal: 2600 }, summary: 'Two days', warnings: [],
  days: [
    { date: '2026-10-29', items: [{ slot: 'breakfast', recipeId: breakfast.id, name: breakfast.name, servings: 1 }, { slot: 'lunch', recipeId: lunch.id, name: lunch.name, servings: 1.5 }] },
    { date: '2026-10-30', items: [{ slot: 'dinner', recipeId: dinner.id, name: dinner.name, servings: 1 }] },
  ],
  ...over,
});
const suggestion = () => toMealPlanSuggestion(raw())!;
const emptyWeek = (): PlanDraft => ({ weekStart: WEEK, days: Array.from({ length: 7 }, (_, i) => ({ date: `2026-10-${26 + i}`.replace('2026-10-32', '2026-11-01'), items: [] })), shoppingChecked: [] });

describe('AI meal plan suggestions — parse', () => {
  it('parses a stored action; unknown recipes or malformed shapes make it non-applicable (null)', () => {
    expect(suggestion().days).toHaveLength(2);
    expect(toMealPlanSuggestion(raw({ days: [{ date: '2026-10-29', items: [{ slot: 'lunch', recipeId: 'not-a-recipe', servings: 1 }] }] }))).toBeNull();
    expect(toMealPlanSuggestion(raw({ days: [{ date: '2026-12-01', items: [] }] }))).toBeNull();
    expect(toMealPlanSuggestion(raw({ kind: 'week_adjustment' }))).toBeNull();
    expect(toMealPlanSuggestion(raw({ days: [{ date: '2026-10-29', items: [{ slot: 'lunch', recipeId: lunch.id, servings: 9 }] }] }))).toBeNull();
  });

  it('recipe cards keep only catalog recipes and use catalog names', () => {
    const r = toRecipeSuggestions({ kind: 'recipe_suggestions', id: 'm', recipes: [{ id: lunch.id, name: 'Renamed <b>', perServing: { kcal: 500, protein_g: 40 } }, { id: 'nope', name: 'x' }] });
    expect(r!.recipes.map((x) => [x.id, x.name])).toEqual([[lunch.id, lunch.name]]);
    expect(toRecipeSuggestions({ kind: 'recipe_suggestions', id: 'm', recipes: [{ id: 'nope' }] })).toBeNull();
  });
});

describe('AI meal plan suggestions — preview matches balanceDay', () => {
  it('the totals shown are planDayNutrition of balanceDay(day) — the same days that get saved', () => {
    const s = suggestion();
    const { days, status } = previewMealPlan(s, PREFS);
    s.days.forEach((d, i) => {
      const plain = { date: d.date, items: d.items.map((it, n) => ({ id: `ai:${s.id}:${d.date}:${n}`, slot: it.slot, recipeId: it.recipeId, servings: it.servings })) };
      const balanced = balanceDay(plain, PREFS, { dayIndex: i });
      expect(days[i]).toEqual(balanced);
      expect(status.days[i].totals).toEqual(planDayNutrition(balanced, RECIPES_BY_ID));
      expect(status.days[i].proteinTarget).toBe(150);
    });
    const applied = applyMealPlanSuggestion(null, s, 'replace', PREFS)!;
    expect(applied.plan.days.filter((d) => d.items.length)).toEqual(days);
  });
});

describe('AI meal plan suggestions — apply, replay, undo', () => {
  it('no plan yet → creates the week with the suggested days only', () => {
    const r = applyMealPlanSuggestion(null, suggestion(), 'replace', PREFS)!;
    expect(r.plan.days).toHaveLength(7);
    expect(r.touched).toEqual(['2026-10-29', '2026-10-30']);
    expect(r.plan.days.find((d) => d.date === '2026-10-26')!.items).toEqual([]);
    expect(isMealPlanApplied(r.plan, 'msg-1')).toBe(true);
  });

  it('replace vs only empty days', () => {
    const existing = emptyWeek();
    existing.days[3].items = [{ id: 'mine', slot: 'dinner', recipeId: dinner.id, servings: 1 }]; // Thu 29th has a meal
    const replace = applyMealPlanSuggestion(existing, suggestion(), 'replace', PREFS)!;
    expect(replace.plan.days[3].items.every((i) => i.id.startsWith('ai:msg-1:'))).toBe(true);
    const empty = applyMealPlanSuggestion(existing, suggestion(), 'empty', PREFS)!;
    expect(empty.touched).toEqual(['2026-10-30']);
    expect(empty.plan.days[3].items.map((i) => i.id)).toEqual(['mine']);
    existing.days[4].items = [{ id: 'mine2', slot: 'lunch', recipeId: lunch.id, servings: 1 }];
    expect(applyMealPlanSuggestion(existing, suggestion(), 'empty', PREFS)).toBeNull(); // nothing to fill
  });

  it('idempotent replay: applying again changes nothing', () => {
    const first = applyMealPlanSuggestion(emptyWeek(), suggestion(), 'replace', PREFS)!;
    const again = applyMealPlanSuggestion(first.plan, suggestion(), 'replace', PREFS)!;
    expect(again.alreadyApplied).toBe(true);
    expect(again.plan).toBe(first.plan);
    expect(again.touched).toEqual([]);
  });

  it('Undo removes exactly the suggestion and restores the replaced meals; other meals added since are kept', () => {
    const existing = emptyWeek();
    existing.days[3].items = [{ id: 'mine', slot: 'dinner', recipeId: dinner.id, servings: 1 }];
    const r = applyMealPlanSuggestion(existing, suggestion(), 'replace', PREFS)!;
    const undone = undoMealPlanSuggestion(r.plan, 'msg-1', r.snapshot);
    expect(undone.days[3].items.map((i) => i.id)).toEqual(['mine']);
    expect(undone.days[4].items).toEqual([]);
    expect(isMealPlanApplied(undone, 'msg-1')).toBe(false);
    // the user added a snack to Friday after applying → Undo keeps it
    const edited = { ...r.plan, days: r.plan.days.map((d) => (d.date === '2026-10-30' ? { ...d, items: [...d.items, { id: 'snack', slot: 'snack' as const, recipeId: lunch.id, servings: 1 }] } : d)) };
    expect(undoMealPlanSuggestion(edited, 'msg-1', r.snapshot).days[4].items.map((i) => i.id)).toEqual(['snack']);
    // no snapshot (other device) → just removes the AI items
    expect(undoMealPlanSuggestion(r.plan, 'msg-1').days[3].items).toEqual([]);
  });

  it('a different suggestion is independent', () => {
    const first = applyMealPlanSuggestion(null, suggestion(), 'replace', PREFS)!;
    const other: MealPlanSuggestion = { ...suggestion(), id: 'msg-2', days: [suggestion().days[1]] };
    expect(isMealPlanApplied(first.plan, 'msg-2')).toBe(false);
    expect(applyMealPlanSuggestion(first.plan, other, 'replace', PREFS)!.alreadyApplied).toBe(false);
  });
});
