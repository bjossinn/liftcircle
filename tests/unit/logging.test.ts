/**
 * Shared set validation, counting, substitutions, warm-ups and progression wording (section 4 of the
 * 29 Oct repair brief). Each block names the finding it covers.
 */
import { describe, expect, it } from 'vitest';
import { EXERCISES } from '@/data/exercises';
import type { Exercise, LoggedSet, SessionExercise, WorkoutSession } from '@/domain/types';
import { hasRecordedLoad, isCountableSet, isValidCompletedSet, sanitizeImportedSession, setFieldsFor, validateLoggedSet, validateSessionRecord } from '@/domain/setValidation';
import * as ops from '@/domain/sessionOps';
import { detectRecords, personalRecords, summarizeSession, weeklyWorkingSets } from '@/domain/stats';
import { comparableHistory, suggestNext, workingSets } from '@/domain/progression';
import { adaptPrescription, adaptSessionExercise, fitsConstraints, substitutionCandidates } from '@/domain/substitution';
import { warmupSets } from '@/domain/warmups';
import { buildSessionFromTemplate } from '@/domain/program/session';
import { defaultSettings } from '@/state/defaults';
import { displayWeight, kgToLb, lbToKg } from '@/domain/units';
import { parseNumberText } from '@/features/train/setDraft';

const byId = new Map(EXERCISES.map((e) => [e.id, e]));
const ex = (id: string) => {
  const e = byId.get(id);
  if (!e) throw new Error(id);
  return e;
};
const S = (p: Partial<LoggedSet>): LoggedSet => ({ id: Math.random().toString(36).slice(2), type: 'normal', completed: true, weightKg: null, reps: null, ...p });
const base = (id: string, exercises: SessionExercise[], extra: Partial<WorkoutSession> = {}): WorkoutSession => ({
  id, createdAt: 0, updatedAt: 0, name: 'W', status: 'completed', date: '2026-10-20', timeZone: 'UTC', startedAt: 1_000, endedAt: 2_000, pausedTotalMs: 0, exercises, ...extra,
});
const se = (exerciseId: string, sets: LoggedSet[], extra: Partial<SessionExercise> = {}): SessionExercise => ({ id: `${exerciseId}-${Math.random()}`, exerciseId, order: 0, sets, ...extra });

const bench = ex('barbell-bench-press');
const pushup = ex('push-up');
const assisted = ex('assisted-pull-up');
const dip = ex('weighted-dip');
const plank = ex('plank');
const carry = ex('farmer-carry');
const bike = ex('stationary-bike');

