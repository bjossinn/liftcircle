/**
 * Onboarding wizard state: draft shape, defaults, step order and per-step zod validation.
 * Six quick questions (goal, experience, days, session length, where you train, anything to be careful with), then the
 * program preview. Units come from the device locale; body details and nutrition are set up later (Profile, Progress,
 * Nutrition, Settings). The draft is saved to kv('onboarding-draft') so a reload resumes where the user left off.
 */
import { z } from 'zod';
import type { AccountState, ActivityType, Allergen, DietTag, Equipment, Goal, OnboardingAnswers, ProgramVersion, UnitPrefs } from '@/domain/types';
import { isSplitKey, splitKeyOfVersion } from '@/domain/program/splits';
import { deviceLocale, unitsForLocale } from '@/domain/units';
import { defaultAccountState } from '@/state/defaults';

export const DRAFT_KEY = 'onboarding-draft';

/** The six questions, in order. */
export const QUESTION_STEPS = ['goal', 'experience', 'days', 'duration', 'location', 'limits'] as const;
export type QuestionStep = (typeof QUESTION_STEPS)[number];
export type StepKey = 'welcome' | QuestionStep | 'result' | 'manual';

export interface NutritionChoice {
  refSource: 'current' | 'goal';
  proteinPerKg: number;
  manual: boolean;
  manualProtein?: number | null;
  manualCalories?: number | null;
  manualCarbs?: number | null;
  manualFat?: number | null;
}

export interface Draft {
  v: 1;
  mode: 'plan' | 'manual';
  step: StepKey;
  /** Answers incl. the explicit `splitPreference` (persisted with the draft). */
  a: OnboardingAnswers;
  /** Exercise shuffle within the chosen split. Never selects the split itself. */
  variant: number;
  regen: Record<string, number>;
  /** The suggestion as edited on the result screen, tied to the answers it was generated from. */
  version?: ProgramVersion | null;
  versionKey?: string | null;
  /** Kept for drafts saved by the longer wizard (nutrition is no longer part of onboarding). */
  nutri: NutritionChoice;
  manual: { sessions: number; days: number[] };
}

export const ALL_GYM: Equipment[] = [
  'barbell', 'rack', 'bench', 'dumbbell', 'kettlebell', 'machine', 'cable', 'band', 'pullup_bar', 'dip_station', 'ez_bar', 'smith', 'cardio_machine',
];
export const LOCATION_PRESETS: Record<OnboardingAnswers['location'], Equipment[]> = {
  full_gym: ALL_GYM,
  home_gym: ['barbell', 'rack', 'bench', 'dumbbell', 'pullup_bar', 'band'],
  minimal: [],
};

const sameUnits = (x: UnitPrefs, y: UnitPrefs) => x.weight === y.weight && x.length === y.length && x.distance === y.distance;

/**
 * Units for a new plan. Someone who hasn't been through setup and still has the factory units gets units from their
 * device locale (en-US → lb, elsewhere kg); anyone who has onboarded or changed units in Settings keeps theirs.
 */
export function onboardingUnits(account: AccountState, locale: string | undefined = deviceLocale()): UnitPrefs {
  const units = account.settings.units;
  if (account.profile.onboardedAt || !sameUnits(units, defaultAccountState().settings.units)) return { ...units };
  return unitsForLocale(locale);
}

/** Default training days for a weekly count, spread out with rest days between (0 = Sunday). */
export const SPREAD_DAYS: Record<number, number[]> = {
  1: [1],
  2: [1, 4],
  3: [1, 3, 5],
  4: [1, 2, 4, 5],
  5: [1, 2, 3, 5, 6],
  6: [1, 2, 3, 4, 5, 6],
  7: [1, 2, 3, 4, 5, 6, 0],
};

/**
 * "Which days?" sets the whole week from one answer: the days picked are the days you train (all of them hard lifting
 * days, up to 6; an endurance goal turns the extra ones into endurance sessions). The generator spreads the sessions
 * over exactly those days.
 */
