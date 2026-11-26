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
import { useT } from '@/i18n';

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

/** The first sentence in bold, the rest plain (the approved copy is one string per notice). */
function Lead({ text }: { text: string }) {
  const i = text.indexOf('. ');
  if (i < 0) return <strong className="font-semibold">{text}</strong>;
  return (
    <>
      <strong className="font-semibold">{text.slice(0, i + 1)}</strong> {text.slice(i + 2)}
    </>
  );
}

const bar = 'flex items-start gap-2 border-b px-4 py-2 text-sm';
const closeBtn = 'shrink-0 -my-2 -mr-2 inline-flex items-center justify-center size-11 rounded-xl text-muted hover:text-ink';

export function HealthBanner() {
  const h = useHealth();
  const { db } = useApp();
  const { t } = useT();
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
          <Lead text={t('sync.storageBlocked')} />
        </span>
      </div>
    );
  }
  if (h.storage === 'quota') {
    return (
      <div role="alert" className={`${bar} bg-danger-soft border-danger/30`}>
        <HardDrive className="size-4 text-danger shrink-0 mt-0.5" aria-hidden />
        <span className="flex-1">
          <Lead text={t('sync.storageFull')} />
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
            ? t('sync.offlineSetupFailed')
            : t('sync.offlineUnavailable')}
        </span>
        <button
          type="button"
          className={closeBtn}
          aria-label={t('common.dismiss')}
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
          {t('sync.localOnly')}{' '}
          <Link to="/settings/data" className="text-accent font-medium underline underline-offset-2">
            {t('sync.protectData')}
          </Link>
        </span>
        <button
          type="button"
          className={closeBtn}
          aria-label={t('common.dismiss')}
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
