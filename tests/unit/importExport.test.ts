import { describe, expect, it } from 'vitest';
import { LiftDb } from '@/db/db';
import { newRecord, saveRecord } from '@/db/repo';
import { applyImport, buildBackup, csvCell, describePlan, parseBackup, previewImport, activitiesCsv, measurementsCsv, toCsv, workoutsCsv } from '@/features/settings/backup';
import { BACKUP_VERSION, BackupValidationError } from '@/features/settings/backupSchema';
import { defaultAccountState } from '@/state/defaults';
import { EXERCISES } from '@/data/exercises';
import type { ActivityLog, Measurement, Program, SyncFields, WorkoutSession } from '@/domain/types';

const ACCT = '00000000-bbbb-4bbb-8bbb-0000000000';
let n = 0;
async function fresh(guest = false) {
  const db = new LiftDb(guest ? 'guest' : `${ACCT}${String(++n).padStart(2, '0')}`);
  await db.delete();
  await db.open();
  return db;
}
const env = (records: object, extra: object = {}) => JSON.stringify({ format: 'liftcircle-backup', version: 1, exportedAt: '2026-10-28T10:00:00.000Z', records, ...extra });
const weight = (id: string, v: number) => ({ id, createdAt: 1, updatedAt: 1, kind: 'bodyweight', date: '2026-10-01', value: v }) as Measurement;
function workout(id: string = crypto.randomUUID(), sets: Partial<WorkoutSession['exercises'][0]['sets'][0]>[] = [{ weightKg: 60, reps: 8, completed: true }]): WorkoutSession {
  return {
    id, createdAt: 1, updatedAt: 1, name: 'Upper', status: 'completed', date: '2026-10-02', timeZone: 'UTC', startedAt: 1, endedAt: 3_600_001, pausedTotalMs: 0,
    exercises: [{ id: 'e1', exerciseId: 'barbell-bench-press', order: 0, sets: sets.map((s, i) => ({ id: `s${i}`, type: 'normal', completed: false, ...s })) }],
  };
}
function program(id: string, active = true): Program {
  const t = { id: 't1', name: 'A', focus: 'Full body', kind: 'lifting' as const, estimatedMinutes: 45, exercises: [{ id: 'p1', exerciseId: 'goblet-squat', sets: 3, repMin: 8, repMax: 12, targetRir: 2, restSec: 90, warmup: '', priority: 1 as const, alternatives: [] }] };
  return {
    id, createdAt: 1, updatedAt: 1, name: 'Plan', source: 'manual', startDate: '2026-10-01', active, currentVersion: 1, rotationIndex: 0, overrides: [],
    versions: [{ version: 1, createdAt: 1, reason: 'x', templates: [t], schedule: [{ weekday: 1, templateId: 't1' }], weeks: 6, reviewWeek: 4, rationale: [], warnings: [] }],
  };
}
const fails = (text: string, re: RegExp) => {
  let err: unknown;
  try {
    parseBackup(text);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(BackupValidationError);
  expect((err as Error).message).toMatch(re);
};

describe('backup validation (before anything is written)', () => {
  it('rejects malformed JSON, truncated files and non-backups with clear messages', () => {
    fails('not json at all', /isn’t valid JSON/);
    fails('', /empty/);
    const good = env({ measurements: [weight('m1', 80)] });
    fails(good.slice(0, good.length - 20), /incomplete/);
    fails('{"a":1}', /doesn’t look like a Hard Earned backup/);
  });

  it('rejects newer backup versions and invalid envelopes', () => {
    fails(env({}, { version: BACKUP_VERSION + 1 }), /newer version of the app.*Update the app/s);
    fails(env({}, { version: 0 }), /damaged or incomplete/);
    fails(env({}, { version: 1.5 }), /damaged or incomplete/);
  });

  it('rejects broken nested fields, non-finite numbers and bad ids', () => {
    fails(env({ sessions: [{ ...workout('w1'), exercises: 'nope' }] }), /sessions record 1.*exercises/);
    const s = workout('w2');
    (s.exercises[0].sets[0] as unknown as { reps: string }).reps = 'eight';
    fails(env({ sessions: [s] }), /sessions record 1/);
    fails('{"format":"liftcircle-backup","version":1,"exportedAt":"x","records":{"measurements":[{"id":"m","kind":"bodyweight","date":"2026-01-01","value":1e999}]}}', /measurements record 1/);
    fails(env({ measurements: [{ ...weight('', 80) }] }), /missing id/);
    fails(env({ measurements: [{ ...weight('m', 80), date: '1 Oct' }] }), /YYYY-MM-DD/);
    fails(env({ account_state: [{ ...defaultAccountState(), id: 'someone-else' }] }), /account_state/);
  });

  it('rejects duplicate ids inside the file (top level and nested)', () => {
    fails(env({ measurements: [weight('d', 80), weight('d', 81)] }), /id d appears more than once/);
    const s = workout('w', [{ reps: 5, completed: true }, { reps: 5, completed: true }]);
    s.exercises[0].sets[1].id = s.exercises[0].sets[0].id;
    fails(env({ sessions: [s] }), /duplicate set id/);
  });

  it('rejects broken references inside a program', () => {
    const p = program('p');
    p.versions[0].schedule = [{ weekday: 1, templateId: 'missing' }];
    fails(env({ programs: [p] }), /unknown session template missing/);
    fails(env({ programs: [{ ...program('q'), currentVersion: 3 }] }), /current version 3 is missing/);
  });

  it('enforces size limits', () => {
    const many = Array.from({ length: 50_001 }, (_, i) => ({ id: `m${i}` }));
    fails(env({ measurements: many }), /more than this app can import/);
  });

  it('keeps unknown fields (no data loss on round trip) and lists unknown record types', () => {
    const b = parseBackup(env({ measurements: [{ ...weight('m', 80), futureField: { x: 1 } }], wearables: [{ id: 'w' }] }));
    expect((b.records.measurements![0] as Record<string, unknown>).futureField).toEqual({ x: 1 });
    expect(b.unknownEntities).toEqual(['wearables']);
  });

  it('drops __proto__ keys instead of touching prototypes', () => {
    const b = parseBackup('{"format":"liftcircle-backup","version":1,"exportedAt":"x","records":{"measurements":[{"id":"m","kind":"bodyweight","date":"2026-01-01","value":80,"__proto__":{"polluted":true}}]}}');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(b.records.measurements![0], '__proto__')).toBe(false);
  });
});

