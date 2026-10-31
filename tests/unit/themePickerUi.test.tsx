// @vitest-environment jsdom
/**
 * First-launch "Pick your look" through the real Shell, Today and Settings screens (real Dexie via fake-indexeddb;
 * the app context reads the account row live, like AppProvider does). Selecting a card applies the theme to the
 * whole page at once, Continue saves it and leads into the welcome, Settings → Appearance shows the same choice,
 * and it never comes back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { LiftDb, ACCOUNT_ROW_ID } from '@/db/db';
import type { AccountState } from '@/domain/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ db: null as unknown as import('@/db/db').LiftDb }));
vi.mock('@/state/app', async () => {
  const { useLiveQuery } = await import('dexie-react-hooks');
  const { defaultAccountState } = await import('@/state/defaults');
  const { saveRecord } = await import('@/db/repo');
  const { ACCOUNT_ROW_ID: ROW } = await import('@/db/db');
  const useApp = () => {
    const row = useLiveQuery(async () => (await h.db.account.get(ROW)) ?? null, [h.db]);
    const account = row ?? defaultAccountState();
    return {
      db: h.db,
      auth: { status: 'guest' as const },
      account,
      accountReady: row !== undefined,
      online: true,
      backendConfigured: false,
      updateAccount: async (fn: (a: AccountState) => AccountState) => {
        const cur = (await h.db.account.get(ROW)) ?? defaultAccountState();
        await saveRecord('account_state', fn(cur), h.db);
      },
      finishSignOut: () => undefined,
    };
  };
  return { useApp, useDb: () => h.db, useSettings: () => useApp().account.settings, isDemoMode: () => false, DEMO_KEY: 'lc-demo' };
});

const { Shell } = await import('@/app/Shell');
const TodayPage = (await import('@/features/today/TodayPage')).default;
const SettingsPage = (await import('@/features/settings/SettingsPage')).default;
const { ToastProvider } = await import('@/components/toast');

let root: Root;
let el: HTMLDivElement;
let router: ReturnType<typeof createMemoryRouter>;
const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await act(async () => new Promise((r) => setTimeout(r, 20)));
};
async function waitFor<T>(fn: () => T, tries = 150): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return fn();
    } catch (e) {
      if (i >= tries) throw e;
      await act(async () => new Promise((r) => setTimeout(r, 20)));
    }
  }
}
const radio = (name: RegExp) => [...el.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => name.test(b.getAttribute('aria-label') ?? ''))!;
const button = (label: string) => [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label)!;

async function mount(path = '/') {
  el = document.createElement('div');
  document.body.append(el);
  root = createRoot(el);
  router = createMemoryRouter(
    [{ element: createElement(Shell), children: [{ path: '/', element: createElement(TodayPage) }, { path: '/settings', element: createElement(SettingsPage) }] }],
    { initialEntries: [path] },
  );
  await act(async () => root.render(createElement(ToastProvider, null, createElement(RouterProvider, { router }))));
  await flush();
}

beforeEach(async () => {
  localStorage.clear();
  document.documentElement.dataset.theme = 'dark';
  h.db = new LiftDb(`picker-${Math.random().toString(36).slice(2)}`);
  await h.db.open();
});
afterEach(async () => {
  await act(async () => root.unmount());
  el.remove();
  h.db.close();
  await h.db.delete();
});

describe('first-launch theme picker', () => {
  it('applies a card live, Continue saves it and leads into the welcome, Settings shows the same choice, never shown again', async () => {
    await mount('/');
    const heading = await waitFor(() => {
      const hd = el.querySelector('h1');
      expect(hd?.textContent).toBe('Pick your look');
      return hd!;
    });
    // A proper heading names the radio group; focus starts on it.
    expect(document.activeElement).toBe(heading);
    const group = el.querySelector('[role="radiogroup"]')!;
    expect(group.getAttribute('aria-labelledby')).toBe(heading.id);
    expect([...group.querySelectorAll('[role="radio"]')].map((r) => r.getAttribute('aria-label'))).toEqual(['Dark', 'Light', 'Match my phone']);
    // Each option is described too, and its preview is hidden from screen readers.
    expect(document.getElementById(radio(/^Light/).getAttribute('aria-describedby')!)?.textContent).toBe('Chalk with ember accents');
    expect(radio(/^Light/).querySelector('[data-theme="light"]')?.getAttribute('aria-hidden')).toBe('true');
    // Default: Match my phone, and it's the only tab stop.
    expect(radio(/Match my phone/).getAttribute('aria-checked')).toBe('true');
    expect(radio(/Match my phone/).tabIndex).toBe(0);
    expect(radio(/^Dark/).tabIndex).toBe(-1);
    expect(el.textContent).toContain('You can change this anytime in Settings → Appearance.');

    // Tapping Light applies it to the whole page immediately.
    await act(async () => radio(/^Light/).click());
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(radio(/^Light/).getAttribute('aria-checked')).toBe('true');
    // Arrow keys move like native radios (and apply as they go).
    await act(async () => radio(/^Light/).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
    expect(radio(/^Dark/).getAttribute('aria-checked')).toBe('true');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.activeElement).toBe(radio(/^Dark/));
    await act(async () => radio(/^Light/).click());
    // Nothing is saved until Continue (closing the app now would show the picker again).
    expect(localStorage.getItem('lc-theme-picked')).toBeNull();

    await act(async () => button('Continue').click());
    await waitFor(() => expect(el.textContent).toContain('Set up my plan'));
    expect(el.textContent).not.toContain('Pick your look');
    expect(localStorage.getItem('lc-theme-picked')).toBe('1');
    expect((await h.db.account.get(ACCOUNT_ROW_ID))?.settings.theme).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');

    await act(async () => router.navigate('/settings'));
    await waitFor(() => expect(el.querySelector('#appearance-title')).toBeTruthy());
    const appearance = el.querySelector('[role="radiogroup"][aria-labelledby="appearance-title"]')!;
    const checked = [...appearance.querySelectorAll('[role="radio"]')].find((r) => r.getAttribute('aria-checked') === 'true');
    expect(checked?.getAttribute('aria-label')).toBe('Light');

    // Refresh: not shown again.
    await act(async () => root.unmount());
    el.remove();
    await mount('/');
    await waitFor(() => expect(el.textContent).toContain('Set up my plan'));
    expect(el.textContent).not.toContain('Pick your look');
  });

  it('an existing user with a theme in their settings goes straight in, in that theme', async () => {
    const { defaultAccountState } = await import('@/state/defaults');
    const { saveRecord } = await import('@/db/repo');
    const acct = defaultAccountState();
    await saveRecord('account_state', { ...acct, settings: { ...acct.settings, theme: 'light' } }, h.db);
    await mount('/');
    await waitFor(() => expect(el.textContent).toContain('Set up my plan'));
    expect(el.textContent).not.toContain('Pick your look');
  });
});
