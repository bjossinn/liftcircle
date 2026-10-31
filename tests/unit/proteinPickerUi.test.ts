// @vitest-environment jsdom
/**
 * The protein picker: one tri-state chip grid (like / not for me / neutral, with text labels) used in the setup wizard,
 * on the meal plan (with "Rebuild meal plan with these", keeping the current plan until confirmed) and on the recipes
 * screen (protein filter row and "Hide proteins I've excluded").
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ db: null as unknown, account: null as unknown, rerender: (() => undefined) as () => void }));
vi.mock('@/state/app', () => ({
  useApp: () => ({
    db: h.db,
    auth: { status: 'signed_in', userId: 'user-1' },
    account: h.account,
    accountReady: true,
    online: true,
    backendConfigured: true,
    updateAccount: async (fn: (a: unknown) => unknown) => {
      h.account = fn(h.account);
      h.rerender();
    },
    finishSignOut: () => undefined,
  }),
  useDb: () => h.db,
  useSettings: () => (h.account as { settings: unknown }).settings,
}));

import { ToastProvider } from '@/components/toast';
import { LiftDb } from '@/db/db';
import { alive, newRecord, saveRecord } from '@/db/repo';
import { defaultAccountState } from '@/state/defaults';
import { selectMeals, planPrefsFrom } from '@/domain/nutrition/mealplan';
import { featuredProteinGroups, recipeProteinGroups } from '@/domain/nutrition/recipes';
import { RECIPES, RECIPES_BY_ID } from '@/data/recipes';
import { startOfWeek, todayISO } from '@/lib/dates';
import type { AccountState, MealPlan, ProteinPrefs } from '@/domain/types';
import { ProteinPicker } from '@/features/nutrition/ProteinPicker';
import MealPlanPage from '@/features/nutrition/MealPlanPage';
import RecipesPage from '@/features/nutrition/RecipesPage';
import { NutritionStep } from '@/features/onboarding/steps';
import { newDraft, type Draft } from '@/features/onboarding/draft';

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
let root: Root | null = null;
let container: HTMLElement | null = null;
function mount(el: () => ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const render = () => root!.render(createElement(ToastProvider, null, createElement(MemoryRouter, null, el())));
  h.rerender = () => act(render);
  act(render);
}
afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
});
async function waitFor<T>(fn: () => T, tries = 250): Promise<T> {
  for (;; tries--) {
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
const dialogProto = HTMLDialogElement.prototype as unknown as { showModal: () => void; close: () => void };
dialogProto.showModal = function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};
dialogProto.close = function (this: HTMLDialogElement) {
  this.removeAttribute('open');
};
const buttons = () => [...document.querySelectorAll('button')];
const byLabel = (label: string | RegExp) => buttons().find((b) => (typeof label === 'string' ? b.getAttribute('aria-label') === label || norm(b.textContent) === label : label.test(b.getAttribute('aria-label') ?? '')));
const click = (label: string | RegExp) => {
  const b = byLabel(label);
  expect(b, String(label)).toBeTruthy();
  act(() => b!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};
function accountWith(proteinPrefs?: ProteinPrefs): AccountState {
  const a = defaultAccountState();
  a.settings.nutritionEnabled = true;
  a.nutrition = { ...a.nutrition, mode: 'protein_only', proteinG: 160 };
  if (proteinPrefs) a.profile.diet = { ...a.profile.diet, proteinPrefs };
  return a;
}

describe('ProteinPicker chips', () => {
  it('tri-state with text labels: tap once = Like, twice = Not for me, again = No preference', () => {
    let latest: ProteinPrefs | undefined;
    function Harness() {
      const [v, setV] = useState<ProteinPrefs | undefined>(undefined);
      latest = v;
      return createElement(ProteinPicker, { value: v, onChange: setV });
    }
    mount(() => createElement(Harness));
    const chip = () => buttons().find((b) => /^Prawns: /.test(b.getAttribute('aria-label') ?? ''))!;
    expect(chip().getAttribute('aria-label')).toBe('Prawns: No preference');
    expect(chip().getAttribute('aria-describedby')).toBeTruthy(); // the hint explains the taps
    click('Prawns: No preference');
    expect(chip().getAttribute('aria-label')).toBe('Prawns: Like');
    expect(norm(chip().textContent)).toContain('Like'); // visible text, not icon-only
    click('Prawns: Like');
    expect(chip().getAttribute('aria-label')).toBe('Prawns: Not for me');
    expect(norm(chip().textContent)).toContain('Not for me');
    expect(latest).toEqual({ liked: [], excluded: ['prawns'] });
    click('Prawns: Not for me');
    expect(chip().getAttribute('aria-label')).toBe('Prawns: No preference');
    expect(buttons().filter((b) => / (No preference|Like|Not for me)$/.test(b.getAttribute('aria-label') ?? ''))).toHaveLength(17);
  });

  it('the setup wizard nutrition step shows "Which proteins do you like?" and saves to the draft', () => {
    h.account = accountWith();
    let d: Draft = newDraft(h.account as AccountState);
    function Harness() {
      const [draft, setDraft] = useState(d);
      d = draft;
      return createElement(NutritionStep, { d: draft, set: (patch) => setDraft((x) => ({ ...x, a: { ...x.a, ...patch } })), setDraft, errors: {}, byId: new Map() });
    }
    mount(() => createElement(Harness));
    expect(norm(document.body.textContent)).toContain('Which proteins do you like?');
    expect(document.querySelector('[role="group"][aria-labelledby="proteins-title"]')).toBeTruthy();
    click('Chicken: No preference');
    click('Tuna: No preference');
    click('Tuna: Like');
    expect(d.a.diet.proteinPrefs).toEqual({ liked: ['chicken'], excluded: ['tuna'] });
  });
});

describe('meal plan: Proteins sheet', () => {
  it('saving keeps the current plan until "Rebuild meal plan with these" is confirmed; the rebuilt plan has none of the excluded protein', async () => {
    h.account = accountWith();
    const db = new LiftDb(`protein-ui-${Math.random()}`);
    h.db = db;
    const account = h.account as AccountState;
    const weekStart = startOfWeek(todayISO(account.settings.timeZone), account.settings.weekStart);
    const draft = selectMeals(weekStart, planPrefsFrom(account.profile.diet, account.nutrition, true));
    const saved = newRecord<MealPlan>(draft as MealPlan);
    await saveRecord('meal_plans', saved, db);
    // Exclude the main protein of the first planned meal.
    const target = featuredProteinGroups(RECIPES_BY_ID.get(draft.days[0].items[0].recipeId)!)[0];
    const label = `${{ chicken: 'Chicken', turkey: 'Turkey', beef: 'Beef', pork: 'Pork & ham', lamb: 'Lamb', white_fish: 'White fish', oily_fish: 'Salmon & oily fish', tuna: 'Tuna', prawns: 'Prawns', shellfish: 'Other shellfish', eggs: 'Eggs', dairy: 'Dairy', tofu_tempeh: 'Tofu & tempeh', beans_lentils: 'Beans & lentils', chickpeas: 'Chickpeas', whey: 'Whey protein', plant_protein: 'Plant protein powder' }[target]}`;

    mount(() => createElement(MealPlanPage));
    await waitFor(() => expect(byLabel('Proteins')).toBeTruthy());
    click('Proteins');
    await waitFor(() => expect(byLabel(`${label}: No preference`)).toBeTruthy());
    click(`${label}: No preference`);
    click(`${label}: Like`);
    click('Save');
    await waitFor(() => expect(norm(document.body.textContent)).toContain('Your current plan stays as it is until you rebuild it.'));
    expect((h.account as AccountState).profile.diet.proteinPrefs).toEqual({ liked: [], excluded: [target] });
    // Not rebuilt yet.
    const before = (await db.mealPlans.toArray()).find((p) => p.id === saved.id)!;
    expect(before.days).toEqual(saved.days);
    click('Rebuild meal plan with these');
    let plan: MealPlan | undefined;
    for (let i = 0; i < 200 && !plan; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 15));
      });
      const p = alive(await db.mealPlans.toArray()).find((x) => x.id === saved.id)!;
      if (JSON.stringify(p.days) !== JSON.stringify(saved.days)) plan = p;
    }
    expect(plan, 'rebuilt plan').toBeTruthy();
    plan = plan!;
    for (const d of plan.days) for (const it of d.items) expect(recipeProteinGroups(RECIPES_BY_ID.get(it.recipeId)!, it.swaps ?? [])).not.toContain(target);
    db.close();
  });
});

describe('recipes screen: protein filters and the same picker', () => {
  it('"Hide proteins I\'ve excluded" is on by default; the protein filter row narrows the list; "Your proteins" opens the same picker', async () => {
    h.account = accountWith({ liked: [], excluded: ['prawns'] });
    h.db = new LiftDb(`protein-ui-r-${Math.random()}`);
    mount(() => createElement(RecipesPage));
    const count = () => Number(/(\d+) recipes?/.exec(norm(document.body.textContent))![1]);
    const prawnRecipes = RECIPES.filter((r) => featuredProteinGroups(r).includes('prawns')).length;
    expect(prawnRecipes).toBeGreaterThan(0);
    const toggle = [...document.querySelectorAll('[role="switch"], input[type="checkbox"]')].find((x) => norm(x.closest('label')?.textContent ?? x.parentElement?.textContent).includes("Hide proteins I've excluded"));
    expect(toggle, 'toggle').toBeTruthy();
    expect(count()).toBe(RECIPES.length - prawnRecipes);
    expect(norm(document.body.textContent)).toContain('Not for me: prawns');
    // Filter row: tuna only.
    const tunaChip = buttons().find((b) => norm(b.textContent) === 'Tuna' && b.closest('[aria-label="Protein filters"], [role="group"]'));
    expect(tunaChip, 'tuna chip').toBeTruthy();
    act(() => tunaChip!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(count()).toBe(RECIPES.filter((r) => featuredProteinGroups(r).includes('tuna')).length);
    // The same picker, from the header.
    click('Your proteins');
    await waitFor(() => expect(byLabel('Prawns: Not for me')).toBeTruthy());
    expect(byLabel('Chicken: No preference')).toBeTruthy();
  });
});
