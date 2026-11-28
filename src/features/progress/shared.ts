import { useEffect } from 'react';
import { numberText, t, tKey } from '@/i18n';
import { exerciseName } from '@/data/catalog';
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
  /** All alive food logs (all history, read regardless of the nutrition setting); consumers filter by date. */
  foodLogs: FoodLogEntry[];
  /** Food logs within the selected range. */
  rangeFoodLogs?: FoodLogEntry[];
  program: Program | null;
  exercises: Exercise[];
  byId: Map<ID, Exercise>;
  from: ISODate;
  to: ISODate;
  today: ISODate;
  settings: Settings;
  /** Switches the range to all time; undefined when all time is already selected. */
  onShowAll?: () => void;
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
  if (ex.load === 'per_hand') parts.push(t('progress.loadNote.perHand'));
  if (ex.load === 'stack') parts.push(t('progress.loadNote.stack'));
  if (ex.load === 'added') parts.push(t('progress.loadNote.added'));
  if (ex.load === 'assistance') parts.push(t('progress.loadNote.assistance'));
  if (ex.unilateral) parts.push(t('workout.loadNote.repsPerSide'));
  return parts.length ? parts.join(' ') : null;
}

/** Stored-catalog name, else the bundled catalog's, else the localized "Unknown exercise" (records are kept). */
export const exerciseLabel = (id: ID, byId: Map<ID, Exercise>) => exerciseName(id, byId);

/** Food logs within [from, to]. */
export const inRange = <T extends { date: ISODate }>(rows: T[], from: ISODate, to: ISODate) => rows.filter((r) => r.date >= from && r.date <= to);

/** Whole number with locale grouping: "12,345" (en) / "12.345" (is). */
export const fmtInt = (n: number) => numberText(Math.round(n), 0, true);

/** Returns focus to the element that was focused when the caller mounted (a sheet's trigger) when it unmounts. */
export function useReturnFocus() {
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    return () => {
      if (trigger && trigger.isConnected) trigger.focus?.();
    };
  }, []);
}
