/**
 * Web Push on this device: support checks, subscribing (permission is only requested from a user tap — required on
 * iOS), unsubscribing, and keeping the server's copy of the subscription current.
 *
 * The VAPID public key is a public value (VITE_VAPID_PUBLIC_KEY, set in netlify.toml). Without it the whole feature
 * is hidden. iOS/iPadOS only allows web push for apps installed to the Home Screen (standalone).
 */
import { pushApi } from '@/backend/push';
import { DEFAULT_PUSH_PREFS, type PushPrefs } from '@/domain/pushSchedule';
import { isStandalone } from './install';

/**
 * Local state is namespaced by the authenticated user id (`lc-push-device:<uid>`, `lc-push-prefs:<uid>`), so another
 * account signing in on this device never inherits an opt-in, cached preferences or the "on for this device" state.
 * Keys from before namespacing are adopted once by the first account that signs in after the update (on a shared
 * device that is the account that was using it) and then removed.
 */
const LEGACY_DEVICE_KEY = 'lc-push-device';
const LEGACY_PREFS_KEY = 'lc-push-prefs';
export const deviceKey = (uid: string) => `${LEGACY_DEVICE_KEY}:${uid}`;
export const prefsKey = (uid: string) => `${LEGACY_PREFS_KEY}:${uid}`;
/** The signed-in user id, or null for guests / signed out. */
export type PushAccount = string | null | undefined;

export function vapidPublicKey(): string {
  const k = (import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined) ?? '';
  return k.trim();
}

export function isIOSDevice(nav: Navigator = navigator): boolean {
  const ua = nav.userAgent || '';
  return /iPhone|iPad|iPod/.test(ua) || (ua.includes('Mac') && typeof document !== 'undefined' && 'ontouchend' in document);
}

export type PushSupport = 'no_key' | 'unsupported' | 'ios_needs_install' | 'denied' | 'available';

export function pushSupport(): PushSupport {
  if (!vapidPublicKey()) return 'no_key';
  if (typeof window === 'undefined') return 'unsupported';
  const hasApis = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (isIOSDevice() && !isStandalone()) return 'ios_needs_install';
  if (!hasApis) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return 'available';
}

/* ------------------------------------------------------------------ local state (per device) */
function read<T>(key: string): T | null {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}
function write(key: string, v: unknown) {
  try {
    if (v == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage blocked: the server copy still works; we just re-check next start */
  }
}
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
export function onPushChange(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export interface PushDevice {
  endpoint: string;
}
function adoptLegacy(uid: string) {
  try {
    const legacy = localStorage.getItem(LEGACY_DEVICE_KEY);
    if (legacy != null) {
      if (localStorage.getItem(deviceKey(uid)) == null) localStorage.setItem(deviceKey(uid), legacy);
      localStorage.removeItem(LEGACY_DEVICE_KEY);
    }
    localStorage.removeItem(LEGACY_PREFS_KEY); // re-read from the server
  } catch {
    /* storage blocked */
  }
}
export function getPushDevice(uid: PushAccount): PushDevice | null {
  if (!uid) return null;
  adoptLegacy(uid);
  return read<PushDevice>(deviceKey(uid));
}
export const pushEnabledHere = (uid: PushAccount) => !!getPushDevice(uid)?.endpoint;
export const cachedPushPrefs = (uid: PushAccount): PushPrefs => ({ ...DEFAULT_PUSH_PREFS, ...((uid ? read<PushPrefs>(prefsKey(uid)) : null) ?? {}) });
export function cachePushPrefs(uid: PushAccount, p: PushPrefs) {
  if (!uid) return;
  const { kinds, fixedReminderTime, timeZone, quietStart, quietEnd, dailyCap, snoozeUntil, revision } = p;
  write(prefsKey(uid), { kinds, fixedReminderTime, timeZone, quietStart, quietEnd, dailyCap, snoozeUntil, revision });
  emit();
}

/* ------------------------------------------------------------------ subscribe / unsubscribe */
function keyBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function subscriptionBody(sub: PushSubscription | PushSubscriptionJSON) {
  const json = 'toJSON' in sub && typeof sub.toJSON === 'function' ? sub.toJSON() : (sub as PushSubscriptionJSON);
  return { endpoint: json.endpoint ?? '', p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '', userAgent: navigator.userAgent.slice(0, 300) };
}
async function registration(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.ready;
}

export type EnableResult = { ok: true } | { ok: false; reason: 'denied' | 'dismissed' | 'unsupported' | 'failed'; message?: string };

/** Call only from a user tap: asks for permission, subscribes and stores the subscription on the server. */
export async function enablePush(uid: PushAccount, timeZone: string): Promise<EnableResult> {
  if (!uid) return { ok: false, reason: 'unsupported' };
  const support = pushSupport();
  if (support !== 'available') return { ok: false, reason: support === 'denied' ? 'denied' : 'unsupported' };
  const perm = await Notification.requestPermission();
  if (perm === 'denied') return { ok: false, reason: 'denied' };
  if (perm !== 'granted') return { ok: false, reason: 'dismissed' };
  try {
    const reg = await registration();
    const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(vapidPublicKey()) as BufferSource }));
    const body = subscriptionBody(sub);
    await pushApi.saveSubscription(body);
    const prefs = await pushApi.setPrefs({ timeZone });
    write(deviceKey(uid), { endpoint: body.endpoint });
    cachePushPrefs(uid, prefs);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'failed', message: (e as Error)?.message };
  }
}

