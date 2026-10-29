/**
 * Coach-message composer drafts: text + photos the person hasn't sent yet.
 *
 * - Stored in the ACCOUNT-SCOPED database (`db.kv`, key `coach-draft:<relationshipId>`), photos as Blobs,
 *   so a draft survives navigation, reload and going offline, and is never visible to another account
 *   (each account has its own database; the stored accountId is checked as well). Guests have no drafts.
 * - A draft is not a queued message: nothing is sent until the person taps Send. Sending moves the draft
 *   into the coach outbox (`queueCoachMessage`) and deletes the draft in the SAME transaction, then the
 *   outbox sends it — which re-checks that the relationship still allows messages before every send.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LiftDb } from '@/db/db';
import { MAX_PHOTOS, MESSAGE_MAX, queueCoachMessage, type QueueInput } from '@/coaching/outbox';

export interface CoachDraftPhoto {
  id: string;
  blob: Blob;
  thumb: Blob;
  width: number;
  height: number;
}

export interface CoachDraft {
  accountId: string;
  relationshipId: string;
  body: string;
  photos: CoachDraftPhoto[];
  updatedAt: number;
}

export const coachDraftKey = (relationshipId: string) => `coach-draft:${relationshipId}`;

export async function loadCoachDraft(db: LiftDb, relationshipId: string): Promise<CoachDraft | null> {
  if (db.isGuest || !relationshipId) return null;
  const row = await db.kv.get(coachDraftKey(relationshipId));
  const v = row?.value as CoachDraft | undefined;
  if (!v || typeof v !== 'object' || v.accountId !== db.accountKey || v.relationshipId !== relationshipId) return null;
  return {
    ...v,
    body: typeof v.body === 'string' ? v.body.slice(0, MESSAGE_MAX) : '',
    photos: Array.isArray(v.photos) ? v.photos.slice(0, MAX_PHOTOS) : [],
  };
}

/** Save (or, when empty, remove) the draft of one conversation. */
export async function saveCoachDraft(db: LiftDb, relationshipId: string, draft: { body: string; photos: CoachDraftPhoto[] }): Promise<void> {
  if (db.isGuest || !relationshipId) return;
  const key = coachDraftKey(relationshipId);
  if (!draft.body.trim() && draft.photos.length === 0) {
    await db.kv.delete(key);
    return;
  }
  const value: CoachDraft = {
    accountId: db.accountKey,
    relationshipId,
    body: draft.body.slice(0, MESSAGE_MAX),
    photos: draft.photos.slice(0, MAX_PHOTOS).map(({ id, blob, thumb, width, height }) => ({ id, blob, thumb, width, height })),
    updatedAt: Date.now(),
  };
  await db.kv.put({ key, value });
}

export async function clearCoachDraft(db: LiftDb, relationshipId: string): Promise<void> {
  await db.kv.delete(coachDraftKey(relationshipId));
}

/**
 * Turn the draft into a queued outbox message and delete the draft — atomically.
 * Throws (and keeps the draft) when the message is invalid or can't be stored.
 */
export async function queueDraftMessage(db: LiftDb, input: QueueInput): Promise<void> {
  await db.transaction('rw', db.coachOutbox, db.kv, async () => {
    await queueCoachMessage(input, db);
    await db.kv.delete(coachDraftKey(input.relationshipId));
  });
}

/** Text from elsewhere (e.g. "Discuss with coach" on a proposal) joins an existing draft instead of replacing it. */
export function mergeIncomingText(saved: string, incoming: string | null | undefined): string {
  const add = (incoming ?? '').trim();
  if (!add) return saved;
  if (!saved.trim()) return add.slice(0, MESSAGE_MAX);
  if (saved.includes(add)) return saved;
  return `${saved.trimEnd()}\n\n${add}`.slice(0, MESSAGE_MAX);
}

export interface ComposerPhoto extends CoachDraftPhoto {
  url: string;
}

const SAVE_DELAY_MS = 400;

