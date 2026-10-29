import { useEffect, useState } from 'react';
import { socialApi } from '@/backend/social';
import { COACHING_NOTIFICATION_TYPES, type AppNotification, type Settings } from '@/domain/types';
import { useApp } from '@/state/app';
import { usePendingPostsRunner } from '@/social/pendingPosts';

export const POLL_MS = 60_000;

const refreshers = new Set<() => void>();
/** Ask every mounted unread badge to re-fetch (e.g. after marking notifications read). */
export function notifyUnreadChanged() {
  refreshers.forEach((r) => r());
}

/** Notification types the user wants to see (settings.notifications), used for display only. */
export function enabledNotificationTypes(prefs: Settings['notifications']): AppNotification['type'][] {
  const out: AppNotification['type'][] = [];
  if (prefs.friendRequests) out.push('friend_request', 'friend_accept');
  if (prefs.likes) out.push('like');
  if (prefs.comments) out.push('comment');
  if (prefs.coaching !== false) out.push(...COACHING_NOTIFICATION_TYPES);
  return out;
}

/** True when every notification type is enabled, so the server-side unread count is exact. */
export function allNotificationTypesEnabled(prefs: Settings['notifications']): boolean {
  return prefs.friendRequests && prefs.likes && prefs.comments && prefs.coaching !== false;
}

/**
 * Unread in-app notifications. Polls every 60 s only while signed in, online and the page is
 * visible; 0 otherwise. Network results are kept in memory only.
 *
 * This hook is mounted by the header on every main tab, so it also hosts the pending-post
 * runner (process queued posts on app start, reconnect and sign-in).
 */
export function useUnreadCount(): number {
  usePendingPostsRunner();
  const { auth, online, backendConfigured, account } = useApp();
  const prefs = account.settings.notifications;
  const active = backendConfigured && auth.status === 'signed_in' && online;
  const [count, setCount] = useState(0);
  const { friendRequests, likes, comments, coaching } = prefs;

  useEffect(() => {
    if (!active) {
      setCount(0);
      return;
    }
    let stopped = false;
    const types = enabledNotificationTypes({ friendRequests, likes, comments, coaching });
    const all = allNotificationTypesEnabled({ friendRequests, likes, comments, coaching });
    const fetchCount = async () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      try {
        let n: number;
        if (types.length === 0) n = 0;
        else if (all) n = await socialApi.unreadNotificationCount();
        else n = (await socialApi.listNotifications(50)).filter((x) => !x.readAt && types.includes(x.type)).length;
        if (!stopped) setCount(n);
      } catch {
        /* keep the last known value; the badge is best-effort */
      }
    };
    void fetchCount();
    const timer = setInterval(fetchCount, POLL_MS);
    const onVisible = () => document.visibilityState === 'visible' && void fetchCount();
    document.addEventListener('visibilitychange', onVisible);
    refreshers.add(fetchCount);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      refreshers.delete(fetchCount);
    };
  }, [active, friendRequests, likes, comments, coaching]);

  return active ? count : 0;
}
