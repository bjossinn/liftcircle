/** CSV workout import: matching Strong / Hevy exercise names to the exercise library. */
import { describe, expect, it } from 'vitest';
import { EXERCISES } from '@/data/exercises';
import { createMatcher, matchKey, qualifierEquipment, splitQualifier } from '@/features/import/matching';
import { inferCustomExercise } from '@/features/import/plan';
import type { CustomExercise } from '@/domain/types';

const matcher = createMatcher(EXERCISES);
const id = (name: string) => matcher.match(name)?.id ?? null;

describe('match keys', () => {
  it('ignore case, accents, punctuation, spacing and plural s', () => {
    expect(matchKey('  Pull-Up ')).toBe(matchKey('pull up'));
    expect(matchKey('PULLUP')).toBe(matchKey('pull up'));
    expect(matchKey('Biceps Curl')).toBe(matchKey('bicep curl'));
    expect(matchKey('Farmer’s Walk')).toBe(matchKey('Farmers walk'));
    expect(matchKey('Press')).toBe('press'); // "ss" isn't a plural
  });

  it('split "Base (Qualifier)" and read equipment from qualifiers', () => {
    expect(splitQualifier('Bench Press (Barbell)')).toEqual({ base: 'Bench Press', qualifier: 'Barbell' });
    expect(splitQualifier('Plank')).toEqual({ base: 'Plank', qualifier: null });
    expect(qualifierEquipment('Cable - Straight Bar')).toEqual(['cable']);
    expect(qualifierEquipment('Smith Machine')).toContain('smith');
    expect(qualifierEquipment('Standing')).toEqual([]);
  });
});

describe('library matching', () => {
  it('matches common Strong / Hevy names', () => {
    expect(id('Bench Press (Barbell)')).toBe('barbell-bench-press');
    expect(id('bench press (barbell)')).toBe('barbell-bench-press');
    expect(id('Bench Press (Dumbbell)')).toBe('dumbbell-bench-press');
    expect(id('Squat (Barbell)')).toBe('barbell-back-squat');
    expect(id('Deadlift (Barbell)')).toBe('conventional-deadlift');
    expect(id('Overhead Press (Barbell)')).toBe('overhead-press');
    expect(id('Overhead Press (Dumbbell)')).toBe('dumbbell-overhead-press');
    expect(id('Bent Over Row (Barbell)')).toBe('barbell-row');
    expect(id('Lat Pulldown (Cable)')).toBe('lat-pulldown');
    expect(id('Pull Up')).toBe('pull-up');
    expect(id('Pull-up')).toBe('pull-up');
    expect(id('Chin Up')).toBe('chin-up');
    expect(id('Pull Up (Assisted)')).toBe('assisted-pull-up');
    expect(id('Pull Up (Weighted)')).toBe('weighted-pull-up');
    expect(id('Push Up')).toBe('push-up');
    expect(id('Bicep Curl (Dumbbell)')).toBe('dumbbell-curl');
    expect(id('Bicep Curl (Barbell)')).toBe('barbell-curl');
    expect(id('Hammer Curl (Dumbbell)')).toBe('hammer-curl');
    expect(id('Triceps Pushdown (Cable - Straight Bar)')).toBe('triceps-pushdown');
    expect(id('Skullcrusher (EZ Bar)')).toBe('skull-crusher');
    expect(id('Lateral Raise (Dumbbell)')).toBe('dumbbell-lateral-raise');
    expect(id('Lateral Raise (Cable)')).toBe('cable-lateral-raise');
    expect(id('Romanian Deadlift (Barbell)')).toBe('romanian-deadlift');
    expect(id('Romanian Deadlift (Dumbbell)')).toBe('dumbbell-romanian-deadlift');
    expect(id('Hip Thrust (Barbell)')).toBe('barbell-hip-thrust');
    expect(id('Incline Bench Press (Dumbbell)')).toBe('incline-dumbbell-press');
    expect(id('Incline Bench Press (Barbell)')).toBe('incline-barbell-press');
    expect(id('Leg Press')).toBe('leg-press');
    expect(id('Leg Extension (Machine)')).toBe('leg-extension');
    expect(id('Seated Leg Curl (Machine)')).toBe('seated-leg-curl');
    expect(id('Standing Calf Raise (Machine)')).toBe('standing-calf-raise');
    expect(id('Seated Row (Cable)')).toBe('seated-cable-row');
    expect(id('Seated Cable Row - V Grip (Cable)')).toBe('seated-cable-row');
    expect(id('Face Pull (Cable)')).toBe('face-pull');
    expect(id('Goblet Squat (Kettlebell)')).toBe('goblet-squat');
    expect(id('Rowing (Machine)')).toBe('rowing-machine');
    expect(id('Plank')).toBe('plank');
    expect(id('Farmers Walk')).toBe('farmer-carry');
  });

  it('matches library aliases and is whitespace-insensitive', () => {
    expect(id('RDL')).toBe('romanian-deadlift');
    expect(id('  OHP  ')).toBe('overhead-press');
    expect(id('Skull   Crusher')).toBe('skull-crusher');
    expect(id('Hyperextension')).toBe('back-extension');
  });

  it('does not match a different equipment variant to the wrong library exercise', () => {
    expect(id('Bench Press (Smith Machine)')).toBeNull();
    expect(id('Lat Pulldown (Band)')).toBe('band-pulldown');
    expect(id('Squat (Smith Machine)')).toBeNull();
    expect(id('Landmine Press')).toBeNull();
    expect(id('Cable Crunch')).toBeNull();
    expect(id('Running')).toBeNull();
    expect(id('')).toBeNull();
  });

  it('prefers the user’s custom exercise with exactly that name (e.g. from an earlier import)', () => {
    const custom = { ...inferCustomExercise('Bicep Curl (Barbell)', [{ type: 'normal', weight: 30, reps: 10, distance: null, durationSec: null, rpe: null }], 'c1', 1) } as CustomExercise;
    const m = createMatcher([...EXERCISES, custom]);
    expect(m.match('Bicep Curl (Barbell)')?.id).toBe('c1');
    expect(m.match('bicep curl (barbell)')?.id).toBe('c1');
  });
});

