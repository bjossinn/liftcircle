// @vitest-environment jsdom
/**
 * Coach composer drafts: persisted per account + relationship (real Dexie via fake-indexeddb),
 * restored after navigation/reload, cleared after a successful queue, and sent only through the outbox
 * (which re-checks the relationship). coachingApi is mocked — no live backend.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { CoachingRelationship } from '@/backend/coachingContract';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let urlN = 0;
URL.createObjectURL = (() => `blob:test/${++urlN}`) as typeof URL.createObjectURL;
URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;

const h = vi.hoisted(() => ({ db: null as unknown, userId: 'user-1', relStatus: 'active' as 'active' | 'ended' }));
const api = vi.hoisted(() => {
  const rel = (status: string): CoachingRelationship =>
    ({
      id: 'rel-1', coachId: 'coach-1', clientId: 'user-1', status,
      coach: { userId: 'coach-1', displayName: 'Coach Kári', photoUrl: null, suspended: false, approved: true },
      client: { userId: 'user-1', displayName: 'Ana' },
      intake: {}, introMessage: '', scopes: { training: true, measurements: false, nutrition: false, checkins: false },
      requestedAt: '2026-10-01T10:00:00Z', unread: 0, viewerIsCoach: false,
    }) as unknown as CoachingRelationship;
  return {
    rel,
    coachingApi: {
      myRelationships: vi.fn(async () => [rel(h.relStatus)]),
      listMessages: vi.fn(async () => []),
      markRead: vi.fn(async () => undefined),
      sendMessage: vi.fn(async (i: { id: string; relationshipId: string; body: string }) => ({ id: i.id, relationshipId: i.relationshipId, senderId: 'user-1', body: i.body, media: [], status: 'sent', seq: 1, createdAt: new Date().toISOString() })),
      uploadMessageMedia: vi.fn(async () => undefined),
      endCoaching: vi.fn(),
    },
  };
});
vi.mock('@/backend/coaching', () => ({ coachingApi: api.coachingApi }));
vi.mock('@/backend/social', () => ({ socialApi: {} }));
vi.mock('@/state/app', async () => {
  const { defaultAccountState } = await import('@/state/defaults');
  const account = defaultAccountState();
  return {
    useApp: () => ({ db: h.db, auth: { status: 'signed_in', userId: h.userId }, account, accountReady: true, online: true, backendConfigured: true, updateAccount: async () => undefined }),
    useDb: () => h.db,
    useSettings: () => account.settings,
  };
});

import { LiftDb } from '@/db/db';
import { processCoachOutbox } from '@/coaching/outbox';
import { ToastProvider } from '@/components/toast';
import MessagesPage from '@/features/coaching/MessagesPage';
import { coachDraftKey, loadCoachDraft, mergeIncomingText, queueDraftMessage, saveCoachDraft } from '@/features/coaching/tools/coachDraft';

let onLine = true;
Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => onLine });

let dbs: LiftDb[] = [];
let k = 0;
const suffix = () => String(++k).padStart(3, '0');
async function openDb(name: string) {
  const db = new LiftDb(name);
  await db.open();
  dbs.push(db);
  return db;
}
const blob = (b: number) => new Blob([new Uint8Array([b])], { type: 'image/jpeg' });

let root: Root | null = null;
let container: HTMLElement | null = null;
async function render(path: string) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      createElement(ToastProvider, null, createElement(MemoryRouter, { initialEntries: [path] }, createElement(Routes, null, createElement(Route, { path: '/coaching/messages/:relationshipId', element: createElement(MessagesPage) })))),
    );
  });
}
async function unmount() {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
}
async function waitFor<T>(fn: () => T, timeout = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    try {
      return fn();
    } catch (e) {
      if (Date.now() - start > timeout) throw e;
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
    }
  }
}
const textarea = () => {
  const el = container!.querySelector('textarea');
  if (!el || el.readOnly) throw new Error('composer not ready');
  return el as HTMLTextAreaElement;
};
function type(el: HTMLTextAreaElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  onLine = true;
  h.relStatus = 'active';
  h.userId = 'user-1';
  vi.clearAllMocks();
});
afterEach(async () => {
  await unmount();
  for (const d of dbs) {
    d.close();
    await d.delete();
  }
  dbs = [];
});

describe('coach draft storage', () => {
  it('stores text and photo blobs per relationship in the account database', async () => {
    const db = await openDb(`user-1-${suffix()}`);
    await saveCoachDraft(db, 'rel-1', { body: 'Hi', photos: [{ id: 'p1', blob: blob(1), thumb: blob(2), width: 4, height: 3 }] });
    const d = (await loadCoachDraft(db, 'rel-1'))!;
    expect(d).toMatchObject({ accountId: db.accountKey, relationshipId: 'rel-1', body: 'Hi' });
    // (jsdom Blobs don't survive fake-indexeddb's structured clone; browsers store Blobs natively, as the outbox already relies on.)
    expect(d.photos[0]).toMatchObject({ id: 'p1', width: 4, height: 3 });
    expect(d.photos[0]).toHaveProperty('blob');
    expect(await loadCoachDraft(db, 'rel-2')).toBeNull(); // other relationship
    await saveCoachDraft(db, 'rel-1', { body: '  ', photos: [] });
    expect(await db.kv.get(coachDraftKey('rel-1'))).toBeUndefined(); // empty draft removes it
  });

  it('never returns a draft written for another account or in a guest database', async () => {
    const a = await openDb(`user-1-${suffix()}`);
    const b = await openDb(`user-2-${suffix()}`);
    await saveCoachDraft(a, 'rel-1', { body: 'secret', photos: [] });
    expect(await loadCoachDraft(b, 'rel-1')).toBeNull();
    // A row that somehow carries a different account id is ignored.
    await b.kv.put({ key: coachDraftKey('rel-1'), value: { accountId: a.accountKey, relationshipId: 'rel-1', body: 'leak', photos: [], updatedAt: 1 } });
    expect(await loadCoachDraft(b, 'rel-1')).toBeNull();
    const guest = await openDb('guest');
    await saveCoachDraft(guest, 'rel-1', { body: 'x', photos: [] });
    expect(await guest.kv.count()).toBe(0);
  });

  it('queueing moves the draft into the outbox atomically; an invalid message keeps the draft', async () => {
    const db = await openDb(`user-1-${suffix()}`);
    await saveCoachDraft(db, 'rel-1', { body: 'Hello', photos: [] });
    await queueDraftMessage(db, { id: 'm1', relationshipId: 'rel-1', body: 'Hello' });
    expect(await db.coachOutbox.get('m1')).toMatchObject({ body: 'Hello', status: 'queued', accountId: db.accountKey });
    expect(await loadCoachDraft(db, 'rel-1')).toBeNull();

    await saveCoachDraft(db, 'rel-1', { body: 'x'.repeat(10), photos: [] });
    await expect(queueDraftMessage(db, { id: 'm2', relationshipId: 'rel-1', body: 'x'.repeat(5000) })).rejects.toThrow(/up to/);
    expect(await db.coachOutbox.get('m2')).toBeUndefined();
    expect((await loadCoachDraft(db, 'rel-1'))?.body).toBe('x'.repeat(10));
  });

  it('a queued draft is not sent when the relationship no longer allows messages', async () => {
    const db = await openDb(`user-1-${suffix()}`);
    h.userId = db.accountKey;
    await queueDraftMessage(db, { id: 'm1', relationshipId: 'rel-1', body: 'Hello' });
    h.relStatus = 'ended';
    await processCoachOutbox(db, { accountId: db.accountKey });
    expect(api.coachingApi.myRelationships).toHaveBeenCalled();
    expect(api.coachingApi.sendMessage).not.toHaveBeenCalled();
    expect((await db.coachOutbox.get('m1'))?.status).toBe('failed');
  });

  it('merges text handed over from another screen into an existing draft once', () => {
    expect(mergeIncomingText('', 'About week 2')).toBe('About week 2');
    expect(mergeIncomingText('Hi', 'About week 2')).toBe('Hi\n\nAbout week 2');
    expect(mergeIncomingText('Hi\n\nAbout week 2', 'About week 2')).toBe('Hi\n\nAbout week 2');
  });
});

describe('MessagesPage composer', () => {
  it('keeps unsent text across navigation and reload, and clears it after sending', async () => {
    const name = `user-1-${suffix()}`;
    h.userId = name;
    h.db = await openDb(name);
    await render('/coaching/messages/rel-1');
    type(await waitFor(textarea), 'Unsent question about squats');
    await unmount(); // navigate away before the debounce fires
    expect((await loadCoachDraft(h.db as LiftDb, 'rel-1'))?.body).toBe('Unsent question about squats');

    // "Reload": a brand-new database connection, fresh render.
    (h.db as LiftDb).close();
    h.db = await openDb(name);
    await render('/coaching/messages/rel-1');
    expect((await waitFor(textarea)).value).toBe('Unsent question about squats');

    // Send → goes through the outbox (permission re-check) and the draft is gone.
    await act(async () => {
      container!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await waitFor(() => expect(api.coachingApi.sendMessage).toHaveBeenCalledTimes(1));
    expect(api.coachingApi.myRelationships).toHaveBeenCalled();
    expect(textarea().value).toBe('');
    expect(await loadCoachDraft(h.db as LiftDb, 'rel-1')).toBeNull();
  });

  it('restores draft photos and merges ?draft= text without losing the saved draft', async () => {
    const name = `user-1-${suffix()}`;
    h.userId = name;
    h.db = await openDb(name);
    await saveCoachDraft(h.db as LiftDb, 'rel-1', { body: 'Saved text', photos: [{ id: 'p1', blob: blob(1), thumb: blob(2), width: 4, height: 3 }] });
    await render(`/coaching/messages/rel-1?draft=${encodeURIComponent('About the proposal')}`);
    expect((await waitFor(textarea)).value).toBe('Saved text\n\nAbout the proposal');
    expect(container!.querySelectorAll('ul[aria-label="Photos to send"] img')).toHaveLength(1);
    await unmount();
    expect((await loadCoachDraft(h.db as LiftDb, 'rel-1'))?.body).toBe('Saved text\n\nAbout the proposal');
  });

  it('does not show one account’s draft to another account', async () => {
    const a = await openDb(`user-1-${suffix()}`);
    await saveCoachDraft(a, 'rel-1', { body: 'Private draft', photos: [] });
    const name = `user-2-${suffix()}`;
    h.userId = name;
    h.db = await openDb(name);
    await render('/coaching/messages/rel-1');
    expect((await waitFor(textarea)).value).toBe('');
  });
});