describe('import preview and merge rules', () => {
  it('previews new / identical / different / deleted-here records and keeps this device’s by default', async () => {
    const db = await fresh();
    await saveRecord('measurements', weight('same', 80), db);
    await saveRecord('measurements', weight('changed', 70), db);
    await saveRecord('measurements', weight('gone', 60), db);
    await db.measurements.update('gone', { deletedAt: 5 });
    const backup = parseBackup(env({ measurements: [weight('same', 80), weight('changed', 75), weight('gone', 60), weight('new', 90)] }));
    const p = await previewImport(db, backup);
    expect(p.rows[0]).toMatchObject({ entity: 'measurements', total: 4, newCount: 1, existing: 2, identical: 1, differs: 1, deletedHere: 1 });
    expect(describePlan(p, { entities: ['measurements'] })).toEqual({ add: 1, replace: 0, keep: 1 });

    const r = await applyImport(db, backup, { entities: ['measurements'] });
    expect(r).toMatchObject({ added: 1, replaced: 0, written: 1 });
    expect((await db.measurements.get('changed'))!.value).toBe(70); // kept
    expect((await db.measurements.get('gone'))!.deletedAt).toBe(5); // never resurrected
  });

  it('"use the backup’s" replaces differing records as ordinary synced edits', async () => {
    const db = await fresh();
    await saveRecord('measurements', weight('changed', 70), db);
    await db.measurements.update('changed', { serverVersion: 7 });
    await db.outbox.clear();
    const backup = parseBackup(env({ measurements: [weight('changed', 75)] }));
    const r = await applyImport(db, backup, { entities: ['measurements'], existing: 'replace' });
    expect(r.replaced).toBe(1);
    const rec = (await db.measurements.get('changed'))!;
    expect(rec.value).toBe(75);
    expect(rec.serverVersion).toBe(7); // keeps the sync base → compare-and-swap, not "prefer cloud"
    const ops = await db.outbox.toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ entity: 'measurements', recordId: 'changed', op: 'upsert' });
    expect(ops[0].preferRemote).toBeFalsy();
  });

  it('added records are queued for sync with preferRemote (existing cloud copies win)', async () => {
    const db = await fresh();
    await applyImport(db, parseBackup(env({ measurements: [weight('a', 1), weight('b', 2)] })), ['measurements']);
    const ops = await db.outbox.toArray();
    expect(ops.map((o) => o.recordId).sort()).toEqual(['a', 'b']);
    expect(ops.every((o) => o.preferRemote && o.accountId === db.accountKey)).toBe(true);
  });

  it('settings & targets: explicit keep/replace per part instead of a silent skip', async () => {
    const db = await fresh();
    const local = defaultAccountState();
    local.profile.displayName = 'Device';
    await saveRecord('account_state', local, db);
    const fromBackup = defaultAccountState();
    fromBackup.profile.displayName = 'Backup';
    fromBackup.settings.units.weight = 'lb';
    fromBackup.nutrition = { ...fromBackup.nutrition, mode: 'protein_only', proteinG: 150, updatedAt: 1 };
    const backup = parseBackup(env({ account_state: [fromBackup] }));
    const p = await previewImport(db, backup);
    expect(p.singleton).toEqual({ onDevice: true, differs: { settings: true, profile: true, nutrition: true, favorites: false } });

    // Default (nothing chosen) keeps everything.
    expect((await applyImport(db, backup, { entities: ['account_state'] })).written).toBe(0);
    // Choose: replace settings + nutrition, keep profile.
    const r = await applyImport(db, backup, { entities: ['account_state'], singleton: { settings: 'replace', nutrition: 'replace' } });
    expect(r.replaced).toBe(1);
    const a = (await db.account.get('account'))!;
    expect(a.settings.units.weight).toBe('lb');
    expect(a.nutrition.proteinG).toBe(150);
    expect(a.profile.displayName).toBe('Device');
  });

  it('settings are added whole when the device has none', async () => {
    const db = await fresh();
    const backup = parseBackup(env({ account_state: [{ ...defaultAccountState(), profile: { ...defaultAccountState().profile, displayName: 'B' } }] }));
    const p = await previewImport(db, backup);
    expect(p.singleton?.onDevice).toBe(false);
    expect((await applyImport(db, backup, ['account_state'])).added).toBe(1);
    expect((await db.account.get('account'))!.profile.displayName).toBe('B');
  });

  it('keeps one active program and one in-progress workout', async () => {
    const db = await fresh();
    await saveRecord('programs', program('local-active'), db);
    await saveRecord('sessions', { ...workout('local-live'), status: 'active' }, db);
    const backup = parseBackup(env({ programs: [program('backup-active')], sessions: [{ ...workout('backup-live'), status: 'active' }, workout('done')] }));
    const p = await previewImport(db, backup);
    expect(p.rows.find((r) => r.entity === 'programs')!.notes.join()).toMatch(/inactive/);
    expect(p.rows.find((r) => r.entity === 'sessions')!.notes.join()).toMatch(/in progress/);
    await applyImport(db, backup, ['programs', 'sessions']);
    expect((await db.programs.toArray()).filter((x) => x.active).map((x) => x.id)).toEqual(['local-active']);
    expect(await db.sessions.get('backup-live')).toBeUndefined();
    expect(await db.sessions.get('done')).toBeDefined();
  });

  it('reports cross-record references that do not resolve, without blocking', async () => {
    const db = await fresh();
    const s = workout('w');
    s.exercises[0].exerciseId = 'deleted-custom-thing';
    s.programId = 'old-program';
    const p = await previewImport(db, parseBackup(env({ sessions: [s] })));
    expect(p.warnings.join(' ')).toMatch(/1 exercise isn’t in this app/);
    expect(p.warnings.join(' ')).toMatch(/program that isn’t in the backup/);
  });

  it('invalid completed sets are imported as not completed with values blanked (setValidation rule)', async () => {
    const db = await fresh();
    const s = workout('w', [
      { weightKg: 60, reps: 8, completed: true }, // valid
      { weightKg: 60, reps: 0, completed: true }, // completed with 0 reps → not completed
      { weightKg: -20, reps: 5, completed: true }, // negative load → load "not recorded", still a done set
    ]);
    const backup = parseBackup(env({ sessions: [s] }));
    const p = await previewImport(db, backup);
    expect(p.repaired).toEqual({ sessions: 1, sets: 2 });
    await applyImport(db, backup, ['sessions']);
    const sets = (await db.sessions.get('w'))!.exercises[0].sets;
    expect(sets[0]).toMatchObject({ weightKg: 60, reps: 8, completed: true });
    expect(sets[1].completed).toBe(false);
    expect(sets[2]).toMatchObject({ weightKg: null, reps: 5, completed: true });
  });
});

