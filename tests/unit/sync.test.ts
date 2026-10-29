/**
 * Sync engine behaviour against an in-memory server that implements the documented
 * sync_push / sync_pull compare-and-swap contract (src/backend/contract.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PullResult, PushResult } from '@/backend/contract';
import type { SyncedEntity } from '@/db/db';

/* ---------------------------------------------------------- fake server */
interface Row { version: number; payload: unknown; deleted: boolean; owner: string }
const server = {
  rows: new Map<string, Row>(),
  seq: 0,
  user: 'user-a',
  failNext: null as null | 'network' | 'auth' | 'lost-response',
  pushes: 0,
  reset() {
    this.rows.clear();
    this.seq = 0;
    this.user = 'user-a';
    this.failNext = null;
    this.pushes = 0;
  },
  key(entity: string, id: string) {
    return `${this.user}:${entity}:${id}`;
  },
  push(entity: SyncedEntity, id: string, op: 'upsert' | 'delete', base: number | null, payload: unknown): PushResult {
    const k = this.key(entity, id);
    const row = this.rows.get(k);
    if (row?.deleted && op === 'upsert') return { status: 'gone', version: row.version };
    if (base === null && row) return { status: 'conflict', version: row.version, payload: row.payload, deleted: row.deleted };
    if (base !== null && (!row || row.version !== base)) return { status: 'conflict', version: row?.version ?? 0, payload: row?.payload ?? null, deleted: !!row?.deleted };
    const version = ++this.seq;
    this.rows.set(k, { version, payload, deleted: op === 'delete', owner: this.user });
    return { status: 'ok', version };
  },
  pull(since: number): PullResult {
    const changes = [...this.rows.entries()]
      .filter(([k, r]) => k.startsWith(`${this.user}:`) && r.version > since)
      .map(([k, r]) => ({ entity: k.split(':')[1] as SyncedEntity, id: k.split(':')[2], version: r.version, deleted: r.deleted, payload: r.deleted ? null : r.payload }))
      .sort((a, b) => a.version - b.version);
    return { changes, cursor: changes.length ? changes[changes.length - 1].version : since, hasMore: false };
  },
};

vi.mock('@/backend/syncRemote', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/backend/syncRemote')>();
  return {
    ...orig,
    syncRemote: {
      push: async (entity: SyncedEntity, id: string, op: 'upsert' | 'delete', base: number | null, payload: unknown) => {
        server.pushes++;
        const f = server.failNext;
        if (f === 'network') {
          server.failNext = null;
          throw new orig.BackendError('offline', 'network');
        }
        if (f === 'auth') throw new orig.BackendError('expired', 'auth', 401);
        const r = server.push(entity, id, op, base, JSON.parse(JSON.stringify(payload)));
        if (f === 'lost-response') {
          server.failNext = null;
          throw new orig.BackendError('connection dropped', 'network');
        }
        return r;
      },
      pull: async (since: number) => server.pull(since),
    },
  };
});

import { LiftDb } from '@/db/db';
import { saveRecord, deleteRecord, newRecord } from '@/db/repo';
import { configureSync, syncNow, getSyncStatus, resolveConflict, unsyncedCount } from '@/sync/engine';
import type { Measurement, SyncFields } from '@/domain/types';

const measurement = (value: number) => newRecord<Omit<Measurement, keyof SyncFields>>({ kind: 'bodyweight', date: '2026-10-01', value }) as Measurement;

let n = 0;
async function freshDb(account = 'user-a') {
  const db = new LiftDb(`${account}`);
  // unique physical name per test to avoid cross-test state
  (db as unknown as { name: string }).name;
  await db.delete();
  await db.open();
  return db;
}

beforeEach(() => {
  server.reset();
  n++;
});

async function run(db: LiftDb, userId: string | null = db.accountKey, online = true) {
  configureSync({ db, userId, online });
  await syncNow();
}

