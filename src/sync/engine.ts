/**
 * Private-record synchronization.
 *
 * - Local writes go to Dexie first and queue an outbox op (src/db/repo.ts). Workouts never wait on the network.
 * - Push: for each queued op (oldest first) we read the CURRENT local record and call sync_push with the
 *   server-issued version we last saw as base_version. The server does an atomic compare-and-swap.
 * - Conflicts are never resolved by device timestamps. A conflicting edit is preserved in db.conflicts and the
 *   user chooses (keep this device / keep the other / keep both as copies).
 * - Server tombstones win: an old offline device can't resurrect a deleted record ('gone'); its local edits
 *   are kept as a restorable conflict instead of being silently dropped.
 * - Ops carry the account id and are only ever sent while that same account is authenticated.
 * - Auth failures pause sync without touching local data.
 */
import { useSyncExternalStore } from 'react';
import { SYNCED_ENTITIES, type LiftDb, type OutboxOp, type SyncConflict, type SyncedEntity } from '@/db/db';
import { onLocalWrite, tableFor } from '@/db/repo';
import type { PushResult } from '@/backend/contract';
import { syncRemote, toBackendError } from '@/backend/syncRemote';
import { uuid } from '@/lib/id';
import { supabase } from '@/backend/supabase';
import { BackendError } from '@/backend/syncRemote';

export type SyncPhase = 'disabled' | 'idle' | 'syncing' | 'offline' | 'paused_auth' | 'error';
export interface SyncStatus {
  phase: SyncPhase;
  pending: number;
  conflicts: number;
  failing: number;
  lastSyncedAt?: number;
  lastError?: string;
}

interface Ctx {
  db: LiftDb;
  userId: string | null; // authenticated (valid session) user, or null
  online: boolean;
}

let ctx: Ctx | null = null;
let status: SyncStatus = { phase: 'disabled', pending: 0, conflicts: 0, failing: 0 };
let running: Promise<void> | null = null;
let again = false;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function setStatus(patch: Partial<SyncStatus>) {
  status = { ...status, ...patch };
  listeners.forEach((l) => l());
}

export function getSyncStatus() {
  return status;
}
export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => status,
  );
}

const MAX_BACKOFF = 5 * 60_000;
const backoff = (attempts: number) => Math.min(MAX_BACKOFF, 2000 * 2 ** Math.max(0, attempts - 1));
const CURSOR_KEY = 'sync-cursor';

/** Strip local-only fields before sending. */
function toPayload(rec: Record<string, unknown>) {
  const { serverVersion: _v, ...rest } = rec;
  return rest;
}

