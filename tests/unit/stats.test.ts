import { describe, expect, it } from 'vitest';
import type { Exercise, ID, LoggedSet, Measurement, SessionExercise, WorkoutSession } from '@/domain/types';
import {
  detectRecords, e1rm, e1rmEligible, exerciseSeries, goalProgress, observations, personalRecords, proteinDays, rollingAverage,
  setVolumeKg, summarizeSession, weeklyTotals, weeklyVolume, weeklyWorkingSets, cardioSeries, VOLUME_CONVENTIONS,
} from '@/domain/stats';

/* ------------------------------------------------------------ fixtures */
const base = {
  aliases: [], category: 'compound', secondaryMuscles: [], difficulty: 1, stresses: [], setup: '', execution: '', cues: [], mistakes: [], substitutions: [],
} as const;
const ex = (e: Partial<Exercise> & Pick<Exercise, 'id' | 'tracking' | 'load'>): Exercise =>
  ({ ...base, name: e.id, primaryMuscles: ['chest'], pattern: 'horizontal_push', equipment: [], ...e }) as Exercise;

const BENCH = ex({ id: 'barbell-bench-press', tracking: 'weight_reps', load: 'total', primaryMuscles: ['chest'], secondaryMuscles: ['triceps', 'shoulders'] });
const DB_BENCH = ex({ id: 'dumbbell-bench-press', tracking: 'weight_reps', load: 'per_hand', implements: 2 });
const SPLIT = ex({ id: 'bulgarian-split-squat', tracking: 'weight_reps', load: 'per_hand', implements: 2, unilateral: true, primaryMuscles: ['quads', 'glutes'] });
const ROW1 = ex({ id: 'one-arm-dumbbell-row', tracking: 'weight_reps', load: 'total', unilateral: true, primaryMuscles: ['lats'] });
const LEGPRESS = ex({ id: 'leg-press', tracking: 'weight_reps', load: 'stack', primaryMuscles: ['quads'] });
const WDIP = ex({ id: 'weighted-dip', tracking: 'bodyweight_plus', load: 'added', primaryMuscles: ['triceps'] });
const APU = ex({ id: 'assisted-pull-up', tracking: 'assisted', load: 'assistance', primaryMuscles: ['lats'] });
const PUSHUP = ex({ id: 'push-up', tracking: 'reps', load: 'none' });
const PLANK = ex({ id: 'plank', tracking: 'duration', load: 'none', primaryMuscles: ['abs'] });
const ALL = [BENCH, DB_BENCH, SPLIT, ROW1, LEGPRESS, WDIP, APU, PUSHUP, PLANK];
const byId = new Map<ID, Exercise>(ALL.map((e) => [e.id, e]));

let n = 0;
const set = (p: Partial<LoggedSet>): LoggedSet => ({ id: `set${n++}`, type: 'normal', completed: true, ...p });
const sx = (exerciseId: ID, sets: LoggedSet[]): SessionExercise => ({ id: `se${n++}`, exerciseId, order: 0, sets });
const session = (id: string, date: string, exercises: SessionExercise[], extra: Partial<WorkoutSession> = {}): WorkoutSession => ({
  id, date, name: 'W', status: 'completed', timeZone: 'UTC', startedAt: Date.UTC(2026, 0, 1, 10), endedAt: Date.UTC(2026, 0, 1, 11), pausedTotalMs: 0,
  createdAt: 1, updatedAt: 1, exercises, ...extra,
});

/* -------------------------------------------------------------- tests */
describe('e1RM (Epley)', () => {
  it('computes w × (1 + r/30) for 1–10 reps only', () => {
    expect(e1rm(100, 5)).toBeCloseTo(116.667, 2);
    expect(e1rm(100, 10)).toBeCloseTo(133.333, 2);
    expect(e1rm(100, 1)).toBeCloseTo(103.333, 2);
    expect(e1rm(100, 11)).toBeNull();
    expect(e1rm(100, 0)).toBeNull();
    expect(e1rm(0, 5)).toBeNull();
  });
  it('is only eligible for free-weight weight×reps exercises', () => {
    expect(e1rmEligible(BENCH)).toBe(true);
    expect(e1rmEligible(DB_BENCH)).toBe(true);
    expect(e1rmEligible(LEGPRESS)).toBe(false);
    expect(e1rmEligible(WDIP)).toBe(false);
    expect(e1rmEligible(APU)).toBe(false);
    expect(e1rmEligible(PUSHUP)).toBe(false);
  });
  it('series only carries e1RM for eligible exercises and ≤ 10 reps', () => {
    const s = [
      session('a', '2026-01-01', [sx(BENCH.id, [set({ weightKg: 60, reps: 12 })]), sx(LEGPRESS.id, [set({ weightKg: 100, reps: 8 })])]),
      session('b', '2026-01-03', [sx(BENCH.id, [set({ weightKg: 70, reps: 5 }), set({ weightKg: 60, reps: 12 })])]),
    ];
    const bench = exerciseSeries(s, BENCH.id, BENCH);
    expect(bench[0].bestE1rmKg).toBeNull(); // 12 reps → not estimated
    expect(bench[1].bestE1rmKg).toBeCloseTo(81.667, 2);
    expect(exerciseSeries(s, LEGPRESS.id, LEGPRESS)[0].bestE1rmKg).toBeNull();
  });
});

