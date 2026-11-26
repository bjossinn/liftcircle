// @vitest-environment jsdom
/**
 * PR #20 follow-up: with the socialFeed flag off there is no Feed tab, so queued shares must be recoverable from the
 * profile. A share is queued → its upload fails → Retry publishes it; another one fails → Cancel removes it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ db: null as unknown, failDraft: true }));
vi.mock('@/state/app', () => ({
  useApp: () => ({ db: h.db, backendConfigured: true, auth: { status: 'signed_in', userId: (h.db as { accountKey: string }).accountKey }, online: true }),
  useDb: () => h.db,
}));
const api = vi.hoisted(() => ({
  socialApi: {
    getMyProfile: vi.fn(async () => ({ id: 'me-id', username: 'me', displayName: 'Me', bio: null, interests: [], discoverable: true, avatarUrl: null })),
    getUserPosts: vi.fn(async () => ({ items: [], next: null })),
    amModerator: vi.fn(async () => false),
    createPostDraft: vi.fn(async () => {
      if (h.failDraft) throw Object.assign(new Error('Server error'), { status: 500 });
    }),
    uploadPostMedia: vi.fn(async () => undefined),
    publishPost: vi.fn(async (id: string) => ({ id })),
    deletePost: vi.fn(async () => undefined),
  },
}));
vi.mock('@/backend/social', () => ({ socialApi: api.socialApi }));

import { isFeatureEnabled } from '@/config/featureFlags';
import { LiftDb } from '@/db/db';
import { processPendingPosts, queuePost, setPendingPostsAccount } from '@/social/pendingPosts';
import ProfilePage from '@/features/social/ProfilePage';
import { ToastProvider } from '@/components/toast';

let root: Root | null = null;
let el: HTMLDivElement;
let n = 0;
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
const text = () => document.body.textContent ?? '';
const buttons = (label: string) => [...document.body.querySelectorAll<HTMLButtonElement>('button')].filter((b) => b.textContent?.trim() === label);
const click = (b: HTMLButtonElement | undefined) =>
  act(async () => {
    if (!b) throw new Error('no button');
    b.click();
  });
const post = (id: string) => ({ id, kind: 'workout' as const, audience: 'friends' as const, caption: `Share ${id}`, photos: [], snapshot: null });

beforeEach(async () => {
  // jsdom lacks the modal dialog API used by ConfirmDialog.
  const proto = HTMLDialogElement.prototype as unknown as { showModal: () => void; close: () => void };
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  proto.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  h.db = new LiftDb(`me-profile-${++n}`);
  h.failDraft = true;
  vi.clearAllMocks();
  el = document.createElement('div');
  document.body.append(el);
  root = createRoot(el);
  await act(async () =>
    root!.render(
      createElement(ToastProvider, null, createElement(MemoryRouter, { initialEntries: ['/profile'] }, createElement(Routes, null, createElement(Route, { path: '/profile', element: createElement(ProfilePage) })))),
    ),
  );
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  el.remove();
  document.body.innerHTML = '';
  setPendingPostsAccount(null);
  (h.db as LiftDb).close();
});

describe('Profile: pending uploads with the social feed off', () => {
  it('queued → failed → Retry publishes it', async () => {
    expect(isFeatureEnabled('socialFeed')).toBe(false);
    const db = h.db as LiftDb;
    await waitFor(() => expect(text()).toContain('Posts you share will appear here.'));
    expect(text()).not.toContain('Not posted yet');

    await act(async () => queuePost(post('p1'), db));
    await waitFor(() => expect(text()).toContain('Waiting to upload'));
    expect(text()).toContain('Share p1');

    setPendingPostsAccount(db.accountKey);
    await act(async () => processPendingPosts(db));
    await waitFor(() => expect(text()).toContain('Upload failed'));
    expect(text()).toContain('Uploads that need attention');
    expect((await db.pendingPosts.get('p1'))?.status).toBe('error');

    h.failDraft = false;
    const listCalls = api.socialApi.getUserPosts.mock.calls.length;
    await click(buttons('Retry')[0]);
    await waitFor(() => expect(text()).not.toContain('Share p1'));
    expect(await db.pendingPosts.get('p1')).toBeUndefined();
    expect(api.socialApi.publishPost).toHaveBeenCalledWith('p1');
    // The published post is pulled into the profile's list.
    await waitFor(() => expect(api.socialApi.getUserPosts.mock.calls.length).toBeGreaterThan(listCalls));
  });

  it('queued → failed → Cancel removes it (and cleans up the server draft)', async () => {
    const db = h.db as LiftDb;
    await act(async () => queuePost(post('p2'), db));
    setPendingPostsAccount(db.accountKey);
    await act(async () => processPendingPosts(db));
    await waitFor(() => expect(text()).toContain('Upload failed'));

    await click(buttons('Cancel post')[0]);
    await waitFor(() => expect(text()).toContain('Cancel this post?'));
    const confirm = buttons('Cancel post').at(-1);
    await click(confirm);
    await waitFor(() => expect(text()).not.toContain('Share p2'));
    expect(await db.pendingPosts.count()).toBe(0);
    expect(api.socialApi.deletePost).toHaveBeenCalledWith('p2');
    expect(api.socialApi.publishPost).not.toHaveBeenCalled();
  });
});
