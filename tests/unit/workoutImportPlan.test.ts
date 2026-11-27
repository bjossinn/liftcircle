/**
 * CSV workout import: the preview plan, unit and time-zone handling, idempotent re-import (stable per-workout hash),
 * custom exercises for unmatched names, and the single-transaction write (sync queue, no side effects).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LiftDb } from '@/db/db';
import { alive, deleteRecord } from '@/db/repo';
import { EXERCISES } from '@/data/exercises';
import { parseWorkoutCsv } from '@/features/import/parse';
import { applyWorkoutImport, buildImportPlan, importKey, planWorkoutImport, uuidFromHex, workoutHashId } from '@/features/import/plan';
import { isCountableSet } from '@/domain/setValidation';
import type { Exercise } from '@/domain/types';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/import/${name}`, import.meta.url), 'utf8');
const ACCT = '00000000-cccc-4ccc-8ccc-0000000000';
let n = 0;
async function fresh(guest = false) {
  const db = new LiftDb(guest ? 'guest' : `${ACCT}${String(++n).padStart(2, '0')}`);
  await db.delete();
  await db.open();
  return db;
}
async function library(db: LiftDb): Promise<Exercise[]> {
  return [...EXERCISES, ...alive(await db.customExercises.toArray())];
}
const UTC = { timeZone: 'UTC', weightUnit: 'kg' as const };
const EMPTY = { sessionIds: new Set<string>(), importKeys: new Set<string>(), customIds: new Set<string>() };

describe('preview plan', () => {
  it('summarises a Strong file: workouts, sets, date range, matched vs new exercises', async () => {
    const plan = await buildImportPlan(parseWorkoutCsv(fixture('strong.csv')), EXERCISES, EMPTY, UTC);
    expect(plan).toMatchObject({ source: 'strong', workoutsFound: 2, newWorkouts: 2, alreadyImported: 0, from: '2024-01-15', to: '2024-01-17', unitNeeded: true, skippedRows: 2 });
    expect(plan.setsFound).toBe(18);
    expect(plan.newSets).toBe(18);
    expect(plan.warmupSets).toBe(2);
    expect(plan.matched.map((l) => [l.name, l.exerciseId])).toEqual([
      ['Bench Press (Barbell)', 'barbell-bench-press'],
      ['Bicep Curl (Barbell)', 'barbell-curl'],
      ['Deadlift (Barbell)', 'conventional-deadlift'],
      ['Overhead Press (Barbell)', 'overhead-press'],
      ['Plank', 'plank'],
      ['Pull Up', 'pull-up'],
      ['Pull Up (Assisted)', 'assisted-pull-up'],
      ['Triceps Pushdown (Cable - Straight Bar)', 'triceps-pushdown'],
    ]);
    expect(plan.matched.find((l) => l.name === 'Bench Press (Barbell)')!.sets).toBe(4);
    expect(plan.created.map((l) => [l.name, l.sets])).toEqual([
      ['Landmine Press', 1],
      ['Running', 1],
    ]);
    expect(plan.customExercises.map((c) => [c.name, c.tracking])).toEqual([
      ['Landmine Press', 'weight_reps'],
      ['Running', 'distance_time'],
    ]);
  });

  it('builds ordinary completed sessions: times in the account zone, kg, warm-ups, notes and duration', async () => {
    const plan = await buildImportPlan(parseWorkoutCsv(fixture('strong.csv')), EXERCISES, EMPTY, { timeZone: 'Atlantic/Reykjavik', weightUnit: 'kg', now: 1_700_000_000_000 });
    const push = plan.sessions[0];
    expect(push).toMatchObject({ name: 'Push Day', status: 'completed', date: '2024-01-15', timeZone: 'Atlantic/Reykjavik', pausedTotalMs: 0, notes: 'Good session, slept well' });
    expect(push.startedAt).toBe(Date.UTC(2024, 0, 15, 7, 45, 12));
    expect(push.endedAt).toBe(push.startedAt + 3900 * 1000);
    expect(push.imported).toEqual({ source: 'strong', key: 'strong|2024-01-15T07:45:12', importedAt: 1_700_000_000_000 });
    expect(push.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const bench = push.exercises[0];
    expect(bench.exerciseId).toBe('barbell-bench-press');
    expect(bench.notes).toBe('Paused reps, "touch and go" last set');
    expect(bench.sets.map((s) => [s.type, s.weightKg, s.entered, s.reps, s.rpe, s.completed])).toEqual([
      ['warmup', 40, { value: 40, unit: 'kg' }, 10, null, true],
      ['normal', 80, { value: 80, unit: 'kg' }, 8, 8, true],
      ['normal', 80, { value: 80, unit: 'kg' }, 7, 8.5, true],
      ['normal', 80, { value: 80, unit: 'kg' }, 6, 9, true],
    ]);
    const byId = new Map(EXERCISES.map((e) => [e.id, e]));
    // Warm-ups never count as working sets; the others do.
    expect(bench.sets.map((s) => isCountableSet(s, byId.get('barbell-bench-press')!))).toEqual([false, true, true, true]);
    const plank = push.exercises.find((e) => e.exerciseId === 'plank')!;
    expect(plank.sets[0]).toMatchObject({ durationSec: 60, weightKg: null, reps: null, completed: true });
    const pull = plan.sessions[1];
    expect(pull.exercises.find((e) => e.exerciseId === 'pull-up')!.sets[0]).toMatchObject({ reps: 10, weightKg: null });
    const run = pull.exercises.find((e) => plan.customExercises.some((c) => c.id === e.exerciseId && c.name === 'Running'))!;
    expect(run.sets[0]).toMatchObject({ distanceM: 2500, durationSec: 900 }); // km (the weight unit is kg)
  });

  it('converts pounds (chosen in the preview, or stated by the file) and keeps the entered value', async () => {
    const strong = parseWorkoutCsv(fixture('strong.csv'));
    const lb = await buildImportPlan(strong, EXERCISES, EMPTY, { timeZone: 'UTC', weightUnit: 'lb' });
    const s = lb.sessions[0].exercises[0].sets[1];
    expect(s.entered).toEqual({ value: 80, unit: 'lb' });
    expect(s.weightKg).toBeCloseTo(36.287, 3);
    // Distance follows the weight unit when the file doesn't say: miles.
    expect(lb.sessions[1].exercises.at(-1)!.sets[0].distanceM).toBeCloseTo(4023.4, 1);

    const hevy = await buildImportPlan(parseWorkoutCsv(fixture('hevy-lbs.csv')), EXERCISES, EMPTY, UTC); // file says lb
    expect(hevy.unitNeeded).toBe(false);
    const incline = hevy.sessions[0].exercises[0];
    expect(incline.exerciseId).toBe('incline-dumbbell-press');
    expect(incline.sets[0].entered).toEqual({ value: 60, unit: 'lb' });
    expect(incline.sets[0].weightKg).toBeCloseTo(27.216, 3);
    expect(hevy.sessions[0].exercises[1].sets[0].distanceM).toBeCloseTo(2414, 0);
    expect(hevy.sessions[0].startedAt).toBe(Date.UTC(2024, 1, 3, 18, 15));
    expect(hevy.sessions[0].endedAt).toBe(Date.UTC(2024, 1, 3, 19, 20));
  });

  it('maps Hevy warm-up, drop and failure sets, supersets and the European Strong variant', async () => {
    const hevy = await buildImportPlan(parseWorkoutCsv(fixture('hevy.csv')), EXERCISES, EMPTY, UTC);
    expect(hevy).toMatchObject({ newWorkouts: 2, warmupSets: 2, unitNeeded: false, from: '2024-01-15', to: '2024-01-17' });
    const upper = hevy.sessions[0];
    expect(upper.exercises[0].sets.map((s) => s.type)).toEqual(['warmup', 'normal', 'normal']);
    expect(upper.exercises[1].supersetGroup).toBe('0');
    expect(upper.exercises[2].sets.map((s) => s.type)).toEqual(['normal', 'drop']);
    expect(hevy.created.map((l) => l.name)).toEqual(['Cable Crunch', 'Treadmill']);

    const eu = await buildImportPlan(parseWorkoutCsv(fixture('strong-eu.csv')), EXERCISES, EMPTY, UTC);
    expect(eu.unitNeeded).toBe(false);
    expect(eu.sessions[0].exercises[0].sets[1]).toMatchObject({ weightKg: 102.5, reps: 5, rpe: 8.5 });
    expect(eu.sessions[0].exercises[2]).toMatchObject({ exerciseId: 'rowing-machine' });
    expect(eu.sessions[0].exercises[2].sets[0]).toMatchObject({ distanceM: 2000, durationSec: 480 });
    expect(eu.created).toEqual([]);
  });

  it('repairs impossible values so they never count as work', async () => {
    const csv = 'Date,Workout Name,Exercise Name,Set Order,Weight,Reps\n2024-01-01 10:00:00,A,Bench Press (Barbell),1,60,7.5\n2024-01-01 10:00:00,A,Bench Press (Barbell),2,-5,5';
    const plan = await buildImportPlan(parseWorkoutCsv(csv), EXERCISES, EMPTY, UTC);
    expect(plan.repairedSets).toBe(2);
    const sets = plan.sessions[0].exercises[0].sets;
    expect(sets[0].completed).toBe(false); // fractional reps
    expect(sets[1]).toMatchObject({ weightKg: null, reps: 5 }); // negative load → not recorded
  });
});

describe('stable ids and dedupe', () => {
  it('hash ids depend on source, start time and sets — not on the unit or time zone chosen', async () => {
    const file = parseWorkoutCsv(fixture('strong.csv'));
    const a = await buildImportPlan(file, EXERCISES, EMPTY, { timeZone: 'UTC', weightUnit: 'kg' });
    const b = await buildImportPlan(file, EXERCISES, EMPTY, { timeZone: 'America/New_York', weightUnit: 'lb' });
    expect(a.sessions.map((s) => s.id)).toEqual(b.sessions.map((s) => s.id));
    const w = file.workouts[0];
    const changed = { ...w, exercises: [{ ...w.exercises[0], sets: [{ ...w.exercises[0].sets[0], reps: 11 }] }] };
    expect(await workoutHashId('strong', changed)).not.toBe(await workoutHashId('strong', w));
    expect(await workoutHashId('hevy', w)).not.toBe(await workoutHashId('strong', w));
    expect(importKey('strong', w)).toBe('strong|2024-01-15T07:45:12');
    expect(uuidFromHex('f'.repeat(64))).toBe('ffffffff-ffff-5fff-bfff-ffffffffffff');
  });

  it('re-importing the same file adds nothing; custom exercises are reused, not duplicated', async () => {
    const db = await fresh();
    const file = parseWorkoutCsv(fixture('strong.csv'));
    const first = await planWorkoutImport(db, file, await library(db), UTC);
    expect(await applyWorkoutImport(db, first)).toEqual({ workouts: 2, exercises: 2 });
    expect(await db.sessions.count()).toBe(2);
    expect(await db.customExercises.count()).toBe(2);

    const again = await planWorkoutImport(db, parseWorkoutCsv(fixture('strong.csv')), await library(db), UTC);
    expect(again).toMatchObject({ newWorkouts: 0, alreadyImported: 2, created: [], customExercises: [] });
    expect(again.matched.map((l) => l.name)).toContain('Landmine Press'); // now matches the custom exercise
    expect(await applyWorkoutImport(db, again)).toEqual({ workouts: 0, exercises: 0 });
    // Applying a stale plan twice (double tap) doesn't duplicate either.
    expect(await applyWorkoutImport(db, first)).toEqual({ workouts: 0, exercises: 0 });
    expect(await db.sessions.count()).toBe(2);
    expect(await db.customExercises.count()).toBe(2);
  });

  it('a file with more workouts adds only the new ones; a workout edited in the other app is not added twice', async () => {
    const db = await fresh();
    const base = fixture('strong.csv');
    await applyWorkoutImport(db, await planWorkoutImport(db, parseWorkoutCsv(base), await library(db), UTC));
    const edited = base.replace('"Push Day",1h 5m,"Bench Press (Barbell)",1,80,8', '"Push Day",1h 5m,"Bench Press (Barbell)",1,82.5,8');
    const extra = `${edited}\n2024-01-20 09:00:00,"Legs",50m,"Squat (Barbell)",1,100,5,0,0,"","",\n`;
    const plan = await planWorkoutImport(db, parseWorkoutCsv(extra), await library(db), UTC);
    expect(plan).toMatchObject({ workoutsFound: 3, newWorkouts: 1, alreadyImported: 2 });
    expect(plan.sessions[0].name).toBe('Legs');
  });

  it('a deleted imported workout is not brought back by a later import', async () => {
    const db = await fresh();
    const file = parseWorkoutCsv(fixture('hevy.csv'));
    const plan = await planWorkoutImport(db, file, await library(db), UTC);
    await applyWorkoutImport(db, plan);
    await deleteRecord('sessions', plan.sessions[0].id, db);
    const again = await planWorkoutImport(db, file, await library(db), UTC);
    expect(again).toMatchObject({ newWorkouts: 0, alreadyImported: 2 });
  });

  it('never overwrites a custom exercise the user renamed since an earlier import', async () => {
    const db = await fresh(true);
    const file = parseWorkoutCsv(fixture('hevy.csv'));
    await applyWorkoutImport(db, await planWorkoutImport(db, file, await library(db), UTC));
    const crunch = (await db.customExercises.toArray()).find((c) => c.name === 'Cable Crunch')!;
    await db.customExercises.put({ ...crunch, name: 'Kneeling cable crunch' });
    await db.sessions.clear();
    const plan = await planWorkoutImport(db, file, await library(db), UTC);
    const created = plan.customExercises.find((c) => c.name === 'Cable Crunch')!;
    expect(created.id).not.toBe(crunch.id);
    await applyWorkoutImport(db, plan);
    expect((await db.customExercises.get(crunch.id))!.name).toBe('Kneeling cable crunch');
  });
});

describe('writing', () => {
  it('queues sessions and custom exercises for sync (cloud copy wins), with no other side effects', async () => {
    const db = await fresh();
    const plan = await planWorkoutImport(db, parseWorkoutCsv(fixture('hevy.csv')), await library(db), UTC);
    await applyWorkoutImport(db, plan);
    const ops = await db.outbox.toArray();
    expect(ops.map((o) => o.entity).sort()).toEqual(['custom_exercises', 'custom_exercises', 'sessions', 'sessions']);
    expect(ops.every((o) => o.op === 'upsert' && o.preferRemote === true && o.status === 'pending')).toBe(true);
    // No analytics events, push schedules or other local state are written by an import.
    expect(await db.kv.count()).toBe(0);
    expect(await db.pendingPosts.count()).toBe(0);
    const stored = await db.sessions.toArray();
    expect(stored.every((s) => s.status === 'completed' && s.imported?.source === 'hevy')).toBe(true);
  });

  it('guest devices store the records without a sync queue', async () => {
    const db = await fresh(true);
    await applyWorkoutImport(db, await planWorkoutImport(db, parseWorkoutCsv(fixture('strong-eu.csv')), await library(db), UTC));
    expect(await db.sessions.count()).toBe(2);
    expect(await db.outbox.count()).toBe(0);
  });

  it('writes nothing when the transaction fails', async () => {
    const db = await fresh();
    const plan = await planWorkoutImport(db, parseWorkoutCsv(fixture('hevy.csv')), await library(db), UTC);
    const broken = { ...plan, sessions: [...plan.sessions, { ...plan.sessions[0], id: undefined as unknown as string }] };
    await expect(applyWorkoutImport(db, broken)).rejects.toThrow();
    expect(await db.sessions.count()).toBe(0);
    expect(await db.customExercises.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
  });
});

describe('recorded values survive the mapping', () => {
  const header = 'Date,Workout Name,Exercise Name,Set Order,Weight (kg),Reps,Distance (m),Seconds';
  const row = (date: string, name: string, w: number, r: number, d: number, sec: number) => `${date},A,${name},1,${w},${r},${d},${sec}`;
  const D1 = '2024-01-01 10:00:00';
  const D2 = '2024-01-03 10:00:00';
  const setOf = (plan: Awaited<ReturnType<typeof buildImportPlan>>, date: string, name: string) => {
    const s = plan.sessions.find((x) => x.imported!.key === `strong|${date.replace(' ', 'T')}`)!;
    const all = [...EXERCISES, ...plan.customExercises];
    const i = parseWorkoutCsv(csv).workouts.find((w) => w.startKey === date)!.exercises.findIndex((e) => e.name === name);
    const se = s.exercises[i];
    return { set: se.sets[0], exercise: all.find((e) => e.id === se.exerciseId)! };
  };
  const csv = [
    header,
    row(D1, 'Suitcase Carry (Dumbbell)', 20, 0, 30, 30),
    row(D1, 'Sled Push', 100, 0, 20, 0),
    row(D1, 'Weighted Plank', 10, 0, 0, 60),
    row(D1, 'Farmers Walk', 32, 0, 40, 45),
    row(D1, 'Mountain Climbers', 0, 20, 0, 0),
    row(D1, 'Jumping Jacks', 0, 30, 0, 0),
    row(D1, 'Pull Up', 10, 5, 0, 0),
    row(D2, 'Mountain Climbers', 0, 0, 0, 45),
    row(D2, 'Pull Up', 0, 8, 0, 0),
  ].join('\n');

  it('keeps loaded carries, sleds and weighted holds with their weight, distance and time, all completed', async () => {
    const plan = await buildImportPlan(parseWorkoutCsv(csv), EXERCISES, EMPTY, UTC);
    const carry = setOf(plan, D1, 'Suitcase Carry (Dumbbell)');
    expect(carry.exercise.id).toBe('suitcase-carry');
    expect(carry.set).toMatchObject({ weightKg: 20, entered: { value: 20, unit: 'kg' }, distanceM: 30, durationSec: 30, completed: true });
    const farmer = setOf(plan, D1, 'Farmers Walk');
    expect(farmer.exercise.id).toBe('farmer-carry');
    expect(farmer.set).toMatchObject({ weightKg: 32, distanceM: 40, durationSec: 45, completed: true });
    const sled = setOf(plan, D1, 'Sled Push');
    expect(sled.exercise).toMatchObject({ custom: true, name: 'Sled Push', tracking: 'distance_time', load: 'total' });
    expect(sled.set).toMatchObject({ weightKg: 100, distanceM: 20, completed: true });
    const plank = setOf(plan, D1, 'Weighted Plank');
    expect(plank.exercise).toMatchObject({ custom: true, tracking: 'distance_time' });
    expect(plank.exercise.load).not.toBe('none');
    expect(plank.set).toMatchObject({ weightKg: 10, durationSec: 60, completed: true });
    expect(plan.repairedSets).toBe(0);
  });

  it('rep-count Mountain Climbers / Jumping Jacks and a loaded Pull Up get compatible variants; matching blocks stay on the library', async () => {
    const plan = await buildImportPlan(parseWorkoutCsv(csv), EXERCISES, EMPTY, UTC);
    const mc = setOf(plan, D1, 'Mountain Climbers');
    expect(mc.exercise).toMatchObject({ custom: true, name: 'Mountain Climbers (Strong)', tracking: 'reps' });
    expect(mc.set).toMatchObject({ reps: 20, completed: true });
    const jj = setOf(plan, D1, 'Jumping Jacks');
    expect(jj.exercise).toMatchObject({ custom: true, name: 'Jumping Jacks (Strong)', tracking: 'reps' });
    expect(jj.set).toMatchObject({ reps: 30, completed: true });
    const pu = setOf(plan, D1, 'Pull Up');
    expect(pu.exercise).toMatchObject({ custom: true, name: 'Pull Up (Strong)', tracking: 'weight_reps' });
    expect(pu.set).toMatchObject({ weightKg: 10, reps: 5, completed: true });
    // The timed Mountain Climbers block and the bodyweight Pull Up block fit the library exercises.
    expect(setOf(plan, D2, 'Mountain Climbers').exercise.id).toBe('mountain-climber');
    expect(setOf(plan, D2, 'Mountain Climbers').set).toMatchObject({ durationSec: 45, completed: true });
    expect(setOf(plan, D2, 'Pull Up').exercise.id).toBe('pull-up');
    // Preview: the same export name is listed as matched and as a new variant.
    expect(plan.matched.map((l) => [l.name, l.exerciseId])).toContainEqual(['Mountain Climbers', 'mountain-climber']);
    expect(plan.created.map((l) => [l.name, l.exerciseName])).toContainEqual(['Mountain Climbers', 'Mountain Climbers (Strong)']);
    expect(plan.repairedSets).toBe(0);
  });

  it('variants are reused by a later import, not duplicated', async () => {
    const db = await fresh();
    await applyWorkoutImport(db, await planWorkoutImport(db, parseWorkoutCsv(csv), await library(db), UTC));
    const customs = await db.customExercises.count();
    await db.sessions.clear();
    const again = await planWorkoutImport(db, parseWorkoutCsv(csv), await library(db), UTC);
    expect(again.customExercises).toEqual([]);
    expect(again.matched.map((l) => l.exerciseName)).toContain('Mountain Climbers (Strong)');
    await applyWorkoutImport(db, again);
    expect(await db.customExercises.count()).toBe(customs);
  });

  it('every fixture: no recorded weight, reps, distance or time is dropped, and no valid set becomes not done', async () => {
    for (const name of ['strong.csv', 'strong-eu.csv', 'hevy.csv', 'hevy-lbs.csv']) {
      const file = parseWorkoutCsv(fixture(name));
      const plan = await buildImportPlan(file, EXERCISES, EMPTY, { ...UTC, now: 1 });
      const all = new Map([...EXERCISES, ...plan.customExercises].map((e) => [e.id, e]));
      const byStart = new Map(plan.sessions.map((s) => [s.startedAt, s]));
      for (const w of file.workouts) {
        const session = byStart.get(Date.parse(`${'local' in w.start ? w.start.local : ''}Z`))!;
        w.exercises.forEach((e, i) =>
          e.sets.forEach((src, j) => {
            const out = session.exercises[i].sets[j];
            const label = `${name}: ${e.name} #${j + 1}`;
            const ex = all.get(session.exercises[i].exerciseId)!;
            if ((src.weight ?? 0) > 0) expect(out.weightKg, label).not.toBeNull();
            if ((src.reps ?? 0) > 0) expect(out.reps, label).toBe(src.reps);
            if ((src.distance ?? 0) > 0) expect(out.distanceM, label).not.toBeNull();
            if ((src.durationSec ?? 0) > 0) expect(out.durationSec, label).toBe(src.durationSec);
            expect(out.completed, label).toBe(true);
            expect(ex, label).toBeDefined();
          }),
        );
      }
    }
  });

  it('day/month choice changes the dates and the dedupe key, so a wrong choice can be corrected', async () => {
    const amb = 'Date,Workout Name,Exercise Name,Set Order,Weight,Reps\n01/02/2024 10:00,A,Squat (Barbell),1,100,5';
    const dmy = await buildImportPlan(parseWorkoutCsv(amb, { dayOrder: 'dmy' }), EXERCISES, EMPTY, UTC);
    const mdy = await buildImportPlan(parseWorkoutCsv(amb, { dayOrder: 'mdy' }), EXERCISES, EMPTY, UTC);
    expect(dmy).toMatchObject({ dayOrderNeeded: true, from: '2024-02-01' });
    expect(mdy.from).toBe('2024-01-02');
    expect(dmy.sessions[0].id).not.toBe(mdy.sessions[0].id);
  });
});
