/**
 * Onboarding wizard state: draft shape, defaults, step order and per-step zod validation.
 * The draft is saved to kv('onboarding-draft') so a reload resumes where the user left off.
 */
import { z } from 'zod';
import type { AccountState, ActivityType, Allergen, DietTag, Equipment, Goal, OnboardingAnswers, ProgramVersion } from '@/domain/types';
import { isSplitKey, splitKeyOfVersion } from '@/domain/program/splits';

export const DRAFT_KEY = 'onboarding-draft';

export type StepKey =
  | 'welcome' | 'about' | 'body' | 'goal' | 'experience' | 'schedule' | 'equipment' | 'exercises' | 'limits' | 'lifestyle' | 'nutrition' | 'review'
  | 'result' | 'manual';

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
  nutri: NutritionChoice;
  manual: { sessions: number; days: number[] };
  fromReview?: boolean;
}

export const ALL_GYM: Equipment[] = [
  'barbell', 'rack', 'bench', 'dumbbell', 'kettlebell', 'machine', 'cable', 'band', 'pullup_bar', 'dip_station', 'ez_bar', 'smith', 'cardio_machine',
];
export const LOCATION_PRESETS: Record<OnboardingAnswers['location'], Equipment[]> = {
  full_gym: ALL_GYM,
  home_gym: ['barbell', 'rack', 'bench', 'dumbbell', 'pullup_bar', 'band'],
  minimal: [],
};

export function defaultAnswers(account: AccountState): OnboardingAnswers {
  const p = account.profile;
  return {
    displayName: p.displayName ?? '',
    units: { ...account.settings.units },
    age: p.age,
    heightCm: p.heightCm,
    goal: p.goal ?? 'build_muscle',
    secondaryGoal: p.secondaryGoal,
    targetWeightKg: p.targetWeightKg,
    experience: p.experience ?? 'new',
    totalDaysPerWeek: 3,
    liftingDaysPerWeek: 3,
    availableWeekdays: [1, 2, 3, 4, 5, 6, 0],
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

export function newDraft(account: AccountState): Draft {
  return {
    v: 1,
    mode: 'plan',
    step: 'welcome',
    a: defaultAnswers(account),
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
export function migrateDraft(d: Draft): Draft {
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

export function stepsFor(d: Pick<Draft, 'mode' | 'a'>): StepKey[] {
  if (d.mode === 'manual') return ['welcome', 'about', 'manual'];
  return ['welcome', 'about', 'body', 'goal', 'experience', 'schedule', 'equipment', 'exercises', 'limits', 'lifestyle', ...(d.a.wantsNutrition ? (['nutrition'] as StepKey[]) : []), 'review', 'result'];
}

export const STEP_TITLES: Record<StepKey, string> = {
  welcome: 'Welcome',
  about: 'About you',
  body: 'Body details',
  goal: 'Your goal',
  experience: 'Experience',
  schedule: 'Your week',
  equipment: 'Equipment',
  exercises: 'Activities & exercises',
  limits: 'Anything to go easy on?',
  lifestyle: 'Everyday activity',
  nutrition: 'Food preferences',
  review: 'Review',
  result: 'Your plan',
  manual: 'Your own program',
};

export const isUnder18 = (a: Pick<OnboardingAnswers, 'age'>) => a.age != null && a.age < 18;

/* ------------------------------------------------------------ validation */
const GOALS = ['build_muscle', 'strength', 'lose_fat', 'general_fitness', 'endurance'] as const satisfies readonly Goal[];
const ENDURANCE_ACTIVITIES = ['run', 'cycle', 'swim', 'row', 'hike', 'walk'] as const satisfies readonly ActivityType[];

const aboutSchema = z.object({
  displayName: z.string().trim().min(1, 'Enter a name — a nickname is fine.').max(40, 'Keep it under 40 characters.'),
});
const bodySchema = z.object({
  age: z.number().int('Use whole years.').min(13, 'LiftCircle is for ages 13 and up.').max(100, 'Please check your age.').optional(),
  weightKg: z.number().min(30, 'Please check your weight.').max(300, 'Please check your weight.').optional(),
  heightCm: z.number().min(120, 'Please check your height.').max(230, 'Please check your height.').optional(),
});
const goalSchema = z
  .object({
    goal: z.enum(GOALS),
    secondaryGoal: z.enum(GOALS).optional(),
    targetWeightKg: z.number().min(30, 'Please check the target weight.').max(300, 'Please check the target weight.').optional(),
    endurance: z
      .object({
        activity: z.enum(ENDURANCE_ACTIVITIES),
        recentMinutes: z.number().min(5, 'At least 5 minutes.').max(300, 'Up to 300 minutes.').optional(),
        recentDistanceKm: z.number().min(0.2, 'Please check the distance.').max(300, 'Please check the distance.').optional(),
      })
      .optional(),
  })
  .refine((v) => !v.secondaryGoal || v.secondaryGoal !== v.goal, { message: 'Pick a different secondary goal (or none).', path: ['secondaryGoal'] });
const scheduleSchema = z
  .object({
    totalDaysPerWeek: z.number().int().min(1, 'At least 1 day.').max(7),
    liftingDaysPerWeek: z.number().int().min(0).max(6, 'At most 6 lifting days.'),
    availableWeekdays: z.array(z.number().int().min(0).max(6)).min(1, 'Pick at least one day you could train.'),
    preferredLiftingWeekdays: z.array(z.number().int().min(0).max(6)),
    sessionMinutes: z.number().int().min(20, 'At least 20 minutes.').max(180, 'Up to 180 minutes.'),
  })
  .superRefine((v, ctx) => {
    if (v.liftingDaysPerWeek > v.totalDaysPerWeek)
      ctx.addIssue({ code: 'custom', path: ['liftingDaysPerWeek'], message: 'Lifting days are part of your total active days — raise the total or lower lifting days.' });
    if (v.availableWeekdays.length < v.totalDaysPerWeek)
      ctx.addIssue({ code: 'custom', path: ['availableWeekdays'], message: `Pick at least ${v.totalDaysPerWeek} available days, or lower your total days.` });
    if (v.preferredLiftingWeekdays.some((d) => !v.availableWeekdays.includes(d)))
      ctx.addIssue({ code: 'custom', path: ['preferredLiftingWeekdays'], message: 'Preferred lifting days must be days you’re available.' });
    if (v.preferredLiftingWeekdays.length > v.liftingDaysPerWeek)
      ctx.addIssue({ code: 'custom', path: ['preferredLiftingWeekdays'], message: `Pick at most ${v.liftingDaysPerWeek} preferred lifting day${v.liftingDaysPerWeek === 1 ? '' : 's'}.` });
  });
const loadsSchema = z.object({ knownLoads: z.record(z.string(), z.number().min(0, 'Loads can’t be negative.').max(600, 'Please check this load.')).optional() });
const nutritionSchema = z.object({
  diet: z.object({
    mealsPerDay: z.number().int().min(1, '1–6 meals.').max(6, '1–6 meals.'),
    maxCookMinutes: z.number().int().min(5).max(180),
  }),
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
    case 'about':
      return run(aboutSchema, a);
    case 'body':
      return run(bodySchema, a);
    case 'goal':
      return run(goalSchema, a);
    case 'schedule':
      return run(scheduleSchema, a);
    case 'exercises':
      return run(loadsSchema, a);
    case 'nutrition':
      return run(nutritionSchema, a);
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
