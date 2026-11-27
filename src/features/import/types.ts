/**
 * Intermediate model for workout history imported from other apps (Strong, Hevy). Parsers turn a CSV export into
 * `ParsedImport`; `plan.ts` maps it onto Hard Earned workouts. Values stay as written in the file (weights in the
 * file's unit) so the per-workout dedupe hash never depends on choices made in the preview.
 */
import type { WeightUnit } from '@/domain/types';

export type ImportSource = 'strong' | 'hevy';
export type ImportDistanceUnit = 'km' | 'mi' | 'm';

/** A workout's start: a local wall-clock time ("2024-01-15T08:30:00", interpreted in the account's time zone) or an instant. */
export type ImportStart = { local: string } | { epochMs: number };

export interface ParsedSet {
  type: 'normal' | 'warmup' | 'drop';
  /** Load in the file's unit (see `ParsedImport.weightUnit` / `ParsedSet.weightUnit`). */
  weight: number | null;
  /** Unit stated on the row itself (Strong "Weight Unit" column), when present. */
  weightUnit?: WeightUnit;
  reps: number | null;
  /** Distance in the file's unit (see `distanceUnit`). */
  distance: number | null;
  distanceUnit?: ImportDistanceUnit;
  durationSec: number | null;
  rpe: number | null;
}

export interface ParsedExercise {
  /** Exercise name exactly as in the export ("Bench Press (Barbell)"). */
  name: string;
  notes?: string;
  supersetId?: string;
  sets: ParsedSet[];
}

export interface ParsedWorkout {
  name: string;
  start: ImportStart;
  /** Raw start text from the file; part of the stable dedupe key. */
  startKey: string;
  durationSec?: number;
  end?: ImportStart;
  notes?: string;
  exercises: ParsedExercise[];
}

export interface ParsedImport {
  source: ImportSource;
  /** Unit of every weight in the file, or null when the file doesn't say (Strong exports without a unit column). */
  weightUnit: WeightUnit | null;
  /** Unit of every distance in the file, or null when the file doesn't say (then it follows the weight unit). */
  distanceUnit: ImportDistanceUnit | null;
  workouts: ParsedWorkout[];
  /** Data rows that couldn't be used (no date, no exercise, rest-timer rows…). */
  skippedRows: number;
}

/** A file that isn't a supported export, or holds no workouts. `code` maps to a translated message. */
export class WorkoutImportError extends Error {
  constructor(readonly code: 'unknown_format' | 'empty' | 'too_large' | 'unreadable') {
    super(code);
  }
}
