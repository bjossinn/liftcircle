/**
 * Local database upgrades are safe for people mid-workout: a database written by the previous app version
 * (schema v1) opens under the current schema with every record and queued sync op intact, no table is ever
 * dropped, and a rollback to older code can still open a database a newer version already upgraded.
 */
import { describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { LiftDb, dbNameFor } from '@/db/db';

/** Schema v1 exactly as shipped in 0.1.x (src/db/db.ts history). */
const V1 = {
  account: 'id',
  programs: 'id, active, updatedAt',
  templates: 'id, updatedAt',
  sessions: 'id, date, status, startedAt, updatedAt',
  activities: 'id, date, type, updatedAt',
  activityTemplates: 'id',
  measurements: 'id, kind, date, [kind+date]',
  goals: 'id',
  customExercises: 'id',
  customFoods: 'id, name',
  foodLogs: 'id, date, meal',
  savedMeals: 'id',
  mealPlans: 'id, weekStart',
  outbox: '++seq, accountId, [entity+recordId], status',
  conflicts: 'id, entity',
  pendingPosts: 'id, status',
  kv: 'key',
};

const activeSession = {
  id: 'sess-1', date: '2026-10-29', status: 'active', name: 'Push', startedAt: Date.now() - 600_000, pausedTotalMs: 0,
  updatedAt: Date.now(), createdAt: Date.now(), exercises: [{ id: 'e1', exerciseId: 'bench', sets: [{ id: 's1', done: true, kg: 60, reps: 8 }] }],
  rest: { endsAt: Date.now() + 90_000 },
};

describe('Dexie schema upgrades', () => {
  it('a v1 database (active workout + queued ops) opens under the current schema unchanged', async () => {
    const key = 'upgrade-user';
    await Dexie.delete(dbNameFor(key));
    const old = new Dexie(dbNameFor(key));
    old.version(1).stores(V1);
    await old.open();
    await old.table('sessions').put(activeSession);
    await old.table('outbox').add({ accountId: key, entity: 'sessions', recordId: 'sess-1', op: 'upsert', queuedAt: 1, attempts: 0, status: 'pending' });
    await old.table('kv').put({ key: 'sync-cursor', value: 42 });
    old.close();

    const db = new LiftDb(key);
    await db.open();
    expect(db.verno).toBeGreaterThanOrEqual(2);
    expect(await db.sessions.get('sess-1')).toEqual(activeSession);
    expect(await db.sessions.where('status').equals('active').count()).toBe(1);
    expect(await db.outbox.count()).toBe(1);
    expect((await db.outbox.toArray())[0]).toMatchObject({ accountId: key, recordId: 'sess-1', status: 'pending' });
    expect(await db.kv.get('sync-cursor')).toEqual({ key: 'sync-cursor', value: 42 });
    // tables added later are usable right away
    await db.coachOutbox.put({ id: 'm1', accountId: key, relationshipId: 'r', body: 'hi', status: 'queued', attempts: 0, createdAt: 1 });
    expect(await db.coachOutbox.count()).toBe(1);
    db.close();
    await Dexie.delete(dbNameFor(key));
  });

  it('the current schema keeps every v1 table and index (no destructive migration)', async () => {
    const db = new LiftDb('schema-check');
    await db.open();
    for (const [table, spec] of Object.entries(V1)) {
      const t = db.tables.find((x) => x.name === table);
      expect(t, `table ${table}`).toBeTruthy();
      for (const idx of spec.split(',').slice(1).map((s) => s.trim().replace(/^\[|\]$/g, '').replace('+', '+'))) {
        const names = t!.schema.indexes.map((i) => (Array.isArray(i.keyPath) ? i.keyPath.join('+') : i.keyPath));
        expect(names, `${table} index ${idx}`).toContain(idx);
      }
    }
    db.close();
    await db.delete();
  });

  it('older code can still open a database that a newer version upgraded (rollback / stale tab)', async () => {
    const key = 'rollback-user';
    await Dexie.delete(dbNameFor(key));
    const current = new LiftDb(key);
    await current.open();
    await current.sessions.put(activeSession as never);
    const verno = current.verno;
    current.close();
    // a future release adds a table at a higher version
    const future = new LiftDb(key);
    future.version(verno + 1).stores({ futureThing: 'id' });
    await future.open();
    future.close();
    // the current (older) code opens it and still reads the workout
    const again = new LiftDb(key);
    await again.open();
    expect(await again.sessions.get('sess-1')).toBeTruthy();
    again.close();
    await Dexie.delete(dbNameFor(key));
  });
});
