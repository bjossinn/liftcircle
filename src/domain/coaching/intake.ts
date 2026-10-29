/**
 * Coaching request intake: prefill from the user's own profile/program inputs, let them edit or remove
 * fields, and send ONLY what they kept. Pure.
 */
import type { CoachFormat, CoachingIntake, SharingScopes } from '@/backend/coachingContract';
import type { Equipment, Experience, Goal, LimitationArea, OnboardingAnswers, PrivateProfile } from '@/domain/types';

export const INTRO_MAX = 2000;
export const NOTES_MAX = 1000;

export type IntakeKey = 'goal' | 'secondaryGoal' | 'experience' | 'daysPerWeek' | 'sessionMinutes' | 'equipment' | 'limitations' | 'preferredFormat' | 'notes';
export const INTAKE_KEYS: IntakeKey[] = ['goal', 'secondaryGoal', 'experience', 'daysPerWeek', 'sessionMinutes', 'equipment', 'limitations', 'preferredFormat', 'notes'];

export interface IntakeDraft {
  goal?: Goal;
  secondaryGoal?: Goal;
  experience?: Experience;
  daysPerWeek?: number;
  sessionMinutes?: number;
  equipment?: Equipment[];
  limitations?: LimitationArea[];
  preferredFormat?: CoachFormat;
  notes?: string;
  /** Fields the user chose to include. A removed field is never sent, even if it has a value. */
  kept: Record<IntakeKey, boolean>;
}

/**
 * Start from what the app already knows. Only goal/experience/schedule/equipment and limitation AREAS are used —
 * free-text injury notes, age, weight and other private details are never copied in.
 */
export function prefillIntake(profile: Partial<PrivateProfile> | null | undefined, inputs: Partial<OnboardingAnswers> | null | undefined, coachFormats: CoachFormat[] = []): IntakeDraft {
  const goal = profile?.goal ?? inputs?.goal;
  const secondaryGoal = profile?.secondaryGoal ?? inputs?.secondaryGoal;
  const experience = profile?.experience ?? inputs?.experience;
  const daysPerWeek = inputs?.totalDaysPerWeek ?? inputs?.liftingDaysPerWeek;
  const sessionMinutes = inputs?.sessionMinutes;
  const equipment = inputs?.equipment?.length ? [...inputs.equipment] : undefined;
  const lim = (profile?.limitations?.length ? profile.limitations : inputs?.limitations) ?? [];
  const limitations = lim.length ? [...lim] : undefined;
  const preferredFormat = coachFormats.length === 1 ? coachFormats[0] : undefined;
  const d: IntakeDraft = {
    goal,
    secondaryGoal: secondaryGoal && secondaryGoal !== goal ? secondaryGoal : undefined,
    experience,
    daysPerWeek,
    sessionMinutes,
    equipment,
    limitations,
    preferredFormat,
    notes: '',
    kept: {} as IntakeDraft['kept'],
  };
  for (const k of INTAKE_KEYS) d.kept[k] = hasValue(d, k);
  return d;
}

export function hasValue(d: Omit<IntakeDraft, 'kept'>, k: IntakeKey): boolean {
  const v = d[k];
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'string') return v.trim().length > 0;
  if (typeof v === 'number') return isFinite(v);
  return true;
}

const clampInt = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

/** The intake actually sent: kept, non-empty, normalized fields only. */
export function buildIntake(d: IntakeDraft): CoachingIntake {
  const out: CoachingIntake = {};
  const keep = (k: IntakeKey) => d.kept[k] && hasValue(d, k);
  if (keep('goal')) out.goal = d.goal;
  if (keep('secondaryGoal') && d.secondaryGoal !== (keep('goal') ? d.goal : undefined)) out.secondaryGoal = d.secondaryGoal;
  if (keep('experience')) out.experience = d.experience;
  if (keep('daysPerWeek')) out.daysPerWeek = clampInt(d.daysPerWeek!, 1, 7);
  if (keep('sessionMinutes')) out.sessionMinutes = clampInt(d.sessionMinutes!, 10, 240);
  if (keep('equipment')) out.equipment = [...new Set(d.equipment!)];
  if (keep('limitations')) out.limitations = [...new Set(d.limitations!)];
  if (keep('preferredFormat')) out.preferredFormat = d.preferredFormat;
  if (keep('notes')) out.notes = d.notes!.trim().slice(0, NOTES_MAX);
  return out;
}

export function introProblem(msg: string): string | null {
  const t = msg.trim();
  if (!t) return 'Write a short introduction so the coach knows what you’re looking for.';
  if (t.length > INTRO_MAX) return `Keep it under ${INTRO_MAX} characters.`;
  return null;
}

/* ---------------------------------------------------------------- sharing */
export type ScopeKey = keyof SharingScopes;
export type ScopeNeed = 'recommended' | 'often_useful' | 'optional';

/**
 * How much a coach's service typically relies on each category. Training is what program coaching works
 * from; the others are optional unless the coach's declared specialties/goals point at them.
 */
export function scopeNeeds(coach: { specialties: string[]; goals: string[] } | null | undefined): Record<ScopeKey, ScopeNeed> {
  const spec = new Set(coach?.specialties ?? []);
  const goals = new Set(coach?.goals ?? []);
  return {
    training: 'recommended',
    measurements: spec.has('fat_loss') || goals.has('lose_fat') ? 'often_useful' : 'optional',
    nutrition: spec.has('nutrition') ? 'often_useful' : 'optional',
    checkins: 'optional',
  };
}

export const defaultScopes = (): SharingScopes => ({ training: true, measurements: false, nutrition: false, checkins: false });
