import { describe, expect, it } from 'vitest';
import { EXERCISES } from '@/data/exercises';
import { chooseSplit, consecutivePairs, estimateSessionMinutes, generateProgram, regenerateTemplates } from '@/domain/program/generator';
import { COVERAGE_GROUPS } from '@/domain/program/templates';
import { createProgram, currentVersion, restoreVersion, templateById, withNewVersion } from '@/domain/program/program';
import { buildSessionFromTemplate } from '@/domain/program/session';
import { defaultSettings } from '@/state/defaults';
import type { Equipment, Exercise, OnboardingAnswers, ProgramVersion, SessionTemplate, WorkoutSession } from '@/domain/types';

const byId = new Map(EXERCISES.map((e) => [e.id, e]));
const START = '2026-11-02'; // a Monday

function answers(over: Partial<OnboardingAnswers> = {}): OnboardingAnswers {
  return {
    displayName: 'Test',
    units: { weight: 'kg', length: 'cm', distance: 'km' },
    goal: 'build_muscle',
    experience: 'intermediate',
    totalDaysPerWeek: 3,
    liftingDaysPerWeek: 3,
    availableWeekdays: [0, 1, 2, 3, 4, 5, 6],
    preferredLiftingWeekdays: [],
    sessionMinutes: 60,
    location: 'full_gym',
    equipment: [],
    preferredActivities: [],
    enjoyedExerciseIds: [],
    excludedExerciseIds: [],
    limitations: [],
    activityLevel: 'moderate',
    wantsNutrition: false,
    diet: { tags: [], allergens: [], dislikedIngredientIds: [], maxCookMinutes: 30, budget: 'any', mealsPerDay: 3 },
    ...over,
  };
}
const gen = (over: Partial<OnboardingAnswers> = {}, variant = 0) => generateProgram(answers(over), EXERCISES, { startDate: START, variant });
const lifting = (v: ProgramVersion) => v.templates.filter((t) => t.kind === 'lifting');
const liftingSlots = (v: ProgramVersion) => v.schedule.filter((s) => v.templates.find((t) => t.id === s.templateId)?.kind === 'lifting');
const allRx = (v: ProgramVersion) => v.templates.flatMap((t) => t.exercises);
const exOf = (id: string) => byId.get(id) as Exercise;

describe('catalog under test', () => {
  it('is the real curated catalog', () => {
    expect(EXERCISES.length).toBeGreaterThanOrEqual(60);
  });
});

describe('template choice by lifting days', () => {
  const expected: Record<number, string> = { 1: 'fb1', 2: 'fb2', 3: 'fb3', 4: 'ul4', 5: 'ulppl', 6: 'ppl6' };
  for (const n of [1, 2, 3, 4, 5, 6]) {
    it(`${n} lifting day(s) → ${expected[n]}`, () => {
      const v = gen({ liftingDaysPerWeek: n, totalDaysPerWeek: n });
      expect(liftingSlots(v)).toHaveLength(n);
      expect(lifting(v).every((t) => t.id.startsWith(`${expected[n]}:`))).toBe(true);
      expect(lifting(v)).toHaveLength(n === 6 ? 6 : n === 5 ? 5 : n);
    });
  }

  // Updated (repair brief §2): the old expectation encoded the defect — variant parity switched 3-day
  // plans to ulf for experienced users only. Now the split comes from the explicit choice; every level can pick it.
  it('3 days: upper/lower/full is an explicit choice for every level; the variant never changes the split', () => {
    expect(chooseSplit(answers({ experience: 'advanced' }), 1).split?.key).toBe('fb3');
    expect(chooseSplit(answers({ experience: 'advanced', splitPreference: 'ulf' }), 0).split?.key).toBe('ulf');
    expect(chooseSplit(answers({ experience: 'new', splitPreference: 'ulf' }), 1).split?.key).toBe('ulf');
    expect(chooseSplit(answers({ experience: 'new' }), 1).split?.key).toBe('fb3');
  });

  it('5 days for a beginner: recommends 4 but keeps the choice', () => {
    const v = gen({ experience: 'new', liftingDaysPerWeek: 5, totalDaysPerWeek: 5 });
    expect(liftingSlots(v)).toHaveLength(5);
    expect(v.warnings.join(' ')).toMatch(/4 days/);
  });

  it('6 days for a beginner: recommends fewer but keeps PPL×2', () => {
    const v = gen({ experience: 'returning', liftingDaysPerWeek: 6, totalDaysPerWeek: 6 });
    expect(liftingSlots(v)).toHaveLength(6);
    expect(lifting(v)[0].id.startsWith('ppl6:')).toBe(true);
    expect(v.warnings.join(' ')).toMatch(/3–4 days/);
  });

  it('separates total activity days from lifting days', () => {
    const v = gen({ liftingDaysPerWeek: 2, totalDaysPerWeek: 5 });
    expect(liftingSlots(v)).toHaveLength(2);
    expect(v.schedule).toHaveLength(5);
  });
});