describe('atomic import', () => {
  it('a failure in the middle of the write leaves existing data and the sync queue untouched', async () => {
    const db = await fresh();
    await saveRecord('measurements', weight('existing', 70), db);
    const outboxBefore = await db.outbox.toArray();
    const backup = parseBackup(env({ measurements: [weight('existing', 75), weight('m1', 1), weight('m2', 2), weight('m3', 3)], sessions: [workout('w1')] }));
    db.measurements.hook('creating', (_k, obj) => {
      if ((obj as { id: string }).id === 'm2') throw new Error('injected disk failure');
    });
    await expect(applyImport(db, backup, { entities: ['sessions', 'measurements'], existing: 'replace' })).rejects.toThrow(/Could not save/);
    expect((await db.measurements.toArray()).map((m) => [m.id, m.value])).toEqual([['existing', 70]]);
    expect(await db.sessions.count()).toBe(0);
    expect(await db.outbox.toArray()).toEqual(outboxBefore);
  });

  it('applyImport re-validates objects that did not come from parseBackup', async () => {
    const db = await fresh();
    const bogus = { format: 'liftcircle-backup', version: 1, exportedAt: 'x', records: { sessions: [{ id: 'x' }] } };
    await expect(applyImport(db, bogus as never, ['sessions'])).rejects.toBeInstanceOf(BackupValidationError);
    expect(await db.sessions.count()).toBe(0);
  });

  it('a full round trip into an existing account adds only what is missing', async () => {
    const src = await fresh();
    await saveRecord('measurements', newRecord<Omit<Measurement, keyof SyncFields>>({ kind: 'bodyweight', date: '2026-10-01', value: 80 }) as Measurement, src);
    await saveRecord('programs', program('p1'), src);
    await saveRecord('sessions', workout('w1'), src);
    const backup = parseBackup(JSON.stringify(await buildBackup(src)));
    const dst = await fresh();
    await saveRecord('sessions', workout('w1'), dst);
    const p = await previewImport(dst, backup);
    expect(p.rows.find((r) => r.entity === 'sessions')).toMatchObject({ newCount: 0, identical: 1 });
    const r = await applyImport(dst, backup, ['measurements', 'programs', 'sessions']);
    expect(r).toMatchObject({ added: 2, replaced: 0 });
    expect(await dst.sessions.count()).toBe(1);
  });

  it('guest database: import writes records but queues nothing', async () => {
    const db = await fresh(true);
    await applyImport(db, parseBackup(env({ measurements: [weight('a', 1)] })), ['measurements']);
    expect(await db.measurements.count()).toBe(1);
    expect(await db.outbox.count()).toBe(0);
  });
});

