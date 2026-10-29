/**
 * Message history of one coaching conversation: initial load, ~5 s polling while the page is visible
 * (plus immediately on focus / online / visibility), merge of messages the outbox has just sent, and a
 * small account-scoped cache so the history stays readable offline.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CoachMessage } from '@/backend/coachingContract';
import { coachingApi } from '@/backend/coaching';
import type { LiftDb } from '@/db/db';
import { onCoachMessageSent } from '@/coaching/outbox';
import { coachingError } from '@/coaching/errors';

export const POLL_MS = 5_000;
const PAGE = 200;
const cacheKey = (id: string) => `coach-msgs:${id}`;

export function sortMessages(list: CoachMessage[]): CoachMessage[] {
  return [...list].sort((a, b) => {
    if (a.seq != null && b.seq != null) return a.seq - b.seq;
    if (a.seq != null) return -1;
    if (b.seq != null) return 1;
    return Date.parse(a.createdAt) - Date.parse(b.createdAt);
  });
}

export function mergeMessages(cur: CoachMessage[], incoming: CoachMessage[]): CoachMessage[] {
  const map = new Map(cur.map((m) => [m.id, m]));
  for (const m of incoming) map.set(m.id, { ...map.get(m.id), ...m });
  return sortMessages([...map.values()]);
}

/** Where incremental polling resumes: before any message still awaiting media (its status may flip). */
export function pollCursor(list: CoachMessage[]): number | undefined {
  const seqs = list.filter((m) => m.seq != null).map((m) => m.seq!);
  if (!seqs.length) return undefined;
  const pending = list.filter((m) => m.status === 'awaiting_media' && m.seq != null).map((m) => m.seq!);
  return pending.length ? Math.min(...pending) - 1 : Math.max(...seqs);
}

export function useConversation(relationshipId: string, db: LiftDb, enabled: boolean) {
  const [messages, setMessages] = useState<CoachMessage[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [cacheChecked, setCacheChecked] = useState(false);
  const ref = useRef<CoachMessage[]>([]);
  const busy = useRef(false);
  const fromCacheRef = useRef(false);
  fromCacheRef.current = fromCache;

  const commit = useCallback(
    (list: CoachMessage[]) => {
      ref.current = list;
      setMessages(list);
      db.kv.put({ key: cacheKey(relationshipId), value: list.slice(-PAGE) }).catch(() => {});
    },
    [db, relationshipId],
  );

  // Cached history first (offline / instant open).
  useEffect(() => {
    let cancelled = false;
    ref.current = [];
    setMessages(undefined);
    setFromCache(false);
    setCacheChecked(false);
    db.kv
      .get(cacheKey(relationshipId))
      .then((row) => {
        if (cancelled || ref.current.length || !Array.isArray(row?.value)) return;
        ref.current = row!.value as CoachMessage[];
        setMessages(ref.current);
        setFromCache(true);
      })
      .catch(() => {})
      .finally(() => !cancelled && setCacheChecked(true));
    return () => {
      cancelled = true;
    };
  }, [db, relationshipId]);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const list = await coachingApi.listMessages(relationshipId, undefined, PAGE);
      commit(mergeMessages([], list));
      setFromCache(false);
      setError(null);
    } catch (e) {
      setError(coachingError(e, 'Couldn’t load messages.'));
      if (!ref.current.length) setMessages((m) => m ?? []);
    } finally {
      busy.current = false;
    }
  }, [relationshipId, commit]);

  const poll = useCallback(async () => {
    if (busy.current) return;
    if (!ref.current.length || fromCacheRef.current) return refresh();
    busy.current = true;
    try {
      const list = await coachingApi.listMessages(relationshipId, pollCursor(ref.current), 100);
      if (list.length) commit(mergeMessages(ref.current, list));
      setError(null);
    } catch {
      /* transient: next poll retries; the last good history stays on screen */
    } finally {
      busy.current = false;
    }
  }, [relationshipId, commit, refresh]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const visible = () => document.visibilityState === 'visible';
    const timer = setInterval(() => visible() && navigator.onLine !== false && void poll(), POLL_MS);
    const kick = () => visible() && void poll();
    window.addEventListener('focus', kick);
    window.addEventListener('online', kick);
    document.addEventListener('visibilitychange', kick);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', kick);
      window.removeEventListener('online', kick);
      document.removeEventListener('visibilitychange', kick);
    };
  }, [enabled, refresh, poll]);

  // Messages the outbox just persisted appear immediately (then polling confirms order).
  useEffect(
    () =>
      onCoachMessageSent((m, relId) => {
        if (relId === relationshipId) commit(mergeMessages(ref.current, [m]));
      }),
    [relationshipId, commit],
  );

  // Not fetching (offline / signed out) and nothing cached → an empty, settled history.
  return { messages: messages ?? (cacheChecked && !enabled ? [] : undefined), error, fromCache, refresh, poll };
}