describe('equipment, exclusions and limitations', () => {
  const cases: { name: string; equipment: Equipment[] }[] = [
    { name: 'bodyweight only', equipment: ['bodyweight'] },
    { name: 'dumbbells only', equipment: ['dumbbell'] },
    { name: 'bands only', equipment: ['band'] },
  ];
  for (const c of cases) {
    for (const days of [2, 3, 4]) {
      it(`${c.name}, ${days} days: never barbell/machine/cable exercises (incl. alternatives)`, () => {
        const v = gen({ location: 'minimal', equipment: c.equipment, liftingDaysPerWeek: days, totalDaysPerWeek: days });
        const allowed = new Set<Equipment>([...c.equipment, 'bodyweight']);
        const ids = allRx(v).flatMap((rx) => [rx.exerciseId, ...rx.alternatives]);
        expect(allRx(v).length).toBeGreaterThan(0);
        for (const id of ids) {
          const ex = exOf(id);
          expect(ex.equipment.every((e) => allowed.has(e)), `${id} needs ${ex.equipment.join('+')}`).toBe(true);
          expect(ex.equipment.some((e) => ['barbell', 'machine', 'cable', 'rack', 'smith'].includes(e))).toBe(false);
        }
      });
    }
  }

  it('home gym with barbell & rack uses them but never machines', () => {
    const v = gen({ location: 'home_gym', equipment: ['barbell', 'rack', 'bench', 'dumbbell', 'pullup_bar'] });
    const ids = allRx(v).map((r) => r.exerciseId);
    expect(ids).toContain('barbell-back-squat');
    expect(ids.every((id) => !exOf(id).equipment.includes('machine') && !exOf(id).equipment.includes('cable'))).toBe(true);
  });

  it('excluded exercises are never selected or offered as alternatives', () => {
    const excluded = ['barbell-back-squat', 'barbell-bench-press', 'lat-pulldown', 'plank'];
    const v = gen({ excludedExerciseIds: excluded, liftingDaysPerWeek: 4, totalDaysPerWeek: 4 });
    const ids = allRx(v).flatMap((rx) => [rx.exerciseId, ...rx.alternatives]);
    for (const id of excluded) expect(ids).not.toContain(id);
    expect(v.rationale.join(' ')).toMatch(/excluded/);
  });

  it('limitations: nothing that commonly loads the area, with a non-diagnostic note', () => {
    const v = gen({ limitations: ['knee', 'shoulder'] });
    for (const rx of allRx(v)) {
      const ex = exOf(rx.exerciseId);
      expect(ex.stresses.includes('knee') || ex.stresses.includes('shoulder'), rx.exerciseId).toBe(false);
      for (const alt of rx.alternatives) expect(exOf(alt).stresses.some((s) => s === 'knee' || s === 'shoulder'), alt).toBe(false);
    }
    expect(v.rationale.join(' ')).toMatch(/isn’t a diagnosis/);
    // every squat/lunge stresses the knee in the catalog → reported as a gap, not silently ignored
    expect(v.warnings.join(' ')).toMatch(/squat or lunge/);
  });

  it('enjoyed exercises are preferred when they fit', () => {
    const v = gen({ enjoyedExerciseIds: ['hack-squat'] });
    expect(allRx(v).map((r) => r.exerciseId)).toContain('hack-squat');
  });

  it('brand-new lifters never get technically demanding (difficulty 3) lifts', () => {
    const v = gen({ experience: 'new', liftingDaysPerWeek: 4, totalDaysPerWeek: 4 });
    expect(allRx(v).every((rx) => exOf(rx.exerciseId).difficulty < 3)).toBe(true);
  });
});

