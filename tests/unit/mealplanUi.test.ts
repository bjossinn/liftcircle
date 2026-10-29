// @vitest-environment jsdom
/**
 * Meal plan screen: the per-day gap, protein-only wording and "Balance this day" are rendered from the saved
 * plan, so they look the same after a remount (reload) and update after an edit.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ db: null as unknown, account: null as unknown }));
vi.mock('@/state/app', () => ({
  useApp: () => ({
    db: h.db,
    auth: { status: 'signed_in', userId: 'user-1' },
    account: h.account,
    accountReady: true,
    online: true,
    backendConfigured: true,
    updateAccount: async () => undefined,
    finishSignOut: () => undefined,
  }),
  useDb: () => h.db,
  useSettings: () => (h.account as { settings: unknown }).settings,
}));

import { ToastProvider } from '@/components/toast';
import { LiftDb } from '@/db/db';
import { newRecord, saveRecord } from '@/db/repo';
import { defaultAccountState } from '@/state/defaults';
import { selectMeals, planPrefsFrom } from '@/domain/nutrition/mealplan';
import { startOfWeek, todayISO } from '@/lib/dates';
import type { AccountState, MealPlan } from '@/domain/types';
import MealPlanPage from '@/features/nutrition/MealPlanPage';

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
let root: Root | null = null;
let container: HTMLElement | null = null;
function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(ToastProvider, null, createElement(MemoryRouter, { initialEntries: ['/nutrition/plan'] }, createElement(MealPlanPage)))));
}
function unmount() {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
}
async function waitFor<T>(fn: () => T, timeout = 4000): Promise<T> {
  const start = Date.now();
  for (;;) {
    try {
      return fn();
    } catch (e) {
      if (Date.now() - start > timeout) throw e;
      await act(async () => {
        await new Promise((r) => setTimeout(r, 15));
      });
    }
  }
}
const text = () => norm(document.body.textContent);

afterEach(() => unmount());

describe('MealPlanPage (protein-only fixture)', () => {
  it('shows gaps from the saved plan, survives a remount, and balances a day', async () => {
    const db = new LiftDb(`mealplan-ui-${Date.now()}`);
    h.db = db;
    const base = defaultAccountState();
    const account: AccountState = {
      ...base,
      settings: { ...base.settings, nutritionEnabled: true },
      profile: { ...base.profile, diet: { tags: [], allergens: ['milk'], dislikedIngredientIds: [], maxCookMinutes: 30, budget: 'any', mealsPerDay: 3 } },
      nutrition: { ...base.nutrition, mode: 'protein_only', proteinG: 144, proteinPerKg: 1.8, referenceWeightKg: 80, calories: 2600, mealsPerDay: 3 },
    };
    h.account = account;
    const week = startOfWeek(todayISO(account.settings.timeZone), account.settings.weekStart);
    // A plan saved by the old planner (no protein sides, one serving each): the reviewed shortfall.
    const legacy = selectMeals(week, planPrefsFrom(account.profile.diet, account.nutrition, true));
    const rec = newRecord(legacy) as MealPlan;
    await saveRecord('meal_plans', rec, db);

    mount();
    await waitFor(() => expect(text()).toMatch(/0 of 7 days within ±7 g of your 144 g protein target/));
    expect(text()).toMatch(/You're tracking protein only, so calories are shown for information/);
    expect(text()).toMatch(/kcal \(for information\)/);
    expect(text()).not.toMatch(/\/ 2600 kcal/); // a stale calorie value is never shown as a target
    expect(text()).toMatch(/19 g short/); // first day: 125 g of 144 g
    const before = text();

    // Reload: the same warnings and gaps are derived from the persisted plan.
    unmount();
    mount();
    await waitFor(() => expect(text()).toMatch(/0 of 7 days within/));
    expect(text()).toBe(before);

    const balance = [...document.querySelectorAll('button')].find((b) => norm(b.textContent) === 'Balance this day')!;
    expect(balance).toBeTruthy();
    act(() => balance.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await waitFor(() => expect(text()).toMatch(/1 of 7 days within ±7 g/));
    const saved = (await db.mealPlans.get(rec.id))!;
    expect(saved.days[0].items.some((i) => (i.extras?.length ?? 0) > 0 || i.servings !== 1)).toBe(true);
    expect(saved.days[0].items.map((i) => i.recipeId)).toEqual(legacy.days[0].items.map((i) => i.recipeId));

    act(() => [...document.querySelectorAll('button')].find((b) => norm(b.textContent) === 'Balance all days')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await waitFor(() => expect(text()).toMatch(/7 of 7 days within ±7 g/));
    expect(text()).not.toMatch(/g short/);
    db.close();
    await db.delete();
  });
});