export function withTrainingDays(a: OnboardingAnswers, days: number[]): OnboardingAnswers {
  const unique = [...new Set(days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))];
  return { ...a, availableWeekdays: unique, totalDaysPerWeek: unique.length, liftingDaysPerWeek: Math.min(unique.length, 6), preferredLiftingWeekdays: [] };
}

/** The days a draft trains on: the picked days, or (older drafts with "any day" availability) a spread of the count. */
export function trainingDaysOf(a: Pick<OnboardingAnswers, 'availableWeekdays' | 'totalDaysPerWeek'>): number[] {
  if (a.availableWeekdays.length === a.totalDaysPerWeek) return a.availableWeekdays;
  return SPREAD_DAYS[Math.min(7, Math.max(1, a.totalDaysPerWeek))] ?? SPREAD_DAYS[3];
}

export function defaultAnswers(account: AccountState, locale?: string): OnboardingAnswers {
  const p = account.profile;
  return {
    displayName: p.displayName ?? '',
    units: onboardingUnits(account, locale),
    age: p.age,
    heightCm: p.heightCm,
    goal: p.goal ?? 'build_muscle',
    secondaryGoal: p.secondaryGoal,
    targetWeightKg: p.targetWeightKg,
    experience: p.experience ?? 'new',
    totalDaysPerWeek: 3,
    liftingDaysPerWeek: 3,
    availableWeekdays: [...SPREAD_DAYS[3]],
    preferredLiftingWeekdays: [],
    sessionMinutes: 60,
    location: 'full_gym',
    equipment: [...ALL_GYM],
    preferredActivities: [],
    enjoyedExerciseIds: [],
    excludedExerciseIds: [],
    limitations: [...(p.limitations ?? [])],
    limitationNotes: p.injuryNotes,
    activityLevel: p.activityLevel ?? 'light',
    wantsNutrition: account.settings.nutritionEnabled,
    nutritionMode: 'protein_only',
    diet: { ...p.diet },
    sexParam: p.sexParam,
    individualizedNutrition: p.individualizedNutrition,
    knownLoads: {},
  };
}

export function newDraft(account: AccountState, locale?: string): Draft {
  return {
    v: 1,
    mode: 'plan',
    step: 'welcome',
    a: defaultAnswers(account, locale),
    variant: 0,
    regen: {},
    version: null,
    versionKey: null,
    nutri: { refSource: 'current', proteinPerKg: 1.8, manual: false },
    manual: { sessions: 3, days: [1, 3, 5] },
  };
}

/**
 * Bring a saved draft up to date. Drafts saved before explicit split choice could hold an edited
 * suggestion whose split came from the old hidden shuffle parity; pin that visible split as the
 * preference so the selector, the plan on screen and the accepted program agree. Unknown split values
 * are dropped (absent = recommended default).
 */
/** Steps of the earlier 12-step wizard → where a saved draft resumes now. */
const LEGACY_STEPS: Record<string, StepKey> = {
  about: 'goal',
  body: 'goal',
  schedule: 'days',
  equipment: 'location',
  exercises: 'limits',
  lifestyle: 'limits',
  nutrition: 'limits',
  review: 'result',
};
const STEP_KEYS = new Set<string>(['welcome', ...QUESTION_STEPS, 'result', 'manual']);

export function migrateDraft(d: Draft): Draft {
  // Earlier wizard: map its steps onto the six questions, and turn "available any day" into the picked training days.
  if (!STEP_KEYS.has(d.step)) d = { ...d, step: LEGACY_STEPS[d.step as string] ?? 'welcome' };
  if (d.a.availableWeekdays.length !== d.a.totalDaysPerWeek || d.a.preferredLiftingWeekdays.length) {
    const a = withTrainingDays(d.a, trainingDaysOf(d.a));
    // An edited preview stays the one shown (its sessions are already placed on days).
    d = { ...d, a, versionKey: d.version && d.versionKey === JSON.stringify(d.a) ? JSON.stringify(a) : d.versionKey };
  }
  let a = d.a;
  if (a.splitPreference !== undefined && !isSplitKey(a.splitPreference)) {
    a = { ...a };
    delete a.splitPreference;
  }
  let next: Draft = a === d.a ? d : { ...d, a, versionKey: d.versionKey === JSON.stringify(d.a) ? JSON.stringify(a) : d.versionKey };
  if (next.a.splitPreference === undefined && next.version && next.versionKey === JSON.stringify(next.a)) {
    const key = splitKeyOfVersion(next.version);
    if (key) {
      const pinned = { ...next.a, splitPreference: key };
      next = { ...next, a: pinned, versionKey: JSON.stringify(pinned) };
    }
  }
  return next;
}

