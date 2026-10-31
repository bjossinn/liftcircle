/**
 * Coach-chat outbox: messages are written to the ACCOUNT-SCOPED `db.coachOutbox` before anything
 * is sent, so nothing a person types is lost offline or on a flaky connection.
 *
 * State machine (per item, id = the server message id, so every retry is idempotent):
 *   queued ──(online, relationship still writable)──▶ sending ──server ok──▶ removed (message is "Sent")
 *      ▲                                               │
 *      └──────────── network error / offline ──────────┤
 *                                                      └── other error ──▶ failed (manual Retry)
 *   queued ──(relationship ended / declined / suspended / missing)──▶ failed with an explanation,
 *            NO send call; the text stays so the person can copy it.
 *
 * Messages with photos: sendMessage(id, mediaIds) creates the row as 'awaiting_media'; each photo is
 * then uploaded (marked per photo, so a retry skips finished uploads) and the server's
 * finalize step flips it to 'sent'. The item is removed once every photo is uploaded.
 * Processing never throws into callers; concurrent calls coalesce.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { CoachOutboxItem, LiftDb } from '@/db/db';
import type { CoachingRelationship, CoachMessage } from '@/backend/coachingContract';
import { coachingApi } from '@/backend/coaching';
import { useApp } from '@/state/app';
import { relationshipWritable } from './relationship';
import { coachingError, isNetworkError } from './errors';

export const MESSAGE_MAX = 4000;
export const MAX_PHOTOS = 4;

const isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;

/* ============================================================ sent events */
type SentListener = (m: CoachMessage, relationshipId: string) => void;
const sentListeners = new Set<SentListener>();
/** Subscribe to messages the outbox has just persisted on the server. */
export function onCoachMessageSent(fn: SentListener): () => void {
  sentListeners.add(fn);
  return () => sentListeners.delete(fn);
}

/* ============================================================ in-flight store (for "Sending…") */
const inFlight = new Set<string>();
const inFlightListeners = new Set<() => void>();
function setInFlight(id: string, on: boolean) {
  if (on) inFlight.add(id);
  else inFlight.delete(id);
  inFlightListeners.forEach((l) => l());
}
export function useOutboxInFlight(id: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      inFlightListeners.add(cb);
      return () => inFlightListeners.delete(cb);
    },
    () => inFlight.has(id),
    () => false,
  );
}

/* ============================================================ queue API */
export interface QueueInput {
  id: string;
  relationshipId: string;
  body: string;
  sharedFromAi?: boolean;
  photos?: { id: string; blob: Blob; thumb: Blob; width: number; height: number }[];
}

/** Persist a message locally (status 'queued'). Same id twice is a no-op. */
export async function queueCoachMessage(input: QueueInput, db: LiftDb): Promise<void> {
  const body = input.body.trim();
  const photos = input.photos ?? [];
  if (!body && photos.length === 0) throw new Error('Write a message or add a photo.');
  if (body.length > MESSAGE_MAX) throw new Error(`Messages can be up to ${MESSAGE_MAX} characters.`);
  if (photos.length > MAX_PHOTOS) throw new Error(`You can attach up to ${MAX_PHOTOS} photos.`);
  if (db.isGuest) throw new Error('Sign in to message your coach.');
  await db.transaction('rw', db.coachOutbox, async () => {
    if (await db.coachOutbox.get(input.id)) return;
    await db.coachOutbox.add({
      id: input.id,
      accountId: db.accountKey,
      relationshipId: input.relationshipId,
      body,
      sharedFromAi: input.sharedFromAi || undefined,
      photos: photos.length ? photos.map((p) => ({ ...p, uploaded: false })) : undefined,
      status: 'queued',
      attempts: 0,
      createdAt: Date.now(),
    });
  });
}

/** Manual retry: back to 'queued', then process. Keeps the same id (no duplicates on the server). */
export async function retryCoachMessage(id: string, db: LiftDb, accountId: string | null): Promise<void> {
  try {
    const row = await db.coachOutbox.get(id);
    if (!row || row.status === 'sending') return;
    await db.coachOutbox.update(id, { status: 'queued', error: undefined });
  } catch {
    return;
  }
  await processCoachOutbox(db, { accountId });
}

/** Remove an unsent message from this device. */
export async function discardCoachMessage(id: string, db: LiftDb): Promise<void> {
  try {
    await db.coachOutbox.delete(id);
  } catch {
    /* ignore */
  }
}

/* ============================================================ processing */
export interface ProcessOptions {
  /** The account currently signed in with a valid session; items are only sent for this account. */
  accountId: string | null;
}

let running: Promise<void> | null = null;
let rerun: { db: LiftDb; opts: ProcessOptions } | null = null;

/** Send every eligible queued message. Never throws; concurrent calls coalesce into one more pass. */
export function processCoachOutbox(db: LiftDb, opts: ProcessOptions): Promise<void> {
  if (running) {
    rerun = { db, opts };
    return running;
  }
  running = (async () => {
    let job: { db: LiftDb; opts: ProcessOptions } | null = { db, opts };
    while (job) {
      rerun = null;
      try {
        await runOnce(job.db, job.opts);
      } catch {
        /* never surface */
      }
      job = rerun;
    }
  })().finally(() => {
    running = null;
  });
  return running;
}

