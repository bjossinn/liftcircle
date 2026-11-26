// @vitest-environment jsdom
/**
 * Device-level push operations are bound to the account that started them (src/pwa/push.ts): enable, disable, refresh
 * and the service worker's subscription-change handler re-check the backend session (and the caller's own
 * cancellation) after every await, pass expectedUserId to the server, and never cache under the wrong account.
 * A → B → A on one browser: ownership of the shared endpoint is checked on the server, not assumed from the cache.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  currentUserId: vi.fn(async (): Promise<string | null> => 'user-a'),
  saveSubscription: vi.fn(async () => ({ id: 's', endpoint: 'https://push.example/1' })),
  deleteSubscription: vi.fn(async () => true),
  deviceOwner: vi.fn(async (): Promise<'mine' | 'other' | 'none'> => 'mine'),
  getPrefs: vi.fn(async () => ({ kinds: ['workout_reminder'], fixedReminderTime: null, timeZone: 'UTC', quietStart: '22:00', quietEnd: '07:00', dailyCap: 2, snoozeUntil: null, revision: 1, coachSupported: true })),
  setPrefs: vi.fn(async () => ({ kinds: ['workout_reminder'], fixedReminderTime: null, timeZone: 'UTC', quietStart: '22:00', quietEnd: '07:00', dailyCap: 2, snoozeUntil: null, revision: 1, coachSupported: true })),
}));
vi.mock('@/backend/push', async (orig) => ({ ...((await orig()) as object), pushApi: api }));

import { deviceKey, disablePush, enablePush, listenForSubscriptionChanges, prefsKey, refreshPushSubscription } from '@/pwa/push';
import { BackendError } from '@/backend/syncRemote';

const KEY = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const SUB = { endpoint: 'https://push.example/1', toJSON: () => ({ endpoint: 'https://push.example/1', keys: { p256dh: KEY, auth: 'BTBZMqHH6r4Tts7J_aSIgg' } }), unsubscribe: vi.fn(async () => true) };
let swListener: ((e: MessageEvent) => void) | null = null;
let permission: NotificationPermission = 'granted';
const requestPermission = vi.fn(async () => permission);

beforeEach(() => {
  localStorage.clear();
  vi.stubEnv('VITE_VAPID_PUBLIC_KEY', KEY);
  for (const f of Object.values(api)) f.mockClear();
  api.currentUserId.mockImplementation(async () => 'user-a');
  api.deviceOwner.mockImplementation(async () => 'mine');
  permission = 'granted';
  requestPermission.mockImplementation(async () => permission);
  SUB.unsubscribe.mockClear();
  Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => 'Mozilla/5.0 (Linux; Android 14) Chrome/130' });
  (globalThis as { Notification?: unknown }).Notification = { get permission() { return permission; }, requestPermission };
  (window as unknown as { PushManager: unknown }).PushManager = function PushManager() {};
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      ready: Promise.resolve({ pushManager: { getSubscription: async () => SUB, subscribe: async () => SUB } }),
      addEventListener: (_t: string, fn: (e: MessageEvent) => void) => void (swListener = fn),
      removeEventListener: () => void (swListener = null),
    },
  });
});
const flush = () => new Promise((r) => setTimeout(r, 10));

describe('enable / disable are bound to the initiating account', () => {
  it('enable writes with expectedUserId and caches under that account', async () => {
    expect(await enablePush('user-a', 'UTC')).toEqual({ ok: true });
    expect(api.saveSubscription).toHaveBeenCalledWith(expect.objectContaining({ endpoint: SUB.endpoint }), 'user-a');
    expect(api.setPrefs).toHaveBeenCalledWith({ timeZone: 'UTC' }, 'user-a');
    expect(localStorage.getItem(deviceKey('user-a'))).toContain(SUB.endpoint);
  });

  it('a permission prompt that resolves after a switch to B writes nothing (caller cancellation or a different session)', async () => {
    let answer!: (p: NotificationPermission) => void;
    requestPermission.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    let current = true;
    const p = enablePush('user-a', 'UTC', () => current);
    current = false; // the screen moved on to B
    answer('granted');
    expect(await p).toEqual({ ok: false, reason: 'cancelled' });
    api.currentUserId.mockImplementation(async () => 'user-b'); // or: the backend session is B's
    expect(await enablePush('user-a', 'UTC')).toEqual({ ok: false, reason: 'cancelled' });
    expect(api.saveSubscription).not.toHaveBeenCalled();
    expect(localStorage.getItem(deviceKey('user-a'))).toBeNull();
    expect(localStorage.getItem(deviceKey('user-b'))).toBeNull();
  });

  it('the server refusing for another account ("account changed") is a quiet cancel, not an error', async () => {
    api.saveSubscription.mockRejectedValueOnce(new BackendError('The signed-in account changed. Nothing was saved.', 'P0001', 400));
    expect(await enablePush('user-a', 'UTC')).toEqual({ ok: false, reason: 'cancelled' });
    expect(localStorage.getItem(deviceKey('user-a'))).toBeNull();
  });

  it('disable only runs for the account that asked', async () => {
    localStorage.setItem(deviceKey('user-a'), JSON.stringify({ endpoint: SUB.endpoint }));
    api.currentUserId.mockImplementation(async () => 'user-b');
    expect(await disablePush('user-a')).toBe(false);
    expect(SUB.unsubscribe).not.toHaveBeenCalled();
    expect(api.deleteSubscription).not.toHaveBeenCalled();
    api.currentUserId.mockImplementation(async () => 'user-a');
    expect(await disablePush('user-a')).toBe(true);
    expect(api.deleteSubscription).toHaveBeenCalledWith(SUB.endpoint, 'user-a');
    expect(localStorage.getItem(deviceKey('user-a'))).toBeNull();
  });
});

describe('refresh reconciles endpoint ownership (A → B → A on one browser)', () => {
  it('an unchanged endpoint now owned by B is taken back when A returns; a mine endpoint is left alone', async () => {
    localStorage.setItem(deviceKey('user-a'), JSON.stringify({ endpoint: SUB.endpoint }));
    await refreshPushSubscription('user-a');
    expect(api.deviceOwner).toHaveBeenCalledWith(SUB.endpoint);
    expect(api.saveSubscription).not.toHaveBeenCalled(); // still A's
    // B enabled push on the same browser meanwhile (same endpoint): the server row now belongs to B.
    api.deviceOwner.mockImplementation(async () => 'other');
    await refreshPushSubscription('user-a');
    expect(api.saveSubscription).toHaveBeenCalledWith(expect.objectContaining({ endpoint: SUB.endpoint }), 'user-a');
    expect(localStorage.getItem(prefsKey('user-a'))).toContain('workout_reminder');
  });

  it('a refresh that outlives an account switch neither writes nor caches for A', async () => {
    localStorage.setItem(deviceKey('user-a'), JSON.stringify({ endpoint: SUB.endpoint }));
    api.deviceOwner.mockImplementation(async () => 'other');
    api.currentUserId.mockImplementation(async () => 'user-b');
    await refreshPushSubscription('user-a');
    expect(api.saveSubscription).not.toHaveBeenCalled();
    expect(localStorage.getItem(prefsKey('user-a'))).toBeNull();
    let current = true;
    api.currentUserId.mockImplementation(async () => 'user-a');
    api.getPrefs.mockImplementationOnce(async () => {
      current = false; // switched while loading
      return { kinds: ['food_unlogged'], fixedReminderTime: null, timeZone: 'UTC', quietStart: '22:00', quietEnd: '07:00', dailyCap: 3, snoozeUntil: null, revision: 9, coachSupported: true };
    });
    api.deviceOwner.mockImplementation(async () => 'mine');
    await refreshPushSubscription('user-a', () => current);
    expect(localStorage.getItem(prefsKey('user-a'))).toBeNull();
  });
});

describe('service worker subscription change', () => {
  it('uploads the new endpoint for the listening account only, and stops after the account changes', async () => {
    localStorage.setItem(deviceKey('user-a'), JSON.stringify({ endpoint: 'https://push.example/old' }));
    const stop = listenForSubscriptionChanges('user-a');
    const msg = { data: { type: 'lc-push-subscription-changed', subscription: { endpoint: 'https://push.example/new', keys: { p256dh: KEY, auth: 'BTBZMqHH6r4Tts7J_aSIgg' } } } } as MessageEvent;
    api.currentUserId.mockImplementation(async () => 'user-b');
    swListener!(msg);
    await flush();
    expect(api.saveSubscription).not.toHaveBeenCalled();
    api.currentUserId.mockImplementation(async () => 'user-a');
    swListener!(msg);
    await flush();
    expect(api.saveSubscription).toHaveBeenCalledWith(expect.objectContaining({ endpoint: 'https://push.example/new' }), 'user-a');
    expect(api.deleteSubscription).toHaveBeenCalledWith('https://push.example/old', 'user-a');
    expect(localStorage.getItem(deviceKey('user-a'))).toContain('/new');
    stop();
    expect(swListener).toBeNull();
  });
});