export function stepsFor(d: Pick<Draft, 'mode'>): StepKey[] {
  if (d.mode === 'manual') return ['welcome', 'manual'];
  return ['welcome', ...QUESTION_STEPS, 'result'];
}

/** 1-based question number (1–6), or null for the welcome, preview and manual screens. */
export function questionNumber(step: StepKey): number | null {
  const i = (QUESTION_STEPS as readonly string[]).indexOf(step);
  return i < 0 ? null : i + 1;
}

export const STEP_TITLES: Record<StepKey, string> = {
  welcome: 'Welcome',
  goal: 'What’s your main goal?',
  experience: 'How much have you lifted before?',
  days: 'Which days can you train?',
  duration: 'How long is a workout?',
  location: 'Where do you train?',
  limits: 'Anything to be careful with?',
  result: 'Your plan',
  manual: 'Your own program',
};

export const isUnder18 = (a: Pick<OnboardingAnswers, 'age'>) => a.age != null && a.age < 18;

/* ------------------------------------------------------------ validation */
const GOALS = ['build_muscle', 'strength', 'lose_fat', 'general_fitness', 'endurance'] as const satisfies readonly Goal[];
const ENDURANCE_ACTIVITIES = ['run', 'cycle', 'swim', 'row', 'hike', 'walk'] as const satisfies readonly ActivityType[];

const goalSchema = z.object({
  goal: z.enum(GOALS),
  endurance: z.object({ activity: z.enum(ENDURANCE_ACTIVITIES) }).partial().optional(),
});
const daysSchema = z.object({
  availableWeekdays: z.array(z.number().int().min(0).max(6)).min(1, 'Pick at least one day.'),
});
const durationSchema = z.object({
  sessionMinutes: z.number().int().min(20, 'At least 20 minutes.').max(180, 'Up to 180 minutes.'),
});
const manualSchema = z.object({
  sessions: z.number().int().min(1).max(7),
  days: z.array(z.number().int().min(0).max(6)),
});

function issuesToErrors(issues: z.core.$ZodIssue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of issues) {
    const key = i.path.join('.');
    if (!out[key]) out[key] = i.message;
  }
  return out;
}

export function validateStep(step: StepKey, d: Draft): Record<string, string> {
  const a = d.a;
  const run = (schema: z.ZodType, value: unknown) => {
    const r = schema.safeParse(value);
    return r.success ? {} : issuesToErrors(r.error.issues);
  };
  switch (step) {
    case 'goal':
      return run(goalSchema, a);
    case 'days':
      return run(daysSchema, a);
    case 'duration':
      return run(durationSchema, a);
    case 'manual':
      return run(manualSchema, d.manual);
    default:
      return {};
  }
}

export const DIET_TAG_LABELS: Record<DietTag, string> = {
  vegetarian: 'Vegetarian',
  vegan: 'Vegan',
  pescatarian: 'Pescatarian',
  dairy_free: 'Dairy-free',
  gluten_free: 'Gluten-free',
  high_protein: 'High protein',
};
export const ALLERGEN_LABELS: Record<Allergen, string> = {
  milk: 'Milk',
  egg: 'Egg',
  fish: 'Fish',
  shellfish: 'Shellfish',
  tree_nuts: 'Tree nuts',
  peanuts: 'Peanuts',
  wheat: 'Wheat',
  gluten: 'Gluten',
  soy: 'Soy',
  sesame: 'Sesame',
  mustard: 'Mustard',
  celery: 'Celery',
};
