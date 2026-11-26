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

const h = vi.hoisted(() => ({
  auth: { status: 'signed_in', userId: 'user-a' } as { status: string; userId?: string },
  online: true,
  settings: { timeZone: 'Europe/Oslo', nutritionEnabled: true } as { timeZone: string; nutritionEnabled: boolean },
}));
vi.mock('@/state/app', () => ({
  useApp: () => ({ auth: h.auth, online: h.online, account: { settings: h.settings } }),
}));
const api = vi.hoisted(() => ({
  saveSubscription: vi.fn(async () => ({ id: 'sub1', endpoint: 'https://push.example/1' })),
  deleteSubscription: vi.fn(async () => true),
  getPrefs: vi.fn(),
  setPrefs: vi.fn(),
  updatePrefs: vi.fn(),
  replaceJobs: vi.fn(async () => 0),
  cancelJob: vi.fn(async () => true),
  sendTest: vi.fn(async () => ({ queued: true })),
  recordSyncComplete: vi.fn(async () => true),
}));
vi.mock('@/backend/push', async (orig) => ({ ...((await orig()) as object), pushApi: api }));

import { ToastProvider } from '@/components/toast';
import { PushSection } from '@/features/settings/PushSection';
import { DEFAULT_PUSH_PREFS, type PushPrefs } from '@/domain/pushSchedule';
import type { PushPrefsPatch, ServerPushPrefs } from '@/backend/push';
import { setLanguage } from '@/i18n';

