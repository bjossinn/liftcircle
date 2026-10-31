// @vitest-environment jsdom
/**
 * Recipes list (Quick chip) and the recipe screen: section order, tick-off checkboxes, wake lock, and the
 * "Add to meal plan…" / favourites buttons. Same mini harness as the other UI tests (react-dom/client + act;
 * real Dexie via fake-indexeddb).
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
import { QUICK_MINUTES, recipeMinutes } from '@/domain/nutrition/recipes';
import type { AccountState } from '@/domain/types';
import RecipesPage from '@/features/nutrition/RecipesPage';
import RecipeDetailPage from '@/features/nutrition/RecipeDetailPage';

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
          ),
        ),
      ),
    ),
  );
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
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
const buttons = () => [...document.querySelectorAll('button')];
const button = (name: string | RegExp) => {
  const b = buttons().find((x) => {
    const n = norm(x.getAttribute('aria-label') || x.textContent);
    return typeof name === 'string' ? n === name : name.test(n);
  });
  if (!b) throw new Error(`no button ${name}`);
  return b;
};
const checkbox = (label: string) => {
  const c = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((x) => x.getAttribute('aria-label') === label);
  if (!c) throw new Error(`no checkbox ${label}`);
  return c;
};

let release: ReturnType<typeof vi.fn>;
let request: ReturnType<typeof vi.fn>;
beforeEach(() => {
  h.db = new LiftDb(`recipes-ui-${Date.now()}-${Math.random()}`);
  const base = defaultAccountState();
  h.account = { ...base, settings: { ...base.settings, nutritionEnabled: true } } satisfies AccountState;
  const proto = HTMLDialogElement.prototype as unknown as { showModal: () => void; close: () => void };
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  proto.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  release = vi.fn(async () => undefined);
  request = vi.fn(async () => ({ release }));
  Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true });
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});
afterEach(async () => {
  unmount();
  await (h.db as LiftDb).delete();
});

describe('RecipesPage', () => {
  it('the Quick chip keeps only recipes with prep + cook ≤ 15 min and combines with the diet filters', async () => {
    mount('/nutrition/recipes');
    const countText = () => norm(document.querySelector('p[aria-live="polite"]')?.textContent).match(/^(\d+) recipes?$/)?.[1];
    expect(countText()).toBe(String(RECIPES.length));
    const quick = button(/^Quick \(≤ 15 min\)$/);
    expect(quick.getAttribute('aria-checked')).toBe('false');
    click(quick);
    expect(quick.getAttribute('aria-checked')).toBe('true');
    const expected = RECIPES.filter((r) => recipeMinutes(r) <= QUICK_MINUTES);
    expect(expected.length).toBeGreaterThan(20);
    expect(expected.length).toBeLessThan(RECIPES.length);
    await waitFor(() => expect(countText()).toBe(String(expected.length)));
    // The list renders 60 at a time; open the rest.
    for (let more = buttons().find((b) => /^Show more/.test(norm(b.textContent))); more; more = buttons().find((b) => /^Show more/.test(norm(b.textContent)))) click(more);
    const shown = [...document.querySelectorAll('a[href^="/nutrition/recipes/"]')].map((a) => decodeURIComponent(a.getAttribute('href')!.split('/').pop()!));
    expect(shown.sort()).toEqual(expected.map((r) => r.id).sort());
    for (const id of shown) expect(recipeMinutes(RECIPES_BY_ID.get(id)!)).toBeLessThanOrEqual(15);
    // Combines with the other filters: quick vegan recipes.
    click(button('Vegan'));
    await waitFor(() => expect(Number(countText() ?? 0)).toBeLessThan(expected.length));
    click(quick);
    click(button('Vegan'));
    await waitFor(() => expect(countText()).toBe(String(RECIPES.length)));
  });
});

describe('RecipeDetailPage', () => {
  it('shows time, servings, macros, ingredients, steps, substitutions and notes in that order, then the actions', async () => {
    mount('/nutrition/recipes/egg-veg-muffins');
    const order = [...document.querySelectorAll('section[data-section]')].map((s) => s.getAttribute('data-section'));
    expect(order).toEqual(['time', 'servings', 'macros', 'ingredients', 'steps', 'substitutions', 'notes']);
    const headings = [...document.querySelectorAll('section[data-section] h2')].map((x) => norm(x.textContent));
    expect(headings).toEqual(['Time', 'Servings', 'Per serving', 'Ingredients', 'How to make it', 'Substitutions', 'Notes']);
    const recipe = RECIPES_BY_ID.get('egg-veg-muffins')!;
    const time = norm(document.querySelector('section[data-section="time"]')!.textContent);
    expect(time).toContain(`${recipe.prepMinutes + recipe.cookMinutes} min`);
    expect(time).toContain(`${recipe.prepMinutes} min prep + ${recipe.cookMinutes} min cook`);
    expect(document.querySelectorAll('section[data-section="steps"] li')).toHaveLength(recipe.steps.length);
    expect(norm(document.querySelector('section[data-section="notes"]')!.textContent)).toContain(recipe.notes!);
    // Actions come after the content.
    const notes = document.querySelector('section[data-section="notes"]')!;
    for (const name of ['Add to meal plan…', 'Log this meal', 'Save to favourites']) {
      const b = button(name);
      expect(notes.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // Servings selector scales the recipe.
    click(button('More servings'));
    expect(norm(document.querySelector('[data-testid="servings-value"]')!.textContent)).toBe('5');
  });

  it('ingredients and steps tick off locally', async () => {
    mount('/nutrition/recipes/tuna-white-bean-salad');
    const recipe = RECIPES_BY_ID.get('tuna-white-bean-salad')!;
    const ingBoxes = document.querySelectorAll<HTMLInputElement>('section[data-section="ingredients"] input[type="checkbox"]');
    expect(ingBoxes).toHaveLength(recipe.ingredients.length);
    expect([...ingBoxes].every((b) => !b.checked)).toBe(true);
    const ingSection = () => norm(document.querySelector('section[data-section="ingredients"]')!.textContent);
    expect(ingSection()).toContain(`0 of ${recipe.ingredients.length} ticked`);
    const tuna = checkbox('1 can tuna in water, drained');
    click(tuna);
    expect(tuna.checked).toBe(true);
    expect(ingSection()).toContain(`1 of ${recipe.ingredients.length} ticked`);
    expect(tuna.closest('label')!.querySelector('.line-through')).not.toBeNull();
    click(tuna);
    expect(tuna.checked).toBe(false);

    const step1 = checkbox('Step 1 done');
    const step2 = checkbox('Step 2 done');
    click(step2);
    expect(step2.checked).toBe(true);
    expect(step1.checked).toBe(false);
    expect(document.querySelectorAll('section[data-section="steps"] input:checked')).toHaveLength(1);
  });

  it('keeps the screen awake while open and releases the lock on leave', async () => {
    mount('/nutrition/recipes/shakshuka-for-one');
    await waitFor(() => expect(request).toHaveBeenCalledWith('screen'));
    await act(async () => undefined);
    unmount();
    await waitFor(() => expect(release).toHaveBeenCalled());
  });

  it('"Add to meal plan…" adds the recipe to this week\'s plan; "Save to favourites" toggles', async () => {
    mount('/nutrition/recipes/chicken-fajitas-skyr');
    click(button('Add to meal plan…'));
    const add = await waitFor(() => {
      const b = button('Add to plan');
      expect(b.disabled).toBe(false); // the week plan has loaded (none yet)
      return b;
    });
    click(add);
    const db = h.db as LiftDb;
    let plans = await db.mealPlans.toArray();
    for (let i = 0; i < 100 && plans.length === 0; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 15));
      });
      plans = await db.mealPlans.toArray();
    }
    expect(plans).toHaveLength(1);
    const items = plans.flatMap((p) => p.days.flatMap((d) => d.items));
    expect(items).toEqual([expect.objectContaining({ recipeId: 'chicken-fajitas-skyr', slot: 'dinner', servings: 1 })]);

    click(button('Save to favourites'));
    await waitFor(() => expect((h.account as AccountState).favorites.recipes).toContain('chicken-fajitas-skyr'));
  });
});
