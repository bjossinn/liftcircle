// @vitest-environment jsdom
/**
 * ScrollReset (src/app/ScrollReset.tsx) and FeedPage's own scroll memory, in a router laid out like Shell
 * (<ScrollReset /> before <Outlet />). jsdom has no layout, so window.scrollTo is stubbed to move window.scrollY and
 * fire a scroll event synchronously (harsher than a browser, which fires it on the next frame).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router';
import type { Post } from '@/domain/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Social feature on: backend configured, signed in, online.
vi.mock('@/state/app', () => ({
  useApp: () => ({ backendConfigured: true, auth: { status: 'signed_in', userId: 'me' }, online: true }),
  useDb: () => null,
}));
vi.mock('@/app/TopActions', () => ({ TopActions: () => null }));
vi.mock('@/social/pendingPosts', () => ({
  usePendingPosts: () => [],
  usePendingPostsRunner: () => {},
  usePendingProgress: () => null,
  friendlyError: (e: unknown) => String(e),
}));
const posts: Post[] = Array.from({ length: 20 }, (_, i) => ({
  id: `p${i}`,
  authorId: 'friend',
  author: { id: 'friend', username: 'anna', displayName: 'Anna', avatarUrl: null },
  kind: 'workout',
  audience: 'friends',
  caption: `Post number ${i}`,
  snapshot: { title: 'Upper A', kind: 'workout', date: '2026-11-20', durationSec: 3000, exercises: [] },
  media: [],
  likeCount: 0,
  commentCount: 0,
  likedByMe: false,
  createdAt: new Date(Date.now() - i * 60_000).toISOString(),
  editedAt: null,
})) as unknown as Post[];
vi.mock('@/backend/social', () => ({
  socialApi: new Proxy(
    { getFeed: async () => ({ items: posts, next: null }) },
    { get: (t: Record<string, unknown>, k: string) => t[k] ?? (async () => null) },
  ),
}));

const { ScrollReset, ScrollPositions, MAX_ENTRIES } = await import('@/app/ScrollReset');
const { default: FeedPage } = await import('@/features/social/FeedPage');
const { ToastProvider } = await import('@/components/toast');

let root: Root | null = null;
let el: HTMLDivElement | null = null;

beforeEach(() => {
  Object.defineProperty(window, 'scrollY', { value: 0, writable: true, configurable: true });
  window.scrollTo = ((x: number | ScrollToOptions, y?: number) => {
    (window as { scrollY: number }).scrollY = typeof x === 'number' ? (y ?? 0) : (x.top ?? 0);
    window.dispatchEvent(new Event('scroll'));
  }) as typeof window.scrollTo;
});
afterEach(async () => {
  await act(async () => root?.unmount());
  el?.remove();
  root = null;
  el = null;
});

function mount(routes: { path: string; element: React.ReactNode }[], initial: string) {
  const router = createMemoryRouter(
    [{ element: createElement(Fragment, null, createElement(ScrollReset), createElement(Outlet)), children: routes }],
    { initialEntries: [initial] },
  );
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => root!.render(createElement(ToastProvider, null, createElement(RouterProvider, { router }))));
  return router;
}
const scrollY = () => window.scrollY;
const userScroll = (y: number) => act(() => window.scrollTo(0, y));
const go = (fn: () => unknown) => act(async () => void (await fn()));

const page = (name: string) => createElement('div', null, name);
const LIB = [
  { path: '/list', element: page('list') },
  { path: '/detail', element: page('detail') },
];

describe('ScrollReset', () => {
  it('a new pathname starts at the top; Back restores the position', async () => {
    const router = mount(LIB, '/list');
    userScroll(900);
    await go(() => router.navigate('/detail'));
    expect(scrollY()).toBe(0);
    userScroll(300);
    await go(() => router.navigate(-1));
    expect(scrollY()).toBe(900);
    await go(() => router.navigate(1));
    expect(scrollY()).toBe(300);
  });

  it('an entry never scrolled is seeded at 0: Back from a scrolled detail returns to the top', async () => {
    const router = mount(LIB, '/list');
    await go(() => router.navigate('/detail'));
    userScroll(500);
    await go(() => router.navigate(-1));
    expect(scrollY()).toBe(0);
  });

  it('a search-only REPLACE keeps the position and hands it to the new entry (search → detail → Back)', async () => {
    const router = mount(LIB, '/list');
    userScroll(120);
    await go(() => router.navigate('/list?q=a', { replace: true }));
    expect(scrollY()).toBe(120);
    await go(() => router.navigate('/detail'));
    expect(scrollY()).toBe(0);
    userScroll(500);
    await go(() => router.navigate(-1));
    expect(router.state.location.search).toBe('?q=a');
    expect(scrollY()).toBe(120);
  });

  it('captures the outgoing position even if its scroll event never fired (scroll, then tap)', async () => {
    const router = mount(LIB, '/list');
    (window as { scrollY: number }).scrollY = 700; // moved, no event yet
    await go(() => router.navigate('/detail'));
    expect(scrollY()).toBe(0);
    await go(() => router.navigate(-1));
    expect(scrollY()).toBe(700);
  });

  it('a search-only PUSH keeps the position', async () => {
    const router = mount(LIB, '/list');
    userScroll(250);
    await go(() => router.navigate('/list?section=app'));
    expect(scrollY()).toBe(250);
  });

  it('keeps at most MAX_ENTRIES positions, dropping the least recently used', () => {
    const p = new ScrollPositions();
    for (let i = 0; i < MAX_ENTRIES + 10; i++) p.set(`k${i}`, i);
    expect(p.size).toBe(MAX_ENTRIES);
    expect(p.get('k0')).toBeUndefined();
    expect(p.get(`k${MAX_ENTRIES + 9}`)).toBe(MAX_ENTRIES + 9);
    p.set('k10', 1); // touched → most recent
    p.set('new', 2);
    expect(p.get('k10')).toBe(1);
    expect(p.get('k11')).toBeUndefined();
  });
});

describe('Feed → post → Back (social feature on)', () => {
  it('Feed remembers where the reader was before the reset, and restores it on Back', async () => {
    const router = mount(
      [
        { path: '/feed', element: createElement(FeedPage) },
        { path: '/feed/post/:id', element: page('post') },
      ],
      '/feed',
    );
    await vi.waitFor(() => expect(el!.textContent).toContain('Post number 19'));
    userScroll(800);
    await go(() => router.navigate('/feed/post/p3'));
    expect(scrollY()).toBe(0);
    await go(() => router.navigate(-1));
    await vi.waitFor(() => expect(el!.textContent).toContain('Post number 19'));
    await vi.waitFor(() => expect(scrollY()).toBe(800));
  });
});
