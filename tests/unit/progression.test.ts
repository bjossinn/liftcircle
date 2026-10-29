import { describe, expect, it } from 'vitest';
import { EXERCISES } from '@/data/exercises';
import { comparableHistory, nextLoadUp, suggestNext } from '@/domain/progression';
import { kgToLb, lbToKg, round } from '@/domain/units';
import type { Exercise, LoggedSet, SessionExercise, WorkoutSession } from '@/domain/types';

const ex = (id: string) => {
  const e = EXERCISES.find((x) => x.id === id);
  if (!e) throw new Error(`missing ${id}`);
  return e as Exercise;
};
let n = 0;
type S = { w?: number | null; r?: number | null; rir?: number; d?: number; m?: number; type?: LoggedSet['type'] };
function se(exerciseId: string, sets: S[], extra: Partial<SessionExercise> = {}): SessionExercise {
  return {
    id: `se${n++}`,
    exerciseId,
    order: 0,
    sets: sets.map((s) => ({ id: `set${n++}`, type: s.type ?? 'normal', weightKg: s.w ?? null, reps: s.r ?? null, rir: s.rir ?? null, durationSec: s.d ?? null, distanceM: s.m ?? null, completed: true })),
    ...extra,
  };
}
const times = (k: number, s: S) => Array.from({ length: k }, () => ({ ...s }));
const rx = { sets: 3, repMin: 8, repMax: 12, targetRir: 2 };
const KG = { unit: 'kg' as const };
const LB = { unit: 'lb' as const };

describe('loaded lifts: double progression', () => {
  const squat = ex('barbell-back-squat');

  it('no history → calibrate with no load', () => {
    const s = suggestNext(squat, rx, [], KG);
    expect(s.action).toBe('calibrate');
    expect(s.loadKg).toBeNull();
  });

  it('all sets at the top of the range at target effort in two sessions → smallest increase, back to bottom of range', () => {
    const h = [se(squat.id, times(3, { w: 60, r: 12, rir: 2 })), se(squat.id, times(3, { w: 60, r: 12 }))];
    const s = suggestNext(squat, rx, h, KG);
    expect(s.action).toBe('increase_load');
    expect(s.loadKg).toBe(62.5);
    expect(s.targetReps).toBe(8);
    expect(s.repMin).toBe(8);
  });

  it('top of range only once → hold to confirm', () => {
    const h = [se(squat.id, times(3, { w: 60, r: 12 })), se(squat.id, [{ w: 60, r: 12 }, { w: 60, r: 11 }, { w: 60, r: 10 }])];
    const s = suggestNext(squat, rx, h, KG);
    expect(s.action).toBe('hold');
    expect(s.loadKg).toBe(60);
  });

  it('missed targets → hold the load, add reps', () => {
    const h = [se(squat.id, [{ w: 60, r: 10 }, { w: 60, r: 9 }, { w: 60, r: 9 }]), se(squat.id, times(3, { w: 60, r: 12 }))];
    const s = suggestNext(squat, rx, h, KG);
    expect(s.action).toBe('add_reps');
    expect(s.loadKg).toBe(60);
    expect(s.targetReps).toBe(10);
    const below = suggestNext(squat, rx, [se(squat.id, [{ w: 60, r: 9 }, { w: 60, r: 7 }, { w: 60, r: 6 }])], KG);
    expect(below.action).toBe('hold');
    expect(below.loadKg).toBe(60);
  });

  it('reps reached by grinding past the target effort do not trigger an increase', () => {
    const h = [se(squat.id, times(3, { w: 60, r: 12, rir: 0 })), se(squat.id, times(3, { w: 60, r: 12, rir: 0 }))];
    expect(suggestNext(squat, rx, h, KG).action).not.toBe('increase_load');
  });

  it('missing a prescribed working set blocks the increase; warm-ups are ignored', () => {
    const h = [se(squat.id, [{ w: 20, r: 10, type: 'warmup' }, ...times(2, { w: 60, r: 12 })]), se(squat.id, times(3, { w: 60, r: 12 }))];
    expect(suggestNext(squat, rx, h, KG).action).toBe('hold');
  });

  it('discomfort on a recent comparable session → no increase, alternatives offered', () => {
    const h = [se(squat.id, times(3, { w: 60, r: 12 })), se(squat.id, times(3, { w: 60, r: 12 }), { discomfort: true })];
    const s = suggestNext(squat, rx, h, KG);
    expect(s.action).toBe('discomfort_hold');
    expect(s.loadKg).toBe(60);
    expect(s.alternativeIds?.length).toBeGreaterThan(0);
  });

  it('repeated declines → review recovery', () => {
    const h = [se(squat.id, times(3, { w: 55, r: 8 })), se(squat.id, times(3, { w: 57.5, r: 9 })), se(squat.id, times(3, { w: 60, r: 10 }))];
    const s = suggestNext(squat, rx, h, KG);
    expect(s.action).toBe('review_recovery');
    expect(s.reason).toMatch(/recovery|workload|sleep/i);
  });

  it('lb users get lb increments on an achievable grid', () => {
    const h = [se(squat.id, times(3, { w: lbToKg(135), r: 12 })), se(squat.id, times(3, { w: lbToKg(135), r: 12 }))];
    const s = suggestNext(squat, rx, h, LB);
    expect(s.action).toBe('increase_load');
    expect(round(kgToLb(s.loadKg!), 2)).toBe(140);
    const db = ex('dumbbell-bench-press');
    const h2 = [se(db.id, times(3, { w: lbToKg(25), r: 12 })), se(db.id, times(3, { w: lbToKg(25), r: 12 }))];
    expect(round(kgToLb(suggestNext(db, rx, h2, LB).loadKg!), 2)).toBe(30);
  });

  it('respects equipment increments (machines jump more) and custom increments', () => {
    const press = ex('leg-press');
    const h = [se(press.id, times(3, { w: 100, r: 12 })), se(press.id, times(3, { w: 100, r: 12 }))];
    expect(suggestNext(press, rx, h, KG).loadKg).toBe(105);
    const hs = [se(squat.id, times(3, { w: 60, r: 12 })), se(squat.id, times(3, { w: 60, r: 12 }))];
    expect(suggestNext(squat, rx, hs, { unit: 'kg', incrementKg: 1 }).loadKg).toBe(61);
    // odd load → next achievable plate step, not +2.5 on top of an odd number
    expect(nextLoadUp(61.3, 2.5, 'kg')).toBe(62.5);
  });
});

