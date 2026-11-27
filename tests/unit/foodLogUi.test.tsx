// @vitest-environment jsdom
/**
 * Roadmap item 11 — Food Log: lands on Recent with Quick protein first; presets log one ordinary protein-only quick
 * entry atomically (with its outbox op) on the deep-linked date/meal; invalid/future deep links are normalized;
 * "Other amount" focuses the manual form without logging; a slow double tap writes once; a failed write keeps state
 * and can be retried; multi-entry logs are all-or-nothing; repeats keep the stored snapshot; EN/IS copy renders.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    online: false,
    backendConfigured: true,
    updateAccount: async () => undefined,
  }),
}));

import { ToastProvider } from '@/components/toast';
import { LiftDb } from '@/db/db';
import { newRecord, saveRecord } from '@/db/repo';
import { LanguageProvider, setLanguage, type Language } from '@/i18n';
import { defaultAccountState } from '@/state/defaults';
import { todayISO, addDays } from '@/lib/dates';
import { recentItems, recentKey, normalizeLogDate, quickProteinDraft, defaultMealAt } from '@/domain/nutrition/log';
import type { AccountState, FoodLogEntry, SavedMeal } from '@/domain/types';
import FoodLogPage from '@/features/nutrition/FoodLogPage';

const dialogProto = HTMLDialogElement.prototype as unknown as { showModal: () => void; close: () => void };
dialogProto.showModal = function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};
dialogProto.close = function (this: HTMLDialogElement) {
  this.removeAttribute('open');
};

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const text = () => norm(document.body.textContent);
let root: Root | null = null;
let container: HTMLElement | null = null;
let db: LiftDb;

function mount(url: string, language: Language = 'en') {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      createElement(LanguageProvider, {
        language,
        children: createElement(ToastProvider, null, createElement(MemoryRouter, { initialEntries: [url] }, createElement(FoodLogPage))),
      }),
    ),
  );
}
async function waitFor<T>(fn: () => T | Promise<T>, tries = 200): Promise<T> {
  for (;; tries--) {
    try {
      return await fn();
    } catch (e) {
      if (tries <= 0) throw e;
      await act(async () => {
        await new Promise((r) => setTimeout(r, 15));
      });
    }
  }
}
const button = (label: string) => {
  const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === label || norm(x.textContent) === label);
  expect(b, label).toBeTruthy();
  return b as HTMLButtonElement;
};
const click = (b: HTMLElement) => act(() => void b.dispatchEvent(new MouseEvent('click', { bubbles: true })));
const tabs = () => [...document.querySelectorAll('[role="tab"]')] as HTMLButtonElement[];
const selectedTab = () => tabs().find((x) => x.getAttribute('aria-selected') === 'true')?.id;
const alive = async () => (await db.foodLogs.toArray()).filter((e) => !e.deletedAt);

function account(): AccountState {
  const a = defaultAccountState();
  a.settings = { ...a.settings, timeZone: 'UTC', nutritionEnabled: false };
  return a;
}

beforeEach(() => {
  db = new LiftDb(`user-${Math.random().toString(36).slice(2)}`);
  h.db = db;
  h.account = account();
  setLanguage('en');
});
afterEach(async () => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  await db.delete();
  setLanguage('en');
  vi.restoreAllMocks();
});

const TODAY = () => todayISO('UTC');

describe('Food log landing and tabs', () => {
  it('defaults to Recent (also for an invalid tab), shows all six tabs in order, Quick protein first', async () => {
    mount('/nutrition/log?tab=nope');
    expect(tabs().map((x) => x.id)).toEqual(['tab-recent', 'tab-quick', 'tab-foods', 'tab-recipes', 'tab-custom', 'tab-saved']);
    expect(selectedTab()).toBe('tab-recent');
    expect(tabs().map((x) => x.tabIndex)).toEqual([0, -1, -1, -1, -1, -1]);
    const panel = document.querySelector('[role="tabpanel"]')!;
    expect(panel.getAttribute('aria-labelledby')).toBe('tab-recent');
    expect(norm(panel.textContent).startsWith('Quick protein')).toBe(true);
    // Usable while/after Recent loads, with exactly one Recent empty state.
    expect(button('Add 20 g protein').textContent).toBe('+20 g');
    await waitFor(() => expect(text()).toContain('Nothing recent'));
    expect(text().match(/Nothing recent/g)).toHaveLength(1);
  });

  it('every valid tab id keeps its meaning; Arrow/Home/End move the roving focus', async () => {
    for (const id of ['quick', 'foods', 'recipes', 'custom', 'saved', 'recent']) {
      mount(`/nutrition/log?tab=${id}`);
      expect(selectedTab()).toBe(`tab-${id}`);
      act(() => root!.unmount());
      container!.remove();
      root = null;
    }
    mount('/nutrition/log');
    const first = tabs()[0];
    first.focus();
    act(() => void first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(selectedTab()).toBe('tab-quick');
    expect(document.activeElement?.id).toBe('tab-quick');
    act(() => void document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
    expect(selectedTab()).toBe('tab-saved');
    act(() => void document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
    expect(selectedTab()).toBe('tab-recent');
  });
});

describe('Quick protein', () => {
  it('one tap logs one protein-only quick entry on the deep-linked date/meal, with its outbox op', async () => {
    const day = addDays(TODAY(), -2);
    mount(`/nutrition/log?date=${day}&meal=dinner`);
    click(button('Add 30 g protein'));
    await waitFor(async () => expect((await alive()).length).toBe(1));
    const [e] = await alive();
    expect(e).toMatchObject({ name: 'Quick protein · 30 g', source: { kind: 'quick' }, protein: 30, date: day, meal: 'dinner' });
    for (const k of ['kcal', 'carbs', 'fat', 'grams', 'servings'] as const) expect(k in e, k).toBe(false);
    const ops = await db.outbox.toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ entity: 'food_logs', recordId: e.id, op: 'upsert' });
    await waitFor(() => expect(text()).toMatch(/Added: Quick protein · 30 g\. Dinner · /));
    expect(text()).toContain('View day');
  });

  it('all presets log distinct amounts and the Recent list keeps them apart', async () => {
    mount('/nutrition/log');
    for (const g of [20, 30, 40]) {
      click(button(`Add ${g} g protein`));
      await waitFor(async () => expect((await alive()).filter((x) => x.protein === g)).toHaveLength(1));
    }
    await waitFor(() => expect([...document.querySelectorAll('[aria-label^="Log Quick protein"]')]).toHaveLength(3));
  });

  it('normalizes a future date and an invalid meal before writing', async () => {
    mount(`/nutrition/log?date=${addDays(TODAY(), 5)}&meal=brunch`);
    expect((document.getElementById('log-date') as HTMLInputElement).value).toBe(TODAY());
    click(button('Add 20 g protein'));
    await waitFor(async () => expect((await alive()).length).toBe(1));
    const [e] = await alive();
    expect(e.date).toBe(TODAY());
    expect(['breakfast', 'lunch', 'dinner', 'snack']).toContain(e.meal);
    expect(e.meal).toBe(defaultMealAt(new Date().getUTCHours()));
  });

  it('"Other amount" opens Quick entry and focuses protein without logging', async () => {
    mount('/nutrition/log');
    click(button('Other amount'));
    expect(selectedTab()).toBe('tab-quick');
    await waitFor(() => expect(document.activeElement?.id).toBe('food-log-quick-protein'));
    expect(await db.foodLogs.count()).toBe(0);
  });

  it('a double tap during a pending write stores one entry; after completion a new tap is valid', async () => {
    mount('/nutrition/log');
    const b = button('Add 40 g protein');
    act(() => {
      b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitFor(async () => expect((await alive()).length).toBe(1));
    await waitFor(() => expect(button('Add 40 g protein').disabled).toBe(false));
    click(button('Add 40 g protein'));
    await waitFor(async () => expect((await alive()).length).toBe(2));
  });

  it('a failed write shows the error, keeps the manual form, and a retry succeeds', async () => {
    mount('/nutrition/log?tab=quick');
    const spy = vi.spyOn(db, 'transaction').mockImplementationOnce((() => Promise.reject(new Error('quota'))) as never);
    const input = document.getElementById('food-log-quick-protein') as HTMLInputElement;
    act(() => {
      input.focus();
      input.value = '25';
      input.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      input.blur();
    });
    click(button('Add'));
    await waitFor(() => expect(text()).toContain('Could not save. Please try again.'));
    expect(await db.foodLogs.count()).toBe(0);
    expect((document.getElementById('food-log-quick-protein') as HTMLInputElement).value).toBe('25');
    spy.mockRestore();
    click(button('Add'));
    await waitFor(async () => expect((await alive()).map((x) => x.protein)).toEqual([25]));
  });
});

describe('Atomic multi-entry logging and repeats', () => {
  it('a saved meal is all-or-nothing: a failing item rolls the whole batch back', async () => {
    const meal = newRecord<Omit<SavedMeal, 'id' | 'createdAt' | 'updatedAt'>>({
      name: 'Breakfast usual',
      items: [
        { name: 'A', source: { kind: 'quick' }, protein: 10 },
        { name: 'B', source: { kind: 'quick' }, protein: 0 },
      ],
    });
    await saveRecord('saved_meals', meal, db);
    db.foodLogs.hook('creating', (_k, obj: FoodLogEntry) => {
      if (obj.name === 'B') throw new Error('boom');
    });
    mount('/nutrition/log?tab=saved');
    await waitFor(() => button('Log Breakfast usual'));
    click(button('Log Breakfast usual'));
    await waitFor(() => expect(text()).toContain('Could not save. Please try again.'));
    expect(await db.foodLogs.count()).toBe(0);
    expect((await db.outbox.toArray()).filter((o) => o.entity === 'food_logs')).toHaveLength(0);
  });

  it('"Copy previous meal" holds the guard across a slow read and the write: a double tap copies once', async () => {
    const yesterday = addDays(TODAY(), -1);
    await db.foodLogs.bulkPut([newRecord({ name: 'Skyr', source: { kind: 'quick' as const }, protein: 17, date: yesterday, meal: 'lunch' as const })]);
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const orig = db.foodLogs.where.bind(db.foodLogs);
    vi.spyOn(db.foodLogs, 'where').mockImplementation(((key: string) => {
      const real = orig(key);
      // Delay only the copy's equals() read; Recent's between() query passes straight through.
      return Object.assign(Object.create(real), {
        equals: (v: string) => ({ toArray: async () => { await gate; return real.equals(v).toArray(); } }),
      });
    }) as never);
    mount(`/nutrition/log?date=${TODAY()}&meal=lunch`);
    const copy = button('Copy this meal from the previous day');
    act(() => {
      copy.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      copy.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(button('Copy this meal from the previous day').disabled).toBe(true);
    await act(async () => open());
    await waitFor(async () => expect((await alive()).filter((e) => e.date === TODAY())).toHaveLength(1));
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect((await alive()).filter((e) => e.date === TODAY())).toHaveLength(1);
    await waitFor(() => expect(button('Copy this meal from the previous day').disabled).toBe(false));
    // After completion a new, intentional tap is valid again.
    click(button('Copy this meal from the previous day'));
    await waitFor(async () => expect((await alive()).filter((e) => e.date === TODAY())).toHaveLength(2));
  });

  it('repeating a Recent item keeps the stored snapshot exactly (no recalculation) and ignores tombstones', async () => {
    const old: FoodLogEntry = newRecord({
      name: 'Old recipe name',
      source: { kind: 'recipe' as const, refId: 'does-not-matter' },
      servings: 1.5,
      kcal: 512,
      protein: 41.3,
      date: addDays(TODAY(), -3),
      meal: 'lunch' as const,
    });
    const gone: FoodLogEntry = newRecord({ name: 'Deleted thing', source: { kind: 'quick' as const }, protein: 9, date: TODAY(), meal: 'snack' as const, deletedAt: 5 });
    await db.foodLogs.bulkPut([old, gone]);
    mount('/nutrition/log');
    await waitFor(() => button('Log Old recipe name again'));
    expect(text()).not.toContain('Deleted thing');
    click(button('Log Old recipe name again'));
    await waitFor(async () => expect((await alive()).length).toBe(2));
    const copy = (await alive()).find((e) => e.id !== old.id)!;
    expect(copy).toMatchObject({ name: 'Old recipe name', source: { kind: 'recipe', refId: 'does-not-matter' }, servings: 1.5, kcal: 512, protein: 41.3 });
    expect('carbs' in copy).toBe(false);
  });
});

describe('Food log in Icelandic', () => {
  it('renders the approved copy for tabs, Quick protein and the manual form', async () => {
    setLanguage('is');
    mount('/nutrition/log', 'is');
    expect(tabs().map((x) => norm(x.textContent))).toEqual(['Nýlega skráð', 'Flýtiskráning', 'Matvæli', 'Uppskriftir', 'Mín matvæli', 'Vistaðar máltíðir']);
    expect(text()).toContain('Skrá prótein');
    expect(text()).toContain('Afrita þessa máltíð frá deginum áður');
    click(button('Skrá 20 g af próteini'));
    await waitFor(async () => expect((await alive()).map((e) => e.name)).toEqual(['Prótein · 20 g']));
    click(button('Annað magn'));
    expect(text()).toContain('Gildi sem þú skilur eftir auð eru óþekkt, ekki núll.');
    expect(text()).toContain('Kolvetni (valfrjálst)');
    expect(text()).not.toMatch(/Quick|Recent|Values you leave/);
  });

  it('localizes the foods sheet (state, measures, source label)', async () => {
    setLanguage('is');
    mount('/nutrition/log?tab=foods', 'is');
    expect(text()).toContain('Í 100 g:');
    const egg = [...document.querySelectorAll('li button')].find((b) => /egg/i.test(b.textContent ?? '')) as HTMLElement | undefined;
    if (egg) {
      click(egg);
      expect(text()).toContain('Heimild:');
      expect(text()).toMatch(/1 stykki \(\d+ g\)/);
    }
  });
});

describe('pure helpers', () => {
  it('quick-entry identity keeps 20/30/40 g and missing-versus-zero apart', () => {
    const mk = (over: Partial<FoodLogEntry>, at: number): FoodLogEntry =>
      ({ id: String(at), createdAt: at, updatedAt: at, date: '2026-01-01', meal: 'snack', name: 'Quick protein · 20 g', source: { kind: 'quick' }, ...over }) as FoodLogEntry;
    const rows = [mk({ protein: 20 }, 1), mk({ protein: 30 }, 2), mk({ protein: 40 }, 3), mk({ protein: 20 }, 4), mk({ protein: 20, kcal: 0 }, 5)];
    const out = recentItems(rows, 25);
    expect(out.map((e) => e.id)).toEqual(['5', '4', '3', '2']);
    expect(recentKey(mk({ protein: 20 }, 1))).not.toBe(recentKey(mk({ protein: 20, kcal: 0 }, 1)));
    expect(recentKey(mk({ protein: 0 }, 1))).not.toBe(recentKey(mk({}, 1)));
  });
  it('normalizes dates and builds protein-only drafts', () => {
    expect(normalizeLogDate('2026-02-30', '2026-03-01')).toBe('2026-03-01');
    expect(normalizeLogDate('2026-03-02', '2026-03-01')).toBe('2026-03-01');
    expect(normalizeLogDate('2026-02-28', '2026-03-01')).toBe('2026-02-28');
    expect(normalizeLogDate(null, '2026-03-01')).toBe('2026-03-01');
    expect(quickProteinDraft(30, 'x')).toEqual({ name: 'x', source: { kind: 'quick' }, protein: 30 });
  });
});
