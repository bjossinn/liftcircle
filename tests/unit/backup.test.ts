import { describe, expect, it } from 'vitest';
import { LiftDb } from '@/db/db';
import { newRecord, saveRecord } from '@/db/repo';
import { applyImport, buildBackup, parseBackup, previewImport, workoutsCsv, toCsv } from '@/features/settings/backup';
import { importGuestData, previewGuestImport } from '@/features/auth/guestImport';
import type { Measurement, SyncFields, WorkoutSession } from '@/domain/types';
import { EXERCISES } from '@/data/exercises';
import { kgToLb } from '@/domain/units';

async function fresh(name: string) {
  const db = new LiftDb(name);
  await db.delete();
  await db.open();
  return db;
}
const weight = (v: number) => newRecord<Omit<Measurement, keyof SyncFields>>({ kind: 'bodyweight', date: '2026-10-01', value: v }) as Measurement;
function workout(): WorkoutSession {
  return {
    id: crypto.randomUUID(), createdAt: 1, updatedAt: 1, name: 'Upper', status: 'completed', date: '2026-10-02', timeZone: 'UTC', startedAt: 1, endedAt: 3_600_001, pausedTotalMs: 0,
    exercises: [{ id: 'e1', exerciseId: 'barbell-bench-press', order: 0, sets: [{ id: 'x', type: 'normal', weightKg: 20.41165665, entered: { value: 45, unit: 'lb' }, reps: 8, completed: true }] }],
  };
}

describe('backup export/import', () => {
  it('round-trips records without duplicating on repeated import', async () => {
    const src = await fresh('bk-src');
    await saveRecord('measurements', weight(80), src);
    await saveRecord('sessions', workout(), src);
    const text = JSON.stringify(await buildBackup(src));
    const backup = parseBackup(text);
    expect(backup.includesMedia).toBe(false);

    const dst = await fresh('bk-dst');
    const p1 = await previewImport(dst, backup);
    expect(p1.rows.find((r) => r.entity === 'sessions')).toMatchObject({ newCount: 1, existing: 0 });
    expect((await applyImport(dst, backup, ['measurements', 'sessions'])).written).toBe(2);
    // second import: nothing new
    const p2 = await previewImport(dst, backup);
    expect(p2.rows.every((r) => r.newCount === 0)).toBe(true);
    expect((await applyImport(dst, backup, ['measurements', 'sessions'])).written).toBe(0);
    expect(await dst.sessions.count()).toBe(1);
    // entered values survive exactly (45 lb stays 45 lb)
    const s = (await dst.sessions.toArray())[0];
    expect(s.exercises[0].sets[0].entered).toEqual({ value: 45, unit: 'lb' });
    expect(kgToLb(s.exercises[0].sets[0].weightKg!)).toBeCloseTo(45, 6);
  });

  it('rejects files that are not backups or from a newer version', () => {
    expect(() => parseBackup('nope')).toThrow(/valid JSON/);
    expect(() => parseBackup('{"a":1}')).toThrow(/Hard Earned backup/);
    expect(() => parseBackup(JSON.stringify({ format: 'liftcircle-backup', version: 99, exportedAt: 'x', records: {} }))).toThrow(/newer version/);
  });

  it('CSV escapes values and exports one row per set', () => {
    expect(toCsv(['a'], [['x,"y"']])).toBe('a\r\n"x,""y"""');
    const csv = workoutsCsv([workout()], new Map(EXERCISES.map((e) => [e.id, e])));
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('Barbell bench press');
    expect(lines[1]).toContain('45 lb');
  });
});

describe('guest import', () => {
  it('previews, imports into the signed-in account and never duplicates', async () => {
    const guest = await fresh('guest');
    await saveRecord('measurements', weight(70), guest);
    await saveRecord('sessions', workout(), guest);
    guest.close();
    const acct = await fresh('00000000-aaaa-4aaa-8aaa-000000000001');
    const rows = await previewGuestImport(acct);
    expect(rows.find((r) => r.entity === 'sessions')?.toImport).toBe(1);
    expect(await importGuestData(acct, acct.accountKey, ['sessions', 'measurements'])).toBe(2);
    expect(await importGuestData(acct, acct.accountKey, ['sessions', 'measurements'])).toBe(0);
    expect(await acct.outbox.count()).toBe(2); // queued for the account's sync
  });

  it('refuses to import into a database that is not the authenticated account', async () => {
    const acct = await fresh('00000000-aaaa-4aaa-8aaa-000000000002');
    await expect(importGuestData(acct, 'someone-else', ['sessions'])).rejects.toThrow();
  });
});
