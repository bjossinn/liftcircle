/**
 * Service-worker registration with a user-controlled update flow.
 * The new SW waits until the user taps "Update", and we never reload during an active workout:
 * if another tab activates the update while a workout is open here, the reload is deferred
 * (`reloadPending`) and <UpdateBanner /> performs it once no workout is active.
 * Registration/precache failures are reported to ./health so the UI can say offline mode isn't ready.
 */
import { reportSwError, reportSwReady, reportSwUnsupported } from './health';

type Listener = () => void;
let needRefresh = false;
let offlineReady = false;
let reloadPending = false;
let apply: ((reload?: boolean) => Promise<void>) | null = null;
const listeners = new Set<Listener>();
const emit = () => listeners.forEach((l) => l());

export function subscribePwa(fn: Listener) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
export const pwaState = () => ({ needRefresh, offlineReady, reloadPending });

/** Watch an installing worker: if it becomes redundant before anything controls the page, precaching failed. */
export function watchInstall(reg: ServiceWorkerRegistration) {
  const track = (w: ServiceWorker | null) => {
    if (!w) return;
    w.addEventListener('statechange', () => {
      if (w.state === 'activated') reportSwReady();
      if (w.state === 'redundant' && !reg.active && !reg.waiting && !reg.installing) {
        reportSwError(new Error('The offline copy of the app could not be saved (service worker install failed).'));
      }
    });
  };
  track(reg.installing);
  reg.addEventListener('updatefound', () => track(reg.installing));
  if (reg.active) reportSwReady();
}

const HOURLY_MS = 60 * 60 * 1000;
export const VISIBLE_CHECK_MIN_MS = 5 * 60 * 1000;

/**
 * Check for a new SW hourly while the app is open, and when the page becomes visible again
 * (e.g. reopened from the iOS app switcher), at most once every 5 minutes. A check only installs the
 * new SW; it still waits for "Update", so this never reloads during a workout.
 */
export function watchForUpdates(reg: ServiceWorkerRegistration, now = () => Date.now()) {
  // Registration itself just checked for updates.
  let lastCheck = now();
  const check = () => {
    lastCheck = now();
    reg.update().catch(() => {});
  };
  const interval = setInterval(check, HOURLY_MS);
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible' && now() - lastCheck >= VISIBLE_CHECK_MIN_MS) check();
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  return () => {
    clearInterval(interval);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };
}

export async function initPwa() {
  if (import.meta.env.DEV) return;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || !navigator.serviceWorker) {
    reportSwUnsupported();
    return;
  }
  try {
    const { registerSW } = await import('virtual:pwa-register');
    apply = registerSW({
      immediate: true,
      onNeedRefresh() {
        needRefresh = true;
        emit();
      },
      onOfflineReady() {
        offlineReady = true;
        reportSwReady();
        emit();
      },
      // Called when a new SW took control (after "Update" here or in another tab). Old lazy chunks are
      // gone from the cache now, so we must reload — but never in the middle of a workout.
      onNeedReload() {
        reloadPending = true;
        emit();
      },
      onRegisteredSW(_url, reg) {
        if (!reg) return;
        watchInstall(reg);
        watchForUpdates(reg);
      },
      onRegisterError(e) {
        reportSwError(e);
      },
    });
  } catch (e) {
    // The registration module itself failed to load; the app still works online.
    reportSwError(e);
  }
}

/** Separate so tests can observe it (window.location can't be stubbed in jsdom). */
export function reloadPage() {
  location.reload();
}

export async function applyUpdate() {
  if (apply) await apply(true);
  else reloadPage();
}
