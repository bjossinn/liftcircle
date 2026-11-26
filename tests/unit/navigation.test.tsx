// @vitest-environment jsdom
/**
 * Roadmap item 6: four-tab navigation.
 * - Tabs: Today, Train, Coach, Progress (Feed only as a fifth tab when the socialFeed flag is on). Nutrition is no
 *   longer a tab; its routes still work and it's reached from Today (card + quick action) and Profile.
 * - Header: Profile (with Nutrition, Friends, Settings on the Profile page) and Notifications when signed in.
 * - Coach tab (/coach): opens the training assistant directly. A switcher to human coaching (/coaching) appears only
 *   for people with an active, pending or past coach, coaches/applicants, admins, or when the coach marketplace is on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import type { AiSettings, CoachingRelationship, CoachProfile } from '@/backend/coachingContract';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  db: null as unknown,
  account: null as unknown,
  auth: 'signed_in' as 'signed_in' | 'guest',
  backend: true,
  rels: [] as unknown[],
  profile: null as unknown,
  admin: false,
  relsFail: false,
  socialUnread: 0,
}));
vi.mock('@/state/app', () => ({
  useApp: () => ({
    db: h.db,
    account: h.account,
    accountReady: true,
    auth: { status: h.auth, userId: h.auth === 'signed_in' ? 'me' : undefined },
    online: true,
    backendConfigured: h.backend,
    updateAccount: async () => undefined,
  }),
  useDb: () => h.db,
  useSettings: () => (h.account as { settings: unknown }).settings,
}));
vi.mock('@/features/social/useUnreadCount', () => ({ useUnreadCount: () => h.socialUnread }));
vi.mock('@/backend/coaching', () => ({
  coachingApi: {
    myRelationships: async () => {
      if (h.relsFail) throw new Error('offline');
      return h.rels;
    },
    getMyCoachProfile: async () => h.profile,
    myRoles: async () => ({ admin: h.admin, moderator: false }),
    sendMessage: async () => undefined,
  },
}));
const SETTINGS_ON: AiSettings = {
  enabled: true,
  paused: false,
  consentAt: '2026-10-01T10:00:00Z',
  scopes: { profile: true, training: true, measurements: false, nutrition: false },
  profileNotes: '',
  coachStyle: 'balanced',
};
vi.mock('@/backend/ai', () => ({
  aiApi: {
    status: async () => ({ available: true }),
    getSettings: async () => SETTINGS_ON,
    saveSettings: async () => SETTINGS_ON,
    history: async () => [],
    send: async () => undefined,
    clearHistory: async () => undefined,
    listProposals: async () => [],
    respondProposal: async () => undefined,
  },
}));

const { LiftDb } = await import('@/db/db');
const { defaultAccountState } = await import('@/state/defaults');
const { mainTabs, isTabActive } = await import('@/app/Shell');
const { TopActions } = await import('@/app/TopActions');
const { ProfileShortcuts } = await import('@/features/social/ProfilePage');
const TodayPage = (await import('@/features/today/TodayPage')).default;
const CoachTabPage = (await import('@/features/coaching/CoachTabPage')).default;
const CoachingHubPage = (await import('@/features/coaching/CoachingHubPage')).default;
const { clearCoachChannelCache, hasHumanCoaching } = await import('@/features/coaching/coachChannels');
const { ToastProvider } = await import('@/components/toast');

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
async function render(node: ReactElement, path = '/') {
  el = document.createElement('div');
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(createElement(ToastProvider, null, createElement(MemoryRouter, { initialEntries: [path] }, node))));
}
const hrefs = (scope: ParentNode = el!) => [...scope.querySelectorAll('a')].map((a) => a.getAttribute('href'));
const switcher = () => el!.querySelector('nav[aria-label="Coach channels"]');

const rel = (over: Partial<CoachingRelationship> = {}): CoachingRelationship =>
  ({ id: 'r1', status: 'ended', viewerIsCoach: false, unread: 0, requestedAt: '2026-01-01', coach: { displayName: 'Coach Kim', photoUrl: null, suspended: false }, ...over }) as unknown as CoachingRelationship;

beforeEach(() => {
  h.db = new LiftDb(`nav-${++dbCount}`);
  h.account = defaultAccountState();
  h.auth = 'signed_in';
  h.backend = true;
  h.rels = [];
  h.profile = null;
  h.admin = false;
  h.relsFail = false;
  h.socialUnread = 0;
  clearCoachChannelCache();
  const proto = HTMLDialogElement.prototype as unknown as { showModal: () => void; close: () => void };
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  proto.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  el?.remove();
  vi.unstubAllEnvs();
});

/* ------------------------------------------------------------------ tabs */
describe('four tabs', () => {
  it('Today, Train, Coach, Progress by default; no Nutrition, Coaching or Feed tab', () => {
    const tabs = mainTabs();
    expect(tabs.map((t) => [t.label, t.to])).toEqual([
      ['Today', '/'],
      ['Train', '/train'],
      ['Coach', '/coach'],
      ['Progress', '/progress'],
    ]);
  });

  it('socialFeed on: Feed is a fifth tab, after the four', () => {
    vi.stubEnv('VITE_ENABLE_SOCIAL_FEED', 'true');
    expect(mainTabs().map((t) => t.label)).toEqual(['Today', 'Train', 'Coach', 'Progress', 'Feed']);
  });

  it('the Coach tab stays highlighted across human coaching and AI screens; Today only on /', () => {
    const [today, train, coach, progress] = mainTabs();
    for (const p of ['/coach', '/coaching', '/coaching/my', '/coaching/dashboard', '/coaching/ai/settings']) expect(isTabActive(coach, p), p).toBe(true);
    expect(isTabActive(coach, '/coachingx')).toBe(false);
    expect(isTabActive(today, '/')).toBe(true);
    expect(isTabActive(today, '/train')).toBe(false);
    expect(isTabActive(train, '/train/history')).toBe(true);
    expect(isTabActive(progress, '/nutrition')).toBe(false);
  });

  it('nutrition routes are still in the route table', async () => {
    const src = (await import('../../src/app/routes.tsx?raw')).default as string;
    for (const p of ['/nutrition', '/nutrition/log', '/nutrition/targets', '/nutrition/recipes', '/nutrition/plan', '/nutrition/shopping', '/coach', '/coaching', '/coaching/ai'])
      expect(src).toContain(`path: '${p}'`);
  });
});

