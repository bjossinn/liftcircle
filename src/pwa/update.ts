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
        // Check for updates hourly while the app is open.
        setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
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