describe('weekdays', () => {
  it('only uses the available weekdays', () => {
    const avail = [1, 3, 5, 6];
    const v = gen({ availableWeekdays: avail, liftingDaysPerWeek: 3, totalDaysPerWeek: 4 });
    expect(v.schedule.every((s) => avail.includes(s.weekday))).toBe(true);
    expect(new Set(v.schedule.map((s) => s.weekday)).size).toBe(v.schedule.length);
  });

  it('caps lifting days to the available days and warns', () => {
    const v = gen({ availableWeekdays: [2, 4], liftingDaysPerWeek: 4, totalDaysPerWeek: 4 });
    expect(liftingSlots(v)).toHaveLength(2);
    expect(v.warnings.join(' ')).toMatch(/available/);
  });

  it('beginners: no back-to-back lifting when avoidable', () => {
    for (const n of [2, 3]) {
      const v = gen({ experience: 'new', liftingDaysPerWeek: n, totalDaysPerWeek: n });
      expect(consecutivePairs(liftingSlots(v).map((s) => s.weekday))).toHaveLength(0);
      expect(v.warnings.join(' ')).not.toMatch(/back-to-back/);
    }
  });

  it('beginners: warns when back-to-back is unavoidable', () => {
    const v = gen({ experience: 'new', availableWeekdays: [1, 2, 3], liftingDaysPerWeek: 3, totalDaysPerWeek: 3 });
    expect(liftingSlots(v).map((s) => s.weekday).sort()).toEqual([1, 2, 3]);
    expect(v.warnings.join(' ')).toMatch(/back-to-back/);
  });

  it('honours preferred lifting days', () => {
    const v = gen({ preferredLiftingWeekdays: [2, 4, 6] });
    expect(liftingSlots(v).map((s) => s.weekday).sort()).toEqual([2, 4, 6]);
  });

  it('every-day activity adds easy walk / mobility days, one session per day', () => {
    const v = gen({ experience: 'new', liftingDaysPerWeek: 3, totalDaysPerWeek: 7 });
    expect(v.schedule).toHaveLength(7);
    expect(new Set(v.schedule.map((s) => s.weekday)).size).toBe(7);
    const easy = v.schedule.map((s) => v.templates.find((t) => t.id === s.templateId)!).filter((t) => t.kind !== 'lifting');
    expect(easy).toHaveLength(4);
    expect(easy.every((t) => ['walk', 'mobility', 'cardio'].includes(t.kind))).toBe(true);
    expect(easy.some((t) => t.kind === 'walk')).toBe(true);
    expect(easy.some((t) => t.kind === 'mobility')).toBe(true);
  });

  it('uses a preferred cardio activity on easy days', () => {
    const v = gen({ liftingDaysPerWeek: 2, totalDaysPerWeek: 4, preferredActivities: ['cycle'] });
    expect(v.templates.some((t) => t.cardio?.activity === 'cycle')).toBe(true);
  });
});