/* ============================================================ validation */
describe('shared set validation (user requirement + reproduced defect "20 kg / 0 reps counts as done")', () => {
  it('rep-based completed sets need positive whole reps', () => {
    expect(validateLoggedSet(S({ weightKg: 20, reps: 0 }), bench).ok).toBe(false);
    expect(validateLoggedSet(S({ weightKg: 20, reps: 0 }), bench).fieldErrors.reps).toMatch(/at least 1 rep/);
    expect(validateLoggedSet(S({ weightKg: 20, reps: 2.5 }), bench).fieldErrors.reps).toMatch(/whole/);
    expect(validateLoggedSet(S({ weightKg: 20, reps: 5 }), bench).ok).toBe(true);
    expect(validateLoggedSet(S({ reps: 0 }), pushup).ok).toBe(false);
    expect(validateLoggedSet(S({ reps: 12 }), pushup).ok).toBe(true);
  });
  it('rejects negative and non-finite numbers everywhere (drafts included)', () => {
    expect(validateLoggedSet(S({ weightKg: -5, reps: 5 }), bench).fieldErrors.weight).toBeDefined();
    expect(validateLoggedSet(S({ weightKg: Number.NaN, reps: 5 }), bench).ok).toBe(false);
    expect(validateLoggedSet(S({ weightKg: Infinity, reps: 5 }), bench).ok).toBe(false);
    expect(validateLoggedSet(S({ completed: false, reps: -1 }), pushup).ok).toBe(false);
    expect(validateLoggedSet(S({ durationSec: -30 }), plank).ok).toBe(false);
    expect(validateLoggedSet(S({ reps: 5, rir: 11 }), pushup).fieldErrors.rir).toBeDefined();
    expect(validateLoggedSet(S({ reps: 5, rpe: 0 }), pushup).fieldErrors.rpe).toBeDefined();
  });
  it('incomplete drafts may be empty or partial', () => {
    expect(validateLoggedSet(S({ completed: false }), bench).ok).toBe(true);
    expect(validateLoggedSet(S({ completed: false, reps: 0 }), bench).ok).toBe(true);
  });
  it('keeps valid zero added weight and zero assistance', () => {
    expect(validateLoggedSet(S({ weightKg: 0, reps: 8 }), dip, { mode: 'log' }).ok).toBe(true);
    expect(validateLoggedSet(S({ weightKg: 0, reps: 8 }), assisted, { mode: 'log' }).ok).toBe(true);
    expect(hasRecordedLoad(S({ weightKg: 0 }), dip)).toBe(true);
    expect(hasRecordedLoad(S({ weightKg: 0 }), assisted)).toBe(true);
  });
  it('decision: logging requires a load on loaded working sets; history/import accept "load not recorded"', () => {
    expect(validateLoggedSet(S({ reps: 8 }), bench, { mode: 'log' }).fieldErrors.weight).toMatch(/weight/);
    expect(validateLoggedSet(S({ weightKg: 0, reps: 8 }), bench, { mode: 'log' }).ok).toBe(false);
    expect(validateLoggedSet(S({ reps: 8 }), dip, { mode: 'log' }).fieldErrors.weight).toMatch(/0 for none/);
    expect(validateLoggedSet(S({ reps: 8 }), assisted, { mode: 'log' }).fieldErrors.weight).toMatch(/assistance/);
    // warm-ups don't need a load to be logged
    expect(validateLoggedSet(S({ type: 'warmup', reps: 8 }), bench, { mode: 'log' }).ok).toBe(true);
    // history: allowed, but the load is not a known zero
    const r = validateLoggedSet(S({ reps: 8 }), bench);
    expect(r.ok).toBe(true);
    expect(r.loadRecorded).toBe(false);
  });
  it('timed and distance/time modes', () => {
    expect(validateLoggedSet(S({ durationSec: 0 }), plank).ok).toBe(false);
    expect(validateLoggedSet(S({ durationSec: 30 }), plank).ok).toBe(true);
    expect(validateLoggedSet(S({}), bike).ok).toBe(false);
    expect(validateLoggedSet(S({ distanceM: 0, durationSec: 0 }), bike).ok).toBe(false);
    expect(validateLoggedSet(S({ durationSec: 600 }), bike).ok).toBe(true);
    expect(validateLoggedSet(S({ distanceM: 400 }), bike).ok).toBe(true);
    expect(validateLoggedSet(S({ distanceM: 40, weightKg: 24 }), carry, { mode: 'log' }).ok).toBe(true);
    expect(validateLoggedSet(S({ distanceM: 40 }), carry, { mode: 'log' }).ok).toBe(false);
    expect(setFieldsFor(carry)).toEqual(['weight', 'distance', 'duration']);
    expect(setFieldsFor(plank)).toEqual(['duration']);
  });
  it('isCountableSet: completed AND valid AND not a warm-up', () => {
    expect(isCountableSet(S({ weightKg: 60, reps: 5 }), bench)).toBe(true);
    expect(isCountableSet(S({ weightKg: 60, reps: 0 }), bench)).toBe(false);
    expect(isCountableSet(S({ type: 'warmup', weightKg: 20, reps: 8 }), bench)).toBe(false);
    expect(isValidCompletedSet(S({ type: 'warmup', weightKg: 20, reps: 8 }), bench)).toBe(true);
    expect(isCountableSet(S({ completed: false, weightKg: 60, reps: 5 }), bench)).toBe(false);
    // unknown exercise: generic rules
    expect(isCountableSet(S({ reps: 0 }), undefined)).toBe(false);
    expect(isCountableSet(S({ reps: 3 }), undefined)).toBe(true);
  });
  it('import helpers: validateSessionRecord lists problems; sanitizeImportedSession never lets invalid data count', () => {
    const s = base('imp', [se('barbell-bench-press', [S({ weightKg: 60, reps: 5 }), S({ weightKg: -3, reps: 5 }), S({ weightKg: 60, reps: 0 })])]);
    const issues = validateSessionRecord(s, byId);
    expect(issues).toHaveLength(2);
    const { session: clean } = sanitizeImportedSession(s, byId);
    const sets = clean.exercises[0].sets;
    expect(sets[0]).toBe(s.exercises[0].sets[0]); // valid data untouched
    expect(sets[1]).toMatchObject({ weightKg: null, reps: 5, completed: true }); // bad load → not recorded
    expect(sets[2]).toMatchObject({ reps: 0, completed: false });
    expect(validateSessionRecord(clean, byId)).toEqual([]);
  });
});

