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
      ? 'Update ready. Install it after your workout.'
      : 'Update ready to install'
    : {
        idle: `You have ${version}`,
        checking: 'Checking…',
        latest: `You’re up to date (${version})`,
        offline: 'You’re offline. Try again later.',
        unsupported: 'Not available here. Reload to update.',
        error: 'Couldn’t check. Try again.',
        available: '',
      }[status];

  return (
    <ListRow
      left={<RefreshCw className={`size-5 text-muted${status === 'checking' ? ' animate-spin' : ''}`} aria-hidden />}
      title="Check for updates"
      subtitle={<span role="status">{subtitle}</span>}
      right={
        available ? (
          !busy && (
            <Button size="sm" variant="primary" onClick={() => applyUpdate()}>
              Update
            </Button>
          )
        ) : (
          <Button size="sm" variant="secondary" disabled={status === 'checking'} onClick={() => void check()}>
            {status === 'checking' ? 'Checking…' : 'Check'}
          </Button>
        )
      }
    />
  );
}