describe('volume conventions', () => {
  it('excludes warm-ups and incomplete sets from volume and working sets', () => {
    const s = session('s', '2026-01-01', [
      sx(BENCH.id, [set({ type: 'warmup', weightKg: 40, reps: 10 }), set({ weightKg: 80, reps: 5 }), set({ weightKg: 80, reps: 5, completed: false })]),
    ]);
    const sum = summarizeSession(s, byId);
    expect(sum.warmupSets).toBe(1);
    expect(sum.workingSets).toBe(1);
    expect(sum.totalReps).toBe(5);
    expect(sum.volume.freeWeightKg).toBe(400);
    expect(setVolumeKg(set({ type: 'warmup', weightKg: 40, reps: 10 }), BENCH)).toBe(0);
  });
  it('counts both dumbbells for per-hand loads (implements × 2)', () => {
    expect(setVolumeKg(set({ weightKg: 20, reps: 10 }), DB_BENCH)).toBe(400);
  });
  it('counts both sides for unilateral exercises', () => {
    // 15 kg per side, 10 reps per side, one dumbbell: 15 × 10 × 2 sides
    expect(setVolumeKg(set({ weightKg: 15, reps: 10 }), ROW1)).toBe(300);
    // pair of 10 kg dumbbells, 8 reps per leg: 10 × 8 × 2 implements × 2 sides
    expect(setVolumeKg(set({ weightKg: 10, reps: 8 }), SPLIT)).toBe(320);
    expect(VOLUME_CONVENTIONS.join(' ')).toMatch(/per side/);
  });
  it('keeps machine volume separate from free weights and added load separate again', () => {
    const s = session('s', '2026-01-01', [
      sx(BENCH.id, [set({ weightKg: 100, reps: 5 })]),
      sx(LEGPRESS.id, [set({ weightKg: 150, reps: 10 })]),
      sx(WDIP.id, [set({ weightKg: 20, reps: 8 })]),
    ]);
    const v = summarizeSession(s, byId).volume;
    expect(v).toEqual({ freeWeightKg: 500, machineKg: 1500, addedBodyweightKg: 160 });
  });
  it('excludes assisted and pure bodyweight from load volume but counts their reps', () => {
    const s = session('s', '2026-01-01', [sx(APU.id, [set({ weightKg: 30, reps: 8 })]), sx(PUSHUP.id, [set({ reps: 20 })])]);
    const sum = summarizeSession(s, byId);
    expect(sum.volume).toEqual({ freeWeightKg: 0, machineKg: 0, addedBodyweightKg: 0 });
    expect(sum.bodyweightReps).toBe(28);
    expect(setVolumeKg(set({ weightKg: 30, reps: 8 }), APU)).toBe(0);
  });
  it('aggregates weekly volume by the chosen week start', () => {
    // 2026-01-04 is a Sunday; with Monday week start it belongs to the week of 2025-12-29.
    const s = [session('a', '2026-01-04', [sx(BENCH.id, [set({ weightKg: 100, reps: 5 })])]), session('b', '2026-01-05', [sx(LEGPRESS.id, [set({ weightKg: 100, reps: 10 })])])];
    const w = weeklyVolume(s, byId, 1, '2025-12-29', '2026-01-11');
    expect(w.map((x) => x.week)).toEqual(['2025-12-29', '2026-01-05']);
    expect(w[0].freeWeightKg).toBe(500);
    expect(w[1].machineKg).toBe(1000);
    const sunday = weeklyVolume(s, byId, 0, '2026-01-04', '2026-01-10');
    expect(sunday).toHaveLength(1);
    expect(sunday[0].freeWeightKg).toBe(500);
    expect(sunday[0].machineKg).toBe(1000);
  });
});