async function runOnce(db: LiftDb, opts: ProcessOptions) {
  if (db.isGuest || !opts.accountId || opts.accountId !== db.accountKey) return;
  if (!isOnline()) return;
  const rows = (await db.coachOutbox.where('accountId').equals(db.accountKey).toArray())
    // 'sending' rows not in flight in this runtime were interrupted (tab closed, crash): resume them.
    .filter((r) => r.status === 'queued' || (r.status === 'sending' && !inFlight.has(r.id)))
    .sort((a, b) => a.createdAt - b.createdAt);
  if (!rows.length) return;

  // Re-check permission before sending anything queued: ended / revoked / blocked / suspended → fail.
  let rels: CoachingRelationship[];
  try {
    rels = await coachingApi.myRelationships();
  } catch {
    return; // can't verify right now → keep everything queued
  }
  for (const row of rows) {
    if (!isOnline()) break;
    const rel = rels.find((r) => r.id === row.relationshipId);
    const w = relationshipWritable(rel);
    if (!w.ok) {
      await db.coachOutbox.update(row.id, {
        status: 'failed',
        error: `Not sent: ${w.reason} Your text is kept here so you can copy it.`,
      });
      continue;
    }
    const stop = await sendOne(row, db);
    if (stop) break;
  }
}

/** Returns true when processing should stop (went offline). */
async function sendOne(row: CoachOutboxItem, db: LiftDb): Promise<boolean> {
  setInFlight(row.id, true);
  try {
    await db.coachOutbox.update(row.id, { status: 'sending', error: undefined });
    const photos = row.photos ?? [];
    const input = { id: row.id, relationshipId: row.relationshipId, body: row.body, mediaIds: photos.length ? photos.map((p) => p.id) : undefined, sharedFromAi: row.sharedFromAi };
    let msg = await coachingApi.sendMessage(input);
    if (photos.length) {
      for (const ph of photos) {
        const fresh = await db.coachOutbox.get(row.id);
        if (!fresh) return false; // discarded meanwhile
        if (fresh.photos?.find((p) => p.id === ph.id)?.uploaded) continue;
        await coachingApi.uploadMessageMedia(row.relationshipId, row.id, ph.id, ph.blob, ph.thumb);
        await db.coachOutbox
          .where('id')
          .equals(row.id)
          .modify((r) => {
            const p = r.photos?.find((x) => x.id === ph.id);
            if (p) p.uploaded = true;
          });
      }
      // Same id → the server returns the existing row (now 'sent' once finalized); no duplicate.
      if (msg.status === 'awaiting_media') msg = await coachingApi.sendMessage(input);
    }
    await db.coachOutbox.delete(row.id);
    sentListeners.forEach((l) => l(msg, row.relationshipId));
    return false;
  } catch (e) {
    try {
      if (isNetworkError(e)) {
        await db.coachOutbox.update(row.id, { status: 'queued', error: undefined });
        return true;
      }
      const cur = await db.coachOutbox.get(row.id);
      if (cur) await db.coachOutbox.update(row.id, { status: 'failed', attempts: cur.attempts + 1, error: coachingError(e, 'The message wasn’t sent.') });
    } catch {
      /* storage failure: leave as is */
    }
    return false;
  } finally {
    setInFlight(row.id, false);
  }
}

/* ============================================================ hooks */

/** Unsent messages of one conversation (oldest first). */
export function useCoachOutbox(relationshipId: string | undefined): CoachOutboxItem[] {
  const { db } = useApp();
  return (
    useLiveQuery(
      async () => (relationshipId ? (await db.coachOutbox.where('relationshipId').equals(relationshipId).toArray()).filter((r) => r.accountId === db.accountKey).sort((a, b) => a.createdAt - b.createdAt) : []),
      [db, relationshipId],
    ) ?? []
  );
}

/** Keeps the outbox moving: on mount, when coming online, when the page becomes visible. */
export function useCoachOutboxRunner(): void {
  const { db, auth, online } = useApp();
  const accountId = auth.status === 'signed_in' && auth.userId ? auth.userId : null;
  useEffect(() => {
    if (!accountId || !online) return;
    void processCoachOutbox(db, { accountId });
  }, [db, accountId, online]);
  useEffect(() => {
    if (!accountId) return;
    const kick = () => void processCoachOutbox(db, { accountId });
    const onVisible = () => document.visibilityState === 'visible' && kick();
    window.addEventListener('online', kick);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', kick);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [db, accountId]);
}

/** Status line for an unsent message. Never claims "Sent". */
export function outboxStatusLabel(item: Pick<CoachOutboxItem, 'status'>, online: boolean, sending = false): string {
  if (item.status === 'failed') return 'Failed: Retry';
  if (sending || item.status === 'sending') return 'Sending…';
  return online ? 'Sending…' : 'Queued: will send when you’re back online';
}
