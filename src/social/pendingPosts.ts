/**
 * Local queue of posts that haven't been published yet (offline shares, failed uploads).
 *
 * Lives in the ACCOUNT-SCOPED database (`db.pendingPosts`), so a queued post can only ever be
 * published while that same account is signed in. Publishing is resumable and idempotent:
 *   createPostDraft(id) → uploadPostMedia for each photo not yet uploaded (marked per photo)
 *   → publishPost(id) → local row removed.
 * Failures are recorded on the pending row (status 'error', attempts, error text) and retried with
 * exponential backoff. Nothing here ever throws into callers or touches workout records on failure.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { ID, PendingPost } from '@/domain/types';
import type { LiftDb } from '@/db/db';
import { saveRecord } from '@/db/repo';
import { socialApi } from '@/backend/social';
import { useApp, useDb } from '@/state/app';

/* ============================================================ errors */

/** Turn any backend/network error into a short sentence a person can act on. */
export function friendlyError(e: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  const status = (e as { status?: number } | null)?.status;
  const msg = raw.toLowerCase();
  if ((typeof navigator !== 'undefined' && navigator.onLine === false) || /failed to fetch|networkerror|network request failed|load failed/.test(msg)) {
    return 'Couldn’t reach the server. Check your connection and try again.';
  }
  if (status === 401 || /jwt|not authenticated|session.*expired|invalid token/.test(msg)) return 'Your session has expired. Sign in again to continue.';
  if (status === 429 || /rate limit|too many/.test(msg)) return 'You’re doing that a lot. Wait a moment and try again.';
  if (status === 413 || /payload too large|too large/.test(msg)) return 'That file is too large to upload.';
  if (/not implemented/.test(msg)) return 'Social features aren’t available right now.';
  if (e instanceof DOMException && e.name === 'AbortError') return 'Cancelled.';
  // Messages written for people (short, no codes/JSON/SQL) are passed through.
  if (raw && raw.length <= 140 && !/[{}<>]|pgrst|violates|constraint|sql|syntax|undefined|null|stack|\bat\b.*:\d+/i.test(raw)) return raw;
  return fallback;
}

/* ============================================================ auth gate */

let gateAccount: string | null = null;
const gateListeners = new Set<() => void>();

/**
 * Tell the queue which account is currently signed in with a VALID session (null otherwise).
 * Pending posts are only processed for a database whose accountKey equals this id.
 */
export function setPendingPostsAccount(accountId: string | null) {
  if (gateAccount === accountId) return;
  gateAccount = accountId;
  gateListeners.forEach((l) => l());
}

const isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;

/* ============================================================ progress store */

const progress = new Map<ID, number>();
const progressListeners = new Set<() => void>();
function setProgress(id: ID, value: number | null) {
  if (value == null) progress.delete(id);
  else progress.set(id, Math.max(0, Math.min(1, value)));
  progressListeners.forEach((l) => l());
}
/** Upload progress 0..1 for a pending post that is currently uploading, else null. */
export function usePendingProgress(id: ID | null | undefined): number | null {
  return useSyncExternalStore(
    (cb) => {
      progressListeners.add(cb);
      return () => progressListeners.delete(cb);
    },
    () => (id ? (progress.get(id) ?? null) : null),
    () => null,
  );
}

/* ============================================================ backoff */

export const MAX_AUTO_ATTEMPTS = 6;
const BASE_DELAY_MS = 5_000;
const MAX_DELAY_MS = 30 * 60_000;
const nextAttemptAt = new Map<ID, number>();
export const backoffDelay = (attempts: number) => Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1));

/* ============================================================ queue API */

export async function queuePost(p: Omit<PendingPost, 'status' | 'attempts' | 'createdAt'>, db: LiftDb): Promise<void> {
  if (p.photos.length > 4) throw new Error('A post can have up to 4 photos.');
  await db.transaction('rw', db.pendingPosts, async () => {
    // Same id queued twice (double tap, re-render) is a no-op: the id is the server post id.
    if (await db.pendingPosts.get(p.id)) return;
    await db.pendingPosts.add({
      ...p,
      photos: p.photos.map((ph) => ({ ...ph, uploaded: false })),
      status: 'waiting',
      attempts: 0,
      createdAt: Date.now(),
    });
  });
}

