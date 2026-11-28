// @vitest-environment jsdom
/**
 * Icelandic copy on the social screens: post cards, snapshots, access notices, notifications, usernames and photo
 * errors. Captions, display names and stored snapshot text are user content and stay as written.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/state/app', () => ({
  useApp: () => ({ backendConfigured: true, auth: { status: 'signed_in', userId: 'me' }, online: false }),
  useDb: () => null,
}));

const { setLanguage } = await import('@/i18n');
const { PostCard } = await import('@/features/social/PostCard');
const { AccessNotice, SnapshotView, timeAgo, usernameProblem } = await import('@/features/social/common');
const { describeNotification } = await import('@/features/social/NotificationsPage');
const { MediaError } = await import('@/social/media');
const { ToastProvider } = await import('@/components/toast');
import type { AppNotification, Post } from '@/domain/types';

let root: Root | null = null;
let el: HTMLDivElement | null = null;
const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

async function render(node: ReactElement) {
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  await act(async () => root!.render(createElement(ToastProvider, null, createElement(MemoryRouter, null, node))));
  return el;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  el?.remove();
  root = null;
  el = null;
  setLanguage('en');
});

const post: Post = {
  id: 'p1',
  authorId: 'friend',
  author: { id: 'friend', username: 'anna', displayName: 'Anna', avatarUrl: null },
  kind: 'workout',
  audience: 'friends',
  caption: 'Great session today',
  snapshot: { title: 'Upper A', kind: 'workout', date: '2026-11-20', durationSec: 3000, exercises: [{ name: 'Bench Press', sets: [{ reps: 5 }] }] },
  media: [],
  likeCount: 2,
  commentCount: 1,
  likedByMe: false,
  createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  editedAt: new Date().toISOString(),
};

describe('social screens in Icelandic', () => {
  it('post card: chrome is Icelandic, caption and stored names stay as written', async () => {
    setLanguage('is');
    const c = await render(createElement(PostCard, { post, meId: 'me' }));
    const text = norm(c.textContent);
    expect(text).toContain('Great session today');
    expect(text).toContain('Lokið: Upper A');
    expect(text).toContain('Bench Press');
    expect(text).toContain('5 endurtekningar');
    expect(text).toContain('fyrir 5 mín.');
    expect(text).toContain('breytt');
    expect(c.querySelector('article')?.getAttribute('aria-label')).toBe('Færsla frá Anna');
    expect(c.querySelector('[aria-label="Læka"]')).not.toBeNull();
    expect(c.querySelector('[aria-label="Valkostir færslu"]')).not.toBeNull();
  });

  it('post card stays English by default', async () => {
    const c = await render(createElement(PostCard, { post, meId: 'me' }));
    const text = norm(c.textContent);
    expect(text).toContain('Completed Upper A');
    expect(text).toContain('5 reps');
    expect(text).toContain('5 min ago');
  });

  it('built-in activity names in a snapshot are shown in the reader’s language', async () => {
    setLanguage('is');
    const c = await render(createElement(SnapshotView, { snapshot: { title: 'Run', kind: 'activity', date: '2026-11-20', activity: { type: 'run', label: 'Run', distance: '5 km' } } }));
    expect(norm(c.textContent)).toContain('Hlaup');
  });

  it('offline notice is a full Icelandic sentence for each screen', async () => {
    setLanguage('is');
    const c = await render(createElement(AccessNotice, { access: 'offline', what: 'feed' }));
    expect(norm(c.textContent)).toContain('Fréttaveitan krefst nettengingar.');
  });

  it('notifications, usernames, time and photo errors', () => {
    setLanguage('is');
    const n = { id: 'n1', type: 'like', actor: { id: 'a', username: 'anna', displayName: 'Anna' }, createdAt: '' } as unknown as AppNotification;
    expect(describeNotification(n, 'me')).toEqual({ who: 'Anna', text: 'lækaði færsluna þína' });
    expect(usernameProblem('ab')).toBe('Að minnsta kosti 3 stafir.');
    expect(timeAgo(new Date(Date.now() - 2 * 3600_000).toISOString())).toBe('fyrir 2 klst.');
    expect(new MediaError('empty').message).toBe('Þessi skrá er tóm.');
  });
});
