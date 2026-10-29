import { getDb, SYNCED_ENTITIES, type LiftDb, type SyncedEntity } from './db';
import type { SyncFields } from '@/domain/types';
import { uuid } from '@/lib/id';
import { reportStorageError } from '@/pwa/health';

type Listener = () => void;
const writeListeners = new Set<Listener>();
/** Sync engine subscribes to get poked after local writes. */
export function onLocalWrite(fn: Listener) {
  writeListeners.add(fn);
  return () => writeListeners.delete(fn);
}

export class StorageWriteError extends Error {
  constructor(cause: unknown) {
    super('Could not save to this device’s storage. Your browser may be out of space or blocking storage.');
    this.cause = cause;
  }
}

export function tableFor(db: LiftDb, entity: SyncedEntity) {
  return db.table(SYNCED_ENTITIES[entity]);
}

/** Queue (or coalesce) an outbox op. Only for signed-in account databases. */
async function enqueue(db: LiftDb, entity: SyncedEntity, recordId: string, op: 'upsert' | 'delete', preferRemote?: boolean) {
  if (db.isGuest) return;
  const existing = await db.outbox.where('[entity+recordId]').equals([entity, recordId]).first();
  if (existing) {
    // The payload is always read fresh at send time, so we only need the latest op kind.
    await db.outbox.update(existing.seq!, { op, status: existing.status === 'conflict' ? 'conflict' : 'pending', nextAttemptAt: 0 });
  } else {
    await db.outbox.add({ accountId: db.accountKey, entity, recordId, op, queuedAt: Date.now(), attempts: 0, status: 'pending', preferRemote });
  }
}

/** Create a new record with sync fields. */
export function newRecord<T extends object>(fields: T): T & SyncFields {
  const now = Date.now();
  return { id: uuid(), createdAt: now, updatedAt: now, ...fields } as T & SyncFields;
}

/** Persist a record immediately and queue it for sync. */
export async function saveRecord<T extends SyncFields>(entity: SyncedEntity, record: T, db: LiftDb = getDb(), opts: { preferRemote?: boolean } = {}): Promise<T> {
  const rec = { ...record, updatedAt: Date.now() };
  try {
    await db.transaction('rw', tableFor(db, entity), db.outbox, async () => {
      await tableFor(db, entity).put(rec);
      await enqueue(db, entity, rec.id, 'upsert', opts.preferRemote);
    });
  } catch (e) {
    reportStorageError(e); // quota / unavailable → app-wide banner (other errors are ignored there)
    throw new StorageWriteError(e);
  }
  writeListeners.forEach((l) => l());
  return rec;
}

export interface BulkWrite {
  entity: SyncedEntity;
  record: SyncFields;
  /** Imported record that may already exist in the cloud: keep the cloud copy on conflict. */
  preferRemote?: boolean;
}

/**
 * Write many records (and their outbox ops) in ONE Dexie transaction: either every record is stored and
 * queued, or — if anything fails — nothing is changed.
 * Pass a function to decide the writes INSIDE the transaction (it may read any synced table, e.g. to
 * re-check the current local state); throwing from it aborts without writing.
 * Records are stored as given (callers set updatedAt/serverVersion deliberately).
 */
export async function saveRecordsAtomic(writes: BulkWrite[] | (() => Promise<BulkWrite[]>), db: LiftDb = getDb()): Promise<number> {
  const tables = typeof writes === 'function' ? Object.values(SYNCED_ENTITIES) : [...new Set(writes.map((w) => SYNCED_ENTITIES[w.entity]))];
  let n = 0;
  try {
    await db.transaction('rw', [...tables.map((t) => db.table(t)), db.outbox], async () => {
      const list = typeof writes === 'function' ? await writes() : writes;
      for (const w of list) {
        await tableFor(db, w.entity).put(w.record);
        await enqueue(db, w.entity, w.record.id, 'upsert', w.preferRemote);
      }
      n = list.length;
    });
  } catch (e) {
    // Errors meant for the user (e.g. validation inside the plan) keep their message.
    if (e instanceof Error && (e as { userFacing?: boolean }).userFacing) throw e;
    reportStorageError(e);
    throw new StorageWriteError(e);
  }
  if (n) writeListeners.forEach((l) => l());
  return n;
}

/** Soft delete: keep a tombstone so other devices learn about the deletion. */
export async function deleteRecord(entity: SyncedEntity, id: string, db: LiftDb = getDb()): Promise<void> {
  try {
    await db.transaction('rw', tableFor(db, entity), db.outbox, async () => {
      const t = tableFor(db, entity);
      const existing = await t.get(id);
      if (!existing) return;
      if (db.isGuest) {
        await t.delete(id);
        return;
      }
      await t.put({ ...existing, deletedAt: Date.now(), updatedAt: Date.now() });
      await enqueue(db, entity, id, 'delete');
    });
  } catch (e) {
    reportStorageError(e); // quota / unavailable → app-wide banner (other errors are ignored there)
    throw new StorageWriteError(e);
  }
  writeListeners.forEach((l) => l());
}

/** Filter out tombstones. */
export const alive = <T extends { deletedAt?: number }>(rows: T[]) => rows.filter((r) => !r.deletedAt);

export async function kvGet<T>(key: string, db: LiftDb = getDb()): Promise<T | undefined> {
  return (await db.kv.get(key))?.value as T | undefined;
}
export async function kvSet(key: string, value: unknown, db: LiftDb = getDb()) {
  await db.kv.put({ key, value });
}
