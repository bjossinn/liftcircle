import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage } from '@/i18n';
import { EXERCISES } from '@/data/exercises';
import { generateProgram } from '@/domain/program/generator';
import { sessionDisplayName } from '@/domain/program/localize';
import { sessionMark, workoutMarkSource } from '@/domain/program/sessionMark';
import { buildSessionFromTemplate } from '@/domain/program/session';
import { workoutHistoryRow } from '@/features/train/historyItems';
import { workoutDisplayName } from '@/features/program/parts';
import { defaultAccountState } from '@/state/defaults';
import type { OnboardingAnswers, Program, SessionTemplate, WorkoutSession } from '@/domain/types';

afterEach(() => setLanguage('en'));

const answers: OnboardingAnswers = {
  displayName: 'Test', units: { weight: 'kg', length: 'cm', distance: 'km' }, goal: 'build_muscle', experience: 'intermediate',
  totalDaysPerWeek: 3, liftingDaysPerWeek: 3, availableWeekdays: [0, 1, 2, 3, 4, 5, 6], preferredLiftingWeekdays: [], sessionMinutes: 60,
  location: 'full_gym', equipment: [], preferredActivities: [], enjoyedExerciseIds: [], excludedExerciseIds: [], limitations: [],
  activityLevel: 'moderate', wantsNutrition: false,
  diet: { tags: [], allergens: [], dislikedIngredientIds: [], maxCookMinutes: 30, budget: 'any', mealsPerDay: 3 },
};
const version = generateProgram(answers, EXERCISES, { startDate: '2026-11-02' });
const lifting = version.templates.find((t) => t.kind === 'lifting')!;
const tpl = (over: Partial<SessionTemplate>): SessionTemplate => ({ id: 'x', name: 'x', focus: '', kind: 'lifting', exercises: [], estimatedMinutes: 30, ...over });
const program = (templates: SessionTemplate[]): Program =>
  ({ id: 'p1', createdAt: 1, updatedAt: 1, name: 'Plan', active: true, currentVersion: 1, versions: [{ ...version, version: 1, templates }] }) as unknown as Program;
const workout = (over: Partial<WorkoutSession>): Pick<WorkoutSession, 'name' | 'notes' | 'templateId' | 'programId' | 'programVersion' | 'nameEdited'> => ({
  name: lifting.name, templateId: lifting.id, programId: 'p1', programVersion: 1, ...over,
});

describe('history rows', () => {
  it('(a) search matches the localized title and the stored English name', () => {
    setLanguage('is');
    const shown = sessionDisplayName(lifting, 'is');
    expect(shown).not.toBe(lifting.name);
    const row = workoutHistoryRow(workout({}), [], [program([lifting])]);
    expect(row.title).toBe(shown);
    expect(row.search).toContain(shown.toLocaleLowerCase());
    expect(row.search).toContain(lifting.name.toLowerCase());
  });

  it('(b) a renamed workout or template is never auto-translated', () => {
    setLanguage('is');
    const row = workoutHistoryRow(workout({ nameEdited: true }), [], [program([lifting])]);
    expect(row.title).toBe(lifting.name);
    // Starting a renamed template carries the marker onto the workout; an unrenamed one does not.
    const ctx = { catalog: EXERCISES, history: [], settings: defaultAccountState().settings, date: '2026-11-20', timeZone: 'UTC', experience: 'new' as const };
    expect(buildSessionFromTemplate({ ...lifting, nameEdited: true }, ctx).nameEdited).toBe(true);
    expect(buildSessionFromTemplate(lifting, ctx).nameEdited).toBeUndefined();
  });

  it('(c) uses the real session kind/family, not lifting', () => {
    const mobility = tpl({ id: 'act:mobility', name: 'Mobility', kind: 'mobility' });
    const conditioning = tpl({ id: 'custom:x1', name: 'Intervals', kind: 'conditioning' });
    const progs = [program([lifting, mobility, conditioning])];
    expect(sessionMark(workoutHistoryRow(workout({ name: 'Mobility', templateId: 'act:mobility' }), [], progs).mark!).family).toBe('mobility');
    expect(sessionMark(workoutMarkSource({ name: 'Intervals', templateId: 'custom:x1', programId: 'p1' }, progs)!).family).toBe('conditioning');
    expect(sessionMark(workoutMarkSource(workout({}), progs)!).family).toBe(sessionMark(lifting).family);
    // Template no longer in any program: inferred from the generated id.
    expect(sessionMark(workoutMarkSource({ name: 'Mobility', templateId: 'act:mobility' }, [])!).family).toBe('mobility');
    expect(sessionMark(workoutMarkSource({ name: 'Long run', templateId: 'end:long' }, [])!).family).toBe('cardio_long');
    expect(workoutMarkSource({ name: 'Free workout' }, progs)).toBeNull();
  });

  it('workoutDisplayName: generated names localized, renamed and custom names as stored', () => {
    setLanguage('is');
    const shown = sessionDisplayName(lifting, 'is');
    expect(workoutDisplayName({ name: lifting.name, templateId: lifting.id })).toBe(shown);
    expect(workoutDisplayName({ name: lifting.name, templateId: lifting.id, nameEdited: true })).toBe(lifting.name);
    expect(workoutDisplayName({ name: lifting.name })).toBe(lifting.name);
    expect(workoutDisplayName({ name: 'Leg day', templateId: lifting.id })).toBe('Leg day');
    setLanguage('en');
    expect(workoutDisplayName({ name: lifting.name, templateId: lifting.id })).toBe(lifting.name);
  });
});
