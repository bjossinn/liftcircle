/**
 * Pure helpers for coaches building a ProposedProgram, plus a local (account-scoped) autosave of the
 * editor draft so work isn't lost on a flaky connection. Validation/diffing use the shared
 * `validateProposedProgram` / `describeChanges` from '@/domain/program/proposals'.
 */
import type { ProposedProgram, CoachingIntake } from '@/backend/coachingContract';
import type { Equipment, Experience, Goal, ID, ISODate, LimitationArea, OnboardingAnswers, ProgramVersion, ScheduleSlot, SessionTemplate, UnitPrefs } from '@/domain/types';
import type { LiftDb } from '@/db/db';
import { ALL_EQUIPMENT, WEEK_ORDER, emptyTemplate } from '@/domain/program/generator';
import { uuid } from '@/lib/id';

const shortId = () => uuid().replace(/-/g, '').slice(0, 10);
export const newTemplateId = () => `coach:${shortId()}`;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function blankProposed(name = 'New plan'): ProposedProgram {
  return {
    name,
    reason: '',
    templates: [emptyTemplate(newTemplateId(), 'Session A')],
    schedule: [],
    weeks: 8,
    reviewWeek: 8,
    rationale: [],
    warnings: [],
    progressionNotes: '',
  };
}

/** Program content from existing version-like content (a template-free deep copy). */
export function proposedFromVersion(v: Omit<ProgramVersion, 'version' | 'createdAt'> | ProposedProgram, name: string): ProposedProgram {
  const c = clone(v) as ProposedProgram;
  return {
    name,
    reason: '',
    templates: c.templates,
    schedule: c.schedule,
    weeks: c.weeks,
    reviewWeek: c.reviewWeek,
    rationale: c.rationale ?? [],
    warnings: c.warnings ?? [],
    progressionNotes: (c as ProposedProgram).progressionNotes ?? '',
  };
}

/** Copy library sessions into a program with fresh ids (slot ids only need to be unique per session). */
export function templatesAsSessions(templates: SessionTemplate[]): SessionTemplate[] {
  return templates.map((t) => {
    const id = newTemplateId();
    return { ...clone(t), id, exercises: t.exercises.map((x, i) => ({ ...clone(x), id: `${id}:${i}` })) };
  });
}

export function proposedFromTemplates(templates: SessionTemplate[], name = 'New plan'): ProposedProgram {
  const p = blankProposed(name);
  const sessions = templatesAsSessions(templates);
  return { ...p, templates: sessions.length ? sessions : p.templates };
}

/** Comparable ProgramVersion for describeChanges. */
export function asVersion(p: ProposedProgram, version = 0): ProgramVersion {
  const { name: _n, progressionNotes: _p, ...rest } = p;
  void _n;
  void _p;
  return { ...clone(rest), version, createdAt: 0 };
}

/** Set the weekdays a session is scheduled on (replacing its previous days). */
export function setSessionDays(p: ProposedProgram, templateId: ID, days: number[]): ProposedProgram {
  const schedule = [...p.schedule.filter((s) => s.templateId !== templateId), ...days.map((weekday) => ({ weekday, templateId }))].sort(
    (a, b) => WEEK_ORDER.indexOf(a.weekday) - WEEK_ORDER.indexOf(b.weekday),
  );
  return { ...p, schedule };
}

/**
 * Missed sessions / schedule changes: move scheduled slots to other weekdays.
 * `newWeekdays[i]` is the new weekday for `schedule[i]`. Returns the new schedule (week-ordered) and
 * any weekday that would hold two sessions (shown to the coach; validation rejects it before sending).
 */
export function moveSessions(schedule: ScheduleSlot[], newWeekdays: number[]): { schedule: ScheduleSlot[]; clashes: number[] } {
  const next = schedule.map((s, i) => ({ weekday: newWeekdays[i] ?? s.weekday, templateId: s.templateId }));
  next.sort((a, b) => WEEK_ORDER.indexOf(a.weekday) - WEEK_ORDER.indexOf(b.weekday));
  const count = new Map<number, number>();
  for (const s of next) count.set(s.weekday, (count.get(s.weekday) ?? 0) + 1);
  const clashes = [...count].filter(([, n]) => n > 1).map(([d]) => d);
  return { schedule: next, clashes };
}

