import { describe, expect, it } from 'vitest';
import { EXERCISES } from '@/data/exercises';
import { generateProgram } from '@/domain/program/generator';
import { SPLITS } from '@/domain/program/templates';
import { sessionMark, sessionMarkKey } from '@/domain/program/sessionMark';
import type { OnboardingAnswers, ProgramVersion, SessionTemplate, SplitKey } from '@/domain/types';

const START = '2026-11-02';
function answers(over: Partial<OnboardingAnswers> = {}): OnboardingAnswers {
  return {
    displayName: 'Test',
    units: { weight: 'kg', length: 'cm', distance: 'km' },
    goal: 'build_muscle',
    experience: 'advanced',
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
const gen = (over: Partial<OnboardingAnswers>): ProgramVersion => generateProgram(answers(over), EXERCISES, { startDate: START });
const marks = (v: ProgramVersion) => v.templates.map((t) => sessionMarkKey(t));
const tpl = (over: Partial<SessionTemplate>): SessionTemplate => ({ id: 'x', name: 'x', focus: '', kind: 'lifting', exercises: [], estimatedMinutes: 30, ...over });

/** Lifting days for each built-in split, so the generator picks it when it is requested. */
const DAYS: Record<SplitKey, number> = { fb1: 1, fb2: 2, ul2: 2, fb3: 3, ulf: 3, ppl3: 3, ul4: 4, fb4: 4, ulppl: 5, ul5: 5, ppl6: 6, ul6: 6, es: 2 };

describe('sessionMark: every generated workout in a plan is distinguishable', () => {
  for (const key of Object.keys(SPLITS) as SplitKey[]) {
    it(`${key}: no two templates share a mark`, () => {
      const over: Partial<OnboardingAnswers> =
        key === 'es'
          ? { goal: 'endurance', preferredActivities: ['run'], liftingDaysPerWeek: 2, totalDaysPerWeek: 5 }
          : { splitPreference: key, liftingDaysPerWeek: DAYS[key], totalDaysPerWeek: Math.min(7, DAYS[key] + 2), preferredActivities: ['cycle'] };
      const v = gen(over);
      if (key !== 'es') expect(v.templates.filter((t) => t.kind === 'lifting').every((t) => t.id.startsWith(`${key}:`))).toBe(true);
      const keys = marks(v);
      expect(new Set(keys).size, keys.join(', ')).toBe(v.templates.length);
    });
  }

  it('fb3: Full body A/B/C share a family with letters A, B, C', () => {
    const v = gen({ splitPreference: 'fb3', liftingDaysPerWeek: 3 });
    expect(v.templates.filter((t) => t.kind === 'lifting').map((t) => sessionMark(t))).toEqual([
      { family: 'full_body', letter: 'A' },
      { family: 'full_body', letter: 'B' },
      { family: 'full_body', letter: 'C' },
    ]);
  });

  it('ul4: Upper A, Upper B, Lower A, Lower B are four distinct marks (the owner’s example)', () => {
    const v = gen({ splitPreference: 'ul4', liftingDaysPerWeek: 4, totalDaysPerWeek: 4 });
    const byName = Object.fromEntries(v.templates.map((t) => [t.name, sessionMarkKey(t)]));
    expect(byName).toEqual({ 'Upper A': 'upper:A', 'Lower A': 'lower:A', 'Upper B': 'upper:B', 'Lower B': 'lower:B' });
  });

  it('ppl3: push, pull and legs are distinct families (same letter is fine)', () => {
    const v = gen({ splitPreference: 'ppl3', liftingDaysPerWeek: 3 });
    expect(v.templates.map((t) => sessionMark(t).family)).toEqual(['push', 'pull', 'legs']);
  });

  it('ulf: upper, lower and full body are distinct families; the single full-body day has no letter', () => {
    const v = gen({ splitPreference: 'ulf', liftingDaysPerWeek: 3 });
    expect(v.templates.map((t) => sessionMarkKey(t))).toEqual(['upper:A', 'lower:A', 'full_body:']);
  });

  it('es: Strength A/B', () => {
    const v = gen({ goal: 'endurance', preferredActivities: ['run'], liftingDaysPerWeek: 2, totalDaysPerWeek: 5 });
    const strength = v.templates.filter((t) => t.kind === 'lifting').map((t) => sessionMarkKey(t));
    expect(strength).toEqual(['strength:A', 'strength:B']);
    // Endurance sessions (easy / long / steady) are distinct from each other too.
    const cardio = v.templates.filter((t) => t.kind === 'cardio').map((t) => sessionMarkKey(t));
    expect(new Set(cardio).size).toBe(cardio.length);
  });
});

describe('sessionMark: activity kinds', () => {
  it('walk, cardio, mobility and conditioning are distinct from lifting and from each other (cardio ≠ walk)', () => {
    const keys = [
      sessionMarkKey(tpl({ id: 'act:walk', kind: 'walk', name: 'Easy walk' })),
      sessionMarkKey(tpl({ id: 'act:cardio', kind: 'cardio', name: 'Easy ride' })),
      sessionMarkKey(tpl({ id: 'act:mobility', kind: 'mobility', name: 'Mobility' })),
      sessionMarkKey(tpl({ id: 'act:conditioning', kind: 'conditioning', name: 'Conditioning intervals' })),
      sessionMarkKey(tpl({ id: 'fb3:a', name: 'Full body A' })),
      sessionMarkKey(tpl({ id: 'custom:1', name: 'My lifts' })),
    ];
    expect(keys).toEqual(['walk:', 'cardio:', 'mobility:', 'conditioning:', 'full_body:A', 'lifting:']);
    expect(sessionMarkKey(tpl({ id: 'end:easy', kind: 'cardio', name: 'Easy run' }))).not.toBe(sessionMarkKey(tpl({ id: 'end:long', kind: 'cardio', name: 'Long run' })));
    expect(sessionMarkKey(tpl({ id: 'end:long', kind: 'cardio', name: 'Long run' }))).not.toBe(sessionMarkKey(tpl({ id: 'end:steady', kind: 'cardio', name: 'Steady run' })));
  });
});

describe('sessionMark: derived from stable stored data', () => {
  it('a generated id wins over the name (survives a rename)', () => {
    expect(sessionMark(tpl({ id: 'ul4:ub', name: 'Arms & chest', nameEdited: true }))).toEqual({ family: 'upper', letter: 'B' });
    expect(sessionMark(tpl({ id: 'ppl6:plb', name: 'Back day' }))).toEqual({ family: 'pull', letter: 'B' });
    expect(sessionMark(tpl({ id: 'ppl6:lga', name: 'x' }))).toEqual({ family: 'legs', letter: 'A' });
    expect(sessionMark(tpl({ id: 'ul6:lc', name: 'x' }))).toEqual({ family: 'lower', letter: 'C' });
    expect(sessionMark(tpl({ id: 'fb4:d', name: 'x' }))).toEqual({ family: 'full_body', letter: 'D' });
    expect(sessionMark(tpl({ id: 'fb1:fb', name: 'Full body' }))).toEqual({ family: 'full_body', letter: null });
  });

  it('otherwise parses the canonical English name / focus, never the Icelandic display string', () => {
    expect(sessionMark(tpl({ id: 'coach:1', name: 'Upper B', focus: 'Upper body' }))).toEqual({ family: 'upper', letter: 'B' });
    expect(sessionMark(tpl({ id: 'coach:2', name: 'Heavy day', focus: 'Lower body' }))).toEqual({ family: 'lower', letter: null });
    expect(sessionMark(tpl({ id: 'custom:a', name: 'Session C' }))).toEqual({ family: 'lifting', letter: 'C' });
    // An Icelandic display name is not stored data and is not parsed into a family.
    expect(sessionMark(tpl({ id: 'coach:3', name: 'Efri líkami A' })).family).toBe('lifting');
    // Renamed away from the letter, not a generated id → no badge.
    expect(sessionMark(tpl({ id: 'custom:b', name: 'Arms', nameEdited: true }))).toEqual({ family: 'lifting', letter: null });
  });
});