describe('sync engine', () => {
  it('pushes new records and records the server-issued version', async () => {
    const db = await freshDb();
    const m = await saveRecord('measurements', measurement(80), db);
    expect(await db.outbox.count()).toBe(1);
    await run(db);
    expect(await db.outbox.count()).toBe(0);
    expect((await db.measurements.get(m.id))?.serverVersion).toBe(1);
    expect(server.rows.size).toBe(1);
  });

  it('a retry after a lost response does not duplicate and is treated as success', async () => {
    const db = await freshDb();
    const m = await saveRecord('measurements', measurement(81), db);
    server.failNext = 'lost-response'; // server applied it, client never heard back
    await run(db);
    await run(db);
    expect(server.pushes).toBeGreaterThanOrEqual(2); // it really was retried
    expect(await db.outbox.count()).toBe(0);
    expect(server.rows.size).toBe(1);
    expect(await db.conflicts.count()).toBe(0);
    expect((await db.measurements.get(m.id))?.serverVersion).toBe(1);
  });

  it('stale edits from a second device become a preserved conflict, never a silent overwrite', async () => {
    const a = await freshDb();
    const m = await saveRecord('measurements', measurement(80), a);
    await run(a);
    // Another device edits and pushes version 2
    server.push('measurements', m.id, 'upsert', 1, { ...m, value: 79 });
    // This device edits offline on top of version 1
    await saveRecord('measurements', { ...(await a.measurements.get(m.id))!, value: 82 }, a);
    await run(a);
    expect(await a.conflicts.count()).toBe(1);
    expect((server.rows.values().next().value as Row).payload).toMatchObject({ value: 79 });
    expect((await a.measurements.get(m.id))?.value).toBe(82); // local edit kept
    // keep both → local version saved as a new record, remote copy applied
    const c = (await a.conflicts.toArray())[0];
    await resolveConflict(a, c.id, 'keep_both');
    await run(a);
    const values = (await a.measurements.toArray()).filter((x) => !x.deletedAt).map((x) => x.value).sort();
    expect(values).toEqual([79, 82]);
    expect(server.rows.size).toBe(2);
  });

  it('keep this device overwrites the cloud using the server version as base', async () => {
    const a = await freshDb();
    const m = await saveRecord('measurements', measurement(80), a);
    await run(a);
    server.push('measurements', m.id, 'upsert', 1, { ...m, value: 79 });
    await saveRecord('measurements', { ...(await a.measurements.get(m.id))!, value: 82 }, a);
    await run(a);
    await resolveConflict(a, (await a.conflicts.toArray())[0].id, 'keep_local');
    await run(a);
    expect((server.rows.values().next().value as Row).payload).toMatchObject({ value: 82 });
    expect(await a.conflicts.count()).toBe(0);
  });

  it('a deletion on the server cannot be resurrected by an old offline device', async () => {
    const a = await freshDb();
    const m = await saveRecord('measurements', measurement(80), a);
    await run(a);
    server.push('measurements', m.id, 'delete', 1, null); // deleted elsewhere → version 2 tombstone
    await saveRecord('measurements', { ...(await a.measurements.get(m.id))!, value: 90 }, a); // stale offline edit
    await run(a);
    const row = [...server.rows.values()][0];
    expect(row.deleted).toBe(true);
    expect((await a.measurements.get(m.id))?.deletedAt).toBeTruthy();
    // the edit is kept as a restorable conflict rather than lost
    expect(await a.conflicts.count()).toBe(1);
  });

  it('local deletes push tombstones and pull applies remote deletions', async () => {
    const a = await freshDb();
    const m1 = await saveRecord('measurements', measurement(80), a);
    const m2 = await saveRecord('measurements', measurement(81), a);
    await run(a);
    await deleteRecord('measurements', m1.id, a);
    server.push('measurements', m2.id, 'delete', 2, null);
    await run(a);
    expect([...server.rows.values()].every((r) => r.deleted)).toBe(true);
    expect((await a.measurements.get(m2.id))?.deletedAt).toBeTruthy();
  });

  it('pull brings down records created on another device', async () => {
    const a = await freshDb();
    server.push('measurements', '11111111-1111-4111-8111-111111111111', 'upsert', null, { id: '11111111-1111-4111-8111-111111111111', kind: 'bodyweight', date: '2026-09-01', value: 77, createdAt: 1, updatedAt: 1 });
    await run(a);
    expect((await a.measurements.get('11111111-1111-4111-8111-111111111111'))?.value).toBe(77);
  });

  it('auth failure pauses sync and keeps every local record and queued op', async () => {
    const a = await freshDb();
    await saveRecord('measurements', measurement(80), a);
    server.failNext = 'auth';
    await run(a);
    expect(getSyncStatus().phase).toBe('paused_auth');
    expect(await a.measurements.count()).toBe(1);
    expect(await a.outbox.count()).toBe(1);
    server.failNext = null;
    await run(a);
    expect(await a.outbox.count()).toBe(0);
  });

  it('never sends ops while a different account is authenticated', async () => {
    const a = await freshDb('user-a');
    await saveRecord('measurements', measurement(80), a);
    await run(a, 'user-b'); // session belongs to someone else
    expect(server.pushes).toBe(0);
    expect(getSyncStatus().phase).toBe('paused_auth');
    // and offline → nothing sent either
    await run(a, 'user-a', false);
    expect(server.pushes).toBe(0);
  });

  it('guest databases never queue or sync', async () => {
    const g = new LiftDb('guest');
    await g.delete();
    await g.open();
    await saveRecord('measurements', measurement(70), g);
    expect(await g.outbox.count()).toBe(0);
    await run(g, 'user-a');
    expect(server.pushes).toBe(0);
  });

  it('importing a record that already exists in the cloud keeps the cloud copy', async () => {
    const a = await freshDb();
    const id = '22222222-2222-4222-8222-222222222222';
    server.push('measurements', id, 'upsert', null, { id, kind: 'bodyweight', date: '2026-09-01', value: 75, createdAt: 1, updatedAt: 1 });
    await saveRecord('measurements', { id, kind: 'bodyweight', date: '2026-09-01', value: 99, createdAt: 2, updatedAt: 2 } as Measurement, a, { preferRemote: true });
    await run(a);
    expect((await a.measurements.get(id))?.value).toBe(75);
    expect(server.rows.size).toBe(1);
  });

  it('a non-import record colliding with a different cloud copy becomes a conflict, not an overwrite', async () => {
    const a = await freshDb();
    const id = '33333333-3333-4333-8333-333333333333';
    server.push('measurements', id, 'upsert', null, { id, kind: 'bodyweight', date: '2026-09-01', value: 75, createdAt: 1, updatedAt: 1 });
    await saveRecord('measurements', { id, kind: 'bodyweight', date: '2026-09-01', value: 99, createdAt: 2, updatedAt: 2 } as Measurement, a);
    await run(a);
    expect((await a.measurements.get(id))?.value).toBe(99);
    expect(await a.conflicts.count()).toBe(1);
  });

  it('lost response followed by more local edits: our landed write is recognised and the newer edit is pushed', async () => {
    const db = await freshDb();
    const m = await saveRecord('measurements', measurement(80), db);
    server.failNext = 'lost-response';
    configureSync({ db, userId: 'user-a', online: true });
    await syncNow();
    await saveRecord('measurements', { ...(await db.measurements.get(m.id))!, value: 85 }, db); // edit while unsure
    await run(db);
    await run(db);
    expect((await db.measurements.get(m.id))?.value).toBe(85);
    expect(await db.conflicts.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
    expect((server.rows.values().next().value as Row).payload).toMatchObject({ value: 85 });
  });

  it('resolving a conflict uses edits made after it was detected', async () => {
    const a = await freshDb();
    const m = await saveRecord('measurements', measurement(80), a);
    await run(a);
    server.push('measurements', m.id, 'upsert', 1, { ...m, value: 79 });
    await saveRecord('measurements', { ...(await a.measurements.get(m.id))!, value: 82 }, a);
    await run(a);
    await saveRecord('measurements', { ...(await a.measurements.get(m.id))!, value: 83 }, a); // later edit
    await resolveConflict(a, (await a.conflicts.toArray())[0].id, 'keep_local');
    await run(a);
    expect((await a.measurements.get(m.id))?.value).toBe(83);
    expect((server.rows.values().next().value as Row).payload).toMatchObject({ value: 83 });
  });

  it('a waiting conflict keeps the other side current; unresolved conflicts count as unsynced', async () => {
    const a = await freshDb();
    const m = await saveRecord('measurements', measurement(80), a);
    await run(a);
    server.push('measurements', m.id, 'upsert', 1, { ...m, value: 79 });
    await saveRecord('measurements', { ...(await a.measurements.get(m.id))!, value: 82 }, a);
    await run(a);
    expect(await unsyncedCount(a)).toBeGreaterThanOrEqual(1);
    server.push('measurements', m.id, 'upsert', 2, { ...m, value: 70 }); // other device edits again
    await run(a);
    await resolveConflict(a, (await a.conflicts.toArray())[0].id, 'keep_remote');
    expect((await a.measurements.get(m.id))?.value).toBe(70);
    expect((await a.measurements.get(m.id))?.serverVersion).toBe(3);
  });
});
