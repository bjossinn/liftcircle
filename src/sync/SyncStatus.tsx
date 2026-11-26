import { useEffect } from 'react';
import { Link } from 'react-router';
import { AlertTriangle, CloudOff, GitMerge } from 'lucide-react';
import { useApp } from '@/state/app';
import { configureSync, useSyncStatus } from './engine';
import { clearSignedUrlCache } from '@/backend/social';
import { setPendingPostsAccount } from '@/social/pendingPosts';
import { useT } from '@/i18n';

/** Wires the sync engine to the current account / auth / connectivity. Mounted once in the shell. */
export function SyncRunner() {
  const { db, auth, online } = useApp();
  const validUser = auth.status === 'signed_in' ? auth.userId ?? null : null;
  useEffect(() => {
    configureSync({ db, userId: validUser, online });
  }, [db, validUser, online]);
  // Account switch: drop per-account in-memory caches (signed media URLs).
  useEffect(() => {
    clearSignedUrlCache();
    setPendingPostsAccount(validUser);
  }, [db, validUser]);
  return null;
}

export function SyncStatusBanner() {
  const { auth, db } = useApp();
  const s = useSyncStatus();
  const { t, tp } = useT();
  if (db.isGuest) return null;
  if (auth.status === 'expired' || (s.phase === 'paused_auth' && auth.status !== 'loading')) {
    return (
      <Link to="/auth?reauth=1" className="flex items-center gap-2 bg-warn-soft border-b border-warn/30 px-4 py-2 text-sm">
        <CloudOff className="size-4 text-warn shrink-0" aria-hidden />
        <span className="flex-1">
          {s.pending > 0 ? t('sync.pausedPending', { count: s.pending }) : t('sync.paused')}
        </span>
      </Link>
    );
  }
  if (s.conflicts > 0) {
    return (
      <Link to="/settings/data#sync" className="flex items-center gap-2 bg-warn-soft border-b border-warn/30 px-4 py-2 text-sm">
        <GitMerge className="size-4 text-warn shrink-0" aria-hidden />
        <span className="flex-1">
          {tp('sync.conflicts', s.conflicts)}
        </span>
      </Link>
    );
  }
  if (s.failing > 0) {
    return (
      <Link to="/settings/data#sync" className="flex items-center gap-2 bg-danger-soft border-b border-danger/30 px-4 py-2 text-sm">
        <AlertTriangle className="size-4 text-danger shrink-0" aria-hidden />
        <span className="flex-1">{t('sync.retryBackup')}</span>
      </Link>
    );
  }
  return null;
}