describe('session time budget', () => {
  it('estimate includes general warm-up, setup, ramp-up sets and rest', () => {
    const t: SessionTemplate = {
      id: 't', name: 'T', focus: 'x', kind: 'lifting', estimatedMinutes: 0,
      exercises: [{ id: 's', exerciseId: 'barbell-back-squat', sets: 3, repMin: 5, repMax: 5, targetRir: 2, restSec: 180, warmup: '', priority: 1, alternatives: [] }],
    };
    // 300 s warm-up + 120 s setup + 2 ramp-up sets × 100 s + 3 × (5 reps × 4 s + 10 s) + 2 × 180 s rest = 1070 s → 18 min
    expect(estimateSessionMinutes(t, EXERCISES)).toBe(18);
    const longerRest = { ...t, exercises: [{ ...t.exercises[0], restSec: 300 }] };
    expect(estimateSessionMinutes(longerRest, EXERCISES)).toBe(22);
  });

  it('trims priority-3 accessories first to fit the budget', () => {
    const roomy = gen({ liftingDaysPerWeek: 4, totalDaysPerWeek: 4, sessionMinutes: 90 });
    const tight = gen({ liftingDaysPerWeek: 4, totalDaysPerWeek: 4, sessionMinutes: 45 });
    for (const t of lifting(tight)) {
      expect(t.estimatedMinutes).toBeLessThanOrEqual(45);
      expect(t.estimatedMinutes).toBe(estimateSessionMinutes(t, EXERCISES));
      const full = roomy.templates.find((x) => x.id === t.id)!;
      expect(full.trimmedExerciseIds ?? []).toHaveLength(0);
      for (const id of t.trimmedExerciseIds ?? []) expect(full.exercises.find((r) => r.exerciseId === id)?.priority).toBe(3);
      // main lifts survive
      expect(t.exercises.filter((r) => r.priority === 1).length).toBe(full.exercises.filter((r) => r.priority === 1).length);
    }
    expect(lifting(tight).some((t) => (t.trimmedExerciseIds ?? []).length > 0)).toBe(true);
    expect(tight.warnings.join(' ')).toMatch(/To fit 45 minutes/);
  });

  it('short 30-minute sessions still fit', () => {
    const v = gen({ experience: 'new', sessionMinutes: 30 });
    for (const t of lifting(v)) expect(t.estimatedMinutes).toBeLessThanOrEqual(30);
  });
});

describe('coverage and prescriptions', () => {
  for (const n of [2, 3, 4, 5, 6]) {
    it(`${n} days, full gym: every major movement pattern appears across the week`, () => {
      const v = gen({ liftingDaysPerWeek: n, totalDaysPerWeek: n });
      const patterns = new Set(allRx(v).map((r) => exOf(r.exerciseId).pattern));
      for (const g of COVERAGE_GROUPS) expect(g.patterns.some((p) => patterns.has(p)), g.label).toBe(true);
      expect(v.rationale.join(' ')).toMatch(/trained about 2× or more a week/);
    });
  }

  it('1 day explains the once-a-week compromise', () => {
    const v = gen({ liftingDaysPerWeek: 1, totalDaysPerWeek: 1 });
    expect(v.rationale.join(' ')).toMatch(/once a week/);
  });

  it('beginners: 2–3 working sets, RIR 3, moderate reps; rest 2–3 min main / 60–90 s accessories', () => {
    const v = gen({ experience: 'new' });
    for (const rx of allRx(v).filter((r) => lifting(v).some((t) => t.exercises.includes(r)))) {
      expect(rx.sets).toBeGreaterThanOrEqual(2);
      expect(rx.sets).toBeLessThanOrEqual(3);
      expect(rx.targetRir).toBe(3);
      if (rx.priority === 1) expect(rx.restSec).toBeGreaterThanOrEqual(120);
      if (rx.priority === 3) expect(rx.restSec).toBeLessThanOrEqual(90);
      expect(rx.warmup.length).toBeGreaterThan(10);
      if (!rx.durationSec && rx.priority !== 3) expect(rx.repMax).toBeLessThanOrEqual(12);
    }
  });

  it('experienced strength goal: main lifts 3–6 reps, accessories 10–15', () => {
    const v = gen({ experience: 'advanced', goal: 'strength', liftingDaysPerWeek: 4, totalDaysPerWeek: 4 });
    const mainLoaded = allRx(v).filter((r) => r.priority === 1 && exOf(r.exerciseId).tracking === 'weight_reps');
    expect(mainLoaded.length).toBeGreaterThan(0);
    for (const rx of mainLoaded) {
      expect(rx.repMin).toBeGreaterThanOrEqual(3);
      expect(rx.repMax).toBeLessThanOrEqual(6);
      expect(rx.restSec).toBeGreaterThanOrEqual(120);
    }
    for (const rx of allRx(v).filter((r) => r.priority === 3 && exOf(r.exerciseId).tracking === 'weight_reps')) {
      expect([rx.repMin, rx.repMax]).toEqual([10, 15]);
    }
  });

  it('starting loads only from known loads; otherwise calibration (never from age/bodyweight)', () => {
    const v = gen({ age: 30, weightKg: 90, heightCm: 185, knownLoads: { 'barbell-back-squat': 60 } });
    const squat = allRx(v).find((r) => r.exerciseId === 'barbell-back-squat')!;
    expect(squat.startLoadKg).toBe(60);
    expect(squat.calibrate).toBeFalsy();
    const others = allRx(v).filter((r) => r.exerciseId !== 'barbell-back-squat');
    expect(others.every((r) => r.startLoadKg === undefined)).toBe(true);
    const loadedOthers = others.filter((r) => exOf(r.exerciseId).tracking === 'weight_reps');
    expect(loadedOthers.length).toBeGreaterThan(0);
    expect(loadedOthers.every((r) => r.calibrate === true && /calibration/i.test(r.warmup))).toBe(true);
  });

  it('each exercise has substitutions and a priority; block has a review week', () => {
    const v = gen();
    expect(v.weeks).toBeGreaterThanOrEqual(6);
    expect(v.reviewWeek).toBeLessThanOrEqual(v.weeks);
    expect(allRx(v).every((r) => [1, 2, 3].includes(r.priority))).toBe(true);
    expect(allRx(v).filter((r) => r.alternatives.length > 0).length).toBeGreaterThan(allRx(v).length * 0.8);
    expect(v.rationale.join(' ')).toMatch(/product default/);
    expect(v.rationale.join(' ')).not.toMatch(/optimal(?! program)/i);
  });
});