describe('number parsing for drafts (decimal comma/point, empty)', () => {
  it('parses', () => {
    expect(parseNumberText('22,5')).toEqual({ kind: 'number', value: 22.5 });
    expect(parseNumberText('22.5')).toEqual({ kind: 'number', value: 22.5 });
    expect(parseNumberText('22.')).toEqual({ kind: 'number', value: 22 });
    expect(parseNumberText('')).toEqual({ kind: 'empty' });
    expect(parseNumberText('-3').kind).toBe('invalid');
    expect(parseNumberText('abc').kind).toBe('invalid');
    expect(parseNumberText('8.5', { decimals: false }).kind).toBe('invalid');
    expect(parseNumberText('1e3').kind).toBe('invalid');
  });
});

/* ============================================================= sessionOps */
describe('logging ops (reproduced defect: 0 reps completed, rest started, 0 copied forward)', () => {
  const active = (): WorkoutSession => ({ ...base('a', [se('barbell-bench-press', [S({ id: 'x', completed: false, weightKg: 20, reps: 0 }), S({ id: 'y', completed: false })], { id: 'e' })]), status: 'active' });
  it('toggleSetComplete with the exercise refuses invalid sets', () => {
    const r = ops.toggleSetComplete(active(), 'e', 'x', 5, bench);
    expect(r.completed).toBe(false);
    expect(r.errors[0]).toMatch(/rep/);
    expect(r.session.exercises[0].sets[0].completed).toBe(false);
    expect(r.session.exercises[0].sets[1].reps).toBeNull();
  });
  it('never copies zeros/negatives forward (carry, add set, copy previous)', () => {
    let s = active();
    s = ops.updateSet(s, 'e', 'y', { weightKg: 20, reps: 0 });
    s = ops.addSet(s, 'e');
    expect(s.exercises[0].sets[2].reps).toBeNull();
    expect(s.exercises[0].sets[2].weightKg).toBe(20);
    s = ops.updateSet(s, 'e', 'y', { reps: 7 });
    s = ops.copyPreviousSet(s, 'e', 'y');
    expect(s.exercises[0].sets[1]).toMatchObject({ reps: null, weightKg: 20 });
    // old, unvalidated callers: a 0-rep completion still doesn't carry 0 forward
    const legacy = ops.toggleSetComplete(active(), 'e', 'x', 5);
    expect(legacy.session.exercises[0].sets[1].reps).toBeNull();
  });
  it('a valid set completes and carries valid values', () => {
    let s = active();
    s = ops.updateSet(s, 'e', 'x', { reps: 6 });
    const r = ops.toggleSetComplete(s, 'e', 'x', 5, bench);
    expect(r.completed).toBe(true);
    expect(r.session.exercises[0].sets[1]).toMatchObject({ weightKg: 20, reps: 6 });
  });
});

