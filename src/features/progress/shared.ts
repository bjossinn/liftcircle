import { numberText, t, tKey } from '@/i18n';
import type { ActivityLog, Exercise, FoodLogEntry, ID, ISODate, Measurement, MuscleGroup, Program, Settings, UserGoal, WorkoutSession } from '@/domain/types';

/** Everything a Progress section needs, already filtered for tombstones. */
export interface ProgressData {
  /** All completed sessions (records & goals need full history). */
  sessions: WorkoutSession[];
  /** Completed sessions within the selected range. */
  rangeSessions: WorkoutSession[];
  activities: ActivityLog[];
  rangeActivities: ActivityLog[];
  measurements: Measurement[];
  goals: UserGoal[];
  foodLogs: FoodLogEntry[];
  program: Program | null;
  exercises: Exercise[];
  byId: Map<ID, Exercise>;
  from: ISODate;
  to: ISODate;
  today: ISODate;
  settings: Settings;
}

export const MUSCLE_NAMES: Record<MuscleGroup, string> = {
  chest: 'Chest', upper_back: 'Upper back', lats: 'Lats', shoulders: 'Shoulders', rear_delts: 'Rear delts', biceps: 'Biceps', triceps: 'Triceps',
  forearms: 'Forearms', quads: 'Quads', hamstrings: 'Hamstrings', glutes: 'Glutes', calves: 'Calves', adductors: 'Adductors', abs: 'Abs',
  obliques: 'Obliques', lower_back: 'Lower back', full_body: 'Full body', cardio: 'Cardio',
};
/** Localized muscle-group name (shared muscle glossary). */
export const muscleName = (m: MuscleGroup) => tKey(`workout.meta.muscle.${m}`, MUSCLE_NAMES[m]);

export function conventionNote(ex: Exercise): string | null {
  const parts: string[] = [];
  // i18n: no approved Icelandic copy for the four load notes below (see missing/g2_progress.md).
  if (ex.load === 'per_hand') parts.push('Weight is per dumbbell/kettlebell.');
  if (ex.load === 'stack') parts.push('Weight is the machine or cable stack setting.');
  if (ex.load === 'added') parts.push('Weight is the load added to your bodyweight.');
  if (ex.load === 'assistance') parts.push('Weight is the assistance. Less is progress.');
  if (ex.unilateral) parts.push(t('workout.loadNote.repsPerSide'));
  return parts.length ? parts.join(' ') : null;
}

/** Whole number with locale grouping: "12,345" (en) / "12.345" (is). */
export const fmtInt = (n: number) => numberText(Math.round(n), 0, true);
