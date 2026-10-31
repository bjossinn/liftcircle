import { useEffect, useState, useSyncExternalStore } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { RefreshCw } from 'lucide-react';
import { applyUpdate, pwaState, reloadPage, subscribePwa } from './update';
import { useApp } from '@/state/app';
import { Button } from '@/components/ui';
import { useToast } from '@/components/toast';

let snapshot = pwaState();
const subscribe = (cb: () => void) =>
  subscribePwa(() => {
    snapshot = pwaState();
    cb();
  });

export function UpdateBanner() {
  const state = useSyncExternalStore(subscribe, () => snapshot);
  const { db } = useApp();
  const toast = useToast();
  // Same definition of "active workout" as the Resume bar (deleted sessions don't block updates).
  const activeCount = useLiveQuery(() => db.sessions.where('status').equals('active').filter((s) => !s.deletedAt).count(), [db]);
  const busy = (activeCount ?? 0) > 0;
  const [dismissed, setDismissed] = useState(false);
  // "Check for updates" in Settings found one: show the banner again even if "Later" was tapped.
  useEffect(() => {
    if (state.checkSeq) setDismissed(false);
  }, [state.checkSeq]);
  useEffect(() => {
    if (state.offlineReady) toast.show('Ready to work offline', { tone: 'success' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.offlineReady]);
  // A new version took control (e.g. updated from another tab): reload once no workout is open here.
  // `activeCount === undefined` means the local database hasn't answered yet — wait for it.
  useEffect(() => {
    if (state.reloadPending && activeCount === 0) reloadPage();
  }, [state.reloadPending, activeCount]);
  if (state.reloadPending) {
    if (!busy) return null;
    return (
      <div role="status" className="flex items-center gap-3 bg-accent-soft border-b border-accent/30 px-4 py-2 text-sm">
        <RefreshCw className="size-4 text-accent shrink-0" aria-hidden />
        <span className="flex-1">Hard Earned was updated. It will reload when you finish this workout.</span>
      </div>
    );
  }
  if (!state.needRefresh || dismissed) return null;
  return (
    <div role="status" className="flex items-center gap-3 bg-accent-soft border-b border-accent/30 px-4 py-2 text-sm">
      <RefreshCw className="size-4 text-accent shrink-0" aria-hidden />
      <span className="flex-1">Update available.{busy && ' You can install it after you finish your workout.'}</span>
      {!busy ? (
        <Button size="sm" variant="primary" onClick={() => applyUpdate()}>
          Update
        </Button>
      ) : null}
      <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>
        Later
      </Button>
    </div>
  );
}
