// @vitest-environment jsdom
/**
 * Meal plan screen: the per-day gap, protein-only wording and "Balance this day" are rendered from the saved
 * plan, so they look the same after a remount (reload) and update after an edit. Today is listed first (earlier days
 * collapsed), past weeks open from "Past meal plans", and ?week= opens that week. The clock is pinned (Date only).
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
import { RECIPES as ALL_RECIPES } from '@/data/recipes';
import { setNutritionCatalog } from '../../supabase/functions/_shared/nutrition/catalog';

// These fixtures (and their exact numbers) were reviewed on the 84-recipe catalogue of packs 1–2, so the planner runs on that
// catalogue here. The full catalogue (pack 3) is covered by recipeCatalog.test.ts and proteinPrefs.test.ts.
setNutritionCatalog({ recipes: ALL_RECIPES.slice(0, 84) });

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
let root: Root | null = null;
let container: HTMLElement | null = null;
function mount(url = '/nutrition/plan') {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(ToastProvider, null, createElement(MemoryRouter, { initialEntries: [url] }, createElement(MealPlanPage)))));
}
function unmount() {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
}
// Counts attempts rather than reading the clock, because some tests pin Date.
async function waitFor<T>(fn: () => T, timeout = 4000): Promise<T> {
  for (let tries = Math.ceil(timeout / 15); ; tries--) {
    try {
      return fn();
    } catch (e) {
      if (tries <= 0) throw e;
      await act(async () => {
        await new Promise((r) => setTimeout(r, 15));
      });
    }
  }
}
const text = () => norm(document.body.textContent);

afterEach(() => {
  unmount();
  vi.useRealTimers();
});
// jsdom lacks the modal dialog API used by Sheet.
const dialogProto = HTMLDialogElement.prototype as unknown as { showModal: () => void; close: () => void };
dialogProto.showModal = function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};
dialogProto.close = function (this: HTMLDialogElement) {
  this.removeAttribute('open');
};
/** Pin "now" (noon UTC, so the date is the same in any device time zone) without faking timers. */
const pinDate = (iso: string) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${iso}T12:00:00Z`));
};
const click = (label: string) => {
  const b = [...document.querySelectorAll('button')].find((x) => norm(x.textContent) === label || x.getAttribute('aria-label') === label);
  expect(b, label).toBeTruthy();
  act(() => b!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};
const dayTitles = () => [...document.querySelectorAll('section > [id^="d-"], section [id^="d-"]')].map((e) => norm(e.textContent));

describe('MealPlanPage (protein-only fixture)', () => {
  it('shows gaps from the saved plan, survives a remount, and balances a day', async () => {
    pinDate('2026-10-26'); // first day of the week, so every day is "upcoming" and day 1 is on top
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
    expect(text()).toMatch(/16 g short/); // first day: 128 g of 144 g (84-recipe catalogue; was 125 g with 24 recipes)
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

describe('MealPlanPage: today first, past plans', () => {
  async function setup() {
    const db = new LiftDb(`mealplan-order-${Math.random().toString(36).slice(2)}`);
    h.db = db;
    const base = defaultAccountState();
    const account: AccountState = { ...base, settings: { ...base.settings, nutritionEnabled: true, weekStart: 1, timeZone: 'UTC' } };
    h.account = account;
    const prefs = planPrefsFrom(account.profile.diet, account.nutrition, true);
    await saveRecord('meal_plans', newRecord(selectMeals('2026-10-26', prefs)) as MealPlan, db);
    await saveRecord('meal_plans', newRecord(selectMeals('2026-10-19', prefs)) as MealPlan, db);
    await saveRecord('meal_plans', newRecord(selectMeals('2026-10-05', prefs)) as MealPlan, db);
    return db;
  }

  it('lists today first, then the rest of the week; earlier days are collapsed at the end', async () => {
    pinDate('2026-10-30'); // Friday
    const db = await setup();
    mount();
    await waitFor(() => expect(dayTitles()[0]).toBe('Today'));
    expect(dayTitles()).toEqual(['Today', 'Saturday 31 Oct', 'Sunday 1 Nov']);
    const toggle = [...document.querySelectorAll('button')].find((b) => norm(b.textContent).startsWith('Earlier this week'))!;
    expect(norm(toggle.textContent)).toBe('Earlier this week · 4 days');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    click('Earlier this week · 4 days');
    await waitFor(() => expect(dayTitles()).toHaveLength(7));
    expect(dayTitles().slice(3)).toEqual(['Monday 26 Oct', 'Tuesday 27 Oct', 'Wednesday 28 Oct', 'Thursday 29 Oct']);
    db.close();
    await db.delete();
  });

  it('on the first day of the week there is nothing to collapse; a past week shows in date order', async () => {
    pinDate('2026-10-26');
    const db = await setup();
    mount();
    await waitFor(() => expect(dayTitles()).toHaveLength(7));
    expect(dayTitles()[0]).toBe('Today');
    expect(text()).not.toMatch(/Earlier this week/);
    click('Previous week');
    await waitFor(() => expect(dayTitles()[0]).toBe('Monday 19 Oct'));
    expect(dayTitles()).toHaveLength(7);
    expect(text()).not.toMatch(/Earlier this week/);
    db.close();
    await db.delete();
  });

  it('"Past meal plans" lists earlier weeks newest first and opens one; "Back to this week" returns', async () => {
    pinDate('2026-10-30');
    const db = await setup();
    mount();
    await waitFor(() => expect(dayTitles()[0]).toBe('Today'));
    expect(text()).not.toMatch(/Back to this week/);
    click('Past meal plans');
    await waitFor(() => expect(text()).toMatch(/Last week/));
    const rows = [...document.querySelectorAll('dialog[open] li')].map((li) => norm(li.textContent));
    expect(rows).toHaveLength(2); // this week's plan isn't "past"
    expect(rows[0]).toMatch(/^Last week19 Oct – 25 Oct · \d+ meals$/);
    expect(rows[1]).toMatch(/^Week of 5 Oct5 Oct – 11 Oct · \d+ meals$/);
    act(() => (document.querySelectorAll('dialog[open] li button')[1] as HTMLButtonElement).click());
    await waitFor(() => expect(dayTitles()[0]).toBe('Monday 5 Oct'));
    expect(text()).toMatch(/Week of/);
    click('Back to this week');
    await waitFor(() => expect(dayTitles()[0]).toBe('Today'));
    db.close();
    await db.delete();
  });

  it('?week= opens that week (e.g. the coach "Customize first" link)', async () => {
    pinDate('2026-10-30');
    const db = await setup();
    mount('/nutrition/plan?week=2026-10-21');
    await waitFor(() => expect(dayTitles()[0]).toBe('Monday 19 Oct'));
    db.close();
    await db.delete();
  });

  it('with no earlier plans, the sheet says so', async () => {
    pinDate('2026-10-30');
    const db = new LiftDb(`mealplan-empty-${Math.random().toString(36).slice(2)}`);
    h.db = db;
    const base = defaultAccountState();
    h.account = { ...base, settings: { ...base.settings, nutritionEnabled: true, timeZone: 'UTC' } };
    mount();
    await waitFor(() => expect(text()).toMatch(/No plan for this week/));
    click('Past meal plans');
    await waitFor(() => expect(text()).toMatch(/No earlier meal plans yet/));
    db.close();
    await db.delete();
  });
});
