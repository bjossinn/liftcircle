// @vitest-environment jsdom
/**
 * Settings → Push notifications (src/features/settings/PushSection.tsx) with the real device logic (src/pwa/push.ts),
 * a MOCKED pushApi and stubbed browser APIs: hidden without a VAPID key, iPhone-not-installed explanation (no button),
 * denied state, the permission prompt only on the tap, per-type toggles (social off by default), fixed time,
 * test button and turning it off on this device.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ auth: { status: 'signed_in' as string } }));
vi.mock('@/state/app', () => ({
  useApp: () => ({ auth: h.auth, online: true, account: { settings: { timeZone: 'Europe/Oslo' } } }),
}));
const api = vi.hoisted(() => ({
  saveSubscription: vi.fn(async () => ({ id: 'sub1', endpoint: 'https://push.example/1' })),
  deleteSubscription: vi.fn(async () => true),
  getPrefs: vi.fn(),
  setPrefs: vi.fn(),
  replaceJobs: vi.fn(async () => 0),
  cancelJob: vi.fn(async () => true),
  sendTest: vi.fn(async () => ({ queued: true })),
}));
vi.mock('@/backend/push', async (orig) => ({ ...((await orig()) as object), pushApi: api }));

import { ToastProvider } from '@/components/toast';
import { PushSection } from '@/features/settings/PushSection';
import { DEFAULT_PUSH_PREFS, type PushPrefs } from '@/domain/pushSchedule';

const KEY = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
let root: Root | null = null;
let el: HTMLElement | null = null;
let serverPrefs: PushPrefs;
let permission: NotificationPermission;
const requestPermission = vi.fn(async () => permission);
const subscribe = vi.fn(async () => ({ endpoint: 'https://push.example/1', toJSON: () => ({ endpoint: 'https://push.example/1', keys: { p256dh: KEY, auth: 'BTBZMqHH6r4Tts7J_aSIgg' } }), unsubscribe: vi.fn(async () => true) }));
let existing: unknown = null;

function device({ ua, standalone = false, perm = 'default' as NotificationPermission }: { ua: string; standalone?: boolean; perm?: NotificationPermission }) {
  permission = perm;
  Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => ua });
  window.matchMedia = ((q: string) => ({ matches: standalone && q.includes('standalone'), addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  (globalThis as { Notification?: unknown }).Notification = { get permission() { return permission; }, requestPermission };
  (window as unknown as { PushManager: unknown }).PushManager = function PushManager() {};
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { ready: Promise.resolve({ pushManager: { getSubscription: async () => existing, subscribe } }), addEventListener() {}, removeEventListener() {} },
  });
}
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';

const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 20))));
async function render() {
  el = document.createElement('div');
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(createElement(ToastProvider, null, createElement(MemoryRouter, null, createElement(PushSection)))));
  await flush();
}
const text = () => document.body.textContent?.replace(/\s+/g, ' ') ?? '';
const button = (name: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === name) ?? null;
const toggle = (label: string) => {
  const l = [...document.querySelectorAll('label')].find((x) => x.textContent === label);
  return l ? (document.getElementById(l.htmlFor) as HTMLButtonElement) : null;
};
const click = async (b: Element | null) => {
  if (!b) throw new Error('missing element');
  await act(async () => void b.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await flush();
};

beforeEach(() => {
  localStorage.clear();
  vi.stubEnv('VITE_VAPID_PUBLIC_KEY', KEY);
  h.auth = { status: 'signed_in' };
  existing = null;
  serverPrefs = { ...DEFAULT_PUSH_PREFS, timeZone: 'Europe/Oslo' };
  api.getPrefs.mockImplementation(async () => ({ ...serverPrefs }));
  api.setPrefs.mockImplementation(async (p: Partial<PushPrefs>) => (serverPrefs = { ...serverPrefs, ...p }));
  for (const f of Object.values(api)) f.mockClear();
  requestPermission.mockClear();
  subscribe.mockClear();
});
afterEach(() => {
  act(() => root?.unmount());
  el?.remove();
  vi.unstubAllEnvs();
});

describe('push notification settings', () => {
  it('is hidden entirely when the build has no VAPID public key', async () => {
    vi.stubEnv('VITE_VAPID_PUBLIC_KEY', '');
    device({ ua: ANDROID });
    await render();
    expect(text()).not.toMatch(/Push notifications/);
  });

  it('iPhone not installed to the Home Screen: explains Share → Add to Home Screen, links /install, no button', async () => {
    device({ ua: IPHONE, standalone: false });
    await render();
    expect(document.querySelector('[data-testid="push-ios-install"]')).toBeTruthy();
    expect(text()).toMatch(/only work in the installed app/);
    expect(text()).toMatch(/Share, then Add to Home Screen/);
    expect(document.querySelector('a[href="/install"]')).toBeTruthy();
    expect(button('Turn on notifications')).toBeNull();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('iPhone installed (standalone) gets the normal button', async () => {
    device({ ua: IPHONE, standalone: true });
    await render();
    expect(button('Turn on notifications')).toBeTruthy();
  });

  it('denied permission: explains how to re-enable it in settings', async () => {
    device({ ua: ANDROID, perm: 'denied' });
    await render();
    expect(document.querySelector('[data-testid="push-denied"]')).toBeTruthy();
    expect(text()).toMatch(/Settings → Notifications → LiftCircle/);
    expect(button('Turn on notifications')).toBeNull();
  });

  it('asks for permission only on the tap, subscribes, stores the device, and shows toggles (social off by default)', async () => {
    device({ ua: ANDROID });
    await render();
    expect(requestPermission).not.toHaveBeenCalled();
    permission = 'granted';
    await click(button('Turn on notifications'));
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    expect(api.saveSubscription).toHaveBeenCalledWith(expect.objectContaining({ endpoint: 'https://push.example/1', p256dh: KEY, auth: 'BTBZMqHH6r4Tts7J_aSIgg' }));
    expect(api.setPrefs).toHaveBeenCalledWith({ timeZone: 'Europe/Oslo' });
    expect(text()).toMatch(/Notifications are on for this device/);
    for (const l of ['Workout reminders', 'Rest-over alerts', 'Coaching messages', 'Missed-session nudges']) expect(toggle(l)?.getAttribute('aria-checked')).toBe('true');
    expect(toggle('Friends & social')?.getAttribute('aria-checked')).toBe('false');
    expect(toggle('Remind me at a fixed time')?.getAttribute('aria-checked')).toBe('false');
  });

  it('toggles save the enabled kinds; the fixed time override can be turned on', async () => {
    device({ ua: ANDROID, perm: 'granted' });
    localStorage.setItem('lc-push-device', JSON.stringify({ endpoint: 'https://push.example/1' }));
    await render();
    await click(toggle('Friends & social'));
    expect(api.setPrefs).toHaveBeenLastCalledWith({ kinds: ['workout_reminder', 'rest_over', 'coaching', 'missed_nudge', 'social'] });
    expect(toggle('Friends & social')?.getAttribute('aria-checked')).toBe('true');
    await click(toggle('Rest-over alerts'));
    expect(api.setPrefs).toHaveBeenLastCalledWith({ kinds: ['workout_reminder', 'coaching', 'missed_nudge', 'social'] });
    await click(toggle('Remind me at a fixed time'));
    expect(api.setPrefs).toHaveBeenLastCalledWith({ fixedReminderTime: '17:00' });
    expect((document.querySelector('input[type="time"]') as HTMLInputElement).value).toBe('17:00');
  });

  it('the test button queues a test notification; "Turn off on this device" unsubscribes and deletes the server row', async () => {
    device({ ua: ANDROID, perm: 'granted' });
    localStorage.setItem('lc-push-device', JSON.stringify({ endpoint: 'https://push.example/1' }));
    const unsubscribe = vi.fn(async () => true);
    existing = { endpoint: 'https://push.example/1', unsubscribe };
    await render();
    await click(button('Send a test notification'));
    expect(api.sendTest).toHaveBeenCalledTimes(1);
    expect(text()).toMatch(/Test notification on its way/);
    await click(button('Turn off on this device'));
    expect(unsubscribe).toHaveBeenCalled();
    expect(api.deleteSubscription).toHaveBeenCalledWith('https://push.example/1');
    expect(button('Turn on notifications')).toBeTruthy();
    expect(localStorage.getItem('lc-push-device')).toBeNull();
  });

  it('signed out: explains that an account is needed', async () => {
    h.auth = { status: 'guest' };
    device({ ua: ANDROID });
    await render();
    expect(text()).toMatch(/Sign in to get reminders/);
    expect(button('Turn on notifications')).toBeNull();
  });
});
