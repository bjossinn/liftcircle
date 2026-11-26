// @vitest-environment jsdom
/**
 * Roadmap item 4: the coach marketplace and the social feed are hidden behind feature flags (default off, switched on
 * with VITE_ENABLE_COACH_MARKETPLACE / VITE_ENABLE_SOCIAL_FEED). Nothing is deleted: existing coaching keeps working,
 * share cards and auto-share keep queueing posts, and old links land on a clear screen instead of a dead end.
 * The Coaching hub itself is covered in coachingHubUi.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import type { CoachingRelationship } from '@/backend/coachingContract';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ db: null as unknown, account: null as unknown, rels: [] as unknown[] }));
vi.mock('@/state/app', () => ({
  useApp: () => ({ db: h.db, account: h.account, backendConfigured: true, auth: { status: 'signed_in', userId: 'me' }, online: true, updateAccount: async () => undefined }),
  useDb: () => h.db,
  useSettings: () => (h.account as { settings: unknown }).settings,
}));
vi.mock('@/app/TopActions', () => ({ TopActions: () => null }));
// Share card stand-in: reports a posted (id) or still-queued (null) share back to ComposePage.
vi.mock('@/features/social/SharePreview', () => ({
  SharePreview: ({ onDone }: { onDone?: (id: string | null) => void }) =>
    createElement('div', null, createElement('button', { onClick: () => onDone?.('post-1') }, 'Posted'), createElement('button', { onClick: () => onDone?.(null) }, 'Queued')),
}));
vi.mock('@/backend/coaching', () => ({
  coachingApi: new Proxy(
    {},
    { get: (_t, k) => (k === 'myRelationships' ? async () => h.rels : k === 'then' ? undefined : async () => []) },
  ),
}));

import { DEFAULT_FLAGS, FLAG_ENV_VARS, isFeatureEnabled, parseFlag, readFeatureFlags } from '@/config/featureFlags';
import { FeatureGate, FeedOff, CoachMarketplaceOff } from '@/app/FeatureGate';
import { mainTabs } from '@/app/Shell';
import { feedHome } from '@/features/social/feedHome';
import { LiftDb } from '@/db/db';
import { defaultAccountState } from '@/state/defaults';
import { maybeAutoShare } from '@/social/autoShare';
import ComposePage from '@/features/social/ComposePage';
import MyCoachPage from '@/features/coaching/MyCoachPage';
import type { WorkoutSession } from '@/domain/types';
import { ToastProvider } from '@/components/toast';

let root: Root | null = null;
let el: HTMLDivElement;
let dbCount = 0;
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
function Where() {
  const l = useLocation();
  return createElement('output', { 'data-testid': 'where' }, l.pathname);
}
async function render(path: string, routes: { path: string; element: ReactNode }[]) {
  el = document.createElement('div');
  document.body.append(el);
  root = createRoot(el);
  await act(async () =>
    root!.render(
      createElement(
        ToastProvider,
        null,
        createElement(
        MemoryRouter,
        { initialEntries: [path] },
        createElement(Where),
        createElement(Routes, null, ...routes.map((r) => createElement(Route, { key: r.path, path: r.path, element: r.element })), createElement(Route, { key: '*', path: '*', element: createElement('p', null, 'elsewhere') })),
        ),
      ),
    ),
  );
}
const where = () => el.querySelector('output')?.textContent;
const links = () => [...el.querySelectorAll('a')].map((a) => a.getAttribute('href'));
const click = (text: string) =>
  act(async () => {
    const b = [...el.querySelectorAll<HTMLButtonElement>('button')].find((x) => x.textContent?.trim() === text);
    if (!b) throw new Error(`no button ${text}`);
    b.click();
  });

beforeEach(() => {
  h.db = new LiftDb(`flags-${++dbCount}`);
  h.account = defaultAccountState();
  h.rels = [];
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  el?.remove();
  vi.unstubAllEnvs();
});

describe('feature flags module', () => {
  it('both flags default to off', () => {
    expect(DEFAULT_FLAGS).toEqual({ coachMarketplace: false, socialFeed: false });
    expect(readFeatureFlags({})).toEqual({ coachMarketplace: false, socialFeed: false });
    expect(isFeatureEnabled('coachMarketplace')).toBe(false);
    expect(isFeatureEnabled('socialFeed')).toBe(false);
  });

  it('uses the documented env var names', () => {
    expect(FLAG_ENV_VARS).toEqual({ coachMarketplace: 'VITE_ENABLE_COACH_MARKETPLACE', socialFeed: 'VITE_ENABLE_SOCIAL_FEED' });
  });

  it('env vars switch each flag on independently', () => {
    expect(readFeatureFlags({ VITE_ENABLE_COACH_MARKETPLACE: 'true' })).toEqual({ coachMarketplace: true, socialFeed: false });
    expect(readFeatureFlags({ VITE_ENABLE_SOCIAL_FEED: '1' })).toEqual({ coachMarketplace: false, socialFeed: true });
    vi.stubEnv('VITE_ENABLE_SOCIAL_FEED', 'yes');
    expect(isFeatureEnabled('socialFeed')).toBe(true);
    expect(isFeatureEnabled('coachMarketplace')).toBe(false);
  });

  it('parses true/false, 1/0, yes/no, on/off in any case; anything else keeps the default', () => {
    for (const v of ['true', 'TRUE', ' on ', 'Yes', '1', true]) expect(parseFlag(v, false)).toBe(true);
    for (const v of ['false', 'Off', 'no', '0', false]) expect(parseFlag(v, true)).toBe(false);
    for (const v of ['', 'maybe', undefined, null, 2]) {
      expect(parseFlag(v, false)).toBe(false);
      expect(parseFlag(v, true)).toBe(true);
    }
  });
});

describe('social feed flag: navigation', () => {
  it('OFF (default): no Feed tab; the four tabs are Today, Train, Coach, Progress', () => {
    const tabs = mainTabs();
    expect(tabs.map((t) => t.label)).toEqual(['Today', 'Train', 'Coach', 'Progress']);
    expect(tabs.map((t) => t.to)).not.toContain('/feed');
  });

  it('ON via VITE_ENABLE_SOCIAL_FEED: Feed comes back as a fifth tab', () => {
    vi.stubEnv('VITE_ENABLE_SOCIAL_FEED', 'true');
    expect(mainTabs().map((t) => t.label)).toEqual(['Today', 'Train', 'Coach', 'Progress', 'Feed']);
  });

  it('OFF: /feed explains the feed is off and links to the profile and Today (the feed page itself is not rendered)', async () => {
    await render('/feed', [{ path: '/feed', element: createElement(FeatureGate, { flag: 'socialFeed', off: createElement(FeedOff) }, createElement('p', null, 'REAL FEED')) }]);
    expect(el.textContent).toContain('The feed isn’t available right now');
    expect(el.textContent).toContain('Nothing has been deleted');
    expect(el.textContent).not.toContain('REAL FEED');
    expect(links()).toEqual(expect.arrayContaining(['/profile', '/']));
  });

  it('ON: /feed renders the feed', async () => {
    vi.stubEnv('VITE_ENABLE_SOCIAL_FEED', 'true');
    await render('/feed', [{ path: '/feed', element: createElement(FeatureGate, { flag: 'socialFeed', off: createElement(FeedOff) }, createElement('p', null, 'REAL FEED')) }]);
    expect(el.textContent).toContain('REAL FEED');
  });

  it('"back to feed" targets (post page, notifications without a post) go to the profile when OFF, the feed when ON', () => {
    expect(feedHome()).toEqual({ path: '/profile', label: 'Your profile' });
    vi.stubEnv('VITE_ENABLE_SOCIAL_FEED', 'true');
    expect(feedHome()).toEqual({ path: '/feed', label: 'Back to feed' });
  });
});

describe('social feed flag: sharing still works and never lands on a hidden feed', () => {
  const completed = (): WorkoutSession => ({
    id: 's1', createdAt: 1, updatedAt: 1, name: 'Push', status: 'completed', date: '2026-11-20', timeZone: 'UTC', startedAt: 1, endedAt: 60_000, pausedTotalMs: 0, exercises: [],
  }) as unknown as WorkoutSession;
  const compose = (path: string) =>
    render(path, [
      { path: '/feed/new', element: createElement(ComposePage) },
      { path: '/feed', element: createElement('p', null, 'FEED') },
    ]);

  it('OFF: a posted share opens the new post, not the hidden feed', async () => {
    await (h.db as LiftDb).sessions.put(completed());
    await compose('/feed/new?session=s1');
    await waitFor(() => expect(el.textContent).toContain('Posted'));
    await click('Posted');
    expect(where()).toBe('/feed/post/post-1');
  });

  it('OFF: a share still waiting to upload goes back to the workout', async () => {
    await (h.db as LiftDb).sessions.put(completed());
    await compose('/feed/new?session=s1');
    await waitFor(() => expect(el.textContent).toContain('Queued'));
    await click('Queued');
    expect(where()).toBe('/train/history/s1');
  });

  it('OFF: a standalone post still waiting to upload goes to Today', async () => {
    await compose('/feed/new');
    await waitFor(() => expect(el.textContent).toContain('Queued'));
    await click('Queued');
    expect(where()).toBe('/');
  });

  it('ON: sharing lands on the feed as before', async () => {
    vi.stubEnv('VITE_ENABLE_SOCIAL_FEED', 'true');
    await (h.db as LiftDb).sessions.put(completed());
    await compose('/feed/new?session=s1');
    await waitFor(() => expect(el.textContent).toContain('Posted'));
    await click('Posted');
    expect(where()).toBe('/feed');
  });

  it('OFF: auto-share (when the user turned it on) still queues the post; nothing depends on the feed tab', async () => {
    const db = h.db as LiftDb;
    const settings = defaultAccountState().settings;
    settings.social.autoShare.enabled = true;
    const shared = await maybeAutoShare({ session: completed() }, { db, settings, byId: new Map() });
    expect(shared).toBe(true);
    expect(await db.pendingPosts.filter((p) => p.sourceRecordId === 's1').count()).toBe(1);
  });
});

describe('coach marketplace flag: routes and existing coaching', () => {
  const gated = (child: string) => createElement(FeatureGate, { flag: 'coachMarketplace', off: createElement(CoachMarketplaceOff) }, createElement('p', null, child));

  it('OFF: find / coach profile / request routes explain and link back to Coaching (the marketplace pages are not rendered)', async () => {
    for (const path of ['/coaching/find', '/coaching/coach/c1', '/coaching/request/c1']) {
      await render(path, [
        { path: '/coaching/find', element: gated('DIRECTORY') },
        { path: '/coaching/coach/:id', element: gated('COACH PROFILE') },
        { path: '/coaching/request/:coachId', element: gated('REQUEST FORM') },
      ]);
      expect(el.textContent).toContain('Finding a coach isn’t open yet');
      expect(el.textContent).not.toMatch(/DIRECTORY|COACH PROFILE|REQUEST FORM/);
      expect(links()).toContain('/coaching');
      await act(async () => root!.unmount());
      root = null;
      el.remove();
    }
  });

  it('ON via VITE_ENABLE_COACH_MARKETPLACE: the marketplace pages render', async () => {
    vi.stubEnv('VITE_ENABLE_COACH_MARKETPLACE', 'true');
    await render('/coaching/find', [{ path: '/coaching/find', element: gated('DIRECTORY') }]);
    expect(el.textContent).toContain('DIRECTORY');
  });

  const active = {
    id: 'r1', viewerIsCoach: false, status: 'active', unread: 1, requestedAt: '2026-11-01T00:00:00Z', acceptedAt: '2026-11-02T00:00:00Z',
    coach: { userId: 'c1', displayName: 'Coach Kim', suspended: false, approved: true }, client: { userId: 'me', displayName: 'Me' },
    scopes: { training: true, measurements: false, nutrition: false, checkins: true },
  } as unknown as CoachingRelationship;

  it('OFF: a client with an active coach keeps My coach and Messages, without "Find another coach"', async () => {
    h.rels = [active];
    await render('/coaching/my', [{ path: '/coaching/my', element: createElement(MyCoachPage) }]);
    await waitFor(() => expect(el.textContent).toContain('Coach Kim'));
    expect(el.textContent).toContain('Messages (1 new)');
    expect(el.textContent).toContain('End coaching');
    expect(el.textContent).not.toMatch(/find another coach|look for a coach|switch coach/i);
    await click('Messages (1 new)');
    expect(where()).toBe('/coaching/messages/r1');
  });

  it('ON: the same client can switch coach', async () => {
    vi.stubEnv('VITE_ENABLE_COACH_MARKETPLACE', 'true');
    h.rels = [active];
    await render('/coaching/my', [{ path: '/coaching/my', element: createElement(MyCoachPage) }]);
    await waitFor(() => expect(el.textContent).toContain('Find another coach'));
  });

  it('OFF: no coach at all → the training assistant is offered instead of an empty marketplace', async () => {
    await render('/coaching/my', [{ path: '/coaching/my', element: createElement(MyCoachPage) }]);
    await waitFor(() => expect(el.textContent).toContain('No coach yet'));
    expect(el.textContent).toContain('Try the training assistant');
    expect(el.textContent).not.toContain('Look for a coach');
  });
});