describe('weekly working sets by muscle', () => {
  it('counts primary muscles as 1 and secondary as 0.5, warm-ups excluded', () => {
    const s = [session('a', '2026-01-05', [sx(BENCH.id, [set({ type: 'warmup', weightKg: 40, reps: 10 }), set({ weightKg: 80, reps: 5 }), set({ weightKg: 80, reps: 5 })])])];
    const w = weeklyWorkingSets(s, byId, 1, '2026-01-05', '2026-01-11');
    expect(w[0].total).toBe(2);
    expect(w[0].muscles.chest).toBe(2);
    expect(w[0].muscles.triceps).toBe(1);
    expect(w[0].muscles.shoulders).toBe(1);
  });
});

describe('records', () => {
  const h1 = session('h1', '2026-01-01', [
    sx(BENCH.id, [set({ weightKg: 80, reps: 5 }), set({ weightKg: 70, reps: 8 })]),
    sx(APU.id, [set({ weightKg: 30, reps: 8 })]),
    sx(PUSHUP.id, [set({ reps: 20 })]),
    sx(PLANK.id, [set({ type: 'timed', durationSec: 60 })]),
  ]);
  it('detects heaviest, e1RM, reps-at-weight, most reps, duration and least assistance', () => {
    const cur = session('c', '2026-01-08', [
      sx(BENCH.id, [set({ type: 'warmup', weightKg: 120, reps: 1 }), set({ weightKg: 82.5, reps: 5 }), set({ weightKg: 70, reps: 10 })]),
      sx(APU.id, [set({ weightKg: 25, reps: 8 })]),
      sx(PUSHUP.id, [set({ reps: 22 })]),
      sx(PLANK.id, [set({ type: 'timed', durationSec: 75 })]),
    ]);
    const hits = detectRecords(cur, [h1], byId, 'kg');
    const kinds = hits.map((h) => `${h.exerciseId}:${h.kind}`);
    expect(kinds).toContain('barbell-bench-press:heaviest');
    expect(hits.find((h) => h.kind === 'heaviest')!.value).toBe(82.5); // warm-up 120 kg ignored
    expect(kinds).toContain('barbell-bench-press:e1rm');
    expect(kinds).toContain('barbell-bench-press:reps_at_weight');
    expect(hits.find((h) => h.kind === 'reps_at_weight')!.label).toMatch(/10 reps at 70 kg/);
    expect(kinds).toContain('push-up:most_reps');
    expect(kinds).toContain('plank:longest_duration');
    const la = hits.find((h) => h.kind === 'least_assistance')!;
    expect(la.exerciseId).toBe(APU.id);
    expect(la.value).toBe(25);
  });
  it('more assistance is not a record', () => {
    const cur = session('c', '2026-01-08', [sx(APU.id, [set({ weightKg: 35, reps: 10 })])]);
    expect(detectRecords(cur, [h1], byId, 'kg').filter((h) => h.kind === 'least_assistance')).toHaveLength(0);
  });
  it('compares only within the same exercise', () => {
    // Heavy dumbbell bench should not be compared with barbell bench history.
    const cur = session('c', '2026-01-08', [sx(DB_BENCH.id, [set({ weightKg: 90, reps: 5 })])]);
    expect(detectRecords(cur, [h1], byId, 'kg')).toEqual([]);
    // Bench at a lower weight than history: no record even though DB bench was heavy elsewhere.
    const cur2 = session('c2', '2026-01-09', [sx(BENCH.id, [set({ weightKg: 75, reps: 5 })])]);
    expect(detectRecords(cur2, [h1, cur], byId, 'kg').filter((h) => h.kind === 'heaviest')).toEqual([]);
  });
  it('ignores the session itself, active sessions and tombstones in history', () => {
    const cur = session('c', '2026-01-08', [sx(BENCH.id, [set({ weightKg: 85, reps: 5 })])]);
    const deleted = session('d', '2026-01-02', [sx(BENCH.id, [set({ weightKg: 200, reps: 5 })])], { deletedAt: 5 });
    const active = session('x', '2026-01-03', [sx(BENCH.id, [set({ weightKg: 200, reps: 5 })])], { status: 'active' });
    expect(detectRecords(cur, [h1, cur, deleted, active], byId, 'kg').some((h) => h.kind === 'heaviest')).toBe(true);
  });
  it('a first-ever session is a baseline, not a record', () => {
    const cur = session('c', '2026-01-08', [sx(WDIP.id, [set({ weightKg: 10, reps: 8 })])]);
    expect(detectRecords(cur, [h1], byId, 'kg')).toEqual([]);
  });
  it('editing a historical set updates summaries and records', () => {
    const old = session('o', '2026-01-01', [sx(BENCH.id, [set({ weightKg: 80, reps: 5 })])]);
    const recent = session('r', '2026-01-08', [sx(BENCH.id, [set({ weightKg: 85, reps: 5 })])]);
    expect(detectRecords(recent, [old], byId, 'kg').some((h) => h.kind === 'heaviest')).toBe(true);
    expect(personalRecords([old, recent], BENCH, 'kg').find((r) => r.kind === 'heaviest')!.date).toBe('2026-01-08');
    // Correct a typo in the old session: it was actually 90 kg.
    const corrected: WorkoutSession = { ...old, exercises: [{ ...old.exercises[0], sets: [{ ...old.exercises[0].sets[0], weightKg: 90 }] }] };
    expect(detectRecords(recent, [corrected], byId, 'kg').some((h) => h.kind === 'heaviest')).toBe(false);
    const pr = personalRecords([corrected, recent], BENCH, 'kg').find((r) => r.kind === 'heaviest')!;
    expect(pr.value).toBe(90);
    expect(pr.date).toBe('2026-01-01');
    expect(summarizeSession(corrected, byId).volume.freeWeightKg).toBe(450);
  });
  it('uses the entered unit for labels', () => {
    const lb = (v: number) => ({ value: v, unit: 'lb' as const });
    const old = session('o', '2026-01-01', [sx(BENCH.id, [set({ weightKg: 102.058, entered: lb(225), reps: 5 })])]);
    const cur = session('c', '2026-01-08', [sx(BENCH.id, [set({ weightKg: 104.326, entered: lb(230), reps: 5 })])]);
    expect(detectRecords(cur, [old], byId, 'lb').find((h) => h.kind === 'heaviest')!.label).toMatch(/230 lb × 5/);
  });
  it('personal records label assisted bests as least assistance', () => {
    const s = [session('a', '2026-01-01', [sx(APU.id, [set({ weightKg: 30, reps: 8 })])]), session('b', '2026-01-05', [sx(APU.id, [set({ weightKg: 20, reps: 6 })])])];
    const pr = personalRecords(s, APU, 'kg').find((r) => r.kind === 'least_assistance')!;
    expect(pr.value).toBe(20);
    expect(pr.date).toBe('2026-01-05');
  });
});