/* ---------------------------------------------------------------- header */
describe('header actions', () => {
  it('signed in: Notifications (with unread) and Profile only; Friends and Settings moved to Profile', async () => {
    h.socialUnread = 2;
    await render(createElement(TopActions));
    expect(hrefs()).toEqual(['/notifications', '/profile']);
    expect(el!.querySelector('a[href="/notifications"]')!.getAttribute('aria-label')).toBe('Notifications, 2 unread');
    expect(el!.querySelector('a[href="/profile"]')!.getAttribute('aria-label')).toBe('Profile');
  });

  it('guest: just Profile', async () => {
    h.auth = 'guest';
    await render(createElement(TopActions));
    expect(hrefs()).toEqual(['/profile']);
  });
});

describe('Profile is the way to Nutrition, Friends and Settings', () => {
  it('lists all three with the online version', async () => {
    await render(createElement(ProfileShortcuts));
    expect(hrefs()).toEqual(['/nutrition', '/friends', '/settings']);
    expect(norm(el!.textContent)).toContain('Optional: protein target');
  });

  it('personal version (no backend): Nutrition and Settings, no Friends', async () => {
    h.backend = false;
    await render(createElement(ProfileShortcuts));
    expect(hrefs()).toEqual(['/nutrition', '/settings']);
  });
});

/* ----------------------------------------------------------------- Today */
describe('Today: nutrition without a tab', () => {
  it('nutrition off: a quick action into Nutrition, no nutrition card', async () => {
    await render(createElement(TodayPage));
    const link = await waitFor(() => {
      const a = el!.querySelector<HTMLAnchorElement>('a[href="/nutrition"]');
      if (!a) throw new Error('no nutrition link');
      return a;
    });
    expect(norm(link.textContent)).toBe('Track protein');
    expect(el!.querySelector('#today-nutrition')).toBeNull();
    expect(hrefs()).not.toContain('/train'); // the Train quick action was redundant with the tab
  });

  it('nutrition on: the protein/nutrition card with Details and Log food, plus the Nutrition quick action', async () => {
    const acc = defaultAccountState();
    h.account = { ...acc, settings: { ...acc.settings, nutritionEnabled: true }, nutrition: { ...acc.nutrition, mode: 'protein_only', proteinG: 150 } };
    await render(createElement(TodayPage));
    await waitFor(() => expect(el!.querySelector('#today-nutrition')).not.toBeNull());
    const links = hrefs();
    expect(links).toContain('/nutrition');
    expect(links.some((l) => l?.startsWith('/nutrition/log?date='))).toBe(true);
    expect(norm([...el!.querySelectorAll('a[href="/nutrition"]')].map((a) => a.textContent).join('|'))).toContain('Nutrition');
  });
});

