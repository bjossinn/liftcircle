/**
 * Explicit workout-split selection (repair brief §2): catalog per lifting-day count, explicit choice,
 * intent kept across day-count changes, endurance branch, and determinism from visible inputs only.
 */
import { describe, expect, it } from 'vitest';
import { EXERCISES } from '@/data/exercises';
import { chooseSplit, generateProgram, regenerateTemplates } from '@/domain/program/generator';
import { effectiveLiftingDays, recommendedSplit, resolveSplit, splitFamily, splitKeyOfVersion, splitOptions } from '@/domain/program/splits';
import { COVERAGE_GROUPS, SPLITS } from '@/domain/program/templates';
import { createProgram } from '@/domain/program/program';
import { migrateDraft, newDraft, type Draft } from '@/features/onboarding/draft';
import { defaultAccountState } from '@/state/defaults';
import type { AccountState, Experience, OnboardingAnswers, ProgramVersion, SplitKey } from '@/domain/types';

const START = '2026-11-02';
const EXPERIENCES: Experience[] = ['new', 'returning', 'intermediate', 'advanced'];

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
const gen = (a: OnboardingAnswers, variant = 0) => generateProgram(a, EXERCISES, { startDate: START, variant });
const liftingIds = (v: ProgramVersion) => v.templates.filter((t) => t.kind === 'lifting').map((t) => t.id);
const liftingSlots = (v: ProgramVersion) => v.schedule.filter((s) => v.templates.find((t) => t.id === s.templateId)?.kind === 'lifting');

describe('split catalog', () => {
  it('1 lifting day: full body is the only structure', () => {
    for (const experience of EXPERIENCES) {
      const opts = splitOptions(answers({ experience }), 1);
      expect(opts.map((o) => o.key)).toEqual(['fb1']);
      expect(opts[0].recommended).toBe(true);
    }
    // even an explicit upper/lower choice resolves to full body, visibly
    const r = resolveSplit(answers({ splitPreference: 'ul2' }), 1);
    expect(r.key).toBe('fb1');
    expect(r.adjustment?.message).toMatch(/doesn’t fit 1 lifting day/);
  });

  it('2 days offers Full-body A/B and Upper/Lower; 3 days offers Full-body, U/L/F and PPL', () => {
    expect(splitOptions(answers(), 2).map((o) => o.key)).toEqual(['fb2', 'ul2']);
    expect(splitOptions(answers(), 3).map((o) => o.key)).toEqual(['fb3', 'ulf', 'ppl3']);
  });

  it('every day count ≥2 has a non-full-body option, exactly one recommendation and tradeoff text; defs match the day count', () => {
    for (const experience of EXPERIENCES)
      for (const goal of ['build_muscle', 'strength', 'lose_fat', 'general_fitness'] as const)
        for (const n of [2, 3, 4, 5, 6]) {
          const opts = splitOptions(answers({ experience, goal }), n);
          expect(opts.length, `${experience}/${goal}/${n}`).toBeGreaterThanOrEqual(2);
          expect(opts.some((o) => splitFamily(o.key) !== 'full_body')).toBe(true);
          expect(opts.filter((o) => o.recommended)).toHaveLength(1);
          for (const o of opts) {
            expect(o.tradeoff.length).toBeGreaterThan(20);
            expect(SPLITS[o.key].days).toHaveLength(n);
            expect(new Set(SPLITS[o.key].days.map((d) => d.key)).size).toBe(n);
          }
        }
  });

  it('recommended defaults are unchanged for users who never choose (fb1, fb2, fb3, ul4, ulppl, ppl6)', () => {
    const exp: Record<number, SplitKey> = { 1: 'fb1', 2: 'fb2', 3: 'fb3', 4: 'ul4', 5: 'ulppl', 6: 'ppl6' };
    for (const experience of EXPERIENCES) for (const n of [1, 2, 3, 4, 5, 6]) expect(recommendedSplit(answers({ experience }), n)).toBe(exp[n]);
  });
});

