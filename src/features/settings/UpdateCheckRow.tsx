/**
 * Settings → App → "Check for updates". Looks for a new version right away instead of waiting for the hourly /
 * on-reopen check (src/pwa/update.ts → checkForUpdates). The update banner stays as it is. When an update is found
 * it shows again, and the "Update" button here does the same as the banner's, never during a workout.
 */
import { useState, useSyncExternalStore } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { RefreshCw } from 'lucide-react';
import { Button, ListRow } from '@/components/ui';
import { useApp } from '@/state/app';
import { useT } from '@/i18n';
import { applyUpdate, checkForUpdates, pwaState, subscribePwa, type UpdateCheckResult } from '@/pwa/update';

let snapshot = pwaState();
const subscribe = (cb: () => void) => {
  // Re-read on (re)mount: Settings opens long after load, and the state may have changed while it was closed.
  snapshot = pwaState();
  return subscribePwa(() => {
    snapshot = pwaState();
    cb();
  });
};

type Status = 'idle' | 'checking' | UpdateCheckResult;

export function UpdateCheckRow() {
  const { db } = useApp();
  const { t } = useT();
  const pwa = useSyncExternalStore(subscribe, () => snapshot);
  const [status, setStatus] = useState<Status>('idle');
  const activeCount = useLiveQuery(() => db.sessions.where('status').equals('active').filter((s) => !s.deletedAt).count(), [db]);
  const busy = (activeCount ?? 0) > 0;
  const available = pwa.needRefresh || status === 'available';
  const version = `v${__APP_VERSION__}`;

  const check = async () => {
    setStatus('checking');
    setStatus(await checkForUpdates());
  };

  const subtitle = available
    ? busy
      ? t('settings.updateReadyAfter')
      : t('settings.updateReady')
    : {
        idle: t('settings.versionCurrent', { version }),
        checking: t('settings.checking'),
        latest: t('settings.upToDate', { version }),
        offline: t('settings.checkOffline'),
        unsupported: t('settings.checkUnsupported'),
        error: t('settings.checkFailed'),
        available: '',
      }[status];

  return (
    <ListRow
      left={<RefreshCw className={`size-5 text-muted${status === 'checking' ? ' animate-spin' : ''}`} aria-hidden />}
      title={t('settings.checkUpdates')}
      subtitle={<span role="status">{subtitle}</span>}
      right={
        available ? (
          !busy && (
            <Button size="sm" variant="primary" onClick={() => applyUpdate()}>
              {t('sync.update')}
            </Button>
          )
        ) : (
          <Button size="sm" variant="secondary" disabled={status === 'checking'} onClick={() => void check()}>
            {status === 'checking' ? t('settings.checking') : t('settings.check')}
          </Button>
        )
      }
    />
  );
}
