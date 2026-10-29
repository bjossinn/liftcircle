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

export function conventionNote(ex: Exercise): string | null {
  const parts: string[] = [];
  if (ex.load === 'per_hand') parts.push('Weight is per dumbbell/kettlebell.');
  if (ex.load === 'stack') parts.push('Weight is the machine or cable stack setting.');
  if (ex.load === 'added') parts.push('Weight is the load added to your bodyweight.');
  if (ex.load === 'assistance') parts.push('Weight is the assistance — less is progress.');
  if (ex.unilateral) parts.push('Reps are per side.');
  return parts.length ? parts.join(' ') : null;
}

export const fmtInt = (n: number) => Math.round(n).toLocaleString('en-GB');
