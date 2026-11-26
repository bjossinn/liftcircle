/**
 * Web Push on this device: support checks, subscribing (permission is only requested from a user tap — required on
 * iOS), unsubscribing, and keeping the server's copy of the subscription current.
 *
 * The VAPID public key is a public value (VITE_VAPID_PUBLIC_KEY, set in netlify.toml). Without it the whole feature
 * is hidden. iOS/iPadOS only allows web push for apps installed to the Home Screen (standalone).
 */
import { isAccountChanged, pushApi } from '@/backend/push';
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

export type EnableResult = { ok: true } | { ok: false; reason: 'denied' | 'dismissed' | 'unsupported' | 'failed' | 'cancelled'; message?: string };
/** Is the operation still wanted (the caller's own cancellation, e.g. the screen moved on to another account)? */
export type StillCurrent = () => boolean;
const always: StillCurrent = () => true;

/**
 * Every awaited step (permission prompt, service worker, network) can outlast an account switch. Before each write the
 * operation re-checks that it is still current AND that the backend session still belongs to `uid`; the server also
 * refuses a write for another account (expectedUserId). Nothing is cached under an account that didn't do the write.
 */
async function stillFor(uid: string, isCurrent: StillCurrent): Promise<boolean> {
  if (!isCurrent()) return false;
  const who = await pushApi.currentUserId();
  return who === uid && isCurrent();
}

/** Call only from a user tap: asks for permission, subscribes and stores the subscription on the server. */
export async function enablePush(uid: PushAccount, timeZone: string, isCurrent: StillCurrent = always): Promise<EnableResult> {
  if (!uid) return { ok: false, reason: 'unsupported' };
  const support = pushSupport();
  if (support !== 'available') return { ok: false, reason: support === 'denied' ? 'denied' : 'unsupported' };
  const perm = await Notification.requestPermission();
  if (!isCurrent()) return { ok: false, reason: 'cancelled' };
  if (perm === 'denied') return { ok: false, reason: 'denied' };
  if (perm !== 'granted') return { ok: false, reason: 'dismissed' };
  try {
    const reg = await registration();
    const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(vapidPublicKey()) as BufferSource }));
    const body = subscriptionBody(sub);
    if (!(await stillFor(uid, isCurrent))) return { ok: false, reason: 'cancelled' };
    await pushApi.saveSubscription(body, uid);
    if (!(await stillFor(uid, isCurrent))) return { ok: false, reason: 'cancelled' };
    write(deviceKey(uid), { endpoint: body.endpoint });
    const prefs = await pushApi.setPrefs({ timeZone }, uid);
    if (isCurrent()) cachePushPrefs(uid, prefs);
    else emit();
    return { ok: true };
  } catch (e) {
    if (isAccountChanged(e)) return { ok: false, reason: 'cancelled' };
    return { ok: false, reason: 'failed', message: (e as Error)?.message };
  }
}

/** Unsubscribes this device and deletes its server row (only for `uid`, the account that asked). */
export async function disablePush(uid: PushAccount, isCurrent: StillCurrent = always): Promise<boolean> {
  if (!uid) return false;
  if (!(await stillFor(uid, isCurrent))) return false;
  const device = getPushDevice(uid);
  let endpoint = device?.endpoint;
  try {
    const sub = await (await registration()).pushManager.getSubscription();
    if (sub) {
      endpoint = sub.endpoint;
      if (!(await stillFor(uid, isCurrent))) return false;
      await sub.unsubscribe();
    }
  } catch {
    /* no service worker: the server row is still removed below */
  }
  if (endpoint) {
    try {
      await pushApi.deleteSubscription(endpoint, uid);
    } catch (e) {
      if (!isAccountChanged(e)) throw e;
      return false;
    }
  }
  write(deviceKey(uid), null);
  emit();
  return true;
}

/**
 * On app start and on every account change (signed in, online): if push is on here for `uid`, make sure the browser
 * still has a subscription and that the server's row for this endpoint belongs to `uid` — another account may have
 * taken the same browser endpoint meanwhile (A enables, B enables, A returns), so ownership is checked, not assumed
 * from the cached endpoint. Also refreshes cached prefs.
 */
export async function refreshPushSubscription(uid: PushAccount, isCurrent: StillCurrent = always): Promise<void> {
  const device = getPushDevice(uid);
  if (!uid || !device || pushSupport() !== 'available' || Notification.permission !== 'granted') return;
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    if (!(await stillFor(uid, isCurrent))) return;
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(vapidPublicKey()) as BufferSource });
  }
  if (!(await stillFor(uid, isCurrent))) return;
  const changed = sub.endpoint !== device.endpoint;
  const owner = changed ? 'other' : await pushApi.deviceOwner(sub.endpoint).catch(() => 'unknown' as const);
  if (changed || owner === 'other' || owner === 'none') {
    if (!(await stillFor(uid, isCurrent))) return;
    try {
      await pushApi.saveSubscription(subscriptionBody(sub), uid);
    } catch (e) {
      if (isAccountChanged(e)) return;
      throw e;
    }
    if (changed) await pushApi.deleteSubscription(device.endpoint, uid).catch(() => undefined);
    if (!isCurrent()) return;
    write(deviceKey(uid), { endpoint: sub.endpoint });
  }
  const prefs = await pushApi.getPrefs();
  if (await stillFor(uid, isCurrent)) cachePushPrefs(uid, prefs); // never cache another account's settings under uid
}

/** The service worker re-subscribed (pushsubscriptionchange): upload the new subscription for `uid` only. */
export function listenForSubscriptionChanges(uid: PushAccount, isCurrent: StillCurrent = always): () => void {
  if (!uid || typeof navigator === 'undefined' || !navigator.serviceWorker) return () => undefined;
  let live = true;
  const current = () => live && isCurrent();
  const onMessage = (e: MessageEvent) => {
    const d = e.data as { type?: string; subscription?: PushSubscriptionJSON } | null;
    if (d?.type !== 'lc-push-subscription-changed' || !d.subscription?.endpoint || !pushEnabledHere(uid)) return;
    const old = getPushDevice(uid)?.endpoint;
    void (async () => {
      if (!(await stillFor(uid, current))) return;
      await pushApi.saveSubscription(subscriptionBody(d.subscription!), uid);
      if (!current()) return;
      write(deviceKey(uid), { endpoint: d.subscription!.endpoint });
      if (old && old !== d.subscription!.endpoint) await pushApi.deleteSubscription(old, uid);
    })().catch(() => undefined);
  };
  navigator.serviceWorker.addEventListener('message', onMessage);
  return () => {
    live = false;
    navigator.serviceWorker.removeEventListener('message', onMessage);
  };
}
