import { describe, expect, it } from 'vitest';
import * as ops from '@/domain/sessionOps';
import type { WorkoutSession } from '@/domain/types';
import { EXERCISES } from '@/data/exercises';

const bench = EXERCISES.find((e) => e.id === 'barbell-bench-press')!;

function session(): WorkoutSession {
  let s: WorkoutSession = { id: 's1', createdAt: 0, updatedAt: 0, name: 'Test', status: 'active', date: '2026-10-28', timeZone: 'UTC', startedAt: 1_000_000, pausedTotalMs: 0, exercises: [] };
  s = ops.addExercise(s, bench, 3);
  return s;
}

describe('session operations', () => {
  it('one-tap completion toggles and carries values into the next empty set', () => {
    let s = session();
    const ex = s.exercises[0];
    s = ops.updateSet(s, ex.id, ex.sets[0].id, { weightKg: 60, reps: 10 });
    const r = ops.toggleSetComplete(s, ex.id, ex.sets[0].id, 2_000_000);
    expect(r.completed).toBe(true);
    expect(r.session.exercises[0].sets[1]).toMatchObject({ weightKg: 60, reps: 10, completed: false });
    const undo = ops.toggleSetComplete(r.session, ex.id, ex.sets[0].id, 2_000_100);
    expect(undo.completed).toBe(false);
    expect(undo.session.exercises[0].sets[0].completed).toBe(false);
  });

  it('rest timer is deadline-based: pause, resume, extend and recalculation after a long gap', () => {
    let s = ops.startRest(session(), 0, 120_000);
    expect(ops.restRemainingMs(s.rest, 30_000)).toBe(90_000);
    expect(ops.restRemainingMs(s.rest, 10 * 60_000)).toBe(0); // app reopened much later
    s = ops.pauseRest(s, 30_000);
    expect(ops.restRemainingMs(s.rest, 999_999)).toBe(90_000); // paused: time frozen
    s = ops.resumeRest(s, 100_000);
    expect(ops.restRemainingMs(s.rest, 100_000)).toBe(90_000);
    s = ops.extendRest(s, 100_000, 15_000);
    expect(ops.restRemainingMs(s.rest, 100_000)).toBe(105_000);
    s = ops.resetRest(s, 200_000);
    expect(ops.restRemainingMs(s.rest, 200_000)).toBe(120_000);
    expect(ops.skipRest(s).rest).toBeUndefined();
  });

  it('session pause excludes paused time from elapsed duration', () => {
    let s = session();
    s = ops.pauseSession(s, s.startedAt + 60_000);
    expect(ops.elapsedMs(s, s.startedAt + 10 * 60_000)).toBe(60_000);
    s = ops.resumeSession(s, s.startedAt + 5 * 60_000);
    expect(ops.elapsedMs(s, s.startedAt + 6 * 60_000)).toBe(2 * 60_000);
  });

  it('finishing keeps only completed sets and drops empty exercises', () => {
    let s = session();
    s = ops.addExercise(s, EXERCISES.find((e) => e.id === 'plank')!, 3);
    const ex = s.exercises[0];
    s = ops.updateSet(s, ex.id, ex.sets[0].id, { weightKg: 60, reps: 8 });
    s = ops.toggleSetComplete(s, ex.id, ex.sets[0].id, 1).session;
    const f = ops.finishSession(s, s.startedAt + 3_600_000);
    expect(f.status).toBe('completed');
    expect(f.exercises).toHaveLength(1);
    expect(f.exercises[0].sets).toHaveLength(1);
    expect(f.rest).toBeUndefined();
    expect(ops.elapsedMs(f, Date.now())).toBe(3_600_000);
  });

  it('swap does not move completed sets onto a different exercise', () => {
    let s = session();
    const ex = s.exercises[0];
    s = ops.updateSet(s, ex.id, ex.sets[0].id, { weightKg: 60, reps: 8 });
    s = ops.toggleSetComplete(s, ex.id, ex.sets[0].id, 1).session;
    expect(ops.swapExercise(s, ex.id, 'dumbbell-bench-press').exercises[0].exerciseId).toBe('barbell-bench-press');
    const fresh = session();
    expect(ops.swapExercise(fresh, fresh.exercises[0].id, 'dumbbell-bench-press').exercises[0]).toMatchObject({ exerciseId: 'dumbbell-bench-press', swappedFrom: 'barbell-bench-press' });
  });

  it('reorder, superset, copy-previous and load adjustment', () => {
    let s = session();
    s = ops.addExercise(s, EXERCISES.find((e) => e.id === 'one-arm-dumbbell-row')!, 3);
    const [a, b] = s.exercises;
    s = ops.toggleSupersetWithNext(s, a.id);
    expect(s.exercises[0].supersetGroup).toBeTruthy();
    expect(s.exercises[0].supersetGroup).toBe(s.exercises[1].supersetGroup);
    s = ops.moveExercise(s, b.id, -1);
    expect(s.exercises[0].id).toBe(b.id);
    s = ops.updateSet(s, a.id, s.exercises[1].sets[0].id, { weightKg: 50, reps: 10 });
    s = ops.copyPreviousSet(s, a.id, s.exercises[1].sets[1].id);
    expect(s.exercises[1].sets[1]).toMatchObject({ weightKg: 50, reps: 10 });
    s = ops.adjustPendingLoad(s, a.id, 2.5);
    expect(s.exercises[1].sets.map((x) => x.weightKg)).toEqual([52.5, 52.5, 2.5]);
  });
});