describe('rolling average', () => {
  it('averages a trailing calendar window', () => {
    const pts = [
      { date: '2026-01-01', value: 80 },
      { date: '2026-01-03', value: 82 },
      { date: '2026-01-07', value: 81 },
      { date: '2026-01-09', value: 79 },
    ];
    const r = rollingAverage(pts, 7);
    expect(r[0].avg).toBe(80);
    expect(r[1].avg).toBe(81);
    expect(r[2].avg).toBeCloseTo(81, 5); // 1st–7th
    expect(r[3].avg).toBeCloseTo(80.6667, 3); // 3rd–9th
  });
});

describe('cardio & weekly totals', () => {
  const acts = [
    { id: 'a1', type: 'run', date: '2026-01-05', durationSec: 1500, distanceM: 5000, timeZone: 'UTC', createdAt: 1, updatedAt: 1 },
    { id: 'a2', type: 'walk', date: '2026-01-06', durationSec: 3600, timeZone: 'UTC', createdAt: 2, updatedAt: 2 },
    { id: 'a3', type: 'run', date: '2026-01-07', durationSec: 3000, distanceM: 10000, timeZone: 'UTC', createdAt: 3, updatedAt: 3, deletedAt: 9 },
  ] as const;
  it('computes pace per km and filters by type and tombstones', () => {
    const runs = cardioSeries([...acts], 'run');
    expect(runs).toHaveLength(1);
    expect(runs[0].paceSecPerKm).toBe(300);
    expect(runs[0].speedKmh).toBe(12);
    expect(cardioSeries([...acts]).find((p) => p.id === 'a2')!.paceSecPerKm).toBeNull();
  });
  it('sums weekly minutes and distance', () => {
    const w = weeklyTotals([], [...acts], 1, '2026-01-05', '2026-01-11');
    expect(w).toHaveLength(1);
    expect(w[0].activities).toBe(2);
    expect(w[0].activityMinutes).toBe(85);
    expect(w[0].distanceM).toBe(5000);
  });
});

