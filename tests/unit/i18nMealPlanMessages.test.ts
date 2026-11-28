/**
 * Meal plan warnings and day-status texts (planWarnings / planDayStatus / planStatus, shared with the ai-coach function)
 * follow the app language when the app passes planTextContext; without it they stay the English the server has
 * always produced, byte for byte.
 */
import { describe, expect, it } from 'vitest';
import {
  generateMealPlan, planDayStatus, planStatus, planTextContext, planWarnings, type PlanDraft, type PlanPrefs,
} from '@/domain/nutrition/mealplan';
import { recipeDisplayName } from '@/data/catalogText';
import { RECIPES_BY_ID } from '@/data/recipes';
import { sharedT } from '../../supabase/functions/_shared/i18n/core';

const WEEK = '2026-10-26'; // a Monday
const base: PlanPrefs = { tags: [], allergens: [], dislikedIngredientIds: [], maxCookMinutes: 30, budget: 'any', mealsPerDay: 3 };
const IS = planTextContext('is');
const ENGLISH_WORDS = /\b(recipes?|meals?|serving|protein target|planned|Swap|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|contains|isn't|Not for me)\b/;

const { plan } = generateMealPlan(WEEK, { ...base, proteinTarget: 150 });
/** Day 3 points at a recipe that no longer exists; day 5 is empty. */
const broken: PlanDraft = {
  ...plan,
  days: plan.days.map((d, k) => (k === 2 ? { ...d, items: [{ ...d.items[0], recipeId: 'gone' }, ...d.items.slice(1)] } : k === 4 ? { ...d, items: [] } : d)),
};
const strict: PlanPrefs = {
  ...base, proteinTarget: 150, allergens: ['milk', 'egg', 'gluten', 'wheat'], tags: ['vegan'], dislikedIngredientIds: ['chicken_breast'],
  proteinExcluded: ['chicken', 'eggs', 'dairy'],
};

describe('planWarnings', () => {
  it('is unchanged English by default and with lang "en"', () => {
    const w = planWarnings(broken, strict);
    expect(planWarnings(broken, strict, { lang: 'en' })).toEqual(w);
    expect(w).toContain('A meal on Wednesday uses a recipe that is no longer available. Swap or remove it.');
    expect(w.some((x) => / on (Monday|Tuesday|Thursday|Friday|Saturday|Sunday) (contains|isn't|includes) .*\. Swap it or edit the meal\.$/.test(x))).toBe(true);
    expect(planWarnings(plan, base)).toContain('Portions are one serving each. Adjust servings to suit your appetite.');
    // The app's English context gives the same text as the server default.
    expect(planWarnings(broken, strict, planTextContext('en'))).toEqual(w);
  });

  it('is Icelandic with the app context: localized recipe names, weekdays, allergens and diets', () => {
    const w = planWarnings(broken, strict, IS);
    expect(w).toContain('Máltíð á miðvikudaginn notar uppskrift sem er ekki lengur til. Skiptu henni út eða fjarlægðu hana.');
    for (const x of w) expect(x, x).not.toMatch(ENGLISH_WORDS);
    const conflicts = w.filter((x) => x.endsWith('Skiptu um uppskrift eða breyttu máltíðinni.'));
    expect(conflicts.length).toBeGreaterThan(0);
    // Each conflict starts with the Icelandic recipe name of a planned meal.
    const names = plan.days.flatMap((d) => d.items.map((i) => recipeDisplayName(RECIPES_BY_ID.get(i.recipeId)!, 'is')));
    for (const x of conflicts) expect(names.some((n) => x.startsWith(`${n} á `)), x).toBe(true);
    expect(w.join(' ')).toMatch(/uppfyllir ekki mataræðisstillinguna „Vegan“/);
    expect(w.join(' ')).toMatch(/inniheldur ofnæmisvalda? \(/);
    expect(planWarnings(plan, base, IS)).toContain('Hver máltíð er einn skammtur. Breyttu skömmtunum eftir matarlyst.');
  });

  it('chooses the Icelandic count forms with plural rules', () => {
    const tr = sharedT('is');
    const one = tr.tp('mealPlanner.warning.fewRecipes', 21, { meals: tr.tp('mealPlanner.slotCount.lunch', 21) });
    expect(one).toMatch(/^Aðeins 21 uppskrift fyrir hádegismat passar/);
    expect(tr.tp('mealPlanner.warning.fewRecipes', 3, { meals: 'kvöldmat' })).toMatch(/^Aðeins 3 uppskriftir fyrir kvöldmat passa/);
    expect(sharedT('en').tp('mealPlanner.warning.fewRecipes', 3, { meals: sharedT('en').tp('mealPlanner.slotCount.lunch', 3) })).toBe(
      'Only 3 lunches fit your choices, so some repeat this week: allow one more protein or a longer cook time?',
    );
  });
});

describe('planDayStatus', () => {
  const hungry: PlanPrefs = { ...base, proteinTarget: 300, kcalTarget: 2000, mealsPerDay: 3 };
  const lean = generateMealPlan(WEEK, { ...base, proteinTarget: 90 }).plan;

  it('is unchanged English by default', () => {
    const st = planDayStatus(lean.days[0], hungry);
    expect(planDayStatus(lean.days[0], hungry, { lang: 'en' })).toEqual(st);
    expect(st.message).toMatch(/^\d+ g of your 300 g protein target is planned: \d+ g short\./);
    expect(st.message).toContain('Your allergy and diet settings are never relaxed to reach a target.');
    expect(planDayStatus(broken.days[4], hungry).message).toBe('No meals are planned for this day.');
    expect(planStatus(lean, hungry, planTextContext('en'))).toEqual(planStatus(lean, hungry));
  });

  it('is Icelandic with lang "is": message, suggestions and empty days', () => {
    const st = planDayStatus(lean.days[0], hungry, IS);
    expect(st.message).toMatch(/^Skipulögð eru \d+ g af 300 g próteinmarkmiðinu þínu: \d+ g vantar upp á\./);
    expect(st.message).toContain('Ofnæmis- og mataræðisstillingunum þínum er aldrei slakað til að ná markmiði.');
    expect(st.suggestions.length).toBeGreaterThan(0);
    for (const s of st.suggestions) expect(s, s).not.toMatch(ENGLISH_WORDS);
    expect(st.suggestions.some((s) => /\(\+?-?[\d,]+ g prótein\)\.$/.test(s))).toBe(true);
    expect(planDayStatus(broken.days[4], hungry, IS).message).toBe('Engar máltíðir eru skipulagðar þennan dag.');
    // Same numbers and decisions in both languages: only the text differs.
    const en = planStatus(lean, hungry);
    const is = planStatus(lean, hungry, IS);
    expect(is.days.map((d) => [d.state, d.proteinGap, d.suggestions.length, d.balanced])).toEqual(en.days.map((d) => [d.state, d.proteinGap, d.suggestions.length, d.balanced]));
  });

  it('reports a protein surplus in Icelandic', () => {
    const big = generateMealPlan(WEEK, { ...base, proteinTarget: 200 }).plan;
    const st = planDayStatus(big.days[0], { ...base, proteinTarget: 60 }, IS);
    expect(st.state).toBe('over');
    expect(st.message).toMatch(/^Skipulögð eru \d+ g af próteini, \d+ g yfir 60 g markmiðinu þínu\.$/);
  });
});
