/**
 * Visible, non-blocking warnings when offline support or on-device storage isn't working:
 * blocked/missing IndexedDB (e.g. some private modes), a full disk, a failed service-worker
 * registration, or storage the browser may evict. Mounted once in the shell.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router';
import { AlertTriangle, CloudOff, HardDrive, X } from 'lucide-react';
import { useApp } from '@/state/app';
import { getHealth, probeStorage, reportPersisted, subscribeHealth, watchUnhandledStorageErrors } from './health';
import { isStandalone } from './install';

const SW_DISMISS = 'lc-sw-notice-dismissed';
const PERSIST_DISMISS = 'lc-persist-notice-dismissed';
const read = (s: Storage | undefined, k: string) => {
  try {
    return s?.getItem(k) === '1';
  } catch {
    return false;
  }
};
const write = (s: Storage | undefined, k: string) => {
  try {
    s?.setItem(k, '1');
  } catch {
    /* storage blocked: the notice just comes back next time */
  }
};
const session = () => (typeof sessionStorage === 'undefined' ? undefined : sessionStorage);
const local = () => (typeof localStorage === 'undefined' ? undefined : localStorage);

export function useHealth() {
  return useSyncExternalStore(subscribeHealth, getHealth, getHealth);
}

/** Probes the current account database once per account and watches for storage errors. */
export function StorageHealthRunner() {
  const { db } = useApp();
  useEffect(() => {
    watchUnhandledStorageErrors();
    let cancelled = false;
    void probeStorage(() => db.open());
    // The persistent-storage request (AppProvider) may still be pending at first probe: look again later.
    const t = setTimeout(() => {
      if (cancelled) return;
      navigator.storage?.persisted?.().then(reportPersisted, () => {});
    }, 3000);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [db]);
  return null;
}

const bar = 'flex items-start gap-2 border-b px-4 py-2 text-sm';
const closeBtn = 'shrink-0 -my-2 -mr-2 inline-flex items-center justify-center size-11 rounded-xl text-muted hover:text-ink';

export function HealthBanner() {
  const h = useHealth();
  const { db } = useApp();
  const [swDismissed, setSwDismissed] = useState(() => read(session(), SW_DISMISS));
  const [persistDismissed, setPersistDismissed] = useState(() => read(local(), PERSIST_DISMISS));
  // Only worth mentioning once there is something to lose (a finished workout on a guest device).
  const askPersist = h.persisted === false && h.storage === 'ok' && db.isGuest && !db.isDemo && !persistDismissed;
  const hasWorkouts = useLiveQuery(
    () => (askPersist ? db.sessions.where('status').equals('completed').count().catch(() => 0) : Promise.resolve(0)),
    [db, askPersist],
  );

  if (h.storage === 'unavailable') {
    return (
      <div role="alert" className={`${bar} bg-danger-soft border-danger/30`}>
        <AlertTriangle className="size-4 text-danger shrink-0 mt-0.5" aria-hidden />
        <span className="flex-1">
          <strong className="font-semibold">This browser isn’t letting LiftCircle save on this device.</strong> Private browsing or blocked site data can
          cause this, and workouts can’t be kept. Allow site data for LiftCircle or open it in a normal window, then reload.
        </span>
      </div>
    );
  }
  if (h.storage === 'quota') {
    return (
      <div role="alert" className={`${bar} bg-danger-soft border-danger/30`}>
        <HardDrive className="size-4 text-danger shrink-0 mt-0.5" aria-hidden />
        <span className="flex-1">
          <strong className="font-semibold">Your device storage is full.</strong> New changes may not be saved. Free up some space, then reload LiftCircle.
        </span>
      </div>
    );
  }
  if ((h.sw === 'error' || h.sw === 'unsupported') && !swDismissed) {
    return (
      <div role="status" className={`${bar} bg-surface-2 border-line`}>
        <CloudOff className="size-4 text-muted shrink-0 mt-0.5" aria-hidden />
        <span className="flex-1">
          {h.sw === 'error'
            ? 'Offline mode couldn’t be set up this time. LiftCircle works while you’re online; reload to try again.'
            : 'Offline mode isn’t available in this browser window. LiftCircle works while you’re online.'}
        </span>
        <button
          type="button"
          className={closeBtn}
          aria-label="Dismiss"
          onClick={() => {
            write(session(), SW_DISMISS);
            setSwDismissed(true);
          }}
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
    );
  }
  // Data that exists only on this device (no account backup) and the browser may evict it.
  if (askPersist && (hasWorkouts ?? 0) > 0 && !isStandalone()) {
    return (
      <div role="status" className={`${bar} bg-surface-2 border-line`}>
        <HardDrive className="size-4 text-muted shrink-0 mt-0.5" aria-hidden />
        <span className="flex-1">
          Your workouts are only on this device, and the browser may clear them if storage runs low.{' '}
          <Link to="/settings/data" className="text-accent font-medium underline underline-offset-2">
            Back up or protect your data
          </Link>
        </span>
        <button
          type="button"
          className={closeBtn}
          aria-label="Dismiss"
          onClick={() => {
            write(local(), PERSIST_DISMISS);
            setPersistDismissed(true);
          }}
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
    );
  }
  return null;
}