describe('every selectable split builds a sound plan', () => {
  it('full gym: all movement patterns covered, sessions fit the time, unique exercises per session', () => {
    const byId = new Map(EXERCISES.map((e) => [e.id, e]));
    for (const experience of EXPERIENCES)
      for (const n of [1, 2, 3, 4, 5, 6])
        for (const o of splitOptions(answers({ experience }), n)) {
          const v = gen(answers({ experience, liftingDaysPerWeek: n, totalDaysPerWeek: n, splitPreference: o.key }));
          const patterns = new Set(v.templates.flatMap((t) => t.exercises.map((r) => byId.get(r.exerciseId)!.pattern)));
          // covered, or (e.g. 1 short day) trimmed to fit the time and reported — never silently missing
          for (const g of COVERAGE_GROUPS) expect(g.patterns.some((p) => patterns.has(p)) || v.warnings.some((w) => w.includes(`No ${g.label} work`)), `${o.key}/${experience}: ${g.label}`).toBe(true);
          if (n >= 2) for (const g of COVERAGE_GROUPS) expect(g.patterns.some((p) => patterns.has(p)), `${o.key}/${experience}: ${g.label}`).toBe(true);
          for (const t of v.templates.filter((x) => x.kind === 'lifting')) {
            expect(new Set(t.exercises.map((r) => r.exerciseId)).size).toBe(t.exercises.length);
            if (t.estimatedMinutes > 60) expect(v.warnings.join(' ')).toMatch(/run a little over/);
          }
          expect(v.templates.every((t) => v.schedule.some((s) => s.templateId === t.id))).toBe(true);
          if (experience === 'new') expect(v.templates.every((t) => t.exercises.every((r) => byId.get(r.exerciseId)!.difficulty < 3))).toBe(true);
        }
  });

  it('once-a-week structures say so honestly (compromise warning)', () => {
    const v = gen(answers({ liftingDaysPerWeek: 2, totalDaysPerWeek: 2, splitPreference: 'ul2' }));
    expect(v.warnings.join(' ')).toMatch(/Compromise: .* once a week/);
    expect(v.rationale.join(' ')).toMatch(/You chose this structure/);
  });
});

describe('explicit choice at 2 and 3 lifting days for every experience level', () => {
  for (const experience of EXPERIENCES)
    for (const n of [2, 3]) {
      it(`${experience}, ${n} days: non-full-body options exist and an explicit choice is honoured`, () => {
        const base = answers({ experience, liftingDaysPerWeek: n, totalDaysPerWeek: n });
        const nonFb = splitOptions(base, n).filter((o) => splitFamily(o.key) !== 'full_body');
        expect(nonFb.length).toBeGreaterThanOrEqual(1);
        for (const o of splitOptions(base, n)) {
          const a = { ...base, splitPreference: o.key };
          const v = gen(a);
          expect(liftingSlots(v)).toHaveLength(n);
          expect(splitKeyOfVersion(v)).toBe(o.key);
          expect(liftingIds(v)).toEqual(SPLITS[o.key].days.map((d) => `${o.key}:${d.key}`));
          // the shuffle variant never changes the split
          for (const variant of [1, 2, 3]) expect(splitKeyOfVersion(gen(a, variant))).toBe(o.key);
        }
      });
    }
});

describe('no hidden variant parity (previous defect)', () => {
  it('chooseSplit ignores the variant for the split and passes it through to exercise shuffling', () => {
    for (const experience of EXPERIENCES)
      for (const n of [2, 3, 4, 5, 6])
        for (const variant of [0, 1, 2, 3, 7]) {
          const c = chooseSplit(answers({ experience, liftingDaysPerWeek: n, totalDaysPerWeek: n }), variant);
          expect(c.split?.key).toBe(recommendedSplit(answers({ experience }), n));
          expect(c.exerciseVariant).toBe(variant);
        }
  });

  it('shuffling exercises keeps the split but changes exercises', () => {
    const a = answers({ splitPreference: 'ppl3' });
    const v0 = gen(a, 0);
    const v1 = gen(a, 1);
    expect(liftingIds(v1)).toEqual(liftingIds(v0));
    expect(JSON.stringify(v1.templates)).not.toEqual(JSON.stringify(v0.templates));
    const r = regenerateTemplates(v0, [v0.templates[0].id], a, EXERCISES, 2);
    expect(r.templates[0].id).toBe(v0.templates[0].id);
  });
});