/* =================================================================== stats */
describe('invalid / incomplete sets never inflate counts, volume or PRs', () => {
  it('summary ignores invalid completed sets and counts valid warm-ups separately', () => {
    const s = base('s', [
      se('barbell-bench-press', [S({ type: 'warmup', weightKg: 20, reps: 8 }), S({ type: 'warmup', weightKg: 20, reps: 0 }), S({ weightKg: 60, reps: 5 }), S({ weightKg: 60, reps: 0 }), S({ weightKg: -1, reps: 5 })]),
      se('plank', [S({ type: 'timed', durationSec: 0 }), S({ type: 'timed', durationSec: 40 })]),
    ]);
    const sum = summarizeSession(s, byId);
    expect(sum.workingSets).toBe(2);
    expect(sum.warmupSets).toBe(1);
    expect(sum.totalReps).toBe(5);
    expect(sum.timedSec).toBe(40);
    expect(sum.volume.freeWeightKg).toBe(300);
    expect(weeklyWorkingSets([s], byId, 1, '2026-10-19', '2026-10-25')[0].total).toBe(2);
  });
  it('"load not recorded" adds no volume and creates no load record', () => {
    const prev = base('p', [se('barbell-bench-press', [S({ weightKg: 60, reps: 5 })])], { date: '2026-10-10', startedAt: 10 });
    const cur = base('c', [se('barbell-bench-press', [S({ weightKg: null, reps: 12 }), S({ weightKg: 0, reps: 12 })])], { date: '2026-10-20', startedAt: 20 });
    expect(summarizeSession(cur, byId).workingSets).toBe(2);
    expect(summarizeSession(cur, byId).volume.freeWeightKg).toBe(0);
    expect(detectRecords(cur, [prev], byId, 'kg')).toEqual([]);
  });
  it('bodyweight_plus with unrecorded added load never becomes a bodyweight reps record', () => {
    const prev = base('p', [se('weighted-dip', [S({ weightKg: 0, reps: 8 })])], { startedAt: 10, date: '2026-10-10' });
    const cur = base('c', [se('weighted-dip', [S({ weightKg: null, reps: 15 })])], { startedAt: 20 });
    expect(detectRecords(cur, [prev], byId, 'kg').find((r) => r.kind === 'most_reps')).toBeUndefined();
    const cur2 = base('c2', [se('weighted-dip', [S({ weightKg: 0, reps: 15 })])], { startedAt: 30 });
    expect(detectRecords(cur2, [prev], byId, 'kg').find((r) => r.kind === 'most_reps')).toBeDefined();
  });
  it('assistance: zero assistance is valid and a real record', () => {
    const prev = base('p', [se('assisted-pull-up', [S({ weightKg: 20, reps: 6 })])], { startedAt: 10, date: '2026-10-10' });
    const cur = base('c', [se('assisted-pull-up', [S({ weightKg: 0, reps: 3 })])], { startedAt: 20 });
    expect(detectRecords(cur, [prev], byId, 'kg').find((r) => r.kind === 'least_assistance')?.value).toBe(0);
  });
  it('a corrected historical record recomputes PRs (0-rep "PR" disappears once fixed or invalid)', () => {
    const a = base('a', [se('barbell-bench-press', [S({ weightKg: 60, reps: 5 })])], { date: '2026-10-01', startedAt: 1 });
    const b = base('b', [se('barbell-bench-press', [S({ weightKg: 100, reps: 0 })])], { date: '2026-10-05', startedAt: 2 });
    const heaviest = (list: WorkoutSession[]) => personalRecords(list, bench, 'kg').find((r) => r.kind === 'heaviest')?.value;
    expect(heaviest([a, b])).toBe(60); // the invalid 100 kg × 0 isn't a record
    const fixed = { ...b, exercises: [{ ...b.exercises[0], sets: [{ ...b.exercises[0].sets[0], reps: 1 }] }] };
    expect(heaviest([a, fixed])).toBe(100);
  });
});