/** Unsubscribes this device and deletes its server row. */
export async function disablePush(uid: PushAccount): Promise<void> {
  if (!uid) return;
  const device = getPushDevice(uid);
  let endpoint = device?.endpoint;
  try {
    const sub = await (await registration()).pushManager.getSubscription();
    if (sub) {
      endpoint = sub.endpoint;
      await sub.unsubscribe();
    }
  } catch {
    /* no service worker: the server row is still removed below */
  }
  if (endpoint) await pushApi.deleteSubscription(endpoint);
  write(deviceKey(uid), null);
  emit();
}

/**
 * On app start (signed in, online): if push is on here, make sure the browser still has the subscription and the
 * server has the current one (endpoints can change, e.g. after pushsubscriptionchange). Also refreshes cached prefs.
 */
export async function refreshPushSubscription(uid: PushAccount, isCurrent: () => boolean = () => true): Promise<void> {
  const device = getPushDevice(uid);
  if (!uid || !device || pushSupport() !== 'available' || Notification.permission !== 'granted') return;
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(vapidPublicKey()) as BufferSource });
  if (sub.endpoint !== device.endpoint) {
    await pushApi.saveSubscription(subscriptionBody(sub));
    await pushApi.deleteSubscription(device.endpoint).catch(() => undefined);
    if (!isCurrent()) return;
    write(deviceKey(uid), { endpoint: sub.endpoint });
  }
  const prefs = await pushApi.getPrefs();
  if (isCurrent()) cachePushPrefs(uid, prefs); // the account changed meanwhile: don't cache under the old user
}

/** The service worker re-subscribed (pushsubscriptionchange): upload the new subscription. */
export function listenForSubscriptionChanges(uid: PushAccount): () => void {
  if (!uid || typeof navigator === 'undefined' || !navigator.serviceWorker) return () => undefined;
  const onMessage = (e: MessageEvent) => {
    const d = e.data as { type?: string; subscription?: PushSubscriptionJSON } | null;
    if (d?.type !== 'lc-push-subscription-changed' || !d.subscription?.endpoint || !pushEnabledHere(uid)) return;
    const old = getPushDevice(uid)?.endpoint;
    void pushApi
      .saveSubscription(subscriptionBody(d.subscription))
      .then(() => {
        write(deviceKey(uid), { endpoint: d.subscription!.endpoint });
        if (old && old !== d.subscription!.endpoint) return pushApi.deleteSubscription(old).then(() => undefined);
      })
      .catch(() => undefined);
  };
  navigator.serviceWorker.addEventListener('message', onMessage);
  return () => navigator.serviceWorker.removeEventListener('message', onMessage);
}