describe('determinism: fresh wizard vs restored draft', () => {
  const account: AccountState = defaultAccountState();

  it('same visible inputs → same structure, whatever the stored shuffle variant', () => {
    for (const experience of EXPERIENCES)
      for (const pref of [undefined, 'ulf', 'ppl3'] as const) {
        const fresh: Draft = newDraft(account);
        fresh.a = { ...fresh.a, displayName: 'X', experience, ...(pref ? { splitPreference: pref } : {}) };
        // a draft restored from kv (JSON round trip) that had been shuffled several times
        const restored = migrateDraft(JSON.parse(JSON.stringify({ ...fresh, variant: 5, step: 'result' })) as Draft);
        expect(restored.a).toEqual(fresh.a);
        const a = gen(fresh.a, fresh.variant);
        const b = gen(restored.a, restored.variant);
        expect(liftingIds(b)).toEqual(liftingIds(a));
        expect(b.schedule).toEqual(a.schedule);
        // identical visible inputs AND variant → identical plan
        expect(gen(restored.a, fresh.variant)).toEqual(a);
      }
  });

  it('old drafts without splitPreference keep working (recommended default)', () => {
    const d = newDraft(account);
    delete (d.a as Partial<OnboardingAnswers>).splitPreference;
    const m = migrateDraft(JSON.parse(JSON.stringify(d)));
    expect(m.a.splitPreference).toBeUndefined();
    expect(splitKeyOfVersion(gen(m.a))).toBe(recommendedSplit(m.a, 3));
  });

  it('an old draft whose edited suggestion used the parity split pins that visible split', () => {
    const d = newDraft(account);
    const old = chooseSplit(d.a, 0); // shape check only
    expect(old.split).not.toBeNull();
    const version = gen({ ...d.a, splitPreference: 'ulf' });
    const saved: Draft = { ...d, step: 'result', variant: 1, version, versionKey: JSON.stringify(d.a) };
    const m = migrateDraft(JSON.parse(JSON.stringify(saved)));
    expect(m.a.splitPreference).toBe('ulf');
    expect(m.versionKey).toBe(JSON.stringify(m.a)); // the edited suggestion is still shown
    expect(m.version).toEqual(version);
  });

  it('drops an unknown stored split value', () => {
    const d = newDraft(account);
    const bad = JSON.parse(JSON.stringify({ ...d, a: { ...d.a, splitPreference: 'bro_split' } }));
    expect(migrateDraft(bad).a.splitPreference).toBeUndefined();
    expect(resolveSplit(bad.a, 3).key).toBe('fb3');
  });

  it('the accepted program keeps the split in its inputs and old programs without it still load', () => {
    const a = answers({ splitPreference: 'ul2', liftingDaysPerWeek: 2, totalDaysPerWeek: 2 });
    const v = gen(a);
    const p = createProgram(a, v, START, 'Upper / Lower', 'generated');
    expect(p.inputs?.splitPreference).toBe('ul2');
    expect(splitKeyOfVersion(v)).toBe('ul2');
    const legacy = answers({ liftingDaysPerWeek: 2, totalDaysPerWeek: 2 });
    expect(splitKeyOfVersion(gen(legacy))).toBe('fb2');
  });
});