/* ============================================================= progression */
describe('progression uses only valid work and states its effort basis honestly', () => {
  const rx = { sets: 2, repMin: 8, repMax: 10, targetRir: 2 };
  const hist = (rir: number | null, extra: LoggedSet[] = []) => [
    se('barbell-bench-press', [S({ weightKg: 60, reps: 10, rir }), S({ weightKg: 60, reps: 10, rir }), ...extra]),
    se('barbell-bench-press', [S({ weightKg: 60, reps: 10, rir }), S({ weightKg: 60, reps: 10, rir })]),
  ];
  it('reproduced defect fixed: no "at the target effort" claim when RIR/RPE wasn’t recorded', () => {
    const s = suggestNext(bench, rx, hist(null), { unit: 'kg' });
    expect(s.action).toBe('increase_load');
    expect(s.reason).not.toMatch(/at the target effort/);
    expect(s.reason).toMatch(/effort wasn’t logged/);
    expect(s.effortBasis).toBe('not_recorded');
  });
  it('says "at the target effort" only when effort was recorded', () => {
    const s = suggestNext(bench, rx, hist(2), { unit: 'kg' });
    expect(s.reason).toMatch(/at the target effort/);
    expect(s.effortBasis).toBe('recorded');
  });
  it('invalid sets are not working sets and are ignored', () => {
    const x = se('barbell-bench-press', [S({ weightKg: 60, reps: 0 }), S({ weightKg: 60, reps: 8 }), S({ type: 'warmup', weightKg: 20, reps: 8 })]);
    expect(workingSets(x, bench)).toHaveLength(1);
    const sessions = [base('z', [x])];
    expect(comparableHistory(sessions, 'barbell-bench-press')).toHaveLength(1);
    const onlyInvalid = [base('q', [se('barbell-bench-press', [S({ weightKg: 60, reps: 0 })])])];
    expect(comparableHistory(onlyInvalid, 'barbell-bench-press')).toHaveLength(0);
  });
  it('unrecorded loads never count as reaching the load', () => {
    const h = [
      se('barbell-bench-press', [S({ weightKg: 60, reps: 10 }), S({ weightKg: null, reps: 10 })]),
      se('barbell-bench-press', [S({ weightKg: 60, reps: 10 }), S({ weightKg: 60, reps: 10 })]),
    ];
    expect(suggestNext(bench, rx, h, { unit: 'kg' }).action).not.toBe('increase_load');
  });
});

