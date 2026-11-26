/**
 * Generated program text is localized only when it is demonstrably generated: a session/field the user (or a coach)
 * named or wrote is shown verbatim even when it equals a generated English string.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EXERCISES } from '@/data/exercises';
import { setLanguage, t } from '@/i18n';
import { emptyTemplate, generateProgram, regenerateTemplates } from '@/domain/program/generator';
import { exerciseNote } from '@/domain/program/explain';
import { cardioNotesText, isGeneratedTemplateId, rxNotesText, sessionDisplayFocus, sessionDisplayName } from '@/domain/program/localize';
import { displaySessionName, versionReasonText } from '@/features/program/parts';
import type { OnboardingAnswers, SessionTemplate } from '@/domain/types';

function answers(over: Partial<OnboardingAnswers> = {}): OnboardingAnswers {
  return {
    displayName: 'Test', units: { weight: 'kg', length: 'cm', distance: 'km' }, goal: 'build_muscle', experience: 'intermediate',
    totalDaysPerWeek: 5, liftingDaysPerWeek: 3, availableWeekdays: [0, 1, 2, 3, 4, 5, 6], preferredLiftingWeekdays: [], sessionMinutes: 60,
    location: 'full_gym', equipment: [], preferredActivities: ['walk'], enjoyedExerciseIds: [], excludedExerciseIds: [], limitations: [],
    activityLevel: 'moderate', wantsNutrition: false,
    diet: { tags: [], allergens: [], dislikedIngredientIds: [], maxCookMinutes: 30, budget: 'any', mealsPerDay: 3 },
    ...over,
  };
}
const gen = () => generateProgram(answers(), EXERCISES, { startDate: '2026-11-02', variant: 0 });
const EASY_WALK = t('program.generator.easyWalk', undefined, 'en');
const FULL_BODY_A = 'Full body A';

afterEach(() => setLanguage('en'));

describe('program text provenance', () => {
  it('generated sessions still translate', () => {
    setLanguage('is');
    const v = gen();
    const fbA = v.templates.find((s) => s.name === FULL_BODY_A)!;
    expect(isGeneratedTemplateId(fbA.id)).toBe(true);
    expect(sessionDisplayName(fbA)).not.toBe(FULL_BODY_A);
    expect(sessionDisplayFocus(fbA)).toBe('Allur líkaminn');
    const walk = v.templates.find((s) => s.name === EASY_WALK)!;
    expect(walk).toBeDefined();
    expect(sessionDisplayName(walk)).toBe(t('program.generator.easyWalk', undefined, 'is'));
    expect(cardioNotesText(walk)).toBe(t('program.generator.walkNotes', undefined, 'is'));
  });

  it('a session the user renamed to "Session A" stays verbatim; an untouched manual "Session A" translates', () => {
    setLanguage('is');
    const manual = emptyTemplate('custom:m1', 'Session A');
    expect(displaySessionName(manual)).toBe(t('onboarding.manualSessionName', { letter: 'A' }, 'is'));
    expect(displaySessionName({ ...manual, nameEdited: true })).toBe('Session A');
    const generated = gen().templates.find((s) => s.name === FULL_BODY_A)!;
    expect(displaySessionName({ ...generated, name: 'Session A', nameEdited: true })).toBe('Session A');
  });

  it('custom sessions named like generated ones display verbatim', () => {
    setLanguage('is');
    const custom = emptyTemplate('custom:abc', EASY_WALK);
    expect(displaySessionName(custom)).toBe(EASY_WALK);
    expect(sessionDisplayName(emptyTemplate('custom:def', FULL_BODY_A))).toBe(FULL_BODY_A);
    // Coach/library/AI sessions (other ids) and name-only lookups are verbatim too.
    expect(sessionDisplayName({ id: 'coach:123', name: FULL_BODY_A })).toBe(FULL_BODY_A);
    expect(sessionDisplayName({ name: EASY_WALK })).toBe(EASY_WALK);
    // The app-written focus of a blank custom session is still localized; any other focus is shown as stored.
    expect(sessionDisplayFocus(custom)).toBe(t('program.rationale.custom', undefined, 'is'));
    expect(sessionDisplayFocus({ id: 'coach:1', focus: 'Full body' })).toBe('Full body');
  });

  it('a renamed generated session displays verbatim, also after regenerating it', () => {
    setLanguage('is');
    const v = gen();
    const fbB = v.templates.find((s) => s.name === 'Full body B')!;
    const renamed: SessionTemplate = { ...fbB, name: FULL_BODY_A, nameEdited: true };
    expect(sessionDisplayName(renamed)).toBe(FULL_BODY_A);
    const next = regenerateTemplates({ ...v, templates: v.templates.map((x) => (x.id === fbB.id ? renamed : x)) }, [fbB.id], answers(), EXERCISES, 1);
    const again = next.templates.find((x) => x.id === fbB.id)!;
    expect(again.nameEdited).toBe(true);
    expect(sessionDisplayName(again)).toBe(FULL_BODY_A);
    // Stored English is unchanged.
    expect(again.name).toBe(FULL_BODY_A);
  });

  it('edited notes equal to generated notes display verbatim; unedited generated notes translate', () => {
    setLanguage('is');
    const walkNotes = t('program.generator.walkNotes', undefined, 'en');
    const tpl: SessionTemplate = {
      id: 'act:walk', name: EASY_WALK, focus: '', kind: 'walk', exercises: [], estimatedMinutes: 30,
      cardio: { activity: 'walk', minutes: 30, intensity: 'easy', notes: walkNotes },
    };
    expect(cardioNotesText(tpl)).toBe(t('program.generator.walkNotes', undefined, 'is'));
    expect(cardioNotesText({ ...tpl, cardio: { ...tpl.cardio!, notesEdited: true } })).toBe(walkNotes);
    expect(cardioNotesText({ ...tpl, id: 'custom:x' })).toBe(walkNotes);

    const bw = t('program.generator.bodyweightStart', undefined, 'en');
    expect(exerciseNote({ notes: bw })).toBe(t('program.generator.bodyweightStart', undefined, 'is'));
    expect(exerciseNote({ notes: bw, notesEdited: true })).toBe(bw);
    expect(rxNotesText({ notes: bw, notesEdited: true })).toBe(bw);
  });

  it('session names inside version reasons follow the same provenance', () => {
    setLanguage('is');
    const v = gen();
    const reason = t('program.reordered', { sessionName: FULL_BODY_A }, 'en');
    const generated = versionReasonText(reason, v.templates);
    expect(generated).toBe(t('program.reordered', { sessionName: sessionDisplayName(v.templates.find((s) => s.name === FULL_BODY_A)!) }, 'is'));
    expect(versionReasonText(reason, [emptyTemplate('custom:1', FULL_BODY_A)])).toBe(t('program.reordered', { sessionName: FULL_BODY_A }, 'is'));
    expect(versionReasonText(reason)).toBe(t('program.reordered', { sessionName: FULL_BODY_A }, 'is'));
  });
});