/**
 * Composer state backed by the stored draft. `ready` is false until the saved draft has loaded
 * (the composer should be read-only until then so nothing typed is overwritten).
 */
export function useCoachDraft(relationshipId: string, db: LiftDb, incoming?: string | null) {
  const [ready, setReady] = useState(false);
  const [body, setBodyState] = useState('');
  const [photos, setPhotosState] = useState<ComposerPhoto[]>([]);
  const latest = useRef<{ body: string; photos: ComposerPhoto[]; dirty: boolean }>({ body: '', photos: [], dirty: false });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const incomingRef = useRef(incoming);

  const persist = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (!latest.current.dirty) return;
    latest.current.dirty = false;
    try {
      await saveCoachDraft(db, relationshipId, { body: latest.current.body, photos: latest.current.photos });
    } catch {
      latest.current.dirty = true; // storage hiccup: try again on the next change / flush
    }
  }, [db, relationshipId]);

  const schedule = useCallback(
    (delay: number) => {
      latest.current.dirty = true;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void persist(), delay);
    },
    [persist],
  );

  // Load the saved draft for this conversation; flush pending changes when leaving it.
  useEffect(() => {
    let cancelled = false;
    latest.current = { body: '', photos: [], dirty: false };
    setReady(false);
    setBodyState('');
    setPhotosState([]);
    loadCoachDraft(db, relationshipId)
      .catch(() => null)
      .then((d) => {
        if (cancelled) return;
        const savedBody = d?.body ?? '';
        const merged = mergeIncomingText(savedBody, incomingRef.current);
        incomingRef.current = null;
        const ph = (d?.photos ?? []).map((p) => ({ ...p, url: URL.createObjectURL(p.thumb) }));
        latest.current = { body: merged, photos: ph, dirty: merged !== savedBody };
        setBodyState(merged);
        setPhotosState(ph);
        setReady(true);
        if (latest.current.dirty) void persist();
      });
    const flush = () => void persist();
    const onHidden = () => document.visibilityState === 'hidden' && flush();
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      cancelled = true;
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHidden);
      void persist();
      latest.current.photos.forEach((p) => URL.revokeObjectURL(p.url));
    };
  }, [db, relationshipId, persist]);

  const setBody = useCallback(
    (v: string) => {
      const next = v.slice(0, MESSAGE_MAX);
      latest.current.body = next;
      setBodyState(next);
      schedule(SAVE_DELAY_MS);
    },
    [schedule],
  );

  const addPhoto = useCallback(
    (p: CoachDraftPhoto): boolean => {
      if (latest.current.photos.length >= MAX_PHOTOS) return false;
      const next = [...latest.current.photos, { ...p, url: URL.createObjectURL(p.thumb) }];
      latest.current.photos = next;
      setPhotosState(next);
      schedule(0);
      return true;
    },
    [schedule],
  );

  const removePhoto = useCallback(
    (id: string) => {
      const gone = latest.current.photos.find((x) => x.id === id);
      if (gone) URL.revokeObjectURL(gone.url);
      const next = latest.current.photos.filter((x) => x.id !== id);
      latest.current.photos = next;
      setPhotosState(next);
      schedule(0);
    },
    [schedule],
  );

  /** Queue the current draft for sending (outbox re-checks permission before it goes out) and clear it. */
  const send = useCallback(
    async (id: string) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      const cur = latest.current;
      try {
        await queueDraftMessage(db, { id, relationshipId, body: cur.body.trim(), photos: cur.photos.map(({ id: pid, blob, thumb, width, height }) => ({ id: pid, blob, thumb, width, height })) });
      } catch (e) {
        schedule(0); // not queued: make sure the draft itself is stored
        throw e;
      }
      cur.photos.forEach((p) => URL.revokeObjectURL(p.url));
      latest.current = { body: '', photos: [], dirty: false };
      setBodyState('');
      setPhotosState([]);
    },
    [db, relationshipId, schedule],
  );

  return { ready, body, photos, setBody, addPhoto, removePhoto, send, flush: persist };
}