/* --------------------------------------------------------------- intake → generator answers */
const GOALS: Goal[] = ['build_muscle', 'strength', 'lose_fat', 'general_fitness', 'endurance'];
const EXPERIENCES: Experience[] = ['new', 'returning', 'intermediate', 'advanced'];
const LIMITS: LimitationArea[] = ['knee', 'shoulder', 'lower_back', 'hip', 'wrist', 'elbow', 'neck', 'ankle'];

/** Map the client's shared intake onto generator answers. Unknowns fall back to neutral defaults (listed in `assumed`). */
export function intakeToAnswers(intake: CoachingIntake, units: UnitPrefs): { answers: OnboardingAnswers; assumed: string[] } {
  const assumed: string[] = [];
  const goal = GOALS.find((g) => g === intake.goal) ?? (assumed.push('goal: general fitness'), 'general_fitness');
  const secondaryGoal = GOALS.find((g) => g === intake.secondaryGoal && g !== goal);
  const experience = EXPERIENCES.find((x) => x === intake.experience) ?? (assumed.push('experience: intermediate'), 'intermediate');
  const days = intake.daysPerWeek && intake.daysPerWeek >= 1 ? Math.min(6, Math.round(intake.daysPerWeek)) : (assumed.push('3 days per week'), 3);
  const minutes = intake.sessionMinutes && intake.sessionMinutes >= 15 ? Math.min(180, intake.sessionMinutes) : (assumed.push('60-minute sessions'), 60);
  const equipment = (intake.equipment ?? []).filter((e): e is Equipment => (ALL_EQUIPMENT as string[]).includes(e));
  const location: OnboardingAnswers['location'] = equipment.length === 0 ? 'full_gym' : equipment.includes('barbell') && equipment.includes('rack') ? 'full_gym' : equipment.length <= 2 ? 'minimal' : 'home_gym';
  if (equipment.length === 0) assumed.push('a full gym');
  const limitations = (intake.limitations ?? []).filter((l): l is LimitationArea => (LIMITS as string[]).includes(l));
  return {
    assumed,
    answers: {
      displayName: '',
      units,
      goal,
      secondaryGoal,
      experience,
      totalDaysPerWeek: days,
      liftingDaysPerWeek: goal === 'endurance' ? Math.min(2, days) : days,
      availableWeekdays: [0, 1, 2, 3, 4, 5, 6],
      preferredLiftingWeekdays: [],
      sessionMinutes: minutes,
      location,
      equipment,
      preferredActivities: [],
      enjoyedExerciseIds: [],
      excludedExerciseIds: [],
      limitations,
      activityLevel: 'moderate',
      wantsNutrition: false,
      diet: { tags: [], allergens: [], dislikedIngredientIds: [], maxCookMinutes: 30, budget: 'any', mealsPerDay: 3 },
    },
  };
}

/* --------------------------------------------------------------- local autosave */
export interface EditorDraft {
  proposalId: ID;
  program: ProposedProgram;
  revise: boolean;
  message: string;
  effectiveDate: ISODate | null;
  savedAt: number;
}
const draftKey = (relationshipId: ID) => `coach-program-draft:${relationshipId}`;

export async function loadEditorDraft(db: LiftDb, relationshipId: ID): Promise<EditorDraft | null> {
  try {
    return ((await db.kv.get(draftKey(relationshipId)))?.value as EditorDraft | undefined) ?? null;
  } catch {
    return null;
  }
}
export async function saveEditorDraft(db: LiftDb, relationshipId: ID, d: EditorDraft | null): Promise<void> {
  try {
    if (d) await db.kv.put({ key: draftKey(relationshipId), value: d });
    else await db.kv.delete(draftKey(relationshipId));
  } catch {
    /* best-effort */
  }
}