describe('protein days', () => {
  it('treats days without logs as no data, not zero', () => {
    const logs = [
      { id: '1', date: '2026-01-01', meal: 'lunch', name: 'x', source: { kind: 'quick' }, protein: 100, createdAt: 1, updatedAt: 1 },
      { id: '2', date: '2026-01-01', meal: 'dinner', name: 'y', source: { kind: 'quick' }, protein: 90, createdAt: 1, updatedAt: 1 },
      { id: '3', date: '2026-01-02', meal: 'lunch', name: 'z', source: { kind: 'quick' }, protein: 50, createdAt: 1, updatedAt: 1 },
      { id: '4', date: '2026-01-03', meal: 'lunch', name: 'kcal only', source: { kind: 'quick' }, kcal: 500, createdAt: 1, updatedAt: 1 },
    ] as const;
    const d = proteinDays([...logs], '2026-01-01', '2026-01-04', 180);
    expect(d.map((x) => x.met)).toEqual([true, false, null, null]);
    expect(d[3].proteinG).toBeNull();
  });
});

describe('goals', () => {
  const ctxBase = { activities: [], measurements: [] as Measurement[], foodLogs: [], byId, today: '2026-01-08', weekStart: 1 as const, unit: 'kg' as const };
  it('sessions per week counts completed workouts this week', () => {
    const s = [session('a', '2026-01-05', []), session('b', '2026-01-07', []), session('c', '2026-01-01', [])];
    const g = goalProgress({ id: 'g', createdAt: 0, updatedAt: 0, title: '', kind: 'sessions_per_week', target: 3 }, { ...ctxBase, sessions: s });
    expect(g.current).toBe(2);
    expect(g.fraction).toBeCloseTo(2 / 3);
    expect(g.reached).toBe(false);
  });
  it('exercise load goal uses best working set; assisted goal treats lower as better', () => {
    const s = [session('a', '2026-01-05', [sx(BENCH.id, [set({ weightKg: 95, reps: 3 }), set({ type: 'warmup', weightKg: 120, reps: 1 })]), sx(APU.id, [set({ weightKg: 40, reps: 5 })])]),
      session('b', '2026-01-07', [sx(APU.id, [set({ weightKg: 20, reps: 5 })])])];
    const g = goalProgress({ id: 'g', createdAt: 0, updatedAt: 0, title: '', kind: 'exercise_load', exerciseId: BENCH.id, target: 100 }, { ...ctxBase, sessions: s });
    expect(g.current).toBe(95);
    const a = goalProgress({ id: 'g', createdAt: 0, updatedAt: 0, title: '', kind: 'exercise_load', exerciseId: APU.id, target: 0 }, { ...ctxBase, sessions: s });
    expect(a.current).toBe(20);
    expect(a.fraction).toBeCloseTo(0.5);
  });
});

describe('observations', () => {
  const bw = (date: string, value: number): Measurement => ({ id: date, kind: 'bodyweight', date, value, createdAt: 1, updatedAt: 1 });
  it('reports plan adherence and bodyweight average with a signed delta', () => {
    const ms = [bw('2026-01-01', 81.8), bw('2026-01-03', 81.4), bw('2026-01-05', 81.0), bw('2026-01-08', 81.4)];
    const o = observations({ sessions: [], activities: [], measurements: ms, today: '2026-01-10', weekStart: 1, unit: 'kg', plan: { planned: 4, completed: 3 } });
    expect(o).toContain('You completed 3 of 4 planned sessions this week.');
    // last 7 days (4th–10th): 81.0, 81.4 → 81.2 ; previous (Dec 28–3rd): 81.8, 81.4 → 81.6
    expect(o).toContain('Bodyweight 7-day average: 81.2 kg (−0.4 kg vs last week)');
  });
  it('mentions this week’s workouts and activity minutes, and states when nothing is logged', () => {
    const o = observations({
      sessions: [session('a', '2026-01-06', [sx(BENCH.id, [set({ weightKg: 60, reps: 8 })])])],
      activities: [{ id: 'r', type: 'run', date: '2026-01-07', durationSec: 1800, timeZone: 'UTC', createdAt: 1, updatedAt: 1 }],
      measurements: [], today: '2026-01-08', weekStart: 1, unit: 'kg', byId,
    });
    expect(o).toContain('This week you’ve logged 1 workout and 1 other activity.');
    expect(o).toContain('Activity time this week: 30 min (+30 min vs last week).');
    expect(o).toContain('Working sets this week: 1 (last week: 0).');
    expect(observations({ sessions: [], activities: [], measurements: [], today: '2026-01-08', weekStart: 1, unit: 'kg' })).toEqual(['No workouts or activities logged yet.']);
    expect(o.join(' ')).not.toMatch(/recovery|muscle gained/i);
  });
});