/* ----------------------------------------------------------------- Coach */
describe('hasHumanCoaching', () => {
  it('only for people human coaching concerns (or everyone when the marketplace is on)', () => {
    expect(hasHumanCoaching({ marketplace: false })).toBe(false);
    expect(hasHumanCoaching({ marketplace: false, relationships: [] , coachProfile: null, admin: false })).toBe(false);
    expect(hasHumanCoaching({ marketplace: true })).toBe(true);
    for (const status of ['active', 'requested', 'ended'] as const) expect(hasHumanCoaching({ marketplace: false, relationships: [rel({ status })] }), status).toBe(true);
    expect(hasHumanCoaching({ marketplace: false, relationships: [rel({ viewerIsCoach: true, status: 'active' })] })).toBe(true);
    expect(hasHumanCoaching({ marketplace: false, coachProfile: { status: 'submitted' } as CoachProfile })).toBe(true);
    expect(hasHumanCoaching({ marketplace: false, admin: true })).toBe(true);
    expect(hasHumanCoaching({ marketplace: false, unread: 1 })).toBe(true);
  });
});

describe('Coach tab', () => {
  const chatReady = () =>
    waitFor(() => {
      expect(norm(el!.querySelector('h1')?.textContent)).toBe('Coach');
      expect(el!.querySelector('#ai-composer')).not.toBeNull();
    });

  it('a regular lifter without a coach gets the training assistant directly, with no switcher or back button', async () => {
    await render(createElement(CoachTabPage), '/coach');
    await chatReady();
    await tick(60);
    expect(switcher()).toBeNull();
    expect(el!.querySelector('button[aria-label="Back"]')).toBeNull();
    expect(el!.querySelector('[role="article"][aria-label="Training assistant welcome"], article[aria-label="Training assistant welcome"]')).not.toBeNull();
  });

  it('past coaching: the switcher links back to human coaching', async () => {
    h.rels = [rel({ status: 'ended' })];
    await render(createElement(CoachTabPage), '/coach');
    await chatReady();
    await waitFor(() => expect(switcher()).not.toBeNull());
    expect(hrefs(switcher()!)).toEqual(['/coach', '/coaching']);
    expect(switcher()!.querySelector('a[href="/coach"]')!.getAttribute('aria-current')).toBe('page');
  });

  it('an active coach with unread messages shows the count on the switcher', async () => {
    h.rels = [rel({ status: 'active', unread: 3 })];
    await render(createElement(CoachTabPage), '/coach');
    await waitFor(() => expect(norm(switcher()?.querySelector('a[href="/coaching"]')?.textContent)).toBe('Coaching3'));
  });

  it('coaches, applicants and admins get the switcher too', async () => {
    h.profile = { status: 'approved' } as CoachProfile;
    await render(createElement(CoachTabPage), '/coach');
    await waitFor(() => expect(switcher()).not.toBeNull());
    await act(async () => root!.unmount());
    el!.remove();
    clearCoachChannelCache();
    h.profile = null;
    h.admin = true;
    await render(createElement(CoachTabPage), '/coach');
    await waitFor(() => expect(switcher()).not.toBeNull());
  });

  it('coach marketplace on: everyone gets the switcher (the hub is where you find a coach)', async () => {
    vi.stubEnv('VITE_ENABLE_COACH_MARKETPLACE', 'true');
    await render(createElement(CoachTabPage), '/coach');
    await chatReady();
    expect(switcher()).not.toBeNull();
  });

  it('guests: the assistant’s sign-in screen, no switcher', async () => {
    h.auth = 'guest';
    h.rels = [rel()];
    await render(createElement(CoachTabPage), '/coach');
    await waitFor(() => expect(norm(el!.querySelector('h1')?.textContent)).toBe('Coach'));
    await tick(60);
    expect(switcher()).toBeNull();
  });

  it('a failed coaching load keeps what was known (no flicker away from the switcher)', async () => {
    h.rels = [rel()];
    await render(createElement(CoachTabPage), '/coach');
    await waitFor(() => expect(switcher()).not.toBeNull());
    await act(async () => root!.unmount());
    el!.remove();
    h.relsFail = true;
    h.rels = [];
    await render(createElement(CoachTabPage), '/coach');
    await tick(80);
    expect(switcher()).not.toBeNull();
  });

  it('the Coaching hub has the switcher back to the assistant, and opens the assistant in the Coach tab', async () => {
    h.rels = [rel({ status: 'active' })];
    await render(createElement(CoachingHubPage), '/coaching');
    await waitFor(() => expect(switcher()).not.toBeNull());
    expect(switcher()!.querySelector('a[href="/coaching"]')!.getAttribute('aria-current')).toBe('page');
    await waitFor(() => expect(norm(el!.textContent)).toContain('Open training assistant'));
    const open = [...el!.querySelectorAll('a')].find((a) => norm(a.textContent) === 'Open training assistant')!;
    expect(open.getAttribute('href')).toBe('/coach');
  });
});
