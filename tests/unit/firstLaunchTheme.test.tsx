// @vitest-environment jsdom
/**
 * First launch no longer stops at a "Pick your look" theme picker: a brand-new device goes straight into the welcome
 * on Match my phone, and the theme is still chosen in Settings → Appearance (real Shell, Today and Settings screens,
 * real Dexie via fake-indexeddb). Existing users keep the theme saved in their account.
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
  h.db = new LiftDb(`first-launch-${Math.random().toString(36).slice(2)}`);
  await h.db.open();
});
afterEach(async () => {
  await act(async () => root.unmount());
  el.remove();
  h.db.close();
  await h.db.delete();
});

describe('first launch without a theme picker', () => {
  it('a brand-new device goes straight to the welcome; Settings → Appearance shows Match my phone and still changes the theme', async () => {
    await mount('/');
    await waitFor(() => expect(el.textContent).toContain('Set up my plan'));
    expect(el.textContent).not.toContain('Pick your look');
    expect(el.querySelector('[role="radiogroup"]')).toBeNull();

    // Item 11: the legacy #appearance-title anchor opens the "Language & display" group.
    await act(async () => router.navigate('/settings#appearance-title'));
    await waitFor(() => expect(el.querySelector('#appearance-title')).toBeTruthy());
    const appearance = () => el.querySelector('[role="radiogroup"][aria-labelledby="appearance-title"]')!;
    const checked = () => [...appearance().querySelectorAll('[role="radio"]')].find((r) => r.getAttribute('aria-checked') === 'true')?.getAttribute('aria-label');
    expect(checked()).toMatch(/Match/);

    const light = [...appearance().querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((r) => r.getAttribute('aria-label') === 'Light')!;
    await act(async () => light.click());
    await waitFor(async () => expect((await h.db.account.get(ACCOUNT_ROW_ID))?.settings.theme).toBe('light'));
    await waitFor(() => expect(checked()).toBe('Light'));
  });

  it('an existing user keeps the theme saved in their account and is never interrupted', async () => {
    const { defaultAccountState } = await import('@/state/defaults');
    const { saveRecord } = await import('@/db/repo');
    const acct = defaultAccountState();
    await saveRecord('account_state', { ...acct, settings: { ...acct.settings, theme: 'dark' } }, h.db);
    await mount('/');
    await waitFor(() => expect(el.textContent).toContain('Set up my plan'));
    expect(el.textContent).not.toContain('Pick your look');
    expect((await h.db.account.get(ACCOUNT_ROW_ID))?.settings.theme).toBe('dark');
  });
});