describe('bodyweight, assisted, timed and cardio rules', () => {
  it('bodyweight: add reps, then suggest a harder variation', () => {
    const pu = ex('push-up');
    const r = { sets: 3, repMin: 6, repMax: 12, targetRir: 2 };
    const s1 = suggestNext(pu, r, [se(pu.id, [{ r: 10 }, { r: 9 }, { r: 8 }])], KG);
    expect(s1.action).toBe('add_reps');
    expect(s1.targetReps).toBe(9);
    const s2 = suggestNext(pu, r, [se(pu.id, times(3, { r: 12 })), se(pu.id, times(3, { r: 12 }))], KG);
    expect(s2.action).toBe('add_reps');
    expect(s2.hint).toBe('harder_variation');
  });

  it('weighted bodyweight: start adding load from zero once the range is mastered', () => {
    const dip = ex('weighted-dip');
    const r = { sets: 3, repMin: 6, repMax: 10, targetRir: 2 };
    const s = suggestNext(dip, r, [se(dip.id, times(3, { w: 0, r: 10 })), se(dip.id, times(3, { w: 0, r: 10 }))], KG);
    expect(s.action).toBe('increase_load');
    expect(s.loadKg).toBe(2.5);
  });

  it('assisted: top of range twice → less assistance', () => {
    const ap = ex('assisted-pull-up');
    const r = { sets: 3, repMin: 6, repMax: 10, targetRir: 2 };
    const s = suggestNext(ap, r, [se(ap.id, times(3, { w: 30, r: 10 })), se(ap.id, times(3, { w: 30, r: 10 }))], KG);
    expect(s.action).toBe('reduce_assistance');
    expect(s.loadKg).toBe(25);
    const last = suggestNext(ap, r, [se(ap.id, times(3, { w: 5, r: 10 })), se(ap.id, times(3, { w: 5, r: 10 }))], KG);
    expect(last.loadKg).toBe(0);
    expect(last.hint).toBe('unassisted');
  });

  it('timed holds: longer duration once targets are met twice', () => {
    const plank = ex('plank');
    const r = { sets: 3, repMin: 1, repMax: 1, targetRir: 2, durationSec: 30 };
    const s = suggestNext(plank, r, [se(plank.id, times(3, { d: 30 })), se(plank.id, times(3, { d: 32 }))], KG);
    expect(s.action).toBe('increase_duration');
    expect(s.durationSec).toBe(35);
    const hold = suggestNext(plank, r, [se(plank.id, [{ d: 30 }, { d: 25 }, { d: 20 }]), se(plank.id, times(3, { d: 30 }))], KG);
    expect(hold.action).toBe('hold');
  });

  it('cardio: distance or time increases gradually', () => {
    const row = ex('rowing-machine');
    const r = { sets: 1, repMin: 1, repMax: 1, targetRir: 3, durationSec: 600 };
    const dist = suggestNext(row, r, [se(row.id, [{ d: 600, m: 2000 }]), se(row.id, [{ d: 600, m: 1950 }])], KG);
    expect(dist.action).toBe('increase_distance');
    expect(dist.distanceM).toBe(2200);
    const time = suggestNext(row, r, [se(row.id, [{ d: 600 }]), se(row.id, [{ d: 600 }])], KG);
    expect(time.action).toBe('increase_duration');
    expect(time.durationSec).toBe(660);
  });
});

describe('comparableHistory', () => {
  const mk = (id: string, startedAt: number, status: WorkoutSession['status'], exercises: SessionExercise[], deletedAt?: number): WorkoutSession => ({
    id, createdAt: startedAt, updatedAt: startedAt, name: id, status, date: '2026-11-01', timeZone: 'UTC', startedAt, pausedTotalMs: 0, exercises, deletedAt,
  });
  it('completed, not deleted, newest first, only sessions with completed working sets', () => {
    const sessions = [
      mk('old', 1, 'completed', [se('goblet-squat', [{ w: 20, r: 10 }])]),
      mk('new', 3, 'completed', [se('goblet-squat', [{ w: 22, r: 10 }])]),
      mk('active', 4, 'active', [se('goblet-squat', [{ w: 24, r: 10 }])]),
      mk('deleted', 5, 'completed', [se('goblet-squat', [{ w: 26, r: 10 }])], 6),
      mk('warmonly', 2, 'completed', [se('goblet-squat', [{ w: 10, r: 10, type: 'warmup' }])]),
      mk('other', 7, 'completed', [se('leg-press', [{ w: 100, r: 10 }])]),
    ];
    const h = comparableHistory(sessions, 'goblet-squat');
    expect(h.map((x) => x.sets[0].weightKg)).toEqual([22, 20]);
    expect(comparableHistory(sessions, 'goblet-squat', 'new').map((x) => x.sets[0].weightKg)).toEqual([20]);
  });
});