describe('custom exercises for unmatched names', () => {
  const set = (o: object) => ({ type: 'normal' as const, weight: null, reps: null, distance: null, durationSec: null, rpe: null, ...o });
  it('infer tracking and load from the recorded values', () => {
    expect(inferCustomExercise('Landmine Press', [set({ weight: 25, reps: 10 })], 'x', 1)).toMatchObject({ tracking: 'weight_reps', load: 'total', custom: true, name: 'Landmine Press' });
    expect(inferCustomExercise('Cable Crunch', [set({ weight: 45, reps: 15 })], 'x', 1)).toMatchObject({ tracking: 'weight_reps', pattern: 'trunk', category: 'core' });
    expect(inferCustomExercise('Hammer Row (Machine)', [set({ weight: 45, reps: 15 })], 'x', 1)).toMatchObject({ load: 'stack', equipment: ['machine'], pattern: 'horizontal_pull' });
    expect(inferCustomExercise('Arnold Press (Dumbbell)', [set({ weight: 16, reps: 10 })], 'x', 1)).toMatchObject({ load: 'per_hand', implements: 2, equipment: ['dumbbell'] });
    expect(inferCustomExercise('Sit Up', [set({ reps: 20 })], 'x', 1)).toMatchObject({ tracking: 'reps', load: 'none' });
    expect(inferCustomExercise('Running', [set({ distance: 5, durationSec: 1500 })], 'x', 1)).toMatchObject({ tracking: 'distance_time', category: 'cardio', pattern: 'conditioning' });
    expect(inferCustomExercise('Dead Hang', [set({ durationSec: 45 })], 'x', 1)).toMatchObject({ tracking: 'duration', load: 'none' });
    expect(inferCustomExercise('Muscle Up (Assisted)', [set({ weight: 20, reps: 5 })], 'x', 1)).toMatchObject({ tracking: 'assisted', load: 'assistance' });
    expect(inferCustomExercise('Ring Dip (Weighted)', [set({ weight: 10, reps: 5 })], 'x', 1)).toMatchObject({ tracking: 'bodyweight_plus', load: 'added' });
  });
});