/* ============================================================ substitution */
describe('substitutions rebuild prescriptions and untouched sets (reproduced defect: Prone floor pulldown → Plank kept reps)', () => {
  const rxReps = { sets: 3, repMin: 8, repMax: 12, targetRir: 2, restSec: 60, slotId: 'slot' };
  const untouched = (exerciseId: string, sets: LoggedSet[], rx: SessionExercise['prescription'] = rxReps) => se(exerciseId, sets, { prescription: rx });

  it('rep → time: Prone floor pulldown → Plank gets a seconds target, timed sets, no reps', () => {
    const before = untouched('prone-lat-pulldown', [S({ completed: false, reps: 10 }), S({ completed: false, reps: 10 })]);
    const after = adaptSessionExercise(before, ex('prone-lat-pulldown'), plank)!;
    expect(after.exerciseId).toBe('plank');
    expect(after.swappedFrom).toBe('prone-lat-pulldown');
    expect(after.prescription).toMatchObject({ sets: 3, restSec: 60, durationSec: 30, slotId: 'slot' });
    expect(after.sets.every((s) => s.type === 'timed' && s.reps == null && s.durationSec === 30)).toBe(true);
    expect(after.sets.map((s) => s.id)).toEqual(before.sets.map((s) => s.id)); // stable ids → no remounts
  });
  it('time → rep: Plank → Dead bug gets a rep range and normal rep sets', () => {
    const before = untouched('plank', [S({ type: 'timed', completed: false, durationSec: 30 })], { sets: 1, repMin: 1, repMax: 1, targetRir: 2, restSec: 60, durationSec: 30 });
    const to = ex('dead-bug');
    const after = adaptSessionExercise(before, plank, to)!;
    expect(after.prescription?.durationSec).toBeUndefined();
    expect(after.prescription!.repMin).toBeGreaterThan(1);
    expect(after.sets[0]).toMatchObject({ type: 'normal', durationSec: null, reps: null });
    expect(to.tracking).not.toBe('duration');
  });
  it('weighted → assisted: load convention reset (no reinterpreted load), warm-ups dropped', () => {
    const before = untouched('lat-pulldown', [S({ type: 'warmup', completed: false, weightKg: 20, reps: 8 }), S({ completed: false, weightKg: 50, reps: 10 })]);
    const after = adaptSessionExercise(before, ex('lat-pulldown'), assisted)!;
    expect(after.sets).toHaveLength(1);
    expect(after.sets[0]).toMatchObject({ type: 'normal', weightKg: null, reps: 10 });
    expect(after.prescription).toMatchObject({ repMin: 8, repMax: 12 });
  });
  it('bilateral → per-hand unilateral: reps cleared (per-side), load cleared', () => {
    const before = untouched('barbell-row', [S({ completed: false, weightKg: 60, reps: 10 })]);
    const oneArm = ex('one-arm-dumbbell-row');
    expect(oneArm.unilateral).toBe(true);
    const after = adaptSessionExercise(before, ex('barbell-row'), oneArm)!;
    expect(after.sets[0]).toMatchObject({ weightKg: null, reps: null });
  });
  it('to bodyweight + added load: starts at 0 added (explicit bodyweight), not a missing value', () => {
    const after = adaptSessionExercise(untouched('lat-pulldown', [S({ completed: false, weightKg: 50, reps: 8 })]), ex('lat-pulldown'), ex('weighted-pull-up'))!;
    expect(after.sets[0].weightKg).toBe(0);
  });
  it('distance/time: rep → carry gets timed sets; carry → bike keeps its time target', () => {
    const toCarry = adaptSessionExercise(untouched('one-arm-dumbbell-row', [S({ completed: false, reps: 10 })]), ex('one-arm-dumbbell-row'), carry)!;
    expect(toCarry.sets[0]).toMatchObject({ type: 'timed', reps: null, durationSec: 40 });
    const rxT = { sets: 2, repMin: 1, repMax: 1, targetRir: 2, restSec: 75, durationSec: 40 };
    const toBike = adaptSessionExercise(untouched('farmer-carry', [S({ type: 'timed', completed: false, durationSec: 40, distanceM: 30 })], rxT), carry, bike)!;
    expect(toBike.prescription?.durationSec).toBe(40);
    expect(toBike.sets[0]).toMatchObject({ type: 'timed', durationSec: 40, distanceM: 30, weightKg: null });
  });
  it('never reinterprets completed sets', () => {
    const done = untouched('prone-lat-pulldown', [S({ completed: true, reps: 10 }), S({ completed: false })]);
    expect(adaptSessionExercise(done, ex('prone-lat-pulldown'), plank)).toBeNull();
    const s = { ...base('x', [done]), status: 'active' as const };
    expect(ops.swapExercise(s, done.id, plank, ex('prone-lat-pulldown'))).toEqual(s);
    expect(adaptPrescription(rxReps, ex('prone-lat-pulldown'), plank)?.durationSec).toBe(30);
  });
  it('default candidates respect equipment, exclusions and limitations', () => {
    const c = { equipment: new Set(['bodyweight', 'band'] as const), excluded: new Set(['band-pulldown']), limitations: new Set<never>() };
    const ids = substitutionCandidates(ex('lat-pulldown'), EXERCISES, { equipment: new Set(c.equipment), excluded: c.excluded });
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const e = ex(id);
      expect(e.equipment.every((q) => q === 'bodyweight' || q === 'band')).toBe(true);
      expect(id).not.toBe('band-pulldown');
    }
    const knee = substitutionCandidates(ex('barbell-back-squat'), EXERCISES, { limitations: new Set(['knee']) });
    expect(knee.every((id) => !ex(id).stresses.includes('knee'))).toBe(true);
    expect(fitsConstraints(bench, undefined)).toBe(true);
  });
});