const controllers = new Map<ID, AbortController>();

export async function cancelPendingPost(id: ID, db: LiftDb): Promise<void> {
  const row = await db.pendingPosts.get(id);
  controllers.get(id)?.abort();
  controllers.delete(id);
  nextAttemptAt.delete(id);
  setProgress(id, null);
  await db.pendingPosts.delete(id);
  // If a draft may exist on the server, clean it up (best-effort; server also expires abandoned drafts).
  if (row && (row.attempts > 0 || row.status === 'uploading') && gateAccount === db.accountKey && isOnline()) {
    socialApi.deletePost(id).catch(() => {});
  }
}

export async function retryPendingPost(id: ID, db: LiftDb): Promise<void> {
  try {
    const row = await db.pendingPosts.get(id);
    if (!row) return;
    nextAttemptAt.delete(id);
    if (row.status !== 'uploading') await db.pendingPosts.update(id, { status: 'waiting', error: undefined });
  } catch {
    return;
  }
  await processPendingPosts(db);
}

/* ============================================================ processing */

let running: Promise<void> | null = null;
let rerun: { db: LiftDb; opts?: ProcessOptions } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

export interface ProcessOptions {
  /** Override the auth gate (e.g. from a component that knows the current auth state). */
  accountId?: string | null;
}