describe('determinism and variants', () => {
  it('same input → identical output, independent of catalog order', () => {
    const a = gen({ liftingDaysPerWeek: 4, totalDaysPerWeek: 6, preferredActivities: ['run'] });
    const b = gen({ liftingDaysPerWeek: 4, totalDaysPerWeek: 6, preferredActivities: ['run'] });
    expect(b).toEqual(a);
    const shuffled = [...EXERCISES].reverse();
    const c = generateProgram(answers({ liftingDaysPerWeek: 4, totalDaysPerWeek: 6, preferredActivities: ['run'] }), shuffled, { startDate: START });
    expect(c).toEqual(a);
  });

  it('a variant gives a different plan, deterministically', () => {
    const a = gen({}, 0);
    const b = gen({}, 1);
    const b2 = gen({}, 1);
    expect(JSON.stringify(b.templates)).not.toEqual(JSON.stringify(a.templates));
    expect(b2).toEqual(b);
  });

  it('regenerateTemplates only changes the selected session', () => {
    const a = answers({ liftingDaysPerWeek: 4, totalDaysPerWeek: 4 });
    const v = generateProgram(a, EXERCISES, { startDate: START });
    const target = v.templates[0];
    const r = regenerateTemplates(v, [target.id], a, EXERCISES, 1);
    expect(r.templates.slice(1)).toEqual(v.templates.slice(1));
    expect(r.schedule).toEqual(v.schedule);
    expect(r.templates[0].id).toBe(target.id);
    expect(r.templates[0].name).toBe(target.name);
    expect(r.templates[0].exercises.map((e) => e.exerciseId)).not.toEqual(target.exercises.map((e) => e.exerciseId));
    expect(r.reason).toMatch(/Regenerated/);
  });
});

describe('endurance-first goal', () => {
  it('builds around the activity with 1–2 supporting strength sessions', () => {
    const v = gen({ goal: 'endurance', liftingDaysPerWeek: 4, totalDaysPerWeek: 5, endurance: { activity: 'run', recentMinutes: 30 } });
    expect(liftingSlots(v).length).toBeLessThanOrEqual(2);
    expect(liftingSlots(v).length).toBeGreaterThanOrEqual(1);
    const cardioSlots = v.schedule.filter((s) => v.templates.find((t) => t.id === s.templateId)?.cardio?.activity === 'run');
    expect(cardioSlots.length).toBe(3);
    const easy = v.templates.find((t) => t.id === 'end:easy')!;
    expect(easy.cardio).toMatchObject({ activity: 'run', minutes: 30, intensity: 'easy' });
    expect(v.templates.find((t) => t.id === 'end:long')!.cardio!.minutes).toBeGreaterThan(30);
    expect(v.warnings.join(' ')).toMatch(/2 supporting strength/);
    expect(v.rationale.join(' ')).toMatch(/Built around your run/);
  });

  it('without a recent duration it starts with a gentle calibration session', () => {
    const v = gen({ goal: 'endurance', liftingDaysPerWeek: 1, totalDaysPerWeek: 3, preferredActivities: ['cycle'] });
    const easy = v.templates.find((t) => t.id === 'end:easy')!;
    expect(easy.cardio!.activity).toBe('cycle');
    expect(easy.cardio!.notes).toMatch(/Calibration/);
  });
});

