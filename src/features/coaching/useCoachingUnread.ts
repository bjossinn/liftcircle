/**
 * Unread coaching count for the tab bar: polls coachingApi.unreadCoachingCount() every 60 s while
 * signed in, online and the page is visible (and right away when any of those become true).
 * Returns 0 otherwise. Never throws; a failed poll keeps the last known value.
 *
 * Because it is mounted app-wide (tab bar), it also keeps the coach-message outbox moving, so
 * messages queued offline are sent when the connection returns even outside the chat screen.
 */
import { useEffect, useState } from 'react';
import { coachingApi } from '@/backend/coaching';
import { useApp } from '@/state/app';
import { useCoachOutboxRunner } from '@/coaching/outbox';

export const UNREAD_POLL_MS = 60_000;
/** Screens dispatch this after marking messages read so the badge refreshes immediately. */
export const COACHING_UNREAD_EVENT = 'liftcircle:coaching-unread';

export function notifyCoachingUnreadChanged() {
  try {
    window.dispatchEvent(new Event(COACHING_UNREAD_EVENT));
  } catch {
    /* ignore */
  }
}

export function useCoachingUnread(): number {
  const { auth, online, backendConfigured } = useApp();
  const enabled = backendConfigured && auth.status === 'signed_in' && online;
  const [count, setCount] = useState(0);
  useCoachOutboxRunner();

  useEffect(() => {
    if (!enabled) {
      setCount(0);
      return;
    }
    let cancelled = false;
    let inFlight = false;
    const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
    const tick = async () => {
      if (!visible() || inFlight) return;
      inFlight = true;
      try {
        const n = await coachingApi.unreadCoachingCount();
        if (!cancelled) setCount(typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
      } catch {
        /* keep last value */
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), UNREAD_POLL_MS);
    const onVisible = () => visible() && void tick();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener(COACHING_UNREAD_EVENT, onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener(COACHING_UNREAD_EVENT, onVisible);
    };
  }, [enabled, auth.userId]);

  return enabled ? count : 0;
}
