/**
 * Offline/expired-session logging guarantees at the data layer (complements tests/unit/sync.test.ts):
 * while the session is expired or the device is offline, a workout can be started, edited many times,
 * finished and deleted locally; nothing is sent, the outbox holds exactly one op per record (idempotent),
 * and everything is pushed once a valid session for THIS account returns.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncedEntity } from '@/db/db';

const remote = vi.hoisted(() => ({ pushes: [] as { entity: string; id: string; op: string }[], pulls: 0, version: 0 }));
vi.mock('@/backend/syncRemote', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/backend/syncRemote')>();
  return {
    ...orig,
    syncRemote: {
      push: async (entity: SyncedEntity, id: string, op: 'upsert' | 'delete') => {
        remote.pushes.push({ entity, id, op });
        return { status: 'ok', version: ++remote.version };
      },
      pull: async (since: number) => {
        remote.pulls++;
        return { changes: [], cursor: since, hasMore: false };
      },
    },
  };
});

import { LiftDb } from '@/db/db';
import { deleteRecord, newRecord, saveRecord } from '@/db/repo';
import { configureSync, getSyncStatus, syncNow } from '@/sync/engine';
import type { WorkoutSession } from '@/domain/types';

const workout = () =>
  newRecord({ date: '2026-10-29', status: 'active', name: 'Push', startedAt: Date.now(), pausedTotalMs: 0, exercises: [] }) as unknown as WorkoutSession;

async function fresh(key = 'user-a') {
  const db = new LiftDb(key);
  await db.delete();
  await db.open();
  return db;
}

beforeEach(() => {
  remote.pushes = [];
  remote.pulls = 0;
});

describe('logging while sync is paused', () => {
  it('expired session: the whole workout is logged locally, one queued op per record, nothing sent; resumes on sign-in', async () => {
    const db = await fresh();
    configureSync({ db, userId: null, online: true }); // session expired: AppProvider passes no valid user
    expect(getSyncStatus().phase).toBe('paused_auth');
    let s = await saveRecord('sessions', workout(), db);
    for (let i = 1; i <= 5; i++) s = await saveRecord('sessions', { ...s, name: `Push ${i}` }, db); // repeated edits
    s = await saveRecord('sessions', { ...s, status: 'completed', finishedAt: Date.now() } as WorkoutSession, db);
    const extra = await saveRecord('sessions', workout(), db);
    await deleteRecord('sessions', extra.id, db); // started by mistake, then deleted
    await syncNow();
    expect(remote.pushes).toHaveLength(0);
    expect((await db.sessions.get(s.id))?.status).toBe('completed');
    expect((await db.sessions.get(s.id))?.name).toBe('Push 5');
    const ops = await db.outbox.toArray();
    expect(ops).toHaveLength(2); // coalesced: one per record
    expect(ops.find((o) => o.recordId === s.id)).toMatchObject({ op: 'upsert', accountId: 'user-a', status: 'pending' });
    expect(ops.find((o) => o.recordId === extra.id)).toMatchObject({ op: 'delete' }); // tombstone queued, not dropped

    // a different account signing in must not flush these ops
    configureSync({ db, userId: 'user-b', online: true });
    await syncNow();
    expect(remote.pushes).toHaveLength(0);

    // the same account signs in again → everything goes up once
    configureSync({ db, userId: 'user-a', online: true });
    await syncNow();
    expect(remote.pushes.map((p) => `${p.op}:${p.id === s.id ? 'finished' : 'deleted'}`).sort()).toEqual(['delete:deleted', 'upsert:finished']);
    expect(await db.outbox.count()).toBe(0);
    await syncNow(); // idempotent: nothing left to send
    expect(remote.pushes).toHaveLength(2);
    db.close();
  });

  it('offline: logging works and queues; reconnecting sends it', async () => {
    const db = await fresh('user-c');
    configureSync({ db, userId: 'user-c', online: false });
    expect(getSyncStatus().phase).toBe('offline');
    const s = await saveRecord('sessions', workout(), db);
    await syncNow();
    expect(remote.pushes).toHaveLength(0);
    expect(await db.outbox.count()).toBe(1);
    configureSync({ db, userId: 'user-c', online: true });
    await syncNow();
    expect(remote.pushes).toEqual([{ entity: 'sessions', id: s.id, op: 'upsert' }]);
    db.close();
  });
});
