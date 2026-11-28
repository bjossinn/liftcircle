// @vitest-environment jsdom
/**
 * Icelandic nutrition screens: recipe list and recipe screen (catalog names, steps, templates), targets explanation,
 * shopping list labels and logged-entry names. Same mini harness as recipesUi.test.ts (react-dom/client + act; real
 * Dexie via fake-indexeddb).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';

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
    updateAccount: async (fn: (a: unknown) => unknown) => {
      h.account = fn(h.account);
    },
    finishSignOut: () => undefined,
  }),
  useDb: () => h.db,
  useSettings: () => (h.account as { settings: unknown }).settings,
}));

import { ToastProvider } from '@/components/toast';
import { LiftDb } from '@/db/db';
import { defaultAccountState } from '@/state/defaults';
import { RECIPES, RECIPES_BY_ID } from '@/data/recipes';
import { ingredientDisplayName, recipeDisplayName, recipeSteps } from '@/data/catalogText';
import { buildShoppingList } from '@/domain/nutrition/mealplan';
import { computeNutritionTargets } from '@/domain/nutrition/targets';
import { entryDisplayName } from '@/features/nutrition/shared';
import { setLanguage, t } from '@/i18n';
import type { AccountState } from '@/domain/types';
import RecipesPage from '@/features/nutrition/RecipesPage';
import RecipeDetailPage from '@/features/nutrition/RecipeDetailPage';
import TargetsPage from '@/features/nutrition/TargetsPage';

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
let root: Root | null = null;
let container: HTMLElement | null = null;
function mount(path: string) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      createElement(
        ToastProvider,
        null,
        createElement(
          MemoryRouter,
          { initialEntries: [path] },
          createElement(
            Routes,
            null,
            createElement(Route, { path: '/nutrition/recipes', element: createElement(RecipesPage) }),
            createElement(Route, { path: '/nutrition/recipes/:id', element: createElement(RecipeDetailPage) }),
            createElement(Route, { path: '/nutrition/targets', element: createElement(TargetsPage) }),
          ),
        ),
      ),
    ),
  );
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

beforeEach(() => {
  setLanguage('is');
  h.db = new LiftDb(`i18n-nutrition-${Date.now()}-${Math.random()}`);
  const base = defaultAccountState();
  h.account = {
    ...base,
    settings: { ...base.settings, nutritionEnabled: true },
    profile: { ...base.profile, age: 35, heightCm: 180, sexParam: 'male' },
    nutrition: { ...base.nutrition, mode: 'full' },
  } satisfies AccountState;
  Object.defineProperty(navigator, 'wakeLock', { value: { request: vi.fn(async () => ({ release: vi.fn(async () => undefined) })) }, configurable: true });
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});
afterEach(async () => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  await (h.db as LiftDb).delete();
  setLanguage('en');
});

describe('Icelandic recipe screens', () => {
  it('recipe list: count, Quick chip, meta line and recipe names are Icelandic', async () => {
    mount('/nutrition/recipes');
    await waitFor(() => expect(text()).toContain(`${RECIPES.length} uppskriftir`));
    expect(text()).toContain('Fljótlegt (≤ 15 mín)');
    expect(text()).toContain('g prótein í skammti');
    expect(text()).toContain(recipeDisplayName(RECIPES[0], 'is'));
    expect(document.querySelector('input[type="search"]')!.getAttribute('placeholder')).toBe('Leita að uppskriftum eða hráefni');
  });

  it('recipe screen: name, sections, steps and ingredient names in Icelandic', async () => {
    const r = RECIPES_BY_ID.get('skyr-oat-pancakes')!;
    mount(`/nutrition/recipes/${r.id}`);
    await waitFor(() => expect(text()).toContain('Skyr- og hafrapönnukökur'));
    expect(text()).toContain('Aðferð');
    expect(text()).toContain('Hráefni');
    expect(text()).toContain(recipeSteps(r, 'is')[0]);
    expect(text()).toContain(ingredientDisplayName(r.ingredients[0].ingredientId, 'is').toLocaleLowerCase('is'));
    expect(text()).toContain('Skrá þessa máltíð');
    expect(text()).not.toContain('How to make it');
  });

  it('targets screen: section titles and the calculation explanation are Icelandic', async () => {
    await (h.db as LiftDb).measurements.add({ id: 'w1', kind: 'bodyweight', value: 80, date: '2026-11-01', createdAt: 1, updatedAt: 1 } as never);
    mount('/nutrition/targets');
    await waitFor(() => expect(text()).toContain('Upplýsingarnar þínar'));
    expect(text()).toContain('Hvernig þetta er reiknað');
    await waitFor(() => expect(text()).toContain('Hvíldarorka (Mifflin–St Jeor, karl)'));
    expect(text()).not.toContain('Resting energy');
  });
});

describe('Icelandic nutrition domain text', () => {
  it('computeNutritionTargets explains in the app language; English is unchanged', () => {
    const input = { age: 30, weightKg: 80, heightCm: 180, sexParam: 'male' as const, activityLevel: 'light' as const, goal: 'strength' as const, mode: 'full' as const, mealsPerDay: 3 };
    const is = computeNutritionTargets(input).explanation.join(' ');
    expect(is).toContain('Viðmiðunarþyngd');
    expect(is).toContain('Markmið (Styrkur)');
    setLanguage('en');
    const en = computeNutritionTargets(input).explanation.join(' ');
    expect(en).toContain('Spread across 3 meals: about 48 g each.');
    expect(en).toContain('standard multiplier for "Lightly active"');
  });

  it('shopping list names, amounts and sections follow the language', () => {
    const r = RECIPES_BY_ID.get('skyr-oat-pancakes')!;
    const plan = { weekStart: '2026-11-23', shoppingChecked: [], days: [{ date: '2026-11-23', items: [{ id: 'a', slot: 'breakfast' as const, recipeId: r.id, servings: 1 }] }] };
    const groups = buildShoppingList(plan, RECIPES_BY_ID, undefined, 'is');
    expect(groups.map((g) => g.label)).toContain(t('food.category.dairy', undefined, 'is'));
    const names = groups.flatMap((g) => g.items.map((i) => i.name));
    expect(names).toContain(ingredientDisplayName('skyr-plain', 'is'));
  });

  it('logged entries show the localized catalog name unless the user renamed them', () => {
    const r = RECIPES_BY_ID.get('skyr-oat-pancakes')!;
    expect(entryDisplayName({ name: r.name, source: { kind: 'recipe', refId: r.id } })).toBe('Skyr- og hafrapönnukökur');
    expect(entryDisplayName({ name: `${r.name} (with swaps)`, source: { kind: 'recipe', refId: r.id } })).toBe('Skyr- og hafrapönnukökur (með útskiptum hráefnum)');
    expect(entryDisplayName({ name: 'My pancakes', source: { kind: 'recipe', refId: r.id } })).toBe('My pancakes');
  });
});