/* ================================================================ warm-ups */
describe('barbell warm-ups (reproduced defect: 20 kg / 45 lb floor could exceed the working load)', () => {
  it('never at or above the working load; fewer warm-ups when the bar is the working load', () => {
    expect(warmupSets(17.5, bench, 2, 'kg', 2.5)).toEqual([]);
    expect(warmupSets(20, bench, 2, 'kg', 2.5)).toEqual([]);
    expect(warmupSets(22.5, bench, 2, 'kg', 2.5).map((w) => w.entered.value)).toEqual([20]);
    expect(warmupSets(lbToKg(40), bench, 2, 'lb', 5)).toEqual([]);
  });
  it('feasible bar settings: bar + whole increments, rounded down', () => {
    expect(warmupSets(60, bench, 2, 'kg', 2.5).map((w) => [w.entered.value, w.reps])).toEqual([[30, 8], [45, 4]]);
    expect(warmupSets(lbToKg(135), bench, 2, 'lb', 5).map((w) => w.entered.value)).toEqual([65, 100]);
    expect(warmupSets(lbToKg(60), bench, 2, 'lb', 5).map((w) => w.entered.value)).toEqual([45]);
    // a lighter bar set by the user gives a lighter first ramp-up
    expect(warmupSets(lbToKg(60), bench, 2, 'lb', 5, { workout: { ...defaultSettings().workout, barLb: 35 } }).map((w) => w.entered.value)).toEqual([35, 45]);
    expect(warmupSets(30, ex('goblet-squat'), 1, 'kg', 2).map((w) => w.entered.value)).toEqual([14]);
  });
  it('physical load preserved across unit changes (exact kg + entered value)', () => {
    const [w] = warmupSets(lbToKg(135), bench, 2, 'lb', 5);
    expect(w.weightKg).toBeCloseTo(lbToKg(65), 9);
    expect(displayWeight(w.weightKg, 'lb', w.entered)).toBe(65);
    expect(displayWeight(w.weightKg, 'kg', w.entered)).toBe(29.5);
    expect(kgToLb(w.weightKg)).toBeCloseTo(65, 9);
  });
  it('session builder uses the fixed warm-ups (light barbell working load → no heavier warm-up)', () => {
    const t = {
      id: 't', name: 'A', focus: 'A', kind: 'lifting' as const, estimatedMinutes: 30,
      exercises: [{ id: 't:1', exerciseId: 'barbell-bench-press', sets: 3, repMin: 8, repMax: 10, targetRir: 2, restSec: 120, warmup: '', priority: 1 as const, alternatives: [], startLoadKg: 17.5, calibrate: true }],
    };
    const s = buildSessionFromTemplate(t, { catalog: EXERCISES, history: [], settings: defaultSettings(), date: '2026-10-28', timeZone: 'UTC' });
    const sets = s.exercises[0].sets;
    const working = sets.find((x) => x.type !== 'warmup')!.weightKg!;
    for (const w of sets.filter((x) => x.type === 'warmup')) expect(w.weightKg ?? 0).toBeLessThan(working);
  });
});

describe('exercise catalog substitutions are all adaptable', () => {
  it('every listed substitution resolves and produces a prescription for its tracking type', () => {
    const rx = { sets: 3, repMin: 8, repMax: 12, targetRir: 2, restSec: 60 };
    for (const from of EXERCISES as Exercise[]) {
      for (const id of from.substitutions) {
        const to = byId.get(id);
        if (!to) continue; // unresolved ids are covered by exercises.test.ts
        const out = adaptPrescription(rx, from, to)!;
        if (to.tracking === 'duration' || to.tracking === 'distance_time') expect(out.durationSec).toBeGreaterThan(0);
        else expect(out.durationSec).toBeUndefined();
      }
    }
  });
});
