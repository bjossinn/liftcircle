/**
 * public/push-sw.js (imported into the Workbox service worker): a push always shows a notification with the payload,
 * a click focuses an open LiftCircle window (navigating it) or opens the deep link, and the file adds no caching.
 * Evaluated with a fake ServiceWorkerGlobalScope as `self`.
 */
import { describe, expect, it, vi } from 'vitest';
import SRC from '../../public/push-sw.js?raw';
const ORIGIN = 'https://liftcircle.example';

function load(windows: { url: string }[] = []) {
  const handlers: Record<string, (e: unknown) => void> = {};
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const clientsList = windows.map((w) => ({
    url: w.url,
    focus: vi.fn(async function (this: unknown) {
      return this;
    }),
    navigate: vi.fn(async function (this: { url: string }, u: string) {
      this.url = u;
      return this;
    }),
  }));
  const self = {
    location: { origin: ORIGIN },
    registration: { showNotification: vi.fn(async (title: string, options: Record<string, unknown>) => void shown.push({ title, options })), pushManager: {} },
    clients: { matchAll: vi.fn(async () => clientsList), openWindow: vi.fn(async (u: string) => ({ url: u })) },
    addEventListener: (type: string, fn: (e: unknown) => void) => void (handlers[type] = fn),
  };
  // Evaluate the classic worker script with `self` bound to the fake scope.
  new Function('self', SRC)(self);
  const dispatch = async (type: string, event: Record<string, unknown>) => {
    let waited: Promise<unknown> = Promise.resolve();
    handlers[type]({ ...event, waitUntil: (p: Promise<unknown>) => void (waited = p) });
    await waited;
  };
  return { self, handlers, shown, clientsList, dispatch };
}
const pushEvent = (data: unknown) => ({ data: { json: () => (typeof data === 'string' ? JSON.parse(data) : data), text: () => String(data) } });

describe('service worker push handlers', () => {
  it('registers push, notificationclick and pushsubscriptionchange — and no fetch handler or caching', () => {
    const { handlers } = load();
    expect(Object.keys(handlers).sort()).toEqual(['notificationclick', 'push', 'pushsubscriptionchange']);
    expect(SRC).not.toMatch(/caches\.|registerRoute|addEventListener\(['"]fetch/);
  });

  it('a push shows a notification with the payload (tag per kind so newer ones replace older)', async () => {
    const sw = load();
    await sw.dispatch('push', pushEvent({ title: 'LiftCircle', body: 'Rest’s up: Bench press set 3, 60 kg × 8', url: '/train/session/w1', tag: 'rest' }));
    expect(sw.shown).toHaveLength(1);
    expect(sw.shown[0].title).toBe('LiftCircle');
    expect(sw.shown[0].options).toMatchObject({ body: 'Rest’s up: Bench press set 3, 60 kg × 8', tag: 'rest', renotify: true, data: { url: '/train/session/w1' } });
  });

  it('every push shows something, even with an empty or broken payload; external URLs are refused', async () => {
    const sw = load();
    await sw.dispatch('push', { data: null });
    await sw.dispatch('push', { data: { json: () => { throw new Error('bad'); }, text: () => 'plain text' } });
    await sw.dispatch('push', pushEvent({ title: 'X', url: '//evil.example/phish' }));
    expect(sw.shown.map((s) => s.title)).toEqual(['LiftCircle', 'LiftCircle', 'X']);
    expect(sw.shown[1].options.body).toBe('plain text');
    expect((sw.shown[2].options.data as { url: string }).url).toBe('/');
  });

  it('click focuses an open LiftCircle window and navigates it to the deep link', async () => {
    const sw = load([{ url: `${ORIGIN}/progress` }]);
    const close = vi.fn();
    await sw.dispatch('notificationclick', { notification: { close, data: { url: '/coaching/messages/r1' } } });
    expect(close).toHaveBeenCalled();
    expect(sw.clientsList[0].navigate).toHaveBeenCalledWith(`${ORIGIN}/coaching/messages/r1`);
    expect(sw.clientsList[0].focus).toHaveBeenCalled();
    expect(sw.self.clients.openWindow).not.toHaveBeenCalled();
  });

  it('click with no open window opens the deep link', async () => {
    const sw = load([]);
    await sw.dispatch('notificationclick', { notification: { close: () => undefined, data: { url: '/feed/post/p1' } } });
    expect(sw.self.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/feed/post/p1`);
  });
});
