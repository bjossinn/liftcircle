// @vitest-environment jsdom
/**
 * Icelandic copy in the app shell: the four tabs, header actions, Profile shortcuts, Today, the sync/backup banner,
 * the route error boundary, sync error messages and theme options. English stays as it was (see navigation.test.tsx).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  db: null as unknown,
  account: null as unknown,
  auth: 'signed_in' as 'signed_in' | 'guest' | 'expired',
  socialUnread: 0,
  sync: { phase: 'idle', pending: 0, conflicts: 0, failing: 0 } as Record<string, unknown>,
}));
vi.mock('@/state/app', () => ({
  useApp: () => ({
    db: h.db,
    account: h.account,
    accountReady: true,
    auth: { status: h.auth, userId: h.auth === 'signed_in' ? 'me' : undefined },
    online: true,
    backendConfigured: true,
    updateAccount: async () => undefined,
  }),
  useDb: () => h.db,
  useSettings: () => (h.account as { settings: unknown }).settings,
}));
vi.mock('@/features/social/useUnreadCount', () => ({ useUnreadCount: () => h.socialUnread }));
vi.mock('@/sync/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/sync/engine')>()),
  useSyncStatus: () => h.sync,
}));

const { setLanguage } = await import('@/i18n');
const { LiftDb } = await import('@/db/db');
const { StorageWriteError } = await import('@/db/repo');
const { defaultAccountState } = await import('@/state/defaults');
const { mainTabs } = await import('@/app/Shell');
const { TopActions } = await import('@/app/TopActions');
const { RouteError } = await import('@/app/RouteError');
const { ProfileShortcuts } = await import('@/features/social/ProfilePage');
const TodayPage = (await import('@/features/today/TodayPage')).default;
const { greeting } = await import('@/features/today/TodayPage');
const { SyncStatusBanner } = await import('@/sync/SyncStatus');
const { toBackendError } = await import('@/backend/syncRemote');
const { ToastProvider } = await import('@/components/toast');
const { macroLine } = await import('@/features/nutrition/shared');
const { themeLabel, THEME_OPTIONS } = await import('@/theme/theme');

let root: Root | null = null;
let el: HTMLDivElement | null = null;
let dbCount = 0;
const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const tick = (ms = 20) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
async function waitFor<T>(fn: () => T, tries = 150): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return fn();
    } catch (e) {
      if (i >= tries) throw e;
      await tick();
    }
  }
}
async function mount(node: ReactElement) {
  el = document.createElement('div');
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(node));
}
const render = (node: ReactElement, path = '/') => mount(createElement(ToastProvider, null, createElement(MemoryRouter, { initialEntries: [path] }, node)));

beforeEach(() => {
  h.db = new LiftDb(`i18n-shell-${++dbCount}`);
  h.account = defaultAccountState();
  h.auth = 'signed_in';
  h.socialUnread = 0;
  h.sync = { phase: 'idle', pending: 0, conflicts: 0, failing: 0 };
  setLanguage('is');
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  el?.remove();
  setLanguage('en');
});

describe('Icelandic shell', () => {
  it('the four tabs are Í dag · Æfingar · Þjálfari · Framfarir (and back to English)', () => {
    expect(mainTabs().map((t) => [t.label, t.to])).toEqual([
      ['Í dag', '/'],
      ['Æfingar', '/train'],
      ['Þjálfari', '/coach'],
      ['Framfarir', '/progress'],
    ]);
    setLanguage('en');
    expect(mainTabs().map((t) => t.label)).toEqual(['Today', 'Train', 'Coach', 'Progress']);
  });

  it('header actions: Prófíll and Tilkynningar with an unread count', async () => {
    h.socialUnread = 3;
    await render(createElement(TopActions));
    expect(el!.querySelector('a[href="/profile"]')!.getAttribute('aria-label')).toBe('Prófíll');
    expect(el!.querySelector('a[href="/profile"]')!.getAttribute('title')).toBe('Prófíll, næring, vinir og stillingar');
    expect(el!.querySelector('a[href="/notifications"]')!.getAttribute('aria-label')).toBe('Tilkynningar, ólesnar: 3');
  });

  it('Profile shortcuts: Næring, Vinir, Stillingar', async () => {
    await render(createElement(ProfileShortcuts));
    expect(el!.querySelector('nav')!.getAttribute('aria-label')).toBe('Flýtileiðir á prófíl');
    const text = norm(el!.textContent);
    for (const s of ['Næring', 'Vinir', 'Stillingar']) expect(text).toContain(s);
  });

  it('Today: quick actions, this week and the setup card', async () => {
    await render(createElement(TodayPage));
    const link = await waitFor(() => {
      const a = el!.querySelector<HTMLAnchorElement>('a[href="/nutrition"]');
      if (!a) throw new Error('no nutrition link');
      return a;
    });
    expect(norm(link.textContent)).toBe('Fylgjast með próteini');
    const text = norm(el!.textContent);
    expect(text).toContain('Gaman að sjá þig í Hard Earned');
    for (const s of ['Setja upp æfingaáætlun', 'Byrja æfingu frá grunni', 'Þessi vika', 'Skrá hreyfingu', 'Lotutímamælir']) expect(text).toContain(s);
    expect(el!.querySelector('[aria-label="Dagar þessarar viku"]')).not.toBeNull();
    expect(['Góðan morgun', 'Góðan dag', 'Gott kvöld']).toContain(norm(el!.querySelector('h1')!.textContent));
  });

  it('time-of-day greetings come from the dictionary', () => {
    expect([greeting(8), greeting(14), greeting(22)]).toEqual(['Góðan morgun', 'Góðan dag', 'Gott kvöld']);
    setLanguage('en');
    expect([greeting(8), greeting(14), greeting(22)]).toEqual(['Good morning', 'Good afternoon', 'Good evening']);
  });

  it('sync banner: paused with pending changes, and conflicts with Icelandic plurals (1, 21 → one; 2, 11 → other)', async () => {
    h.sync = { phase: 'paused_auth', pending: 2, conflicts: 0, failing: 0 };
    await render(createElement(SyncStatusBanner));
    expect(norm(el!.textContent)).toBe(
      'Öryggisafritun er í bið. Skráðu þig aftur inn til að halda áfram. Breytingar í bið: 2. Gögnin þín eru örugg á þessu tæki.',
    );
    await act(async () => root!.unmount());
    el!.remove();
    for (const [n, expected] of [
      [1, '1 færslu var breytt á tveimur tækjum. Veldu hvora útgáfuna á að geyma.'],
      [21, '21 færslu var breytt á tveimur tækjum. Veldu hvora útgáfuna á að geyma.'],
      [11, '11 færslum var breytt á tveimur tækjum. Veldu hvaða útgáfur á að geyma.'],
    ] as const) {
      h.sync = { phase: 'idle', pending: 0, conflicts: n, failing: 0 };
      await render(createElement(SyncStatusBanner));
      expect(norm(el!.textContent)).toBe(expected);
      await act(async () => root!.unmount());
      el!.remove();
    }
    root = null;
    h.sync = { phase: 'idle', pending: 0, conflicts: 0, failing: 3 };
    await render(createElement(SyncStatusBanner));
    expect(norm(el!.textContent)).toBe('Ekki tókst að taka öryggisafrit af öllum breytingum. Ýttu hér til að reyna aftur.');
  });

  it('sync errors: app-authored messages are Icelandic; codes are unchanged', () => {
    const offline = toBackendError(new TypeError('Failed to fetch'));
    expect(offline.message).toBe('Þú virðist vera án nettengingar. Athugaðu tenginguna og reyndu aftur.');
    expect(offline.isNetwork).toBe(true);
    const expired = toBackendError({ message: 'JWT expired' });
    expect(expired.message).toBe('Innskráningin þín er útrunnin. Skráðu þig aftur inn.');
    expect(expired.isAuth).toBe(true);
    expect(toBackendError({}).message).toBe('Eitthvað fór úrskeiðis. Reyndu aftur.');
    expect(new StorageWriteError(new Error('QuotaExceededError')).message).toBe(
      'Ekki tókst að vista á þessu tæki. Geymslupláss vafrans gæti verið fullt eða lokað fyrir vistun.',
    );
    setLanguage('en');
    expect(toBackendError({}).message).toBe('Something went wrong. Please try again.');
  });

  it('route error boundary uses the device language without providers', async () => {
    const Boom = () => {
      throw new Error('boom');
    };
    const router = createMemoryRouter([{ path: '/', element: createElement(Boom), errorElement: createElement(RouteError) }]);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await mount(createElement(RouterProvider, { router }));
    spy.mockRestore();
    const text = norm(el!.textContent);
    expect(text).toContain('Eitthvað fór úrskeiðis');
    expect(text).toContain('Vistaðar æfingar eru öruggar á þessu tæki. Prófaðu að endurhlaða.');
    expect(text).toContain('Reyna aftur');
  });

  it('macro line and theme labels', () => {
    expect(macroLine({ kcal: 420, protein: 32, carbs: 40, fat: 12 })).toBe('420 kcal · 32 g prótein · 40 g kolvetni · 12 g fita');
    expect([themeLabel('dark'), themeLabel('light'), themeLabel('system')]).toEqual(['Dökkt', 'Ljóst', 'Fylgja símanum']);
    expect(THEME_OPTIONS[0].description).toBe('Kolgrátt með hlýjum glóðarlitum');
  });
});