describe('day-count changes keep the intent', () => {
  it('upper/lower intent maps to the nearest UL-family split and says so', () => {
    const cases: [number, SplitKey][] = [[2, 'ul2'], [3, 'ulf'], [4, 'ul4'], [5, 'ul5'], [6, 'ul6']];
    for (const [n, key] of cases) {
      const r = resolveSplit(answers({ splitPreference: 'ul2' }), n);
      expect(r.key, `${n} days`).toBe(key);
      if (key !== 'ul2') expect(r.adjustment).toMatchObject({ kind: 'mapped' });
      else expect(r.adjustment).toBeUndefined();
    }
  });

  it('full-body intent stays full body where possible, otherwise the closest/recommended with a visible message', () => {
    expect(resolveSplit(answers({ splitPreference: 'fb2' }), 3).key).toBe('fb3');
    expect(resolveSplit(answers({ splitPreference: 'fb3' }), 4).key).toBe('fb4');
    expect(resolveSplit(answers({ splitPreference: 'fb3' }), 5).key).toBe('ul5');
    const six = resolveSplit(answers({ splitPreference: 'fb3' }), 6);
    expect(six.key).toBe('ppl6');
    expect(six.adjustment).toMatchObject({ kind: 'fallback' });
    expect(six.adjustment?.message).toMatch(/recommended/);
  });

  it('push/pull/legs intent: 2 days → Upper/Lower, 6 days → PPL×2; returning to 3 days restores it', () => {
    const a = answers({ splitPreference: 'ppl3' });
    expect(resolveSplit(a, 2).key).toBe('ul2');
    expect(resolveSplit(a, 6).key).toBe('ppl6');
    expect(resolveSplit(a, 3)).toMatchObject({ key: 'ppl3', explicit: true });
  });

  it('the generator surfaces the adjustment as a plan warning', () => {
    const v = gen(answers({ splitPreference: 'ul2', liftingDaysPerWeek: 3, totalDaysPerWeek: 3 }));
    expect(splitKeyOfVersion(v)).toBe('ulf');
    expect(v.warnings[0]).toMatch(/closest structure: Upper \/ Lower \/ Full body/);
  });

  it('available days cap the lifting count before the split is resolved', () => {
    const a = answers({ splitPreference: 'ppl3', liftingDaysPerWeek: 3, totalDaysPerWeek: 2, availableWeekdays: [1, 4] });
    expect(effectiveLiftingDays(a)).toBe(2);
    expect(splitKeyOfVersion(gen(a))).toBe('ul2');
  });
});

describe('endurance / supporting-strength branch', () => {
  it('lifting is capped to 2 supporting sessions; other active days are endurance sessions', () => {
    const a = answers({ goal: 'endurance', liftingDaysPerWeek: 4, totalDaysPerWeek: 5, endurance: { activity: 'run' } });
    expect(effectiveLiftingDays(a)).toBe(2);
    const v = gen(a);
    expect(liftingSlots(v)).toHaveLength(2);
    expect(v.schedule.filter((s) => v.templates.find((t) => t.id === s.templateId)?.cardio?.activity === 'run')).toHaveLength(3);
  });

  it('2 supporting sessions: does not bypass the selector — full-body support (recommended) or upper/lower', () => {
    for (const experience of EXPERIENCES) {
      const a = answers({ goal: 'endurance', experience, liftingDaysPerWeek: 2, totalDaysPerWeek: 4 });
      expect(splitOptions(a, 2).map((o) => o.key)).toEqual(['es', 'ul2']);
      expect(splitKeyOfVersion(gen(a))).toBe('es');
      const ul = gen({ ...a, splitPreference: 'ul2' });
      expect(splitKeyOfVersion(ul)).toBe('ul2');
      expect(ul.rationale.join(' ')).toMatch(/2 supporting strength sessions \(Upper \/ Lower\)/);
    }
  });

  it('1 supporting session: full body only', () => {
    const a = answers({ goal: 'endurance', liftingDaysPerWeek: 1, totalDaysPerWeek: 3, splitPreference: 'ul2' });
    expect(splitOptions(a, 1).map((o) => o.key)).toEqual(['es']);
    const v = gen(a);
    expect(liftingIds(v)).toEqual(['es:sa']);
  });

  it('switching goal keeps a structural intent (full-body choice → supporting strength)', () => {
    const r = resolveSplit(answers({ goal: 'endurance', splitPreference: 'fb2' }), 2);
    expect(r.key).toBe('es');
    expect(r.adjustment?.message).toMatch(/endurance goal/);
  });
});