describe('program versions', () => {
  it('createProgram / withNewVersion / restore never mutate earlier versions', () => {
    const a = answers();
    const v = gen();
    const p = createProgram(a, v, START, 'Full body', 'generated');
    expect(p.currentVersion).toBe(1);
    expect(p.active).toBe(true);
    expect(p.inputs?.goal).toBe('build_muscle');
    const edited = withNewVersion(p, { ...currentVersion(p), reason: 'Renamed', templates: currentVersion(p).templates.map((t, i) => (i === 0 ? { ...t, name: 'Monday' } : t)) });
    expect(edited.currentVersion).toBe(2);
    expect(edited.versions).toHaveLength(2);
    expect(edited.versions[0].templates[0].name).toBe(v.templates[0].name);
    expect(templateById(edited, v.templates[0].id)?.name).toBe('Monday');
    const restored = restoreVersion(edited, 1);
    expect(restored.currentVersion).toBe(3);
    expect(currentVersion(restored).templates[0].name).toBe(v.templates[0].name);
    expect(currentVersion(restored).reason).toMatch(/Restored version 1/);
  });
});

describe('session builder', () => {
  const settings = defaultSettings();
  const ctxBase = { catalog: EXERCISES, settings, date: '2026-11-02', timeZone: 'UTC' };
  const tpl = (): SessionTemplate => lifting(gen({ knownLoads: { 'barbell-bench-press': 50 } }))[0];

  it('creates an active session with warm-ups for main lifts and calibration when no history', () => {
    const t = tpl();
    const s = buildSessionFromTemplate(t, { ...ctxBase, history: [], programId: 'p1', programVersion: 1, plannedDate: '2026-11-02' });
    expect(s.status).toBe('active');
    expect(s.name).toBe(t.name);
    expect(s.templateId).toBe(t.id);
    expect(s.pausedTotalMs).toBe(0);
    expect(Math.abs(s.startedAt - Date.now())).toBeLessThan(5000);
    expect(s.exercises.map((e) => e.exerciseId)).toEqual(t.exercises.map((e) => e.exerciseId));
    const squat = s.exercises.find((e) => e.exerciseId === 'barbell-back-squat')!;
    expect(squat.sets.filter((x) => x.type === 'warmup')).toHaveLength(2);
    expect(squat.sets.filter((x) => x.type === 'normal')).toHaveLength(t.exercises.find((r) => r.exerciseId === 'barbell-back-squat')!.sets);
    expect(squat.sets.every((x) => x.weightKg == null && !x.completed)).toBe(true);
    const bench = s.exercises.find((e) => e.exerciseId === 'barbell-bench-press')!;
    expect(bench.sets.filter((x) => x.type === 'normal').every((x) => x.weightKg === 50)).toBe(true);
    expect(bench.sets.filter((x) => x.type === 'warmup').every((x) => (x.weightKg ?? 0) >= 20 && (x.weightKg ?? 0) < 50)).toBe(true);
    expect(squat.prescription?.slotId).toBe(t.exercises.find((r) => r.exerciseId === 'barbell-back-squat')!.id);
    const ids = s.exercises.flatMap((e) => [e.id, ...e.sets.map((x) => x.id)]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('pre-fills from progression after two top-of-range sessions', () => {
    const t = tpl();
    const rx = t.exercises.find((r) => r.exerciseId === 'barbell-back-squat')!;
    const done = (id: string, startedAt: number): WorkoutSession => ({
      id, createdAt: startedAt, updatedAt: startedAt, name: t.name, status: 'completed', date: '2026-10-20', timeZone: 'UTC', startedAt, pausedTotalMs: 0,
      exercises: [{ id: `${id}-e`, exerciseId: 'barbell-back-squat', order: 0, sets: Array.from({ length: rx.sets }, (_, i) => ({ id: `${id}-${i}`, type: 'normal' as const, weightKg: 60, reps: rx.repMax, completed: true })) }],
    });
    const s = buildSessionFromTemplate(t, { ...ctxBase, history: [done('a', 1000), done('b', 2000)] });
    const squat = s.exercises.find((e) => e.exerciseId === 'barbell-back-squat')!;
    const work = squat.sets.filter((x) => x.type === 'normal');
    expect(work.every((x) => x.weightKg === 62.5 && x.reps === rx.repMin)).toBe(true);
    expect(work[0].entered).toEqual({ value: 62.5, unit: 'kg' });
  });
});

describe('invariants across many inputs', () => {
  it('always yields a valid schedule that respects days, equipment and time', () => {
    const equipments: Equipment[][] = [[], ['dumbbell', 'bench'], ['band', 'pullup_bar'], ['barbell', 'rack', 'bench', 'dumbbell']];
    const goals = ['build_muscle', 'strength', 'lose_fat', 'general_fitness', 'endurance'] as const;
    const exps = ['new', 'returning', 'intermediate', 'advanced'] as const;
    const avails = [[0, 1, 2, 3, 4, 5, 6], [1, 3, 5], [6, 0], [2]];
    let count = 0;
    for (const equipment of equipments)
      for (const goal of goals)
        for (const experience of exps)
          for (const availableWeekdays of avails)
            for (const liftDays of [0, 2, 4, 6]) {
              const total = Math.min(7, liftDays + 2);
              const sessionMinutes = liftDays % 4 === 0 ? 30 : 75;
              const v = gen({ equipment, location: equipment.length ? 'home_gym' : 'minimal', goal, experience, availableWeekdays, liftingDaysPerWeek: liftDays, totalDaysPerWeek: total, sessionMinutes });
              count++;
              const days = v.schedule.map((s) => s.weekday);
              expect(new Set(days).size).toBe(days.length);
              expect(days.every((d) => availableWeekdays.includes(d))).toBe(true);
              expect(v.schedule.every((s) => v.templates.some((t) => t.id === s.templateId))).toBe(true);
              expect(v.templates.every((t) => v.schedule.some((s) => s.templateId === t.id))).toBe(true);
              const allowed = new Set<Equipment>([...equipment, 'bodyweight']);
              for (const rx of allRx(v)) expect(exOf(rx.exerciseId).equipment.every((e) => allowed.has(e))).toBe(true);
              for (const t of lifting(v)) {
                if (t.estimatedMinutes > sessionMinutes) expect(v.warnings.join(' ')).toMatch(/run a little over/);
                expect(new Set(t.exercises.map((r) => r.exerciseId)).size).toBe(t.exercises.length);
              }
              if (goal === 'endurance') expect(liftingSlots(v).length).toBeLessThanOrEqual(2);
              expect(v.rationale.length).toBeGreaterThan(2);
            }
    expect(count).toBe(4 * 5 * 4 * 4 * 4);
  });
});

describe('plan text de-duplication (display helpers)', () => {
  it('per-exercise rows drop the repeated calibration sentence and generic cues; custom text stays', async () => {
    const { exerciseCue, exerciseNote, CALIBRATION_CUE } = await import('@/domain/program/explain');
    const v = gen({ experience: 'new' });
    const rows = lifting(v).flatMap((t) => t.exercises);
    const repeatedBefore = rows.filter((r) => r.warmup.includes(CALIBRATION_CUE)).length;
    expect(repeatedBefore).toBeGreaterThan(3); // the same long sentence on most rows (the reported repetition)
    expect(rows.some((r) => (exerciseCue(r).cue ?? '').includes('Calibration:'))).toBe(false);
    expect(rows.filter((r) => exerciseNote(r)).length).toBe(0);
    // main lifts keep their ramp-up cue
    for (const r of rows.filter((x) => x.priority === 1 && exOf(x.exerciseId).tracking === 'weight_reps')) expect(exerciseCue(r).cue).toMatch(/Ramp up/);
    // coach / user-written text is never hidden
    expect(exerciseCue({ warmup: 'Two easy sets with the bar.' }).cue).toBe('Two easy sets with the bar.');
    expect(exerciseNote({ notes: 'Pause at the bottom.' })).toBe('Pause at the bottom.');
  });
});