const KEY = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
let root: Root | null = null;
let el: HTMLElement | null = null;
let serverPrefs: ServerPushPrefs;
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
const tree = () => createElement(ToastProvider, null, createElement(MemoryRouter, null, createElement(PushSection)));
async function render() {
  el = document.createElement('div');
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(tree()));
  await flush();
}
async function rerender() {
  await act(async () => root!.render(tree()));
  await flush();
}
const select = (label: string) => {
  const l = [...document.querySelectorAll('label')].find((x) => x.textContent === label);
  return l ? (document.getElementById(l.htmlFor) as HTMLSelectElement) : null;
};
const choose = async (s: HTMLSelectElement | null, value: string) => {
  if (!s) throw new Error('missing select');
  await act(async () => {
    s.value = value;
    s.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
};
const DEVICE = 'lc-push-device:user-a';
/** A versioned server: applies the patch when the revision matches, like update_push_prefs. */
function versionedServer() {
  api.updatePrefs.mockImplementation(async (patch: PushPrefsPatch, rev: number) => {
    if (rev !== serverPrefs.revision) return { status: 'conflict', prefs: { ...serverPrefs } };
    const { snoozeDays, resume, ...rest } = patch;
    serverPrefs = {
      ...serverPrefs,
      ...rest,
      ...(snoozeDays ? { snoozeUntil: new Date(Date.now() + snoozeDays * 86_400_000).toISOString() } : {}),
      ...(resume ? { snoozeUntil: null } : {}),
      revision: serverPrefs.revision + 1,
    };
    return { status: 'ok', prefs: { ...serverPrefs } };
  });
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
  setLanguage('en');
  vi.stubEnv('VITE_VAPID_PUBLIC_KEY', KEY);
  h.auth = { status: 'signed_in', userId: 'user-a' };
  h.online = true;
  h.settings = { timeZone: 'Europe/Oslo', nutritionEnabled: true };
  existing = null;
  serverPrefs = { ...DEFAULT_PUSH_PREFS, timeZone: 'Europe/Oslo', revision: 1, coachSupported: true, devices: 1 };
  for (const f of Object.values(api)) f.mockReset();
  api.saveSubscription.mockImplementation(async () => ({ id: 'sub1', endpoint: 'https://push.example/1' }));
  api.deleteSubscription.mockImplementation(async () => true);
  api.sendTest.mockImplementation(async () => ({ queued: true }));
  api.getPrefs.mockImplementation(async () => ({ ...serverPrefs }));
  api.setPrefs.mockImplementation(async (p: Partial<PushPrefs>) => (serverPrefs = { ...serverPrefs, ...p }));
  versionedServer();
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
    expect(text()).toMatch(/Settings → Notifications → Hard Earned/);
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
    expect(localStorage.getItem(DEVICE)).toContain('push.example/1');
    for (const l of ['Workout reminders', 'Rest-over alerts', 'Coaching messages', 'Missed-session nudges']) expect(toggle(l)?.getAttribute('aria-checked')).toBe('true');
    expect(toggle('Friends & social')?.getAttribute('aria-checked')).toBe('false');
    expect(toggle('Food-log reminders')?.getAttribute('aria-checked')).toBe('false'); // off by default
    expect(toggle('Remind me at a fixed time')?.getAttribute('aria-checked')).toBe('false');
    expect(text()).toMatch(/Coach notifications.*Other notifications/);
  });

  it('toggles save one versioned patch each; the fixed time override can be turned on', async () => {
    device({ ua: ANDROID, perm: 'granted' });
    localStorage.setItem(DEVICE, JSON.stringify({ endpoint: 'https://push.example/1' }));
    await render();
    await click(toggle('Friends & social'));
    expect(api.updatePrefs).toHaveBeenLastCalledWith({ kinds: ['workout_reminder', 'rest_over', 'coaching', 'missed_nudge', 'social'] }, 1);
    expect(toggle('Friends & social')?.getAttribute('aria-checked')).toBe('true');
    expect(text()).toMatch(/Reminder settings saved\./);
    await click(toggle('Rest-over alerts'));
    expect(api.updatePrefs).toHaveBeenLastCalledWith({ kinds: ['workout_reminder', 'coaching', 'missed_nudge', 'social'] }, 2);
    await click(toggle('Food-log reminders'));
    expect(api.updatePrefs).toHaveBeenLastCalledWith({ kinds: ['workout_reminder', 'coaching', 'missed_nudge', 'social', 'food_unlogged'] }, 3);
    await click(toggle('Remind me at a fixed time'));
    expect(api.updatePrefs).toHaveBeenLastCalledWith({ fixedReminderTime: '17:00' }, 4);
    expect((document.querySelector('input[type="time"]') as HTMLInputElement).value).toBe('17:00');
    expect(api.setPrefs).not.toHaveBeenCalled();
  });

  it('the test button queues a test notification; "Turn off on this device" unsubscribes and deletes the server row', async () => {
    device({ ua: ANDROID, perm: 'granted' });
    localStorage.setItem(DEVICE, JSON.stringify({ endpoint: 'https://push.example/1' }));
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
    expect(localStorage.getItem(DEVICE)).toBeNull();
    expect(text()).toMatch(/Push notifications are off on this device\. Your choices still apply to other enabled devices\./);
  });

  it('daily limit: 1, 2 or 3 per day (default 2), saved as a versioned patch', async () => {
    device({ ua: ANDROID, perm: 'granted' });
    localStorage.setItem(DEVICE, JSON.stringify({ endpoint: 'https://push.example/1' }));
    await render();
    const cap = select('Daily reminder limit');
    expect(cap?.value).toBe('2');
    expect([...cap!.options].map((o) => o.textContent)).toEqual(['1 reminder per day', '2 reminders per day', '3 reminders per day']);
    await choose(cap, '3');
    expect(api.updatePrefs).toHaveBeenLastCalledWith({ dailyCap: 3 }, 1);
    expect(text()).toMatch(/The daily limit and pause apply to workout, missed-workout and food-log reminders across all your devices\./);
    // A value the server rejects shows the validation message.
    api.updatePrefs.mockResolvedValueOnce({ status: 'invalid', field: 'cap', prefs: { ...serverPrefs } });
    await choose(select('Daily reminder limit'), '1');
    expect(text()).toMatch(/Choose 1, 2 or 3 reminders per day\./);
  });

  it('pause: waits for the server before saying it took effect; resume; failures say so', async () => {
    device({ ua: ANDROID, perm: 'granted' });
    localStorage.setItem(DEVICE, JSON.stringify({ endpoint: 'https://push.example/1' }));
    await render();
    expect([...select('Pause length')!.options].map((o) => o.textContent)).toEqual(['1 day', '3 days', '7 days', '14 days']);
    await choose(select('Pause length'), '7');
    let resolve!: () => void;
    const gate = new Promise<void>((r) => (resolve = r));
    const real = api.updatePrefs.getMockImplementation()!;
    api.updatePrefs.mockImplementationOnce(async (p: PushPrefsPatch, rev: number) => {
      await gate;
      return real(p, rev);
    });
    await click(button('Rest me for 7 days'));
    expect(api.updatePrefs).toHaveBeenLastCalledWith({ snoozeDays: 7 }, 1);
    expect(text()).toMatch(/Pausing reminders…/);
    expect(text()).not.toMatch(/paused until/);
    await act(async () => resolve());
    await flush();
    expect(text()).toMatch(/Coach reminders are paused until .+\./);
    await click(button('Resume reminders'));
    expect(api.updatePrefs).toHaveBeenLastCalledWith({ resume: true }, 2);
    expect(text()).toMatch(/Your selected coach reminders are active again\./);
    api.updatePrefs.mockRejectedValueOnce(new Error('server down'));
    await click(button('Rest me for 7 days'));
    expect(text()).toMatch(/Couldn’t pause reminders\. Please try again\./);
    expect(text()).not.toMatch(/paused until/);
    expect(text()).toMatch(/Your selected coach reminders are active\./);
  });

  it('a change saved on another device first: nothing is overwritten, the latest settings load and the user is told', async () => {
    device({ ua: ANDROID, perm: 'granted' });
    localStorage.setItem(DEVICE, JSON.stringify({ endpoint: 'https://push.example/1' }));
    await render();
    serverPrefs = { ...serverPrefs, kinds: ['rest_over'], revision: 5 }; // another device turned reminders off
    await click(toggle('Friends & social'));
    expect(api.updatePrefs).toHaveBeenLastCalledWith(expect.anything(), 1);
    expect(text()).toMatch(/Your reminder settings changed on another device\. The latest settings have been loaded\./);
    expect(toggle('Workout reminders')?.getAttribute('aria-checked')).toBe('false');
    expect(toggle('Friends & social')?.getAttribute('aria-checked')).toBe('false');
    expect(text()).toMatch(/All coach reminders are off\./);
  });

  it('offline: every change is disabled with the offline notice; the last saved settings still show', async () => {
    device({ ua: ANDROID, perm: 'granted' });
    localStorage.setItem(DEVICE, JSON.stringify({ endpoint: 'https://push.example/1' }));
    h.online = false;
    await render();
    expect(text()).toMatch(/You’re offline\. Connect to change reminder settings or pause reminders\. Your last saved settings still apply\./);
    expect(toggle('Workout reminders')?.disabled).toBe(true);
    expect(toggle('Friends & social')?.disabled).toBe(true);
    expect(api.getPrefs).not.toHaveBeenCalled();
    expect(api.updatePrefs).not.toHaveBeenCalled();
  });

  it('food-log reminders need nutrition features; quiet hours show their summary, "off" when start = end, and the time zone', async () => {
    device({ ua: ANDROID, perm: 'granted' });
    localStorage.setItem(DEVICE, JSON.stringify({ endpoint: 'https://push.example/1' }));
    h.settings = { timeZone: 'Europe/Oslo', nutritionEnabled: false };
    serverPrefs = { ...serverPrefs, kinds: [...serverPrefs.kinds, 'food_unlogged'] };
    await render();
    expect(toggle('Food-log reminders')?.disabled).toBe(true);
    expect(toggle('Food-log reminders')?.getAttribute('aria-checked')).toBe('false');
    expect(text()).toMatch(/One reminder at 19:00 if no food has been logged that day\. Off by default\./);
    expect(text()).toMatch(/Turn on nutrition features to use food-log reminders\./);
    expect(document.querySelector('a[href="/nutrition"]')?.textContent).toBe('Open nutrition');
    expect(text()).toMatch(/Quiet hours: 22:00–07:00\./);
    expect(text()).toMatch(/Time zone: Europe\/Oslo/);
    const start = [...document.querySelectorAll('label')].find((x) => x.textContent === 'Quiet hours start')!;
    const input = document.getElementById(start.htmlFor) as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '07:00');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    expect(api.updatePrefs).toHaveBeenLastCalledWith({ quietStart: '07:00' }, 1);
    expect(text()).toMatch(/Quiet hours are off\./);
  });

  it('load failure offers a retry; a server without coach notifications shows the unavailable state', async () => {
    device({ ua: ANDROID, perm: 'granted' });
    localStorage.setItem(DEVICE, JSON.stringify({ endpoint: 'https://push.example/1' }));
    api.getPrefs.mockRejectedValueOnce(new Error('down'));
    await render();
    expect(text()).toMatch(/Couldn’t load your reminder settings\. Please try again\./);
    expect(toggle('Workout reminders')?.disabled).toBe(true);
    serverPrefs = { ...serverPrefs, coachSupported: false };
    await click(button('Try again'));
    expect(text()).toMatch(/Coach notification settings aren’t available right now\. Please try again later\./);
    expect(select('Daily reminder limit')).toBeNull();
  });

  it('account switching never inherits the opt-in, cached settings or a pending load of the previous account', async () => {
    device({ ua: ANDROID, perm: 'granted' });
    localStorage.setItem(DEVICE, JSON.stringify({ endpoint: 'https://push.example/1' }));
    const aPrefs = { ...serverPrefs, kinds: [...serverPrefs.kinds, 'food_unlogged', 'social'] as ServerPushPrefs['kinds'], dailyCap: 3 as const };
    localStorage.setItem('lc-push-prefs:user-a', JSON.stringify(aPrefs));
    // A's settings are still loading when user B signs in on the same device.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    api.getPrefs.mockImplementationOnce(async () => {
      await gate;
      return aPrefs;
    });
    await render();
    expect(toggle('Food-log reminders')?.getAttribute('aria-checked')).toBe('true');
    h.auth = { status: 'signed_in', userId: 'user-b' };
    serverPrefs = { ...DEFAULT_PUSH_PREFS, revision: 0, coachSupported: true, devices: 0 };
    await rerender();
    expect(button('Turn on notifications')).toBeTruthy();
    expect(toggle('Food-log reminders')).toBeNull();
    await act(async () => release());
    await flush();
    expect(localStorage.getItem('lc-push-prefs:user-b') ?? '').not.toContain('food_unlogged');
    expect(localStorage.getItem('lc-push-device:user-b')).toBeNull();
  });

  it('a legacy (pre-namespacing) device key is adopted once by the signed-in account and removed', async () => {
    device({ ua: ANDROID, perm: 'granted' });
    localStorage.setItem('lc-push-device', JSON.stringify({ endpoint: 'https://push.example/1' }));
    await render();
    expect(text()).toMatch(/Notifications are on for this device/);
    expect(localStorage.getItem('lc-push-device')).toBeNull();
    expect(localStorage.getItem(DEVICE)).toContain('push.example/1');
  });

  it('Icelandic: the coach notification settings use the approved strings', async () => {
    setLanguage('is');
    device({ ua: ANDROID, perm: 'granted' });
    localStorage.setItem(DEVICE, JSON.stringify({ endpoint: 'https://push.example/1' }));
    await render();
    expect(text()).toMatch(/Áminningar frá þjálfara/);
    expect(text()).toMatch(/Áminningarnar sem þú valdir eru virkar\./);
    expect([...select('Daglegt hámark áminninga')!.options].map((o) => o.textContent)).toEqual(['1 áminning á dag', '2 áminningar á dag', '3 áminningar á dag']);
    expect(button('Hvíla mig í 1 dag')).toBeTruthy();
    expect(text()).toMatch(/Hljóðlaus tími: 22:00–07:00\./);
    expect(text()).toMatch(/Aðrar tilkynningar/);
  });

  it('signed out: explains that an account is needed', async () => {
    h.auth = { status: 'guest' };
    device({ ua: ANDROID });
    await render();
    expect(text()).toMatch(/Sign in to get reminders/);
    expect(button('Turn on notifications')).toBeNull();
  });
});