describe('CSV export', () => {
  it('neutralizes formula-leading text but keeps numbers numeric', () => {
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-easy')).toBe("'-easy");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\tcmd')).toBe("'\tcmd");
    expect(csvCell('\r=1')).toBe(`"'\r=1"`);
    expect(csvCell('Bench')).toBe('Bench');
    expect(csvCell(-12.5)).toBe('-12.5');
    expect(csvCell(0)).toBe('0');
    expect(csvCell(Number.NaN)).toBe('');
    expect(toCsv(['a', 'b'], [['=1', 2]])).toBe("a,b\r\n'=1,2");
  });

  it('applies to user text in workouts, activities and measurements exports', () => {
    const byId = new Map(EXERCISES.map((e) => [e.id, e]));
    const s = { ...workout('w'), name: '=cmd|"/c calc"!A1' };
    const wl = workoutsCsv([s], byId).split('\r\n')[1];
    expect(wl).toContain(`"'=cmd|""/c calc""!A1"`);
    expect(wl).toMatch(/,60,/); // weight stays a plain number
    const a = { id: 'a', createdAt: 1, updatedAt: 1, type: 'run', date: '2026-10-01', timeZone: 'UTC', durationSec: 1800, elevationM: -12, notes: '@evil', customName: '+name' } as ActivityLog;
    const al = activitiesCsv([a]).split('\r\n')[1];
    expect(al).toContain("'+name");
    expect(al).toContain("'@evil");
    expect(al).toContain(',-12,'); // negative numbers in numeric columns are untouched
    expect(measurementsCsv([{ ...weight('m', 80), note: '-note' }]).split('\r\n')[1]).toBe("2026-10-01,bodyweight,80,kg,,'-note");
  });
});