/** Publish every eligible pending post. Never throws. Concurrent calls coalesce. */
export function processPendingPosts(db: LiftDb, opts?: ProcessOptions): Promise<void> {
  if (running) {
    rerun = { db, opts };
    return running;
  }
  running = (async () => {
    let job: { db: LiftDb; opts?: ProcessOptions } | null = { db, opts };
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

async function runOnce(db: LiftDb, opts?: ProcessOptions) {
  if (db.isGuest) return;
  const account = opts && 'accountId' in opts ? (opts.accountId ?? null) : gateAccount;
  if (!account || account !== db.accountKey) return;
  if (!isOnline()) return;
  const rows = (await db.pendingPosts.toArray()).sort((a, b) => a.createdAt - b.createdAt);
  const now = Date.now();
  for (const row of rows) {
    if (!isOnline()) break;
    if (controllers.has(row.id)) continue; // already in flight
    if (row.status === 'error') {
      if (row.attempts >= MAX_AUTO_ATTEMPTS) continue; // needs a manual retry
      if ((nextAttemptAt.get(row.id) ?? 0) > now) continue;
    }
    await publishOne(row.id, db);
  }
  scheduleRetry(db);
}

function scheduleRetry(db: LiftDb) {
  if (timer) clearTimeout(timer);
  timer = null;
  let soonest = Infinity;
  for (const t of nextAttemptAt.values()) soonest = Math.min(soonest, t);
  if (!isFinite(soonest)) return;
  timer = setTimeout(() => {
    timer = null;
    void processPendingPosts(db);
  }, Math.max(1000, soonest - Date.now()));
}

class Cancelled extends Error {}

async function publishOne(id: ID, db: LiftDb): Promise<void> {
  const ctrl = new AbortController();
  controllers.set(id, ctrl);
  const alive = async () => {
    if (ctrl.signal.aborted) throw new Cancelled();
    const r = await db.pendingPosts.get(id);
    if (!r) throw new Cancelled();
    return r;
  };
  try {
    let row = await alive();
    await db.pendingPosts.update(id, { status: 'uploading', error: undefined });
    const total = row.photos.length;
    setProgress(id, total ? row.photos.filter((p) => p.uploaded).length / (total + 1) : 0);

    // 1. Draft (idempotent on id). Snapshot only — sourceRecordId stays on this device.
    await socialApi.createPostDraft({
      id: row.id,
      kind: row.kind,
      audience: row.audience,
      caption: row.caption,
      snapshot: row.snapshot ?? null,
      media: row.photos.map((ph, i) => ({ id: ph.id, position: i, description: ph.description || undefined, width: ph.width, height: ph.height })),
    });

    // 2. Photos — skip the ones already uploaded on a previous attempt.
    for (let i = 0; i < row.photos.length; i++) {
      row = await alive();
      const ph = row.photos[i];
      if (!ph || ph.uploaded) continue;
      const done = row.photos.filter((p) => p.uploaded).length;
      await socialApi.uploadPostMedia(row.id, ph.id, ph.blob, ph.thumb, {
        signal: ctrl.signal,
        onProgress: (f) => setProgress(id, (done + f) / (total + 1)),
      });
      await db.pendingPosts
        .where('id')
        .equals(id)
        .modify((r) => {
          const p = r.photos.find((x) => x.id === ph.id);
          if (p) p.uploaded = true;
        });
      setProgress(id, (done + 1) / (total + 1));
    }

    // 3. Publish (server verifies media; idempotent).
    row = await alive();
    const post = await socialApi.publishPost(row.id);
    setProgress(id, 1);
    await db.pendingPosts.delete(id);
    nextAttemptAt.delete(id);
    await linkToSource(row, post?.id ?? row.id, db);
  } catch (e) {
    if (e instanceof Cancelled || ctrl.signal.aborted) return;
    try {
      const r = await db.pendingPosts.get(id);
      if (r) {
        const attempts = r.attempts + 1;
        const offline = !isOnline();
        await db.pendingPosts.update(id, {
          status: offline ? 'waiting' : 'error',
          attempts: offline ? r.attempts : attempts,
          error: offline ? undefined : friendlyError(e, 'The upload didn’t finish.'),
        });
        if (!offline) nextAttemptAt.set(id, Date.now() + backoffDelay(attempts));
      }
    } catch {
      /* storage failure: leave as is */
    }
  } finally {
    controllers.delete(id);
    setProgress(id, null);
  }
}

/** On success only: remember the post id on the local source record (for "delete the post too"). */
async function linkToSource(row: PendingPost, postId: ID, db: LiftDb) {
  if (!row.sourceRecordId) return;
  try {
    if (row.kind === 'workout') {
      const s = await db.sessions.get(row.sourceRecordId);
      if (s && !s.deletedAt && !(s.sharedPostIds ?? []).includes(postId)) {
        await saveRecord('sessions', { ...s, sharedPostIds: [...(s.sharedPostIds ?? []), postId] }, db);
      }
    } else if (row.kind === 'activity') {
      const a = await db.activities.get(row.sourceRecordId);
      if (a && !a.deletedAt && !(a.sharedPostIds ?? []).includes(postId)) {
        await saveRecord('activities', { ...a, sharedPostIds: [...(a.sharedPostIds ?? []), postId] }, db);
      }
    }
  } catch {
    /* the post is published; linking is a convenience */
  }
}

/* ============================================================ hooks */

/** Pending posts of the current account, oldest first. */
export function usePendingPosts(): PendingPost[] {
  const db = useDb();
  return useLiveQuery(async () => (await db.pendingPosts.toArray()).sort((a, b) => a.createdAt - b.createdAt), [db]) ?? [];
}

/**
 * Keeps the queue moving: processes on mount (app start), on 'online' events and when auth
 * becomes 'signed_in'. Safe to mount more than once (processing coalesces).
 */
export function usePendingPostsRunner(): void {
  const { db, auth, online } = useApp();
  const account = auth.status === 'signed_in' && auth.userId ? auth.userId : null;
  useEffect(() => {
    setPendingPostsAccount(account);
  }, [account]);
  useEffect(() => {
    if (!account || account !== db.accountKey || !online) return;
    void processPendingPosts(db, { accountId: account });
  }, [db, account, online]);
  useEffect(() => {
    const kick = () => void processPendingPosts(db);
    window.addEventListener('online', kick);
    const onVisible = () => document.visibilityState === 'visible' && kick();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', kick);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [db]);
}

/** Component form of the runner, for mounting once in the app shell. */
export function PendingPostsRunner(): null {
  usePendingPostsRunner();
  return null;
}

/** Status line for UI. Never implies the post is visible to anyone. */
export function pendingStatusLabel(p: Pick<PendingPost, 'status'>): string {
  if (p.status === 'uploading') return 'Uploading…';
  if (p.status === 'error') return 'Upload failed — Retry';
  return 'Waiting to upload';
}