/** Cheap 32-bit FNV-1a hash of the stable JSON, plus length, for recognising payloads we sent. */
export function payloadHash(v: unknown): string {
  const str = stableStringify(v);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(16)}:${str.length}`;
}

/** Stable JSON for equality checks (key order independent). */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined && k !== 'serverVersion')
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}

async function refreshCounts(db: LiftDb) {
  try {
    const [pending, conflicts, failing] = await Promise.all([
      db.outbox.where('status').equals('pending').count(),
      db.conflicts.count(),
      db.outbox.where('status').equals('error').count(),
    ]);
    setStatus({ pending, conflicts, failing });
  } catch {
    /* db closed during account switch */
  }
}

/** Called by <SyncRunner/> whenever auth/online/db change. */
export function configureSync(next: Ctx) {
  ctx = next;
  if (next.db.isGuest) {
    setStatus({ phase: 'disabled', pending: 0, conflicts: 0, failing: 0 });
    return;
  }
  void refreshCounts(next.db);
  if (!next.userId || next.userId !== next.db.accountKey) {
    setStatus({ phase: 'paused_auth' });
    return;
  }
  if (!next.online) {
    setStatus({ phase: 'offline' });
    return;
  }
  schedule(0);
}

function schedule(ms: number) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void syncNow(), ms);
}

onLocalWrite(() => {
  if (ctx && !ctx.db.isGuest) {
    void refreshCounts(ctx.db);
    schedule(1500);
  }
});

/** Run a full push+pull cycle now (coalesces concurrent calls). */
export function syncNow(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        again = false;
        await cycle();
      } while (again);
    } finally {
      running = null;
    }
  })();
  return running;
}

async function cycle() {
  const c = ctx;
  if (!c || c.db.isGuest) return;
  if (!c.userId || c.userId !== c.db.accountKey) return setStatus({ phase: 'paused_auth' });
  if (!c.online) return setStatus({ phase: 'offline' });
  setStatus({ phase: 'syncing' });
  try {
    await pushAll(c.db, c.userId);
    await pullAll(c.db);
    setStatus({ phase: 'idle', lastSyncedAt: Date.now(), lastError: undefined });
  } catch (e) {
    const err = toBackendError(e);
    if (err.isAuth) setStatus({ phase: 'paused_auth', lastError: err.message });
    else if (err.isNetwork) setStatus({ phase: 'offline', lastError: err.message });
    else {
      setStatus({ phase: 'error', lastError: err.message });
      schedule(30_000);
    }
  } finally {
    await refreshCounts(c.db);
  }
}

async function pushAll(db: LiftDb, userId: string) {
  for (;;) {
    const now = Date.now();
    const ops = (await db.outbox.where('status').equals('pending').sortBy('seq')).filter(
      (o) => o.accountId === userId && (o.nextAttemptAt ?? 0) <= now,
    );
    if (ops.length === 0) {
      const waiting = await db.outbox.where('status').equals('pending').filter((o) => o.accountId === userId).first();
      if (waiting?.nextAttemptAt) schedule(Math.max(1000, waiting.nextAttemptAt - now));
      return;
    }
    for (const op of ops) {
      if (ctx?.db !== db || ctx.userId !== userId) return; // account switched mid-run: stop immediately
      await pushOne(db, op);
    }
  }
}

async function pushOne(db: LiftDb, op: OutboxOp) {
  const table = tableFor(db, op.entity);
  const rec = (await table.get(op.recordId)) as (Record<string, unknown> & { id: string; updatedAt: number; serverVersion?: number; deletedAt?: number }) | undefined;
  if (!rec) {
    await db.outbox.delete(op.seq!);
    return;
  }
  const kind: 'upsert' | 'delete' = rec.deletedAt ? 'delete' : 'upsert';
  const base = rec.serverVersion ?? null;
  const payload = toPayload(rec);
  const hash = payloadHash(payload);
  // Never send an op with credentials of a different account (e.g. another tab switched accounts).
  const sb = supabase();
  if (sb) {
    const { data } = await sb.auth.getSession();
    if (data.session?.user.id !== op.accountId) throw new BackendError('Signed in as a different account', 'auth', 401);
  }
  const sentHashes = [...(op.sentHashes ?? []).filter((h) => h !== hash), hash].slice(-5);
  await db.outbox.update(op.seq!, { sentHashes });
  let res: PushResult;
  try {
    res = await syncRemote.push(op.entity, rec.id, kind, base, payload);
  } catch (e) {
    const err = toBackendError(e);
    if (err.isAuth || err.isNetwork) throw err; // pause the whole run
    const attempts = op.attempts + 1;
    await db.outbox.update(op.seq!, {
      attempts,
      lastError: err.message,
      nextAttemptAt: Date.now() + backoff(attempts),
      status: attempts >= 8 ? 'error' : 'pending',
    });
    return;
  }

  // Apply the result without clobbering edits made while the request was in flight.
  await db.transaction('rw', table, db.outbox, db.conflicts, async () => {
    const cur = (await table.get(rec.id)) as typeof rec | undefined;
    const unchanged = !!cur && cur.updatedAt === rec.updatedAt;
    const finish = async () => {
      if (unchanged) await db.outbox.delete(op.seq!);
      else await db.outbox.update(op.seq!, { attempts: 0, status: 'pending', nextAttemptAt: 0 });
    };
    if (res.status === 'ok') {
      if (cur) await table.update(rec.id, { serverVersion: res.version });
      await finish();
      return;
    }
    if (res.status === 'gone') {
      // Deleted elsewhere: deletion wins. Keep local edits restorable if this wasn't our own delete.
      if (kind === 'upsert' && cur) await saveConflict(db, op.entity, cur, null, res.version, true);
      if (cur) await table.put({ ...cur, deletedAt: cur.deletedAt ?? Date.now(), serverVersion: res.version });
      await db.outbox.delete(op.seq!);
      return;
    }
    // conflict
    const remotePayload = res.payload as Record<string, unknown> | null;
    const remoteHash = remotePayload && !res.deleted ? payloadHash(remotePayload) : null;
    if (remoteHash && remoteHash === hash) {
      // Our earlier attempt already applied (idempotent retry).
      if (cur) await table.update(rec.id, { serverVersion: res.version });
      await finish();
      return;
    }
    if (remoteHash && sentHashes.includes(remoteHash)) {
      // An earlier attempt of ours landed (response was lost) and we've edited since:
      // adopt the server version as our base and push the newer local state again.
      if (cur) await table.update(rec.id, { serverVersion: res.version });
      await db.outbox.update(op.seq!, { attempts: 0, status: 'pending', nextAttemptAt: 0 });
      return;
    }
    if (base === null && remotePayload && !res.deleted && op.preferRemote) {
      // Imported record whose id already exists in the cloud: preserve the existing cloud record.
      await table.put({ ...remotePayload, serverVersion: res.version });
      await db.outbox.delete(op.seq!);
      return;
    }
    if (kind === 'delete' && res.deleted) {
      // Already deleted on the server too.
      if (cur) await table.update(rec.id, { serverVersion: res.version });
      await db.outbox.delete(op.seq!);
      return;
    }
    await saveConflict(db, op.entity, cur ?? rec, remotePayload, res.version, !!res.deleted);
    await db.outbox.update(op.seq!, { status: 'conflict' });
  });
}

async function saveConflict(db: LiftDb, entity: SyncedEntity, local: unknown, remote: unknown, remoteVersion: number, remoteDeleted: boolean) {
  const l = local as { id: string };
  const c: SyncConflict = {
    id: `${entity}:${l.id}`,
    entity,
    recordId: l.id,
    local,
    remote,
    remoteVersion,
    detectedAt: Date.now(),
    remoteDeleted,
  };
  await db.conflicts.put(c);
}

async function pullAll(db: LiftDb) {
  let since = ((await db.kv.get(CURSOR_KEY))?.value as number | undefined) ?? 0;
  for (let page = 0; page < 50; page++) {
    const res = await syncRemote.pull(since, 200);
    for (const ch of res.changes) {
      const tableName = SYNCED_ENTITIES[ch.entity];
      if (!tableName) continue;
      const table = db.table(tableName);
      await db.transaction('rw', table, db.outbox, db.conflicts, async () => {
        const local = (await table.get(ch.id)) as { serverVersion?: number; deletedAt?: number } | undefined;
        if (local?.serverVersion != null && local.serverVersion >= ch.version) return; // already have it
        const pendingOp = await db.outbox.where('[entity+recordId]').equals([ch.entity, ch.id]).first();
        if (pendingOp) {
          // Local edit pending: the push will surface any conflict. If a conflict is already waiting for the
          // user, keep its "other device" side current so resolving never applies an outdated copy.
          if (pendingOp.status === 'conflict') {
            const cid = `${ch.entity}:${ch.id}`;
            const existing = await db.conflicts.get(cid);
            if (existing && existing.remoteVersion < ch.version)
              await db.conflicts.put({ ...existing, remote: ch.deleted ? null : ch.payload, remoteVersion: ch.version, remoteDeleted: ch.deleted } as SyncConflict);
          }
          return;
        }
        if (ch.deleted) {
          if (local) await table.put({ ...local, deletedAt: local.deletedAt ?? Date.now(), serverVersion: ch.version });
          return;
        }
        if (ch.payload) await table.put({ ...(ch.payload as object), serverVersion: ch.version });
      });
    }
    since = res.cursor;
    await db.kv.put({ key: CURSOR_KEY, value: since });
    if (!res.hasMore) break;
  }
}

/* ------------------------------------------------------ conflict resolution */
export type ConflictChoice = 'keep_local' | 'keep_remote' | 'keep_both';

export async function resolveConflict(db: LiftDb, conflictId: string, choice: ConflictChoice) {
  const c = await db.conflicts.get(conflictId);
  if (!c) return;
  const table = tableFor(db, c.entity);
  await db.transaction('rw', table, db.outbox, db.conflicts, async () => {
    // Use the CURRENT local row so edits made after the conflict was detected aren't reverted.
    const local = ((await table.get(c.recordId)) ?? c.local) as Record<string, unknown> & { id: string; deletedAt?: number };
    const op = await db.outbox.where('[entity+recordId]').equals([c.entity, c.recordId]).first();
    if (choice === 'keep_remote') {
      if (c.remoteDeleted || !c.remote) await table.put({ ...local, deletedAt: Date.now(), serverVersion: c.remoteVersion });
      else await table.put({ ...(c.remote as object), serverVersion: c.remoteVersion });
      if (op) await db.outbox.delete(op.seq!);
    } else if (choice === 'keep_local' && !c.remoteDeleted) {
      // Overwrite the cloud copy (or re-apply our deletion): retry with the server's current version as base.
      await table.put({ ...local, serverVersion: c.remoteVersion, updatedAt: Date.now() });
      if (op) await db.outbox.update(op.seq!, { status: 'pending', attempts: 0, nextAttemptAt: 0 });
      else await db.outbox.add({ accountId: db.accountKey, entity: c.entity, recordId: c.recordId, op: 'upsert', queuedAt: Date.now(), attempts: 0, status: 'pending' });
    } else {
      // keep_both (or "restore" a remotely deleted record): this device's version becomes a new record.
      const copyId = uuid();
      const now = Date.now();
      const base = local.deletedAt ? (c.local as Record<string, unknown>) : local;
      await table.put({ ...base, id: copyId, serverVersion: undefined, deletedAt: undefined, createdAt: now, updatedAt: now, sharedPostIds: undefined });
      await db.outbox.add({ accountId: db.accountKey, entity: c.entity, recordId: copyId, op: 'upsert', queuedAt: now, attempts: 0, status: 'pending' });
      if (c.remoteDeleted || !c.remote) await table.put({ ...local, deletedAt: now, serverVersion: c.remoteVersion });
      else await table.put({ ...(c.remote as object), serverVersion: c.remoteVersion });
      if (op) await db.outbox.delete(op.seq!);
    }
    await db.conflicts.delete(conflictId);
  });
  await refreshCounts(db);
  if (ctx?.db === db) schedule(0);
}

/** Retry ops that exhausted automatic attempts. */
export async function retryFailed(db: LiftDb) {
  await db.outbox.where('status').equals('error').modify({ status: 'pending', attempts: 0, nextAttemptAt: 0 });
  schedule(0);
}

/** Count of ops not yet confirmed by the server (for sign-out decisions). */
export async function unsyncedCount(db: LiftDb) {
  // Unresolved conflicts hold local edits that exist nowhere else.
  return (await db.outbox.count()) + (await db.conflicts.count());
}
